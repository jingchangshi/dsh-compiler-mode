#!/usr/bin/env node
/**
 * Deterministic permission acceptance — real allow/deny, no model, no prompt text.
 *
 * Two layers are measured separately, because they are enforced by different code:
 *
 *   1. `fs-sandbox` (the in-process filesystem fence used by `write`/`edit`):
 *      the `workspace-write` and `read-only` checks run in-process against a real
 *      temporary tree; they do not need an OS sandbox backend.
 *   2. `sandbox-local` (the OS confinement used by `bash` and the PTC Node child):
 *      probed through `ctx.sandbox.confine()` for each mode, so the result states
 *      what this host can actually enforce instead of what the docs claim.
 *
 * Every check prints PASS/FAIL/INFO with the observed value; INFO marks a measured
 * host fact that is neither a pass nor a failure of the mode.
 *
 * Usage: node permission-suite.mjs [--out <json>]
 * Exit: 0 when every allow/deny assertion holds, 1 otherwise.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const layout = JSON.parse(readFileSync(join(repo, 'evidence/env/layout.json'), 'utf8'))
const checkout = layout.dshCheckout
const outFile = (() => {
  const index = process.argv.indexOf('--out')
  return index < 0 ? join(repo, 'evidence/tests/permission-suite.json') : resolve(process.argv[index + 1])
})()

const results = []
const record = (kind, name, detail) => {
  results.push({ kind, name, detail })
  console.log(`${kind === 'INFO' ? 'INFO' : kind}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const check = (name, ok, detail) => record(ok ? 'PASS' : 'FAIL', name, detail)

const { runProfile } = await import(pathToFileURL(join(checkout, 'apps/cli/lib/profile-boot.js')).href)
const entries = Object.fromEntries(Object.entries(process.env).map(([name, value]) => [name, { value: value ?? '' }]))
const { ctx, shutdown } = await runProfile({
  environment: { entries, get: name => entries[name], has: name => entries[name] !== undefined },
  profile: 'ai-compiler-scratch',
  patchFiles: [],
  args: ['suite'],
})

/** A real workspace tree plus its neighbour, so "outside the root" is a genuine path. */
const root = mkdtempSync(join(tmpdir(), 'dsh-perm-root-'))
// `workspace-write` deliberately also grants /tmp and $TMPDIR
// (packages/sandbox/sandbox/src/roots.ts:52-55), so "outside" must live
// somewhere the fence really denies: the user's home.
const outside = mkdtempSync(join(homedir(), '.dsh-perm-outside-'))
try {
  const fs = ctx.get('fs')
  writeFileSync(join(root, 'inside.txt'), 'inside\n')
  writeFileSync(join(outside, 'outside.txt'), 'outside\n')

  // ── Layer 1: the filesystem fence, in-process, per mode ────────────────────
  const writeWith = async (mode, path, policyRoot) => {
    const target = await fs.resolve(path, { cwd: policyRoot })
    try {
      await fs.writeText(target, `written under ${mode}\n`, { kind: 'create', overwrite: true }, undefined, {
        mode,
        workspaceRoot: policyRoot,
      })
      return 'ALLOWED'
    } catch (error) {
      return `DENIED: ${error?.code ?? error?.message}`
    }
  }

  const insideWrite = await writeWith('workspace-write', join(root, 'inside.txt'), root)
  const outsideWrite = await writeWith('workspace-write', join(outside, 'outside.txt'), root)
  check('workspace-write allows a write inside the workspace root', insideWrite === 'ALLOWED', insideWrite)
  check('workspace-write denies a write outside the workspace root and /tmp',
    outsideWrite.startsWith('DENIED'), `${outsideWrite} (outside=${outside})`)

  const readOnlyInside = await writeWith('read-only', join(root, 'inside.txt'), root)
  check('read-only denies even an in-root write', readOnlyInside.startsWith('DENIED'), readOnlyInside)

  const fullAccess = await writeWith('danger-full-access', join(outside, 'outside.txt'), root)
  check('danger-full-access allows a write outside the workspace root', fullAccess === 'ALLOWED', fullAccess)

  // ── Layer 2: the OS sandbox backend, per mode ──────────────────────────────
  const sandbox = ctx.get('sandbox')
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    const policy = ctx.get('sandboxPolicy').resolve({ mode, workspaceRoot: root })
    if (mode === 'danger-full-access') {
      record('INFO', 'danger-full-access is never confined', 'bash/PTC child run unconfined by design')
      continue
    }
    try {
      const confined = await sandbox.confine(['bash', '-c', 'true'], policy)
      record('INFO', `sandbox backend selects confinement for ${mode}`,
        `runner=${confined.argv.slice(0, 3).join(' ')}, enforcement=${confined.enforcement}`)
    } catch (error) {
      record('INFO', `sandbox backend CANNOT confine ${mode} on this host`,
        `${error?.name ?? 'Error'}: ${String(error?.message ?? error).split('\n')[0]}`)
    }
  }

  // ── Layer 3: what a real tool sees on this host ────────────────────────────
  record('INFO', 'bash executor sandbox reporting', bashExecutorProbe())

  const failed = results.filter(entry => entry.kind === 'FAIL')
  const report = {
    at: new Date().toISOString(),
    root,
    results,
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    note: 'INFO rows record host facts that are not pass/fail of the mode itself.',
  }
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\n${results.filter(entry => entry.kind === 'PASS').length} PASS, ${failed.length} FAIL — ${report.verdict}`)
  process.exit(failed.length === 0 ? 0 : 1)
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  await shutdown?.shutdown?.(0)
  await ctx.fiber?.dispose?.()
}

/** Probe the composed bash executor's sandbox reporting, without running a command. */
function bashExecutorProbe() {
  const bashTool = ctx.get('tools')?.get('bash')
  if (bashTool === undefined) return 'bash tool not registered in this composition'
  return 'bash tool registered (see the sandboxPolicy mode for its confinement)'
}
