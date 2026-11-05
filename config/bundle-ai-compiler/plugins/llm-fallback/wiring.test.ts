import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from './index.ts'
import type { CallConfigLike } from './logic.ts'

/**
 * Mirrors the shipped table in `bundles.patch.yml`
 * (`ai-compiler-llm-fallback.routes`): the three corp routes, one magpie hop
 * each, and no entry for magpie primaries. Keep this fixture and that YAML in
 * sync.
 */
const RAW = {
  routes: [
    { from: { provider: 'corp', model: 'Qwen3.8-Flash' }, to: [{ provider: 'magpie', model: 'opencode-go/qwen3.8-flash' }] },
    { from: { provider: 'corp', model: 'DeepSeek-V4.1-Flash-1017' }, to: [{ provider: 'magpie', model: 'auto/deepseek-v4.1-flash' }] },
    { from: { provider: 'corp', model: 'GLM-5.3-Flash' }, to: [{ provider: 'magpie', model: 'auto/glm-5.3-flash' }] },
  ],
  onCodes: ['QUOTA', 'AUTH'],
  globalSticky: true,
  maxHops: 3,
}

interface Entry { fn: (...args: any[]) => any; prepend: boolean }

function makeCtx() {
  const listeners = new Map<string, Entry[]>()
  const warnings: string[] = []
  const ctx = {
    on(name: string, fn: (...args: any[]) => any, options?: { prepend?: boolean }) {
      const list = listeners.get(name) ?? []
      list.push({ fn, prepend: options?.prepend === true })
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name)
        if (current === undefined) return
        const index = current.findIndex(entry => entry.fn === fn)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect(factory: () => () => void) {
      return factory()
    },
    logger: { warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) } },
  }
  const pick = (name: string): Entry => {
    const list = listeners.get(name)
    assert.ok(list && list.length > 0, `expected a listener for ${name}`)
    return list[0]
  }
  return { ctx, listeners, warnings, pick }
}

const primary = (): CallConfigLike => ({ provider: 'corp', model: 'Qwen3.8-Flash' })
const budget = { code: 'RATE_LIMIT', message: '429 Budget has been exceeded! budget_exceeded' }

test('apply registers both listeners prepended', () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx as never, RAW)
  assert.equal(listeners.get('agent/request')?.[0]?.prepend, true)
  assert.equal(listeners.get('agent/request-error')?.[0]?.prepend, true)
})

test('request passes through the primary until a failure advances it', async () => {
  const { ctx, pick } = makeCtx()
  apply(ctx as never, RAW)
  const onRequest = pick('agent/request')

  const first = await onRequest.fn({ agent: { id: 'lead' } }, async () => primary())
  assert.deepEqual(first, { provider: 'corp', model: 'Qwen3.8-Flash' })

  const onError = pick('agent/request-error')
  const action = await onError.fn(
    { agent: { id: 'lead' }, provider: 'corp', failure: budget },
    async () => undefined,
  )
  assert.deepEqual(action, { kind: 'retry' })

  const second = await onRequest.fn({ agent: { id: 'lead' } }, async () => primary())
  assert.equal(second.provider, 'magpie')
  assert.equal(second.model, 'opencode-go/qwen3.8-flash')
})

test('a non-quota failure delegates to the next handler (undefined)', async () => {
  const { ctx, pick } = makeCtx()
  apply(ctx as never, RAW)
  const onRequest = pick('agent/request')
  await onRequest.fn({ agent: { id: 'lead' } }, async () => primary())

  const onError = pick('agent/request-error')
  const action = await onError.fn(
    { agent: { id: 'lead' }, provider: 'corp', failure: { code: 'SERVER', message: '502' } },
    async () => 'delegated',
  )
  assert.equal(action, 'delegated')
})

test('sticky single hop: a later request keeps the fallback; a second failure delegates', async () => {
  const { ctx, pick } = makeCtx()
  apply(ctx as never, RAW)
  const onRequest = pick('agent/request')
  const onError = pick('agent/request-error')

  await onRequest.fn({ agent: { id: 'w1' } }, async () => primary())
  await onError.fn({ agent: { id: 'w1' }, provider: 'corp', failure: budget }, async () => undefined)
  const pinned = await onRequest.fn({ agent: { id: 'w1' } }, async () => primary())
  assert.equal(pinned.model, 'opencode-go/qwen3.8-flash')
  // the shipped chain has one hop, so a failure on the fallback has nowhere to go
  const beyondChain = await onError.fn(
    { agent: { id: 'w1' }, provider: 'magpie', failure: { code: 'QUOTA', message: 'x' } },
    async () => 'delegated',
  )
  assert.equal(beyondChain, 'delegated')
})

test('a magpie group route has no fallback: request passes through and failure delegates', async () => {
  const { ctx, pick } = makeCtx()
  apply(ctx as never, RAW)
  const onRequest = pick('agent/request')
  const onError = pick('agent/request-error')
  const groupRoute = (): CallConfigLike => ({ provider: 'magpie', model: 'group/architect' })

  const first = await onRequest.fn({ agent: { id: 'architect' } }, async () => groupRoute())
  assert.deepEqual(first, { provider: 'magpie', model: 'group/architect' })

  const action = await onError.fn(
    { agent: { id: 'architect' }, provider: 'magpie', failure: budget },
    async () => 'delegated',
  )
  assert.equal(action, 'delegated')
  const unchanged = await onRequest.fn({ agent: { id: 'architect' } }, async () => groupRoute())
  assert.deepEqual(unchanged, { provider: 'magpie', model: 'group/architect' })
})
