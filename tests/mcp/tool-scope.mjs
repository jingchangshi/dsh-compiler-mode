#!/usr/bin/env node
/**
 * E2/F2 acceptance: does the AgentGates MCP bridge reach exactly the two
 * compiler presets, and what does it actually cost?
 *
 * WHAT THIS MEASURES (numbers, not assumptions)
 * ---------------------------------------------
 * 1. VISIBILITY. The real profile is booted through the launcher's own
 *    runProfile(), then one Agent is created per preset and asked
 *    tools.get(name, scope) for all ten AgentGates tool names. That call is
 *    the registry view resolved along THAT Agent's scope chain, so it is the
 *    authoritative answer to "may this Agent call this tool at all". Both
 *    compiler presets must resolve all ten; Standard, PTC, Minimal and Cordis
 *    must resolve none. This is what proves that a row placed INSIDE a preset
 *    (rather than in the host bundle layer) really does scope.
 *
 *    The PTC SDK section is read too: both compiler presets render tools
 *    through run_code, so the ten names must appear as SDK bindings there.
 *
 * 2. PROCESS COUNT. Counted from /proc children of this process, matched on
 *    the server's argv. The interesting result is WHEN they appear: the
 *    mcp-client row belongs to a preset Generation, presets mount eagerly at
 *    registration, and Agents join that generation -- so the bridge is ONE
 *    child per preset, shared by every Agent of that preset, NOT one child per
 *    Agent. Verified by counting at boot, then after Agents are created.
 *
 * 3. STARTUP LATENCY. Per-preset boot-to-ready wall clock, and per-Agent
 *    creation time once the bridge is already live.
 *
 * 4. RSS. VmRSS of each bridge child, so a future move to a shared service can
 *    be decided from these numbers instead of a guess.
 *
 * WHY ONE CHILD PROCESS PER PRESET
 * --------------------------------
 * Probing six presets inside ONE boot is not reliably possible: composition
 * teardown makes the profile's Agent factory unusable partway through a long
 * probe sequence (measured: "no agent factory registered" after an Agent is
 * disposed, and "agent loop is not active" once several presets have been
 * assembled), which is a property of a long-lived throwaway harness, not of
 * the delivered presets. This script therefore re-executes itself with
 * --only <preset> once per preset and aggregates the JSON lines. Each probe
 * gets a pristine boot, and a failure in one preset cannot mask another.
 *
 * TWO SERVERS ARE SUPPORTED
 * -------------------------
 * --server <path> names the Python MCP program the row spawns; it is passed
 * through AGENT_GATES_MCP_PYTHON, which is exactly the override the delivered
 * row reads, so the YAML is never edited for a test. --stub selects
 * tests/mcp/fixtures/agentgates-stub-server.py, which speaks real MCP over
 * stdio and advertises the same ten names, for machines without a configured
 * AgentGates.
 *
 * Usage:
 *   node tests/mcp/tool-scope.mjs [--profile ai-compiler-scratch]
 *                                 [--server <python-mcp-program>] [--stub]
 *                                 [--json <outfile>]
 *
 *   --presets a,b    probe only these presets (default: all six)
 *   --only <preset>  internal: one preset, one boot, prints a RESULT line
 *   --restart        with --only: kill the bridge and report what recovers.
 *                    DIAGNOSTIC, not an assertion -- see docs/10-mcp-wiring.md,
 *                    "Server restart". It reports the measured outcome instead
 *                    of failing the suite on behaviour DSH does not promise.
 *
 * Exit: 0 every check passed, 1 a check failed, 2 usage/boot error.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const layout = JSON.parse(readFileSync(join(repo, 'evidence/env/layout.json'), 'utf8'))
const checkout = layout.dshCheckout

const argv = process.argv.slice(2)
const values = flag => argv.flatMap((token, index) => (token === flag ? [argv[index + 1]] : []))
const profile = values('--profile')[0] ?? 'ai-compiler-scratch'
const useStub = argv.includes('--stub')
const only = values('--only')[0] ?? null
const server = resolve(values('--server')[0]
  ?? (useStub
    ? join(repo, 'tests/mcp/fixtures/agentgates-stub-server.py')
    : join(layout.references.agentGates, '.venv/bin/python')))

/** The ten tool names the AgentGates server publishes (agent_gates/mcp_server.py). */
const AGENTGATES_TOOLS = ['cancel', 'doctor', 'list_gates', 'list_workspaces', 'report',
  'status', 'submit', 'verify', 'verify_requirements', 'wait']
