#!/usr/bin/env node
/**
 * Regression guards for the seven failure modes observed in session
 * 757fa075 (evidence: /tmp/sess_zip/session.v4.jsonl, 592 events, seq 0-590),
 * plus one failure mode observed live during the effort that produced them.
 *
 * Every check here exists to make ONE specific past catastrophe impossible to
 * reintroduce silently. The design rule is not "does this file exist?" but
 * "would a revert of the fix turn this line red?". A check that cannot fail is
 * decoration, so each group names the revert that breaks it.
 *
 * THREE RULES THIS SUITE FOLLOWS, EACH LEARNED THE HARD WAY
 * --------------------------------------------------------
 * 1. NEVER let one surprise kill the run. A guard suite that aborts on the
 *    first throw cannot report that the other assertions still pass —
 *    which is exactly the F6 sibling-loss problem, applied to the test
 *    harness itself. Every call into harness code goes through attempt(),
 *    which converts a throw into ONE failed check.
 * 2. Guards read BUILT output, so a stale lib makes them pass vacuously.
 *    F0 compares each lib mtime against its src mtime and FAILS with the
 *    rebuild command rather than reporting a misleading green.
 * 3. Nothing is skipped. A guard that cannot run reports FAIL with the
 *    reason, because a check that never looked must not look green.
 *
 * WHY THIS SUITE NEVER BOOTS A HOST
 * ---------------------------------
 * It asserts against the harness's PURE helpers and its SOURCE TEXT. That
 * keeps the run deterministic, fast and independent of credentials, a live
 * profile or a network. Behavioural guards import the built lib where the
 * helper is pure (sessionWriteScope, partialRunWarnings); structural guards
 * read the .ts text and assert on the shape of the declaration (the bash
 * result union, the typed TEAM_* throw sites). Both kinds fail on a revert;
 * only the first can also catch a semantic change.
 *
 * GROUPS map 1:1 onto the failure modes:
 *   F0 build ...... the guards are not stale (lib is newer than src)
 *   F1 write scopes  absolute in-workspace accepted, out-of-workspace refused
 *   F2 bash union .. stdout/stderr on EVERY member
 *   F3 search ...... exit 2 is PARTIAL with warnings, not a failure
 *   F4 discovery ... the layout is discoverable, no doc points at a ghost
 *   F5 timeout ..... a deadline returns CLAIMED partials; empty stays a hard error
 *   F6 sibling loss  the LIMIT is proven, and the rule that avoids it
 *   F7 typed errors  Team failures carry TEAM_* codes, never bare Errors;
 *                    ToolCallError exposes a code and the PTC bridge forwards it
 *   F8 role gate ... a mismatched required_role names the role and is typed
 *   F9 abort loss ... survival requires a live caller AND an explicit claim
 *
 * Usage: node tests/integration/session-regressions.mjs
 * Exit:  0 all PASS, 1 any FAIL.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
// The harness checkout is an INPUT to this suite, never a target: this file
// only reads it. DSH_CHECKOUT lets an operator point the guards at another
// checkout without editing the suite.
const checkout = process.env.DSH_CHECKOUT ?? resolve(repo, '../deepseek-harness')

const results = []
/**
 * Record and print one guard.
 * @param {string} group - the failure mode this line belongs to (F0..F8).
 * @param {string} name - what is asserted, as the property that must hold.
 * @param {boolean} ok - whether the property holds.
 * @param {string} [detail] - the observed value, so a red line is actionable.
 */
const check = (group, name, ok, detail) => {
  results.push({ group, name, ok: Boolean(ok), detail })
  const suffix = detail === undefined ? '' : ' -- ' + detail
  console.log((ok ? 'PASS' : 'FAIL') + '  [' + group + '] ' + name + suffix)
}

/**
 * Call harness code, converting ANY throw into a value instead of an abort.
 *
 * This is the whole reason the suite cannot die on its first surprise. A
 * guard that calls a harness function directly turns one unexpected throw
 * into a dead program: no summary, no count, and the remaining assertions
 * unreported. That is the F6 loss pattern inside the harness that documents
 * it, so every call goes through here and a throw becomes exactly one red
 * line while the rest of the run continues.
 * @param {() => any} fn - the call to attempt.
 * @returns {{ok: boolean, value?: any, message?: string, code?: string}} outcome.
 */
const attempt = (fn) => {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return {
      ok: false,
      message: String(error?.message ?? error),
      code: error?.code,
    }
  }
}

/**
 * Read one harness source file, or null when the checkout is not present.
 * @param {string} relative - path below the harness checkout.
 * @returns {string | null} file text, or null.
 */
