#!/usr/bin/env node
/**
 * Pinned source patches this delivery applies to the deepseek-harness checkout.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A DSH *bundle* can add rows to a profile, but it cannot add a service method
 * or a model tool that does not exist in the installed source. Three such
 * changes are pinned here, in order:
 *   0001 - the Lead could pass a route through `spawn_teammate`'s
 *          `agent_options`; 0002 removed it, so the patch chain no longer
 *          contains this file.
 *   0002 - role-first Team topology: roles, four reserved plus four flex slots,
 *          per-slot generations, and `retire_teammate`.
 *   0003 - per-preset role routes: the Team-service `presetRoles` table, so two
 *          presets in one Host route the same role id to different models.
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
import { existsSync, readFileSync, realpathSync } from 'node:fs'
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
export const PATCHES = [
  {
    file: '0002-team-roles-slots.patch',
    feature: 'Role-first team topology (roles, 4 reserved + 4 flex slots, generations)',
    probe: { file: 'packages/experimental/agent-team/src/roster.ts', needle: 'TEAM_NO_CAPACITY' },
  },
  {
    file: '0003-team-preset-role-routes.patch',
    feature: 'Per-preset role routes (presetRoles table resolved from the Lead preset)',
    // Only 0003 introduces this module, so its presence is an unambiguous
    // applied-state probe. The probe is read only outside a git work tree.
    probe: { file: 'packages/experimental/agent-team/src/routes.ts', needle: 'export function resolveRoles' },
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

/**
 * Everything above is data + pure helpers. The CLI body below runs ONLY when
 * this file is executed directly, because scripts/install.sh, uninstall.sh and
 * verify.sh all invoke it as `node harness-patches.mjs <cmd>`.
 *
 * tests/integration/harness-patches.mjs `import`s PATCHES from this module so
 * its fixtures track the registry automatically. Importing must therefore not
 * run the CLI: without this guard the import would call parseArgs() with the
 * test runner's argv, hit usage(), and exit(2) before a single check ran.
 */
