/**
 * AgentGates completion policy for Team tasks.
 *
 * This plugin is the ONLY place `dsh-compiler-mode` decides whether a Team task
 * may be marked complete, and it decides by asking AgentGates. It never
 * re-implements verification: the Python package owns receipt parsing, source
 * identity and gate verdicts, and this file only marshals a requirement in and
 * a verdict out. Two implementations of the same check would eventually
 * disagree about which one is authoritative.
 *
 * Requirements are declared with kind `agentgates` and a payload naming a
 * workspace, an adapter and the gates that must have passed. Completion must
 * then offer an evidence reference: the run id of a published receipt.
 *
 * A task with no requirements never reaches this module. That is the Team
 * domain's guarantee, not this plugin's, which is why builds are never forced
 * on tasks that did not ask for one.
 *
 * @module @local/dsh-ai-compiler-agentgates
 */

import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ai-compiler-agentgates'

/**
 * Service the policy registers against. Declared so a profile without the
 * Agent Teams service leaves this plugin inactive instead of throwing.
 */
export const inject = ['agentTeams']

/** The requirement kind this policy owns. */
export const REQUIREMENT_KIND = 'agentgates'

/** Stable rejection codes a caller can branch on. */
export const REJECTION_CODES = {
  MALFORMED: 'AGENTGATES_REQUIREMENT_MALFORMED',
  MISSING_EVIDENCE: 'AGENTGATES_EVIDENCE_MISSING',
  EXTRA_EVIDENCE: 'AGENTGATES_EVIDENCE_UNEXPECTED',
  UNSATISFIED: 'AGENTGATES_REQUIREMENTS_UNSATISFIED',
  UNAVAILABLE: 'AGENTGATES_VERIFIER_UNAVAILABLE',
}

const MAX_REFERENCE_LENGTH = 128
const MAX_REASON_LENGTH = 900

