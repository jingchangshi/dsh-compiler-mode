# Case A Acceptance Run — `DeadFunctionEliminationPass`

## Pass
`DeadFunctionEliminationPass` (`bishengir/lib/Transforms/DeadFunctionElimination.cpp`, MLIR op name `dead-func-elimination`) — a function-op-only, more aggressive replacement for `SymbolDCE`: it erases any `FunctionOpInterface` op with no known uses, *including public ones*, gated by a user-supplied `filterFn` predicate.

## Definition
`bishengir/lib/Transforms/DeadFunctionElimination.cpp:51` — `struct DeadFunctionEliminationPass : public bishengir::impl::DeadFunctionEliminationBase<DeadFunctionEliminationPass>` (inside an anonymous namespace opened at `:49`, closed at `:66`).
Obtained with `lsp goToDefinition` at line 51, char 9, on the `DeadFunctionEliminationPass` token → single location `DeadFunctionElimination.cpp` 0-based line 50, chars 7–34 (i.e. `:51`).

## Pipeline position
**Not found** — the pass is registered but never placed in a pipeline.

- Registered in the global registry only: `bishengir/include/bishengir/Transforms/Passes.td:53` (`def DeadFunctionElimination : Pass<"dead-func-elimination", "mlir::ModuleOp">`), constructor hook at `Passes.td:63`; `GEN_PASS_REGISTRATION` at `bishengir/include/bishengir/Transforms/Passes.h:88`, invoked as `bishengir::registerBiShengIRTransformPasses()` from `bishengir/include/bishengir/InitAllPasses.h:94` and `InitAllPassesA3.h:79`.
- Searches run: `grep "dead-func-elimination"` (repo-wide) → 1 hit, the TD definition; `grep "createDeadFunctionEliminationPass"` → 3 hits (decl, def, TD constructor string), no `addPass`; `grep "DeadFunctionEliminationPass"` → only the .cpp; `grep "addPass\("` in `PackTilingData.cpp` → 0 hits; `grep DeadFunctionElimination|dead-func` under `bishengir/test` → 0 hits.
- The logic *is* live via a different entry point: `PackTilingDataPass` (wired at `HFusionPipelines.cpp:216` and `regbase/HFusionRegbasePipelines.cpp:299`) calls the free function directly.

## Call sites
- `bishengir/lib/Transforms/DeadFunctionElimination.cpp:70` — `return std::make_unique<DeadFunctionEliminationPass>(options);` (the only instantiation).
- `bishengir/lib/Dialect/HFusion/Transforms/PackTilingData.cpp:350` — `bishengir::eliminateDeadFunctions(mod, dfeOptions);` (real consumer of the pass logic, filter set at `:335`–`:349`).
- `bishengir/lib/Transforms/DeadFunctionElimination.cpp:59` — `bishengir::eliminateDeadFunctions(getOperation(), options);` inside `runOnOperation()`.