function main(argv) {
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

  /**
   * CHAIN-LEVEL verdict - the only reliable one once later patches are stacked
   * on top of earlier ones.
   *
   * A per-patch check asks git "does THIS patch apply to the current tree?".
   * That question is meaningless for a stacked chain: with 0003 applied on top
   * of 0002, a FORWARD check of 0002 fails (its post-image no longer matches)
   * and a REVERSE check of 0002 can fail too (later context shifted), so a
   * perfectly applied chain reads as 'conflict'. That is exactly how a re-run of
   * install.sh on an already-patched checkout used to fail.
   *
   * The chain answers instead:
   *   - the LAST patch reverse-applies  => nothing is stacked on top of it,
   *                                        so the whole chain is APPLIED;
   *   - the FIRST patch applies         => nothing has been applied yet,
   *                                        so the whole chain is PENDING.
   * Anything else is 'unknown' and is handed to the per-patch loop, which is
   * kept for partial applications and for real conflict diagnostics. 'unknown'
   * is never treated as success, so a diverged tree still fails loudly.
   *
   * Returns undefined when git mode is unavailable (tarball install), where the
   * probe-based per-patch path is the only option.
   */
  function chainState() {
    if (!gitMode || PATCHES.length < 2) return undefined
    const lastApplied = git(['apply', '--check', '--reverse', path.join(patchDir, PATCHES.at(-1).file)]).status === 0
    const firstPending = git(['apply', '--check', path.join(patchDir, PATCHES[0].file)]).status === 0
    if (lastApplied && !firstPending) return 'applied'
    if (firstPending) return 'pending'
    return 'unknown'
  }

  if (args.command === 'status') {
    const rows = []
    // Chain-level verdicts first; per-patch reverse checks are ambiguous once
    // later patches are stacked on top, so they are only a fallback for a
    // partially applied chain.
    const chain = chainState()
    if (chain === 'applied') {
      for (const patch of PATCHES) rows.push(['applied', patch])
    } else if (chain === 'pending') {
      // A chained patch cannot apply while its predecessor is absent, so only
      // the head is 'pending'; the rest are 'blocked' (not a failure).
      PATCHES.forEach((patch, index) => rows.push([index === 0 ? 'pending' : 'blocked', patch]))
    }
    if (rows.length === 0) {
      let previousApplied = true
      for (const patch of PATCHES) {
        const state = previousApplied ? stateOf(patch) : 'blocked'
        rows.push([state, patch])
        previousApplied = state === 'applied'
      }
    }
    let worst = 0
    for (const [state, patch] of rows) {
      console.log(`${state}\t${patch.file}\t${patch.feature}`)
      if (state === 'conflict') worst = 1
    }
    process.exit(worst)
  }

  let changed = false
  let failed = false
  let blocked = false
  // Apply in order; revert in reverse order so each patch is removed before the
  // one it was built on.
  const ordered = args.command === 'revert' ? [...PATCHES].reverse() : PATCHES

  // CHAIN-LEVEL SHORT CIRCUIT
  // -------------------------
  // Re-running install.sh on an already-patched checkout is the most common
  // re-entry path, so the "nothing to do" case must be a clean success. The
  // per-patch loop below cannot decide that for a stacked chain (see
  // chainState()), so the whole-chain verdict is taken first:
  //   apply  + applied  => every row already-applied, CHANGED=0, exit 0
  //   revert + pending  => every row not-applied,    CHANGED=0, exit 0
  // Everything else - 'pending' for apply, 'applied' for revert, and the
  // 'unknown' that a genuinely diverged tree produces - falls through to the
  // per-patch loop, which keeps the partial-application path and the real
  // conflict diagnostics. 'unknown' is never silently accepted.
  const chain = chainState()
  /** Patches the loop still has to visit; empty when the chain settled it. */
  let todo = ordered
  if (chain === 'applied' && args.command === 'apply') {
    for (const patch of PATCHES) console.log(`already-applied\t${patch.file}\t${patch.feature}`)
    todo = []
  } else if (chain === 'pending' && args.command === 'revert') {
    for (const patch of ordered) console.log(`not-applied\t${patch.file}\t${patch.feature}`)
    todo = []
  }

  for (const patch of todo) {
    if (blocked) { console.log(`blocked\t${patch.file}\t${patch.feature}`); continue }
    const state = stateOf(patch)
    if (args.command === 'apply') {
      if (state === 'applied') { console.log(`already-applied\t${patch.file}\t${patch.feature}`); continue }
      if (state === 'conflict') {
        console.error(`harness-patches: ${patch.file} does not apply to ${checkout} (not at the pinned base?)`)
        failed = true
        blocked = true
        continue
      }
      if (args.dry) { console.log(`would-apply\t${patch.file}\t${patch.feature}`); changed = true; continue }
      if (!applyOne(patch, 'apply')) { failed = true; blocked = true; continue }
      console.log(`applied\t${patch.file}\t${patch.feature}`)
      changed = true
    } else {
      if (state === 'pending') { console.log(`not-applied\t${patch.file}\t${patch.feature}`); continue }
      if (state === 'conflict') {
        console.error(`harness-patches: ${patch.file} is neither cleanly applied nor cleanly revertible in ${checkout}`)
        failed = true
        blocked = true
        continue
      }
      if (args.dry) { console.log(`would-revert\t${patch.file}\t${patch.feature}`); changed = true; continue }
      if (!applyOne(patch, 'revert')) { failed = true; blocked = true; continue }
      console.log(`reverted\t${patch.file}\t${patch.feature}`)
      changed = true
    }
  }
  console.log(`HARNESS_PATCH_CHANGED=${changed ? 1 : 0}`)
  process.exit(failed ? 1 : 0)
}

/** True when this module is the process entry point rather than an import. */
function isMain() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const self = fileURLToPath(import.meta.url)
  if (path.resolve(entry) === self) return true
  try { return realpathSync(entry) === realpathSync(self) } catch { return false }
}

if (isMain()) main(process.argv.slice(2))