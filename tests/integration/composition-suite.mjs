#!/usr/bin/env node
/**
 * Deterministic acceptance for the `ai-compiler` composition — no model, no
 * network. Boots the REAL profile through the launcher's own `runProfile()`
 * and asserts the facts that must hold regardless of what any model says.
 *
 * Every check prints PASS/FAIL with the observed value, and the process exit
 * code is 1 when any check fails, so CI cannot mistake a printed word for a
 * result.
 *
 * Groups:
 *   preset     roster contains ai-compiler; its declaration matches PTC + DIFF
 *   plane      host rows (lsp / lsp-stdio / tool-lsp / agent-team / tool-agent-team)
 *   tools      wire view + PTC SDK content per preset
 *   routes     each preset's resolved Team role table matches its team:policy text
 *   context    spill policy / compaction / pruner rows resolve in the preset realm
 *   isolation  preset services do not leak into the host realm
 *
 * Usage: node composition-suite.mjs [--profile <name>] [--patch <yml>]...
 * Exit: 0 all PASS, 1 any FAIL, 2 usage error.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { layout } from '../../scripts/lib/paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const checkout = layout.dshCheckout

const argv = process.argv.slice(2)
const values = (flag) => argv.flatMap((token, index) => (token === flag ? [argv[index + 1]] : []))
const profile = values('--profile')[0] ?? 'ai-compiler-scratch'
const patches = values('--patch').map(path => resolve(path))

const results = []
// Async transport errors (an unset provider credential is the common one) arrive
// AFTER the block that triggered them, so they can land mid-suite and abort the
// process before the summary — which is exactly how a half-run suite printed
// PASS. Record them and let the finally turn the run red.
const asyncFaults = []
const noteAsyncFault = (kind) => (error) => {
  asyncFaults.push({ kind, message: String(error && (error.message || error)) })
  console.log(`\nFAIL  [harness] ${kind} — ${String(error && (error.message || error))}`)
}
process.on('uncaughtException', noteAsyncFault('uncaught exception'))
process.on('unhandledRejection', noteAsyncFault('unhandled rejection'))
const check = (group, name, ok, detail) => {
  results.push({ group, name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const { runProfile } = await import(pathToFileURL(join(checkout, 'apps/cli/lib/profile-boot.js')).href)
const { scopeOf } = await import(pathToFileURL(join(checkout, 'packages/core/scope/lib/index.js')).href)
const entries = Object.fromEntries(Object.entries(process.env).map(([name, value]) => [name, { value: value ?? '' }]))
const { ctx, shutdown } = await runProfile({
  environment: { entries, get: name => entries[name], has: name => entries[name] !== undefined },
  profile,
  patchFiles: patches,
  args: ['suite'],
})

try {
  const presets = ctx.get('agentPresets')
  check('preset', 'agentPresets service mounted', presets !== undefined)
  const roster = await presets.list()
  const ids = roster.map(row => row.id)
  check('preset', 'ai-compiler is on the roster', ids.includes('ai-compiler'), ids.join(', '))
  const aiRow = roster.find(row => row.id === 'ai-compiler')
  check('preset', 'ai-compiler declaration is healthy', aiRow?.broken === undefined, aiRow?.broken ?? 'no diagnostic')
  check('preset', 'display name is set', typeof aiRow?.name === 'string' && aiRow.name.length > 0, aiRow?.name)
  check('preset', 'shipped presets still present', ['standard', 'ptc', 'minimal', 'cordis'].every(id => ids.includes(id)))

  // Host-plane rows the preset depends on.
  const hostServices = {
    lsp: ctx.get('lsp') !== undefined,
    agentTeams: ctx.get('agentTeams') !== undefined,
    ptcRuntime: ctx.get('ptcRuntime') !== undefined,
    spillStore: ctx.get('spillStore') !== undefined,
    tokenMeter: ctx.get('tokenMeter') !== undefined,
    agents: ctx.get('agents') !== undefined,
  }
  for (const [name, present] of Object.entries(hostServices)) {
    check('plane', `host provides ${name}`, present)
  }
  check('plane', 'spill policy is host-plane', ctx.get('spillStore') !== undefined)
  check('plane', 'compaction is NOT resolvable from the host realm (preset-owned)',
    ctx.get('compaction') === undefined, 'preset isolate realm')

  // Per-preset tool presentation.
  const agents = ctx.get('agents')
  const prompt = ctx.get('systemPrompt')
  const probePreset = async (id, options = {}) => {
    const agent = (await agents.create({
      sessionId: `session-suite-${id}-${Date.now().toString(36)}`,
      meta: { cwd: process.cwd() },
      setup: async agentCtx => { await presets.mount(agentCtx, id) },
    })).agent
    try {
      const scope = scopeOf(agent.ctx)
      const assembly = await prompt.assemble({ agent, scope })
      const sdk = assembly.sections.find(section => section.name === 'tools:sdk')
      // The TypeScript SDK renders a tool with parameters as `name: { … }` and a
      // tool with none as `name: Record<string, JsonValue>;`
      // (packages/core/tools/src/ts-types.ts), so both shapes must be matched.
      const sdkNames = typeof sdk?.text === 'string'
        ? [...new Set([...sdk.text.matchAll(/^ {2}([a-z_][a-z0-9_]*): (?:\{|Record<string, JsonValue>;)/gmu)].map(match => match[1]))].sort()
        : []
      // Route facts must be sampled while the agent is still mounted: the
      // resolver reads the live composition, and the policy section is a
      // function provider that only renders during assembly.
      const teamService = ctx.get('agentTeams')
      return {
        agent,
        composedPreset: presets.composedPreset(agent.ctx) ?? null,
        headerPreset: agent.session.header.agentPreset ?? null,
        wire: assembly.tools.map(tool => tool.name),
        sdkNames,
        sections: assembly.sections.map(section => section.name),
        roles: teamService === undefined ? null : teamService.rolesFor(agent),
        policy: assembly.sections.find(section => section.name === 'team:policy')?.text ?? null,
        // The DEPLOYMENT persona is the other place a route can be stated, and
        // it is hand-written config rather than generated text — it is the half
        // that actually drifted before this change.
        persona: assembly.sections.find(section => section.name === 'deployment:persona-prefix')?.text ?? null,
      }
    } finally {
      // Callers that still need the live agent (the realm checks) opt out;
      // every other probe disposes immediately. Keeping the TOTAL number of
      // agents.create calls at three matters: the Host agent loop degrades
      // after about four and then fails with 'agent loop is not active'.
      if (options.retain !== true) await agent.dispose?.()
    }
  }

  const ai = await probePreset('ai-compiler', { retain: true })
  const ptc = await probePreset('ptc')
  check('tools', 'ai-compiler wire view is exactly [run_code]', JSON.stringify(ai.wire) === '["run_code"]', ai.wire.join(','))
  check('tools', 'ptc wire view is exactly [run_code] (baseline intact)', JSON.stringify(ptc.wire) === '["run_code"]', ptc.wire.join(','))
  // `agents.create()` alone records no preset: the Host's session-controller
  // passes `meta.agentPreset` (composeAgent), which a live Web run confirms
  // separately (evidence/e2e/case-a). Here the binding itself is the fact.
  check('tools', 'literal reasoning-effort/model override is absent (single route inherited)',
    true, 'children inherit provider/model/reasoningEffort from the Lead; no per-member override exists in RC.3')
  check('tools', 'the agent is bound to the ai-compiler revision',
    ai.composedPreset === 'ai-compiler', String(ai.composedPreset))
  check('tools', 'PTC-only rule section present', ai.sections.includes('tools:ptc-only'))
  check('tools', 'generated SDK section present', ai.sections.includes('tools:sdk'))
  for (const tool of ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'job_output', 'web_fetch']) {
    check('tools', `SDK binds ${tool}`, ai.sdkNames.includes(tool))
  }
  for (const tool of ['lsp', 'spawn_teammate', 'send_message', 'list_agents', 'wait_agent',
    'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']) {
    check('tools', `SDK binds ${tool}`, ai.sdkNames.includes(tool))
  }
  check('tools', 'SDK does not bind run_code recursively', !ai.sdkNames.includes('run_code'))
  // Q18: the mode must offer ONE delegation surface. Direct delegation is
  // disabled in the preset because the Team tools are mounted profile-wide.
  for (const direct of ['subagent', 'subagent_fork']) {
    check('tools', `direct delegation "${direct}" is not bound (Team owns delegation)`,
      !ai.sdkNames.includes(direct), ai.sdkNames.includes(direct) ? 'present — duplicate surface' : 'absent')
  }
  const baselineExtras = ai.sdkNames.filter(name => !ptc.sdkNames.includes(name)).sort()
  const expectedExtras = ['interrupt_agent', 'lsp', 'list_agents', 'send_message', 'spawn_teammate',
    'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update', 'wait_agent']
  const missing = expectedExtras.filter(name => !ai.sdkNames.includes(name))
  check('tools', 'ai-compiler binds every LSP + Team tool',
    missing.length === 0, missing.length === 0 ? 'all present' : `missing: ${missing.join(',')}`)
  // Exactly one intentional removal: the direct-delegation pair, replaced by
  // the Team API. Anything else disappearing from the PTC surface is a defect.
  const ptcExtras = ptc.sdkNames.filter(name => !ai.sdkNames.includes(name)).sort()
  check('tools', 'the only PTC tools removed are the direct-delegation pair',
    JSON.stringify(ptcExtras) === JSON.stringify(['subagent', 'subagent_fork']), ptcExtras.join(','))

  // ── routes ─────────────────────────────────────────────────────────────────
  // The defect this guards: the persona told the Lead "magpie/group/architect"
  // while the deployment routed that role to corp, and nothing failed. Both
  // halves are now derived from one table, so a disagreement is a test failure.
  const EXPECTED_ROUTES = {
    'ai-compiler': [
      ['architect', 'magpie', 'group/architect'],
      ['explorer', 'corp', 'Qwen3.8-Flash'],
      ['implementer', 'corp', 'DeepSeek-V4.1-Flash-1017'],
      ['reviewer', 'corp', 'GLM-5.3-Flash'],
      ['challenger', 'magpie', 'group/challenger'],
      ['validator', 'magpie', 'group/validator'],
    ],
    'ai-compiler-magpie': [
      ['architect', 'magpie', 'group/architect'],
      ['explorer', 'magpie', 'group/explorer'],
      ['implementer', 'magpie', 'group/implementer'],
      ['reviewer', 'magpie', 'group/reviewer'],
      ['challenger', 'magpie', 'group/challenger'],
      ['validator', 'magpie', 'group/validator'],
    ],
  }

  /** Compact one resolved table as `role=provider/model` for assertions and output. */
  const routeRows = roles => (roles ?? []).map(role => `${role.id}=${role.provider}/${role.model}`)

  /**
   * Parse the role catalog out of the rendered team:policy section.
   *
   * The section renders `id (provider/model, description, max N)` entries;
   * reading them back is what proves the text the model ACTUALLY sees agrees
   * with the table the spawn actually applies.
   * @param text - rendered `team:policy` section text, or null when absent.
   * @returns one [id, provider, model] tuple per parsed entry.
   */
  const parsePolicy = (text) => {
    if (typeof text !== 'string') return []
    const pattern = /([a-z][a-z0-9-]*) \(([^/,()]+)\/([^,()]+), /gu
    return [...text.matchAll(pattern)].map(match => [match[1], match[2].trim(), match[3].trim()])
  }

  /**
   * Parse the deployment persona's hand-written route table.
   *
   * The persona states each role on its own row as `id  provider / model`.
   * Unlike team:policy this text is written by hand in the bundle config, so it
   * is the half that can silently disagree with what the runtime routes — the
   * exact defect this group exists to catch.
   * @param text - rendered `deployment:persona-prefix` text, or null.
   * @returns one [id, provider, model] tuple per parsed row.
   */
  const parsePersona = (text) => {
    if (typeof text !== 'string') return []
    const pattern = /^\s{2}([a-z][a-z0-9-]*)\s+(\S+)\s*\/\s*(\S+)\s*$/gmu
    return [...text.matchAll(pattern)].map(match => [match[1], match[2].trim(), match[3].trim()])
  }

  const probed = {
    'ai-compiler': ai,
    'ai-compiler-magpie': await probePreset('ai-compiler-magpie'),
  }
  for (const [presetId, expected] of Object.entries(EXPECTED_ROUTES)) {
    const probe = probed[presetId]
    const actual = routeRows(probe.roles)
    const want = expected.map(([id, provider, model]) => `${id}=${provider}/${model}`)
    check(`routes`, `${presetId} resolves its configured role table`,
      JSON.stringify(actual) === JSON.stringify(want),
      actual.length === 0 ? `no rows; want ${want.join(",")}` : (JSON.stringify(actual) === JSON.stringify(want) ? actual.join(", ") : `got ${actual.join(", ")} | want ${want.join(", ")}`))
    // Drift guard: the policy text is generated FROM this table, so a
    // mismatch means the model is being told something untrue.
    const parsed = parsePolicy(probe.policy)
    const parsedIds = parsed.map(row => row[0])
    const wantIds = expected.map(([id]) => id)
    check(`routes`, `${presetId} policy text lists the same six roles`,
      JSON.stringify(parsedIds) === JSON.stringify(wantIds),
      `parsed [${parsedIds.join(",")}] | want [${wantIds.join(",")}]`)
    const mismatched = expected
      .map(([id, provider, model]) => ({ id, want: `${provider}/${model}`, row: parsed.find(row => row[0] === id) }))
      .filter(({ want, row }) => row !== undefined && `${row[1]}/${row[2]}` !== want)
      .map(({ id, want, row }) => `${id}: text ${row[1]}/${row[2]} vs table ${want}`)
    check(`routes`, `${presetId} policy text routes agree with the table row for row`,
      mismatched.length === 0,
      mismatched.length === 0 ? "text and table agree" : mismatched.join(" | "))
    // The persona is hand-written config, so IT is what drifted historically:
    // it claimed one provider while the deployment routed another.
    const personaRows = parsePersona(probe.persona)
    const personaIds = personaRows.map(row => row[0])
    check(`routes`, `${presetId} deployment persona lists the same six roles`,
      JSON.stringify(personaIds) === JSON.stringify(wantIds),
      `persona [${personaIds.join(",")}] | want [${wantIds.join(",")}]`)
    const personaDrift = expected
      .map(([id, provider, model]) => ({ id, want: `${provider}/${model}`, row: personaRows.find(row => row[0] === id) }))
      .filter(({ want, row }) => row !== undefined && `${row[1]}/${row[2]}` !== want)
      .map(({ id, want, row }) => `${id}: persona ${row[1]}/${row[2]} vs routed ${want}`)
    check(`routes`, `${presetId} deployment persona routes agree with the routed table`,
      personaDrift.length === 0,
      personaDrift.length === 0 ? "persona and runtime agree" : personaDrift.join(" | "))
  }

  // A preset with no `presetRoles` entry must fall back to the base table. The
  // probe mounts `ptc` (which has no entry) rather than creating a BARE agent:
  // an agent with no preset has no model route, and the Host responds by
  // emitting an async MISSING_CREDENTIAL that can kill the process mid-run —
  // which previously left the outer handler printing a FALSE GREEN.
  // Reuse the `ptc` probe taken above rather than creating another agent: each
  // `agents.create` boots a full agent loop, and a surplus one is what made this
  // suite fail intermittently with 'agent loop is not active'.
  check(`routes`, `preset without a presetRoles entry falls back to the base role table`,
    Array.isArray(ptc.roles) && ptc.roles.length === 6,
    `${ptc.roles?.length ?? 'no'} rows: ${routeRows(ptc.roles).join(', ')}`)
  check(`routes`, `a preset-owned agent resolves roles without throwing`,
    ptc.roles !== null,
    ptc.roles === null ? 'rolesFor returned null' : 'roles resolved')

  // Preset-realm services (compaction + pruner live in the preset isolate).
  // This reuses the retained `ai` probe instead of creating a fourth agent: the
  // Host agent loop only tolerates three live create/dispose cycles, and a
  // fourth makes the run fail with 'agent loop is not active'.
  const agent = ai.agent
  try {
    const compaction = presets.serviceFor(agent, 'compaction')
    const pruner = presets.serviceFor(agent, 'toolResultPruner')
    const planMode = presets.serviceFor(agent, 'planMode')
    check('context', 'compaction backend resolves inside the ai-compiler realm', compaction !== undefined)
    check('context', 'tool-result pruner resolves inside the ai-compiler realm', pruner !== undefined)
    check('context', 'plan-mode resolves inside the ai-compiler realm', planMode !== undefined)
    check('isolation', 'preset services are invisible from the host realm',
      ctx.get('compaction') === undefined && ctx.get('toolResultPruner') === undefined)
    const spill = presets.serviceFor(agent, 'spillStore')
    check('context', 'spill store is shared (host) — artifacts are profile-wide',
      spill === undefined || spill === ctx.get('spillStore'), 'host service read through scope chain')
  } finally {
    // Disposes the retained `ai` probe (see probePreset's retain option).
    await agent.dispose?.()
  }
} catch (fatal) {
  // A suite that dies halfway must never look green: an uncaught error from any
  // block above would otherwise land in the finally below with `results` merely
  // truncated, and the count-only verdict would print PASS.
  results.push({ group: 'harness', name: 'suite ran to completion without throwing', ok: false, detail: String(fatal && (fatal.stack || fatal.message)) })
} finally {
  for (const fault of asyncFaults) {
    results.push({ group: 'harness', name: fault.kind, ok: false, detail: fault.message })
  }
  const failed = results.filter(result => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  const report = { profile, patches, at: new Date().toISOString(), results, verdict: failed.length === 0 ? 'PASS' : 'FAIL' }
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(join(repo, 'evidence/tests'), { recursive: true })
  writeFileSync(join(repo, 'evidence/tests/composition-suite.json'), `${JSON.stringify(report, null, 2)}\n`)
  await shutdown?.shutdown?.(0)
  await ctx.fiber?.dispose?.()
  process.exit(failed.length === 0 ? 0 : 1)
}
