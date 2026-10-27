# 06 — Test Matrix

Every row states **how** it was verified and points at the artifact. Statuses:

| Status | Meaning |
|---|---|
| **PASS** | a command ran and its exit code / parsed output proves it |
| **FAIL** | a command ran and the property does not hold |
| **BLOCKED** | could not be executed on this host, with the concrete reason |
| **NOT_TESTED** | not attempted |
| **NOT_APPLICABLE** | the runtime has no such mechanism |

Kinds: `unit` = deterministic in-process, `integration` = boots a real composition,
`live` = real model through the real Host, `e2e` = the mode's own acceptance cases.

## Suite inventory

| Suite | Command | Kind |
|---|---|---|
| Preset derivation | `node tests/preset/verify-preset.mjs` | unit |
| Composition | `node tests/integration/composition-suite.mjs` | integration |
| MCP bridge scope + cost | `node tests/mcp/tool-scope.mjs` | integration |
| Permissions | `node tests/permissions/permission-suite.mjs` | integration |
| clangd CDB parsing | `node tests/clangd/cdb-parse-audit.mjs <cdb> <root> <file>` | integration |
| Web smoke (P10.10) | `node tests/e2e/web-smoke.mjs` | integration |
| Headless smoke (P10.9) | `node tests/e2e/headless-smoke.mjs` | integration |
| Preset probe | `node tests/diagnostics/preset-probe.mjs …` | integration |
| Case A/B/C | `node tests/e2e/web-session.mjs …` | e2e (live model) |
| Case B verifier | `node tests/e2e/case-b-verify.mjs …` | e2e (independent) |
| Read-only proof | `node tests/e2e/case-a-readonly.mjs …` | e2e (independent) |
| Metrics | `node tests/e2e/session-metrics.mjs …` | analysis |

Results are written to `evidence/tests/` and `evidence/e2e/`.

The `MCP bridge scope + cost` suite boots the real profile six times (one child
process per preset, because a single long-lived boot cannot survive that many
probes — see `docs/10-mcp-wiring.md`), asserts tool visibility per preset, and
records process count, startup latency and RSS. `--presets a,b` narrows it;
`--stub` uses a deterministic stand-in server.

## F1 — Custom Mode

| # | Requirement | Status | Evidence |
|---|---|---|---|
| F1.1 | `ai-compiler` is registered | **PASS** | `plugin_manager install_bundle` → `application: applied`; `cordis_inspect_query Config.listConfigs name=@deepseek-ai/dsh-agent-preset` lists `include:preset-ai-compiler`; `dump-config` shows `[preset-ai-compiler]` |
| F1.2 | selectable and creates a Session | **PASS** | `session/create {agentPreset:'ai-compiler'}` returns `agentPreset: "ai-compiler"`; header of every case session records it |
| F1.3 | does not override shipped PTC | **PASS** | `verify-preset.mjs` verdict PASS, `rows {baseline:33, delivered:33}`, diffs = persona + pruner only |
| F1.4 | old/new revision behaviour | **PASS** | case C run-02 resumed the same session id after the preset's delegation rows changed; the session kept running and its `agentPreset` stayed `ai-compiler`. A *removed* preset makes a cold resume fail with `agent-preset/not-found` (source: `agent-preset-registry/src/index.ts:232-248`) — see Q14 below |
| F1.5 | install/uninstall repeatable | **PASS** | `scripts/install.sh` then `scripts/uninstall.sh` then `scripts/install.sh`; profile `cordis.patch.yml` byte-identical to the backup throughout (see F6.4) |

## F2 — PTC

| # | Requirement | Status | Evidence |
|---|---|---|---|
| F2.1 | `run_code` really runs | **PASS** | case A: 10–23 `run_code` calls per run, `tool/result` carries the program's return value (e.g. `[42,7,13]`); `evidence/e2e/case-a/run-01/session-evidence.json` |
| F2.2 | wire tool list is `[run_code]` only | **PASS** | composition suite: `ai-compiler wire view is exactly [run_code]` |
| F2.3 | SDK matches the agent's visible tools | **PASS** | suite: 46/46 checks — every bound tool name is declared, `run_code` never bound recursively |
| F2.4 | file / search / bash callable through PTC | **PASS** | case A ptc dispatches: `glob, grep, read, lsp, bash`; case B: `bash, read, edit, working_directory` |
| F2.5 | nested calls keep permissions | **PASS** | suite (`tools/pre-execute` + approval path shared); permission suite proves the fence denies outside-root writes |
| F2.6 | intermediate results filterable | **PASS** | case A program read 6 files and returned one 170-char JSON; case C returned 3 lines out of 20 000 |
| F2.7 | timeout / cancel behaviour | **PASS** | case C: `wait_agent` 30 s times out with `timedOut: true` while the PTC program keeps running; a PTC run aborts its sub-dispatches (source `ptc.ts:728-734`) |
| F2.8 | large output bounded | **PASS** | case C: 64 000-char captured stdout + a 108 894-byte subprocess log; the model saw only the curated object |
| F2.9 | audit trail | **PASS** | `tool/ptc-dispatch-start` / `tool/ptc-dispatch` pairs present for every nested call |
| F2.10 | gate tools reachable through `run_code` | **PASS** | `tests/mcp/tool-scope.mjs`: both compiler presets bind all ten `mcp__agentgates__*` names in the PTC SDK section; `standard/ptc/minimal/cordis` bind none |

