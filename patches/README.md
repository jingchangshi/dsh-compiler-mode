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

- `reasoningEffort` is **not exposed** on the tool: none of the six role models declares reasoning
  capability, so any explicit effort fails with `UNSUPPORTED_REASONING_EFFORT`.
- `maxTokens` is passed through unvalidated (no clamp against the model cap).
- `member.model` shows the member's own route only while it is live; the durable truth is the
  child's `subagent/descriptor` event.

# Patch 0002 — team member reclaim (retire + lifetime-slot recycling)

Applies to `deepseek-harness` @ `296181d1c2` (branch `dev`; this HEAD already
contains patch 0001, landed as `b62215edfa`).

## Why it exists

Agent Teams had no member reclamation: `TeamMemberPhase` was
`provisioning | active | failed`, `spawnAdmitted()` counted every row against
`maxMembers`, and the name check rejected any reused name. Failed and finished
teammates therefore permanently consume the lifetime budget, so a long session
eventually cannot spawn another teammate at all. This patch reclaims a slot
without giving up name uniqueness.

It follows the P1 checklist in `docs/design/team-member-reclaim-solution.md`
(T3), with one deviation required by the task brief: a **running** target is
rejected (`TEAM_MEMBER_RUNNING`) instead of being drained inside `retire`.

## What it changes (11 files, +283/−23)

| File | Change |
|---|---|
| `agent-team/src/types.ts` | terminal phase `retired`; `TeamMemberView['status']` gains `retired`; `TeamMemberProjection.phase` keeps the full union (tombstones stay in the client view); `team/member` event map version `2 \| 3`; `RetireTeammateResult`; `maxMembers` = non-retired members |
| `agent-team/src/projection.ts` | snapshot/projection phase enums accept `retired`; `teamMemberEventSchema` accepts v2 or v3; state machine allows `active\|failed → retired` with `retired` absorbing; retired rows stay in the wire view; `stateVersion` 4 → 5 |
| `agent-team/src/roster.ts` | slot limit counts only non-retired members; new `retire(caller, targetName)`: Lead-only, rejects running (`TEAM_MEMBER_RUNNING`) and provisioning members, drains the child session first, appends a v3 tombstone; repeat call is an idempotent no-op; `list()` shows `status: 'retired'`; `tryMembership()` retired guard |
| `agent-team/src/index.ts` | `TeamService.retireTeammate(caller, targetName)` |
| `agent-team/tests/*` | slot reclaim + retired row shown/non-addressable, failed-member retire, repeated-retire no-op, non-Lead/unknown/`lead`/running rejection, replay + absorbing-state, wire-view tombstone, stateVersion 5 |
| `client-ui-agent-team/src/client/TeamAction.tsx` | `MemberStatus` gains `retired`; inert row with an idle dot |
| `client-ui-agent-team/src/client/locales.ts` | `memberStatus.retired` = `已退役` / `Retired` |
| `tool-agent-team/src/index.ts` | `MEMBER_VIEW_SCHEMA.status` gains `retired`; new `retire_teammate` tool (`target`); policy/list text mention retire and the lifetime limit |
| `tool-agent-team/tests/tool-team.spec.ts` | retired status in the status matrix; tool-set, forwarding and policy-text coverage |

Design choices (full rationale in `evidence/design/member-reclaim-spike.md`):
reuse the `phase` field rather than a new event type; `team/member` payload is
**version 2|3** (retirement edges written as 3, existing edges byte-identical);
**`stateVersion` 4 → 5** because the checkpoint state schema widens and
`restore()` does not guard `stateSchema.parse`; names stay **permanently
reserved**, only the slot is reclaimed; retired rows remain as non-addressable
tombstones so task `ownerName` still resolves.

## Verification

In a copy of the checkout (`/tmp/reclaim-spike/repo`, same HEAD): `vitest` for
the agent-team, tool-agent-team and client-ui-agent-team suites → **173/173
tests pass**; `tsc -b` of the three packages and full `tsc -b tsconfig.host.json`
→ clean; `git apply --check` against the real baseline → exit 0. No live Host
build/boot was performed — see the evidence doc for residual risks.

## Apply / revert

```bash
cd ~/workspace/deepseek-harness
git apply ~/workspace/dsh-compiler-mode/patches/0002-team-member-reclaim.patch
node node_modules/typescript/bin/tsc -b tsconfig.host.json
npx tsdown --config-loader native --env.DSH_BUILD_FACE host   # REQUIRED: the Host loads lib/
```
Revert: `git apply -R .../patches/0002-team-member-reclaim.patch` then rebuild and restart.

**Rebuild and restart are both mandatory** — `apps/cli` loads `lib/`, and a running Host keeps its
start-up composition.

---

# Patch 0003 — automatic member reclaim (dead-slot + idle grace)

Applies on top of patch 0002, to `deepseek-harness` @ `296181d1c2` with 0002 applied.

## Why it exists

0002 added an explicit `retire_teammate`, but a long-horizon session should not have to remember to
call it, and it should not have to write prompt guidance either. 0003 makes the runtime manage the
roster: a failed creation never holds a slot (the next spawn reclaims it), and when the member limit
is reached the least-recently-active member that owns no open task and has been idle past the grace
period is retired automatically to make room. No prompt discipline and no manual retire required.

## What it changes (5 files, +157/−12)

| File | Change |
|---|---|
| `agent-team/src/types.ts` | `Config`: `autoRetireFailed` (default true), `memberIdleGraceMs` (default 300000, `0` disables idle reclaim) |
| `agent-team/src/index.ts` | schema + validation, hand the options to `TeamRoster`, track agent status for idle measurement |
| `agent-team/src/roster.ts` | non-retired slot count; `reclaimCandidate`/`reclaimForCapacity` before each spawn; idle tracking; clearer `TEAM_MEMBER_LIMIT` message naming why nothing was reclaimable |
| `tool-agent-team/src/index.ts` | policy text: reuse an idle teammate before spawning; DSH auto-reclaims dead/idle members |
| `agent-team/tests/team.spec.ts` | dead-slot reclaimed at next spawn; idle member reclaimed; a member owning an open task is NOT reclaimed |

## Tradeoff

Automatic reclaim only targets `failed` members, or `active` members that are idle past the grace,
not running, and own no open task. A reclaimed member is no longer addressable, so the durable
pattern is a fixed roster reused with `send_message`; retire explicitly only to correct a mistake.

## Verification

In the same copy of the checkout: 144/144 tests across agent-team + tool-agent-team, `tsc -b` clean,
and `git apply --check` clean on top of 0002. `scripts/install.sh` applies 0002 then 0003 in order.
