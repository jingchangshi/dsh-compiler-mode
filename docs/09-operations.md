# 09 — Operations

## Daily use

1. Open the Web GUI, start a new chat, pick **AI Compiler Engineering** in the preset chip.
2. The model only sees `run_code`; it reaches every other tool from inside a program.
3. Team work: the Lead spawns teammates with `spawn_teammate`, coordinates with `send_message`,
   the shared task board, and `wait_agent`.
4. Source navigation: `tools.lsp` with `goToDefinition` / `findReferences` / `hover` works on any
   C/C++ file under the session's working directory (clangd picks up the nearest
   `compile_commands.json`).

## After any configuration change

**Restart the Host.** A running Host keeps its start-up composition; new or removed rows only
appear after a restart. Symptom of a stale Host: `--dump-config` lists a row the model cannot call.

## Health checks

```bash
node tests/preset/verify-preset.mjs        # declaration still equals PTC + declared diffs
node tests/integration/composition-suite.mjs   # 47 deterministic checks
node tests/permissions/permission-suite.mjs    # 4 allow/deny checks
scripts/verify.sh                          # all of the above + profile untouched
```

## Reading the evidence

| Question | Where |
|---|---|
| Did a run really happen? | `evidence/e2e/<case>/run-*/web-run.json` (status, session id, transcript) |
| What did the model actually call? | `session-evidence.json` → `toolCalls`, `ptcDispatches`, `counts` |
| What did the model see? | `final-answer.md` and the transcript in `web-run.json` |
| Token/tool accounting | `evidence/benchmarks/*/summary.json` |
| Why was a design chosen? | `docs/03-decisions.md` (ADR) |

## Cost and limits

- Each `run_code` is a **fresh Node process** under the session's sandbox policy; long programs
  cost process start-up time and are bounded by `timeoutMs` (default 120 s, cap 600 s).
- A `wait_agent` inside `run_code` consumes the *program's* budget: use bounded waits
  (`timeout_ms` 10 000…3 600 000) and re-list instead of waiting inside one program for minutes.
- Spill artifacts live under a **per-process** temp root (`/tmp/dsh-spill-*`), so they do not
  survive a Host restart and are reclaimed only by the age sweep (`cleanupPeriodDays`, default 30).
  Copy anything you must keep.

## Failure playbook

| Symptom | Cause | Action |
|---|---|---|
| the preset chip does not list the mode | Host started before the bundle was installed | restart the Host |
| `agent-preset/not-found` on an old session | the preset was uninstalled | reinstall, or start a new session |
| `agent-preset/invalid: … never started` | a preset row names a package that is not an `apply()` plugin (e.g. a bare `Service` class) | move that row to the Host plane |
| `spawn_teammate` is `undefined` in `run_code` | stale Host (Team rows missing) or the Team bundle not selected | restart; check `--dump-config` for `tool-agent-team` |
| `SandboxUnavailableError` for `workspace-write` | no usable OS sandbox on this host | see `docs/05-permissions.md`; the mode does not weaken this |
| `FS_STALE_VERSION` on `write`/`edit` | another writer touched the file | re-read, rebase, retry (Lead is the only writer) |
