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
