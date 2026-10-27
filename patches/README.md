# Patch 0001 — per-teammate model route

Applies to `deepseek-harness` @ `1f81c047fc` (rc.3), branch `ai-compiler/team-agent-options`.

## Why it exists

rc.3's Agent Teams API cannot give a teammate its own model: `SpawnTeammateRequest` has no
`agentOptions`, and `TeamRoster.spawnAdmitted()` calls `subagents.startActivation()` without one,
so every teammate inherits the Lead's route. Everything else the feature needs **already exists**:

- `SubagentStartRequest.agentOptions` (`subagent/src/types.ts:167`) with merge semantics
  (`child-agent.ts:98-119`),
- provider capability `agentOptions: true` on both `spawn` and `fork`,
- descriptor persistence of `agentProvider/agentModel/agentReasoningEffort`
  (`descriptor.ts:77-107`) restored by `manager.ts:1369-1374`.

## What it changes (4 files, +85/−1)

| File | Change |
|---|---|
| `agent-team/src/types.ts` | `SpawnTeammateRequest.agentOptions?: AgentOptions` |
| `agent-team/src/roster.ts` | forwards `agentOptions` into `startActivation` |
| `agent-team/src/roster.ts` | **fix**: `list()` no longer falls back to `root.options.model` for a member, which reported the Lead's model as the member's |
| `tool-agent-team/src/index.ts` | model-facing `agent_options { provider, model, maxTokens }`, dropped when empty |
| `tool-agent-team/tests/tool-team.spec.ts` | 3 tests: forwards the route, omits it when absent, drops an empty object |

Backward compatible: omitting `agent_options` behaves exactly as before. 109/109 tests pass.

## Apply / revert

```bash
cd /home/s00653124/workspace/deepseek-harness
git checkout -b ai-compiler/team-agent-options   # if not already on it
git apply /home/s00653124/workspace/dsh-compiler-mode/patches/0001-team-agent-options.patch
node node_modules/typescript/bin/tsc -b tsconfig.host.json
npx tsdown --config-loader native --env.DSH_BUILD_FACE host   # REQUIRED: the Host loads lib/
```
Revert: `git apply -R patches/0001-team-agent-options.patch` then rebuild.

**Rebuild and restart are both mandatory** — `apps/cli` loads `lib/`, and a running Host keeps its
start-up composition. Skipping either produces "the patch looks applied but nothing changed".

## Known limits (measured, not assumed)

- `reasoningEffort` is **not exposed** on the tool: none of the six role models declares reasoning
  capability, so any explicit effort fails with `UNSUPPORTED_REASONING_EFFORT`.
- `maxTokens` is passed through unvalidated (no clamp against the model cap).
- `member.model` shows the member's own route only while it is live; the durable truth is the
  child's `subagent/descriptor` event.
