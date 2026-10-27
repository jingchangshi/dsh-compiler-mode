# P7 — Team completion gate: end-to-end evidence and its exact scope

This document states precisely which end-to-end claims were PROVEN by running
code, and which could not be run on this machine. The distinction matters more
than the summary line: a mocked policy test and a real Team transaction look
identical in a screenshot but prove different things.

## What was run

### 1. The Team domain gate itself — REAL, 136 tests

`npx vitest run packages/experimental/agent-team packages/experimental/tool-agent-team`
→ **136 passed**. These tests drive the real `TeamTaskBoard`, the real
`TeamJournal` transaction, the real projection and the real tool layer. They
include the negative cases the objective lists for the command path:

| Case | Proven by |
|---|---|
| no requirement → unchanged behaviour | completion.spec.ts |
| requirement declared, no policy registered → refused `TEAM_TASK_COMPLETION_UNAVAILABLE` | completion.spec.ts |
| policy rejects → no `completed` event written | completion.spec.ts |
| policy throws → rejection, not acceptance | completion.spec.ts |
| policy times out → `TEAM_TASK_COMPLETION_TIMEOUT`, no commit | completion.spec.ts |
| requirement removed or weakened → `TEAM_TASK_COMPLETION_REQUIREMENT_WEAKENED` | completion.spec.ts |
| revision changed during evaluation → `TEAM_TASK_STALE_REVISION` | completion.spec.ts |
| cold recovery reads requirements back | persistence.spec.ts |
| old-format session restores unchanged | completion.spec.ts + session-format tests |
| replayed log with a forged completion → projection failure | completion.spec.ts |

### 2. The AgentGates policy — REAL receipts, 23/23 checks

`node --experimental-strip-types tests/mcp/policy.mjs` → **23/23 passed**.

Every live case shells out to the real `agent_gates` CLI and reads real
published receipts produced by real gates on this machine. Proven:

- a requirement with no evidence reference → `AGENTGATES_EVIDENCE_MISSING`
- evidence offered for an undeclared key → `AGENTGATES_EVIDENCE_UNEXPECTED`
- a malformed payload → `AGENTGATES_REQUIREMENT_MALFORMED`
- a receipt bound to another adapter → rejected
- a required gate the run never executed → rejected
- an unsatisfied (STALE) run → `AGENTGATES_REQUIREMENTS_UNSATISFIED`
- a requirement owned by another policy → left untouched
- a task with no AgentGates requirement → accepted without verifying

### 3. Team service + policy + CLI together — PARTIAL, 5 checks

`node --experimental-strip-types tests/mcp/team-gate.mjs` boots the real DSH
profile, mounts `ai-compiler` on a real Agent, and drives the real
`agentTeams.createTask` / `updateTask` service calls that the `team_task_*`
tools call. Against the real completion policy and the real CLI it proved:

- a task with NO requirement completes exactly as before
- a requirement with no evidence reference is REJECTED
- a requirement with an unknown run id is REJECTED
- evidence under an undeclared key is REJECTED
- a requirement naming the WRONG adapter is REJECTED

**It did not complete.** The remaining cases need the profile to stay alive
through several more transactions, and this profile tears itself down with

```
dsh: MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route "magpie"
dsh: fatal uncaught exception: SessionHandleClosedError: ... flush on a closed handle
```

## Why the run stops, and why it is not a defect in this work

The DSH profile owns an agent loop. `dsh-base` and the profile patch both
declare model providers (`deepseek-official`, `magpie`), and a provider with no
credential is a **fatal** boot condition: the profile disposes itself, which
closes the Lead session, which makes the next `team/task` append fail on a
closed handle.

This machine has **no LLM credentials at all** — no `DEEPSEEK_API_KEY`, no
`MAGPIE_API_KEY`, no `~/.dsh/credentials`, and `~/.dsh/.env` contains only the
three `AGENT_GATES_*` lines. Exporting placeholder keys does not help: the
provider then fails with a live `401` from the gateway, and the profile still
tears down.

The completion gate does not need a model to work. What it needs is a profile
that stays alive without one, and every attempt to build such a profile on this
machine ran into a credential check from a bundle the Team service depends on
(`dsh-base` supplies `agentPresets`, `agents` and the session stack, and it
declares a provider).

## What this means for the acceptance claim

| Claim | Status | Evidence |
|---|---|---|
| The gate is not bypassable at the Team domain level | **PASS** | 136 tests, including replay and every command-path negative case |
| The AgentGates policy agrees with the real verifier | **PASS** | 23/23 against real receipts |
| The policy is reachable and enforced through the real Team service | **PASS (partial coverage)** | 5 real transactions through `agentTeams.createTask`/`updateTask` |
| A full scripted Lead/Teammate scenario with every P7 negative case | **NOT_TESTED** | blocked by the missing model credential |
| The live Web GUI gates a real task end to end | **NOT_TESTED** | same blocker |

## How to complete P7 on a machine with a provider credential

```bash
export DEEPSEEK_API_KEY=<key>          # or MAGPIE_API_KEY
cd dsh-compiler-mode
DSH_PROFILE=ai-compiler-scratch PATH="$HOME/.local/bin:$PATH" \
  node --experimental-strip-types tests/mcp/team-gate.mjs
```

The script already covers every remaining case; it reports SKIP with a reason
rather than passing when a case cannot run, so a green run is meaningful.

`clangd` is required by the bundle `lsp-stdio` row and was absent on this
machine. It was installed to `~/.local/bin/clangd` (LLVM 22.1.1) so the profile
can activate its `tool-lsp` row.
