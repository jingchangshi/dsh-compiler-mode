#!/usr/bin/env node
/**
 * Behaviour tests for the AgentGates completion policy.
 *
 * Run: node --experimental-strip-types tests/mcp/policy.mjs [--quick]
 *
 * The contract proven here is AGREEMENT: the policy accepts exactly the runs
 * AgentGates verifies as satisfying, and rejects everything else with a
 * distinct code. The verification is never simulated - every live case shells
 * out to the real agent_gates CLI against real published receipts.
 *
 * Agreement rather than a hardcoded expectation is deliberate. A receipt goes
 * STALE the moment its source tree changes, and a live compiler checkout
 * changes whenever anyone builds in it, so asserting that a run accepted
 * earlier is still fresh would test the calendar instead of the gate.
 *
 * --quick skips the cases that submit real gates.
 */
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createPolicy, REJECTION_CODES, REQUIREMENT_KIND } from '../../config/bundle-ai-compiler/plugins/agentgates-policy/index.ts'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "../..")

const AGENT_GATES = process.env.AGENT_GATES_ROOT ?? '/home/s00653124/workspace/AgentGates'
const PYTHON = process.env.AGENT_GATES_PYTHON ?? join(AGENT_GATES, '.venv/bin/python')
const QUICK = process.argv.includes("--quick")
const SUBMIT_TIMEOUT_MS = Number(process.env.SUBMIT_TIMEOUT_MS ?? 900_000)

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

function makeAttempt(requirements, evidence) {
  return { requirements, evidence, signal: new AbortController().signal }
}

function makeRequirement(key, payload) {
  return { key, kind: REQUIREMENT_KIND, payload }
}

function cliEnv() {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: AGENT_GATES }
  if (process.env.AGENT_GATES_CONFIG !== undefined) env.AGENT_GATES_CONFIG = process.env.AGENT_GATES_CONFIG
  return env
}

async function cli(args, timeout) {
  try {
    const completed = await run(PYTHON, args, { cwd: AGENT_GATES, env: cliEnv(), timeout })
    return JSON.parse(completed.stdout)
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
    if (stdout.trim().length === 0) return undefined
    try {
      return JSON.parse(stdout)
    } catch {
      return undefined
    }
  }
}

async function verifyRun(receipt, runId) {
  const args = [
    '-s', '-m', 'agent_gates.cli', 'verify-requirements',
    '--workspace', receipt.workspace,
    '--adapter', receipt.adapter,
    '--run-id', runId,
    '--json',
  ]
  for (const gate of receipt.gates) args.push("--gate", gate)
  const parsed = await cli(args, 240_000)
  if (parsed === undefined || typeof parsed.satisfied !== "boolean") return undefined
  return { satisfied: parsed.satisfied, status: String(parsed.status) }
}

async function submitRun(receipt) {
  const args = [
    '-s', '-m', 'agent_gates.cli', 'submit',
    '--workspace', receipt.workspace,
    '--adapter', receipt.adapter,
    '--json',
  ]
  for (const gate of receipt.gates) args.push("--gate", gate)
  const submitted = await cli(args, 60_000)
  if (submitted === undefined || typeof submitted.execution_id !== "string") return undefined
  const deadline = Date.now() + SUBMIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2_000))
    const waited = await cli([
      '-s', '-m', 'agent_gates.cli', 'wait',
      '--execution-id', submitted.execution_id, '--timeout', '20', '--json',
    ], 60_000)
    const state = waited?.status?.state
    if (state === "FINISHED" || state === "CANCELLED" || state === "INTERRUPTED") {
      return waited.status.run_id ?? undefined
    }
  }
  return undefined
}

const policy = createPolicy({ python: PYTHON, packageRoot: AGENT_GATES, timeoutMs: 240_000 })

