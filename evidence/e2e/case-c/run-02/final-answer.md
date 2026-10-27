All facts recovered and cross-verified across three independent sources. Here is the report.

## Recovery sources

I recovered each of the five facts without taking it from the resume message. Every fact was found in at least two independent records, and I re-measured each one live:

| # | Fact | Primary source | Independent cross-check |
|---|---|---|---|
| 1 | `big-src-a.cpp` = **6000 lines** | `task-1` (`collect-evidence`) description on the shared board | `wc -l` live → `6000` |
| 2 | `big-src-b.cpp` = **6000 lines** | `task-1` description | `wc -l` live → `6000` |
| 3 | `big-src-c.cpp` = **6000 lines** (18000 total) | `task-1` description | `wc -l` live → `6000`, `18000 total` |
| 4 | Long output (`seq 1 20000`) = **20000 lines** | **Spill artifact**: `/tmp/dsh-subprocess-6UgEiH/dsh-subprocess-472079-1-8847c159734e-stdout.log` | `wc -l` → `20000`; `tools.read` → `totalLines: 20000` spanning `1:1` … `20000:20000` |
| 5 | `./failing-test.sh` = **exit code 3** | `task-1` description | re-ran it live → `exit=3` |

Specifically:

- **Facts 1–3, 5** — persisted in the `collect-evidence` task's description on the shared task board (`task-1`, revision 3, status `completed`, owner `lead`, no blockers). That description reads verbatim: *"…wc -l counts for big-src-a/b/c.cpp (6000/6000/6000 = 18000 total), the long-stdout total line count from `seq 1 20000` (20000, spilled to /tmp/dsh-subprocess-…-stdout.log) … and ./failing-test.sh exit code 3 with stderr 'FAIL check-2: expected 42, got 41'."* Writing the facts into the board during Phase 4 is what made them survive both restarts.
- **Fact 4** — read directly from the spill artifact on disk, which is the authoritative source because the captured stdout was truncated (10,800 of 20,000 lines, with the *head* dropped — captured text began at `201`/`9202`). The artifact is unchanged: 108,894 bytes, still spanning lines 1 through 20000 exactly.
- **Supporting fact** — the stderr line `FAIL check-2: expected 42, got 41`, recovered from `task-1` and reproduced by re-running the script.

**Integrity holds.** All four evidence files are present, and their sizes and mtimes are byte-identical to the original run at `2026-10-27 14:11:32 +0800` (273786 / 273786 / 273786 / 204 bytes) — nothing was rewritten or deleted. The rota also survived: `slowpoke` is still registered with its original `fresh` context, currently `inactive`.

## Restart

The five Phase-2 durable facts, re-stated exactly as originally recorded:

1. `big-src-a.cpp` — **6000 lines**
2. `big-src-b.cpp` — **6000 lines**
3. `big-src-c.cpp` — **6000 lines** (18000 total across the three)
4. Long output (`seq 1 20000`) — **20000 lines**
5. `./failing-test.sh` — **exit code 3**
   - stderr, verbatim: `FAIL check-2: expected 42, got 41`

Task board after restart, unchanged:

| id | subject | owner | status | revision | blocked_by |
|---|---|---|---|---|---|
| `task-1` | collect-evidence | `lead` | `completed` | 3 | — |
| `task-2` | verify-evidence | `lead` | `completed` | 3 | `["task-1"]` |

## Did the earlier report survive?

**Yes.** My first-turn report is still present in this conversation in full — including the `## Spill` section with the quoted omission notice and the artifact path, `## Interruption` with the `previousStatus: "running"` → `inactive` transition and the verbatim `wait_agent` no-active-peer payload, `## Failing test` with exit code 3 and the stderr line, `## Task board`, `## Durable facts`, and `## PTC notes` (15 `run_code` calls, 34 nested tool calls). No compaction or summary block replaced it, and every fact in it agrees with what I just independently re-derived.

Two honest caveats carried forward from the original run, unchanged: (a) the `tools.grep` failure on the workspace root (`rg: ./big-src-b.cpp: Resource temporarily unavailable (os error 11)`) was worked around by passing the file path directly, which returned the 6000 matches; (b) my Phase 1 retry loop re-issued an identical failing call, which the runtime flagged — I switched approach rather than repeating it again.