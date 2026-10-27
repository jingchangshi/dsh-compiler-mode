#!/usr/bin/env python3
"""Print the passing receipts of the local AgentGates install as JSON.

Used by tests/mcp/policy.mjs so the completion policy is exercised against
REAL evidence rather than a fabricated receipt. A receipt qualifies only when
it is PASS, re-verifies as PASS, and belongs to a registered workspace.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, ".")

from agent_gates.config import load
from agent_gates.evidence import EvidenceStore
from agent_gates.registry import Registry


def main() -> int:
    config = load()
    store = EvidenceStore(config.evidence_root)
    registry = Registry()
    roots = {str(workspace.source_root): workspace.id
             for workspace in config.workspaces.values()}
    found = []
    stale = []
    runs = store.root / "runs"
    if not runs.is_dir():
        print("[]")
        return 0
    for entry in sorted(runs.iterdir()):
        if not entry.is_dir():
            continue
        try:
            receipt = store.read(entry.name)
        except (OSError, ValueError):
            continue
        if receipt.get("status") != "PASS":
            continue
        # A receipt that records PASS but no longer re-verifies is exactly the
        # STALE case the gate must refuse, so it is collected too.
        if store.verify(entry.name, registry=registry).get("status") != "PASS":
            if any(workspace_root == str((receipt.get("source") or {}).get("root"))
                   for workspace_root in roots):
                stale.append({
                    "label": receipt["adapter"]["id"] + "-stale",
                    "workspace": roots[str((receipt.get("source") or {}).get("root"))],
                    "adapter": receipt["adapter"]["id"],
                    "gates": [gate["gateId"] for gate in receipt.get("gates", [])
                              if gate.get("status") == "PASS"],
                    "staleRunId": receipt["runId"],
                    "stale": True,
                })
            continue
        workspace = roots.get(str((receipt.get("source") or {}).get("root")))
        if workspace is None:
            continue
        found.append({
            "label": receipt["adapter"]["id"],
            "workspace": workspace,
            "adapter": receipt["adapter"]["id"],
            "gates": [gate["gateId"] for gate in receipt.get("gates", [])
                      if gate.get("status") == "PASS"],
            "passingRunId": receipt["runId"],
        })
    print(json.dumps(found + stale))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
