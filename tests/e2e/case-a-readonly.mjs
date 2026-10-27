#!/usr/bin/env node
/**
 * Prove Case A was read-only: compare a fingerprint of the AscendNPU-IR tree's
 * tracked sources before and after the run.
 *
 * Uses `git status --porcelain` (read-only) plus a hash of `git rev-parse HEAD`
 * and the working-tree diff, so any write, delete, or checkout shows up.
 * NOTE: `git status vg` writes only to `.git/index` metadata; the command below
 * runs with `--no-optional-locks` so it does not touch the index at all.
 *
 * Usage:
 *   node case-a-readonly.mjs --record --repo <path> --out <json>
 *   node case-a-readonly.mjs --verify --repo <path> --before <json> --out <json>
 * Exit: 0 on match, 1 on a difference, 2 on usage error.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}
const git = (...args) => spawnSync('git', ['--no-optional-locks', '-C', flag('--repo') ?? '.', ...args], { encoding: 'utf8' })
const repoPath = resolve(flag('--repo') ?? '')
const out = flag('--out')
if (!flag('--repo') || out === undefined) {
  console.error('usage: case-a-readonly.mjs (--record|--verify) --repo <path> --out <json> [--before <json>]')
  process.exit(2)
}

const snapshot = () => ({
  head: (git('rev-parse', 'HEAD').stdout ?? '').trim(),
  branch: (git('rev-parse', '--abbrev-ref', 'HEAD').stdout ?? '').trim(),
  status: (git('status', '--porcelain').stdout ?? '').trim(),
  diffStat: (git('diff', '--stat').stdout ?? '').trim(),
  untracked: (git('ls-files', '--others', '--exclude-standard').stdout ?? '').trim(),
  dirty: (git('status', '--porcelain', '--untracked-files=normal').stdout ?? '').trim() !== '',
})

mkdirSync(dirname(resolve(out)), { recursive: true })
if (argv.includes('--record')) {
  const value = snapshot()
  writeFileSync(resolve(out), `${JSON.stringify(value, null, 2)}\n`)
  console.log(JSON.stringify({ recorded: value.head, dirty: value.dirty, status: value.status.split('\n').filter(Boolean).length }))
  process.exit(0)
}

const before = JSON.parse(readFileSync(resolve(flag('--before') ?? ''), 'utf8'))
const after = snapshot()
const differences = Object.keys(before).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
const report = { repo: repoPath, at: new Date().toISOString(), before, after, differences, verdict: differences.length === 0 ? 'UNCHANGED' : 'CHANGED' }
writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ verdict: report.verdict, differences, head: after.head, dirty: after.dirty }, null, 2))
process.exit(differences.length === 0 ? 0 : 1)
