## Pass

**`FuseReductionIntoLoop`** — [bishengir/lib/Transforms/FuseReductionIntoLoop.cpp](bishengir/lib/Transforms/FuseReductionIntoLoop.cpp)
*Purpose:* fuses `linalg.reduce` ops that consume `scf.for` results **into** the loop body, so the loop carries the smaller 1-D accumulator instead of the full 2-D one (each 2-D iter_arg becomes a zero-filled 1-D init; body `arith.addf` of the 2-D accumulator is rewritten as `linalg.reduce` + 1-D `arith.addf`; the now-redundant post-loop reduce is erased). Goal: lower on-chip buffer pressure and improve locality. Runs on `func::FuncOp` (`runOnOperation` at :173–182).

## Definition

`bishengir/lib/Transforms/FuseReductionIntoLoop.cpp:169` — `struct FuseReductionIntoLoop : public impl::FuseReductionIntoLoopBase<FuseReductionIntoLoop>`. This is a multi-line declaration: 169 is the `struct`/class-name line, 170 carries the base-class clause, 171 the constructor, and the definition closes at :308.

How I got it: candidate discovery with `grep '^(class|struct) \w+'` over `bishengir/lib/Transforms/*.cpp`, then exact confirmation with **`lsp goToDefinition`** at `FuseReductionIntoLoop.cpp:169:7`, which returned `FuseReductionIntoLoop.cpp:169:8`.

## Pipeline position

