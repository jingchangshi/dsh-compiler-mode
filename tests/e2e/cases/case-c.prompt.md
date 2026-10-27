You are an `ai-compiler` agent running Case C: a long, evidence-heavy session that must
survive context pressure, a failing test, a teammate interruption, and a session restart.

You are in PTC mode: `run_code` is the ONLY tool you can call directly. Everything else —
`bash`, `read`, `grep`, `glob`, `job_output`, and every Team tool — is called from inside a
`run_code` program as `await tools.<name>({...})`.

Workspace: the session's working directory. Work only inside it.

PHASE 1 — generate genuine context pressure (do all of these, in separate `run_code` calls):
  a. `tools.bash`: `wc -l big-src-a.cpp big-src-b.cpp big-src-c.cpp` — report the three counts.
  b. `tools.bash`: print a LONG stdout (e.g. `seq 1 20000`) — then in the SAME program return
     only the last 3 lines and the total line count, so the bulk must not enter the model
     context. Quote any "(Omitted … bytes … stored at: …)" notice you receive and the path.
  c. `tools.grep` for `symbol_b_` across the workspace; it matches 6000 lines. Keep only the
     count and 3 sample paths.
  d. `tools.bash`: `./failing-test.sh` — report its exit code and its stderr line verbatim.

PHASE 2 — durable facts. Record these and repeat them in §Restart after you are resumed:
  - the three `wc -l` counts,
  - the long-output total line count,
  - the `./failing-test.sh` exit code.

PHASE 3 — teammate interruption:
  Spawn `slowpoke` (`context: 'fresh'`) with a prompt that makes it run several long
  `run_code` programs. Then, while it is running:
  - `tools.list_agents` → record its status,
  - `tools.interrupt_agent({target:'slowpoke'})` → record `previousStatus`,
  - `tools.list_agents` again → record its status,
  - `tools.wait_agent({timeout_ms: 30000})` → record what it returns.
  Then `tools.send_message` a short follow-up to `slowpoke` and `tools.wait_agent` once more.

PHASE 4 — shared task board with a dependency:
  `tools.team_task_create` "collect-evidence", then "verify-evidence" with
  `blocked_by: [<first id>]`, then claim/complete both with `tools.team_task_update`
  using the current `revision`.

PHASE 5 — when §Restart is requested by the user's next message, re-state the Phase 2 facts
  exactly and quote where you recovered them from (artifact path, task board, or your own
  report).

Final answer (first turn): Markdown with exactly these sections.

## Spill
The long output's total line count, the omission notice you received (quoted), the artifact
path, and whether `tools.read` on that path returned the full text.

## Compaction
Whether the conversation was compacted; quote any summary you saw and the facts you kept.

## Interruption
`slowpoke` status before, `previousStatus`, status after, and `wait_agent`'s return value.

## Failing test
The command, its exit code, and the stderr line verbatim.

## Task board
Every task: id, subject, owner, status, revision.

## Durable facts
The five facts from Phase 2.

## PTC notes
`run_code` call count, nested tool call count (count them), and every failure.

## Restart
Write `PENDING — awaiting restart` here; the user will resume this session and ask for the
re-statement.

Rules
- Never delete `big-src-*.cpp`, `failing-test.sh`, or anything you created as evidence.
- Report failures truthfully; a teammate that fails is reported as failed.
- Finish with the Markdown report only.
