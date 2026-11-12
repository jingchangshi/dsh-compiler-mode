# 09 — Operations

## Daily use

1. Open the Web GUI, start a new chat, pick **AI Compiler Engineering** in the preset chip.
2. The model only sees `run_code`; it reaches every other tool from inside a program.
3. Team work: the Lead spawns teammates with `spawn_teammate`, coordinates with `send_message`,
   the shared task board, and `wait_agent`.
4. Source navigation: `tools.lsp` with `goToDefinition` / `findReferences` / `hover` works on any
   C/C++ file under the session's working directory (clangd picks up the nearest
   `compile_commands.json`).

### Roles and slots

Teammates are **roles**, not per-task hires. Six roles (architect, explorer, implementer, reviewer,
challenger, validator) each fix a model route and a concurrency cap. The team has four reserved/pinned
slots and four flexible slots; spawning fills a matching slot and names the member `<slot>-g<gen>`.
Dispatch by role with `spawn_teammate({ role, task })`; reuse an idle teammate of the same role with
`send_message` (pass `expected_role` to assert) before creating a new one. A task's `required_role` is
enforced on claim/reassign, and a mismatched `expected_role` send is refused — work is never silently
routed to the wrong role. When capacity is full the runtime returns **backpressure** naming the blocked
role: wait, or retire a finished member; it will not steal a pinned role. A retired member keeps its
name forever but is no longer addressable.

#### A role's route depends on the preset

`spawn_teammate` takes only `role`, `task`, `context`, `slot`, `description` — there is **no** provider,
model or `agent_options` parameter, and no session can choose a route. The route comes from the Host row
`agent-team`'s `presetRoles`, keyed by the **Lead's** preset id (`config/bundle-ai-compiler/cordis.patch.yml`
declares `config.id: ai-compiler` / `ai-compiler-magpie`; the tables live in `bundles.patch.yml`):

| role | `ai-compiler` (order 5) | `ai-compiler-magpie` (order 6) | max concurrent |
|---|---|---|---|
| architect | `magpie` / `group/architect` | `magpie` / `group/architect` | 1 |
| explorer | `corp` / `Qwen3.8-Flash` | `magpie` / `group/explorer` | 2 |
| implementer | `corp` / `DeepSeek-V4.1-Flash-1017` | `magpie` / `group/implementer` | 2 |
| reviewer | `corp` / `GLM-5.3-Flash` | `magpie` / `group/reviewer` | 1 |
| challenger | `magpie` / `group/challenger` | `magpie` / `group/challenger` | 1 |
| validator | `magpie` / `group/validator` | `magpie` / `group/validator` | 1 |

A preset with no entry in `presetRoles` falls back to `agent-team.roles` (the built-in mixed table,
identical to the `ai-compiler` column above). A table **replaces** `roles` wholesale — it is never
merged field by field — and because one `slotPlan` serves every preset, each table must name every
reserved role (architect, reviewer, explorer, implementer) or startup validation rejects it.

**To change a route**: edit that preset's table under `agent-team.presetRoles` in
`config/bundle-ai-compiler/bundles.patch.yml`, reinstall the bundle, then **restart the Host**. Nothing
at runtime can change it — not a task, a message, nor anything the Lead passes to `spawn_teammate`.

### Adding or renaming a model