const PREFIX = 'mcp__agentgates__'
const EXPECTED = AGENTGATES_TOOLS.map(name => PREFIX + name).sort()
const COMPILER_PRESETS = ['ai-compiler', 'ai-compiler-magpie']
const OTHER_PRESETS = ['standard', 'ptc', 'minimal', 'cordis']
const ALL_PRESETS = [...COMPILER_PRESETS, ...OTHER_PRESETS]

// --presets a,b,c narrows the run to a subset, for scripts/verify.sh, which
// wants one control preset rather than all four. Absent means all six.
const selected = values('--presets')[0]
const PROBE_PRESETS = selected === undefined
  ? ALL_PRESETS
  : selected.split(',').map(name => name.trim()).filter(name => name.length > 0)
for (const name of PROBE_PRESETS) {
  if (!ALL_PRESETS.includes(name)) {
    console.error('tool-scope: unknown preset ' + name + ' (known: ' + ALL_PRESETS.join(',') + ')')
    process.exit(2)
  }
}

/** True for a string of decimal digits only (a /proc entry name or an RSS value). */
const isDigits = text => text.length > 0 && text.length < 12
  && [...text].every(character => character >= '0' && character <= '9')

/** Every mcp__agentgates__* name among the given names, sorted. */
const agentgates = names => names.filter(name => name.startsWith(PREFIX)).sort()

/** Direct children of this process, read from /proc -- the really spawned set. */
function childProcesses() {
  const found = []
  for (const entry of readdirSync('/proc')) {
    if (!isDigits(entry)) continue
    let stat = null
    try {
      stat = readFileSync('/proc/' + entry + '/stat', 'utf8')
    } catch {
      continue // the child exited between readdir and read
    }
    // comm is parenthesised and may contain spaces, so parse from the last ')'.
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (Number(tail[1]) !== process.pid) continue
    let cmdline = ''
    try {
      cmdline = readFileSync('/proc/' + entry + '/cmdline', 'utf8')
        .split(String.fromCharCode(0)).join(' ').trim()
    } catch {
      continue
    }
    found.push({ pid: Number(entry), cmdline })
  }
  return found
}

/** Resident set size of one pid in bytes, or 0 when it is already gone. */
function rssBytes(pid) {
  let status = ''
  try {
    status = readFileSync('/proc/' + pid + '/status', 'utf8')
  } catch {
    return 0
  }
  for (const line of status.split(String.fromCharCode(10))) {
    if (!line.startsWith('VmRSS:')) continue
    const value = line.slice('VmRSS:'.length).trim().split(' ')
    return isDigits(value[0]) ? Number(value[0]) * 1024 : 0
  }
  return 0
}

/**
 * The bridge children of this run.
 *
 * Matching on the module name (not the executable path) keeps the count
 * correct whether the row runs the delivered venv default, a --server
 * override, or the stub fixture.
 */
const isBridge = child => child.cmdline.includes('agent_gates.mcp_server')
const bridges = () => childProcesses().filter(isBridge)

/**
 * Names bound in a PTC SDK section, read without a regex: each binding is an
 * exactly-two-space indented "name: Type" line, so split on newlines and take
 * the prefix before the first colon.
 */
const sdkBindings = text => {
  const names = []
  for (const line of text.split(String.fromCharCode(10))) {
    if (!line.startsWith('  ') || line.startsWith('   ')) continue
    const colon = line.indexOf(':')
    if (colon <= 2) continue
    const name = line.slice(2, colon).trim()
    if (name.length > 0 && !names.includes(name)) names.push(name)
  }
  return names.sort()
}