## F3 — Agent Teams

| # | Requirement | Status | Evidence |
|---|---|---|---|
| F3.1 | ≥2 teammates | **PASS** | case A: `explorer` + `reviewer`; `team/member` × 4 (2 members × provisioning/active) |
| F3.2 | messages + task board | **PASS** | case A `send_message` 1, `team_task_create` 2, `team_task_update` claim/complete; case B/C same |
| F3.3 | Fresh verified | **PASS** | every case teammate used `context: 'fresh'` and reported back; `team/member` edges = 2 per teammate |
| F3.3b | Fork verified | **PASS (mechanism) — with a measured caveat** | the model *did* pass `context: "fork"` (program verified) yet both children came back `isSeeded:false, inherited:0`. Cause found in source: the fork provider seeds only the Lead's **completed** turns (`subagent-fork-in-process/src/index.ts:46-53`). Deterministic proof: with **0** completed Lead turns → `isSeeded:false, inherited:0`; after **1** completed turn → **`isSeeded:true, inherited:10`**. So fork works, but a fork requested before the Lead finishes a turn is silently unseeded — recorded in `docs/08-compatibility.md` |
| F3.4 | teammate preset binding | **PASS** | source `child-agent.ts:142` + `composeFrom()`; measured: teammates ran `run_code`/`grep`/`read` and Team tools under the same mode |
| F3.5 | PTC + Team joint | **PASS** | case A ptc dispatches include `spawn_teammate`, `send_message`, `team_task_*`, `wait_agent`, `interrupt_agent` |
| F3.6 | recovery | **PASS** | case C: `interrupt_agent` → `previousStatus: running` → `inactive` → `send_message` → resumed and finished |

## F4 — Context

| # | Requirement | Status | Evidence |
|---|---|---|---|
| F4.1 | spill saves and restores a large result | **PARTIAL** | the *bash* tool's own subprocess capture truncates to 64 000 chars and spills the full text to `/tmp/dsh-subprocess-*/…-stdout.log` (verified: file has all 20 000 lines, model saw 10 800). The **spill-policy** layer (`maxInlineTokens: 12500`) did **not** fire on the observed results: `write`/`read`/`grep` results stayed below it, so no `(Omitted … stored at: …)` notice was produced. Measured, not assumed — see `docs/07-benchmarks.md` |
| F4.2 | completeness of the artifact | **PASS** | `wc -l /tmp/dsh-subprocess-…-stdout.log` = 20 000; `big.txt` written = 64 108 bytes = source size |
| F4.3 | spill path + permissions | **PASS** | `<root>/session-<sha256(id)[:12]>/<rand>-<name>.txt`, dir `0700`, file `0600` (measured) |
| F4.4 | read-back | **PASS** | `tools.read` on the artifact path returned `totalLines: 20000` in 2000-line pages; `limit: 20000` is rejected (`limit must be less than or equal to 2000`) |
| F4.5 | compaction triggers | **NOT_TESTED** | no compaction occurred in any run: the routed model's context window is 1 048 576 tokens and the longest case used ~11 k `pressureTokens`, far below `thresholdRatio 0.8`. A compaction run needs a small-context model or an explicitly forced `/compact` |
| F4.6 | session-recovery of evidence | **PASS** | case C run-02: the agent re-read the spill artifact and the task board after restart and re-stated all five facts |
| F4.7 | pruner does not double-process | **NOT_TESTED** | the pruner only runs inside compaction, which never qualified here |
| F4.8 | per-agent context isolation | **PASS** | each teammate is a separate Session with its own log and its own PTC child process |

## F5 — Engineering tools

