#!/usr/bin/env node
/**
 * Experiment 1 — which reasoningEffort levels does each role model actually accept?
 *
 * For every (provider, model) × level, start a throwaway child Agent through the
 * real subagent runtime with `agentOptions`, then read the child's OWN durable log:
 *   - `request/header` → the route and effort the request actually carried
 *   - `turn/end`       → completed or error, with the error text
 *
 * Nothing is inferred from the parent's view: if the child never wrote a
 * request/header, the route never reached a provider request.
 *
 * Writes evidence/design/reasoning-matrix.json.
 * Usage: node reasoning-matrix.mjs [--levels off,low,medium,high] [--out <json>]
 * Exit: 0 when the matrix was produced (individual cell failures are data, not errors).
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { layout } from '../../scripts/lib/paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const checkout = layout.dshCheckout
const argv = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index < 0 ? fallback : argv[index + 1]
}
const levels = value('--levels', 'off,low,medium,high').split(',')
const outFile = resolve(value('--out', join(repo, 'evidence/design/reasoning-matrix.json')))

/** The six role routes under evaluation. */
const ROLES = [
  { role: 'lead', provider: 'magpie', model: 'auto/deepseek-v4.1-flash' },
  { role: 'architect', provider: 'magpie', model: 'codex/gpt-6.1-sol' },
  { role: 'explorer', provider: 'corp', model: 'Qwen3.8-Flash' },
  { role: 'implementer', provider: 'corp', model: 'DeepSeek-V4.1-Flash-1017' },
  { role: 'challenger', provider: 'magpie', model: 'codex/gpt-6.1-sol' },
  { role: 'reviewer', provider: 'corp', model: 'GLM-5.3-Flash' },
]

const { runProfile } = await import(pathToFileURL(join(checkout, 'apps/cli/lib/profile-boot.js')).href)
const entries = Object.fromEntries(Object.entries(process.env).map(([name, v]) => [name, { value: v ?? '' }]))
const { ctx, shutdown } = await runProfile({
  environment: { entries, get: name => entries[name], has: name => entries[name] !== undefined },
  profile: 'ai-compiler-scratch',
  patchFiles: [join(repo, 'tests/e2e/cases/model-overlay.yml')],
  args: ['probe'],
})

const agents = ctx.get('agents')
const subagents = ctx.get('subagents')
const persistence = ctx.get('sessionPersistence')

/** Read a finished child's own log after persistence settles. */
async function readChild(childId) {
  const handle = await persistence.open(childId, 'read', { signal: AbortSignal.timeout(30_000) })
  try {
    const { events } = await handle.read(0, undefined, { signal: AbortSignal.timeout(30_000) })
    const header = [...events].reverse().find(event => event.type === 'request/header')
    const config = header?.data?.header?.config ?? header?.data?.config ?? null
    const ends = events.filter(event => event.type === 'turn/end')
    const error = ends.map(event => event.data?.reason?.error).filter(Boolean).at(-1) ?? null
    const text = events.filter(event => event.type === 'assistant/message')
      .map(event => (event.data?.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join(''))
      .filter(Boolean).at(-1) ?? null
    return { route: config, stopReason: ends.at(-1)?.data?.reason?.kind ?? null, error, text }
  } finally {
    await handle.close()
  }
}

const lead = (await agents.create({ sessionId: `session-matrix-${Date.now()}`, meta: { cwd: process.cwd() } })).agent
const matrix = []
for (const role of ROLES) {
  for (const level of levels) {
    const started = Date.now()
    const childId = `child-${role.role}-${level}-${Math.random().toString(36).slice(2, 7)}`
    const agentOptions = { provider: role.provider, model: role.model, reasoningEffort: level }
    let record
    try {
      const activation = await subagents.startActivation({
        delivery: 'parent', childId, provider: 'spawn', label: `${role.role}:${level}`,
        request: { prompt: [{ type: 'text', text: 'Reply with the single word: READY' }], parent: lead, agentOptions },
        signal: AbortSignal.timeout(300_000),
      })
      await activation.result.catch(() => undefined)
      await new Promise(r => setTimeout(r, 600))
      record = await readChild(childId)
    } catch (error) {
      record = { route: null, stopReason: 'start-failed', error: { message: String(error?.message ?? error) }, text: null }
    }
    const row = {
      role: role.role, provider: role.provider, model: role.model, requestedEffort: level,
      elapsedMs: Date.now() - started,
      routeReachedProvider: record.route !== null,
      actualRoute: record.route === null ? null : `${record.route.provider}/${record.route.model}`,
      actualEffort: record.route?.reasoningEffort ?? null,
      stopReason: record.stopReason,
      errorMessage: record.error?.message ?? null,
      errorCode: record.error?.code ?? null,
      reply: record.text,
    }
    matrix.push(row)
    console.log(`${role.role.padEnd(12)} ${level.padEnd(7)} ${row.stopReason ?? '?'}  route=${row.actualRoute ?? 'none'}  effort=${row.actualEffort ?? '-'}${row.errorMessage === null ? '' : `  ERR=${String(row.errorMessage).slice(0, 90)}`}`)
  }
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, `${JSON.stringify({ at: new Date().toISOString(), levels, rows: matrix }, null, 2)}\n`)
console.log(`\nwrote ${outFile}`)
await shutdown?.shutdown?.(0)
await ctx.fiber?.dispose?.()
process.exit(0)
