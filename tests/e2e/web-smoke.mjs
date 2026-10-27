#!/usr/bin/env node
/**
 * P10.10 — Web Mode smoke test.
 *
 * Creates a real Session through the live Host, sends one trivial prompt, waits
 * for the turn to end, and asserts that the session recorded the preset and
 * produced at least one assistant message. Exit code IS the verdict.
 *
 * Usage: node web-smoke.mjs [--preset ai-compiler] [--out <dir>]
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const argv = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index < 0 ? fallback : argv[index + 1]
}
const preset = value('--preset', 'ai-compiler')
const out = resolve(value('--out', join(repo, 'evidence/tests/web-smoke')))
mkdirSync(out, { recursive: true })

const run = spawnSync(process.execPath, [
  join(here, 'web-session.mjs'), '--out', out, '--preset', preset,
  '--timeout-ms', '180000', '--', 'Reply with exactly the word: SMOKE_OK',
], { encoding: 'utf8' })
const report = (() => {
  try { return JSON.parse(readFileSync(join(out, 'web-run.json'), 'utf8')) } catch { return undefined }
})()
const checks = [
  ['web-session exits 0', run.status === 0],
  ['session recorded the preset', report?.agentPreset === preset],
  ['a turn completed', (report?.sessionStats?.turns ?? 0) >= 1],
  ['the model answered', typeof report?.finalAnswer === 'string' && report.finalAnswer.trim() !== ''],
]
let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed += 1
}
console.log(`\n${checks.length - failed}/${checks.length} — ${failed === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failed === 0 ? 0 : 1)
