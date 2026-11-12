# 15 — Postmortem: "unknown tool: run_code" during task-13 validation

**Subject:** in session **633b5373** (the ai-compiler preset fix), the final
report said *"validator 两次遇到工具调用故障（报 unknown tool: run_code）"* —
the validator(s) allegedly could not call tools, so the Lead "verified everything myself".

**Evidence:** child sessions of `session-633b5373` —
`5cbb3b24…` (first validator), `16ebc401…` (second validator) — plus the
parent log around seq 6585–6668. Every claim below carries seq numbers.

**Guard:** `tests/integration/tool-call-failure-guard.mjs` ([F11]).
**Safe demo:** `scripts/lib/last-row-wins-demo.sh`.

---

## The one-sentence thesis

> There were **two unrelated events**, and the report merged them into one:
> (1) the first validator was a **model that confabulated** the error and never
> called a tool at all; (2) the real tool failures happened because a validator
> **edited the live, HMR-watched profile mid-run**, which recomposed the running
> profile and tore the Team tool plane out from under in-flight programs.

Neither event is "the harness could not expose `run_code`". In both cases
`run_code` was offered and other agents used it fine.

---

## Event 1 — validator #1 never made a tool call (5cbb3b24)

Turn 2 (the validator was resumed after a **12h** gap — a Host restart; seq 193
`session/end-seed` at 2026-11-12T02:05:48):

- seq 198 `system/message` — the freshly assembled validator system prompt, ending
  with the standard PTC instruction: *"`run_code` is the only tool you can call directly."*
- seq 201 `request/header` — the tools array handed to the model contains **exactly
  `run_code`**. The tool WAS offered.
- seq 202 `assistant/message` — the model replies with **text only**
  (`stopReason: "stop"`), claiming *"Every attempt to invoke a tool … results in an
  `unknown tool` validation error."* **There is no `tool/call` event anywhere in
  this turn.** The model never attempted a call.
- seq 210 the Lead's "correction" repeats the error phrase and the
  `bash(...)`-vs-`tools.bash(...)` story; seq 211 `request/header` again offers
  `run_code`; seq 212 the model again replies text-only: *"The system still reports
  an `unknown tool: run_code` error …"*.

**Conclusion.** The `group/validator` route produced a text-only refusal and
**confabulated** an `unknown tool` it never observed. It was primed: the Lead's
own messages (seq 199, seq 210) repeated the phrase and described the error. The
harness was healthy — the identical `run_code` tool in the request header is
the proof.

## Event 2 — the real failure: a live-profile edit triggers HMR recomposition

Validator #2 (16ebc401) **did work**: ~10 successful `run_code` calls (claim
seq 17→23, reads seq 26→38, …). It broke only at seq 116/117, where its program:

1. **wrote `~/.dsh/profiles/web/package.json`**, appending
   `\@deepseek-ai/dsh-experimental-agent-team-profile` to `dsh.profile.bundles`
   (the task-13 "toggle the bundle" instruction), then
2. ran `bash scripts/verify.sh --quick` / `install.sh` and restored the backup.

The instant that manifest write landed (~02:11:54), the Host's HMR **watching that
file** fired. In `packages/boot/hmr/src/index.ts`:

- `Hmr` registers `watchConfig(join(profile.dir,'package.json'), () => refresh(true))`,
  and `refresh(manifestOnly)` returns early only when **bundles are unchanged**
  (`manifestOnly && bundles === lastBundles`). A **bundle-list change** passes
  through to `reconcileProfile()` -> `recomposeProfile()`, which **stops and
  restarts** the plugin entries whose composition changed — the `agent-team`
  row, and with it `tool-agent-team`.

Consequences observed **~3 s later**:

- Validator #2's own program: seq 122 **`code run failed (abort): [object Object]`**
  — the PTC dispatch was torn down mid-flight.
- The **Lead's** concurrent program (parent seq 6638: `wait_agent(118000)` then
  `tools.team_task_list({})`): the wait returned, then seq 6643
  `Error: code run failed (exception): ToolCallError: unknown tool "team_task_list"`.
  That message is emitted by `packages/core/tools/src/index.ts:535` when a name is
  **absent from the caller's scoped tool registry** — i.e. `tool-agent-team`'s
  per-agent registration had just been disposed by the recomposition.
- Parent seq 6656: *"Background subagent 16ebc401 was stopped before it finished"* —
  the validator session was then interrupted as the Lead gave up.

So the genuine "unknown tool" / "abort" failures are a **live-recomposition
race**: editing the live profile's bundle list while agents run restarts the Team
tool plane under them.

---

## Why this was avoidable

`scripts/verify.sh` step 1f reads the **live** profile (`--profile web`). To see
it *fail* you must put the duplicate bundle back — and the task told validators to
do that on the live profile. That edit is exactly what HMR watches.

The correct proof runs on a **throwaway copy** and never writes the live file:
`scripts/lib/last-row-wins-demo.sh` copies `~/.dsh/profiles/web` to
`ai-compiler-lastrow-demo`, appends the shadow bundle **to the copy**, shows
`rows=2, presetRoles absent` (broken) then `rows=1, presetRoles present`
(fixed), and deletes the copy. The live `package.json` is opened read-only.

Range of the fix:

1. `scripts/lib/last-row-wins-demo.sh` — non-destructive FAIL→PASS demo.
2. `tests/integration/tool-call-failure-guard.mjs` ([F11], wired into
   `scripts/verify.sh`) — pins that the safe path exists and that the documented
   HMR mechanism is still real.
3. `docs/09-operations.md` failure playbook — two new rows (live-profile edit;
   confabulated `unknown tool: run_code`).

## Operational rules

- **Never** edit `~/.dsh/profiles/web/package.json` (or its `cordis.patch.yml`)
  while the Host is running. Use `scripts/lib/last-row-wins-demo.sh`.
- If a validator says `unknown tool: run_code`, **check the event log for a
  `tool/call` first**. No `tool/call` = the model never tried; it is a route
  problem, not a harness one. Re-task on a fresh member and do not repeat the
  error phrase in the prompt.
- A `run_code` abort that coincides with a profile edit is a recomposition, not a
  broken tool.

## Update — both residual items implemented in the harness

As a follow-up in this session both were fixed in `deepseek-harness` (dev):

1. `ptc-runtime` `messageOf` now renders a non-Error abort reason as `name: message` / JSON instead of `[object Object]` (`packages/ptc-runtime/ptc-runtime-node/src/index.ts`), pinned by a case in `host-failures.spec.ts`.
2. HMR defers a bundle-list recomposition while agent turns are running, logs `restart required`, and retries when the roster idles (`packages/boot/hmr/src/defer.ts` + `refresh()` in `src/index.ts`), pinned by `tests/defer.spec.ts`.

These are source changes: they take effect after `pnpm run build:lib:host` and a Host restart.

## Residual (smaller) defects worth a follow-up

- `code run failed (abort): [object Object]` — the abort path stringifies a
  non-Error reason, losing the message. Cosmetic, but it hides the real cause in
  exactly this situation.
- HMR happily recomposes the profile (restarting `agent-team`) while PTC programs
  are mid-flight. Production hardening: **defer a manifest-triggered recomposition
  until no agent turn is active**, or reject it with an actionable "restart
  required" instead of aborting live work.
