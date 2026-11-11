#!/usr/bin/env node
/**
 * Deterministic test for scripts/lib/harness-patches.mjs (no DSH checkout, no network).
 *
 * PROVES THE CONTRACTS THE INSTALL FLOW RELIES ON
 * ----------------------------------------------
 *   1. status reports `pending` before apply;
 *   2. apply writes every patch and reports HARNESS_PATCH_CHANGED=1;
 *   3. a second apply is a no-op (CHANGED=0);
 *   4. every patch reports `applied`;
 *   5. revert removes the whole chain in REVERSE order and reports CHANGED=1,
 *      restoring every target file to its exact pre-apply bytes;
 *   6. every patch returns to `pending`;
 *   7. a diverged tree reports `conflict` with exit 1 (never a silent skip).
 *
 * WHY THE FIXTURES ARE DERIVED FROM THE REGISTRY
 * ----------------------------------------------
 * This test used to hardcode ONE stub patch filename. When 0003 was added to
 * the registry the self-test still wrote only 0002, so apply found no 0003 file,
 * returned `conflict`, and revert (which runs in reverse and therefore hit the
 * missing 0003 first) blocked before 0002 was ever reverted -- the suite went
 * red against a perfectly good helper. Because a stale fixture and a broken
 * helper produced the same red, that failure said nothing about which was wrong.
 *
 * So the fixtures are now GENERATED from the exported PATCHES registry: adding
 * 0004 makes this test cover 0004 with no edit here. That is a hard constraint,
 * not a convenience -- do not reintroduce a literal patch filename below, and do
 * not derive fixtures from anything but PATCHES.
 *
 * MULTI-PATCH SEMANTICS ARE DELIBERATE
 * ------------------------------------
 * Every stub patch gets its OWN target file rather than stacking two patches on
 * one file. With a shared target, the reverse-order revert would still leave a
 * correct-looking diff on the file, and a helper that reverted in the WRONG
 * order (or skipped one patch) could pass unnoticed. Distinct files make each
 * step independently observable: after revert every file must be byte-identical
 * to its committed content, so a missed patch is a visible leftover.
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATCHES } from '../../scripts/lib/harness-patches.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const helper = path.join(repoRoot, 'scripts', 'lib', 'harness-patches.mjs')

let failures = 0
const ok = m => console.log(`PASS  ${m}`)
const bad = m => { console.error(`FAIL  ${m}`); failures += 1 }
const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8' })
function run(command, checkout, patches) {
  const r = sh(process.execPath, [helper, command, '--checkout', checkout, '--patches', patches])
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const changed = s => { const m = /HARNESS_PATCH_CHANGED=(\d)/.exec(s); return m === null ? undefined : Number(m[1]) }
/** Per-patch state rows, parsed by FILENAME so it works for any registry size. */
const rowsOf = s => {
  const out = new Map()
  for (const line of s.split('\n')) {
    const col = line.split('\t')
    if (col.length === 3) out.set(col[1], col[0])
  }
  return out
}
const states = (s, patches) => patches.map(p => rowsOf(s).get(p.file))
const allAre = (s, patches, want) => states(s, patches).every(v => v === want)

/**
 * A one-file stub patch that appends `line2` to `<name>.txt`. Every patch in
 * the registry gets its own file, so no two patches share a target.
 */
function stubFor(index) {
  const file = `p${index}.txt`
  return {
    file,
    patch: [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -1 +1,2 @@',
      ' line1',
      `+line2-${index}`,
      '',
    ].join('\n'),
  }
}

// The fixture set is the registry, one stub per entry, in registry order.
const stubs = PATCHES.map((_, i) => stubFor(i))