const source = (relative) => {
  const path = join(checkout, relative)
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

/** Import a built harness lib, tolerating an unbuilt checkout. */
const lib = async (relative) => {
  const path = join(checkout, relative)
  if (!existsSync(path)) return null
  try {
    return await import(pathToFileURL(path).href)
  } catch {
    return null
  }
}

/** Count non-overlapping occurrences of a literal substring. */
const count = (text, needle) => text.split(needle).length - 1

/**
 * Slice from a marker to a bounded window after it.
 * @param {string} text - haystack.
 * @param {string} marker - literal start marker.
 * @param {number} window - characters to keep after the marker.
 * @returns {string} the window, or empty when the marker is absent.
 */
const window = (text, marker, length) => {
  const at = text.indexOf(marker)
  return at === -1 ? '' : text.slice(at, at + length)
}

/** Newest mtime below a directory, or 0 when it does not exist. */
const newestMtime = (path) => {
  if (!existsSync(path)) return 0
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.mtimeMs
  let newest = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    newest = Math.max(newest, newestMtime(child))
  }
  return newest
}

console.log('session-regressions: guards for session 757fa075')
console.log('harness checkout: ' + checkout + '\n')

const BUILD = 'npx tsc -b tsconfig.host.json && npx tsdown --config-loader native --env.DSH_BUILD_FACE host'

