# 14 — Postmortem: session 757fa075 (7 failure modes, 8 guards)

**Subject:** an AI compiler-engineering session that spent **590 events** and
ended with **zero tasks created, zero goal rounds completed**, having lost a
77-second test run, four task creations, and three consecutive steps re-running
the same failing pair.

**Evidence:** `session.v4.jsonl`, 592 events, seq 0–590. The last event is
`seq 590 step/start` — the session did not conclude, it **stopped mid-step**.
Every claim below carries its seq number so it can be re-derived from the log.

**Guard suite:** `tests/integration/session-regressions.mjs` — **82 assertions**
(8 groups, F0–F8), one PASS line each, exit **1** on any regression, exit **0**
when clean, no Host required.

---

## The one-sentence thesis

> **A program that receives an untyped exception loses the ENTIRE step. A typed
> error code is recoverable, per call, by the program that hit it.**

Every failure below is an instance of that sentence. F7 is the pure case: the
program died on an unwrapped `TeamError` and the session never resumed. F1 is
the same defect one level up: the *reason* for a refusal was technically present
but not in a form the caller could act on, so four task creations were lost. F6
is the same defect in the language's own combinator: `Promise.all` converts one
sibling's abort into the loss of every sibling's value.

Fixing each one meant moving information from "a human reading a log can tell"
to "the calling program can branch on it".

---

## Two rules this SUITE itself had to learn (both found by the Lead)

A guard suite is code, and it can commit the very failures it documents. Both of
the following were caught in review, after the first passing run:

**1. The guards read BUILT output, so a stale lib passes without looking.**

The behavioural guards import `packages/*/lib/index.js`, not `src`. Reverting a
`.ts` file changes nothing until the lib is rebuilt — so a stale lib makes those
guards **green while proving nothing**, which is the same defect class as every
failure in this document. The suite now enforces its own precondition: group
**F0** compares each lib mtime against its src mtime and FAILS naming the exact
refresh command:

```bash
npx tsc -b tsconfig.host.json && npx tsdown --config-loader native --env.DSH_BUILD_FACE host
```

`scripts/verify.sh` runs this suite **after** the build steps and never treats a
stale tree as a pass. Do not move the step earlier.

**2. A guard that throws must fail ONE line, not abort the run.**

The first version called `sessionWriteScope` outside a `try/catch` in two places.
With the fix reverted, the uncaught `TeamError` killed the whole program: no
summary, no count, and the other assertions unreported. That is **F7 and F6
inside the guard suite** — one failure destroying all the sibling results. Every
call into harness code now goes through `attempt()`, which converts a throw into
exactly one red line while the rest of the run continues. A suite that dies on
its first surprise cannot tell you what else still passes.

---

## F1 — Absolute write scope destroyed four task creations (seq 587)

**Evidence.** `seq 587` is a `tool/ptc-dispatch` for `team_task_create`:

```
error: { name: "TeamError", code: "TEAM_INVALID_WRITE_SCOPE" }
text:  Error: invalid workspace-relative write scope
       "/home/s00653124/workspace/TileFoundry_p3_02/targets/ascend/tilefoundry_ascend/plan/resolved_plan.py"
```

The model supplied an **absolute** path — the only form it naturally had, since
it had just been editing that file. The Team validator only stores
session-relative prefixes. The call rejected, and because the batch of task
creations was issued as one program, **all four were lost**.

**Root cause.** Two layers disagreed about the accepted form and neither the tool
layer nor the error message bridged the gap. The model had no way to know that
the absolute path it could see was not the string it should pass.

**Mechanical fix — CODE.** `sessionWriteScope(cwd, value)` in
`packages/experimental/tool-agent-team/src/index.ts`:

* a **relative** candidate passes through untouched, so the Team service stays
  the single authority on accepted syntax;
* an **absolute candidate inside the session workspace** is converted losslessly
  to its session-relative form (the F1 case, now succeeding);
* an **absolute candidate outside** it is refused with a message that names the
  required form, the workspace, and a concrete example — and with the typed code
  `TEAM_INVALID_WRITE_SCOPE`.

The refusal is deliberate: a verbatim absolute scope is not comparable with
another task's scope, and a `../` rewrite would corrupt the component-wise
overlap warnings the board derives from these values.

