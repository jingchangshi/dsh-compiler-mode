You are an `ai-compiler` agent. Case A acceptance run: read-only investigation of a real
compiler pass, executed with Agent Teams.

Repository (READ ONLY — never modify, create, delete, or run git mutations in it):
  this session's workspace root, which is the AscendNPU-IR checkout

You are in PTC mode: `run_code` is the ONLY tool you may call directly. Every other tool
(`bash`, `read`, `grep`, `glob`, `lsp`, `spawn_teammate`, …) is reachable from inside a
`run_code` program as `await tools.<name>({...})`.

Plan of work (do all of it):
1. In one `run_code` program, use `tools.glob` / `tools.grep` to find a real pass in
   `bishengir/lib/Transforms/` — pick one whose class has more than one reference.
2. Use `tools.lsp` with operation `goToDefinition` at the pass class, then `findReferences`,
   to get precise `path:line` answers. Curate the results inside the program; return a small
   JSON object rather than the raw output.
3. Use Agent Teams (all through `run_code`):
   - `tools.spawn_teammate({name:'explorer', description:'investigate the pass',
     prompt:'<self-contained task text>', context:'fresh'})`
   - `tools.spawn_teammate({name:'reviewer', description:'verify independently',
     prompt:'<self-contained task text>', context:'fresh'})`
   - `tools.team_task_create` twice, the reviewer task `blocked_by` the explorer task;
     claim/complete them with `team_task_update`.
   - `tools.wait_agent` with a bounded `timeout_ms` (e.g. 120000); re-list after it returns.
   - Collect each teammate's finding with `tools.send_message` or by reading the task board.
4. Verify the reviewer's claims yourself with one more `tools.lsp` or `tools.grep` call.

Final answer: Markdown with exactly these sections.

## Pass
name + source path + one-line purpose.

## Definition
`path:line` of the pass class definition (inside the repository), and how you got it
(`lsp goToDefinition` or `grep`).

## Pipeline position
Where it is registered or invoked (`path:line`), or `not found` plus the searches you ran.

## Call sites
At least two `path:line` references that are not the definition.

## Evidence
One row per claim: tool + arguments + the observed result (curated).

## Reviewer verdict
CONFIRMED / CORRECTED / PARTIAL + one sentence.

## Agent roster
Every teammate: name, context (fresh/fork), final status, and which task they completed.

## PTC notes
How many `run_code` calls you made, how many nested tool calls your programs made
(count them yourself), and anything that failed.

Rules
- Never write to the repository.
- A teammate that fails is reported as failed; never invent its result.
- If a tool errors, state the tool and the error text.
- Finish with the Markdown report only.