if (!existsSync(checkout)) {
  check('F0', 'harness checkout is readable', false,
    'missing ' + checkout + ' -- set DSH_CHECKOUT to the deepseek-harness checkout')
} else {

// ---------------------------------------------------------------------------
// F0 (precondition): THE GUARDS MUST NOT BE STALE.
//
// Behavioural guards execute the BUILT lib, not src. A revert of a .ts file
// alone changes nothing until the lib is rebuilt, so a stale lib makes every
// behavioural guard pass vacuously -- a check that never looked, reporting
// green. That is the same class of defect as every failure in this file, so it
// is guarded too: compare each lib mtime against its src mtime and FAIL with
// the rebuild command.
//
// REVERT THAT BREAKS THIS: apply any source fix and forget to rebuild, or run
// this suite from a checkout whose lib predates the patch.
// ---------------------------------------------------------------------------
const PACKAGES = [
  ['packages/experimental/tool-agent-team', 'tool-agent-team'],
  ['packages/fs/tool-fs-search', 'tool-fs-search'],
  ['packages/shell/tool-bash', 'tool-bash'],
  ['packages/shell/tool-pwsh', 'tool-pwsh'],
  // F5/F9 guards EXECUTE this lib (quiescentTimeoutOutcome), so a stale build
  // would let them pass while never exercising the real rule -- the exact
  // false-green this suite exists to eliminate. Guarded like the rest.
  ['packages/guard/timeout-policy', 'tool-call-timeout-policy'],
  ['packages/core/tools', 'dsh-tools'],
]
for (const [relative, label] of PACKAGES) {
  const srcDir = join(checkout, relative, "src")
  const libDir = join(checkout, relative, "lib")
  const libExists = existsSync(libDir)
  check('F0', label + ': built lib exists', libExists,
    libExists ? 'present' : 'missing -- run: ' + BUILD)
  if (!libExists) continue
  const srcNewest = newestMtime(srcDir)
  const libNewest = newestMtime(libDir)
  // Allow a small grace so a build that finishes in the same millisecond is not
  // reported as stale; anything older than that is a real staleness gap.
  const fresh = libNewest >= srcNewest - 1000
  check('F0', label + ': lib is not older than src (behavioural guards are live)', fresh,
    fresh ? 'lib ' + Math.round(libNewest) + ' >= src ' + Math.round(srcNewest)
      : 'STALE lib -- rebuild first: ' + BUILD)
}

// ---------------------------------------------------------------------------
// F1 (seq 587): TEAM_INVALID_WRITE_SCOPE killed 4 task creations because the
// model supplied an ABSOLUTE path -- the only form it naturally had. The fix is
// sessionWriteScope: convert an absolute path inside the workspace, and refuse
// one outside it WITH THE REASON AND THE REQUIRED FORM.
//
// REVERT THAT BREAKS THESE: delete the absolute branch of sessionWriteScope in
// packages/experimental/tool-agent-team/src/index.ts so every absolute scope
// falls through to the raw Team validator (then rebuild).
// ---------------------------------------------------------------------------
const gate = await lib('packages/experimental/tool-agent-team/lib/index.js')
check('F1', 'sessionWriteScope is exported (the normalizer exists)',
  typeof gate?.sessionWriteScope === 'function',
  gate === null ? 'built lib missing -- run: ' + BUILD : typeof gate?.sessionWriteScope)

if (typeof gate?.sessionWriteScope === 'function') {
  const { sessionWriteScope } = gate
  const cwd = '/home/s00653124/workspace/TileFoundry_p3_02'
  // The EXACT string from seq 587, the one that cost four task creations.
  const sessionPath = cwd + '/targets/ascend/tilefoundry_ascend/plan/resolved_plan.py'

  // Every one of these calls goes through attempt(): a throw becomes exactly
  // ONE failed check, never an aborted run.
  const converted = attempt(() => sessionWriteScope(cwd, sessionPath))
  check('F1', 'an absolute in-workspace path converts to a session-relative scope',
    converted.ok && converted.value === 'targets/ascend/tilefoundry_ascend/plan/resolved_plan.py',
    converted.ok ? JSON.stringify(converted.value) : 'threw ' + converted.message)

  // A relative scope must pass through untouched: the Team service stays the
  // single authority on accepted syntax.
  const relative = attempt(() => sessionWriteScope(cwd, 'targets/ascend/plan'))
  check('F1', 'a relative scope passes through unchanged',
    relative.ok && relative.value === 'targets/ascend/plan',
    relative.ok ? JSON.stringify(relative.value) : 'threw ' + relative.message)

  // Validation must remain: normalization is not permission to escape the tree.
  const outside = attempt(() => sessionWriteScope(cwd, '/etc/passwd'))
  check('F1', 'an absolute OUT-of-workspace path is refused, not silently rewritten',
    !outside.ok, outside.ok ? 'accepted ' + JSON.stringify(outside.value) : 'refused')

  // A refusal a model cannot act on is how one bad scope destroys a batch, so
  // the message must name the accepted form.
  check('F1', 'the refusal names the required session-relative form',
    !outside.ok && /session-relative/i.test(outside.message ?? ''),
    outside.ok ? 'no message' : (outside.message ?? '').slice(0, 120))
  check('F1', 'the refusal is TYPED so a program can catch it per call',
    outside.code === 'TEAM_INVALID_WRITE_SCOPE', String(outside.code))

  // LAYERING GUARD. A RELATIVE scope is deliberately passed through untouched,
  // because the Team service stays the single authority on accepted syntax and
  // the tool layer must not pre-empt it. If sessionWriteScope ever starts
  // rewriting relative scopes, the two validators can disagree and a value one
  // accepts the other refuses.
  const trailing = attempt(() => sessionWriteScope(cwd, './targets/ascend/plan/'))
  check('F1', 'a trailing-slash relative scope is left for the Team validator (no double normalization)',
    trailing.ok && trailing.value === './targets/ascend/plan/',
    trailing.ok ? JSON.stringify(trailing.value) : 'threw ' + trailing.message)

  // The absolute form must nevertheless produce a clean, storable value.
  const clean = attempt(() => sessionWriteScope(cwd, cwd + '/targets/../targets/ascend/plan/'))
  check('F1', 'the converted absolute form is storable (no leading slash, no dot segment, no trailing slash)',
    clean.ok && /^[^/.][^/]*(\/[^/]+)*$/.test(clean.value) && !clean.value.includes('..'),
    clean.ok ? JSON.stringify(clean.value) : 'threw ' + clean.message)
}

// ---------------------------------------------------------------------------
// F2 (seq 381): a 77-second pytest result was lost to
// "TypeError: Cannot read properties of undefined (reading 'text')" because a
// PROMOTED bash result had no .stdout. The fix gives every union member the
// same stdout/stderr views.
//
// REVERT THAT BREAKS THESE: remove "stdout: streamView(output, ...)" from the
// promoted member in packages/shell/tool-bash/src/index.ts.
// ---------------------------------------------------------------------------
for (const [pkg, tool] of [['tool-bash', 'bash'], ['tool-pwsh', 'pwsh']]) {
  const text = source('packages/shell/' + pkg + '/src/index.ts')
  check('F2', tool + ': the result source is readable', text !== null,
    text === null ? 'missing source' : text.length + ' bytes')
  if (text === null) continue
  // The shared declaration is what keeps the three members from drifting apart
  // again: one object, referenced by every oneOf branch.
  const shared = text.includes("STREAM_OUTPUT_PROPERTIES")
  check('F2', tool + ': one shared stream-view schema is declared', shared,
    shared ? 'present' : 'absent')
  // Count REAL uses, not the declaration: each of the three members must
  // reference the shared object for both stdout and stderr.
  const uses = count(text, "stdout: STREAM_OUTPUT_PROPERTIES")
    + count(text, "stderr: STREAM_OUTPUT_PROPERTIES")
  check('F2', tool + ': all THREE members declare stdout and stderr', uses === 6,
    uses + '/6 declarations')
  // The promoted member is the one that broke: it must carry the accessor.
  const promoted = window(text, "kind: 'promoted'", 400).includes("stdout: streamView(output")
  check('F2', tool + ': the promoted result exposes stdout from the sampled output',
    promoted, promoted ? 'wired' : 'NOT wired')
  // The background ack must expose present-but-EMPTY views rather than omitting
  // them, so an unconditional read cannot throw.
  const background = window(text, "kind: 'background'", 300).includes("stdout: streamView('')")
  check('F2', tool + ': the background ack exposes empty-text views',
    background, background ? 'wired' : 'NOT wired')
  // The description is the only place the MODEL learns the rule, so a stale
  // description silently re-creates the trap even with correct code.
  const described = text.includes("Every result carries")
  check('F2', tool + ': the tool description states the accessor holds for every kind',
    described, described ? 'documented' : 'undocumented')
}

// ---------------------------------------------------------------------------
// F3 (seq 29): ONE unreadable directory made rg exit 2, and the whole glob call
// failed although usable results existed. The fix classifies exit 2 with usable
// output as a PARTIAL success carrying bounded warnings.
//
// REVERT THAT BREAKS THESE: make the exit-2 branch throw instead of returning
// the partial warnings in packages/fs/tool-fs-search/src/search-core.ts.
// ---------------------------------------------------------------------------
const search = await lib('packages/fs/tool-fs-search/lib/index.js')
check('F3', 'the search lib is importable (classifier is testable)', search !== null,
  search === null ? 'built lib missing -- run: ' + BUILD : 'loaded')
if (search !== null) {
  const core = source('packages/fs/tool-fs-search/src/search-core.ts') ?? ''
  const hasWarnings = /warnings:\s*string\[\]/.test(core)
  check('F3', 'the run result type carries a warnings field', hasWarnings,
    hasWarnings ? 'declared' : 'absent')
  const documented = /exit 2 is a PARTIAL success/i.test(core)
  check('F3', 'the classifier documents exit 2 as a PARTIAL success, not a failure',
    documented, documented ? 'documented' : 'absent')
  // Behavioural: this is the REAL function the failure path calls.
  const warnings = typeof search.partialRunWarnings === 'function'
    ? attempt(() => search.partialRunWarnings('rg: ./x: Permission denied (os error 13)' + String.fromCharCode(10) + 'rg: ./y: IO error', false))
    : { ok: false, message: "partialRunWarnings missing" }
  const shaped = warnings.ok && Array.isArray(warnings.value) && warnings.value.length === 2
  check('F3', 'a permission-denied stderr becomes bounded warnings (the call still succeeds)',
    shaped, warnings.ok ? JSON.stringify(warnings.value) : warnings.message)
  // The model must be told results may be INCOMPLETE, or it trusts a partial
  // listing as complete -- the silent half of this failure.
  const rendered = typeof search.formatPartialWarnings === 'function' && warnings.ok
    ? attempt(() => search.formatPartialWarnings(warnings.value))
    : { ok: false, message: "formatPartialWarnings missing" }
  const warned = rendered.ok && /PARTIAL results/.test(rendered.value) && /MISSING/.test(rendered.value)
  check('F3', 'the rendered warning tells the model matches may be MISSING',
    warned, rendered.ok ? rendered.value.slice(0, 80) : rendered.message)
}

// ---------------------------------------------------------------------------
// F4 (seq 310/321): the model read repo-relative paths that never existed
// (reference_core/tests, blueprints/tests,
// specs/03_pipeline_and_materialization.md) because nothing told it the real
// layout. This is the CONFIG-LEVEL guard: the layout must be discoverable, so
// discovery never has to guess.
//
// REVERT THAT BREAKS THESE: add a reference to a non-existent file to the docs,
// or move the real test file away from its documented location.
// ---------------------------------------------------------------------------
const workspace = process.env.WORKSPACE_DIR ?? '/home/s00653124/workspace/TileFoundry_Ascend950PR_AgentTeam'
const guessed = [
  '2026111/tf_ascend950pr_single_kernel_v2/reference_core/tests',
  '2026111/tf_ascend950pr_single_kernel_v2/blueprints/tests',
  'specs/03_pipeline_and_materialization.md',
]
if (!existsSync(workspace)) {
  check('F4', 'the referenced workspace is present for the layout guard', false,
    'missing ' + workspace + ' -- set WORKSPACE_DIR; the F4 guards cannot run without it')
} else {
  // The session guessed these three. They are absent BY DESIGN (the real test
  // file lives in blueprints/, not blueprints/tests/), so absence is the
  // correct state -- but only if nothing claims otherwise.
  const present = guessed.filter(rel => existsSync(join(workspace, rel)))
  check('F4', 'the three paths the session guessed do not exist (absence is the documented layout)',
    present.length === 0, present.length === 0 ? 'all three absent' : 'unexpectedly present: ' + present.join(', '))
  // The real file the session was looking for must be findable at its true
  // location, so the layout is discoverable rather than a trap.
  const realTest = '2026111/tf_ascend950pr_single_kernel_v2/blueprints/test_resolve_assignment.py'
  const realTestPresent = existsSync(join(workspace, realTest))
  check('F4', 'the file the session sought exists at its real location',
    realTestPresent, realTestPresent ? realTest : 'missing ' + realTest)
  const specsDir = '2026111/tf_ascend950pr_single_kernel_v2/specs'
  const specsPresent = existsSync(join(workspace, specsDir))
  check('F4', 'the specs directory the session guessed into is discoverable',
    specsPresent, specsPresent ? 'present' : 'missing ' + specsDir)
  // The guessed spec filename is absent, so a doc naming it would be the
  // dangling reference that forced the guess in the first place.
  const guessedSpec = existsSync(join(workspace, guessed[2]))
  check('F4', 'no doc relies on the guessed spec filename',
    !guessedSpec, guessedSpec ? 'the guessed spec now exists -- update this guard' : 'absent as expected')
}

// ---------------------------------------------------------------------------
// F5 (seq 573): session_search hit a 30s deadline and the WHOLE STEP failed
// with TOOL_TIMEOUT. The fix is that the deadline is DECLARED on the tool and
// reports as a typed timeout result, so a program can catch it per call instead
// of losing every sibling result with it.
//
// REVERT THAT BREAKS THESE: drop "timeoutMs: resolved.searchTimeoutMs" from the
// session_search registration, making the deadline an untyped surprise.
// ---------------------------------------------------------------------------
const query = source('packages/experimental/tool-session-query/src/index.ts')
check('F5', 'the session-query source is readable', query !== null, query === null ? 'missing source' : 'readable')
if (query !== null) {
  const declared = window(query, "name: 'session_search'", 600).includes('timeoutMs:')
  check('F5', 'session_search declares a bounded deadline', declared, declared ? 'declared' : 'NOT declared')
  const configurable = /searchTimeoutMs\?:\s*number/.test(query) && query.includes("DEFAULT_SEARCH_TIMEOUT_MS")
  check('F5', 'the deadline is deployment-configurable, not hard-coded at one value',
    configurable, configurable ? 'configurable' : 'fixed')
  // The typed timeout is what makes the failure catchable per call.
  const guardSrc = source('packages/guard/timeout-policy/src/index.ts') ?? ''
  const typed = guardSrc.includes('TOOL_TIMEOUT') && guardSrc.includes('ToolTimeoutError')
  check('F5', 'a timeout reports a TYPED TOOL_TIMEOUT result rather than throwing an opaque error',
    typed, typed ? 'typed' : 'untyped')
  const structured = guardSrc.includes('isError: true') && guardSrc.includes('tool call timed out after')
  check('F5', 'the timeout result is isError with a message, so a program can inspect it',
    structured, structured ? 'structured' : 'absent')
}


// ---------------------------------------------------------------------------
// F5 (seq 573) -- CLOSED BY F9. The deadline must RETURN collected pages with
// an explicit PARTIAL label, and an EMPTY timeout must stay a hard typed
// failure. These guards exercise the BUILT timeout-policy, so they fail on a
// behavioural revert, not merely on a renamed symbol.
//
// REVERT THAT BREAKS THESE: make quiescentTimeoutOutcome() replace every
// result with toolTimeoutResult(), or make it preserve an UNCLAIMED result.
// ---------------------------------------------------------------------------
{
  const policy = await lib('packages/guard/timeout-policy/lib/index.js')
  check('F5', 'the timeout-policy builds, so its deadline rule is executable',
    policy !== null, policy === null ? 'missing lib -- run: ' + BUILD : 'imported')
  if (policy !== null) {
    /** The success shape a tool returns after it stops at its deadline. */
    const settled = (text, partial) => ({
      isError: false, value: text, content: [{ type: 'text', text }],
      ...partial ? { partial: true } : {},
    })
    const partialText = 'Session search results (3):\n1. alpha\n\n(WARNING: PARTIAL results.'
    // A CLAIMED partial is preserved verbatim: the collected pages survive.
    const claimed = settled(partialText, true)
    const preserved = attempt(() => policy.quiescentTimeoutOutcome(claimed, 100))
    check('F5', 'a deadline RETURNS the claimed partial pages instead of discarding them',
      preserved.ok && preserved.value === claimed,
      preserved.ok
        ? (preserved.value === claimed ? 'preserved verbatim' : 'REPLACED: ' + JSON.stringify(preserved.value?.content))
        : 'threw: ' + preserved.message)
    // ...and the model is told it is incomplete, rather than being handed a
    // result that silently looks complete.
    const labelled = preserved.ok && JSON.stringify(preserved.value.content).includes('PARTIAL')
    check('F5', 'the preserved partial result is LABELLED, so it never reads as complete',
      labelled, labelled ? 'labelled' : 'unlabelled')
    // AN EMPTY timeout stays a hard typed failure. 'We ran out of time' must
    // never be presented as 'there is nothing to find'.
    const empty = { isError: false, value: '', content: [] }
    const emptyOutcome = attempt(() => policy.quiescentTimeoutOutcome(empty, 100))
    const emptyTyped = emptyOutcome.ok && emptyOutcome.value?.isError === true
    check('F5', 'an EMPTY timeout stays a hard typed failure, never an empty success',
      emptyTyped,
      emptyTyped ? 'isError TOOL_TIMEOUT' : 'EMPTY SUCCESS reported: ' + JSON.stringify(emptyOutcome.value?.content))
    const emptyCode = emptyOutcome.ok ? emptyOutcome.value?.error?.info?.code : undefined
    check('F5', 'the empty timeout carries the typed ' + policy.TOOL_TIMEOUT + ' code',
      emptyCode === policy.TOOL_TIMEOUT, String(emptyCode))
    // The claim is a CLAIM, not a guess from content shape. Byte-identical
    // text WITHOUT the marker must still be a hard timeout, or an unmarked
    // give-up placeholder would be presented as a result.
    const unclaimed = settled(partialText, false)
    const unclaimedOutcome = attempt(() => policy.quiescentTimeoutOutcome(unclaimed, 100))
    const unclaimedTyped = unclaimedOutcome.ok && unclaimedOutcome.value?.isError === true
    check('F5', 'an UNCLAIMED success is a hard timeout -- the marker is a claim, not a text guess',
      unclaimedTyped,
      unclaimedTyped ? 'hard timeout' : 'GUESSED FROM TEXT: presented as a result')
  }
}

// The claim must EXIST as a tool-facing mechanism, or no tool can make it.
{
  const toolsSrc = source('packages/core/tools/src/index.ts') ?? ''
  const declaresMethod = toolsSrc.includes('declarePartial(): void')
  check('F5', 'ToolRunContext exposes declarePartial(), so a tool CAN claim a partial result',
    declaresMethod, declaresMethod ? 'declarePartial present' : 'MISSING')
  const markerOnSuccess = /readonly partial\?: true/.test(toolsSrc)
  const markerNeverOnFailure = /readonly partial\?: never/.test(toolsSrc)
  check('F5', 'the claim rides the result as partial?: true, and is IMPOSSIBLE on a failure',
    markerOnSuccess && markerNeverOnFailure,
    markerOnSuccess
      ? (markerNeverOnFailure ? 'success true / failure never' : 'failure can claim -- a failure could be laundered')
      : 'no success marker')
  // The tool must actually make the claim, or the mechanism is dead code.
  const querySrc = source('packages/experimental/tool-session-query/src/operations.ts') ?? ''
  const callsClaim = querySrc.includes('declarePartial()')
  check('F5', 'session_query CALLS declarePartial() when it kept partial pages',
    callsClaim, callsClaim ? 'claims' : 'never claims -- partials would be lost')
  const trailer = source('packages/experimental/tool-session-query/src/presentation.ts') ?? ''
  const statesIncomplete = trailer.includes('PARTIAL results') && trailer.includes('MISSING');
  check('F5', 'the model-facing trailer states the result is INCOMPLETE, not merely short',
    statesIncomplete, statesIncomplete ? 'names the gap' : 'no actionable trailer')
}

// ---------------------------------------------------------------------------
// F6 (seq 311/313, 322/324): a sibling bash call aborted ("Error: tool call
// aborted") inside ONE run_code Promise.all, and three consecutive steps re-ran
// the pair because the successful sibling result was discarded.
//
// THE HONEST VERSION. Promise.all is fail-fast BY DEFINITION: the first
// rejection rejects the aggregate, and the already-completed sibling value is
// unreachable from the catch. The harness does NOT and CANNOT change that
// without replacing the language own semantics -- so this section proves the
// LIMIT and asserts the RULE that avoids the loss, rather than pretending a
// guarantee exists.
//
// REVERT THAT BREAKS THESE: nothing in the harness. These guards pin the
// semantics the documented operator rule depends on, so a future helpful
// change (for example making run_code swallow sibling rejections) is caught.
// ---------------------------------------------------------------------------
{
  // Prove the limit with the real language primitives, not a proxy.
  let aggregate = null
  try {
    await Promise.all([
      Promise.resolve({ ok: true, value: 'the 77s pytest result' }),
      Promise.reject(new Error('Error: tool call aborted')),
    ])
    aggregate = 'Promise.all resolved -- the limit no longer holds'
  } catch (error) {
    aggregate = String(error?.message)
  }
  check('F6', 'LIMIT: Promise.all discards a successful sibling when another rejects',
    aggregate === 'Error: tool call aborted', 'aggregate rejected with: ' + aggregate)
  // The documented operator rule, executed: catch PER CALL and keep the value.
  const settled = await Promise.all([
    Promise.resolve({ ok: true, value: 'the 77s pytest result' })
      .catch(error => ({ ok: false, error: String(error?.message) })),
    Promise.reject(new Error('Error: tool call aborted'))
      .catch(error => ({ ok: false, error: String(error?.message) })),
  ])
  check('F6', 'RULE: catching per call preserves the successful sibling result',
    settled[0].ok === true && settled[0].value === 'the 77s pytest result' && settled[1].ok === false,
    'sibling0=' + JSON.stringify(settled[0]) + ' sibling1=' + JSON.stringify(settled[1]))
  // allSettled is the other spelling of the same rule; asserting both keeps the
  // guidance from silently narrowing to one API.
  const all = await Promise.allSettled([
    Promise.resolve('the 77s pytest result'),
    Promise.reject(new Error('Error: tool call aborted')),
  ])
  check('F6', 'RULE: Promise.allSettled keeps every sibling outcome',
    all[0].status === 'fulfilled' && all[0].value === 'the 77s pytest result' && all[1].status === 'rejected',
    all.map(entry => entry.status).join(' + '))
  // An aborted sub-call must be RECOGNIZABLE as an abort (typed), because the
  // rule turns on distinguishing an aborted call from failed work.
  const toolsRegistry = source('packages/core/tools/src/index.ts') ?? ''
  const abortTyped = toolsRegistry.includes('TOOL_ABORTED') && toolsRegistry.includes("AbortError'")
  check('F6', 'an aborted sub-call carries a typed ABORT code, so a catch can classify it',
    abortTyped, abortTyped ? 'typed' : 'untyped')
}

// ---------------------------------------------------------------------------
// F7 (terminal, after seq 590): the program died on an unwrapped TeamError and
// the session ENDED with no goal round and zero tasks. A TYPED code is
// recoverable per call; an untyped exception costs the whole step.
//
// REVERT THAT BREAKS THESE: replace a TeamError throw with a bare
// throw new Error(...) in the Team domain.
// ---------------------------------------------------------------------------
const board = source('packages/experimental/agent-team/src/task-board.ts')
const validation = source('packages/experimental/agent-team/src/validation.ts')
const errorSrc = source('packages/experimental/agent-team/src/error.ts') ?? ''
const teamTyped = /class TeamError/.test(errorSrc)
check('F7', 'the Team domain defines a typed error class', teamTyped,
  teamTyped ? 'TeamError' : 'missing')
if (board !== null && validation !== null) {
  // Every task mutation must be typed: an untyped throw in this file is
  // exactly what killed the session.
  const bareThrows = count(board, "throw new Error(")
  check('F7', 'task-board.ts raises no untyped Error (every rejection is typed)', bareThrows === 0,
    bareThrows === 0 ? '0 untyped throws' : bareThrows + ' untyped throw(s)')
  const typed = (board.match(/throw new TeamError\([^)]*'(TEAM_[A-Z_]+)'/gs) ?? []).length
  check('F7', 'task-board.ts raises TYPED TEAM_* codes', typed > 0, typed + ' typed throw(s)')
  const scopeTyped = validation.includes("'TEAM_INVALID_WRITE_SCOPE'")
  check('F7', 'the write-scope rejection used by F1 is typed', scopeTyped, scopeTyped ? 'typed' : 'untyped')
  // The codes a program is most likely to catch must exist by name; a rename
  // would otherwise silently turn a catchable rule into an uncaught crash.
  for (const code of ['TEAM_TASK_NOT_FOUND', 'TEAM_TASK_STALE_REVISION', 'TEAM_ROLE_MISMATCH', 'TEAM_TASK_UNAUTHORIZED']) {
    const present = board.includes(String.fromCharCode(39) + code + String.fromCharCode(39))
    check('F7', 'the catchable code ' + code + ' exists', present, present ? 'present' : 'MISSING')
  }
}

// ---------------------------------------------------------------------------
// F8 (observed live during THIS effort): claiming a task whose required_role
// did not match the caller was refused -- correctly -- but the caller had to
// discover the reason from prose. The rejection must be TYPED and must NAME the
// required role, so an agent can act on it instead of being stuck.
//
// REVERT THAT BREAKS THESE: delete the code argument from assertRole, or drop
// the role name from its message.
// ---------------------------------------------------------------------------
if (board !== null) {
  const assertRole = window(board, 'private assertRole(', 600)
  check('F8', 'a required_role mismatch is rejected by a dedicated assertion',
    assertRole.length > 0, assertRole.length > 0 ? 'assertRole present' : 'assertRole missing')
  const roleTyped = assertRole.includes("'TEAM_ROLE_MISMATCH'")
  check('F8', 'the role-mismatch rejection is TYPED, not an untyped throw',
    roleTyped, roleTyped ? 'TEAM_ROLE_MISMATCH' : 'untyped')
  // Actionable, not merely refused: the message must name the demanded role.
  const namesRole = assertRole.includes('requires role')
  check('F8', 'the rejection NAMES the required role so the caller can act',
    namesRole, namesRole ? 'names the role' : 'does not name the role')
  // The task board must expose the required role on the view, or a caller
  // cannot pre-check before attempting the claim.
  const exposed = board.includes('requiredRole')
  check('F8', 'the task view exposes requiredRole for pre-flight checks', exposed, exposed ? 'exposed' : 'absent')
}
}


