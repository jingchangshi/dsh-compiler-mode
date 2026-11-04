/**
 * Pure decision logic for the AI-Compiler LLM fallback plugin.
 *
 * Quota is normally exhausted per-day, so this is deliberately STICKY: once a
 * request on a route fails with a quota/auth-class error, the agent is pinned
 * to the next route in the chain and is NEVER returned to the primary
 * automatically. Walking back every few minutes would re-hit the exhausted key,
 * waste calls and make the session non-deterministic. A new session (or a Host
 * restart) starts the probe over.
 *
 * Nothing here imports a runtime package: the controller is plain in-memory
 * state, which keeps it unit-testable with `node --test` and lets the host load
 * it through tsx without a build.
 *
 * @module @local/dsh-ai-compiler-preset/plugins/llm-fallback/logic
 */

/** One `(provider, model)` route; `reasoningEffort` is optional and adapter-owned. */
export interface RouteRef {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One configured `from -> to[]` failover entry. */
export interface RawFallbackRoute {
  readonly from?: RouteRef
  readonly to?: readonly RouteRef[]
}

/** Raw plugin configuration as written in the profile patch. */
export interface RawConfig {
  /** Ordered failover chains, one entry per primary route. */
  readonly routes?: readonly RawFallbackRoute[]
  /** Failure codes that trigger a failover (default: QUOTA, AUTH). */
  readonly onCodes?: readonly string[]
  /** Regex that marks a generic RATE_LIMIT as quota-class (budget wording). */
  readonly quotaMessagePattern?: string
  /** Maximum number of forward failovers performed per agent (default 3). */
  readonly maxHops?: number
  /** Remember a degraded route for the whole process so sibling agents skip it (default true). */
  readonly globalSticky?: boolean
}

/** Normalized, validated settings. */
export interface Settings {
  /** routeKey(primary) -> [primary, ...fallbacks] (immutable). */
  readonly chains: ReadonlyMap<string, readonly RouteRef[]>
  readonly onCodes: ReadonlySet<string>
  readonly quotaPattern: RegExp
  readonly maxHops: number
  readonly globalSticky: boolean
}

/** Failure facts the plugin needs; mirrors the `LlmFailure` fields it reads. */
export interface FailureLike {
  readonly code: string
  readonly message: string
}

/** Minimal call-config shape the controller rewrites. */
export interface CallConfigLike {
  provider: string
  model: string
  reasoningEffort?: unknown
  [key: string]: unknown
}

/** Default failure codes that mean "this route cannot work again soon". */
export const DEFAULT_ON_CODES: readonly string[] = ['QUOTA', 'AUTH']

/**
 * Default budget/quota wording. Covers the corp gateway's
 * `429 ... "type":"budget_exceeded" ... Budget has been exceeded!`, which the
 * pi-ai adapter flattens into a generic RATE_LIMIT rather than QUOTA.
 */
export const DEFAULT_QUOTA_PATTERN = 'budget|quota|credit|balance|余额|额度'

/** Default forward-failover budget per agent. */
export const DEFAULT_MAX_HOPS = 3

/** Stable key for one route. */
export function routeKey(route: { readonly provider: string; readonly model: string }): string {
  return `${route.provider}\u0000${route.model}`
}

/** Human-readable `provider/model`. */
export function describeRoute(route: { readonly provider: string; readonly model: string }): string {
  return `${route.provider}/${route.model}`
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parseRoute(value: unknown, where: string): RouteRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object with provider and model`)
  }
  const record = value as Record<string, unknown>
  if (!isNonEmptyString(record.provider)) throw new Error(`${where}.provider must be a non-empty string`)
  if (!isNonEmptyString(record.model)) throw new Error(`${where}.model must be a non-empty string`)
  const route: { provider: string; model: string; reasoningEffort?: string } = {
    provider: record.provider.trim(),
    model: record.model.trim(),
  }
  if (record.reasoningEffort !== undefined) {
    if (!isNonEmptyString(record.reasoningEffort)) {
      throw new Error(`${where}.reasoningEffort must be a non-empty string when present`)
    }
    route.reasoningEffort = record.reasoningEffort.trim()
  }
  return route
}

/**
 * Validate raw configuration into immutable settings.
 * @throws Error naming the exact field when the configuration is malformed.
 */
export function parseSettings(raw: RawConfig = {}): Settings {
  const chains = new Map<string, readonly RouteRef[]>()
  const routes = raw.routes ?? []
  if (!Array.isArray(routes)) throw new Error('fallback.routes must be an array')
  routes.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`fallback.routes[${index}] must be an object`)
    }
    const from = parseRoute((entry as RawFallbackRoute).from, `fallback.routes[${index}].from`)
    const rawTo = (entry as RawFallbackRoute).to
    if (!Array.isArray(rawTo) || rawTo.length === 0) {
      throw new Error(`fallback.routes[${index}].to must be a non-empty array`)
    }
    const to = rawTo.map((item, j) => parseRoute(item, `fallback.routes[${index}].to[${j}]`))
    const key = routeKey(from)
    if (chains.has(key)) throw new Error(`fallback.routes[${index}] duplicates route ${describeRoute(from)}`)
    chains.set(key, Object.freeze([from, ...to]))
  })

  if (raw.onCodes !== undefined && !Array.isArray(raw.onCodes)) {
    throw new Error('fallback.onCodes must be an array of failure codes')
  }
  const onCodes = new Set((raw.onCodes ?? DEFAULT_ON_CODES).map(code => String(code)))

  const patternText = raw.quotaMessagePattern ?? DEFAULT_QUOTA_PATTERN
  let quotaPattern: RegExp
  try {
    quotaPattern = new RegExp(patternText, 'i')
  } catch {
    throw new Error(`fallback.quotaMessagePattern is not a valid regular expression: ${patternText}`)
  }

  const maxHops = raw.maxHops ?? DEFAULT_MAX_HOPS
  if (!Number.isInteger(maxHops) || maxHops < 0) {
    throw new Error('fallback.maxHops must be a non-negative integer')
  }

  return {
    chains,
    onCodes,
    quotaPattern,
    maxHops,
    globalSticky: raw.globalSticky ?? true,
  }
}

/** True when a failure should trigger a failover rather than an in-place retry. */
export function isEligible(failure: FailureLike, settings: Settings): boolean {
  if (settings.onCodes.has(failure.code)) return true
  // A terminal daily-quota rejection is sometimes flattened into a generic
  // 429/RATE_LIMIT by the adapter; the wording still says budget/quota.
  if (failure.code === 'RATE_LIMIT' && settings.quotaPattern.test(failure.message ?? '')) return true
  return false
}

/** The chain for a route, or undefined when the route has no configured fallback. */
export function chainFor(
  settings: Settings,
  route: { readonly provider: string; readonly model: string },
): readonly RouteRef[] | undefined {
  return settings.chains.get(routeKey(route))
}

interface PlanState {
  readonly chain: readonly RouteRef[]
  index: number
  hops: number
}

/** Outcome of rewriting one request config. */
export interface ResolveOutcome {
  readonly config: CallConfigLike
  readonly changed: boolean
  readonly from?: RouteRef
  readonly to?: RouteRef
}

/** Outcome of one failed attempt. */
export interface FailureOutcome {
  readonly advance: boolean
  readonly from?: RouteRef
  readonly to?: RouteRef
}

function rewrite(resolved: CallConfigLike, target: RouteRef): CallConfigLike {
  const { reasoningEffort: _inherited, ...rest } = resolved
  const config: CallConfigLike = { ...rest, provider: target.provider, model: target.model }
  if (target.reasoningEffort !== undefined) config.reasoningEffort = target.reasoningEffort
  return config
}

/**
 * In-memory, per-agent failover state machine.
 *
 * `resolve` rewrites the outgoing route when the agent is pinned to a fallback;
 * `onFailure` advances the pin forward on an eligible failure. Both are pure
 * with respect to their inputs so they can be tested without Cordis.
 */
export class FallbackController {
  private readonly settings: Settings
  private readonly perAgent: Map<string, PlanState> = new Map()
  private readonly degraded: Map<string, number> = new Map()

  constructor(settings: Settings) {
    this.settings = settings
  }

  /** Rewrite the resolved config when this agent is pinned to a fallback route. */
  resolve(agentId: string, resolved: CallConfigLike): ResolveOutcome {
    const chain = chainFor(this.settings, resolved)
    if (chain === undefined) return { config: resolved, changed: false }

    let state = this.perAgent.get(agentId)
    if (state === undefined) {
      let start = 0
      if (this.settings.globalSticky) {
        const remembered = this.degraded.get(routeKey(chain[0]))
        if (remembered !== undefined) start = Math.min(remembered, chain.length - 1)
      }
      state = { chain, index: start, hops: 0 }
      this.perAgent.set(agentId, state)
    }
    if (state.index <= 0) return { config: resolved, changed: false }

    const target = state.chain[Math.min(state.index, state.chain.length - 1)]
    return {
      config: rewrite(resolved, target),
      changed: true,
      from: { provider: resolved.provider, model: resolved.model },
      to: target,
    }
  }

  /** Advance the agent's pin forward on an eligible failure. */
  onFailure(agentId: string, provider: string, failure: FailureLike): FailureOutcome {
    const state = this.perAgent.get(agentId)
    if (state === undefined) return { advance: false }
    if (!isEligible(failure, this.settings)) return { advance: false }

    const current = state.chain[Math.min(state.index, state.chain.length - 1)]
    // Only advance when the failure came from the route the agent is pinned to.
    if (current.provider !== provider) return { advance: false }
    if (state.hops >= this.settings.maxHops) return { advance: false }
    if (state.index >= state.chain.length - 1) return { advance: false }

    state.index += 1
    state.hops += 1
    if (this.settings.globalSticky) this.degraded.set(routeKey(state.chain[0]), state.index)
    return { advance: true, from: current, to: state.chain[state.index] }
  }

  /** Drop one agent's recorded plan (e.g. on dispose). */
  forget(agentId: string): void {
    this.perAgent.delete(agentId)
  }

  /** Clear all plans and remembered degradations. */
  reset(): void {
    this.perAgent.clear()
    this.degraded.clear()
  }

  /** Read-only view for tests/diagnostics; undefined when the agent has no plan. */
  planOf(agentId: string): { readonly index: number; readonly hops: number; readonly chain: readonly RouteRef[] } | undefined {
    const state = this.perAgent.get(agentId)
    return state === undefined ? undefined : { index: state.index, hops: state.hops, chain: state.chain }
  }
}
