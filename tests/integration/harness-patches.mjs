#!/usr/bin/env node
/**
 * Deterministic test for scripts/lib/harness-patches.mjs (no DSH checkout, no network).
 *
 * Builds a throwaway git work tree, pins a one-line patch, and proves the four
 * contracts the install flow relies on:
 *   1. status reports `pending` before the patch is applied;
 *   2. apply writes the change and reports HARNESS_PATCH_CHANGED=1;
 *   3. a second apply is a no-op (CHANGED=0) — install is idempotent;
 *   4. revert restores the file and returns to `pending`;
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
function stateOf(stdout, file = '0002-team-member-reclaim.patch') {
  const line = stdout.split('\n').find(entry => entry.includes(file))
  return line === undefined ? undefined : line.split('\t')[0]
}

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

  const patch = [
    'diff --git a/src.txt b/src.txt',
    '--- a/src.txt',
    '+++ b/src.txt',
    '@@ -1 +1,2 @@',
    ' line1',
    '+line2',
    '',
  ].join('\n')
  writeFileSync(path.join(patches, '0002-team-member-reclaim.patch'), patch)

  let result = runHelper('status', checkout, patches)
  if (stateOf(result.stdout) === 'pending') ok('status: pending before apply')
  else bad(`status before apply was ${String(stateOf(result.stdout))}, expected pending`)

  result = runHelper('apply', checkout, patches)
  if (changedFlag(result.stdout) === 1 && readFileSync(path.join(checkout, 'src.txt'), 'utf8') === 'line1\nline2\n') {
    ok('apply: writes the change and reports CHANGED=1')
  } else bad('apply did not write the change')

  result = runHelper('apply', checkout, patches)
  if (changedFlag(result.stdout) === 0) ok('apply again: idempotent no-op (CHANGED=0)')
  else bad(`second apply reported CHANGED=${String(changedFlag(result.stdout))}, expected 0`)

  result = runHelper('status', checkout, patches)
  if (stateOf(result.stdout) === 'applied') ok('status: applied after apply')
  else bad(`status after apply was ${String(stateOf(result.stdout))}, expected applied`)

  result = runHelper('revert', checkout, patches)
  if (changedFlag(result.stdout) === 1 && readFileSync(path.join(checkout, 'src.txt'), 'utf8') === 'line1\n') {
    ok('revert: restores the file and reports CHANGED=1')
  } else bad('revert did not restore the file')

  result = runHelper('status', checkout, patches)
  if (stateOf(result.stdout) === 'pending') ok('status: back to pending after revert')
  else bad(`status after revert was ${String(stateOf(result.stdout))}, expected pending`)

  writeFileSync(path.join(checkout, 'src.txt'), 'diverged\n')
  result = runHelper('status', checkout, patches)
  if (stateOf(result.stdout) === 'conflict' && result.code === 1) ok('status: diverged tree reports conflict (exit 1)')
  else bad(`diverged tree reported ${String(stateOf(result.stdout))} exit ${String(result.code)}, expected conflict exit 1`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nharness-patches: all checks passed' : `\nharness-patches: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
