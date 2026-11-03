#!/usr/bin/env node
/**
 * Design evidence — Team member slots are permanent: there is no reclaim path.
 *
 * WHAT THIS PROVES (real runtime, no mocks):
 *   1. With `agent-team.maxMembers` forced to 2 by a `--patch` overlay, the first
 *      two `spawnTeammate` calls succeed and the third throws
 *      `TEAM_MEMBER_LIMIT` ("Team member limit 2 reached").
 *   2. `Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.agentTeams))` plus the
 *      whole prototype chain expose no retire/remove/kill/delete/release/reclaim
 *      member API. The only teammate-affecting public method is `interrupt`
 *      (cancel a turn, not free a slot).
 *   3. Reclaim attempts do not free a slot:
 *      - waiting until every teammate is `inactive`, then spawning -> still refused
 *        (inactive != released);
 *      - interrupting an idle teammate -> still refused;
 *      - deleting/releasing shared task-board entries -> still refused;
 *      - `sendMessage` waking an idle teammate, then waiting idle -> still refused;
 *      - the subagent runtime teardown `ctx.subagents.drainChildren(...)` releases
 *        the live child Agents, yet the roster rows and the count stay, and the
 *        next spawn is still refused.
 *   4. A teammate whose provisioning FAILS is written to the durable roster as
 *      `phase: 'failed'` and permanently occupies a slot. A second Team shows:
 *      one failed spawn (bogus provider) + one successful spawn fills maxMembers=2,
 *      so the next spawn is refused even though only ONE teammate is alive.
 *   5. `listMembers` rows == 1 (Lead pseudo-row) + projection `members` count; the
 *      projection includes failed rows, matching the runtime view.
 *
 * HOW TO RUN
 *   cd /home/s00653124/workspace/dsh-compiler-mode
 *   node tests/design/member-reclaim-probe.mjs
 *   -> writes evidence/design/member-reclaim-probe.json
 *
 * ENVIRONMENT (read from evidence/env/layout.json)
 *   dshCheckout : real checkout; `runProfile` is imported from its built CLI.
 *   profile     : `ai-compiler-scratch` (headless; ai-compiler preset default).
 *   overlays    : tests/e2e/cases/model-overlay.yml (model plane) + a TEMPORARY
 *                 overlay generated in the OS temp dir that replaces the
 *                 `agent-team` row config with maxMembers: 2. Nothing under
 *                 `deepseek-harness/` is touched; the temp overlay is deleted.
 *                 The same temp overlay disables `headless-runner` so the
 *                 profile boots as a plain runtime: its one-shot task runner is
 *                 not mounted and no extra model turn runs beside the probe.
 *
 * NOTES
 *   - Raw `agents.create()` in a headless probe does not apply the profile's
 *     default model, so the child assembly would leave the preset's `{{model}}`
 *     prompt variable unset (the turn dies before its first request and
 *     provisioning fails). Every spawn therefore passes an explicit
 *     `agentOptions` route (magpie / auto/deepseek-v4.1-flash), the same route
 *     the model overlay configures. That route is the only reason spawns
 *     succeed here; it does not affect the limit/roster semantics under test.
 *   - Every spawn/send uses `AbortSignal.timeout(...)` so a bad environment can
 *     never hang the probe; the whole run is repeatable and cleans up with
 *     shutdown + fiber dispose + process.exit.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const layout = JSON.parse(readFileSync(join(repo, 'evidence/env/layout.json'), 'utf8'))
const OUT_PATH = 'evidence/design/member-reclaim-probe.json'

const PROFILE = 'ai-compiler-scratch'
const MAX_MEMBERS = 2
const SPAWN_TIMEOUT_MS = 240_000
const SEND_TIMEOUT_MS = 120_000
const IDLE_TIMEOUT_MS = 120_000
const ROUTE = { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' }
const RECLAIM_NAME = /retire|remove|kill|delete|release|reclaim|evict|teardown|dispose|drain|detach|drop/iu

const sleep = ms => new Promise(done => setTimeout(done, ms))
const evidence = {
  at: new Date().toISOString(),
  probe: 'member-reclaim',
  env: {
    dshCheckout: layout.dshCheckout,
    profile: PROFILE,
    headlessTaskArg: 'probe',
    overlays: ['tests/e2e/cases/model-overlay.yml', '<temp>/agent-team-maxMembers-2.yml'],
    maxMembers: MAX_MEMBERS,
    spawnRoute: ROUTE,
    routeNote: 'Raw agents.create() in a headless probe does not apply the profile default model, so the ai-compiler preset\'s {{model}} prompt variable stays unset and the child turn dies before its first request (TEAM_PROVISIONING_CONFLICT). Every spawn therefore passes an explicit route, the same one the model overlay configures. This does not change limit/roster semantics.',
    oneShotRunner: 'disabled via the temp overlay (headless-runner) so no extra model turn runs beside the probe',
    spawnTimeoutMs: SPAWN_TIMEOUT_MS,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    node: process.version,
  },
  attempts: [],
  availableServiceMethods: {},
  cleanupAttempts: [],
  roster: [],
  rosterSize: 0,
  projectionComparison: [],
  failedProvisioningEvidence: {},
  evidenceGaps: [],
  conclusions: [],
}

let ctx
let shutdown
let tempDir
let fatalError

/** Poll until no teammate is running/provisioning; records the sampled statuses. */
async function waitTeammatesIdle(teams, lead, timeoutMs = IDLE_TIMEOUT_MS) {
  const started = Date.now()
  let sampled = []
  while (Date.now() - started < timeoutMs) {
    sampled = teams.listMembers(lead)
      .filter(member => member.role === 'teammate')
      .map(member => ({ name: member.name, status: member.status }))
    const busy = sampled.some(member => member.status === 'running' || member.status === 'provisioning')
    if (!busy) {
      return { settled: true, elapsedMs: Date.now() - started, members: sampled }
    }
    await sleep(500)
  }
  return { settled: false, elapsedMs: Date.now() - started, members: sampled }
}

