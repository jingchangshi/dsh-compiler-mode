#!/usr/bin/env node
/**
 * P10.9 — Headless smoke test.
 *
 * RC.3's headless bundle composes NO agent-preset roster and refuses a Session
 * that recorded one (`packages/bundle/headless/src/index.ts:212-221`), so this
 * smoke checks what headless CAN promise: a one-shot task runs against the
 * profile's model configuration and answers. It is deliberately NOT a preset
 * test — that surface is covered through the Web Host (P10.10).
 *
 * Usage: node headless-smoke.mjs [--profile ai-compiler-scratch] [--patch <yml>]
 * Exit: 0 when the run answers, 1 otherwise.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const layout = JSON.parse(readFileSync(join(repo, 'evidence/env/layout.json'), 'utf8'))
const argv = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index < 0 ? fallback : argv[index + 1]
}
const profile = value('--profile', 'ai-compiler-scratch')
const out = resolve(value('--out', join(repo, 'evidence/tests/headless-smoke')))
mkdirSync(out, { recursive: true })

const args = [join(layout.dshCheckout, 'apps/cli/lib/bin.js'), '--profile', profile, '--json',
  'Reply with exactly the word: HEADLESS_SMOKE_OK']
for (const patch of argv.flatMap((token, index) => (token === '--patch' ? [argv[index + 1]] : []))) {
  args.splice(args.indexOf('--json'), 0, '--patch', resolve(patch))
}
const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 })
const events = (run.stdout ?? '').split('\n').filter(Boolean)
  .flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
const final = events.find(event => event.type === 'final')
const turnEnd = [...events].reverse().find(event => event.type === 'status' && event.phase === 'turn_end')
const checks = [
  ['headless process exits 0', run.status === 0],
  ['a final event was emitted', final !== undefined],
  ['the model answered', typeof final?.text === 'string' && final.text.trim() !== ''],
  ['the turn ended successfully', turnEnd?.reason?.kind === 'completed'],
]
let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${(run.stderr ?? '').trim().split('\n').slice(-2).join(' ')}`}`)
  if (!ok) failed += 1
}
console.log(`\n${checks.length - failed}/${checks.length} — ${failed === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failed === 0 ? 0 : 1)
