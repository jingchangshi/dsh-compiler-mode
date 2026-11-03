# T4 spike — Team member reclaim (`retire` + lifetime-slot recycling)

Status: **patch produced and statically verified; not built or booted against a live Host.**
Task: `task-4` (shared task board). Owner: `spike-engineer`.

This patch follows the P1 file-level checklist in
`docs/design/team-member-reclaim-solution.md` (T3), with **one deliberate
deviation required by the task brief**: a `running` target is **rejected**
(`TEAM_MEMBER_RUNNING`) instead of T3's "drain the running member inside retire"
option. The child drain still happens before the durable tombstone for every
non-running target.

## 1. Environment and method

- Baseline (read-only): `~/workspace/deepseek-harness`
  at commit **`296181d1c2`** (branch `dev`, working tree clean). This HEAD
  already contains patch 0001's per-teammate route work (`b62215edfa`).
- To avoid touching the baseline worktree, the whole checkout was copied with
  `cp -a` to **`/tmp/reclaim-spike/repo`** (same HEAD, same `node_modules`
  layout; git status clean). All edits, tests and typechecks ran there.
- The patch was generated from that copy with `git diff` and then validated
  with `git apply --check` against the real baseline checkout (read-only —
  `apply --check` writes nothing).

> Note: the copy logged 4 `cp: cannot open ... round_01/*.zip: Permission denied`
> lines. Those files are unrelated session-artifact zips unreadable to this
> account; they are not part of the source tree and do not affect the copy
> (`git status` in the copy is clean).

## 2. What the patch changes (11 files, +283 / −23)

| File | Change |
|---|---|
| `agent-team/src/types.ts` | `TeamMemberPhase` gains terminal `'retired'`; `TeamMemberView['status']` gains `'retired'`; `TeamMemberProjection.phase` keeps the full union (tombstones stay in the client view); `team/member` event map version is `2 \| 3`; adds `RetireTeammateResult`; `maxMembers` doc = non-retired members |
| `agent-team/src/projection.ts` | snapshot + projection phase enums accept `retired`; `teamMemberEventSchema` accepts version 2 or 3; state machine allows `provisioning→active\|failed` and `active\|failed→retired`, `retired` absorbing; retired rows stay in the wire view; `stateVersion` 4 → 5 |
| `agent-team/src/roster.ts` | slot limit counts only non-retired members; new `retire(caller,targetName)` (Lead-only, rejects running/provisioning, drains child first, appends v3 tombstone, idempotent repeat); `list()` reports `status: 'retired'`; `tryMembership()` never treats a winding-down retired child as lead |
| `agent-team/src/index.ts` | `TeamService.retireTeammate(caller,targetName)` |
| `agent-team/tests/team.spec.ts` | slot reclaim + retired row shown/non-addressable; failed-member retire + repeated-retire no-op; non-Lead / unknown / `lead` / running rejection |
| `agent-team/tests/projection-events.spec.ts` | retirement transition + absorbing state; wire view keeps the tombstone; `stateVersion === 5`; test title de-versioned |
| `agent-team/tests/completion.spec.ts` | `stateVersion` assertion 4 → 5 |
| `client-ui-agent-team/src/client/TeamAction.tsx` | `MemberStatus` gains `'retired'`; status key, idle dot and inert treatment |
| `client-ui-agent-team/src/client/locales.ts` | `memberStatus.retired` = `已退役` / `Retired` (the real dictionary; `locale/*.json` holds only meta) |
| `tool-agent-team/src/index.ts` | `MEMBER_VIEW_SCHEMA.status` gains `'retired'`; new `retire_teammate` tool (`target`, `jsonOutput`); policy/list text mention retire and the lifetime limit |
| `tool-agent-team/tests/tool-team.spec.ts` | retired status in the status matrix; tool-set, forwarding and policy-text coverage |

## 3. Design decisions

**Reuse the `team/member` `phase` field; do not add an event type.** Retirement
is one more value of the lifecycle discriminant that already carries
`provisioning|active|failed`. A new event type (e.g. `team/member/retired`)
would add a second write point, a second `TeamEventType`/parser branch and
either a second tombstone collection or duplicated identity — breaking the
"one whole-value snapshot per change" invariant for no benefit.

**`team/member` payload version `2 | 3`; retirement edges are written as 3.**
Everything already written stays version 2 and byte-identical. New readers
accept both. A pre-patch reader treats a v3 event as an unsupported version and
fails the Team projection explicitly — the desired "downgrade fails loudly, not
silently misreads" outcome. (`SUPPORTED_TEAM_EVENT_VERSIONS` already contained 3
for `team/task`, so no selector change is needed.)

**`stateVersion` 4 → 5 is required.** The persisted projection state schema
widens its member-phase domain, so a new v5 checkpoint can legitimately contain
`retired`. `SessionProjectionRegistry.restore()` does **not** guard
`stateSchema.parse(row.val)` when `row.ver === stateVersion`; an old reader that
still claimed version 4 would accept a new v4 row and then throw an uncaught
schema error. Bumping to 5 makes the old reader see a version mismatch, discard
the row and refold the log — surfacing the domain's own projection failure
instead of a crash. New readers refold old v4 caches once, then reuse v5. Cost:
one full replay per session on upgrade (precedent: the same file bumped 3 → 4 in
`1e6630a856` for a validation-only change).

