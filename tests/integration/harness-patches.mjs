#!/usr/bin/env node
/**
 * Deterministic test for scripts/lib/harness-patches.mjs (no DSH checkout, no network).
 *
 * Builds a throwaway git work tree with TWO ordered, dependent patches and
 * proves the contracts the install flow relies on:
 *   1. status reports `pending`, then `blocked` for a patch whose predecessor
 *      is not applied (dependency order, not a false `conflict`);
 *   2. apply writes both changes in order and reports HARNESS_PATCH_CHANGED=1;
 *   3. a second apply is a no-op (CHANGED=0) — install is idempotent;
 *   4. revert removes them in reverse order and restores the file;
 *   5. a patch that does not fit the tree is reported as `conflict` (exit 1),
 *      never silently skipped.
 *
 * Usage: node tests/integration/harness-patches.mjs   (exit 0 = all pass)
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const helper = path.join(repoRoot, 'scripts', 'lib', 'harness-patches.mjs')

const P2 = '0002-team-member-reclaim.patch'
const P3 = '0003-team-auto-reclaim.patch'

let failures = 0
const ok = message => console.log(`PASS  ${message}`)
const bad = message => { console.error(`FAIL  ${message}`); failures += 1 }

function sh(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8' })
}
function runHelper(command, checkout, patches) {
  const result = sh(process.execPath, [helper, command, '--checkout', checkout, '--patches', patches])
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
function changedFlag(stdout) {
  const match = /HARNESS_PATCH_CHANGED=(\d)/.exec(stdout)
  return match === null ? undefined : Number(match[1])
}
function stateOf(stdout, file) {
  const line = stdout.split('\n').find(entry => entry.includes(file))
  return line === undefined ? undefined : line.split('\t')[0]
}

const patch2 = [
  'diff --git a/src.txt b/src.txt',
  '--- a/src.txt',
  '+++ b/src.txt',
  '@@ -1 +1,2 @@',
  ' line1',
  '+line2',
  '',
].join('\n')
const patch3 = [
  'diff --git a/src.txt b/src.txt',
  '--- a/src.txt',
  '+++ b/src.txt',
  '@@ -1,2 +1,3 @@',
  ' line1',
  ' line2',
  '+line3',
  '',
].join('\n')

const root = mkdtempSync(path.join(tmpdir(), 'harness-patches-test-'))
try {
  const checkout = path.join(root, 'checkout')
  const patches = path.join(root, 'patches')
  mkdirSync(checkout)
  mkdirSync(patches)
  sh('git', ['init', '-q'], checkout)
  sh('git', ['config', 'user.email', 'test@example.invalid'], checkout)
  sh('git', ['config', 'user.name', 'test'], checkout)
  writeFileSync(path.join(checkout, 'src.txt'), 'line1\n')
  sh('git', ['add', 'src.txt'], checkout)
  sh('git', ['commit', '-q', '-m', 'base'], checkout)
  writeFileSync(path.join(patches, P2), patch2)
  writeFileSync(path.join(patches, P3), patch3)

  let result = runHelper('status', checkout, patches)
  if (stateOf(result.stdout, P2) === 'pending' && stateOf(result.stdout, P3) === 'blocked') {
    ok('status: pending, then blocked while the predecessor is unapplied')
  } else bad(`status was ${String(stateOf(result.stdout, P2))}/${String(stateOf(result.stdout, P3))}`)

  result = runHelper('apply', checkout, patches)
  const applied = readFileSync(path.join(checkout, 'src.txt'), 'utf8')
  if (changedFlag(result.stdout) === 1 && applied === 'line1\nline2\nline3\n') {
    ok('apply: applies both patches in order (CHANGED=1)')
  } else bad(`apply produced ${JSON.stringify(applied)} CHANGED=${String(changedFlag(result.stdout))}`)

  result = runHelper('apply', checkout, patches)
  if (changedFlag(result.stdout) === 0) ok('apply again: idempotent no-op (CHANGED=0)')
  else bad(`second apply reported CHANGED=${String(changedFlag(result.stdout))}`)

  result = runHelper('status', checkout, patches)
  if (stateOf(result.stdout, P2) === 'applied' && stateOf(result.stdout, P3) === 'applied') ok('status: both applied')
  else bad(`status after apply was ${String(stateOf(result.stdout, P2))}/${String(stateOf(result.stdout, P3))}`)

  result = runHelper('revert', checkout, patches)
  const reverted = readFileSync(path.join(checkout, 'src.txt'), 'utf8')
  if (changedFlag(result.stdout) === 1 && reverted === 'line1\n') {
    ok('revert: removes both in reverse order and restores the file')
  } else bad(`revert produced ${JSON.stringify(reverted)} CHANGED=${String(changedFlag(result.stdout))}`)

  result = runHelper('status', checkout, patches)
  if (stateOf(result.stdout, P2) === 'pending' && stateOf(result.stdout, P3) === 'blocked') {
    ok('status: back to pending/blocked after revert')
  } else bad(`status after revert was ${String(stateOf(result.stdout, P2))}/${String(stateOf(result.stdout, P3))}`)

  writeFileSync(path.join(checkout, 'src.txt'), 'diverged\n')
  result = runHelper('status', checkout, patches)
  if (stateOf(result.stdout, P2) === 'conflict' && result.code === 1) ok('status: diverged tree reports conflict (exit 1)')
  else bad(`diverged tree reported ${String(stateOf(result.stdout, P2))} exit ${String(result.code)}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nharness-patches: all checks passed' : `\nharness-patches: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