/** Plugin configuration. */
export interface Config {
  /** Interpreter that can import agent_gates. Absolute, resolved at install. */
  readonly python?: string
  /** AgentGates configuration file. Absolute; defaults to the documented path. */
  readonly configFile?: string
  /** Directory containing agent_gates, when the interpreter cannot find it. */
  readonly packageRoot?: string
  /** Per-requirement verification budget in milliseconds. */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Resolve a machine parameter from the environment, or fail loudly.
 *
 * There is deliberately no path fallback: a default that names another
 * machine's checkout turns "not configured" into "verified against the wrong
 * installation", which is the one failure a gate must never report as a pass.
 * `scripts/install.sh` records both values in `$DSH_HOME/.env`, which the
 * launcher loads for every profile, so the names below are always set on a
 * machine the installer has run on.
 */
function requireMachineValue(variable: string, what: string): string {
  const value = process.env[variable]
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${what} is not configured: set ${variable}. `
      + 'scripts/install.sh records it in $DSH_HOME/.env; re-run it, or export the variable.')
  }
  return value.trim()
}

/** One verified requirement, as reported in the log. */
interface VerificationOutcome {
  readonly key: string
  readonly runId: string
  readonly satisfied: boolean
  readonly status: string
  readonly failures: readonly string[]
}

/** Narrow unknown JSON to a string field. */
function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Narrow unknown JSON to an array of non-empty strings. */
function readStringArray(source: unknown, key: string): string[] | undefined {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return undefined
  const value = (source as Record<string, unknown>)[key]
  if (!Array.isArray(value) || value.length === 0) return undefined
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) return undefined
    items.push(item.trim())
  }
  return items
}

/**
 * Run one requirement verification through the AgentGates CLI.
 *
 * The CLI is used rather than a bespoke protocol because it IS the published
 * interface of the Python package: the same command a person would run, with a
 * fixed argv and no shell. `--json` makes its answer machine-readable, so this
 * module never parses prose.
 */
async function verifyOne(options: {
  readonly python: string
  readonly configFile: string
  readonly packageRoot: string
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
  readonly workspace: string
  readonly adapter: string
  readonly gates: readonly string[]
  readonly runId: string
}): Promise<VerificationOutcome | { readonly error: string }> {
  const args = [
    '-s', '-m', 'agent_gates.cli', 'verify-requirements',
    '--workspace', options.workspace,
    '--adapter', options.adapter,
    '--run-id', options.runId,
    '--json',
  ]
  for (const gate of options.gates) args.push('--gate', gate)

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    PYTHONPATH: options.packageRoot,
  }
  if (options.configFile.length > 0) env.AGENT_GATES_CONFIG = options.configFile

  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, options.timeoutMs)
  const onAbort = (): void => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const completed = await run(options.python, args, {
      env,
      timeout: options.timeoutMs,
      signal: controller.signal,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    return parseVerification(completed.stdout, options.runId)
  } catch (error: unknown) {
    // A non-zero exit still carries a JSON body: "this receipt does not
    // satisfy the requirement" is an answer, not a crash. Only a missing or
    // unparseable body is a verifier failure.
    const stdout = typeof (error as { stdout?: unknown }).stdout === 'string'
      ? (error as { stdout: string }).stdout
      : ''
    if (stdout.trim().length > 0) return parseVerification(stdout, options.runId)
    const message = error instanceof Error ? error.message : String(error)
    return { error: message.slice(0, MAX_REASON_LENGTH) }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** Parse the verify-requirements JSON body. */
function parseVerification(body: string, runId: string): VerificationOutcome | { readonly error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { error: 'verify-requirements did not return JSON' }
  }
  const satisfied = (parsed as { satisfied?: unknown }).satisfied
  const status = readString(parsed, 'status')
  if (typeof satisfied !== 'boolean' || status === undefined) {
    // An APIError body has code/family/message instead, and is a refusal too.
    return { error: readString(parsed, 'message') ?? readString(parsed, 'code') ?? 'unrecognised verifier answer' }
  }
  return {
    key: '',
    runId,
    satisfied,
    status,
    failures: readStringArray(parsed, 'failures') ?? [],
  }
}

/**
 * Build the policy object for one configuration.
 *
 * Exported so the behaviour can be tested without a Cordis runtime.
 */
export function createPolicy(config: Config = {}) {
  // Only a value the caller did not supply is looked up in the environment, so
  // a test that passes both paths never depends on how the machine was set up.
  const settings = {
    python: config.python ?? requireMachineValue('AGENT_GATES_MCP_PYTHON', 'the AgentGates interpreter'),
    configFile: config.configFile ?? (process.env.AGENT_GATES_CONFIG ?? ''),
    packageRoot: config.packageRoot ?? requireMachineValue('AGENT_GATES_ROOT', 'the AgentGates package root'),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  return {
    name: 'agentgates',
    async evaluate(attempt: TeamTaskCompletionAttemptLike): Promise<TeamTaskCompletionDecisionLike> {
      const owned = attempt.requirements.filter(item => item.kind === REQUIREMENT_KIND)
      // A task may declare other kinds for other policies; those are not ours
      // to judge, and the Team domain runs every registered policy.
      if (owned.length === 0) return { outcome: 'accepted' }

      const offered = new Map<string, string>()
      for (const item of attempt.evidence) {
        if (typeof item.key !== 'string' || typeof item.reference !== 'string') {
          return reject(REJECTION_CODES.MALFORMED, 'completion evidence must have string key and reference')
        }
        offered.set(item.key, item.reference)
      }

      const unknownKeys = [...offered.keys()].filter(key => !owned.some(item => item.key === key))
      if (unknownKeys.length > 0) {
        return reject(REJECTION_CODES.EXTRA_EVIDENCE,
          `evidence offered for unknown requirement(s): ${unknownKeys.join(', ')}`)
      }

      const outcomes: VerificationOutcome[] = []
      for (const requirement of owned) {
        const parsed = parseRequirement(requirement.key, requirement.payload)
        if ('error' in parsed) return reject(REJECTION_CODES.MALFORMED, parsed.error)

        const reference = offered.get(requirement.key)
        if (reference === undefined || reference.length === 0) {
          return reject(REJECTION_CODES.MISSING_EVIDENCE,
            `requirement "${requirement.key}" has no evidence reference; supply the run id of a 
passed receipt as evidence`)
        }
        if (reference.length > MAX_REFERENCE_LENGTH) {
          return reject(REJECTION_CODES.MALFORMED, 'evidence reference is too long to be a run id')
        }

        const result = await verifyOne({
          python: settings.python,
          configFile: settings.configFile,
          packageRoot: settings.packageRoot,
          timeoutMs: settings.timeoutMs,
          signal: attempt.signal,
          workspace: parsed.workspace,
          adapter: parsed.adapter,
          gates: parsed.gates,
          runId: reference,
        })

        if ('error' in result) {
          return reject(REJECTION_CODES.UNAVAILABLE,
            `could not verify requirement "${requirement.key}": ${result.error}`)
        }
        outcomes.push({ ...result, key: requirement.key })
        if (!result.satisfied) {
          const detail = result.failures.length > 0 ? result.failures.join('; ') : 'no failures reported'
          return reject(REJECTION_CODES.UNSATISFIED,
            `requirement "${requirement.key}" is not satisfied: run ${reference} is ${result.status} (${detail})`)
        }
      }

      // Accepted: the receipt records which evidence was used, because
      // "accepted" without the reference that proved it is unverifiable later.
      return {
        outcome: 'accepted',
        details: outcomes.map(item => `${item.key}=${item.runId} (${item.status})`).join(', '),
      }
    },
  }
}

/** Validate one declared requirement payload. */
function parseRequirement(key: string, payload: unknown):
  | { readonly workspace: string; readonly adapter: string; readonly gates: string[] }
  | { readonly error: string } {
  const workspace = readString(payload, 'workspace')
  const adapter = readString(payload, 'adapter')
  const gates = readStringArray(payload, 'required_gates') ?? readStringArray(payload, 'gates')
  if (workspace === undefined) {
    return { error: `requirement "${key}" needs payload.workspace` }
  }
  if (adapter === undefined) {
    return { error: `requirement "${key}" needs payload.adapter` }
  }
  if (gates === undefined) {
    return { error: `requirement "${key}" needs payload.required_gates (a nonempty string array)` }
  }
  return { workspace, adapter, gates }
}

/** Build a rejection verdict. */
function reject(code: string, message: string): TeamTaskCompletionDecisionLike {
  return { outcome: 'rejected', code, message: message.slice(0, MAX_REASON_LENGTH) }
}

/** Structural views of the Team domain types this module consumes. */
interface TeamTaskCompletionAttemptLike {
  readonly requirements: readonly { readonly key: string; readonly kind: string; readonly payload: unknown }[]
  readonly evidence: readonly { readonly key: string; readonly reference: string }[]
  readonly signal: AbortSignal
}

/** Acceptance carries an optional detail string for the durable receipt. */
type TeamTaskCompletionDecisionLike =
  | { readonly outcome: 'accepted'; readonly details?: string }
  | { readonly outcome: 'rejected'; readonly code: string; readonly message: string }

/**
 * Register the policy on the Agent Teams service.
 *
 * The disposer is returned through `ctx.effect` so unloading the plugin
 * unregisters the policy: a policy that outlived its plugin would keep
 * refusing completions from code nobody can see.
 */
export function apply(ctx: AgentTeamsContextLike, config: Config = {}): void {
  const policy = createPolicy(config)
  ctx.effect(() => ctx.agentTeams.registerCompletionPolicy(policy, { timeoutMs: 120_000 }),
    'ai-compiler-agentgates.policy')
}

/** Structural view of the Cordis context this plugin needs. */
interface AgentTeamsContextLike {
  readonly agentTeams: {
    registerCompletionPolicy: (policy: unknown, options?: { timeoutMs?: number }) => () => void
  }
  readonly effect: (factory: () => () => void, label?: string) => void
}

/** Resolve a path to its canonical form, used by the installer. */
export async function canonical(path: string): Promise<string> {
  return realpath(fileURLToPath(new URL(`file://${path}`)))
}