/** Spawn one teammate with a hard timeout, recording either publication or the exact refusal. */
async function spawnTeammate(teams, lead, name, options = {}) {
  const started = Date.now()
  const provider = options.provider ?? 'spawn'
  const record = { name, provider, created: false, code: null, message: null, memberId: null, status: null, elapsedMs: 0 }
  try {
    const result = await teams.spawnTeammate(lead, {
      name,
      description: options.description ?? `reclaim probe member ${name}`,
      prompt: [{ type: 'text', text: options.prompt ?? 'Reply OK.' }],
      context: 'fresh',
      provider,
      agentOptions: options.agentOptions ?? ROUTE,
      signal: AbortSignal.timeout(options.timeoutMs ?? SPAWN_TIMEOUT_MS),
    })
    record.created = true
    record.memberId = result.member.id
    record.status = result.member.status
  } catch (error) {
    record.code = error?.code ?? null
    record.message = String(error?.message ?? error).slice(0, 400)
  }
  record.elapsedMs = Date.now() - started
  return record
}

/** Snapshot listMembers rows plus the durable projection's member count for one Team. */
function rosterSnapshot(teams, projections, lead) {
  const members = teams.listMembers(lead)
  const rows = members.map(member => ({
    name: member.name,
    role: member.role,
    status: member.status,
    ...member.provider === undefined ? {} : { provider: member.provider },
    ...member.context === undefined ? {} : { context: member.context },
    ...member.model === undefined ? {} : { model: member.model },
    diagnostics: member.diagnostics,
    id: member.id,
  }))
  const state = projections.stateOf(lead.session, 'agentTeam')
  return {
    leadSessionId: lead.id,
    rosterSize: members.length,
    teammateRows: members.length - 1,
    rows,
    projectionKey: 'agentTeam',
    projectionMemberCount: state?.members?.length ?? null,
    projectionMembers: (state?.members ?? []).map(member => ({
      name: member.name,
      phase: member.phase,
      ...member.error === undefined ? {} : { error: member.error },
    })),
  }
}

/** Record one "can we clean up?" step plus the follow-up spawn that must still be refused. */
async function cleanupAttempt(teams, lead, kind, label, action, attemptName) {
  const entry = { kind, label, attempted: false, ok: false, result: null, error: null, rosterAfterAction: null, spawnAfter: null }
  try {
    entry.attempted = true
    entry.result = await action()
    entry.ok = true
  } catch (error) {
    entry.error = { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 400) }
  }
  const members = teams.listMembers(lead)
  entry.rosterAfterAction = {
    rosterSize: members.length,
    rows: members.map(member => ({ name: member.name, role: member.role, status: member.status })),
  }
  entry.spawnAfter = await spawnTeammate(teams, lead, attemptName, { description: `after ${label}` })
  evidence.cleanupAttempts.push(entry)
  return entry
}

