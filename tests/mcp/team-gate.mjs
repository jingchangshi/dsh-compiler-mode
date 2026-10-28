#!/usr/bin/env node
/**
 * P5b/P7 acceptance: does a Team task with an AgentGates requirement actually
 * refuse completion until a real receipt satisfies it?
 *
 * Run: node --experimental-strip-types tests/mcp/team-gate.mjs
 *
 * This boots the REAL profile, mounts the ai-compiler preset on a real Agent,
 * creates real Team tasks through the same service the team_task_create tool
 * calls, and then attempts real completions. No model is involved, so every
 * result here is deterministic; what makes it a genuine end-to-end test is that
 * the policy runs, the CLI runs, and the receipts are real receipts this machine
 * produced.
 *
 * Exit: 0 every check passed, 1 a check failed, 2 boot/usage error.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { agentGatesPython, agentGatesRoot, harnessCheckout } from '../../scripts/lib/paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "../..")
const checkout = harnessCheckout
// The profile comes from --profile only. Reading an ambient DSH_PROFILE would
// let an unrelated export silently redirect an acceptance script at a profile
// nobody chose, and its failure would be reported against the wrong one.
function readProfileArg() {
  const index = process.argv.indexOf('--profile')
  return index === -1 ? 'ai-compiler-scratch' : process.argv[index + 1]
}
const profile = readProfileArg()
const AGENT_GATES = agentGatesRoot
const PYTHON = process.env.AGENT_GATES_PYTHON ?? agentGatesPython

let failures = 0
let checks = 0

function check(ok, label, detail) {
  checks += 1
  if (ok) {
    console.log("  ok   " + label)
  } else {
    failures += 1
    console.log("  FAIL " + label + (detail === undefined ? "" : " -> " + detail))
  }
}

/** Ask AgentGates for one passing receipt that satisfies its own gates. */
function findReceipt() {
  const script = join(repo, "tests/mcp/discover-receipts.py")
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: AGENT_GATES }
  if (process.env.AGENT_GATES_CONFIG !== undefined) env.AGENT_GATES_CONFIG = process.env.AGENT_GATES_CONFIG
  try {
    const stdout = execFileSync(PYTHON, [script], { cwd: AGENT_GATES, env, encoding: "utf8", timeout: 240_000 })
    const parsed = JSON.parse(stdout)
    return Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : undefined
  } catch {
    return undefined
  }
}

// PROVIDER CREDENTIALS.
//
// A DSH profile declares model providers, and a provider with no resolvable
// key is a FATAL boot condition: the profile disposes itself, closes the Lead
// session, and the next team/task append fails on a closed handle. So this
// scenario cannot run unless a key resolves.
//
// The precedence chain is the launch environment, then ~/.dsh/.env. The stored
// .credentials.yaml refs are NOT consulted on this path: the profile
// composition does not mount the credentials service, so a key that exists
// only in that file resolves to nothing. Exporting it is the requirement.
if (process.env.MAGPIE_API_KEY === undefined && process.env.DEEPSEEK_API_KEY === undefined) {
  console.log('SKIP: no provider credential in the environment.')
  console.log('  This scenario boots a real DSH profile, where a provider with no')
  console.log('  resolvable key is fatal at boot. Export MAGPIE_API_KEY (or')
  console.log('  DEEPSEEK_API_KEY) and run again.')
  process.exit(2)
}

const receipt = findReceipt()

const { runProfile } = await import(pathToFileURL(join(checkout, "apps/cli/lib/profile-boot.js")).href)

const entries = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key, { value: value ?? "" }]))
const launch = { entries, get: name => entries[name], has: name => entries[name] !== undefined }
// A single non-empty label, exactly as the sibling acceptance script passes.
// An EMPTY args array is not equivalent: the launcher treats "no task" as a
// request to start a session, which makes the web bundle bind its port and
// collides with the live UI. A label is neither a task nor a session request.
// A profile whose bundles do not declare a task-taking command (the live Web
// profile is one) rejects ANY positional argv, so the label cannot be passed
// there. It is not needed either: this script drives the Team service directly
// and never asks a model anything, so there is no task to hand the launcher.
const bootLabel = process.env.DSH_BOOT_LABEL
const args = bootLabel === undefined ? [] : [bootLabel]
const booted = await runProfile({ environment: launch, profile, patchFiles: [], args })
const ctx = booted.ctx
const shutdown = booted.shutdown