async function refusalsWithoutVerifier() {
  console.log("\nrefusals that need no verifier:")
  const owned = [makeRequirement('r1', { workspace: 'tilelang', adapter: 'tilelang-hivm',
                                     required_gates: ['tilelang-hivm-build'] })]

  const none = await policy.evaluate(makeAttempt(owned, []))
  check(none.outcome === "rejected" && none.code === REJECTION_CODES.MISSING_EVIDENCE,
    "a task with a requirement and no run id is REJECTED", JSON.stringify(none))

  const unknown = await policy.evaluate(makeAttempt(owned, [{ key: 'other', reference: 'x' }]))
  check(unknown.outcome === "rejected" && unknown.code === REJECTION_CODES.EXTRA_EVIDENCE,
    "evidence offered for an undeclared key is REJECTED", JSON.stringify(unknown))

  const malformed = await policy.evaluate(makeAttempt(
    [makeRequirement('r1', { workspace: 'tilelang' })],
    [{ key: 'r1', reference: 'x' }]))
  check(malformed.outcome === "rejected" && malformed.code === REJECTION_CODES.MALFORMED,
    "a requirement without required_gates is REJECTED", JSON.stringify(malformed))

  const foreign = await policy.evaluate(makeAttempt(
    [{ key: 'k', kind: 'some-other-policy', payload: {} }], []))
  check(foreign.outcome === "accepted",
    "a requirement owned by another policy is left alone", JSON.stringify(foreign))

  const noRequirements = await policy.evaluate(makeAttempt([], []))
  check(noRequirements.outcome === "accepted",
    "a task with no AgentGates requirement is accepted without verifying",
    JSON.stringify(noRequirements))
}

async function main() {
  console.log("AgentGates completion policy")
  await refusalsWithoutVerifier()

  if (!existsSync(PYTHON)) {
    console.log("\nSKIP live verification: " + PYTHON + " not found")
    return
  }

  const receipts = await cli([join(repo, "tests/mcp/discover-receipts.py")], 240_000)
  if (!Array.isArray(receipts) || receipts.length === 0) {
    console.log("\nSKIP live verification: no usable receipts")
    return
  }

  console.log("\nlive verification against real receipts:")
  for (const receipt of receipts) {
    const requirement = [makeRequirement("r1", {
      workspace: receipt.workspace,
      adapter: receipt.adapter,
      required_gates: receipt.gates,
    })]
    const probeRunId = receipt.staleRunId ?? receipt.passingRunId
    const probe = await verifyRun(receipt, probeRunId)

    if (probe !== undefined && !probe.satisfied) {
      const decision = await policy.evaluate(makeAttempt(requirement,
        [{ key: "r1", reference: probeRunId }]))
      check(decision.outcome === "rejected" && decision.code === REJECTION_CODES.UNSATISFIED,
        receipt.adapter + ": an unsatisfied run is REJECTED as UNSATISFIED",
        JSON.stringify(decision))
    }

    const wrongAdapter = await policy.evaluate(makeAttempt(
      [makeRequirement("r1", { workspace: receipt.workspace, adapter: "tilelang-hivm-npu",
                                required_gates: receipt.gates })],
      [{ key: "r1", reference: probeRunId }]))
    check(wrongAdapter.outcome === "rejected",
      receipt.adapter + ": a receipt bound to another adapter is REJECTED",
      JSON.stringify(wrongAdapter))

    const extraGate = await policy.evaluate(makeAttempt(
      [makeRequirement("r1", { workspace: receipt.workspace, adapter: receipt.adapter,
                                required_gates: receipt.gates.concat(["tilelang-hivm-npu-sanity"]) })],
      [{ key: "r1", reference: probeRunId }]))
    check(extraGate.outcome === "rejected",
      receipt.adapter + ": a required gate the run never ran is REJECTED",
      JSON.stringify(extraGate))

    if (QUICK) continue

    const freshRunId = await submitRun(receipt)
    if (freshRunId === undefined) {
      console.log("  SKIP " + receipt.adapter + ": could not produce a fresh run")
      continue
    }
    const verdict = await verifyRun(receipt, freshRunId)
    if (verdict === undefined) {
      console.log("  SKIP " + receipt.adapter + ": verifier unavailable")
      continue
    }
    const decision = await policy.evaluate(makeAttempt(requirement,
      [{ key: "r1", reference: freshRunId }]))
    const agrees = verdict.satisfied
      ? decision.outcome === "accepted"
      : decision.outcome === "rejected" && decision.code === REJECTION_CODES.UNSATISFIED
    check(agrees,
      receipt.adapter + ": policy agrees with the verifier on a fresh run (" + verdict.status + ")",
      JSON.stringify(decision))
  }
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

main().then(report, error => { console.error(error); process.exitCode = 1 })