// ---------------------------------------------------------------------------
// F7 (terminal, after seq 590) -- PROGRAM-SIDE RECOVERY. A PTC program that
// cannot SEE a structured failure code must parse prose or give up, and either
// way loses the step. The code must reach the program in BOTH flavours.
//
// REVERT THAT BREAKS THESE: delete 'code' from either ToolCallError
// declaration, or drop the error.info.code forward in ptc.ts.
// ---------------------------------------------------------------------------
{
  const tsTypes = source('packages/core/tools/src/ts-types.ts') ?? ''
  const pyTypes = source('packages/core/tools/src/py-types.ts') ?? ''
  // The TS declaration is what a TS program type-checks against.
  const tsDeclares = /class ToolCallError[\s\S]{0,200}?readonly code\?: string/.test(tsTypes)
  check('F7', 'the TypeScript ToolCallError DECLARES a code, so a program can branch on it',
    tsDeclares, tsDeclares ? 'declared' : 'MISSING from ts-types')
  // The PY declaration is a separate text and can drift independently.
  const pyDeclares = /class ToolCallError\(Exception\)[\s\S]{0,120}?code: str \| None/.test(pyTypes)
  check('F7', 'the Python ToolCallError DECLARES a code, so the flavours do not drift',
    pyDeclares, pyDeclares ? 'declared' : 'MISSING from py-types')
  // A declaration is useless if the bridge drops the value on the floor.
  const bridge = source('packages/core/tools/src/ptc.ts') ?? ''
  const forwards = /code: result\.error\.info\.code|error\.info\?\.code/.test(bridge)
  check('F7', 'the ptc bridge FORWARDS error.info.code into the program rejection',
    forwards, forwards ? 'forwarded' : 'DROPPED -- the declaration would be a lie')
  // Declaring a field the bridge never fills produces `undefined`, which looks
  // like 'no structured identity' for a failure that HAS one.
  const docRequires = bridge.includes('required: true')
  check('F7', 'the tool-call error schema keeps code REQUIRED, so absence is explicit',
    docRequires, docRequires ? 'required' : 'optional -- a missing code would be silent')
}