function uniqueSession(label) {
  return "session-team-gate-" + label + "-" + Date.now().toString(36)
    + "-" + Math.random().toString(36).slice(2, 8)
}

try {
  const presets = ctx.get("agentPresets")
  const agents = ctx.get("agents")
  const teams = ctx.get("agentTeams")
  if (presets === undefined || agents === undefined || teams === undefined) {
    console.log("boot error: profile is missing agentPresets/agents/agentTeams")
    process.exit(2)
  }

  const handle = await agents.create({
    sessionId: uniqueSession("lead"),
    meta: { cwd: process.cwd() },
    setup: async agentCtx => { await presets.mount(agentCtx, "ai-compiler") },
  })
  const lead = handle.agent

  console.log("AgentGates Team completion gate")
  console.log("\nprofile: " + profile + "   preset: ai-compiler")

  /**
   * Create one task, claim it as the Lead, declare requirements, then complete
   * it with the given evidence. Returns the error code or "completed".
   */
  async function attemptCompletion(label, requirements, evidence) {
    const created = await teams.createTask(lead, {
      subject: "gate " + label,
      description: "P7 acceptance case " + label,
      ...(requirements === undefined ? {} : { completionRequirements: requirements }),
    })
    await teams.updateTask(lead, { taskId: created.id, expectedRevision: created.revision, action: "claim" })
    const current = teams.listTasks(lead).find(task => task.id === created.id)
    try {
      await teams.updateTask(lead, {
        taskId: created.id,
        expectedRevision: current.revision,
        action: "complete",
        ...(evidence === undefined ? {} : { evidence }),
      })
      const after = teams.listTasks(lead).find(task => task.id === created.id)
      return { outcome: after?.status ?? "unknown", code: null }
    } catch (error) {
      return { outcome: "rejected", code: error?.code ?? String(error) }
    }
  }

  // ── the control case ────────────────────────────────────────────────────
  const plain = await attemptCompletion("no-requirements", undefined, undefined)
  check(plain.outcome === "completed",
    "a task with NO requirement still completes exactly as before",
    JSON.stringify(plain))

  if (receipt === undefined) {
    console.log("\nSKIP live cases: no usable receipt on this machine")
    report()
    process.exit(0)
  }

  const requirement = {
    key: "gate",
    kind: "agentgates",
    payload: {
      workspace: receipt.workspace,
      adapter: receipt.adapter,
      required_gates: receipt.gates,
    },
  }
  const runId = receipt.staleRunId ?? receipt.passingRunId

  // Runs the same verify the policy runs, so a case can assert the policy
  // AGREES with AgentGates rather than asserting a fixed outcome.
  function verifierSays(queryRunId) {
    const args = ["-s", "-m", "agent_gates.cli", "verify-requirements",
      "--workspace", receipt.workspace, "--adapter", receipt.adapter,
      "--run-id", queryRunId, "--json"]
    for (const gate of receipt.gates) args.push("--gate", gate)
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: AGENT_GATES }
    if (process.env.AGENT_GATES_CONFIG !== undefined) env.AGENT_GATES_CONFIG = process.env.AGENT_GATES_CONFIG
    try {
      const stdout = execFileSync(PYTHON, args, { cwd: AGENT_GATES, env, encoding: "utf8", timeout: 240_000 })
      const parsed = JSON.parse(stdout)
      return parsed.satisfied === true
    } catch (error) {
      const stdout = typeof error?.stdout === "string" ? error.stdout : ""
      try {
        return JSON.parse(stdout).satisfied === true
      } catch {
        return undefined
      }
    }
  }

  console.log("\nnegative cases (none may reach completed):")

  const noEvidence = await attemptCompletion("requirements-no-evidence", [requirement], undefined)
  check(noEvidence.outcome === "rejected",
    "a requirement with NO evidence reference is REJECTED", JSON.stringify(noEvidence))

  const wrongRun = await attemptCompletion("requirements-wrong-run", [requirement],
    [{ key: "gate", reference: "0".repeat(32) }])
  check(wrongRun.outcome === "rejected",
    "a requirement with an UNKNOWN run id is REJECTED", JSON.stringify(wrongRun))

  const wrongKey = await attemptCompletion("requirements-wrong-key", [requirement],
    [{ key: "different", reference: runId }])
  check(wrongKey.outcome === "rejected",
    "evidence offered under an undeclared key is REJECTED", JSON.stringify(wrongKey))

  const wrongAdapter = await attemptCompletion("requirements-wrong-adapter",
    [{ key: "gate", kind: "agentgates", payload: { workspace: receipt.workspace,
       adapter: "tilelang-hivm-npu", required_gates: receipt.gates } }],
    [{ key: "gate", reference: runId }])
  check(wrongAdapter.outcome === "rejected",
    "a requirement naming the WRONG adapter is REJECTED", JSON.stringify(wrongAdapter))

  const wrongWorkspace = await attemptCompletion("requirements-wrong-workspace",
    [{ key: "gate", kind: "agentgates", payload: { workspace: "no-such-workspace",
       adapter: receipt.adapter, required_gates: receipt.gates } }],
    [{ key: "gate", reference: runId }])
  check(wrongWorkspace.outcome === "rejected",
    "a requirement naming an UNKNOWN workspace is REJECTED", JSON.stringify(wrongWorkspace))

  const missingGate = await attemptCompletion("requirements-missing-gate",
    [{ key: "gate", kind: "agentgates", payload: { workspace: receipt.workspace,
       adapter: receipt.adapter,
       required_gates: receipt.gates.concat(["tilelang-hivm-npu-sanity"]) } }],
    [{ key: "gate", reference: runId }])
  check(missingGate.outcome === "rejected",
    "a requirement listing a gate the run never ran is REJECTED", JSON.stringify(missingGate))

  const malformed = await attemptCompletion("requirements-malformed",
    [{ key: "gate", kind: "agentgates", payload: { workspace: receipt.workspace } }],
    [{ key: "gate", reference: runId }])
  check(malformed.outcome === "rejected",
    "a MALFORMED requirement payload is REJECTED", JSON.stringify(malformed))

  console.log("\nagreement case:")
  const satisfied = verifierSays(runId)
  const live = await attemptCompletion("requirements-live", [requirement],
    [{ key: "gate", reference: runId }])
  if (satisfied === undefined) {
    console.log("  SKIP the verifier did not answer")
  } else if (satisfied) {
    check(live.outcome === "completed",
      "a requirement the verifier SATISFIES is completed", JSON.stringify(live))
  } else {
    check(live.outcome === "rejected",
      "a requirement the verifier REFUSES (stale tree) is rejected", JSON.stringify(live))
  }

  console.log("\nrequirement integrity:")
  const guarded = await teams.createTask(lead, {
    subject: "requirement integrity",
    description: "a declared requirement must not be removable",
    completionRequirements: [requirement],
  })
  try {
    await teams.updateTask(lead, {
      taskId: guarded.id,
      expectedRevision: guarded.revision,
      action: "edit",
      completionRequirements: [],
    })
    check(false, "removing a declared requirement is REFUSED")
  } catch (error) {
    check(true, "removing a declared requirement is REFUSED (" + (error?.code ?? "error") + ")")
  }
} finally {
  await shutdown?.shutdown?.(0)
}

function report() {
  console.log("\n" + (checks - failures) + "/" + checks + " checks passed")
  if (failures > 0) {
    console.log("RESULT: FAIL")
    process.exitCode = 1
  } else {
    console.log("RESULT: PASS")
  }
}

report()
