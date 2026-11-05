# 03 — Architecture Decision Records

Every decision below was forced by a measurement or a source fact recorded in
`docs/02-source-audit.md`; the ADR states the decision, the evidence, and what it costs.

---

## ADR-001 — Ship `ai-compiler` as an independent bundle, never as an edit of a shipped preset

**Context** — RC.3 ships `standard`, `ptc`, `minimal`, `cordis` as `presets/*.patch.yml` rows of
`@deepseek-ai/dsh-web-app` (`packages/bundle/web-app/package.json`). A later patch layer can only
*replace a row's whole `config`* (`vendor/include/src/index.ts:115-124`), never merge into it.

**Decision** — `ai-compiler` is declared by a **new** bundle (`config/bundle-ai-compiler/`) that
`insert`s one `@deepseek-ai/dsh-agent-preset` row with `config.id: ai-compiler`. Shipped presets are
never targeted.

**Evidence** — `verify-preset.mjs` diffs the delivered declaration against the checkout's
`ptc.patch.yml`: `rows {baseline: 33, delivered: 33}`, two declared changes only. `dump-config`
after install still lists `preset-standard/ptc/minimal/cordis` unchanged.

**Consequence** — uninstall is a pure removal; an RC upgrade that edits `ptc.patch.yml` is detected
by the same script, not silently inherited.

---

## ADR-002 — Derive from PTC by *copying the complete list*, not by `extends`

**Context** — The Loader has no inheritance syntax; a preset is a literal entry list. The
`agent-preset-registry` README states the same for user overrides: replacing `config.plugins`
discards everything not restated.

**Decision** — `config/bundle-ai-compiler/cordis.patch.yml` restates PTC's full child list verbatim
with exactly two `# DIFF:` edits (persona prefix, pruner thresholds), and
`tests/preset/verify-preset.mjs` fails when the diff set stops matching `DECLARED`.
Every deviation carries a `# DIFF:` comment in place.

**Consequence** — upgrade procedure is mechanical: re-copy the new `ptc.patch.yml`, re-apply the two
edits, re-run `verify-preset.mjs`.

---

## ADR-003 — LSP lives on the Host plane; the preset only consumes it

**Context** — First implementation put `lsp` / `lsp-stdio` / `tool-lsp` in a preset
`cordis:group` with `isolate: {lsp: true}`. The preset failed to mount:
`agent-preset/invalid: lsp (@deepseek-ai/dsh-lsp): never started`.
Root cause: `@deepseek-ai/dsh-lsp` exports `default class Lsp extends Service` — an **abstract
service base**, not an `apply()` plugin (`packages/lsp/lsp/src/index.ts:158`); the Cordis registry
accepts only functions or `apply` objects (`vendor/cordis/src/registry.ts:8-10`), so the row gets a
module namespace and no fiber, and `agent-preset-registry/src/mount.ts:142` reports it as
`never started`, which marks the whole preset unusable.

**Decision** — LSP rows live in the bundle's **host layer** (`bundles.patch.yml`), like `ptc-runtime`,
`spill-local` and every other shared service. The preset keeps no LSP row at all.

**Consequence** — the `lsp` tool is registered profile-wide instead of per preset; both `ptc` and
`ai-compiler` therefore see it (measured: 31 vs 31 SDK bindings in
`evidence/probes/preset-probe.json`). If a future deployment needs LSP absent from non-compiler
presets, the isolation must be done by splitting the tool row, not by moving the service.

---

## ADR-004 — Agent Teams come from the official bundle's rows, restated, not rewritten

**Context** — `@deepseek-ai/dsh-experimental-agent-team-profile` is an official **optional** bundle:
`agent-team` (service), `tool-agent-team` (9 tools), `ui-agent-team` (Web panel). It also disables
the four direct-delegation rows.

**Decision** — `bundles.patch.yml` inserts the same three rows with the shipped values
(`maxMembers: 8`, `maxTasks: 256`, `maxMessageBytes: 65536`, `disposalTimeoutMs: 5000`,
`freshProvider: spawn`, `forkProvider: fork`), so **one** install enables the whole mode and one
removal rolls it back. No Team runtime code is written or forked.

**Consequence** — the installation must not also select the experimental bundle (duplicate ids).
`ai-compiler`'s preset keeps the four direct-delegation rows declared so a profile without Team
still delegates; that redundancy is recorded as a known cost in the Q18 audit.

---

## ADR-005 — Context management stays on the official plugins, tuned only where measured

**Context** — `spill-local` + `spill-policy` (`maxInlineTokens: 12500`) are **host** rows; the
compaction backend and the tool-result pruner are **preset** rows in an isolate realm. Everything
consumes provider-reported token usage from the host token meter.