**Cannot regress silently?** **CODE.** Guards F1-1 … F1-8 call the real
`sessionWriteScope` and would fail on the exact string from seq 587.

---

## F2 — A promoted bash result had no `.stdout` (seq 381)

**Evidence.** `seq 381`:

```
TypeError: Cannot read properties of undefined (reading 'text')
    at eval (.../ptc-runtime-node/src/bootstrap.ts:405:16), <anonymous>:11:30
```

Step 31 ran `pytest targets/ascend/tests/ -q` (a 77-second run) and read
`allTestsRun.stdout.text`. The call was **promoted** to a background job, so the
result was `{ kind: 'promoted', cwd, jobId, timeoutMs, output }` — **no
`stdout`**. The program threw, the run_code call failed, the job kept running,
and step 32 was spent killing it. A 77-second test run produced **zero usable
output**.

**Root cause.** The result union has three members but only ONE of them — the
common `foreground` case — carried `stdout`/`stderr`. Every natural program is
written against that shape, so the trap only fires on the slowest commands:
exactly the ones whose output matters most, and exactly when a wasted run is
most expensive.

**Mechanical fix — CODE.** Both `tool-bash` and `tool-pwsh` now render the SAME
`stdout`/`stderr` views on every union member, declared once as
`STREAM_OUTPUT_PROPERTIES`:

| kind | `stdout` | `stderr` |
| --- | --- | --- |
| `foreground` | the command's real stream | the command's real stream |
| `promoted` | the output sampled so far (`=== output`) | present, empty |
| `background` | present, empty | present, empty |

Nothing was removed: `output`, `jobId`, `timeoutMs` stay on `promoted`;
`jobId`, `cwd` stay on `background`. On `promoted`, `stderr` cannot be populated
because the job ring merges both streams — the fields exist so an unconditional
read is safe, not because the split is recoverable after the fact. The tool
**description** now states the rule, which matters as much as the code: the
description is the only place the model learns it.

**Cannot regress silently?** **CODE.** Guards F2-1 … F2-6 per tool.

---

## F3 — One unreadable directory failed a whole discovery call (seq 29)

**Evidence.** `seq 29`, a `glob` for `**/*TEAM_START*`:

```
error: { name: "SearchError", code: "SEARCH_FAILED" }
text:  Error: glob search failed (exit 2): rg: ./artifacts/run03/w35_env_e2e/tilelang_cache_on_6b8at_00:
       IO error for operation on ./artifacts/...: Permission denied (os error 13)
```

One cache directory the process could not read made `rg` exit 2, and the whole
discovery call failed — even though the pattern may well have matched elsewhere
in a tree the process could read.

**Root cause.** Exit 2 was classified as a total failure, when ripgrep uses it
for "some paths could not be read" while still emitting usable output.

**Mechanical fix — CODE.** `search-core.ts` classifies **exit 2 with usable
output as a PARTIAL success**, returning the results plus bounded `warnings`
from stderr. The rendering names the incompleteness explicitly and tells the
model matches may be **MISSING**, so a partial listing is never trusted as
complete — the silent half of the failure.

**Cannot regress silently?** **CODE.** Guards F3-1 … F3-5, including a
behavioural call to the real `partialRunWarnings` and `formatPartialWarnings`.

---

## F4 — The model guessed paths that did not exist (seq 310 / 321)

**Evidence.**

* `seq 310` — `read` of `2026111/tf_ascend950pr_single_kernel_v2/reference_core/tests/test_resolve_assignment.py` → `FS_NOT_FOUND`
* `seq 321` — `read` of `.../blueprints/tests/test_resolve_assignment.py` → `FS_NOT_FOUND`

The session also guessed `specs/03_pipeline_and_materialization.md`. The real
file is `.../blueprints/test_resolve_assignment.py` — **not** in a `tests/`
subdirectory — and the real spec is `specs/03_tir_memory_sync.md`. Every
guessed path was wrong in the same way: the model assumed a conventional layout
instead of a discoverable one.

**Root cause.** Nothing in the workspace made the true layout cheap to discover,
so guessing was the rational move — and every guess cost a step.

**Fix — CODE (bounded).** Three guessed paths are **absent by design**; that is
the correct state and the guard asserts it so nobody "helpfully" creates them
and thereby makes the wrong layout look real. The real file and the real specs
directory are asserted **present and discoverable**.

