# 07 — Benchmarks

Three measurements, each with its provenance stated. Nothing here is estimated; inputs the runtime
does not expose are reported as **NOT_AVAILABLE**.

## §Baseline — what "baseline" actually means in rc.3

The comparison is a **functional-increment experiment**, not "these are off by default":

| Component | Official PTC preset (`ptc`) | `ai-compiler` |
|---|---|---|
| PTC (`run_code`, per-call) | on | on (same rows) |
| Spill (`spill-local` + `spill-policy` 12500 tok) | **on — Host plane, already active** | on (unchanged) |
| Token meter / usage projections | on (Host) | on (unchanged) |
| Compaction backend + `/compact` | on (preset) | on (unchanged config) |
| Tool-result pruner | on, `8192/4096/1024` | on, **`20480/12288/4096`** |
| Agent Teams | **not mounted** | **mounted** (3 Host rows) |
| `lsp` tool | **not mounted** | **mounted** (Host) |
| Direct delegation (`subagent*`) | on | **off** (Team owns delegation) |

So "Enhanced A = PTC + spill/compaction" is *already the baseline* for the context half; the
measurable increments of this delivery are **Teams**, **LSP**, and the **pruner budget**.

## §A/B — same task, same model, same workspace

`tests/bench/ab-benchmark.mjs`, task `tests/bench/task-source-investigation.md`, workspace
`/home/s00653124/workspace/AscendNPU-IR-1`, model `magpie/auto/deepseek-v4.1-flash`, 2 repeats each.

| preset | run | status | steps | tool/call | ptc sub-calls | input tok | output tok | cache-read tok | elapsed |
|---|---|---|---|---|---|---|---|---|---|
| `ptc` | 1 | PASS | 5 | 4 | 4 | 14 874 | 1 049 | 58 752 | 30 185 ms |
| `ptc` | 2 | PASS | 4 | 3 | 4 | 1 279 | 827 | 57 088 | 27 172 ms |
| `ai-compiler` | 1 | PASS | 4 | 3 | 4 | 3 017 | 722 | 55 168 | 27 166 ms |
| `ai-compiler` | 2 | PASS | 5 | 4 | 7 | 5 112 | 1 000 | 69 760 | 30 183 ms |

**Correctness: 4/4 identical answers** (`transformFiles: 13, passClasses: 5, chosen:
DebugLLVM.cpp:942`, same LSP result) from both presets — the mode adds capability without changing
the answer on this task.

**Verdict:** the two presets are statistically indistinguishable on this task (elapsed 27–30 s in
all four runs; token spread is dominated by prompt caching, not by the preset). That is the honest
result: for a *single-agent source lookup*, Teams and LSP are not used, so no gain is expected.
The value of the mode is in the cases below, where the task needs them.

Provenance: tokens = `tokenUsage` projection (provider-reported, disjoint buckets); steps/timings =
`sessionStats`; tool calls and PTC sub-calls = counts of `tool/call` and `tool/ptc-dispatch` events
in the durable log. `evidence/benchmarks/ab/summary.json`.

## §Case-level measurements (live, real tasks)

Source: `evidence/e2e/<case>/run-*/{web-run.json,session-evidence.json}`.

| case | what it proves | steps | tool/call | PTC sub-calls | team member edges | team task edges |
|---|---|---|---|---|---|---|
| A run-01 | read-only investigation + Teams + LSP | 17 | 15 | 29 | 4 | 6 |
| B run-01 | defect repair + independent validation | 13 | 12 | 32 | 4 | 9 |
| C run-01 | long session, spill, failing test, interrupt | 19 | 18 | 36 | 2 | 6 |
| C run-02 | restart recovery, same session id | 27 | 24 | 47 | 2 | 6 |

`team/member` edges = 2 per teammate (provisioning + active); `team/task` edges = one per revision
(create → claim → complete = 3 per task).

## §Spill and context — what was measured, not assumed

Probes recorded in `evidence/context/spill-probes.json`:

1. **23 500-line bash output.** The **bash layer** truncates its own capture to 64 000 chars
   (10 800 of 20 000 lines) and spills the complete text to
   `/tmp/dsh-subprocess-*/…-stdout.log` (108 894 bytes, all 20 000 lines verified). The model saw
   the truncated capture plus the spill path.
2. **`spill-policy` did not fire** on any observed result. Its budget is 12 500 *estimated tokens*
   per tool result; `write`/`read`/`grep` results in these runs stayed below it, so no
   `(Omitted … stored at: …)` notice was produced. This is a measurement, **not** a defect claim:
   the policy is content-driven.
3. **`read` returns a 2 000-line window.** A program reading a 64 108-byte artifact received
   11 199 bytes (2 000 lines) and the object `{path, offset, lines, totalLines}`; `limit: 20000`
   is rejected (`limit must be less than or equal to 2000`). The rest is reachable by paging or
   with `bash`.

**Verdict on the pruner budget change (8192 → 20480):** it could not be shown to matter in these
runs, because the pruner only executes inside compaction and **no compaction occurred** (the routed
model's window is 1 048 576 tokens; the longest case used ~11 k pressure tokens against a
`thresholdRatio` of 0.8). The change is therefore kept as a *reasoned* tuning for compiler evidence
(long build logs, IR dumps), explicitly **not** as a measured win. Reverting it is a one-line edit.

## §Not available (stated rather than faked)

| Metric | Why |
|---|---|
| Spill trigger count / bytes across runs | RC.3 exposes no spill counter; only files on disk (which the age sweep deletes) |
| CPU / peak RSS per session | no per-session resource metric |
| Compaction effectiveness | no compaction qualified; needs a small-context model or a forced `/compact` |
| FFF comparison | no installable rc.3 packaging — see `docs/08-compatibility.md` |