**Decision** — keep the official stack; change exactly one value (the pruner budget
`8192/4096/1024 → 20480/12288/4096`). No third-party context plugin, no FTS index, no custom GC.

**Justification** — the pruner is a *retroactive surface rewrite* that runs only when compaction
qualifies, while spill already replaced oversized results at the tool boundary with a head/tail preview
plus an artifact path. Compiler evidence (build logs, IR dumps) is long and structured, so trimming
4096 chars of head throws away the frame that identifies the failing pass. Measurement and the
resulting verdict: `docs/07-benchmarks.md`.

---

## ADR-006 — Acceptance runs on the **Web Host**, headless only for smoke

**Context** — `@deepseek-ai/dsh-headless` composes no preset roster and actively refuses a session
that recorded one (`packages/bundle/headless/src/index.ts:212-221`). Driving the preset through a
hand-built headless profile produced a session whose model never saw `run_code`
(recorded as a failed run, not hidden).

**Decision** — all live E2E and benchmarks go through the running Web Host with the browser's own
`/api` RPC (`session/create {agentPreset}`, `session/prompt`, `session/projections`). Headless is
covered by its own smoke test and by the Q17 consistency note.

**Consequence** — the measured path is the path a user takes; the driver must authenticate with the
Host's cookie format, which is documented in `tests/e2e/web-session.mjs`.

---

## ADR-007 — Permissions: accept the Host's failure-closed behaviour, never widen it silently

**Context** — on this host `bwrap` cannot create a user namespace (AppArmor
`kernel.apparmor_restrict_unprivileged_userns=1`) and the `landlock-run` launcher is absent from the
build output, so `dsh-sandbox-local`'s Linux chain is unusable. `read-only`/`workspace-write` calls
therefore fail closed.

**Decision** — `ai-compiler` adds **no** sandbox configuration, no exemption and no allowlist. The
profile's existing default (`danger-full-access` with `approval: never`, set by the user) stays as
is; the permission acceptance records the measured allow/deny behaviour of *both* the failing modes
and the working one, and tests delegation's `approval: never` pin instead of pretending the
filesystem fence protects the workspace.

**Consequence** — the security boundary verified here is the **sandbox provider**, not a prompt
instruction; the residual risk (no filesystem containment on this host) is stated in
`docs/05-permissions.md` rather than masked.

---

## ADR-008 — Shared working directory with a single writer

**Context** — every teammate shares the Lead's `cwd`; `write_scopes` on the task board is advisory
only, and Bash/formatters are not covered by the version guard.

**Decision** — the mode's working contract (in the preset persona's task workflow and in the case
prompts) is: Lead is the only writer, teammates are read-only analysts/validators, validation runs
after the writer reports, and the Lead reviews the final diff. Nothing claims a lock.

**Consequence** — parallel *writing* is out of scope for this delivery; the Worktree route is
documented but not adopted (see `08-compatibility.md`).

---

## ADR-009 — No third-party search plugin by default

**Context** — the FFF question (Q13).

**Decision** — `rg`/`glob` (native `grep`/`glob` tools) remain the only text/path search in the
default mode. No third-party package is installed or made a dependency of the bundle.

**Evidence and the fallback path** — `docs/08-compatibility.md` §FFF: no RC.3-compatible
`dsh`-plugin packaging of FFF was found to install; the evaluation is recorded, and the decision
is revisited only with a measured benefit.

---

## ADR-010 — No compiler Skills, no compiler Adapter in this delivery

**Context** — the user's standing decisions: no preset Skills, no compiler adapters, no
PiEngineeringHarness migration.

**Decision** — the bundle ships no `SKILL.md`, mounts the standard `skill-filesystem` + `tool-skill`
pair unchanged (so user skills keep working through the normal discovery path), and defines no
analysis protocol. `docs/01-architecture.md` reserves the Adapter entry point without specifying it.

---

## ADR-011 — Capability source patches are pinned, applied by `install.sh`, and reversible

**Context** — A DSH *bundle* adds rows to a profile, but it cannot add a service method or a model
tool that the installed source lacks. The Agent Teams member-reclaim capability (terminal
`retired` phase + `retire_teammate`) is exactly such a change: rc.3's `agent-team` package has no
removal path and no `retired` phase. Two ways to deliver it existed: (a) land it upstream in
`deepseek-harness`, or (b) ship it as a pinned patch this delivery applies.