| # | Requirement | Status | Evidence |
|---|---|---|---|
| F5.1 | native grep/glob | **PASS** | case A/B/C ptc dispatches; case C: `grep` returned 6000 matches for `symbol_b_` |
| F5.2 | LSP locates a real C++ symbol | **PASS** | case A: `lsp goToDefinition` at `FuseReductionIntoLoop.cpp:169` and `DeadFunctionElimination.cpp:51`; `clangd` parsed the 4 913-entry `compile_commands.json` (0 errors) |
| F5.3 | build + test through bash/jobs | **PASS** | case B: `./run-tests.sh` compiled with clang++ and ran the tests; exit 3 on the bugged copy, 0 after the fix |
| F5.4 | edit → review → test loop | **PASS** | case B: single-line fix, analyst + validator teammates, Lead's final diff; independent verifier 9/9 |

## F6 — Safety and regressions

| # | Requirement | Status | Evidence |
|---|---|---|---|
| F6.1 | permission positive/negative | **PASS** | `permission-suite.mjs` 4/4: in-root write allowed, out-of-root denied (`FS_SANDBOX_DENIED`), `read-only` denies, `danger-full-access` allows |
| F6.2 | OS sandbox availability recorded | **BLOCKED (host)** | `SandboxUnavailableError` for `read-only` and `workspace-write`: `bwrap` cannot create a user namespace (Ubuntu AppArmor) and `bin/landlock-run` is not in the build output |
| F6.3 | Standard/Creator/PTC unbroken | **PASS** | composition suite: `shipped presets still present`; `ptc wire view is exactly [run_code]`; `standard` still exposes its native list |
| F6.4 | model config untouched | **PASS** | profile `cordis.patch.yml` byte-identical to `evidence/backup/profile-web-orig/cordis.patch.yml` |
| F6.5 | compiler repos untouched | **PASS** | `case-a-readonly.mjs`: AscendNPU-IR `HEAD bfefe180…`, `git status` clean before and after every live run |
| F6.6 | uninstall/rollback | **PASS** | `scripts/uninstall.sh` → bundle deselected + removed, preset row gone from `dump-config`; `scripts/rollback.sh` → profile files restored from the backup |

## F7 — Delivery

| # | Requirement | Status | Evidence |
|---|---|---|---|
| F7.1 | real E2E | **PASS** | `evidence/e2e/case-{a,b,c}/run-*/web-run.json` with session ids and transcripts |
| F7.2 | automated tests | **PASS** | 4 deterministic suites, 46 + 4 + 9 checks + the preset diff |
| F7.3 | architecture docs | **PASS** | `docs/01`–`docs/09` |
| F7.4 | version + dependency lock | **PASS** | `evidence/env/versions.json` |
| F7.5 | install/rollback docs | **PASS** | `docs/04-installation.md`, `docs/09-operations.md` |
| F7.6 | commits | **PASS** | this repository's history |
| F7.7 | machine evidence | **PASS** | `evidence/` |

## Q-matrix (Part B) outcome summary

| ID | Result |
|---|---|
| Q01 Creator path | PASS — bundle patch + `install_bundle`, no Web editor needed |
| Q02 PTC derivation | PASS — 33/33 rows, 2 declared diffs; **plus the LSP host-plane correction (Q02b)** |
| Q03 PTC scope | PASS — host runtime, per-agent bindings |
| Q04 Team tools in PTC SDK | PASS — 35 bindings incl. 9 Team tools **after the server restart** |
| Q05 child preset | PASS — inherits the Lead's revision (`composeFrom`) |
| Q06 fresh vs fork | fresh PASS; fork PASS with the seeding-boundary caveat above |
| Q07 permission propagation | PASS — approval pinned to `never`; sandbox override inherited |
| Q08 PTC bypasses guard? | PASS — no: same scheduler path |
| Q09 spill across members | PASS — shared, unauthenticated by design (user-level) |
| Q10 compaction vs team messages | NOT_TESTED — no compaction occurred |
| Q11 team restart recovery | PASS — case C run-02 |
| Q12 PTC timeout vs `wait_agent` | PASS — bounded waits, no deadlock |
| Q13 FFF | PASS (evaluated, not adopted) |
| Q14 preset updates vs old sessions | PASS (live) / documented for cold resume |
| Q15 uninstall rollback | PASS |
| Q16 shared-dir races | PASS as designed (single writer) |
| Q17 headless vs Web | PASS (documented divergence) |
| Q18 duplicate registration | **FAIL→FIXED** — duplicate delegation surface removed |
