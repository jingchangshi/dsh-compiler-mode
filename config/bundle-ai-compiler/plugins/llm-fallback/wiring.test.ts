import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from './index.ts'
import type { CallConfigLike } from './logic.ts'

const RAW = {
  routes: [
    { from: { provider: 'corp', model: 'Qwen3.8-Flash' }, to: [{ provider: 'magpie', model: 'opencode-go/qwen3.8-flash' }, { provider: 'magpie', model: 'auto/claude-haiku-5-5' }] },
  ],
  onCodes: ['QUOTA', 'AUTH'],
  globalSticky: true,
  maxHops: 2,
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

test('sticky: a later request keeps using the fallback; hops are bounded', async () => {
  const { ctx, pick } = makeCtx()
  apply(ctx as never, RAW)
  const onRequest = pick('agent/request')
  const onError = pick('agent/request-error')

  await onRequest.fn({ agent: { id: 'w1' } }, async () => primary())
  await onError.fn({ agent: { id: 'w1' }, provider: 'corp', failure: budget }, async () => undefined)
  // hop #2: magpie -> haiku
  const hop2 = await onError.fn({ agent: { id: 'w1' }, provider: 'magpie', failure: { code: 'QUOTA', message: 'x' } }, async () => undefined)
  assert.deepEqual(hop2, { kind: 'retry' })
  const afterTwo = await onRequest.fn({ agent: { id: 'w1' } }, async () => primary())
  assert.equal(afterTwo.model, 'auto/claude-haiku-5-5')
  // hop #3 is beyond maxHops (2) -> delegate
  const hop3 = await onError.fn({ agent: { id: 'w1' }, provider: 'magpie', failure: { code: 'QUOTA', message: 'x' } }, async () => 'delegated')
  assert.equal(hop3, 'delegated')
})
