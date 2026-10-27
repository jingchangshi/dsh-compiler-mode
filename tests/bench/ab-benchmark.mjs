#!/usr/bin/env node
/**
 * A/B functional-increment benchmark (P9).
 *
 * Runs ONE identical task through the live Web Host under several preset
 * compositions and records only the metrics the harness can actually observe.
 * Anything the runtime does not expose is reported as NOT_AVAILABLE, and every
 * metric names its source.
 *
 * Compositions (the baseline is measured, not assumed — RC.3's base profile
 * already enables spill and the token meter; see docs/07-benchmarks.md):
 *   baseline   `ptc`           official PTC preset
 *   enhanced   `ai-compiler`   PTC + context tuning + Agent Teams + LSP surface
 *
 * Usage:
 *   node ab-benchmark.mjs --task <file> --repeats <n> --out <dir> --preset <id>...
 * Exit: 0 when every run completed, 1 otherwise.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const argv = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index < 0 ? fallback : argv[index + 1]
}
const taskFile = value('--task')
const repeats = Number(value('--repeats', '1'))
const outRoot = resolve(value('--out', join(repo, 'evidence/benchmarks/ab')))
const presets = argv.flatMap((token, index) => (token === '--preset' ? [argv[index + 1]] : []))
if (taskFile === undefined || presets.length === 0) {
  console.error('usage: ab-benchmark.mjs --task <file> --repeats <n> --out <dir> --preset <id>...')
  process.exit(2)
}
const task = readFileSync(resolve(taskFile), 'utf8')
const cwd = value('--cwd', process.cwd())

function measure(runDir) {
  const read = (name) => {
    try { return JSON.parse(readFileSync(join(runDir, name), 'utf8')) } catch { return undefined }
  }
  const run = read('web-run.json')
  const evidence = read('session-evidence.json')
  const counts = evidence?.counts ?? {}
  const stats = run?.sessionStats ?? {}
  const toks = run?.tokenUsage
  return {
    status: run?.status ?? 'MISSING',
    sessionId: run?.sessionId ?? null,
    // provider-reported usage (tokenUsage projection)
    inputTokens: toks?.uncachedInputTokens ?? 'NOT_AVAILABLE',
    outputTokens: toks?.outputTokens ?? 'NOT_AVAILABLE',
    cacheReadTokens: toks?.cacheReadTokens ?? 'NOT_AVAILABLE',
    cacheWriteTokens: toks?.cacheWriteTokens ?? 'NOT_AVAILABLE',
    // session-stats projection
    turns: stats.turns ?? 'NOT_AVAILABLE',
    steps: stats.steps ?? 'NOT_AVAILABLE',
    llmMs: stats.llmMs ?? 'NOT_AVAILABLE',
    toolMs: stats.toolMs ?? 'NOT_AVAILABLE',
    ttftMs: stats.ttftMs ?? 'NOT_AVAILABLE',
    elapsedMs: run?.elapsedMs ?? 'NOT_AVAILABLE',
    // durable log event counts
    toolCalls: counts['tool/call'] ?? 0,
    ptcSubCalls: counts['tool/ptc-dispatch'] ?? 0,
    teamMemberEdges: counts['team/member'] ?? 0,
    teamTaskEdges: counts['team/task'] ?? 0,
    compactions: counts['compaction/start'] ?? 0,
    prunes: counts['compaction/prune'] ?? 0,
    // RC.3 exposes no counter for these: never guessed
    spillTriggers: 'NOT_AVAILABLE',
    cpuPercent: 'NOT_AVAILABLE',
    peakRssBytes: 'NOT_AVAILABLE',
    answerChars: (run?.finalAnswer ?? '').length,
  }
}

const summary = []
mkdirSync(outRoot, { recursive: true })
for (const preset of presets) {
  for (let attempt = 1; attempt <= repeats; attempt += 1) {
    const runDir = join(outRoot, `${preset}-r${attempt}`)
    mkdirSync(runDir, { recursive: true })
    const started = Date.now()
    const child = spawnSync(process.execPath, [
      join(repo, 'tests/e2e/web-session.mjs'), '--out', runDir, '--preset', preset,
      '--cwd', cwd, '--timeout-ms', value('--timeout-ms', '1800000'), '--', task,
    ], { encoding: 'utf8', timeout: 3_600_000 })
    const metrics = measure(runDir)
    summary.push({ preset, attempt, wallMs: Date.now() - started, driverExit: child.status, ...metrics })
    console.log(`${preset} r${attempt}: ${metrics.status} elapsed=${metrics.elapsedMs} steps=${metrics.steps} tools=${metrics.toolCalls} ptc=${metrics.ptcSubCalls}`)
  }
}
const report = {
  at: new Date().toISOString(),
  taskFile: resolve(taskFile),
  task: task.slice(0, 2000),
  cwd,
  repeats,
  provenance: {
    tokens: 'tokenUsage projection — provider-reported, disjoint buckets',
    steps: 'sessionStats projection (turns/steps/llmMs/toolMs/ttftMs)',
    elapsed: 'wall clock of tests/e2e/web-session.mjs',
    toolCalls: 'count of tool/call events in the durable session log',
    ptcSubCalls: 'count of tool/ptc-dispatch events',
    team: 'team/member and team/task events in the Lead log',
    compaction: 'compaction/start and compaction/prune events',
    notAvailable: 'spill count, CPU, peak RSS — RC.3 exposes no counter; reported as NOT_AVAILABLE, never estimated',
  },
  runs: summary,
}
writeFileSync(join(outRoot, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`\nwrote ${join(outRoot, 'summary.json')}`)
process.exit(summary.every(entry => entry.status === 'PASS') ? 0 : 1)