**Names remain permanently reserved; only the slot is reclaimed.** `retire`
never frees the name. This keeps the projection's cross-member name-uniqueness
check and every durable roster reference unambiguous with the smallest change.
Allowing renames would need history-aware identity (a name epoch), which is out
of scope.

**Retired rows remain in every roster/view as tombstones.** The client wire
projection, `list_agents` and the task `ownerName` resolution all keep the row
(status `retired`), so task ownership stays resolvable after retirement and the
model can see what existed. The row is inert in the UI and non-addressable for
`send_message`/`interrupt`.

**A running target is rejected (`TEAM_MEMBER_RUNNING`).** This deviates from
T3's "drain running inside retire" option, per the task brief. It is a distinct,
actionable code (interrupt first, then retry) rather than overloading
`TEAM_INVALID_TARGET`, which means "not a retire target at all". A provisioning
target is rejected with the existing `TEAM_PROVISIONING_CONFLICT`; a repeated
retirement is an **idempotent success** that appends no second event.

## 4. Verification performed

All commands below ran in `/tmp/reclaim-spike/repo` unless stated otherwise.

### 4.1 `git apply --check` (against the real baseline, read-only)

```
Checking patch packages/experimental/agent-team/src/index.ts...
Checking patch packages/experimental/agent-team/src/projection.ts...
Checking patch packages/experimental/agent-team/src/roster.ts...
Checking patch packages/experimental/agent-team/src/types.ts...
Checking patch packages/experimental/agent-team/tests/completion.spec.ts...
Checking patch packages/experimental/agent-team/tests/projection-events.spec.ts...
Checking patch packages/experimental/agent-team/tests/team.spec.ts...
Checking patch packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx...
Checking patch packages/experimental/client-ui-agent-team/src/client/locales.ts...
Checking patch packages/experimental/tool-agent-team/src/index.ts...
Checking patch packages/experimental/tool-agent-team/tests/tool-team.spec.ts...
apply_check_exit=0
```

Reverse check against the edited copy (`git apply --check --reverse`) also
returned 0, confirming the patch reproduces the edited tree exactly.

### 4.2 Tests

```
vitest run packages/experimental/agent-team/tests \
           packages/experimental/tool-agent-team/tests \
           packages/experimental/client-ui-agent-team/tests
  -> 7 files, 173/173 tests passed
     (agent-team: team 47, projection-events 28, completion 23, persistence 4;
      tool-team 40; client-ui: 31)
```

### 4.3 Typecheck

```
tsc -b packages/experimental/agent-team/tsconfig.json \
       packages/experimental/tool-agent-team/tsconfig.json \
       packages/experimental/client-ui-agent-team/tsconfig.json
  -> clean

tsc -b tsconfig.host.json
  -> exit 0 (full host project graph, no diagnostics)
```

## 5. Not verified / risks

- **No live Host build or boot.** `lib/` was not rebuilt and no real session was
  driven through the Web UI. Apply is `--check`-clean, but the Host must rebuild
  (`tsc -b tsconfig.host.json`, `tsdown ... --env.DSH_BUILD_FACE host`) and
  restart before the change is observable. A real "roster near maxMembers →
  retire → spawn" run through the model was not performed.
- **Full repository test suite not run** — only the affected package suites plus
  the client-UI package. Cross-package breakage is unlikely (all consumers of
  the widened unions were updated and typechecked), but not exhaustively proven.
- **Coverage gate not run.** The repo enforces per-file 100%. Two defensive
  branches are marked `/* v8 ignore */`: `settleProvisioning` rejecting an
  impossible `retired` phase, and `tryMembership` returning `undefined` for a
  live retired child. Both are unreachable by construction (`retire` refuses
  provisioning members and drains the child before writing the tombstone).
  Coverage tooling was not run in the spike copy.
- **Event-version downgrade is one-way.** A pre-patch binary reading a log that
  contains a v3 `team/member` event reports a terminal Team projection failure
  for that session (design choice: loud failure over silent misread). Rollback
  means isolating/removing logs that contain retirement events.
- **Crash window in retire.** The child session is drained *before* the durable
  tombstone is appended (so a failure there leaves the member `active`, which is
  retryable). If the process crashes between drain and append, durable state
  says `active`/`failed` while the child is already gone; a later `retire` still
  succeeds (draining an absent child is a no-op). No tombstone is lost, but the
  member briefly looks live.
- **Provisioning members cannot be retired** until recovery settles them to
  `active`/`failed`; a wedged provisioning row is not reclaimed by this patch.
- **Tombstone growth.** Names are reserved forever, so a long session that
  retires many teammates accumulates durable `retired` rows (bounded only by
  session size). `maxMembers` now bounds only live members. Intended trade-off
  of "names never reused", documented in the tool policy.
- **Concurrency.** `retire` serializes its durable append through
  `journal.transact` and re-reads state under the lock; a second retire drains
  again but appends nothing. No dedicated stress test races a concurrent
  `spawn` against `retire`; correctness relies on the existing per-Lead
  transaction serialization.
