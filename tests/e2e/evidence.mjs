#!/usr/bin/env node
/**
 * Read a DSH session log (`$DSH_HOME/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd`)
 * through the PUBLIC session-query service instead of decoding the archive here.
 *
 * It boots a minimal Cordis application in-process — `dsh-session`,
 * `dsh-session-persistence-jsonl`, `dsh-session-query-sqlite` — using the
 * checkout's own built packages, and prints a JSON summary the benchmark and
 * acceptance scripts can consume:
 *
 *   { header, events: n, counts: { 'tool/call': n, ... },
 *     turns, toolCalls: [...names], ptcDispatches: [...],
 *     errors: [...], projections: {...} }
 *
 * Counting is done over the raw event stream, so nothing is inferred from text.
 *
 * Usage: node evidence.mjs <sessionId> [--root <sessionsRoot>] [--project <cwd>]
 *        node evidence.mjs --list [--project <cwd>]
 * Exit: 0 on success, 1 when the session cannot be read, 2 on usage error.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const layout = JSON.parse(readFileSync(join(repo, 'evidence/env/layout.json'), 'utf8'))
const checkout = layout.dshCheckout
const require = createRequire(join(checkout, 'package.json'))

/** Locate a workspace package directory by scanning the checkout's packages tree. */
const { readdirSync, existsSync, statSync, readFileSync: readJson } = require('node:fs')
let index
function packageDir(name) {
  if (index === undefined) {
    index = new Map()
    const roots = [join(checkout, 'packages'), join(checkout, 'vendor'), join(checkout, 'apps')]
    for (const root of roots) {
      for (const group of readdirSync(root)) {
        const groupDir = join(root, group)
        if (!statSync(groupDir).isDirectory()) continue
        const candidates = existsSync(join(groupDir, 'package.json')) ? [groupDir] : readdirSync(groupDir).map(name => join(groupDir, name))
        for (const candidate of candidates) {
          try {
            const manifest = JSON.parse(readJson(join(candidate, 'package.json'), 'utf8'))
            if (typeof manifest.name === 'string') index.set(manifest.name, candidate)
          } catch { /* not a package directory */ }
        }
      }
    }
  }
  const found = index.get(name)
  if (found === undefined) throw new Error(`workspace package not found: ${name}`)
  return found
}

/** Import a built workspace package by its directory. */
async function pkg(name) {
  return await import(pathToFileURL(join(packageDir(name), 'lib/index.js')).href)
}

/** The Cordis plugin export of a namespace module (default, else the module itself). */
function pluginOf(namespaceModule) {
  return namespaceModule.default ?? namespaceModule
}

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}
const project = flag('--project') ?? process.cwd()
const rootFlag = flag('--root')

if (argv.includes('--list')) {
  const { readdirSync, statSync } = await import('node:fs')
  const base = project.replace(/^\/+/, '').replace(/[^\w-]+/gu, '-'); const projectKey = `--${base}--`
  const root = rootFlag ?? join(layout.dshHome, 'sessions', projectKey)
  let ids = []
  try { ids = readdirSync(root).filter(name => statSync(join(root, name)).isDirectory()) } catch { ids = [] }
  console.log(JSON.stringify({ root, sessions: ids }, null, 2))
  process.exit(0)
}

const sessionId = argv[0]
if (sessionId === undefined || sessionId.startsWith('--')) {
  console.error('usage: evidence.mjs <sessionId> [--root <sessionsRoot>] [--project <cwd>] | --list')
  process.exit(2)
}

const [{ Context }, session, projectionModule, tokenMeterModule, persistenceModule, query] = await Promise.all([
  import(pathToFileURL(join(packageDir('@deepseek-ai/cordis'), 'lib/index.js')).href),
  pkg('@deepseek-ai/dsh-session'),
  pkg('@deepseek-ai/dsh-session-projection'),
  pkg('@deepseek-ai/dsh-token-meter'),
  pkg('@deepseek-ai/dsh-session-persistence-jsonl'),
  pkg('@deepseek-ai/dsh-session-query-sqlite'),
].map(promiseify))

/** Resolve either a module namespace or a value. */
function promiseify(value) {
  return Promise.resolve(value)
}

const ctx = new Context()
const root = rootFlag ?? join(layout.dshHome, 'sessions')
const sessionsRoot = rootFlag ?? join(layout.dshHome, 'sessions')
ctx.plugin(pluginOf(session), {})
// The projection service + the token meter own `tokenUsage`/`contextPressure`;
// without them `observeSession()` reports no projections at all.
ctx.plugin(pluginOf(projectionModule), {})
ctx.plugin(pluginOf(tokenMeterModule), {})
ctx.plugin(pluginOf(persistenceModule), { root: sessionsRoot })
ctx.plugin(pluginOf(query), { path: ':memory:', openAt: 'never' })
await new Promise(resolveReady => setTimeout(resolveReady, 100))

const sessions = ctx.get('sessions')
const observations = ctx.get('sessionQuery')
if (observations === undefined) {
  console.error('sessionQuery service unavailable')
  process.exit(1)
}
try {
  const obs = await observations.observeSession(sessionId)
  const counts = Object.create(null)
  const toolCalls = []
  const toolResults = []
  const ptcDispatches = []
  const errors = []
  const events = []
  for (const event of obs.events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1
    events.push({ seq: event.seq, type: event.type })
    if (event.type === 'tool/call') toolCalls.push({ name: event.data.name, callId: event.data.id, arguments: event.data.arguments })
    if (event.type === 'tool/result') {
      // The model-facing content is `data.message.content`; `data.meta` is the
      // tool-private presentation payload and `data.error` the failure identity.
      const message = event.data.message ?? {}
      const blocks = Array.isArray(message.content) ? message.content : []
      toolResults.push({
        callId: message.callId ?? event.data.callId,
        isError: message.isError ?? event.data.isError ?? false,
        error: event.data.error ?? null,
        // A bounded copy keeps the evidence file readable; the full text stays in
        // the session log and, when spilled, in the spill artifact.
        text: blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n').slice(0, 4000),
      })
    }
    if (event.type === 'tool/ptc-dispatch') {
      ptcDispatches.push({
        name: event.data.name,
        isError: event.data.isError,
        outcome: event.data.outcome ?? event.data.status,
      })
    }
    if (event.type === 'error' || event.type === 'turn/end' && event.data.reason?.kind === 'error') {
      errors.push({ seq: event.seq, type: event.type, data: event.data })
    }
  }
  const projectionsFor = obs.projections?.values ?? null

  console.log(JSON.stringify({
    sessionId,
    header: obs.header,
    inheritedEventCount: obs.inheritedEventCount,
    eventCount: obs.events.length,
    counts,
    toolCalls,
    toolResults,
    ptcDispatches,
    errors,
    projections: projectionsFor,
    firstSeq: obs.events[0]?.seq ?? null,
    lastSeq: obs.events.at(-1)?.seq ?? null,
  }, null, 2))
  process.exit(0)
} catch (error) {
  console.error(`cannot read session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
} finally {
  await ctx.dispose?.()
}