**Honest limit — ADVICE.** No code change can stop a model from guessing. What
the layout can do is make the guess *cheap to correct*, and what the guard can
do is ensure no doc points at a file that does not exist. A dangling reference
in the docs is the config-level defect that forces guessing; F4 guards watch for
that, not for the guessing itself.

**Cannot regress silently?** **PARTLY.** Absence, discoverability and
non-dangling references are **CODE** guards. The behaviour of guessing is
**ADVICE** (see the operator rules at the end).

---

## F5 — A 30-second search deadline failed the whole step (seq 573)

**Evidence.** `seq 573`, `session_search` for `"P3-02"`:

```
error: { name: "ToolTimeoutError", code: "TOOL_TIMEOUT" }
text:  Error: tool call timed out after 30000ms
```

The deadline is not the defect — an unbounded search is worse. The defect is
that the timeout surfaced as a step-killing failure with no way to treat it as
"no results this time".

**Root cause.** A bounded operation reported through the same channel as a
fatal error, so a program could not distinguish "this search was slow" from
"this program is broken".

**Mechanical fix — NOT YET CODE (corrected).** An earlier revision of this
document claimed F5 was already fixed. That claim was wrong, and the correction
matters more than the claim did. Verified against `HEAD`:

* `packages/experimental/tool-session-query/src/index.ts:70,80` already declares
  `timeoutMs: resolved.searchTimeoutMs`.
* `packages/guard/timeout-policy/src/index.ts` already emits the typed
  `ToolTimeoutError` / `TOOL_TIMEOUT` result.

Both halves existed **before** this effort, so nothing here was repaired. The
guards only pin the pre-existing shape. What the guards therefore protect is
the *declaration*, not the behaviour a program needs.

**The real defect, still live.** Two sites destroy partial work:

1. `timeout-policy/src/index.ts:61-79`. When the plugin's own deadline fires it
   `return`s `toolTimeoutResult(timeoutMs)`, **discarding** whatever the tool
   returned. A tool that reached quiescence carrying usable partial output has
   that output replaced by a bare error.
2. `tool-session-query/src/operations.ts:244-276`. `collectPages` accumulates
   finds in a local `items` array while lines 257/259 call
   `signal.throwIfAborted()`. On expiry that throws, so every page already
   collected is lost — the same discard-partial-results defect as F3, in a
   different subsystem.

So a 30 s search still fails the whole step with zero usable output. The fix
must RETURN collected pages with a labelled partial warning and keep an empty
timeout a hard failure.

**Mechanical fix — now actually CODE, but NOT by the mechanism first assumed.**
Implementing the two fixes above was not enough: a third layer, one level higher,
destroyed the content anyway. See F9. The delivered fix is:

* `tool-session-query` calls `exec.declarePartial()` when, and only when, the
  paging loop genuinely kept pages before the deadline, and renders a labelled
  `(WARNING: PARTIAL results. … MISSING from the results above.)` trailer.
* `timeout-policy` preserves a result that **claims** partiality and keeps a
  hard typed `TOOL_TIMEOUT` for everything else.

The claim replaced an earlier heuristic (`carriesPartialContent`, which guessed
from "the text is non-empty"). That guess was wrong in the dangerous direction:
an unmarked give-up placeholder would have been presented as a result. A tool
must now ASSERT partiality rather than have it inferred.

**A test that was passing for the wrong reason.** The original
`replaces a cooperative tool result with TOOL_TIMEOUT` test passed only because
the registry destroyed the content *first*, so the policy's preserve branch never
ran — it was reporting a timeout over a corpse. Proved by reverting the registry
fix (old code 18/18 pass; new code the test fails). Rewritten.

**Cannot regress silently?** **CODE.** Guards F5-1 … F5-5 plus F9's. Reverting
any of the three layers independently turns 4–5 tests red.

---

## F6 — An aborted sibling discarded a successful sibling (seq 311/313, 322/324)

**Evidence.** Two consecutive `run_code` programs each issued a `Promise.all`
over a `read` and a `bash`:

* `seq 310` `read` → `FS_NOT_FOUND`; `seq 313` `bash` → `{ name: "AbortError", code: "ABORTED" }`, text `Error: tool call aborted`
* `seq 321` `read` → `FS_NOT_FOUND`; `seq 324` `bash` → same abort

The programs died on the abort. **Three consecutive steps re-ran the same
failing pair.** `Promise.all` is fail-fast by definition: the first rejection
rejects the aggregate, and the already-completed sibling's value is unreachable
from the `catch`.

**This is where this document refuses to overclaim.**

The harness **cannot** guarantee "one aborted sibling preserves the successful
sibling" inside `Promise.all`. That is the semantics of the combinator the
program chose. A runtime that silently swallowed a sibling rejection would be
lying about `Promise.all`, and any program relying on that lie would break
differently later.

**So F6 is split honestly:**

| | kind | what it is |
| --- | --- | --- |
| The limit | **CODE (proven)** | Guards execute the real primitives and assert that `Promise.all` *does* discard the sibling. This is a guard against a future change that makes `run_code` pretend otherwise. |
| The rule | **ADVICE (executable)** | Catch **per call**, or use `Promise.allSettled`. The suite runs both and proves they preserve the value. |

> **Operator rule F6:** inside one `run_code` program, never let a
> single rejection destroy a result you need. Wrap each sub-call in
> `.catch(...)` and inspect the outcome, or use `Promise.allSettled`. Use
> `Promise.all` only when ALL results are genuinely required for the next step.

A documented limit beats a fake guarantee. The abort is at least **typed**
(`TOOL_ABORTED` / `AbortError`), so a per-call `catch` can classify it — that
much is CODE.

---

## F7 — An unwrapped TeamError ended the session (terminal, after seq 590)

**Evidence.** The log simply **stops**: `seq 590` is `step/start`, with no
matching `step/end`. Sequence 583–589 is the final step: `get_goal` at `seq 580`,
then `team_task_create` at `seq 587` rejected with `TEAM_INVALID_WRITE_SCOPE`,
then `seq 589 step/end` and `seq 590 step/start` — and nothing further.

**Zero tasks. Zero goal rounds.** The program died on a `TeamError` it never
caught, and the step — not just the call — was lost.

**Root cause.** The Team domain already raises typed errors (35 distinct
`TEAM_*` codes across the package; 26 typed throws in `task-board.ts`). The loss
came from the program treating a tool call as infallible: it did not wrap the
call, so one rejection cost the whole step and every other result in it.

**Mechanical fix — CODE (partial, and stated as such).**

* Every Team rejection carries a `TEAM_*` code and a human-readable message —
  verified: **0 untyped `throw new Error` in `task-board.ts`**.
* The durable log preserves it: `seq 587` records
  `error: { name: "TeamError", code: "TEAM_INVALID_WRITE_SCOPE" }`.
* The tool-result layer preserves it as `error.info = { name, code }`.

**Honest limit — ADVICE, and an open finding.** The typed code reaches the
durable log and the tool result, but a **PTC program does not receive it on the
thrown exception**. In `packages/core/tools/src/ptc.ts` the binding resolves a
failed dispatch to `{ isError: true, message: result.error.message }` (dropping
`info`), and the program then sees a `ToolCallError` carrying only the binding
name and that message. So a program cannot currently branch on
`error.code === 'TEAM_INVALID_WRITE_SCOPE'`; it can only match message text.

> **Operator rule F7:** wrap every Team tool call in `try/catch` and treat the
> message as the payload. Do not assume a machine-readable `code` on the caught
> exception until `ptc.ts` forwards `error.info` through the binding rejection.

**Cannot regress silently?** **CODE** for the tool layer and log (guards F7-1 …
F7-8). **ADVICE** for the program-side habit. The `ptc.ts` gap is recorded here
as a **known limitation**, deliberately not patched by this effort: it is a
change to the PTC failure contract and deserves its own task and its own tests.

---

## F8 — A role gate refused correctly but unactionably (observed live)

Not in the session log — this one happened **during this effort**. Claiming a
task whose `required_role` was `validator` from an `implementer` agent was
refused, correctly, but the caller could only learn *why* from prose and had to
report the blockage upstream to get it resolved. The refusal was right; the
*shape* of the refusal is what cost a round trip.

**Root cause.** Identical to F7 one level down: a correct refusal that a caller
cannot act on is functionally an untyped rejection.

