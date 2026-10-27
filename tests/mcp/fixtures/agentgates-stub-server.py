#!/home/s00653124/workspace/AgentGates/.venv/bin/python
"""Deterministic MCP stdio server used by tests/mcp/tool-scope.mjs.

This is NOT the AgentGates server. It stands in for it so the DSH-side wiring
(scope visibility, process count, startup latency, RSS) can be measured without
depending on the Python gate implementation, and so the check stays runnable on
a machine where AgentGates is not configured.

It speaks the real MCP protocol over stdio through the official Python SDK, so
the bridge exercises a genuine handshake and a genuine tools/list. The tool
NAMES mirror the AgentGates surface, so a visibility assertion here is an
assertion about the names DSH will publish.

The executable bit and the shebang matter: the mcp-client row spawns this file
directly with an argv of `-s -m agent_gates.mcp_server` (the real entrypoint's
arguments), which this script accepts and ignores.
"""
import anyio
from mcp.server.mcpserver import MCPServer

TOOLS = (
    ("list_workspaces", "List registered AgentGates workspaces."),
    ("list_gates", "List the gates an adapter can run."),
    ("doctor", "Probe the local machine configuration (never evidence of a run)."),
    ("submit", "Submit a gate execution; returns immediately with an execution id."),
    ("status", "Read one execution's current lifecycle state."),
    ("wait", "Bounded wait for an execution to reach a terminal state."),
    ("cancel", "Cancel an execution; idempotent."),
    ("report", "Read a receipt with its re-verified current status."),
    ("verify", "Verify one receipt against the present machine."),
    ("verify_requirements", "Check a run satisfies a task's explicit requirements."),
)

server = MCPServer("agentgates-stub")


def register(name, description):
    """Register one no-op tool whose result is honest about being a stub."""
    @server.tool(name=name, description=description)
    def handler() -> dict:
        return {"stub": True, "tool": name}


for _name, _description in TOOLS:
    register(_name, _description)


if __name__ == "__main__":
    anyio.run(server.run_stdio_async)
