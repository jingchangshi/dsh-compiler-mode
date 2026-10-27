# 01 — Architecture

This document describes the composition that actually exists after implementation, not the
proposal it started from. Everything below is checkable with
`node apps/cli/lib/bin.js --profile web --dump-config` and
`tests/integration/composition-suite.mjs` (44/44 deterministic checks).

---

## 1. Host / Profile / Preset

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ dsh installation (dsh-v0.2.1-rc.3 @ 1f81c047fc)                              │
│   @deepseek-ai/dsh-base        core services: session, llm, tools registry,   │
│                                sandbox, subagent registry, spill, token meter│
│   @deepseek-ai/dsh-web-app     Web transport + host-plane agent rows DISABLED │
│                                + the four shipped preset declarations         │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ profile patch layers, in order
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ profile "web"  ($DSH_HOME/profiles/web)                                      │
│   package.json   dsh.profile.bundles =                                       │
│     [dsh-base, dsh-web-app, @local/dsh-ai-compiler-preset]                   │
│   cordis.patch.yml  user layer (models, permission default) — UNTOUCHED      │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ bundle patches of @local/dsh-ai-compiler-preset
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ bundles.patch.yml   HOST plane (added by this bundle)                        │
│   lsp / lsp-stdio(clangd) / tool-lsp                                         │
│   agent-team / tool-agent-team / ui-agent-team                               │
│ cordis.patch.yml    PRESET plane                                             │
│   insert preset-ai-compiler  (config.id: ai-compiler)                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

A session binds to a preset at creation (`session/create { agentPreset }`), the Host records it in
the session header, and the preset's child plugins are mounted in a registry-owned scope once and
shared by every Agent that selects that revision.

---

## 2. Cordis plugin tree (Web profile, relevant rows)

`H` = host plane, `P` = preset plane. Groups are the preset's `cordis:group` isolate realms.

```text
dsh-base (H)
├── session, session-persistence-jsonl, session-projection, session-query-sqlite
├── llm, llm-pi-ai, agent-default-model          ← profile patch sets provider/model
├── tools                                         mode: native (schema default)
├── system-prompt, agent-loop, subagent, subagent-{spawn,fork}-in-process
├── ptc-runtime          @deepseek-ai/dsh-ptc-runtime-node   (per-call)
├── spill-local, spill-policy                    maxInlineTokens: 12500
├── token-meter, timeout-policy, image-offload, session-checkpoint-policy
├── sandbox, sandbox-policy, bash-sandbox, fs-sandbox, approval, permission
└── (agent rows: tool-bash/tool-fs/tool-todo/… disabled by web-app)

dsh-web-app (H)  … webserver, connection, modules, session-controller, ui-*
└── agent-preset-registry  default: standard
    preset-standard / preset-ptc / preset-minimal / preset-cordis   (shipped, untouched)

@local/dsh-ai-compiler-preset
├── bundles.patch.yml (H)
│   ├── lsp            @deepseek-ai/dsh-lsp
│   ├── lsp-stdio      servers.clangd  (--background-index=0 --pch-storage=memory --log=error)
│   ├── tool-lsp       @deepseek-ai/dsh-tool-lsp
│   ├── agent-team     @deepseek-ai/dsh-experimental-agent-team   maxMembers 8 / maxTasks 256
│   ├── tool-agent-team  freshProvider spawn / forkProvider fork
│   └── ui-agent-team  @deepseek-ai/dsh-experimental-client-ui-agent-team
└── cordis.patch.yml (P) preset-ai-compiler  order 3
    ├── persona                       "AI compiler engineering agent"
    ├── agent-instructions, time-context
    ├── tool-bash | tool-pwsh (platform), tool-fs, tool-fs-search, tool-jobs, tool-schedule
    ├── skill-filesystem, tool-skill            ← user skills keep working, no preset skills
    ├── command-goal, tool-goal
    ├── planning  { isolate: planMode }         plan-mode
    ├── compaction { isolate: compaction, toolResultPruner }
    │     ├── compaction-basic
    │     ├── command-compact
    │     └── tool-result-pruner   thresholdChars 20480 / head 12288 / tail 4096   ← DIFF
    ├── delegation { isolate: workflowEngine }
    │     ├── tool-subagent-control, tool-subagent-list-agents
    │     ├── tool-subagent (spawn), tool-subagent-fork
    │     └── workflow-ptc, tool-workflow (disabled)
    ├── tool-ask-user, tool-todo, tool-web
    ├── tool-presentation   mode: ptc          ← the model sees run_code only
    ├── present
    └── tool-plugin-manager, tool-plugin-market (disabled)
```

Team tools are **not** preset rows: `tool-agent-team` installs nine tools into each Team member's
Agent scope, and the PTC SDK enumerates that same Agent-scoped view, which is why they appear inside
`run_code` (verified: 31 SDK bindings, see §4).

---

## 3. PTC tool execution sequence

```text
model ── tool/call(run_code) ──► ToolRuntime.prepareExecution
                                   ├─ tools/pre-execute waterfall
                                   ├─ approval (ask|never)      ← standing sandbox policy
                                   └─ guards
                                 ──► run_code body (ptc.ts)
                                       ├─ runtime.resolve({program, bindings, cwd, sandboxPolicy, timeoutMs})
                                       │     bindings = registry.schemas(exec.agent)  ← agent's visible view
                                       ├─ spawn ONE Node child under the SAME sandbox policy
                                       │     (danger-full-access ⇒ unconfined; else ctx.sandbox.confine)
                                       └─ program calls await tools.<name>(args)
                                             └─ per sub-call the SAME scheduler runs again:
                                                prepare (pre-execute + approval + guards)
                                                → dispatch (tools/execute waterfall → tool body)
                                                → finalize (tools/post-execute) → tools/result
                                                                                          │
                     only the OUTER result enters the transcript ◄───────────────────────┘
                     (logs + returned JSON + sandbox notice; bounded by maxOutputBytes)
                     sub-calls are logged as tool/ptc-dispatch(-start), log-only events
```