**Mechanical fix — CODE.** `task-board.ts` rejects a role mismatch with
`TEAM_ROLE_MISMATCH` and a message that **names the required role**, and the
task view exposes `requiredRole`, so a caller can pre-check before claiming.

**Cannot regress silently?** **CODE.** Guards F8-1 … F8-4.

---

## F9 — The registry discarded a successful result's content on abort (found while fixing F5)

**This was the true mechanism behind F5**, and it was one layer above both
suspected sites. It is recorded separately because it affects EVERY tool that
races a deadline, not just search.

**Evidence.** `packages/core/tools/src/index.ts`, `dispatchToolBody`:

```ts
const returned = await tool.execute(exec.arguments, exec)
const result = this.createSuccessResult(exec, tool, returned)
return isAborted(signal) ? toolAbortedResult(result) : result
```

and `toolAbortedResult` (line ~1966) keeps **only** `prior.additionalContexts`
and replaces `content` with a bare `Error: tool call aborted`. Proven
empirically: a cooperative tool returning real work under a 100 ms deadline
produced `ABORTED` / `Error: tool call aborted` **with the timeout-policy plugin
not even mounted**.

**Root cause — a FUSED signal.** `dispatchToolBody` judged cancellation with
`isAborted(signal)`, where `signal` is the fused deadline signal, so a wrapper
(deadline) abort was indistinguishable from a caller cancel. The same registry
already makes this distinction correctly two stages later
(`this.callerCancelled(exec)` at ~1632 and ~1660). `dispatchToolBody` was the
outlier.

**The tension, stated honestly.** Both naive answers are wrong:
* Delete the replacement → a genuine caller cancel (user pressed stop) keeps
  accumulating content it should discard, and an aborted FAILED operation can
  start to look successful.
* Keep it → no cooperative tool can ever deliver partial work.

**Mechanical fix — CODE.** An explicit, opt-in claim:

```ts
const survivesDeadline = !this.callerCancelled(exec) && result.partial === true
return isAborted(signal) && !survivesDeadline ? toolAbortedResult(result) : result
```

A tool asserts `declarePartial()`; `partial?: true` is a type-level claim on
success and `never` on failure, so a failure can never be laundered into a
partial success. An **unmarked** success is replaced by `ABORTED` byte-for-byte
as before — pinned by a test using content identical to the preserved case.

**The contract, in one sentence:** a caller cancellation may discard a settled
result's content, but a deadline may not — a tool that observed its budget, kept
real work, and asserted `declarePartial()` has that content preserved, while
unmarked or failed results keep today's hard typed `TOOL_TIMEOUT`.

**Consequence for tool authors (ADVICE, written down because it is now required
knowledge).** A tool that wants to return partial work under a deadline must
call `exec.declarePartial()`. It must not rely on returning non-empty text.
`declarePartial()` is a required member of `ToolRunContext`, so a hand-built
context stub must add it (one in-repo stub needed updating).

**Cannot regress silently?** **CODE.** Reverting any one of the three layers
independently turns 4–5 tests red, including an end-to-end assertion that the
preserved content actually reaches the model.

---

## Summary: CODE vs ADVICE

This is the part that must not be overstated.

| # | Failure | Status | What is guaranteed |
| --- | --- | --- | --- |
| F0 | stale lib made guards vacuous | **CODE** | each lib mtime is compared to its src mtime; stale FAILS naming the rebuild command |
| F1 | absolute write scope | **CODE** | in-workspace absolute converts; out-of-workspace is refused by name, typed |
| F2 | promoted had no `.stdout` | **CODE** | `stdout`/`stderr` exist on every union member, documented in the description |
| F3 | exit 2 killed discovery | **CODE** | partial success + bounded warnings; model is told matches may be MISSING |
| F4 | guessed paths | **PARTLY CODE** | no dangling doc references, real paths discoverable; *not guessing* is **ADVICE** |
| F5 | search timeout killed the step | **CODE** | collected pages are RETURNED with a labelled PARTIAL warning on a deadline; an empty timeout stays a hard typed `TOOL_TIMEOUT`; the tool must assert `declarePartial()` |
| F6 | sibling abort lost a result | **ADVICE** | the LIMIT is proven, the catch-per-call RULE is executable — the harness does not and cannot override `Promise.all` |
| F7 | untyped TeamError ended the session | **CODE** | typed `TEAM_*` codes AND the code is now forwarded into the PTC program (TS `readonly code?: string`, PY `code: str | None`), proven by a real subprocess test that BRANCHES on `error.code` instead of dying; per-call `try/catch` remains program discipline |
| F8 | role gate unactionable | **CODE** | typed `TEAM_ROLE_MISMATCH` naming the required role; `requiredRole` on the view |
| F9 | registry discarded a successful result's content on abort | **CODE** | an opt-in `declarePartial()` claim survives a deadline-induced abort; an unmarked success is still replaced by `ABORTED` exactly as before, and a failure can never be laundered into a partial success |

