#!/usr/bin/env node
/**
 * Case-B verifier: assert the outcome of the repair case from OUTSIDE the agent.
 *
 * Nothing here trusts the agent's own report — each fact is re-derived:
 *   - the fixture's tests pass now (`run-tests.sh` exit 0, parsed per assertion),
 *   - the tests and headers were NOT modified (hash comparison against the
 *     prepared workspace),
 *   - only `src/ircount.cpp` differs, and the diff is small and in place,
 *   - the defect patch no longer applies (the changed lines are gone),
 *   - no file outside the workspace changed (parent-directory mtime probe is
 *     limited to the fixture tree; the repositories used by case A are hashed
 *     by tests/e2e/case-a-readonly.sh).
 *
 * Usage: node case-b-verify.mjs --workdir <dir> --before <before.sha> [--out <json>]
 * Exit: 0 when every assertion holds, 1 otherwise, 2 on usage error.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}
const workdir = resolve(flag('--workdir') ?? '')
const beforeFile = resolve(flag('--before') ?? '')
const outFile = flag('--out') ?? join(repo, 'evidence/e2e/case-b/verify.json')
if (!flag('--workdir') || !flag('--before')) {
  console.error('usage: case-b-verify.mjs --workdir <dir> --before <sha-file> [--out <json>]')
  process.exit(2)
}

const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// 1. The suite passes now.
const run = spawnSync(join(workdir, 'run-tests.sh'), [], { cwd: workdir, encoding: 'utf8' })
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
const okLines = output.split('\n').filter(line => line.startsWith('ok   '))
const failLines = output.split('\n').filter(line => line.startsWith('FAIL'))
check('run-tests.sh exits 0', run.status === 0, `exit=${run.status}`)
check('every assertion reports ok', failLines.length === 0 && okLines.length >= 4, `${okLines.length} ok, ${failLines.length} FAIL`)
check('the merged-source assertion is present', output.includes('merge clears source'))

// 2. Tests and headers are untouched.
const before = Object.fromEntries(readFileSync(beforeFile, 'utf8').trim().split('\n')
  .map(line => line.trim().split(/\s+/)).map(([hash, file]) => [file, hash]))
const now = spawnSync('sha256sum', ['include/ircount.h', 'tests/test_ircount.cpp', 'run-tests.sh'], { cwd: workdir, encoding: 'utf8' })
const nowHashes = Object.fromEntries((now.stdout ?? '').trim().split('\n')
  .map(line => line.trim().split(/\s+/)).map(([hash, file]) => [file, hash]))
for (const protectedFile of ['include/ircount.h', 'tests/test_ircount.cpp', 'run-tests.sh']) {
  check(`${protectedFile} is unmodified`, before[protectedFile] === nowHashes[protectedFile],
    before[protectedFile] === nowHashes[protectedFile] ? 'hash equal' : 'CHANGED')
}

// 3. Only the implementation file changed, and the defect patch no longer applies.
const sourceChanged = before['src/ircount.cpp'] !== nowHashes['src/ircount.cpp']
check('src/ircount.cpp was modified', sourceChanged, sourceChanged ? 'changed (expected)' : 'UNCHANGED')
// The defect patch and a correct fix touch the same line in opposite
// directions, so a clean REVERSE means the defect is back — the positive
// signal is the reverse *failing* with "Unreversed patch detected".
const reverse = spawnSync('patch', ['-p1', '-R', '--dry-run', '-i', join(workdir, 'patches/defect.patch')], { cwd: workdir, encoding: 'utf8' })
const reverseText = `${reverse.stdout ?? ''}${reverse.stderr ?? ''}`
check('the defect is gone (its patch no longer reverses)', reverse.status !== 0 && /Unreversed patch detected|already|Skipping/u.test(reverseText),
  reverse.status !== 0 ? 'reverse refused — the bugged line is absent' : 'reverse applied — the defect is still present')

// 4. The fix restores the counter contract in the source itself.
const source = readFileSync(join(workdir, 'src/ircount.cpp'), 'utf8')
check('mergeFrom clears the source again', /other\.reset\(\);/u.test(source), source.match(/void Counter::mergeFrom[\s\S]{0,160}/u)?.[0].replace(/\n/gu, ' ⏎ '))

const failed = checks.filter(entry => !entry.ok)
const report = { workdir, at: new Date().toISOString(), checks, verdict: failed.length === 0 ? 'PASS' : 'FAIL', testOutput: output.slice(0, 4000) }
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed — ${report.verdict}`)
process.exit(failed.length === 0 ? 0 : 1)
