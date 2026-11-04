import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_HOPS,
  FallbackController,
  describeRoute,
  isEligible,
  parseSettings,
  routeKey,
  type CallConfigLike,
  type FailureLike,
  type RawConfig,
} from './logic.ts'

const ROUTES: RawConfig = {
  routes: [
    { from: { provider: 'corp', model: 'Qwen3.8-Flash' }, to: [{ provider: 'magpie', model: 'opencode-go/qwen3.8-flash' }, { provider: 'magpie', model: 'auto/claude-haiku-5-5' }] },
    { from: { provider: 'corp', model: 'DeepSeek-V4.1-Flash-1017' }, to: [{ provider: 'magpie', model: 'auto/deepseek-v4.1-flash' }] },
  ],
  onCodes: ['QUOTA', 'AUTH'],
  globalSticky: true,
  maxHops: 2,
}

const primary = (): CallConfigLike => ({ provider: 'corp', model: 'Qwen3.8-Flash', maxTokens: 1000 })
const budget: FailureLike = { code: 'RATE_LIMIT', message: 'corp API error (429): {"type":"budget_exceeded"} Budget has been exceeded!' }
const quota: FailureLike = { code: 'QUOTA', message: 'balance exhausted' }
const transient: FailureLike = { code: 'RATE_LIMIT', message: 'too many requests, slow down' }
const server: FailureLike = { code: 'SERVER', message: '502 bad gateway' }

test('parseSettings defaults and validation', () => {
  const s = parseSettings({ routes: [] })
  assert.equal(s.onCodes.has('QUOTA'), true)
  assert.equal(s.onCodes.has('AUTH'), true)
  assert.equal(s.maxHops, DEFAULT_MAX_HOPS)
  assert.equal(s.globalSticky, true)
  assert.equal(s.chains.size, 0)

  const parsed = parseSettings(ROUTES)
  assert.equal(parsed.chains.size, 2)
  // chains include the primary as element 0
  assert.deepEqual(parsed.chains.get(routeKey({ provider: 'corp', model: 'Qwen3.8-Flash' }))?.map(describeRoute), [
    'corp/Qwen3.8-Flash', 'magpie/opencode-go/qwen3.8-flash', 'magpie/auto/claude-haiku-5-5',
  ])
})

test('parseSettings rejects malformed input with a field-naming error', () => {
  assert.throws(() => parseSettings({ routes: [{ from: { provider: '', model: 'x' }, to: [] }] }), /provider/)
  assert.throws(() => parseSettings({ routes: [{ from: { provider: 'a', model: 'b' }, to: [] }] }), /non-empty array/)
  assert.throws(() => parseSettings({ routes: [{ from: { provider: 'a', model: 'b' }, to: [{ provider: 'c', model: '' }] }] }), /model/)
  assert.throws(() => parseSettings({ maxHops: -1 }), /maxHops/)
  assert.throws(() => parseSettings({ quotaMessagePattern: '(' }), /regular expression/)
})

test('isEligible: quota/auth only, budget wording counts, transient/server do not', () => {
  const s = parseSettings(ROUTES)
  assert.equal(isEligible(quota, s), true)
  assert.equal(isEligible({ code: 'AUTH', message: '401' }, s), true)
  assert.equal(isEligible(budget, s), true)          // flattened 429 with budget wording
  assert.equal(isEligible(transient, s), false)
  assert.equal(isEligible(server, s), false)
})