// ---------------------------------------------------------------------------
// Mode A: one preset, one pristine boot. Prints exactly one RESULT line.
// ---------------------------------------------------------------------------
if (only !== null) {
  const { runProfile } = await import(pathToFileURL(join(checkout, 'apps/cli/lib/profile-boot.js')).href)
  const { scopeOf } = await import(pathToFileURL(join(checkout, 'packages/core/scope/lib/index.js')).href)

  // The delivered row resolves its command from process.env.AGENT_GATES_MCP_PYTHON
  // in an !!js expression, which the Loader evaluates against THIS process's own
  // environment. Setting it here selects the server under test without touching
  // the YAML; the profile's launch snapshot is what the row's own env map is
  // merged over, so both layers stay exactly as delivered.
  process.env.AGENT_GATES_MCP_PYTHON = server

  const entries = Object.fromEntries(Object.entries(process.env)
    .map(([name, value]) => [name, { value: value ?? '' }]))
  const launch = { entries, get: name => entries[name], has: name => entries[name] !== undefined }

  const bootStarted = process.hrtime.bigint()
  const booted = await runProfile({ environment: launch, profile, patchFiles: [], args: ['mcp-tool-scope'] })
  const bootMs = Number(process.hrtime.bigint() - bootStarted) / 1e6
  const ctx = booted.ctx
  const shutdown = booted.shutdown
  let payload = {}
  try {
    const presets = ctx.get('agentPresets')
    const agents = ctx.get('agents')
    const prompt = ctx.get('systemPrompt')
    const tools = ctx.get('tools')
    if (presets === undefined || agents === undefined || prompt === undefined || tools === undefined) {
      payload = { error: 'profile is missing agentPresets/agents/systemPrompt/tools' }
    } else {
      const roster = await presets.list()
      const row = roster.find(candidate => candidate.id === only)
      const liveBridgesAtBoot = bridges()
      const rssAtBoot = liveBridgesAtBoot.map(child => rssBytes(child.pid))
      const createdStarted = process.hrtime.bigint()
      const handle = await agents.create({
        sessionId: 'session-mcp-scope-' + only + '-' + Date.now().toString(36)
          + '-' + Math.random().toString(36).slice(2, 8),
        meta: { cwd: process.cwd() },
        setup: async agentCtx => { await presets.mount(agentCtx, only) },
      })
      const createMs = Number(process.hrtime.bigint() - createdStarted) / 1e6
      const scope = scopeOf(handle.agent.ctx)
      const resolvable = EXPECTED.filter(name => tools.get(name, scope) !== undefined)
      const assembly = await prompt.assemble({ agent: handle.agent, scope })
      const sdkSection = assembly.sections.find(section => section.name === 'tools:sdk')

      // A TEAMMATE, not just the Lead, must be able to call a gate tool.
      //
      // A child Agent joins its parent's preset revision through
      // `agentPresets.composeFrom` (packages/subagent/subagent/src/child-agent.ts),
      // so it inherits the same scope chain and therefore the same bridge. That
      // is the property this asserts: the gate tools are a property of the
      // preset, and every member spawned under it sees them without any extra
      // wiring. A child that did NOT inherit them would mean gate verification
      // worked for the Lead and silently failed for the Team, which is exactly
      // the shape of bug the completion policy must not have.
      //
      // The call is `presets.composeFrom(childCtx, parent.ctx)` because that is
      // EXACTLY what the teammate path runs: the subagent manager's
      // applyChildComposition calls it for a child with no own preset selection
      // (packages/subagent/subagent/src/child-agent.ts). Testing the same API
      // keeps this deterministic -- no model, no Team turn -- while still
      // asserting the inheritance that makes a Teammate able to call gates.
      let teammate = { created: false, resolvableCount: 0, error: null }
      try {
        const childHandle = await agents.create({
          sessionId: 'session-mcp-scope-' + only + '-child-' + Date.now().toString(36)
            + '-' + Math.random().toString(36).slice(2, 8),
          meta: { cwd: process.cwd() },
          setup: async childCtx => { presets.composeFrom(childCtx, handle.agent.ctx) },
        })
        const childScope = scopeOf(childHandle.agent.ctx)
        teammate = {
          created: true,
          resolvableCount: EXPECTED.filter(name => tools.get(name, childScope) !== undefined).length,
          composedPreset: presets.composedPreset(childHandle.agent.ctx) ?? null,
          error: null,
        }
      } catch (error) {
        teammate = { created: false, resolvableCount: 0, error: String(error && error.message ? error.message : error) }
      }

      // RECOVERY: kill the preset's own bridge children and confirm the row
      // replaces them. A stdio MCP server that dies must not leave the model
      // with a dead tool list, and `reconnect.enabled: true` alone does not
      // prove recovery -- the observable proof is new child PIDs serving the
      // same ten names afterward. Only run on request (`--restart`), because it
      // deliberately breaks the bridge for a few seconds.
      let restart = null
      if (argv.includes('--restart')) {
        const before = bridges()
        for (const child of before) {
          try { process.kill(child.pid, 'SIGKILL') } catch { /* already gone */ }
        }
        // The client's backoff starts at 500 ms; poll rather than sleep a guess.
        const deadline = Date.now() + 30000
        let after = []
        while (Date.now() < deadline) {
          after = bridges()
          if (after.length >= before.length && after.every(child => before.every(old => old.pid !== child.pid))) break
          await new Promise(done => setTimeout(done, 250))
        }
        // Registration is re-run when the connection comes back; allow the
        // registry a moment to reflect it before reading the view again.
        let recovered = 0
        for (let attempt = 0; attempt < 40; attempt += 1) {
          recovered = EXPECTED.filter(name => tools.get(name, scope) !== undefined).length
          if (recovered === EXPECTED.length) break
          await new Promise(done => setTimeout(done, 250))
        }
        restart = {
          killedPids: before.map(child => child.pid),
          newPids: after.map(child => child.pid),
          replaced: after.length >= before.length
            && after.every(child => before.every(old => old.pid !== child.pid)),
          recoveredTools: recovered,
          waitedMs: Math.round(30000 - Math.max(0, deadline - Date.now())),
        }
      }

      payload = {
        preset: only,
        teammate,
        restart,
        declared: row !== undefined,
        broken: row === undefined ? 'absent' : (row.broken ?? null),
        composedPreset: presets.composedPreset(handle.agent.ctx) ?? null,
        resolvable,
        sdkNames: typeof sdkSection?.text === 'string' ? agentgates(sdkBindings(sdkSection.text)) : [],
        wireNames: assembly.tools.map(tool => tool.name),
        bootMs: Number(bootMs.toFixed(1)),
        createMs: Number(createMs.toFixed(1)),
        bridgesAtBoot: liveBridgesAtBoot.length,
        bridgesWithAgent: bridges().length,
        childCmdlines: liveBridgesAtBoot.map(child => child.cmdline),
        rssAtBoot,
      }
    }
  } catch (error) {
    payload = { preset: only, error: String(error && error.message ? error.message : error) }
  }
  console.log('RESULT ' + JSON.stringify(payload))
  await shutdown?.shutdown?.(0)
  await ctx?.fiber?.dispose?.()
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Mode B: orchestrate one child per preset and aggregate.
// ---------------------------------------------------------------------------
const results = []
const check = (group, name, ok, detail) => {
  results.push({ group, name, ok: Boolean(ok), detail })
  console.log((ok ? 'PASS' : 'FAIL') + '  [' + group + '] ' + name
    + (detail === undefined ? '' : ' — ' + detail))
}

const probes = []
for (const preset of PROBE_PRESETS) {
  const childArgv = [fileURLToPath(import.meta.url), '--only', preset, '--profile', profile, '--server', server]
  const run = spawnSync(process.execPath, childArgv, { encoding: 'utf8', timeout: 180000 })
  const line = (run.stdout ?? '').split(String.fromCharCode(10)).find(text => text.startsWith('RESULT '))
  if (line === undefined) {
    const message = (run.stderr ?? '').split(String.fromCharCode(10)).filter(Boolean).slice(-3).join(' | ')
    probes.push({ preset, error: 'no RESULT line (exit ' + run.status + '): ' + message })
    continue
  }
  probes.push(JSON.parse(line.slice('RESULT '.length)))
}

for (const probe of probes) {
  const label = probe.preset
  check('roster', label + ' is declared and mounts without diagnostics',
    probe.declared === true && probe.broken === null, probe.error ?? (probe.broken ?? 'healthy'))
  if (probe.error !== undefined) continue
  const expected = COMPILER_PRESETS.includes(label)
  if (expected) {
    check('visibility', label + ' Agent resolves all ten AgentGates tools',
      JSON.stringify(probe.resolvable) === JSON.stringify(EXPECTED),
      probe.resolvable.length + '/' + EXPECTED.length + ': '
        + (probe.resolvable.join(',') || '(none)'))
    check('visibility', label + ' PTC SDK binds all ten AgentGates tools',
      JSON.stringify(probe.sdkNames) === JSON.stringify(EXPECTED),
      probe.sdkNames.length + '/' + EXPECTED.length + ': '
        + (probe.sdkNames.join(',') || '(none)'))
    check('visibility', label + ' Agent is bound to its own preset revision',
      probe.composedPreset === label, String(probe.composedPreset))
    // A Teammate inherits the preset, so it must inherit the gate tools too.
    check('visibility', label + ' Teammate inherits all ten AgentGates tools',
      probe.teammate?.created === true && probe.teammate.resolvableCount === EXPECTED.length,
      probe.teammate?.error ?? (probe.teammate?.resolvableCount + '/' + EXPECTED.length
        + ' as ' + String(probe.teammate?.composedPreset)))
  } else {
    check('isolation', label + ' Agent resolves no AgentGates tool',
      probe.resolvable.length === 0, probe.resolvable.join(',') || '(none)')
    check('isolation', label + ' PTC SDK binds no AgentGates tool',
      probe.sdkNames.length === 0, probe.sdkNames.join(',') || '(none)')
    check('isolation', label + ' Teammate inherits no AgentGates tool',
      probe.teammate?.created === true && probe.teammate.resolvableCount === 0,
      probe.teammate?.error ?? (probe.teammate?.resolvableCount + ' resolved'))
  }
}

// Process cost, measured on EVERY boot rather than only the compiler-preset
// ones, because every boot registers every preset -- that is exactly the point:
//
//   * the profile ALWAYS spawns one bridge per compiler preset the moment the
//     presets mount, before any Agent exists, whichever preset the session later
//     uses. With two compiler presets that is two python processes -- and about
//     135 MiB -- on every boot, including a Standard-mode boot. Uninstalling the
//     bundle is the only way to stop paying it;
//   * joining an Agent adds NONE, because the child belongs to the preset's
//     Generation, which every Agent of that preset shares.
//
// The cost is therefore per DSH process and per compiler preset, not per
// Agent, and the numbers below are the measured ones.
const ready = probes.filter(probe => probe.error === undefined)
const probedCompilerPresets = COMPILER_PRESETS.filter(id => PROBE_PRESETS.includes(id))
// Presets mount eagerly at registration, so a subset run still spawns every
// compiler preset's bridge: the count is a property of the profile, not of what
// this invocation chose to probe.
const expectedBridges = COMPILER_PRESETS.length
check('process', 'EVERY boot spawns ' + expectedBridges + ' bridges, before any Agent (both compiler presets mount eagerly)',
  ready.length === probes.length && ready.every(probe => probe.bridgesAtBoot === expectedBridges),
  ready.map(probe => probe.preset + '=' + probe.bridgesAtBoot).join(', ')
    + ' (expected ' + expectedBridges + ' on every boot, including non-compiler ones)')
check('process', 'creating an Agent adds no bridge child (one per preset, shared)',
  ready.every(probe => probe.bridgesWithAgent === probe.bridgesAtBoot),
  ready.map(probe => probe.preset + ': ' + probe.bridgesAtBoot + '->' + probe.bridgesWithAgent).join(', ')
    || '(none)')
check('process', 'every bridge is a real python MCP server process',
  ready.length > 0 && ready.every(probe => probe.childCmdlines.every(cmdline => cmdline.includes('python'))),
  (ready[0]?.childCmdlines ?? []).join(' | ') || '(none)')
check('resources', 'every bridge holds a measurable RSS',
  ready.length > 0 && ready.every(probe => probe.rssAtBoot.length === expectedBridges
    && probe.rssAtBoot.every(bytes => bytes > 0)),
  ready.map(probe => probe.preset + '=' + probe.rssAtBoot
    .map(bytes => (bytes / 1048576).toFixed(1)).join('+') + ' MiB').join(', ') || '(none)')

const measurement = {
  server,
  stub: useStub,
  profile,
  // Stated precisely, because the earlier wording implied the bridge appeared
  // only for the mode in use: BOTH compiler presets mount at preset
  // registration, so every boot -- including a Standard-mode boot -- carries
  // one bridge per compiler preset, and each is shared by all Agents of its
  // preset.
  note: 'presets mount eagerly: EVERY boot spawns ' + expectedBridges
    + ' MCP server children (one per compiler preset, shared by every Agent of that preset),'
    + ' whichever preset the session later uses',
  perPreset: probes.map(probe => ({
    preset: probe.preset,
    bootMs: probe.bootMs ?? null,
    agentCreateMs: probe.createMs ?? null,
    bridgesAtBoot: probe.bridgesAtBoot ?? null,
    bridgesWithAgent: probe.bridgesWithAgent ?? null,
    bridgeRssMiB: (probe.rssAtBoot ?? []).map(bytes => Number((bytes / 1048576).toFixed(1))),
    childCmdlines: probe.childCmdlines ?? [],
  })),
}
console.log('MEASURED ' + JSON.stringify(measurement))

const report = {
  profile,
  server,
  stub: useStub,
  at: new Date().toISOString(),
  expectedTools: EXPECTED,
  measurement,
  results,
  verdict: results.every(result => result.ok) ? 'PASS' : 'FAIL',
}
// An explicit --json target, plus the repo's own evidence copy: the numbers in
// docs/10-mcp-wiring.md must be reproducible from a committed artifact, not from
// whatever the last terminal scrollback happened to show.
const jsonOut = values('--json')[0] ?? null
if (jsonOut !== null) {
  mkdirSync(dirname(resolve(jsonOut)), { recursive: true })
  writeFileSync(resolve(jsonOut), JSON.stringify(report, null, 2) + String.fromCharCode(10))
}
mkdirSync(join(repo, 'evidence/tests'), { recursive: true })
writeFileSync(join(repo, 'evidence/tests/mcp-tool-scope.json'),
  JSON.stringify(report, null, 2) + String.fromCharCode(10))
const failed = results.filter(result => !result.ok)
console.log((results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
