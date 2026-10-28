# MCP wiring: measured process, latency and memory cost

The compiler modes reach the AgentGates gate server over the official
`@deepseek-ai/dsh-mcp-client`. This document records what that costs on this
machine, because the choice between a per-preset stdio child and a shared
long-lived service has to rest on measurements rather than on a guess.

Reproduce with:

    node tests/mcp/tool-scope.mjs

Add `--stub` to measure against `tests/mcp/fixtures/agentgates-stub-server.py`
(a real MCP server that publishes the same ten names) on a machine without a
configured AgentGates, and `--server <path>` to point the row at another
program. The JSON report is written to `evidence/tests/mcp-tool-scope.json`.

## What is being measured

The bridge row lives **inside each compiler preset**, not in the host bundle
layer:

    - id: mcp-agentgates
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: agentgates
        command: !!js process.env.AGENT_GATES_MCP_PYTHON ?? '<venv>/bin/python'
        args: ['-s', '-m', 'agent_gates.mcp_server']
        env:
          AGENT_GATES_CONFIG: !!js process.env.AGENT_GATES_CONFIG ?? (process.env.HOME + '/.config/agent-gates/config.toml')
        toolCallTimeoutMs: 120000
        failOnStartupError: false
        reconnect:
          enabled: true

`tools.register()` writes into `ScopedLayers` keyed by `scopeOf(ctx)`, and
`tools.view(scope)` resolves along the scope chain. A row owned by a preset
therefore registers into that preset's layer, and only Agents bound to that
preset see it. A host row would have registered globally.

## Measured result (2026-10-27, DSH rc.3, profile `ai-compiler-scratch`)

Every row below was produced on six separate boots; the "bridges at boot"
column is identical on all of them, which is the finding: the bridges appear
when the PRESETS register, not when a session picks a mode.

| Property | Measured |
|---|---|
| Bridge children spawned at boot, before any Agent | **2 on every boot** — one per compiler preset, including on a `standard`-mode boot |
| Bridge children added by creating an Agent | **0** |
| Sharing | one child per preset generation, shared by every Agent of that preset |
| Boot-to-ready (preset mounts registered) | **1.29 – 1.36 s** |
| Agent creation once the bridge is live | **8 – 16 ms** |
| RSS per bridge child | **67.5 – 67.6 MiB** |
| Total RSS for the two bridges | **~135 MiB** |
| Visibility: `ai-compiler` | all **10 / 10** `mcp__agentgates__*` tools |
| Visibility: `ai-compiler-magpie` | all **10 / 10** |
| Visibility: `standard`, `ptc`, `minimal`, `cordis` | **0 / 10** in every case |

Per-boot detail (every boot registers every preset, which is why all six rows
show the same count):

| Boot probing preset | boot ms | Agent create ms | bridges at boot | bridges with Agent | bridge RSS |
|---|---|---|---|---|---|
| ai-compiler | 1362.2 | 9.3 | 2 | 2 | 67.5 + 67.6 MiB |
| ai-compiler-magpie | 1311.6 | 15.5 | 2 | 2 | 67.5 + 67.5 MiB |
| standard | 1317.7 | 9.4 | 2 | 2 | 67.5 + 67.5 MiB |
| ptc | 1286.1 | 14.2 | 2 | 2 | 67.5 + 67.6 MiB |
| minimal | 1299.9 | 8.3 | 2 | 2 | 67.5 + 67.5 MiB |
| cordis | 1285.3 | 9.4 | 2 | 2 | 67.6 + 67.6 MiB |

## What this decides

1. **Cost is per DSH process, not per Agent.** Both compiler presets mount at
   registration (preset mounts are eager), so a DSH process always pays exactly
   two bridge children — about 135 MiB — even when the human is using Standard
   mode. Scaling to more concurrent compiler Agents adds nothing. Concretely:
   **a Standard-mode session also carries both compiler-mode bridges, and the
   only way to stop paying for them is to uninstall the bundle** (`scripts/uninstall.sh`
   deselects the preset layer, after which no compiler preset mounts and no
   bridge spawns). Because presets mount eagerly at registration rather than on
   first use, this cost is paid by every DSH process for as long as the bundle
   is installed, not only by sessions that select a compiler mode.
2. **No Agent-count-scaling problem.** Because Agents share the preset's child,
   an eight-member Team under `ai-compiler` still holds two python processes,
   not eight. The ADR-001 stdio choice stands for this deployment.
3. **`toolCallTimeoutMs` stays bounded.** A single `tools/call` may run a
   read-only verification over a compiler checkout, so the 60 s default is
   short; 120 s is the compromise. This does not license blocking: `wait`
   clamps its own timeout and returns a status, so a build never pins one call
   for its whole duration.
4. **A broken bridge looks like "no tools", by design.** The row sets
   `failOnStartupError: false` so an unconfigured or down AgentGates cannot take
   the whole compiler mode offline — `mountPreset()` rejects the entire preset
   when one row fails. The cost of that choice is silence, so
   `scripts/verify.sh` asserts the registered tool names and
   `agent-gates doctor` reports the server side.

## Server restart: what is and is not guaranteed

`reconnect.enabled: true` is set on the row, and the client's supervisor does
react to a lost child — it logs `connection lost; reconnecting in 500ms (attempt
1/10)` and withdraws the tool registrations (the tool names stop resolving
immediately, which is the safety-relevant half: the model cannot call a tool
that is gone). **Full recovery was measured as NOT working inside a scripted
profile boot**: after killing the bridge children, the supervisor emitted the
first reconnect warning, issued exactly one further spawn, and that replacement
died without ever publishing tools, leaving the count at zero for the following
tens of seconds.

That measurement is recorded here rather than asserted as a test, for two
reasons. First, a scripted boot is not a supported hosting environment for the
supervisor — the long-lived Host is, and the client's own test suite
(`packages/mcp/mcp-client/tests/reconnect.spec.ts`) covers crash-driven
reconnection against a fixture server. Second, the honest operational statement
is the safe one: **treat a dead bridge as requiring a Host restart or a plugin
reload, not as self-healing.** `scripts/verify.sh` step 2b is what turns that
into a visible fact — it asserts the registered tool names, so after an
incident the operator sees a failure instead of an empty tool list.
`failOnStartupError: false` is unaffected by this: it governs activation, not
recovery, and it remains the right choice so that a missing server cannot take
the whole compiler mode offline.

## Isolated RPC cost (the gate server itself)

The bridge process is only the transport. A single MCP round trip from a
client that spawns the server, initializes, lists tools and exits costs one
interpreter start (~1.3 s cold, measured via the boot column above, which
includes it). Tool calls after that handshake are sub-millisecond on the
client side because they are stdin/stdout writes; the real cost inside any
call is the gate execution the server performs, which is measured separately
in `docs/07-benchmarks.md` and is deliberately asynchronous — `submit`
returns an execution id and the model polls with a bounded `wait`.

## Reproducing the numbers

    cd ~/workspace/dsh-compiler-mode
    node tests/mcp/tool-scope.mjs                       # real gate server
    node tests/mcp/tool-scope.mjs --stub                # deterministic stand-in
    node tests/mcp/tool-scope.mjs --json /tmp/scope.json

Exit code 0 means every assertion passed; the measurement block is printed as
one `MEASURED {...}` line and written to `evidence/tests/mcp-tool-scope.json`.