The model catalog is **not** owned by this bundle. It lives in the profile's user layer,
`$DSH_HOME/profiles/web/cordis.patch.yml` (this deployment's `llm-pi-ai` row), and `install.sh`
never writes it — that file is the operator's, and `scripts/verify.sh` step 6 fails if the installer
ever touches it. Two separate things must agree:

| what | where | who owns it |
|---|---|---|
| the id the provider serves | `llm-pi-ai.providers.<provider>.models` in the profile's `cordis.patch.yml` | operator |
| the id a role asks for | `agent-team.presetRoles.<preset>[].model` in `bundles.patch.yml` | this bundle |

To add a model:

1. Add it under the right provider in the profile's `cordis.patch.yml`. Copy `maxTokens` and
   `contextWindow` from the provider's own numbers — a wrong `maxTokens` does not fail loudly, it
   truncates. Declare `reasoningEfforts` only if the provider actually accepts them.
2. Restart the Host. The catalog is read at start-up.
3. Only if a **role** should use it, change that role's `model` in `bundles.patch.yml`,
   `scripts/install.sh`, restart.

**A model id that is never declared does not fail at start-up.** Core routing accepts any id, so the
Host comes up healthy, `--dump-config` looks right, and the first `spawn_teammate` for that role dies
with `UNKNOWN_MODEL` — which reads like a Team defect rather than a typo. `verify.sh` step 1f now
resolves all twelve routed pairs against the profile's own catalog and fails with the exact missing
ids.

The related trap is that the throwaway acceptance profile (`ai-compiler-scratch`) declares **no**
operator models — it is built from the shipped template, which knows only the public ones. A routed
`group/*` model therefore resolves in `web` and not in `scratch`; that is why the cross-check lives
in `verify.sh` (which reads the live profile) and not in the composition suite.

**Reasoning effort**: only a model that declares `reasoningEfforts` accepts an effort at all; every
other route refuses with `UNSUPPORTED_REASONING_EFFORT`. `RoleSpec` has no effort field and
`spawn_teammate` takes no effort parameter, so a role's effort is not configurable here — it comes
from the model's own declaration, if any.

## After any configuration change

**Restart the Host.** A running Host keeps its start-up composition; new or removed rows only
appear after a restart. Symptom of a stale Host: `--dump-config` lists a row the model cannot call.

## Health checks

```bash
node tests/preset/verify-preset.mjs             # declaration still equals PTC + declared diffs
node tests/integration/composition-suite.mjs    # 59 deterministic checks, incl. the routes drift guard
node tests/integration/harness-patches.mjs      # capability-patch apply/idempotent/revert/conflict
node tests/permissions/permission-suite.mjs     # 4 allow/deny checks
node scripts/lib/harness-patches.mjs status     # source-patch state: 0002 roles/slots, 0003 preset routes
scripts/verify.sh                               # all of the above + profile untouched
```


## 关于本套件的一个已知陷阱（2026-11-11 记录）

> 本套件的判定曾经只看 `results` 里失败项的个数。如果中途抛异常导致前面已经跑完的检查
> 被截断，剩下的全是 PASS，于是**半途而废的运行会打印绿色并 exit 0**。这个问题已修复：
> 现在有 `uncaughtException`/`unhandledRejection` 处理器与外层 `catch (fatal)`，
> 任何逃逸的异常都会记成一条 `[harness]` 失败并把整轮判为 FAIL。
>
> 记录在此只是提醒将来的人：**“N/N checks passed” 这句话本身不足以证明全部检查都跑过**。
> 判断一轮是否可信，要同时看退出码、检查总数、以及每个 group 是否都出现过。
> 其他测试脚本是否也有同类写法，本文件不做结论（未逐一审计）。

## Reading the evidence

| Question | Where |
|---|---|
| Did a run really happen? | `evidence/e2e/<case>/run-*/web-run.json` (status, session id, transcript) |
| What did the model actually call? | `session-evidence.json` → `toolCalls`, `ptcDispatches`, `counts` |
| What did the model see? | `final-answer.md` and the transcript in `web-run.json` |
| Token/tool accounting | `evidence/benchmarks/*/summary.json` |
| Why was a design chosen? | `docs/03-decisions.md` (ADR) |

## Cost and limits

- Each `run_code` is a **fresh Node process** under the session's sandbox policy; long programs
  cost process start-up time and are bounded by `timeoutMs` (default 120 s, cap 600 s).
- A `wait_agent` inside `run_code` consumes the *program's* budget: use bounded waits
  (`timeout_ms` 10 000…3 600 000) and re-list instead of waiting inside one program for minutes.
- Spill artifacts live under a **per-process** temp root (`/tmp/dsh-spill-*`), so they do not
  survive a Host restart and are reclaimed only by the age sweep (`cleanupPeriodDays`, default 30).
  Copy anything you must keep.

## Failure playbook

| Symptom | Cause | Action |
|---|---|---|
| the preset chip does not list the mode | Host started before the bundle was installed | restart the Host |
| `agent-preset/not-found` on an old session | the preset was uninstalled | reinstall, or start a new session |
| `agent-preset/invalid: … never started` | a preset row names a package that is not an `apply()` plugin (e.g. a bare `Service` class) | move that row to the Host plane |
| `spawn_teammate` is `undefined` in `run_code` | stale Host (Team rows missing) or the Team bundle not selected | restart; check `--dump-config` for `tool-agent-team` |
| `SandboxUnavailableError` for `workspace-write` | no usable OS sandbox on this host | see `docs/05-permissions.md`; the mode does not weaken this |
| `FS_STALE_VERSION` on `write`/`edit` | another writer touched the file | re-read, rebase, retry (Lead is the only writer) |
| `Team member limit N reached` (`TEAM_MEMBER_LIMIT`) | lifetime teammate slots exhausted; names are permanent and only retirement returns a slot | reuse a fixed roster with `send_message`; if the patch is applied, `retire_teammate` idle members |
| `retire_teammate` is `undefined` in `run_code` | team-reclaim patch not applied, or applied but `lib/` not rebuilt | `node scripts/lib/harness-patches.mjs status`; run `scripts/install.sh` (or `pnpm run build:lib:host`) |
| `TEAM_MEMBER_RUNNING` when retiring | the target has a live turn | `interrupt_agent` it, then `retire_teammate` |
| `unknown tool "<name>"` or `code run failed (abort)` while a teammate/Lead program is running | the **live** `package.json` bundle list was edited mid-run; HMR recomposed the profile (`Hmr.reconcileProfile` -> `recomposeProfile`), restarting the `agent-team` / `tool-agent-team` plugins, which drops agent-scoped tools and aborts in-flight `run_code` programs | never edit `~/.dsh/profiles/web/package.json` during a run; prove last-row-wins with `scripts/lib/last-row-wins-demo.sh` (throwaway profile copy). See `docs/15-tool-call-failure-postmortem.md` |
| a validator reports `unknown tool: run_code` but made **no** tool call | model confabulation on a weak route, usually primed by repeating the phrase in the prompt; the `request/header` still offers `run_code` | re-task on a fresh validator and do not repeat the error phrase; confirm from the event log that a `tool/call` was actually attempted |