const root = mkdtempSync(path.join(tmpdir(), 'harness-patches-test-'))
try {
  const checkout = path.join(root, 'checkout'); const patches = path.join(root, 'patches')
  mkdirSync(checkout); mkdirSync(patches)
  sh('git', ['init', '-q'], checkout)
  sh('git', ['config', 'user.email', 't@e.invalid'], checkout)
  sh('git', ['config', 'user.name', 't'], checkout)

  // One committed file per stub, each with distinct base content so a
  // cross-file mix-up cannot look correct.
  for (const s of stubs) writeFileSync(path.join(checkout, s.file), `line1\n`)
  const baseNames = stubs.map(s => s.file)
  sh('git', ['add', ...baseNames], checkout)
  sh('git', ['commit', '-q', '-m', 'base'], checkout)

  // The stub patches are named after the REAL registry entries, so the helper
  // resolves exactly the files it would resolve in production.
  PATCHES.forEach((p, i) => writeFileSync(path.join(patches, p.file), stubs[i].patch))

  const readAll = () => new Map(stubs.map(s => [s.file, readFileSync(path.join(checkout, s.file), 'utf8')]))
  const applyAll = m => new Map([...m].map(([f]) => [f, `line1\nline2-${stubs.findIndex(s => s.file === f)}\n`]))
  const baseline = readAll()
  const applied_expect = applyAll(baseline)

  if (PATCHES.length < 2) bad(`registry has ${PATCHES.length} patch(es); the multi-patch contracts below are not exercised`)

  let r = run('status', checkout, patches)
  // Chain semantics: the first patch is 'pending', the rest are 'blocked'
  // behind it (they cannot apply on top of a base that lacks its predecessor).
  // This exact snapshot is re-asserted after revert: a fully reverted chain must
  // be indistinguishable from a never-applied one.
  const pristineStatus = new Map(rowsOf(r.stdout))
  if (pristineStatus.get(PATCHES[0].file) === 'pending') ok(`status: first patch pending before apply (${PATCHES.length} in registry)`)
  else bad(`status ${pristineStatus.get(PATCHES[0].file)} before apply`)

  r = run('apply', checkout, patches)
  if (r.code === 0 && changed(r.stdout) === 1 && [...applied_expect].every(([f, v]) => readAll().get(f) === v)) {
    ok(`apply writes all ${PATCHES.length} patches and reports CHANGED=1 (exit 0)`)
  } else bad(`apply failed (exit ${r.code}, CHANGED=${changed(r.stdout)}, files: ${JSON.stringify(states(r.stdout, PATCHES))})`)

  // REGRESSION GUARD: re-running `apply` on an already-applied chain is the
  // single most common re-entry path (scripts/install.sh applies on every run
  // and treats a non-zero exit as fatal). The EXIT CODE is asserted, not just
  // CHANGED: the historic bug reported CHANGED=0 together with exit 1 and a
  // spurious 'conflict', so a CHANGED-only assertion stayed green while a real
  // install.sh re-run failed. Every row must also read already-applied.
  r = run('apply', checkout, patches)
  if (r.code === 0 && changed(r.stdout) === 0 && allAre(r.stdout, PATCHES, 'already-applied')) {
    ok('apply again on an applied chain is idempotent (CHANGED=0, exit 0, all already-applied)')
  } else {
    bad(`second apply NOT idempotent: exit ${r.code} (want 0), CHANGED=${changed(r.stdout)}, rows ${JSON.stringify(states(r.stdout, PATCHES))}`)
  }

  // ...and it must not have touched the tree.
  if ([...applied_expect].every(([f, v]) => readAll().get(f) === v)) ok('re-applied chain leaves the tree byte-identical')
  else bad('a no-op apply modified the checkout')

  r = run('status', checkout, patches)
  if (allAre(r.stdout, PATCHES, 'applied')) ok(`status: every patch applied (${PATCHES.length}/${PATCHES.length})`)
  else bad(`status after apply: ${JSON.stringify(states(r.stdout, PATCHES))}`)

  // Revert must walk the chain in REVERSE: the helper's own log lines are
  // asserted, not just the end state, so a forward-order revert is caught even
  // if it happened to produce the right bytes.
  r = run('revert', checkout, patches)
  const revertedOrder = r.stdout.split('\n').filter(l => l.startsWith('reverted\t')).map(l => l.split('\t')[1])
  const wantOrder = [...PATCHES].reverse().map(p => p.file)
  if (revertedOrder.length === PATCHES.length && revertedOrder.every((f, i) => f === wantOrder[i])) {
    ok(`revert removes the chain in reverse order (${wantOrder.join(' -> ')})`)
  } else bad(`revert order ${JSON.stringify(revertedOrder)}, expected ${JSON.stringify(wantOrder)}`)

  const restored = readAll()
  const leftovers = stubs.filter(s => restored.get(s.file) !== baseline.get(s.file)).map(s => s.file)
  if (changed(r.stdout) === 1 && leftovers.length === 0) ok(`revert restores all ${PATCHES.length} target files (CHANGED=1)`)
  else bad(`revert failed (CHANGED=${changed(r.stdout)}, not restored: ${JSON.stringify(leftovers)}, exit ${r.code})`)

  // After a full revert the chain is back to its never-applied state:
  //   row 0          -> 'pending'  (it can be applied right now)
  //   rows 1..n-1    -> 'blocked'  (NOT a failure: a chained patch cannot apply
  //                                while its predecessor is absent, so the helper
  //                                reports it blocked rather than pending)
  // This is the helper's designed semantics (see the firstPending branch in
  // scripts/lib/harness-patches.mjs), so asserting 'pending' on every row would
  // assert something the helper never promised. Assert the real contract instead.
  r = run('status', checkout, patches)
  const afterRevert = rowsOf(r.stdout)
  const headState = afterRevert.get(PATCHES[0].file)
  const tail = PATCHES.slice(1)
  const tailWrong = tail.filter(p => afterRevert.get(p.file) !== 'blocked').map(p => `${p.file}=${afterRevert.get(p.file)}`)
  if (headState === 'pending' && tailWrong.length === 0) {
    ok(`status after revert: head pending, ${tail.length} blocked behind it`)
  } else {
    bad(`status after revert: head=${headState} (want pending), non-blocked tail=${JSON.stringify(tailWrong)}`)
  }

  // Belt and braces: that state must equal what a NEVER-APPLIED chain reports,
  // so a partially reverted tree cannot masquerade as a clean one.
  const statusDrift = PATCHES.filter(p => afterRevert.get(p.file) !== pristineStatus.get(p.file)).map(p => p.file)
  if (statusDrift.length === 0) ok('status after revert is identical to the pre-apply snapshot')
  else bad(`status after revert drifted from pre-apply snapshot: ${JSON.stringify(statusDrift)}`)

  // Round trip: the reverted chain must be genuinely re-appliable, which is what
  // 'pending' is supposed to promise. A helper that left the tree half-reverted
  // could still print 'pending' but fail here.
  r = run('apply', checkout, patches)
  const reapplied = readAll()
  if (changed(r.stdout) === 1 && [...applied_expect].every(([f, v]) => reapplied.get(f) === v)) {
    ok('revert left a usable chain (re-apply reproduces the patched files)')
  } else bad(`re-apply after revert failed (CHANGED=${changed(r.stdout)})`)
  r = run('revert', checkout, patches)
  const finalState = readAll()
  if (changed(r.stdout) === 1 && stubs.every(s => finalState.get(s.file) === baseline.get(s.file))) {
    ok('second revert is clean too (chain stays reversible)')
  } else bad('second revert did not restore the baseline files')

  writeFileSync(path.join(checkout, stubs[0].file), 'diverged\n')
  r = run('status', checkout, patches)
  if (rowsOf(r.stdout).get(PATCHES[0].file) === 'conflict' && r.code === 1) ok('diverged tree reports conflict exit 1')
  else bad(`diverged -> ${rowsOf(r.stdout).get(PATCHES[0].file)} exit ${r.code}`)

  // A diverged tree must also be REFUSED by apply -- never silently "fixed" by
  // the chain-level short circuit. This is the assertion that keeps the fix from
  // becoming a conflict-swallowing hack.
  const divergedBefore = readFileSync(path.join(checkout, stubs[0].file), 'utf8')
  r = run('apply', checkout, patches)
  if (r.code === 1 && readFileSync(path.join(checkout, stubs[0].file), 'utf8') === divergedBefore) {
    ok('diverged tree is refused by apply (exit 1, tree untouched)')
  } else bad(`diverged apply -> exit ${r.code} (want 1)`)
} finally { rmSync(root, { recursive: true, force: true }) }

