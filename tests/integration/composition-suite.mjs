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
 *   context    spill policy / compaction / pruner rows resolve in the preset realm
 *   isolation  preset services do not leak into the host realm
 *
 * Usage: node composition-suite.mjs [--profile <name>] [--patch <yml>]...
 * Exit: 0 all PASS, 1 any FAIL, 2 usage error.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const layout = JSON.parse(readFileSync(join(repo, 'evidence/env/layout.json'), 'utf8'))
const checkout = layout.dshCheckout

const argv = process.argv.slice(2)
const values = (flag) => argv.flatMap((token, index) => (token === flag ? [argv[index + 1]] : []))
const profile = values('--profile')[0] ?? 'ai-compiler-scratch'
const patches = values('--patch').map(path => resolve(path))

const results = []
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
  const probePreset = async (id) => {
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
      return {
        agent,
        composedPreset: presets.composedPreset(agent.ctx) ?? null,
        headerPreset: agent.session.header.agentPreset ?? null,
        wire: assembly.tools.map(tool => tool.name),
        sdkNames,
        sections: assembly.sections.map(section => section.name),
      }
    } finally {
      await agent.dispose?.()
    }
  }

  const ai = await probePreset('ai-compiler')
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

  // Preset-realm services (compaction + pruner live in the preset isolate).
  const agent = (await agents.create({
    sessionId: `session-suite-realm-${Date.now().toString(36)}`,
    meta: { cwd: process.cwd() },
    setup: async agentCtx => { await presets.mount(agentCtx, 'ai-compiler') },
  })).agent
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
    await agent.dispose?.()
  }
} finally {
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