Registered in TableGen at [Passes.td:85](bishengir/include/bishengir/Transforms/Passes.td#L85) (`def FuseReductionIntoLoop : Pass<"fuse-reduction-into-loop", "mlir::func::FuncOp">`, op anchor :86, constructor binding :96), and **invoked** at [HFusionRegbasePipelines.cpp:160](bishengir/lib/Dialect/HFusion/Pipelines/regbase/HFusionRegbasePipelines.cpp#L160) inside `static void preProcess(...)` (:146). The statement spans :159–160; its enclosing `if (options.enableFuseReductionIntoLoop)` is :158, nested in the :156–157 gate `enableTritonKernelCompile && isRegBasedArch(target)`. The option defaults to `"false"` at [Options.td:1285](bishengir/include/bishengir/Tools/bishengir-compile/Options.td#L1285). This is the **only** invocation repo-wide; `HFusionPipelines.cpp` has zero `FuseReduction` hits (its reduce-related code is the unrelated `ComposeMultiReduce`, :138).

## Call sites

| Site | Code |
|---|---|
| [FuseReductionIntoLoop.cpp:314](bishengir/lib/Transforms/FuseReductionIntoLoop.cpp#L314) | `return std::make_unique<FuseReductionIntoLoop>();` (factory body) |
| [HFusionRegbasePipelines.cpp:160](bishengir/lib/Dialect/HFusion/Pipelines/regbase/HFusionRegbasePipelines.cpp#L160) | `bishengir::createFuseReductionIntoLoopPass());` |
| [Passes.h:68](bishengir/include/bishengir/Transforms/Passes.h#L68) | `std::unique_ptr<mlir::Pass> createFuseReductionIntoLoopPass();` |
| [Passes.td:96](bishengir/include/bishengir/Transforms/Passes.td#L96) | `let constructor = "bishengir::createFuseReductionIntoLoopPass()";` |

Test: [fuse-reduction-into-loop.mlir:1](bishengir/test/Transforms/fuse-reduction-into-loop.mlir#L1) drives it directly via `-pass-pipeline="builtin.module(func.func(fuse-reduction-into-loop))"`. Build entry: [CMakeLists.txt:11](bishengir/lib/Transforms/CMakeLists.txt#L11).

## Evidence

| # | Claim | Tool + arguments | Observed result |
|---|---|---|---|
| 1 | Pass classes exist in `Transforms/` | `grep`, pattern `^(class\|struct) \w+`, path `bishengir/lib/Transforms`, include `*.cpp` | 22 struct/class hits; `FuseReductionIntoLoop.cpp:169: struct FuseReductionIntoLoop` |
| 2 | Class definition location | `lsp goToDefinition`, `FuseReductionIntoLoop.cpp`, line 169, char 7 | `kind: locations` → `FuseReductionIntoLoop.cpp:169:8` |
| 3 | Class has >1 reference | `lsp findReferences`, `FuseReductionIntoLoop.cpp`, line 169, char 7 | 4 locations: :169:8 (def), :170:46, :171:12, :314:27 |
| 4 | Definition body lines | `read` FuseReductionIntoLoop.cpp offset 160 limit 25 / offset 305 limit 13 | :169 `struct FuseReductionIntoLoop`; :170 base clause; :171 ctor; :313 factory; :314 `make_unique` |
| 5 | TableGen + pipeline registration | `read` Passes.td offset 80 limit 20; `read` HFusionRegbasePipelines.cpp offset 150 limit 16 | `85: def FuseReductionIntoLoop : Pass<"fuse-reduction-into-loop",` … `96: let constructor`; `158: if (options.enableFuseReductionIntoLoop)`, `160: bishengir::createFuseReductionIntoLoopPass());` |
| 6 | Sole invocation repo-wide | `grep` pattern `createFuseReductionIntoLoopPass\(`, whole repo | exactly 4 hits: def :313, `Passes.td:96`, `Passes.h:68`, `HFusionRegbasePipelines.cpp:160` — only :160 is a call |
| 7 | :314 is a real use of the class | `lsp findReferences`, pipefile line 160 char 30 | :160 (call) and `FuseReductionIntoLoop.cpp:313` (factory) |
| 8 | Definition is the factory's target | `lsp goToDefinition`, `FuseReductionIntoLoop.cpp` line 313 char 30 | `Passes.h:68` |
| 9 | Explorer's refinement (i): 169=struct / 170=derives | reviewer `read` of bytes 167–172 | `169: struct FuseReductionIntoLoop` / `170: : public impl::FuseReductionIntoLoopBase<...>` — consistent, no conflict with "at :169" |
| 10 | Explorer's refinement (ii): no other invocation | reviewer `grep` `FuseReduction` over `bishengir/lib` + inspection of the Pipelines tree (2 cpp files) | 10 hits, all in the pass file, `CMakeLists.txt:11`, and `HFusionRegbasePipelines.cpp:158,160`; `HFusionPipelines.cpp` zero hits |

## Reviewer verdict

**CONFIRMED** — every line number was independently re-verified by re-reading the files (read/grep, no LSP), and both of explorer's refinements hold: line 169 is the class-name line with the base clause on 170, and `HFusionRegbasePipelines.cpp:160` is the sole invocation of the factory in the repository.

## Agent roster

| Name | Context | Final status | Task completed |
|---|---|---|---|
| `lead` | — | running (turn owner) | — |
| `explorer` | fresh | inactive (finished, task reported) | **task-1** (rev 3, completed) — located/characterized the pass: definition :169, purpose, TableGen :85, pipeline :160, options :1285, test file, exclusivity check |
| `reviewer` | fresh | inactive (finished, verdict reported) | **task-2** (rev 3, completed; `blocked_by` task-1) — independent verification of all claims + both refinements, verdict CONFIRMED |

## PTC notes

- **`run_code` calls made:** 10, of which 9 did repo/team work and the 10th was a final read-only board/roster confirmation (both tasks `completed` rev 3; both teammates `inactive`).
- **Nested tool calls made:** 32 total — `glob` 2, `grep` 5, `read` 6, `lsp` 5, `team_task_create` 2, `team_task_list` 4, `list_agents` 4, `spawn_teammate` 2, `wait_agent` 1, `send_message` 1. The `team_task_update` claim/complete transitions (2 tasks) were performed by the teammates inside their own programs and are not counted here.
- **Failures:** one empty result — `grep` with pattern `class .*Pass\b.*:.*public` over `*.cpp` returned 0 matches because the base classes sit on the following line; I re-ran with an anchored `^(class|struct)` pattern and got 22 hits. No `ToolCallError` was raised by any LSP, grep, read, or team call. Read-only compliance held: no file was written, created, deleted, or modified, and no git command was executed.