Measured properties (see `docs/06-tests.md`):

| Property | Mechanism | Evidence |
|---|---|---|
| Model sees only `run_code` | `wireSchemas()` collapses the wire list | `session-evidence.json` counts: `tool/call` names = `run_code` |
| SDK = agent-visible tools | `registry.schemas(exec.agent)` | 31 bindings incl. `lsp` + 9 Team tools |
| Nested calls keep permissions | same scheduler path | suite check + case-B validator denial/allow |
| Raw sub-results stay out of context | only outer result appended | a program reading 12 files returns one small JSON |
| Timeout / cancel | 120 s default, 600 s cap; child killed as a managed range | case-C timeout test |
| Output bound | `maxOutputBytes` 64 MiB → `output-limit` | case-C long-output test |

---

## 4. Agent Team creation and messaging

```text
Lead (session S, preset ai-compiler)
  │ run_code → tools.spawn_teammate({name, description, prompt, context})
  ▼
TeamService.spawnTeammate  (packages/experimental/agent-team)
  ├─ journal team/member {phase: provisioning}   → Lead session log, flushed
  ├─ subagents.startActivation({provider: spawn|fork, childId: uuid, parent: Lead})
  │     └─ subagent manager materialises the child:
  │          composition = composeFrom(child.ctx, lead.ctx)   ← SAME preset revision
  │          policy      = Lead's explicit sandbox override + approval PINNED to "never"
  │          (fork only) seed = Lead's events through the last turn/end
  └─ journal team/member {phase: active}
  ▼
Teammate runs its own Agent loop (same tools, same PTC presentation)
  │  send_message(target) → target.steer() → next step boundary of the target
  │  team_task_*          → Lead log, compare-and-set on `revision`
  │  wait_agent(timeout)  → one-shot waiter, 10 s…1 h, never wakes an inactive member
  ▼
Lead: list_agents → wait_agent → team_task_get → final answer
```

Recovery: Team state is append-only in the **Lead's** session log, so a restart reconstructs roster
and task board; members come back `inactive` until a `send_message` cold-resumes them from their own
log (route, preset and permission restored from the child's events).

---

## 5. Session / artifact / compaction data flow

```text
tool executes ──► full result
      │                │
      │                ├──► spill-policy (host, 12500 est. tokens)
      │                │        └─► spill-local: $TMPDIR/dsh-spill-*/session-<hash>/<rand>-<name>.txt
      │                │             (dir 0700, file 0600) + notice with the absolute path
      │                └──► tool-result-pruner (preset realm, only when compaction qualifies)
      │                         └─► head 12288 + marker + tail 4096
      ▼
model-visible tool/result  (surface)
      │
session log (append-only JSONL, never rewritten)
      │     compaction: compaction/start → compaction/summary → user/message(replace) → compaction/end
      └──► full history, every spilled path, every pptc dispatch
```

Three distinct mechanisms, deliberately not merged:

| Mechanism | Owns | Where |
|---|---|---|
| PTC | intermediate result orchestration — what reaches the model from a program | preset (`tool-presentation`) |
| Spill | keeping an oversized **tool result** retrievable | host (`spill-*`) |
| Compaction | managing the **conversation surface** | preset isolate realm |

---

## 6. Permission scope

```text
                ┌──────────────── Tool visibility ────────────────┐
preset rows ──► │ tools registry: scoped registrations shadow     │  → model-facing schemas
                │ globals; restrictions intersect                 │  → PTC SDK binding list
                └─────────────────────────────────────────────────┘

                ┌──────────── Runtime permission ─────────────────┐
sandbox-policy ─│ read-only | workspace-write | danger-full-access│  → bash wrapper, fs fence,
approval       ─│ ask | never                                       │    PTC child confinement
                └─────────────────────────────────────────────────┘
child agents ──► inherit the Lead's explicit sandbox override, approval pinned to "never"
                 (a child can never widen its own scope)
```

Measured on this host: the sandbox provider's Linux chain (`bwrap`→`landlock-run`) is unusable, so
`read-only`/`workspace-write` fail closed and only `danger-full-access` executes. Details and the
resulting acceptance method: `docs/05-permissions.md`.

---

## 7. Reserved entry points (not implemented here)

- **Compiler Adapter**: a future host- or preset-scoped provider that registers additional tools
  (e.g. IR dump analysis) through the ordinary `ctx.tools.register` path. No protocol is defined
  here because none has been validated.
- **MCP / external tool providers**: `ai-compiler` DOES add one, and it is no longer reserved: the
  compiler presets mount `@deepseek-ai/dsh-mcp-client` as `mcp-agentgates` to reach the AgentGates
  gate server over stdio. It is preset-scoped rather than host-scoped precisely so the other modes
  cannot see the gate tools. Cost, visibility and the measured numbers: `docs/10-mcp-wiring.md`.
- **Other MCP servers**: any further `mcp-*` row may be added the same way; the shipped
  `mcp-resources` host row remains the way to bridge resources rather than tools.
- **Multi-writer Worktree isolation**: `@deepseek-ai/dsh-experimental-tool-worktree` exists as an
  official optional bundle; it is documented in `docs/08-compatibility.md` but is not a dependency of
  this mode.
