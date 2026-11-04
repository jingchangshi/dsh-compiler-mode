/**
 * Provider-route fallback for the AI-Compiler mode.
 *
 * The `llm-retry` plugin retries a failed request on the SAME provider route,
 * which is correct for a transient blip but useless for a terminal, per-day
 * quota exhaustion: the same key fails every attempt. This plugin adds the
 * missing cross-route hand-off at two existing agent-loop seams:
 *
 *   - `agent/request` (waterfall, re-run on every retry): when an agent is
 *     pinned to a fallback route, rewrite `provider`/`model` before the request
 *     is built. The whole conversation is rebuilt from the session each
 *     attempt, so a mid-turn switch keeps the full history.
 *   - `agent/request-error` (waterfall): on an eligible quota/auth-class
 *     failure, advance the pin one hop and return `{ kind: 'retry' }` so the
 *     loop tries again immediately on the fallback route.
 *
 * Failover is STICKY: once advanced, the agent never returns to the primary on
 * its own. A per-day quota does not recover within a turn, and walking back
 * would re-hit the dead key and make the session non-deterministic. A new
 * session / Host restart starts the probe over.
 *
 * Both listeners are registered with `prepend: true` so a quota-class failure
 * is handled here BEFORE `llm-retry` spends its bounded retries on the dead
 * route, and so the rewritten config wins over any later `agent/request`
 * middleware.
 *
 * @module @local/dsh-ai-compiler-preset/plugins/llm-fallback
 */

import {
  FallbackController,
  describeRoute,
  parseSettings,
  type CallConfigLike,
  type FailureLike,
  type RawConfig,
} from './logic.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ai-compiler-llm-fallback'

/** Plugin configuration (see {@link RawConfig}). */
export interface Config extends RawConfig {}

/** The listeners this plugin owns; returned through `ctx.effect` for clean unload. */
interface Disposers {
  (): void
}

interface AgentLike {
  readonly id: string
}

interface RequestPayload {
  readonly agent: AgentLike
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

interface RequestErrorPayload {
  readonly agent: AgentLike
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly failure: FailureLike
  readonly signal: AbortSignal
  readonly retryPolicy?: unknown
}

type NextConfig = () => Promise<CallConfigLike>
type NextAction = () => Promise<{ readonly kind: 'retry' } | undefined>

/** Structural view of the Cordis context this plugin needs. */
interface ContextLike {
  on(event: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): Disposers
  effect(factory: () => Disposers, label?: string): void
  logger?: {
    warn: (...args: unknown[]) => void
    info?: (...args: unknown[]) => void
  }
}

/**
 * Register the fallback listeners.
 *
 * A malformed `routes` table throws at load: a misconfigured fallback that
 * silently did nothing would re-create the exact blind spot this plugin exists
 * to close.
 */
export function apply(ctx: ContextLike, rawConfig: Config = {}): void {
  const settings = parseSettings(rawConfig)
  if (settings.chains.size === 0) {
    ctx.logger?.warn('[llm-fallback] no routes configured; plugin is a no-op')
    return
  }
  const controller = new FallbackController(settings)

  ctx.effect(() => {
    const offRequest = ctx.on('agent/request', (async (payload: RequestPayload, next: NextConfig) => {
      const resolved = await next()
      try {
        const outcome = controller.resolve(payload.agent.id, resolved)
        if (outcome.changed && outcome.to !== undefined) {
          ctx.logger?.warn(
            `[llm-fallback] agent ${payload.agent.id}: pinned to fallback ${describeRoute(outcome.to)}`
            + (outcome.from === undefined ? '' : ` (instead of ${describeRoute(outcome.from)})`),
          )
        }
        return outcome.config
      } catch (error) {
        ctx.logger?.warn('[llm-fallback] resolve failed; passing through:', error)
        return resolved
      }
    }) as (...args: never[]) => unknown, { prepend: true })

    const offError = ctx.on('agent/request-error', (async (payload: RequestErrorPayload, next: NextAction) => {
      try {
        const outcome = controller.onFailure(payload.agent.id, payload.provider, payload.failure)
        if (outcome.advance && outcome.to !== undefined) {
          ctx.logger?.warn(
            `[llm-fallback] agent ${payload.agent.id}: ${payload.failure.code} on `
            + `${outcome.from === undefined ? payload.provider : describeRoute(outcome.from)}`
            + ` -> failing over to ${describeRoute(outcome.to)}`,
          )
          return { kind: 'retry' as const }
        }
      } catch (error) {
        ctx.logger?.warn('[llm-fallback] failover decision failed; delegating:', error)
      }
      return next()
    }) as (...args: never[]) => unknown, { prepend: true })

    return () => {
      offRequest()
      offError()
    }
  }, 'ai-compiler-llm-fallback.listeners')
}
