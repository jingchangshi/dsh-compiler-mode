#!/usr/bin/env node
/**
 * Pinned source patches this delivery applies to the deepseek-harness checkout.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A DSH *bundle* can add rows to a profile, but it cannot add a service method
 * or a model tool that does not exist in the installed source. The Agent Teams
 * member-reclaim capability is such a change: upstream rc.3 has no `retired`
 * phase and no `retire_teammate`, so this delivery pins it as a patch under
 * `patches/` and applies it to the checkout here.
 *
 * The operation is IDEMPOTENT and REVERSIBLE, and it never guesses:
 *   - `git apply --check` succeeding means PENDING (not applied yet);
 *   - `git apply --check -R` succeeding means APPLIED;
 *   - neither succeeding means CONFLICT (the checkout is not at the pinned
 *     base), which is a hard error, never a silent skip.
 *
 * If the checkout is not a git work tree (a tarball install), state falls back
 * to a source probe so the same commands still work.
 *
 * Usage:
 *   node scripts/lib/harness-patches.mjs status [--checkout DIR] [--patches DIR]
 *   node scripts/lib/harness-patches.mjs apply  [--dry-run] [--checkout DIR] [--patches DIR]
 *   node scripts/lib/harness-patches.mjs revert [--dry-run] [--checkout DIR] [--patches DIR]
 *
 * Exit: 0 ok, 1 a patch could not be applied/reverted or a conflict, 2 usage.
 * Machine-read output: one `STATE<TAB>file<TAB>feature` line per patch, and a
 * final `HARNESS_PATCH_CHANGED=0|1` for `apply`/`revert`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const libDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(libDir, '..', '..')

/**
 * The patches this delivery owns, in application order. `probe` is used only
 * when the checkout is not a git work tree; it points at text that exists iff
 * the patch is applied.
 */
const PATCHES = [
  {
    file: '0002-team-member-reclaim.patch',
    feature: 'Team member reclaim (terminal retired phase + retire_teammate)',
    probe: { file: 'packages/experimental/agent-team/src/types.ts', needle: '| \'retired\'' },
  },
]

function parseArgs(argv) {
  const out = { command: argv[0], dry: false, checkout: undefined, patches: undefined }
  if (!['status', 'apply', 'revert'].includes(out.command)) usage()
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') out.dry = true
    else if (arg === '--checkout') out.checkout = argv[++i]
    else if (arg === '--patches') out.patches = argv[++i]
    else usage(`unknown option ${arg}`)
  }
  return out
}

function usage(message) {
  if (message !== undefined) console.error(`harness-patches: ${message}`)
  console.error('usage: harness-patches.mjs <status|apply|revert> [--dry-run] [--checkout DIR] [--patches DIR]')
  process.exit(2)
}

const args = parseArgs(process.argv.slice(2))
const checkout = path.resolve(args.checkout ?? process.env.DSH_CHECKOUT ?? path.join(repoRoot, '..', 'deepseek-harness'))
const patchDir = path.resolve(args.patches ?? path.join(repoRoot, 'patches'))

if (!existsSync(checkout)) {
  console.error(`harness-patches: checkout not found: ${checkout}`)
  process.exit(1)
}

function git(gitArgs) {
  return spawnSync('git', ['-C', checkout, ...gitArgs], { encoding: 'utf8' })
}

function isGitWorkTree() {
  const probe = git(['rev-parse', '--is-inside-work-tree'])
  return probe.status === 0 && probe.stdout.trim() === 'true'
}

const gitMode = isGitWorkTree()

/** 'applied' | 'pending' | 'conflict' for one patch. */
function stateOf(patch) {
  const patchPath = path.join(patchDir, patch.file)
  if (!existsSync(patchPath)) return 'conflict'
  if (gitMode) {
    if (git(['apply', '--check', '--reverse', patchPath]).status === 0) return 'applied'
    if (git(['apply', '--check', patchPath]).status === 0) return 'pending'
    return 'conflict'
  }
  const target = path.join(checkout, patch.probe.file)
  const found = existsSync(target) && readFileSync(target, 'utf8').includes(patch.probe.needle)
  return found ? 'applied' : 'pending'
}

function applyOne(patch, direction) {
  const patchPath = path.join(patchDir, patch.file)
  const flags = direction === 'revert' ? ['apply', '--reverse', patchPath] : ['apply', patchPath]
  const result = git(flags)
  if (result.status !== 0) {
    console.error(`harness-patches: git ${flags[0]} failed for ${patch.file}`)
    if (result.stderr) console.error(result.stderr.trim())
    return false
  }
  return true
}

if (args.command === 'status') {
  let worst = 0
  for (const patch of PATCHES) {
    const state = stateOf(patch)
    console.log(`${state}\t${patch.file}\t${patch.feature}`)
    if (state === 'conflict') worst = 1
  }
  process.exit(worst)
}

let changed = false
let failed = false
for (const patch of PATCHES) {
  const state = stateOf(patch)
  if (args.command === 'apply') {
    if (state === 'applied') { console.log(`already-applied\t${patch.file}\t${patch.feature}`); continue }
    if (state === 'conflict') {
      console.error(`harness-patches: ${patch.file} does not apply to ${checkout} (not at the pinned base?)`)
      failed = true
      continue
    }
    if (args.dry) { console.log(`would-apply\t${patch.file}\t${patch.feature}`); changed = true; continue }
    if (!applyOne(patch, 'apply')) { failed = true; continue }
    console.log(`applied\t${patch.file}\t${patch.feature}`)
    changed = true
  } else {
    if (state === 'pending') { console.log(`not-applied\t${patch.file}\t${patch.feature}`); continue }
    if (state === 'conflict') {
      console.error(`harness-patches: ${patch.file} is neither cleanly applied nor cleanly revertible in ${checkout}`)
      failed = true
      continue
    }
    if (args.dry) { console.log(`would-revert\t${patch.file}\t${patch.feature}`); changed = true; continue }
    if (!applyOne(patch, 'revert')) { failed = true; continue }
    console.log(`reverted\t${patch.file}\t${patch.feature}`)
    changed = true
  }
}
console.log(`HARNESS_PATCH_CHANGED=${changed ? 1 : 0}`)
process.exit(failed ? 1 : 0)