**Decision** — Ship it as a pinned capability patch (now `patches/0002-team-roles-slots.patch`, superseding the older 0002/0003 reclaim patches) and have `scripts/install.sh`
apply it to the checkout, idempotently and reversibly, then rebuild the Host `lib/`. Upstreaming is
out of scope for a delivery that must install on an unmodified rc.3 checkout. This extends the
earlier invariant: the profile's `cordis.patch.yml` is still never edited, but the checkout is now
modified by exactly one pinned, reversible patch.

**Evidence** — `scripts/lib/harness-patches.mjs` decides state from `git apply --check [-R]`:
`pending` / `applied` / `conflict`, never a silent skip. `tests/integration/harness-patches.mjs`
proves apply → idempotent re-apply → revert → conflict on a throwaway git tree.
`scripts/verify.sh` step 1c asserts the patch is applied AND that the built
`agent-team/lib/index.js` contains `retireTeammate`, so "applied but not rebuilt" fails loudly.

**Consequence** — `install.sh --no-harness-patch` skips it; `uninstall.sh --revert-harness` reverses
it. `rollback.sh` stays profile-only: the patch is source, not profile state, and is reversed on its
own. A checkout that has moved past the pinned base reports `conflict` and fails the install rather
than applying a fuzzy diff.

---

## ADR-012 — The runtime reclaims member slots automatically; explicit retire is for correction only

**Context** — 0002 gave the Lead an explicit `retire_teammate`, but relying on the model (or the user)
to call it is not "automatic": a long-horizon session still hits "`Team member limit 8 reached`" and
stops. The requirement is that DSH manage the roster, and that the user never has to write lifecycle
guidance into a prompt.

**Decision** — Two automatic behaviours, plus prompt guidance that the harness *injects* (not the
user): a failed creation never holds a slot, and when the limit is reached the least-recently-active
member that owns no open task and has been idle beyond `memberIdleGraceMs` (default 5 min) is
retired to make room. The `team:policy` system prompt now tells the model to reuse an idle teammate
before spawning. Explicit `retire_teammate` remains for correcting a mistake.

**Evidence** — `roster.ts` `reclaimForCapacity()` runs before every admitted spawn; `reclaimCandidate()`
skips running members and members owning `pending`/`in_progress` tasks, prefers `failed`, then
longest-idle. `team.spec.ts` proves: a failed creation is reclaimed by the next spawn without a
manual call; an idle member is reclaimed at the limit; a member owning an open task is NOT reclaimed
and the limit still reports. `tests/integration/harness-patches.mjs` proves the 0002→0003 patch
chain applies and reverts in order.

**Consequence** — Users create teammates and stop thinking about the limit; DSH makes room. The one
cost is that a reclaimed member is no longer addressable, so the durable pattern is a fixed roster
reused with `send_message`; the grace period keeps a between-rounds role from being reclaimed too
eagerly. `autoRetireFailed=false` and `memberIdleGraceMs=0` restore fully manual behaviour.

---

## ADR-013 — Role-first Team topology replaces dynamic spawn + role-blind reclaim

**Context** — The dynamic model (ADR-011/012) left three gaps: a "member name" carried four unrelated
responsibilities (role discovery, executor identity, context container, capacity), reclamation was
role-blind (LRU), and the send/task paths had no shared role contract, so work could reach the wrong
role. Names were also an unstable namespace with no rebuildable position.

**Decision** — Ship one pinned capability patch (`patches/0002-team-roles-slots.patch`) that makes a
role a first-class contract: `RoleSpec` with provider/model/`maxConcurrent`; a slot topology of four
reserved/pinned plus four flex slots; per-member `roleId/slotId/generation` where a slot is rebuilt
under `generation+1` and named `<slot>-g<gen>` (names stay permanently reserved). Spawn selects a
matching slot and applies the role's route; `retire_teammate` releases the slot; automatic reclamation
only targets failed members or idle flex members (never pinned). Role mismatch is refused at spawn,
task `claim/reassign` (`requiredRole`) and `send_message` (`expectedRole`); full capacity returns
explicit backpressure naming the blocked role. `stateVersion` 6; the new `team/slot` session event is
registered in the generated event vocabulary.

**Evidence** — Agent-team 68 + tool 6 + client 31 tests pass; three-package `tsc -b` and the full
`tsc -b tsconfig.host.json` are clean; the patch applies to `296181d1c2` (`git apply --check` exit 0).

**Consequence** — The user never writes role/lifecycle guidance: the injected policy carries the role
catalog and the routing rules, and the runtime enforces them. Automatic reclaim is safe because pinned
slots are protected and role-mismatched dispatch is structurally refused; capacity pressure is honest
backpressure, not a wrong-role fallback. This supersedes ADR-011/012's reclamation semantics.

---

## ADR-014 — Quota-driven provider-route failover is a sticky local bundle plugin

