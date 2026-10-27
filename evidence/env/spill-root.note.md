# Spill root observation (RC.3)

DSH keeps **no spill counter** (`docs/02-source-audit.md` Q-P5): the only observable facts are
the files on disk. `dsh-spill-local` defaults its root to a **per-process** `mkdtemp` under the
OS temp dir, so the directory changes on every DSH restart and the age sweep (`cleanupPeriodDays`,
default 30) is the only cleanup.

`tests/e2e/session-metrics.mjs` therefore finds artifacts by the documented directory shape
(`<root>/session-<sha256(sessionId)[0:12]>/`) across every `dsh-spill-*` root in `$TMPDIR`.
Artifacts created by the currently running Host are listed below.
