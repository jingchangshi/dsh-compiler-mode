# Patch 0001 — per-teammate model route (historical: superseded by 0002, do not apply)

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
cd ~/workspace/deepseek-harness
git checkout -b ai-compiler/team-agent-options   # if not already on it
git apply ~/workspace/dsh-compiler-mode/patches/0001-team-agent-options.patch
node node_modules/typescript/bin/tsc -b tsconfig.host.json
npx tsdown --config-loader native --env.DSH_BUILD_FACE host   # REQUIRED: the Host loads lib/
```
Revert: `git apply -R patches/0001-team-agent-options.patch` then rebuild.

**Rebuild and restart are both mandatory** — `apps/cli` loads `lib/`, and a running Host keeps its
start-up composition. Skipping either produces "the patch looks applied but nothing changed".

## Known limits (measured, not assumed)

- **This patch is historical: 0002 removed its `agent_options` capability.** The model-facing
  `agent_options` parameter and `SpawnTeammateRequest.agentOptions` no longer exist;
  `spawn_teammate` takes only role/task/context/slot/description. Routes are now fixed
  deployment configuration — see patch 0003 and `docs/design/preset-role-routing.md`.
  Do not re-apply 0001 on its own.
- `reasoningEffort` is **not exposed**: none of the six role models declares reasoning
  capability, so any explicit effort fails with `UNSUPPORTED_REASONING_EFFORT`. `RoleSpec`
  has no `reasoningEffort` field at all.
- `maxTokens` is passed through unvalidated (no clamp against the model cap).
- `member.model` shows the member's own route only while it is live; the durable truth is the
  child's `subagent/descriptor` event.

# Patch 0002 — role-first Team topology (roles, slots, generations)

Applies to `deepseek-harness` @ `296181d1c2` (this HEAD already carries patch 0001 as `b62215edfa`).

## Why it exists

The earlier dynamic-spawn model had no role concept: any task could be message-routed to any member,
reclamation was role-blind, and a member name was an unstable namespace with no rebuildable position.
This patch replaces it with a role-first topology: declared roles with fixed model routes and per-role
concurrency, four reserved/pinned plus four flex slots, and per-member `roleId/slotId/generation` so a
slot can be rebuilt under a new generation while names stay permanently reserved.

## What it changes (18 files, +1105 / −3378)

| Area | Change |
|---|---|
| `agent-team/src/types.ts` | `RoleSpec`, `TeamSlotSnapshot`, member `roleId/slotId/generation`, `team/slot` event, task `requiredRole`, slot-plan config |
| `agent-team/src/projection.ts` | folds `team/slot`, new member/task versions, wire view with roles/slots, `stateVersion` 6 |
| `agent-team/src/roster.ts` | role routing, slot allocation (reserved then flex), generation naming, retire, role-aware reclaim, admission lock |
| `agent-team/src/{index,task-board,task-view,journal}.ts` | default roles + 4/4 slot plan, `requiredRole` enforcement, slots in state |
| `tool-agent-team/src/index.ts` | `spawn_teammate({role,task,slot})`, `send_message` `expected_role`, `retire_teammate`, task `required_role`, role-catalog policy |
| `client-ui-agent-team` | show role/generation, retired status |
| `core/session/src/known-event-types.ts` | register the new `team/slot` session event (generated) |
| tests | rewritten for the role/slot model |

## Verification

In a copy of the checkout: agent-team 68 + tool-agent-team 6 + client-ui 31 = 105 tests pass; `tsc -b`
of the three packages and the full `tsc -b tsconfig.host.json` are clean; `git apply --check` against
the baseline exits 0.

## Apply / revert

`scripts/install.sh` applies it and rebuilds `lib/`; `scripts/uninstall.sh --revert-harness` reverses
it. Rebuild and restart the Host are mandatory.

# Patch 0003 — per-preset Team role routes (`presetRoles`)

Applies on top of 0002. Requires the same rebuild + Host restart.

## Why it exists

After 0002 the Team had ONE role table for the whole Host, so every preset routed the six roles to
the same models. `ai-compiler-magpie` could DESCRIBE a one-provider fleet in its persona but could
never actually run one — and nothing failed when the description disagreed with reality. That silent
disagreement is the defect this patch removes: the route is now derived from one table keyed by the
Lead's preset, and a suite check fails if the persona text drifts from it.

## What it changes (9 files)

| Area | Change |
|---|---|
| `agent-team/src/routes.ts` | **new** — `presetIdOf()` and `resolveRoles()`, the single resolver |
| `agent-team/src/types.ts` | `Config.presetRoles` + JSDoc on every role/slot field |
| `agent-team/src/index.ts` | schema (`z.dict(ROLE_TABLE)`), `rolesFor(agent)`, `validateRoleTable`, cross-table slot validation |
| `agent-team/src/roster.ts` | spawn resolves the role in the order's table, not `config.roles` |
| `tool-agent-team/src/index.ts` | role catalog rendered from `rolesFor(agent)` as a function provider |
| tests + both READMEs | 8 new tests, `agentPresets` stub in the fixture, role-route documentation |

Nothing in `DEFAULT_ROLES` changed, and no field gained a `reasoningEffort` option. With no
`presetRoles` configured, resolution falls through to `roles` (then `DEFAULT_ROLES`), so behaviour is
identical to before the patch.

## Verification

agent-team + tool-agent-team: 83 tests pass (baseline 81, +8). `tsc -b tsconfig.host.json` clean.
The patch applies and reverts cleanly on a pristine worktree of the pinned HEAD.

## Known limits

- Resolution reads `agentPresets.composedPreset()` through a **structural** interface, so agent-team
  gains no dependency on the optional preset registry. A Host without that registry still resolves
  through `session.header.agentPreset`.
- A preset switch mid-session affects only FUTURE spawns; an already-spawned teammate keeps the
  route it started with. This follows from resolving at spawn time and is not separately measured.
- Changing a route needs a config edit plus a Host restart; a running Host keeps its start-up tables.

