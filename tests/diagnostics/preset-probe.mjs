#!/usr/bin/env node
/**
 * Diagnostic probe: boot the real profile and print what the MODEL would see
 * per preset, without running a task.
 *
 * Booting through `apps/cli/lib/profile-boot.js` `runProfile()` gives the exact
 * same composition the launcher builds (bundle layers → profile layer →
 * overlays). After the tree settles, this probe:
 *
 *   1. lists the registry roster (`agentPresets.list()`),
 *   2. for each requested preset: creates a throwaway Agent through
 *      `ctx.agents.create({ setup: ctx => agentPresets.mount(ctx, id) })`,
 *   3. reads `ctx.tools.providerSchemas?` / the registry's wire view and the
 *      system-prompt sections from that Agent's own context, and prints them.
 *
 * It writes nothing and submits no turn: the Agent is disposed immediately.
 *
 * Usage: node preset-probe.mjs --profile <name> [--patch <yml>]... --preset <id>...
 * Exit: 0 on success, 1 on a boot or probe failure, 2 on usage error.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { layout } from '../../scripts/lib/paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const checkout = layout.dshCheckout
const argv = process.argv.slice(2)
const values = (flag) => argv.flatMap((token, index) => (token === flag ? [argv[index + 1]] : []))
const profile = values('--profile')[0]
const patches = values('--patch').map(path => resolve(path))
const presets = values('--preset')
const task = values('--task')[0] ?? null
if (profile === undefined || presets.length === 0) {
  console.error('usage: preset-probe.mjs --profile <name> [--patch <yml>]... --preset <id>...')
  process.exit(2)
}

const { runProfile } = await import(pathToFileURL(join(checkout, 'apps/cli/lib/profile-boot.js')).href)
const { resolveDshHome } = await import(pathToFileURL(join(checkout, 'packages/util/home-paths/lib/index.js')).href)

/** The launcher's own launch-environment snapshot shape, built from this process. */
function launchSnapshot() {
  const entries = Object.fromEntries(Object.entries(process.env).map(([name, value]) => [name, { value: value ?? '' }]))
  return { entries, get: name => entries[name], has: name => entries[name] !== undefined }
}

const { ctx, shutdown } = await runProfile({
  environment: launchSnapshot(),
  profile,
  patchFiles: patches,
  args: task === null ? [] : ['--json', task],
})

try {
  const presetsService = ctx.get('agentPresets')
  const agents = ctx.get('agents')
  if (presetsService === undefined || agents === undefined) {
    console.error('the profile composed no agentPresets and/or agents service')
    process.exit(1)
  }
  const roster = await presetsService.list()
  const report = { profile, roster: roster.map(row => ({ id: row.id, name: row.name, order: row.order, broken: row.broken })), presets: {} }
  for (const id of presets) {
    const sessionId = `session-probe-${randomUUID()}`
    const agent = (await agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      setup: async (agentCtx) => { await presetsService.mount(agentCtx, id) },
    })).agent
    try {
      // The assembled system prompt is what the model actually receives:
      // `tools` is the wire schema list (`[run_code]` under PTC) and
      // `sections` includes the generated SDK.
      const { scopeOf } = await import(pathToFileURL(join(checkout, 'packages/core/scope/lib/index.js')).href)
      // The Agent's own scope, exactly as `assembleContextFor()` supplies it
      // (`{ agent, scope: agent }`, packages/core/agent/src/dispatch.ts:174).
      const assembly = await agent.ctx.systemPrompt.assemble({ agent, scope: scopeOf(agent.ctx) })
      const sdk = assembly.sections.find(section => section.name === 'tools:sdk')
      const collapse = assembly.sections.find(section => section.name === 'tools:ptc-only')
      report.presets[id] = {
        sessionId,
        headerPreset: agent.session.header.agentPreset ?? null,
        composedPreset: presetsService.composedPreset(agent.ctx) ?? null,
        wireToolNames: assembly.tools.map(tool => tool.name),
        // The SDK renders each binding as an indented `name: { … }` member of
        // `interface ToolArgsMap`; the second `interface ToolResultMap` repeats
        // them, so the set is de-duplicated.
        sdkToolNames: typeof sdk?.text === 'string'
          ? [...new Set([...sdk.text.matchAll(/^ {2}([a-z_][a-z0-9_]*): \{/gmu)].map(match => match[1]))].sort()
          : null,
        ptcOnlyRule: typeof collapse?.text === 'string' ? collapse.text : null,
        sectionNames: assembly.sections.map(section => section.name),
        contextNames: assembly.contexts.map(context => context.name),
        sdkText: typeof sdk?.text === 'string' ? sdk.text : null,
        runCodeDescription: assembly.tools.find(tool => tool.name === 'run_code')?.description ?? null,
      }
    } finally {
      await agent.dispose?.()
    }
  }
  console.log(JSON.stringify(report, null, 2))
} finally {
  await shutdown?.shutdown?.(0)
  await ctx.fiber?.dispose?.()
  process.exit(0)
}
