## Root cause

`Counter::mergeFrom` folds the source counter's total into `*this` but never clears the source, violating the documented contract in `include/ircount.h:11` ("Folds `other` into this counter and clears `other`."). The restored `src/ircount.cpp:8` is the missing `other.reset();`.

## Fix

Single-line insertion in one file (`src/ircount.cpp`), no header or test changes.

`src/ircount.cpp:6-8` before:
```cpp
void Counter::mergeFrom(Counter &other) {
  total_ += other.total_;
}
```

`src/ircount.cpp:6-9` after:
```cpp
void Counter::mergeFrom(Counter &other) {
  total_ += other.total_;
  other.reset();
}
```

`diff -u` against the pristine pre-fix copy:
```diff
@@ -5,5 +5,6 @@
 std::size_t Counter::count() const { return total_; }
 void Counter::mergeFrom(Counter &other) {
   total_ += other.total_;
+  other.reset();
 }
 } // namespace ircount
```

## Reproduction before

Command: `./run-tests.sh` — exit code **1**. Output:
```
ok   add accumulates
ok   reset clears
ok   merge adds
FAIL merge clears source: got 2 want 0
```
Failing assertion: `FAIL merge clears source: got 2 want 0` (`tests/test_ircount.cpp:12-16` — after `a.add(5); b.add(2); a.mergeFrom(b);` the source `b` still reported 2).

## Validation after

Command: `./run-tests.sh; echo EXIT=$?` — shell exit code **0**, stderr empty, every line verbatim:
```
ok   add accumulates
ok   reset clears
ok   merge adds
ok   merge clears source
EXIT=0
```
Independently reproduced by `validator` (same 4 lines, `EXIT=0`), which also ran a negative control against the reverted bugged body in `/tmp` and got `FAIL merge clears source: got 2 want 0`, `BUGGED_EXIT=1` — proving the suite is not vacuous. `tests/test_ircount.cpp` sha256 `028b7688…76d1`, mtime at fixture-creation time, unmodified.

## Task board

| id | subject | owner | final status | revision |
|---|---|---|---|---|
| task-1 | analyse: locate cause of mergeFrom not clearing source | analyst | completed | 3 |
| task-2 | fix: make Counter::mergeFrom clear the source counter | lead | completed | 3 |
| task-3 | validate: independently run ./run-tests.sh and report every test line (blocked_by task-2) | validator | completed | 3 |

## Agent roster

| name | context | final status | produced |
|---|---|---|---|
| analyst | fresh | inactive (completed work) | Root cause at `src/ircount.cpp:6-8`; minimal fix `other.reset();` at line 8; corroborating evidence from `src/ircount.cpp.orig` and `patches/defect.patch`; no files edited. |
| validator | fresh | inactive (completed work) | Independent `./run-tests.sh` run: exit 0, all 4 `ok` lines; verified line 8 present; sha256 proof tests untouched; own negative control reproducing `FAIL merge clears source: got 2 want 0`; no workspace edits (scratch work in `/tmp`). |

## PTC notes

- `run_code` calls: **8**.
- Nested tool calls: **26** — working_directory 1, glob 1, read 4, bash 5, team_task_create 3, team_task_get 2, team_task_update 5, team_task_list 3, spawn_teammate 2, wait_agent 3, list_agents 4, edit 1, read_image 0.
- Failures hit: **none blocking**. Non-fatal, factual notes worth flagging:
  - The initial `./run-tests.sh` call returned wrapper `exitCode: 0` while the script itself printed `EXIT=1` — the shell `$?` marker had to be appended to observe the real status. This did not mislead the diagnosis (the `FAIL` line was clear).
  - `validator` flagged that `.lead-backup/` (my scratch pristine copy) and the stale `src/ircount.cpp.orig` were present in the tree. I deleted `.lead-backup/` after taking the diff, so only the intended `src/ircount.cpp` change remains. `src/ircount.cpp` is now byte-identical to its pristine `src/ircount.cpp.orig` (sha256 `0d26bd10…49c0`), i.e. the fix restores upstream rather than weakening code.
  - `validator` also noted `run-tests.sh` is a direct `clang++` one-liner and does not use `CMakeLists.txt`; harmless, not acted on.