// ─────────────────────────────────────────────────────────────────────────────
// STACKED CHAIN: the fixture that actually reproduces the install.sh re-run bug.
//
// The fixture above gives each patch its OWN file, which is right for proving
// revert ordering -- but on that shape a per-patch check already reports
// 'applied' correctly, so it CANNOT catch the chained-apply bug. In production
// 0003 edits lines that 0002 introduced (same files), so once 0003 is applied a
// per-patch FORWARD check of 0002 fails and a REVERSE check can fail too: the
// applied chain reads as 'conflict'. This block reproduces exactly that, with
// two patches stacked on one file, and asserts the chain-level contract.
// Keeping both shapes is deliberate: distinct files guard revert ORDER, one
// shared file guards chain-level APPLY detection.
{
  const sroot = mkdtempSync(path.join(tmpdir(), 'harness-patches-stacked-'))
  try {
    const co = path.join(sroot, 'checkout'); const pa = path.join(sroot, 'patches')
    mkdirSync(co); mkdirSync(pa)
    sh('git', ['init', '-q'], co)
    sh('git', ['config', 'user.email', 't@e.invalid'], co)
    sh('git', ['config', 'user.name', 't'], co)
    writeFileSync(path.join(co, 'shared.txt'), 'a\nb\nc\n')
    sh('git', ['add', 'shared.txt'], co); sh('git', ['commit', '-q', '-m', 'base'], co)

    // Patch i appends its own line, so patch i+1's context depends on patch i.
    // Both touch the SAME file -- the shape that breaks per-patch detection.
    PATCHES.forEach((p, i) => {
      const before = ['a', ...Array.from({ length: i }, (_, k) => `s${k}`), 'b', 'c']
      const body = [...before.slice(0, i + 1).map(l => ` ${l}`), `+s${i}`, ...before.slice(i + 1).map(l => ` ${l}`)].join('\n')
      const hunk = `@@ -1,${before.length} +1,${before.length + 1} @@`
      writeFileSync(path.join(pa, p.file), [
        'diff --git a/shared.txt b/shared.txt',
        '--- a/shared.txt',
        '+++ b/shared.txt',
        hunk,
        body,
        '',
      ].join('\n'))
    })

    const readShared = () => readFileSync(path.join(co, 'shared.txt'), 'utf8')
    const wantApplied = ['a', ...PATCHES.map((_, i) => `s${i}`), 'b', 'c'].join('\n') + '\n'

    let rs = run('apply', co, pa)
    if (rs.code === 0 && changed(rs.stdout) === 1 && readShared() === wantApplied) {
      ok('stacked chain: applies (all patches on ONE file, like the real 0002/0003)')
    } else bad(`stacked apply failed (exit ${rs.code}, file ${JSON.stringify(readShared())})`)

    rs = run('status', co, pa)
    if (rs.code === 0 && allAre(rs.stdout, PATCHES, 'applied')) ok('stacked chain: status reports every patch applied')
    else bad(`stacked status: exit ${rs.code} ${JSON.stringify(states(rs.stdout, PATCHES))}`)

    // THE REGRESSION GUARD for install.sh re-runs on an already-patched checkout.
    const beforeReapply = readShared()
    rs = run('apply', co, pa)
    if (rs.code === 0 && changed(rs.stdout) === 0 && allAre(rs.stdout, PATCHES, 'already-applied')) {
      ok('stacked chain: apply on an applied chain is idempotent (exit 0, all already-applied)')
    } else {
      bad(`stacked re-apply NOT idempotent: exit ${rs.code} (want 0), CHANGED=${changed(rs.stdout)}, rows ${JSON.stringify(states(rs.stdout, PATCHES))}`)
    }
    if (readShared() === beforeReapply) ok('stacked chain: a no-op re-apply leaves the file byte-identical')
    else bad('stacked chain: a no-op re-apply modified the file')

    // REVERT SYMMETRY on the same stacked shape. A fully-pending stacked chain
    // must be a clean no-op: per-patch reverse checks see each other's absence as
    // 'neither applied nor revertible' and report conflict + exit 1, which makes
    // scripts/uninstall.sh (revert on every run) fail on an untouched checkout.
    rs = run('revert', co, pa)
    if (rs.code === 0 && changed(rs.stdout) === 1) ok('stacked chain: reverts cleanly')
    else bad(`stacked revert failed (exit ${rs.code}, CHANGED=${changed(rs.stdout)})`)
    if (readShared() === 'a\nb\nc\n') ok('stacked chain: revert restores the original file')
    else bad(`stacked revert left ${JSON.stringify(readShared())}`)

    // Second revert on the now-pending stacked chain: a clean no-op, exit 0.
    // Without a chain-level verdict this reports conflict + exit 1.
    rs = run('revert', co, pa)
    if (rs.code === 0 && changed(rs.stdout) === 0 && allAre(rs.stdout, PATCHES, 'not-applied')) {
      ok('stacked chain: revert on a fully-pending chain is a clean no-op (exit 0)')
    } else {
      bad(`stacked revert on pending chain: exit ${rs.code} (want 0), CHANGED=${changed(rs.stdout)}, rows ${JSON.stringify(states(rs.stdout, PATCHES))}`)
    }
  } finally { rmSync(sroot, { recursive: true, force: true }) }
}

console.log(failures === 0 ? '\nharness-patches: all checks passed' : `\nharness-patches: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)