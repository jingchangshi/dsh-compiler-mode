#!/usr/bin/env node
/**
 * Guards for the "tool-call failure during validation" incident
 * (docs/15-tool-call-failure-postmortem.md).
 *
 * WHAT ACTUALLY HAPPENED (evidence: session 633b5373 children)
 * ------------------------------------------------------------
 * A validator was told (by the task instructions and by the Lead) to prove
 * scripts/verify.sh step 1f fails on the duplicate agent-team row by toggling
 * @deepseek-ai/dsh-experimental-agent-team-profile in the LIVE profile
 * ~/.dsh/profiles/web/package.json. That edit is watched: HMR recomposes the
 * running profile on any bundle-list change (Hmr.reconcileProfile ->
 * recomposeProfile), stopping and restarting the agent-team / tool-agent-team
 * plugin entries. Two in-flight run_code programs then broke:
 *   - the validator's own program aborted      -> "code run failed (abort)"
 *   - the Lead's concurrent team_task_list()   -> unknown tool "team_task_list"
 * The Lead's report ("unknown tool: run_code" twice) also conflated a SECOND,
 * unrelated event: the first validator (group/validator) never emitted a tool
 * call at all -- its request/header offered run_code and it replied with a
 * text-only refusal, i.e. the model confabulated the error after being primed
 * with that exact phrase.
 *
 * THE FIX THIS PINS
 * -----------------
 * Do the last-row-wins FAIL/PASS demonstration on a THROWAWAY profile copy
 * (scripts/lib/last-row-wins-demo.sh), never the live, HMR-watched profile.
 * These checks fail red if that safe path is removed or the documented
 * mechanism it depends on changes.
 *
 * Structural only: reads source text, boots no Host. Same discipline as
 * session-regressions.mjs (F0-F10) and doc 14.
 *
 * Usage: node tests/integration/tool-call-failure-guard.mjs
 * Exit:  0 all PASS, 1 any FAIL.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const checkout = process.env.DSH_CHECKOUT ?? resolve(repo, '../deepseek-harness')
const results = []
const check = (name, ok, detail) => {
  results.push(Boolean(ok))
  console.log((ok ? 'PASS' : 'FAIL') + '  [F11] ' + name + (detail === undefined ? '' : ' -- ' + detail))
}
const source = (relative) => {
  const path = join(checkout, relative)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}
const local = (relative) => {
  const path = join(repo, relative)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}
const has = (text, needle) => typeof text === 'string' && text.includes(needle)

// G1: the safe, non-destructive demonstration helper exists and is wired to a copy.
const demo = local('scripts/lib/last-row-wins-demo.sh')
check('the last-row-wins demo helper exists', demo !== null, 'scripts/lib/last-row-wins-demo.sh')
check('the demo copies the live profile to a throwaway target (never writes live)',
  has(demo, 'cp -a "$src" "$dst"') && has(demo, 'rm -rf "$dst"') && has(demo, 'refusing to use the live profile as the demo copy'))
check('the demo proves BOTH states (fails on duplicate, passes on fixed)',
  has(demo, 'duplicate-row state') && has(demo, 'fixed state') && has(demo, 'is not a false green'))

// G2: the documented mechanism is real -- HMR recomposes the profile when its
// package.json bundle list changes. If this source stops doing that, the
// postmortem's whole explanation is stale and this check must go red.
const hmr = source('packages/boot/hmr/src/index.ts')
check('HMR watches the profile package.json', has(hmr, "join(profile.dir, 'package.json')"))
check('HMR DEFERS a bundle-change recomposition while agent turns run (P2 fix present)',
  has(hmr, 'shouldDeferProfileRefresh') && has(hmr, 'runningTurnCount') && has(hmr, 'bundlesChanged'))
check('HMR reconciles via recomposeProfile', has(hmr, 'reconcileProfile') && has(hmr, 'recomposeProfile('))

// G3: the exact error the incident observed is a scoped-registry miss, produced
// by core/tools -- not a global tool outage. Names the site so the doc's claim
// ("unknown tool" == caller-scope miss) can be re-derived.
const tools = source('packages/core/tools/src/index.ts')
check('core/tools produces an unknown tool message at scope lookup', has(tools, 'unknown tool "'))

// G4: the operations playbook must warn about editing the live profile during a run.
const ops = local('docs/09-operations.md')
check('the operations playbook warns against editing the live profile mid-run',
  has(ops, 'unknown tool') && has(ops, 'package.json') && /recompos|HMR/.test(ops ?? ''))

const failed = results.filter((ok) => !ok).length
console.log('')
console.log('tool-call-failure: ' + (failed === 0 ? 'PASS' : 'FAIL') + ' (' + (results.length - failed) + '/' + results.length + ')')
process.exit(failed === 0 ? 0 : 1)