**Two rules stay with the operator/model, permanently:**

1. **F6** — catch per call (or `allSettled`) when one rejection must not destroy
   another result.
2. **F7** — wrap Team tool calls; treat the message as the payload until
   `ptc.ts` forwards `error.info`.

Everything else is now enforced by executable guards: a revert turns a line red.

---

## The guards are load-bearing, not decoration

Each guard was validated by **deliberately reverting the fix** and confirming the
corresponding line fails, then restoring and confirming it passes:

| Revert performed | Exit code | Guards turned red |
| --- | --- | --- |
| `sessionWriteScope` absolute branch removed in the **built lib** | **1** | **5** — F1: absolute-converts, out-of-workspace-refused, names-form, typed, converted-form-storable |
| `src` touched but lib NOT rebuilt | **1** | **1** — F0: stale-lib |
| promoted `stdout`/`stderr` + schema refs removed | **1** | **2** — F2: all-three-members, promoted-wired |
| `assertRole` changed to an untyped `throw new Error` | **1** | **3** — F7: no-untyped-throws; F8: typed, names-role |
| `session_search` `timeoutMs` dropped | **1** | **1** — F5: declared deadline |
| exit 2 re-documented as a hard failure | **1** | **1** — F3: partial classification |
| F9: `&& result.partial === true` dropped from the survival predicate | **1** | **2** — F9: claim-required, both-ANDed |
| F9: `!callerCancelled(exec)` dropped from the survival predicate | **1** | **2** — F9: caller-required, both-ANDed |
| F5: policy replaced EVERY outcome with `toolTimeoutResult` in the **built lib** | **1** | **2** — F5: returns-claimed-pages, is-labelled |
| F5: policy fell back to guessing from non-empty text | **1** | **1** — F5: unclaimed-is-a-hard-timeout |
| F7: `readonly code?: string` removed from the TS declaration | **1** | **1** — F7: TS-declares-code |
| F7: `code: result.error.info.code` dropped from the PTC bridge | **1** | **1** — F7: bridge-forwards-code |

Each of the F5/F7/F9 reverts above was performed against the **source**, the lib
rebuilt, the suite run, and the source restored — except the two F5 guards that
execute the built lib, where a source-only revert correctly fails **F0 stale-lib**
instead. Both behaviours are asserted: the staleness guard refuses to let a
behavioural guard pass vacuously.

**Observed exit codes, stated explicitly:**

* a fully passing run prints `82/82 guards passed` and exits **0**;
* every mutated run above printed its FAIL lines, a `FAILED GUARDS:` summary
  naming each one, and exited **1**;
* restoring the fix and rebuilding returns the suite to exit **0**.

The failing runs also confirm the crash fix: the process reaches the summary
and exits cleanly even while a harness function is throwing. Before the
per-call `attempt()` wrapper, that same mutation aborted the program with a
stack trace and no summary at all.

A guard that could not fail would have been replaced. That standard is the whole
point of this suite: prose in a doc cannot stop a regression, but a red line in
`verify.sh` can.

---

## Reproducing

```bash
node tests/integration/session-regressions.mjs     # 82 guards, exit 0/1
scripts/verify.sh                                  # step 4b runs the same suite
```

Environment overrides, so the guards are not welded to one machine:
`DSH_CHECKOUT` (harness checkout, default `../deepseek-harness`) and
`WORKSPACE_DIR` (the F4 workspace). When either is missing the F0/F4 guards
report **FAIL with the reason** rather than silently skipping — a guard that
cannot run must never look green.