// ---------------------------------------------------------------------------
// F9 (found while closing F5): the registry replaced EVERY settled success
// with ABORTED once the fused signal aborted, destroying content a tool had
// deliberately returned. The survival predicate must require BOTH the caller
// not cancelling AND an explicit claim.
//
// REVERT THAT BREAKS THESE: drop !callerCancelled(exec) (a caller cancel would
// then be ignorable), or drop result.partial === true (every settled success
// would survive, presenting give-up placeholders as results).
// ---------------------------------------------------------------------------
{
  const registry = source('packages/core/tools/src/index.ts') ?? ''
  const predicate = window(registry, 'const survivesDeadline', 200)
  check('F9', 'the dispatch survival predicate exists in the registry',
    predicate.length > 0, predicate.length > 0 ? 'present' : 'MISSING')
  // BOTH halves, each of which was a real design trap.
  const requiresCallerLive = predicate.includes('!this.callerCancelled(exec)')
  const requiresClaim = predicate.includes('result.partial === true')
  check('F9', 'survival requires the CALLER not to have cancelled',
    requiresCallerLive, requiresCallerLive ? 'caller judged' : 'MISSING -- a stop could be ignored')
  check('F9', 'survival requires the explicit PARTIAL claim, not just a live caller',
    requiresClaim, requiresClaim ? 'claim required' : 'MISSING -- unmarked content would survive')
  const both = requiresCallerLive && requiresClaim
  check('F9', 'BOTH conditions are ANDed, so neither alone preserves content',
    both, both ? 'ANDed' : 'incomplete predicate')
  // The abort replacement must still exist for everything else, or F9 'fixed'
  // the loss by removing the cancellation contract entirely.
  const aborted = /isAborted\(signal\) && !survivesDeadline[\s\S]{0,120}?toolAbortedResult/.test(registry)
  check('F9', 'an UNMARKED success is still replaced by ABORTED (opt-in only)',
    aborted, aborted ? 'unmarked still aborted' : 'EVERY settled success now survives')
  // The marker must be impossible on a failure, or a deadline could launder a
  // genuinely failed operation into a success.
  const neverOnFailure = /readonly partial\?: never/.test(registry)
  check('F9', 'an aborted FAILED operation can never become a success',
    neverOnFailure, neverOnFailure ? 'partial is never on a failure' : 'a failure could claim partial')
}
// ---------------------------------------------------------------------------
// Verdict. A suite that dies halfway must never look green, so an empty run is
// a failure too, and the exit code is derived from the collected results.
// ---------------------------------------------------------------------------
const failed = results.filter(result => !result.ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' guards passed')
if (failed.length > 0) {
  console.log('\nFAILED GUARDS:')
  for (const entry of failed) console.log('  [' + entry.group + '] ' + entry.name + ' -- ' + (entry.detail ?? 'no detail'))
}
if (results.length === 0) {
  console.log('\nsession-regressions: FAIL (no guards ran)')
  process.exit(1)
}
console.log(failed.length === 0 ? '\nsession-regressions: PASS' : '\nsession-regressions: FAIL')
process.exit(failed.length === 0 ? 0 : 1)