**Context** — The `corp` gateway enforces a per-day budget (~¥50). When it is spent, every
corp-family role (explorer/implementer/reviewer) fails identically on every attempt: the pi-ai
adapter flattens the `429 budget_exceeded` body into a generic `RATE_LIMIT`, so `llm-retry` spends
its bounded retries on a key that cannot recover until the next day. The roles' models are otherwise
fine; they just need the same model lineage on a different budget. Reconfiguring roles to magpie
would work but loses the "corp is primary / cheap" intent and has no automatic hand-off.

**Decision** — Ship `plugins/llm-fallback` (a TS plugin in the local bundle, loaded through the
Host's tsx loader; no checkout patch, no lib rebuild). It hooks two existing agent-loop waterfalls:
`agent/request` rewrites `provider/model` when an agent is pinned to a fallback; `agent/request-error`
advances the pin one hop and returns `{kind:'retry'}` on a quota/auth-class failure. Both are
registered with `prepend:true` so a quota failure is handled before `llm-retry` wastes retries.
Trigger is quota/auth-class only: `QUOTA`, `AUTH`, or a generic `RATE_LIMIT` whose message names
budget/quota (the corp case). The route table maps each corp model to its same-family magpie
counterpart, so quality is preserved (`auto/deepseek-v4.1-flash`, `auto/glm-5.3-flash`; the qwen
family is mapped to `group/qwen-3.8-flash`, the id declared in the live profile — see ADR-014
Addenda). The table maps `corp` routes only: `magpie` routes (including the
`group/*` role models) have no entry, so a magpie-side failure is never rewritten to another route.
Failover is **STICKY**: once advanced, an agent never returns
to the primary on its own — a per-day quota does not recover within a session, and toggling back
would re-hit the dead key and make the session non-deterministic. `globalSticky` also lets a sibling
agent start directly on the degraded route.

**Evidence** — `plugins/llm-fallback/logic.test.ts` + `wiring.test.ts` (18 tests: eligibility,
sticky, single-hop chain end, multi-hop bound, magpie pass-through, global sticky, prepend
registration, retry action) pass with `node --test`;
`verify.sh` step 1e runs them and asserts the row composes via `--dump-config`. The plugin resolves
and loads through the Host's own loader (`node --import tsx/dist/loader.mjs` from the profile cwd).
Failover does not drop context: every attempt rebuilds the whole history from the session.

**Consequence** — When corp budget is spent, the affected roles transparently continue on the magpie
same-family model until the next session/restart re-probes the primary. It is opt-in (the bundle row)
and profile-wide, but inert for routes not in the table. Switching model does not lose context, but
it does append a `[model changed]`-style notice and changes which model authored later turns; the
`assistant/message.source` records the actual route for audit.

### ADR-014 Addendum 1 (2026-11-04) — qwen route id corrected after the live test

The live end-to-end test after the first Host restart (`evidence/e2e/fallback-live/2026-11-04-live-test.md`)
found the qwen fallback target invalid: the magpie gateway no longer serves `auto/qwen3.8-flash` (its
`/v1/models` listed the qwen family only as `opencode-go/qwen3.8-flash` at the time), so the rewritten
request returned `404 not_found` (`PI_AI_ERROR`) and the explorer turn died. The DeepSeek and GLM
routes and `globalSticky` were verified working in the same run.

Fix (user-approved, Option A): the qwen route then targeted `magpie/opencode-go/qwen3.8-flash` (see
Addendum 2 for its current id). This was a one-line id change in the live profile
(`llm-pi-ai.providers.magpie.models`) plus the matching route in `bundles.patch.yml`. It
intentionally touches the user's model config, so `verify.sh` check 6 (profile byte-identical to the
pre-install backup) now additionally reports this approved delta — check 6 was already failing on a
pre-existing `agent-default-model` drift before this change.

Lesson: an offline suite that only parses routes and composes the row cannot catch a stale model id.
Only a real request to the provider can; the live probe is now the acceptance gate for this plugin.

### ADR-014 Addendum 2 (2026-11-05) — qwen target moved to `group/qwen-3.8-flash`

The live profile was refreshed with the current magpie model catalogue, which replaces the
`opencode-go/*` alias with the `group/*` family (the profile now declares `group/qwen-3.8-flash`
and no longer lists `opencode-go/qwen3.8-flash`). The qwen fallback target follows the catalogue:
`corp/Qwen3.8-Flash -> magpie/group/qwen-3.8-flash`.

Addendum 1's lesson still applies — the route id must be a *served, declared* id, so this is a
config-and-tests change only; the plugin code is unchanged. The offline suite mirrors the new id in
its fixtures, and the acceptance gate remains a real failover request on the running Host.