try {
  tempDir = mkdtempSync(join(tmpdir(), 'dsh-member-reclaim-'))
  const overlayPath = join(tempDir, 'agent-team-maxMembers-2.yml')
  writeFileSync(overlayPath, [
    '# GENERATED at runtime by tests/design/member-reclaim-probe.mjs — never committed.',
    '# The Loader replaces `config` wholesale; every key is restated.',
    '- id: agent-team',
    '  config:',
    `    maxMembers: ${MAX_MEMBERS}`,
    '    maxTasks: 256',
    '    maxMessageBytes: 65536',
    '    disposalTimeoutMs: 5000',
    '# Boot as a plain runtime: no one-shot task runner beside the probe.',
    '- id: headless-runner',
    '  disabled: true',
    '',
  ].join('\n'))

  const { runProfile } = await import(`file://${layout.dshCheckout}/apps/cli/lib/profile-boot.js`)
  const entries = Object.fromEntries(Object.entries(process.env).map(([name, value]) => [name, { value: value ?? '' }]))
  const booted = await runProfile({
    environment: { entries, get: name => entries[name], has: name => entries[name] !== undefined },
    profile: PROFILE,
    patchFiles: [join(repo, 'tests/e2e/cases/model-overlay.yml'), overlayPath],
    args: ['probe'],
  })
  ctx = booted.ctx
  shutdown = booted.shutdown

  const agents = ctx.get('agents')
  const teams = ctx.get('agentTeams')
  const presets = ctx.get('agentPresets')
  const projections = ctx.get('sessionProjections')
  const subagents = ctx.get('subagents')
  if (agents === undefined || teams === undefined || presets === undefined) {
    throw new Error('required services missing: agents/agentTeams/agentPresets')
  }

  // ── Service surface: is there any member-reclaim API at all? ───────────────
  // TypeScript `private` is erased at runtime, so those methods also live on the
  // prototype. Names below are private in packages/experimental/agent-team/src:
  // sendAdmitted/spawnAdmitted are internal send/spawn halves, scheduleRecovery
  // is a provisioning hook, disposeRuntime is the whole-service runtime teardown.
  const PROTOTYPE_PRIVATE = new Set(['sendAdmitted', 'scheduleRecovery', 'disposeRuntime'])
  const chain = []
  for (let proto = Object.getPrototypeOf(teams); proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    chain.push({
      className: proto.constructor?.name ?? '(anonymous)',
      ownPropertyNames: Object.getOwnPropertyNames(proto).filter(name => name !== 'constructor'),
    })
  }
  const serviceMethods = chain.flatMap(level => level.ownPropertyNames)
  const publicMethods = serviceMethods.filter(name => !PROTOTYPE_PRIVATE.has(name))
  evidence.availableServiceMethods = {
    expression: 'Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.agentTeams))',
    prototypeChain: chain,
    serviceMethods,
    publicMethods,
    prototypePrivateMethods: [...PROTOTYPE_PRIVATE].filter(name => serviceMethods.includes(name)),
    instanceOwnKeys: Object.keys(teams),
    reclaimLikeMethods: [...new Set(serviceMethods.filter(name => RECLAIM_NAME.test(name)))],
    publicReclaimLikeMethods: [...new Set(publicMethods.filter(name => RECLAIM_NAME.test(name)))],
    teammateAffectingMethods: publicMethods.filter(name => /spawn|interrupt|listMembers|membership|message|teammate/iu.test(name)),
    privateRuntimeTeardown: serviceMethods.includes('disposeRuntime')
      ? 'disposeRuntime exists only as a TS-`private` method on the prototype; it is not part of the public Team service definition, takes no member selector, and is invoked only from service/context disposal (it tears down the whole Team runtime).'
      : null,
  }

  // ── Team A: fill maxMembers, then hit the hard refusal ─────────────────────
  const leadA = (await agents.create({
    sessionId: `session-reclaim-a-${Date.now()}`,
    meta: { cwd: process.cwd() },
    setup: async child => { await presets.mount(child, 'ai-compiler') },
  })).agent

  let index = 0
  while (index < 5) {
    index += 1
    const attempt = await spawnTeammate(teams, leadA, `m-${index}`)
    evidence.attempts.push({ index, ...attempt })
    if (!attempt.created) break
  }

  const rosterAfterAttempts = rosterSnapshot(teams, projections, leadA)
  evidence.roster.push({ team: 'A', phase: 'after-attempts', ...rosterAfterAttempts })
  evidence.rosterSize = rosterAfterAttempts.rosterSize
  evidence.projectionComparison.push({
    team: 'A',
    listMembersLength: rosterAfterAttempts.rosterSize,
    projectionMemberCount: rosterAfterAttempts.projectionMemberCount,
    rowsWithFailedPhase: rosterAfterAttempts.projectionMembers.filter(member => member.phase === 'failed').length,
  })

  // ── Team A reclaim attempts ────────────────────────────────────────────────
  // 1. "Maybe inactive members free their slots."
  const idleWait = await waitTeammatesIdle(teams, leadA)
  await cleanupAttempt(teams, leadA, 'idle-wait', 'wait until every teammate is inactive', async () => idleWait,
    'after-idle-wait')

  // 2. "interrupt_agent should cancel and maybe reclaim."
  await cleanupAttempt(teams, leadA, 'interrupt', 'interrupt an idle teammate', async () => {
    const before = teams.listMembers(leadA)
    const target = before.find(member => member.role === 'teammate')
    if (target === undefined) throw new Error('no teammate to interrupt')
    const result = teams.interrupt(leadA, target.name)
    return { target: target.name, targetStatusBefore: target.status, result }
  }, 'after-interrupt')

  // 3. "Shared task-board delete/release should free something."
  await cleanupAttempt(teams, leadA, 'task-board', 'create/claim/release/delete a shared task', async () => {
    const log = []
    const created = await teams.createTask(leadA, {
      subject: 'reclaim probe task',
      description: 'Proves task-board mutations cannot free a member slot.',
    })
    log.push({ action: 'create', taskId: created.id, revision: created.revision, status: created.status })
    const claimed = await teams.updateTask(leadA, { taskId: created.id, expectedRevision: created.revision, action: 'claim' })
    log.push({ action: 'claim', revision: claimed.revision, status: claimed.status })
    const released = await teams.updateTask(leadA, { taskId: created.id, expectedRevision: claimed.revision, action: 'release' })
    log.push({ action: 'release', revision: released.revision, status: released.status })
    const deleted = await teams.updateTask(leadA, { taskId: created.id, expectedRevision: released.revision, action: 'delete' })
    log.push({ action: 'delete', revision: deleted.revision, status: deleted.status })
    log.push({ listTasksAfterDelete: teams.listTasks(leadA).map(task => task.id) })
    return log
  }, 'after-task-board')

  // 4. "send_message wakes the member and its turn ending should release something."
  await cleanupAttempt(teams, leadA, 'send-message-wake', 'wake an idle teammate via sendMessage, then wait inactive', async () => {
    const target = teams.listMembers(leadA).find(member => member.role === 'teammate')
    if (target === undefined) throw new Error('no teammate to message')
    const sent = await teams.sendMessage(leadA, {
      target: target.name,
      content: [{ type: 'text', text: 'Reply OK.' }],
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    const idle = await waitTeammatesIdle(teams, leadA)
    return { target: target.name, messageId: sent.messageId, idleAfterSend: idle }
  }, 'after-send-wake')

  // 5. "The subagent runtime teardown might free the roster row."
  await cleanupAttempt(teams, leadA, 'subagent-drain', 'ctx.subagents.drainChildren(lead, teammateIds)', async () => {
    const teammates = teams.listMembers(leadA).filter(member => member.role === 'teammate')
    await subagents.drainChildren(leadA, teammates.map(member => member.id))
    const after = rosterSnapshot(teams, projections, leadA)
    return {
      drainedChildIds: teammates.map(member => member.id),
      rosterSizeAfterDrain: after.rosterSize,
      rowsAfterDrain: after.rows.map(row => ({ name: row.name, role: row.role, status: row.status })),
      projectionMemberCountAfterDrain: after.projectionMemberCount,
    }
  }, 'after-subagent-drain')

  const rosterAfterCleanup = rosterSnapshot(teams, projections, leadA)
  evidence.roster.push({ team: 'A', phase: 'after-cleanup', ...rosterAfterCleanup })

  // ── Team B: a FAILED provisioning attempt permanently occupies a slot ──────
  const leadB = (await agents.create({
    sessionId: `session-reclaim-b-${Date.now()}`,
    meta: { cwd: process.cwd() },
    setup: async child => { await presets.mount(child, 'ai-compiler') },
  })).agent

  const badProviderAttempt = await spawnTeammate(teams, leadB, 'b-bad', {
    provider: 'definitely-not-a-provider',
    description: 'must fail provisioning',
    timeoutMs: 60_000,
  })
  const rosterAfterFailed = rosterSnapshot(teams, projections, leadB)
  const failedRow = rosterAfterFailed.projectionMembers.find(member => member.phase === 'failed')

  const goodSpawn = await spawnTeammate(teams, leadB, 'b-good', { description: 'must fill the second slot' })
  const overLimitSpawn = await spawnTeammate(teams, leadB, 'b-over', { description: 'must be refused' })
  const rosterB = rosterSnapshot(teams, projections, leadB)

  evidence.failedProvisioningEvidence = {
    team: 'B',
    maxMembers: MAX_MEMBERS,
    failedSpawn: badProviderAttempt,
    failedRowInRoster: failedRow ?? null,
    liveSpawn: goodSpawn,
    spawnAfterFailedPlusLive: overLimitSpawn,
    rosterSize: rosterB.rosterSize,
    projectionMemberCount: rosterB.projectionMemberCount,
    rows: rosterB.rows.map(row => ({ name: row.name, role: row.role, status: row.status, diagnostics: row.diagnostics })),
  }
  evidence.roster.push({ team: 'B', phase: 'final', ...rosterB })
  evidence.projectionComparison.push({
    team: 'B',
    listMembersLength: rosterB.rosterSize,
    projectionMemberCount: rosterB.projectionMemberCount,
    rowsWithFailedPhase: rosterB.projectionMembers.filter(member => member.phase === 'failed').length,
  })

  // ── Conclusions derived strictly from the recorded observations ───────────
  const limitAttempt = evidence.attempts.find(attempt => attempt.code === 'TEAM_MEMBER_LIMIT')
  const publicReclaimLike = evidence.availableServiceMethods.publicReclaimLikeMethods
  const cleanupStillRefused = evidence.cleanupAttempts.every(entry => entry.spawnAfter?.code === 'TEAM_MEMBER_LIMIT')
  const cleanupRosterSizes = evidence.cleanupAttempts.map(entry => entry.rosterAfterAction?.rosterSize ?? null)
  evidence.conclusions = [
    `maxMembers=${MAX_MEMBERS}: spawns 1..${(limitAttempt?.index ?? 1) - 1} succeeded; the next spawn was refused with ${limitAttempt?.code ?? '(missing)'} "${limitAttempt?.message ?? ''}".`,
    `Public Team service methods: ${evidence.availableServiceMethods.publicMethods.join(', ')}. Reclaim-like public member API: ${publicReclaimLike.length === 0 ? 'NONE' : publicReclaimLike.join(', ')}. The only teammate-turn method is interrupt (cancels a turn, records previousStatus, does not free a slot). Exposed prototype-private members: ${evidence.availableServiceMethods.prototypePrivateMethods.join(', ') || '(none)'}; disposeRuntime is whole-Team teardown called from service disposal only, not a member API.`,
    `inactive != released: after every teammate reached inactive, spawning again was refused with ${evidence.cleanupAttempts[0]?.spawnAfter?.code ?? '(missing)'} — idle teammates keep their slots.`,
    `All ${evidence.cleanupAttempts.length} cleanup attempts (${evidence.cleanupAttempts.map(entry => entry.kind).join(', ')}) left rosterSize at ${cleanupRosterSizes.join('/')}; every follow-up spawn was ${cleanupStillRefused ? 'still refused with TEAM_MEMBER_LIMIT' : 'NOT uniformly refused — inspect cleanupAttempts[]'}.`,
    `Failed provisioning permanently occupies a slot: one bogus-provider spawn (${badProviderAttempt.code ?? badProviderAttempt.message}) + one live spawn filled maxMembers=${MAX_MEMBERS}, and the next spawn was refused with ${overLimitSpawn.code ?? '(unexpected success)'}.`,
    `listMembers = 1 Lead row + durable projection members; failed rows are counted by the projection too (team A projection=${evidence.projectionComparison[0]?.projectionMemberCount}, listMembers=${evidence.projectionComparison[0]?.listMembersLength}; team B rowsWithFailedPhase=${evidence.projectionComparison[1]?.rowsWithFailedPhase}).`,
  ]

  process.exitCode = 0
} catch (error) {
  fatalError = { message: String(error?.message ?? error), stack: String(error?.stack ?? '').split('\n').slice(0, 12).join('\n') }
  evidence.fatalError = fatalError
  evidence.evidenceGaps.push('Probe aborted; only the fields recorded before the failure are evidence. See fatalError.')
  process.exitCode = 1
} finally {
  try { await shutdown?.shutdown?.(0) } catch (error) { evidence.shutdownError = String(error?.message ?? error) }
  try { await ctx?.fiber?.dispose?.() } catch (error) { evidence.disposeError = String(error?.message ?? error) }
  if (tempDir !== undefined) {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  const path = resolve(repo, OUT_PATH)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`member-reclaim-probe: attempts=${evidence.attempts.length} cleanupAttempts=${evidence.cleanupAttempts.length} rosterA=${evidence.roster.find(r => r.team === 'A')?.rosterSize ?? 'n/a'} rosterB=${evidence.roster.find(r => r.team === 'B')?.rosterSize ?? 'n/a'} fatal=${fatalError ? 'YES' : 'no'}`)
  console.log(`wrote ${OUT_PATH}`)
  process.exit(process.exitCode ?? 0)
}