## Evidence
| # | Tool + arguments | Observed result (curated) |
|---|---|---|
| 1 | `grep "^class .*Pass\|^struct .*Pass"` in `bishengir/lib/Transforms/*.cpp` | 5 pass structs found; `DeadFunctionElimination.cpp:51` among them |
| 2 | `grep "DeadFunctionElimination"` repo-wide | 18 hits spanning .cpp/.h/.td/CMakeLists — multi-reference class, selected over `EliminateSingleIterationScfFor` (10 hits) |
| 3 | `lsp goToDefinition` `DeadFunctionElimination.cpp:51:9` | 1 location → `DeadFunctionElimination.cpp:50` (0-based), chars 7–34 ⇒ `:51` |
| 4 | `lsp findReferences` `DeadFunctionElimination.cpp:51:9` | 4 locations, all in-file: `:51` (decl), `:53` (template arg), `:54` (ctor), `:70` (`make_unique`) |
| 5 | `lsp findReferences` `Passes.h:53:52` (`createDeadFunctionEliminationPass`) | 2 locations: `Passes.h:53` decl + `DeadFunctionElimination.cpp:68` def → factory never called |
| 6 | `lsp findReferences` `Passes.h:57:8` (`eliminateDeadFunctions`) | 3 locations: `Passes.h:57`, `DeadFunctionElimination.cpp:32`, `DeadFunctionElimination.cpp:59` |
| 7 | `lsp findReferences` `PackTilingData.cpp:350:25` (`mod` arg) | 4 locations incl. `PackTilingData.cpp:350`, `Passes.h:57`, `DeadFunctionElimination.cpp:32`, `:59` |
| 8 | `read Passes.td:53-64` | Summary "Eliminate functions that are dead."; description: targets function-like ops only, removes public functions, allows specifying which functions to remove |
| 9 | `read PackTilingData.cpp:315-359` | Comment `:334` "Erase dead and empty tiling function"; options built `:335`; filter `:336-349` = `dyn_cast<func::FuncOp>` → `hacc::utils::isHost` → `HostFuncType::kTilingFunction` → `isEmptyTilingFunc`; call `:350` |
| 10 | `grep "dead-func-elimination\|dead_func_elimination"` (`*.{td,cpp,h,py,mlir,md,txt}`) | exactly 1 hit: `Passes.td:53` → no textual pipeline naming the pass |
| 11 | `grep "addPass\("` in `PackTilingData.cpp` | 0 hits → PackTilingData itself is nested via `addPass` elsewhere, not DFE |
| 12 | `grep "isEmptyTilingFunc"` under `bishengir` | local helper at `PackTilingData.cpp:50`, used at `:348` and `:394` |
| 13 | `read InitAllPasses.h:60-99` | `:94` `bishengir::registerBiShengIRTransformPasses();` under "// Transforms passes" |

## Reviewer verdict
**CONFIRMED** — the reviewer independently re-derived all three claims (class at `DeadFunctionElimination.cpp:51`; factory declared `Passes.h:53`/defined `DeadFunctionElimination.cpp:68` and never wired into a pipeline; sole real consumer `PackTilingData.cpp:350` with the host-tiling-function filter), matching my own `grep`/`read`/`lsp` evidence, with two added nuances: `Passes.td:63` is a registration-only reference, and the TableGen constructor passes no options so a registry-driven run would always get the default accept-all filter.

## Agent roster
| Name (label) | Context | Final status | Task completed |
|---|---|---|---|
| `explorer` (`investigate the pass`) | fresh | finished / inactive | Located purpose, TD registration, factory decl+def, proved no pipeline invocation, found the single helper call site `PackTilingData.cpp:335`/`:350`, and the `CMakeLists.txt:4` build entry |
| `reviewer` (`verify independently`) | fresh | finished / inactive | Independently verified claims A/B/C with its own repo-wide greps + `read`/`grep`; returned CONFIRMED on all three plus the `Passes.td:63` / defaulted-options nuances |

## PTC notes
- `run_code` calls made: **15** (including one that failed on a missing team tool, one that enumerated the SDK surface, two that spawned teammates, and three poll/sleep cycles).
- Nested tool calls issued by my programs: **40** (`glob` 1, `grep` 15, `read` 6, `lsp` 6, `subagent` 2, `list_agents` 5, `bash` 4, plus 1 failed `team_task_create`), counted by tallying each `await tools.*` statement per program.
- Failures / deviations (reported as-is, nothing invented):
  - **`team_task_create` is not a function** — `TypeError: tools.team_task_create is not a function`. The Agent Teams task-board tools (`team_task_create`, `team_task_update`, `wait_agent`, `spawn_teammate`) do **not** exist in this session's SDK. `Object.keys(tools)` returns exactly: `ask_user_question, bash, create_goal, edit, exit_plan_mode, get_goal, glob, grep, interrupt_agent, job_kill, job_list, job_output, list_agents, lsp, present, read, read_image, schedule_create, schedule_delete, schedule_list, schedule_update, send_message, skill, subagent, subagent_fork, todo_write, update_goal, web_fetch, web_search, working_directory, write`. No task board was therefore created, no `blocked_by` dependency could be expressed, and no task was claimed/completed.
  - Substitution used: `tools.subagent` with `context: 'fresh'` for both teammates, `tools.list_agents` polled with bounded `sleep` (30 s × 3, ~90 s total — both teammates finished within that budget) in place of `wait_agent`, and each teammate reported back via `tools.send_message`.
  - No repository file was created, modified, or deleted; all teammate work was read-only as instructed.