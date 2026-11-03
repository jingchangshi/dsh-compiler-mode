#!/usr/bin/env node
/**
 * Deterministic test for scripts/lib/harness-patches.mjs (no DSH checkout, no network).
 *
 * One pinned capability patch, proving the contracts the install flow relies on:
 *   1. status reports `pending` before apply;
 *   2. apply writes the change and reports HARNESS_PATCH_CHANGED=1;
 *   3. a second apply is a no-op (CHANGED=0);
 *   4. revert restores the file and returns to `pending`;
 *   5. a diverged tree reports `conflict` with exit 1 (never a silent skip).
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const helper = path.join(repoRoot, 'scripts', 'lib', 'harness-patches.mjs')
const P = '0002-team-roles-slots.patch'

let failures = 0
const ok = m => console.log(`PASS  ${m}`)
const bad = m => { console.error(`FAIL  ${m}`); failures += 1 }
const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8' })
function run(command, checkout, patches) {
  const r = sh(process.execPath, [helper, command, '--checkout', checkout, '--patches', patches])
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const changed = s => { const m = /HARNESS_PATCH_CHANGED=(\d)/.exec(s); return m === null ? undefined : Number(m[1]) }
const state = s => { const l = s.split('\n').find(e => e.includes(P)); return l === undefined ? undefined : l.split('\t')[0] }

const patch = ['diff --git a/src.txt b/src.txt', '--- a/src.txt', '+++ b/src.txt', '@@ -1 +1,2 @@', ' line1', '+line2', ''].join('\n')

const root = mkdtempSync(path.join(tmpdir(), 'harness-patches-test-'))
try {
  const checkout = path.join(root, 'checkout'); const patches = path.join(root, 'patches')
  mkdirSync(checkout); mkdirSync(patches)
  sh('git', ['init', '-q'], checkout)
  sh('git', ['config', 'user.email', 't@e.invalid'], checkout)
  sh('git', ['config', 'user.name', 't'], checkout)
  writeFileSync(path.join(checkout, 'src.txt'), 'line1\n')
  sh('git', ['add', 'src.txt'], checkout); sh('git', ['commit', '-q', '-m', 'base'], checkout)
  writeFileSync(path.join(patches, P), patch)

  let r = run('status', checkout, patches)
  if (state(r.stdout) === 'pending') ok('status: pending before apply'); else bad(`status ${state(r.stdout)}`)

  r = run('apply', checkout, patches)
  if (changed(r.stdout) === 1 && readFileSync(path.join(checkout, 'src.txt'), 'utf8') === 'line1\nline2\n') ok('apply writes and reports CHANGED=1'); else bad('apply failed')

  r = run('apply', checkout, patches)
  if (changed(r.stdout) === 0) ok('apply again idempotent (CHANGED=0)'); else bad(`second apply CHANGED=${changed(r.stdout)}`)

  r = run('status', checkout, patches)
  if (state(r.stdout) === 'applied') ok('status: applied'); else bad(`status ${state(r.stdout)}`)

  r = run('revert', checkout, patches)
  if (changed(r.stdout) === 1 && readFileSync(path.join(checkout, 'src.txt'), 'utf8') === 'line1\n') ok('revert restores (CHANGED=1)'); else bad('revert failed')

  r = run('status', checkout, patches)
  if (state(r.stdout) === 'pending') ok('status: pending after revert'); else bad(`status ${state(r.stdout)}`)

  writeFileSync(path.join(checkout, 'src.txt'), 'diverged\n')
  r = run('status', checkout, patches)
  if (state(r.stdout) === 'conflict' && r.code === 1) ok('diverged tree reports conflict exit 1'); else bad(`diverged -> ${state(r.stdout)} exit ${r.code}`)
} finally { rmSync(root, { recursive: true, force: true }) }

console.log(failures === 0 ? '\nharness-patches: all checks passed' : `\nharness-patches: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
