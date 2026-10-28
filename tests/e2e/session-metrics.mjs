#!/usr/bin/env node
/**
 * Aggregate DSH session logs into benchmark metrics.
 *
 * Input: session ids (or `--run <headless outDir>` to read the `session` event
 *        from a headless run) for the workspace project, read through the
 *        session-query service (see evidence.mjs).
 * Output: one JSON object per session plus a totals block, written to
 *         `evidence/benchmarks/<name>.json`.
 *
 * METRIC PROVENANCE — every number below is either read from the session log,
 * computed from it, or marked NOT_AVAILABLE. Nothing is estimated except
 * `spillArtifacts` (filesystem inspection, labelled) and `contextWindow`
 * (configuration).
 *
 *   tokenUsage.*        `token/usage` projections folded from provider-reported
 *                       usage in `assistant/attempt` events (NOT_AVAILABLE when
 *                       the provider reports none).
 *   turns/steps         `turn/start`, `step/start` event counts.
 *   llmLatencyMs        `llm/request`…`llm/response` pairing if logged; else
 *                       session-stats projection, else NOT_AVAILABLE.
 *   toolCalls           `tool/call` events (native calls + the outer run_code).
 *   ptcSubCalls         `tool/ptc-dispatch` events (PTC-internal tool calls).
 *   spillArtifacts      count + bytes of files under the session's spill dir
 *                       (`<spillRoot>/session-<sha256(id)[0:12]>/`). NOT a
 *                       session event: DSH keeps no spill counter (documented).
 *   compactions         `compaction/summary` event count.
 *   prunes              `compaction/prune` event count.
 *   errors              `turn/end` with reason.kind === 'error'.
 *
 * Usage:
 *   node session-metrics.mjs --out <file.json> <sessionId> [<sessionId>...]
 *   node session-metrics.mjs --out <file.json> --run <headlessOutDir> [--run ...]
 *   node session-metrics.mjs --out <file.json> --from-results <file.json>
 * Exit: 0 when at least one session was measured, 1 otherwise.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { layout } from '../../scripts/lib/paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const argv = process.argv.slice(2)
const valueOf = (flag) => {
  const index = argv.indexOf(flag)
  return index < 0 ? undefined : argv[index + 1]
}
const out = valueOf('--out')
const runs = argv.flatMap((token, index) => (token === '--run' ? [argv[index + 1]] : []))
const fromResults = valueOf('--from-results')
const positional = argv.filter((token, index) => !token.startsWith('--') && argv[index - 1] !== '--out'
  && argv[index - 1] !== '--run' && argv[index - 1] !== '--from-results')
if (out === undefined) {
  console.error('usage: session-metrics.mjs --out <file.json> (<sessionId>... | --run <dir>... | --from-results <json>)')
  process.exit(2)
}

const project = process.env.METRICS_PROJECT ?? process.cwd()
/** Session ids gathered from explicit args and headless run dirs. */
const ids = [...positional]
for (const run of runs) {
  const result = JSON.parse(readFileSync(join(run, 'result.json'), 'utf8'))
  const opening = result.events.find(event => event.type === 'session')
  if (opening !== undefined) ids.push(opening.sessionId)
}
if (fromResults !== undefined) {
  const parsed = JSON.parse(readFileSync(fromResults, 'utf8'))
  for (const entry of parsed) {
    if (typeof entry.sessionId === 'string') ids.push(entry.sessionId)
    if (typeof entry.run === 'string') {
      try {
        const result = JSON.parse(readFileSync(join(entry.run, 'result.json'), 'utf8'))
        const opening = result.events.find(event => event.type === 'session')
        if (opening !== undefined) ids.push(opening.sessionId)
      } catch { /* a missing run dir is recorded below as a failed measurement */ }
    }
  }
}

/** Spill directories are `<root>/session-<sha256(sessionId)[0:12]>` (spill-local/src/store.ts). */
function spillFootprint(sessionId) {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  const dirName = `session-${hash}`
  const roots = []
  for (const root of [process.env.DSH_SPILL_ROOT, layout.spillRoot]) {
    if (typeof root === 'string' && root !== '') roots.push(root)
  }
  // The default root is a per-process mkdtemp under the OS tmpdir: `dsh-spill-*`.
  try {
    for (const entry of readdirSync(process.env.TMPDIR ?? '/tmp')) {
      if (entry.startsWith('dsh-spill-')) roots.push(join(process.env.TMPDIR ?? '/tmp', entry))
    }
  } catch { /* tmpdir unreadable: no spill evidence */ }
  const found = []
  for (const root of roots) {
    const dir = join(root, dirName)
    let names
    try { names = readdirSync(dir) } catch { continue }
    let bytes = 0
    for (const name of names) {
      try { bytes += statSync(join(dir, name)).size } catch { /* raced cleanup */ }
    }
    found.push({ root, dir, files: names.length, bytes })
  }
  return { hash, dirName, matches: found, files: found.reduce((n, item) => n + item.files, 0), bytes: found.reduce((n, item) => n + item.bytes, 0) }
}