test('a primary route with no configured fallback passes through unchanged', () => {
  const c = new FallbackController(parseSettings(ROUTES))
  const resolved: CallConfigLike = { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' }
  const out = c.resolve('a1', resolved)
  assert.equal(out.changed, false)
  assert.equal(out.config, resolved)
})

test('quota failure advances to the first fallback and the retry uses it', () => {
  const c = new FallbackController(parseSettings(ROUTES))
  // first request resolves the primary, unchanged
  assert.equal(c.resolve('a1', primary()).changed, false)
  // a budget 429 on the primary advances and asks for a retry
  const f = c.onFailure('a1', 'corp', budget)
  assert.equal(f.advance, true)
  assert.equal(describeRoute(f.to as never), 'magpie/opencode-go/qwen3.8-flash')
  // next resolve rewrites the route to the fallback and drops inherited reasoning fields
  const out = c.resolve('a1', { ...primary(), reasoningEffort: 'high' })
  assert.equal(out.changed, true)
  assert.equal(out.config.provider, 'magpie')
  assert.equal(out.config.model, 'opencode-go/qwen3.8-flash')
  assert.equal(out.config.reasoningEffort, undefined)
  // unrelated fields (maxTokens) are preserved
  assert.equal(out.config.maxTokens, 1000)
})

test('STICKY: once failed over, the agent never returns to the primary', () => {
  const c = new FallbackController(parseSettings(ROUTES))
  c.resolve('a1', primary())
  c.onFailure('a1', 'corp', quota)
  for (let i = 0; i < 5; i += 1) {
    const out = c.resolve('a1', primary())   // loop still asks for the primary route
    assert.equal(out.changed, true)
    assert.equal(out.config.provider, 'magpie')
  }
  assert.equal(c.planOf('a1')?.index, 1)
})

test('multi-hop is bounded by maxHops and the chain length', () => {
  const c = new FallbackController(parseSettings(ROUTES)) // maxHops 2, chain length 3 (indices 0..2)
  c.resolve('a1', primary())
  assert.equal(c.onFailure('a1', 'corp', quota).advance, true)            // 0 -> 1
  assert.equal(c.onFailure('a1', 'magpie', quota).advance, true)          // 1 -> 2
  const atEnd = c.onFailure('a1', 'magpie', quota)                       // end of chain
  assert.equal(atEnd.advance, false)
  assert.equal(c.planOf('a1')?.index, 2)
})

test('a transient failure on the pinned route does not advance', () => {
  const c = new FallbackController(parseSettings(ROUTES))
  c.resolve('a1', primary())
  assert.equal(c.onFailure('a1', 'corp', transient).advance, false)
  assert.equal(c.onFailure('a1', 'corp', server).advance, false)
  assert.equal(c.planOf('a1')?.index, 0)
})

test('failure from a route the agent is not pinned to does not advance', () => {
  const c = new FallbackController(parseSettings(ROUTES))
  c.resolve('a1', primary())
  assert.equal(c.onFailure('a1', 'magpie', quota).advance, false)
})

test('globalSticky: a sibling agent starts directly on the degraded fallback', () => {
  const c = new FallbackController(parseSettings(ROUTES))
  c.resolve('a1', primary())
  c.onFailure('a1', 'corp', quota)                 // remembers corp -> index 1
  const fresh = c.resolve('a2', primary())         // a2 never saw the failure
  assert.equal(fresh.changed, true)
  assert.equal(fresh.config.model, 'opencode-go/qwen3.8-flash')
})

test('globalSticky:false keeps each agent independent', () => {
  const c = new FallbackController(parseSettings({ ...ROUTES, globalSticky: false }))
  c.resolve('a1', primary())
  c.onFailure('a1', 'corp', quota)
  const fresh = c.resolve('a2', primary())
  assert.equal(fresh.changed, false)
})

test('forget clears one agent plan; reset clears remembered degradation too', () => {
  const independent = new FallbackController(parseSettings({ ...ROUTES, globalSticky: false }))
  independent.resolve('a1', primary())
  independent.onFailure('a1', 'corp', quota)
  independent.forget('a1')
  assert.equal(independent.planOf('a1'), undefined)
  assert.equal(independent.resolve('a1', primary()).changed, false)

  const sticky = new FallbackController(parseSettings(ROUTES))
  sticky.resolve('a1', primary())
  sticky.onFailure('a1', 'corp', quota)
  sticky.reset()
  assert.equal(sticky.resolve('a1', primary()).changed, false)
})