const rows = []
for (const sessionId of ids) {
  const run = spawnSync(process.execPath, [join(here, 'evidence.mjs'), sessionId, '--project', project], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (run.status !== 0) {
    rows.push({ sessionId, status: 'UNREADABLE', stderr: (run.stderr ?? '').trim() })
    continue
  }
  const raw = JSON.parse(run.stdout)
  const counts = raw.counts
  const count = (type) => counts[type] ?? 0
  const tokenUsage = raw.projections?.tokenUsage ?? null
  const sessionStats = raw.projections?.sessionStats ?? null
  rows.push({
    sessionId,
    status: 'OK',
    header: { cwd: raw.header.cwd, agentPreset: raw.header.agentPreset ?? null, parentSession: raw.header.parentSession ?? null, isSeeded: raw.header.isSeeded ?? false },
    eventCount: raw.eventCount,
    turns: count('turn/start'),
    steps: count('step/start'),
    toolCalls: raw.toolCalls.length,
    toolCallNames: [...new Set(raw.toolCalls.map(call => call.name))],
    ptcSubCalls: raw.ptcDispatches.length,
    ptcSubCallErrors: raw.ptcDispatches.filter(call => call.isError === true).length,
    ptcSubCallNames: [...new Set(raw.ptcDispatches.map(call => call.name))],
    compactions: count('compaction/start'),
    compactionSummaries: count('compaction/summary'),
    prunes: count('compaction/prune'),
    teamEvents: { members: count('team/member'), tasks: count('team/task') },
    subagentDescriptors: count('subagent/descriptor'),
    errors: raw.errors.length,
    errorCodes: [...new Set(raw.errors.map(error => error.data?.reason?.error?.code).filter(Boolean))],
    tokenUsage: tokenUsage === null
      ? 'NOT_AVAILABLE (provider reported no usage)'
      : tokenUsage,
    sessionStats,
    spill: spillFootprint(sessionId),
    counts,
  })
}

const measured = rows.filter(row => row.status === 'OK')
const sum = (pick) => measured.reduce((total, row) => total + pick(row), 0)
const totalTokens = measured.reduce((total, row) => {
  const usage = row.tokenUsage
  if (typeof usage !== 'object' || usage === null) return total
  return total + (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0)
}, 0)
const payload = {
  generatedAt: new Date().toISOString(),
  project,
  provenance: {
    tokens: 'tokenUsage projection (provider-reported usage); totalTokens sums all four disjoint buckets',
    spill: 'filesystem: <spillRoot>/session-<sha256(id)[0:12]>/* — DSH exposes no spill counter',
    compaction: 'compaction/start, compaction/summary, compaction/prune session events',
    toolCalls: 'tool/call events; PTC sub-calls are tool/ptc-dispatch events',
    latency: 'NOT_AVAILABLE from this log reader unless sessionStats is populated',
  },
  sessions: rows,
  totals: {
    sessions: measured.length,
    unreadable: rows.length - measured.length,
    turns: sum(row => row.turns),
    steps: sum(row => row.steps),
    toolCalls: sum(row => row.toolCalls),
    ptcSubCalls: sum(row => row.ptcSubCalls),
    compactions: sum(row => row.compactions),
    prunes: sum(row => row.prunes),
    errors: sum(row => row.errors),
    spillFiles: sum(row => row.spill.files),
    spillBytes: sum(row => row.spill.bytes),
    tokensAllBuckets: measured.some(row => typeof row.tokenUsage === 'object') ? totalTokens : 'NOT_AVAILABLE',
  },
}
mkdirSync(dirname(resolve(out)), { recursive: true })
writeFileSync(resolve(out), `${JSON.stringify(payload, null, 2)}\n`)
console.log(JSON.stringify({ out: resolve(out), ...payload.totals }, null, 2))
process.exit(measured.length > 0 ? 0 : 1)
