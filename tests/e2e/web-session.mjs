#!/usr/bin/env node
/**
 * Run one real task through the LIVE Web Host — the acceptance entry the
 * harness actually ships to a person — and capture machine-readable evidence.
 *
 * WHY WEB, NOT HEADLESS: `@deepseek-ai/dsh-headless` composes no agent-preset
 * roster and refuses any Session that recorded one
 * (packages/bundle/headless/src/index.ts `assertAdoptable`). A preset can only
 * be exercised through a surface that mounts presets: the Web Host does, and it
 * is the surface this deployment runs (http://127.0.0.1:3092). The headless
 * bundle remains covered by its own smoke test (P10.9) and by the Q17
 * consistency comparison.
 *
 * Auth: the Host mints a browser cookie from a launch token printed only at
 * start-up (`dsh web`); a second process cannot reuse it. This driver therefore
 * authenticates with the Host's OWN cookie format, signed by the same persistent
 * secret the Host stores in `$DSH_HOME/.credentials.yaml`
 * (packages/client/connection/src/browser-auth.ts: `encodeCookie`,
 * `cookieName`, `signature`). No token or secret is printed; the cookie is kept
 * in memory for the life of this process.
 *
 * Transport: the same `/api` RPC the browser client uses, with the framing the
 * repository's own Web e2e uses (apps/web/tests/server-restart.e2e.ts:124):
 *
 *   POST /api/<endpoint>
 *   { "type": "client-request", "rpcId": <uuid>, "method": <endpoint>,
 *     "payload": { "args": { … } } }
 *   → { "result": { "ok": true, "value": … } }
 *
 * Flow per run:
 *   1. session-controller/addressedSession  → resolve workspace/cwd,
 *   2. session-controller/create            → { sessionId, agentPreset },
 *   3. session-controller/prompt            → submit the task,
 *   4. observe `session/follow` (WebSocket stream) for turn completion, and
 *      fall back to polling `session-controller/projections`,
 *   5. snapshot the durable session log through tests/e2e/evidence.mjs.
 *
 * Usage:
 *   node web-session.mjs --out <dir> --preset <id> [--cwd <dir>] [--model <provider/model>]
 *                        [--timeout-ms N] -- <task text>
 * Exit: 0 when the turn completed, 1 when it failed, 2 on usage/transport error.
 */
import { createHash, createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'



const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const layout = JSON.parse(readFileSync(join(repo, 'evidence/env/layout.json'), 'utf8'))
const base = process.env.DSH_WEB_URL ?? layout.webUrl ?? 'http://127.0.0.1:3092'
// `yaml` resolves from the checkout's own dependency tree; js-yaml is not
// linked at its root, and the credentials document is plain YAML 1.x.
const yamlRoot = join(layout.dshCheckout, 'node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js')
const YAML = (await import(`file://${yamlRoot}`))

const argv = process.argv.slice(2)
const value = (flag) => {
  const index = argv.indexOf(flag)
  return index < 0 ? undefined : argv[index + 1]
}
const outDir = resolve(value('--out') ?? '')
const preset = value('--preset')
const cwd = value('--cwd') ?? process.cwd()
// Resuming an EXISTING session (restart/recovery test) instead of creating one.
const resumeSessionId = value('--session-id')
const model = value('--model')
const timeoutMs = Number(value('--timeout-ms') ?? 2_400_000)
const separator = argv.indexOf('--')
const task = separator < 0 ? '' : argv.slice(separator + 1).join(' ')
if (value('--out') === undefined || preset === undefined || task.trim() === '') {
  console.error('usage: web-session.mjs --out <dir> --preset <id> [--cwd <dir>] [--model p/m] [--timeout-ms N] -- <task>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

/** Base64url exactly as browser-auth encodes it (no padding, URL alphabet). */
const b64 = (buffer) => Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/**
 * Build the Host's own session cookie: `v1.<payload>.<hmac>` where the payload
 * carries the request authority and the expiry window, signed by the persistent
 * `client-connection/browser-session` secret.
 */
function sessionCookie(authority) {
  // The credentials document is YAML (a strict `refs`/`records` mapping), not JSON.
  const stored = YAML.parse(readFileSync(join(layout.dshHome, '.credentials.yaml'), 'utf8'))
  const record = stored?.records?.['client-connection/browser-session']
  const secretText = record?.payload?.secret
  if (typeof secretText !== 'string' || secretText === '') {
    throw new Error('no browser-session secret in $DSH_HOME/.credentials.yaml; open the URL printed by dsh web once')
  }
  const secret = Buffer.from(secretText, 'base64')
  const issuedAt = Date.now()
  const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1000
  const body = b64(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
  const signature = b64(createHmac('sha256', secret).update(body).digest())
  const name = `dsh-auth-${b64(createHash('sha256').update(authority).digest())}`
  return `${name}=v1.${body}.${signature}`
}

const authority = new URL(base).host
const cookie = sessionCookie(authority)

/** One `/api` RPC call, matching the browser client's envelope. */
async function rpc(endpoint, args, signal) {
  const response = await fetch(new URL(`/api/${endpoint}`, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
    signal,
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch {
    throw new Error(`${endpoint}: non-JSON response ${response.status}: ${text.slice(0, 400)}`)
  }
  const result = parsed?.result ?? parsed
  if (result?.ok !== true) {
    throw new Error(`${endpoint}: ${response.status} ${String(result?.error?.message ?? text.slice(0, 400))}`)
  }
  return result.value
}

const started = Date.now()
const record = { base, preset, cwd, model, task, steps: [], rpc: [] }
try {
  const created = resumeSessionId === undefined
    ? await rpc('session/create', { request: { cwd, agentPreset: preset, ...model === undefined ? {} : {} } })
    : { sessionId: resumeSessionId, agentPreset: preset }
  record.steps.push({ step: 'create', at: Date.now() - started, value: created })
  const sessionId = created.sessionId
  record.sessionId = sessionId
  record.agentPreset = created.agentPreset ?? null
  if (created.agentPreset !== preset) {
    throw new Error(`the Host created the session under preset ${JSON.stringify(created.agentPreset)}, not ${JSON.stringify(preset)}`)
  }

  const promptRequest = {
    requestId: `req-${randomUUID()}`,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: task }],
    clientTimeZone: 'Asia/Shanghai',
  }
  // Everything already in the log belongs to earlier turns; only records at or
  // after this cut are this run's own turns. Read BEFORE the prompt is admitted.
  const baseline = await rpc('session/projections', { request: { sessionId } })
  const baselineSeq = baseline?.asOfSeq ?? 0
  const accepted = await rpc('session/prompt', { request: promptRequest })
  record.steps.push({ step: 'prompt', at: Date.now() - started, value: accepted })

  // Poll the durable projection until the turn boundary advances past zero and
  // no turn is open. `turnBoundary` is the same projection the Host uses to
  // refuse a preset switch, so it is the authoritative "the turn is over" fact.
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await rpc('session/projections', { request: { sessionId } })
    // `sessionStats.turns` and `turnOutline` are the durable evidence that a turn
    // ran and finished; `inbox` shows nothing still queued.
    const stats = last?.values?.sessionStats
    const inbox = last?.values?.inbox
    // The turn is over only when the LOG says so. `session/page` returns
    // `records: SessionEventEntry[]` (the wire envelope), not projection
    // counters — and projections lag (measured: sessionStats.steps stayed at 1
    // while the log already held 5 steps).
    const page = await rpc('session/page', { request: {
      address: { kind: 'session', sessionId },
      // `throughSeq` is an inclusive log cut that must not exceed the current
      // cursor, so it is taken from the projection's own `asOfSeq`.
      throughSeq: last?.asOfSeq ?? 0,
      maxMessages: 600,
    } })
    const records = page?.records ?? []
    const own = records.filter(record => ((record?.event ?? record)?.seq ?? 0) > baselineSeq)
    const lastEnd = [...own].reverse().find(record => (record?.event ?? record)?.type === 'turn/end')
    const lastEvent = records.at(-1)
    const idle = lastEnd !== undefined
      && (inbox?.['next-turn']?.length ?? 0) === 0
      && (inbox?.['next-step']?.length ?? 0) === 0
    if (process.env.DSH_DEBUG_WEB === '1') {
      console.error(JSON.stringify({
        at: Date.now() - started, turns: stats?.turns, steps: stats?.steps,
        records: records.length, tail: records.slice(-2).map(r => (r?.event ?? r)?.type),
        haveTurnEnd: lastEnd !== undefined,
      }))
    }
    if (idle) {
      const tail = (lastEvent?.event ?? lastEvent)
      record.lastEvent = { type: tail?.type, seq: tail?.seq }
      break
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 3000))
  }
  record.steps.push({ step: 'idle', at: Date.now() - started, projections: last })
  if ((last?.values?.sessionStats?.turns ?? 0) === 0) {
    throw new Error('the session never completed a turn before the deadline')
  }
  // The model-facing transcript is the authoritative record of what ran; it is
  // pulled from the same RPC the browser client uses.
  try {
    const page = await rpc('session/page', { request: {
      address: { kind: 'session', sessionId },
      throughSeq: last?.asOfSeq ?? 0,
      maxMessages: 600,
    } })
    const records = (page?.records ?? []).map(record => record?.event ?? record)
      .filter(event => (event?.seq ?? 0) > baselineSeq)
    record.transcript = records
      .filter(event => event?.type === 'assistant/message')
      .map(event => ({
        seq: event.seq,
        text: (event.data?.message?.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n'),
      }))
      .filter(entry => entry.text !== '')
      .slice(-6)
    record.finalAnswer = record.transcript.at(-1)?.text ?? ''
    writeFileSync(join(outDir, 'final-answer.md'), record.finalAnswer)
  } catch (error) {
    record.transcriptError = error instanceof Error ? error.message : String(error)
  }
  record.sessionStats = last.values.sessionStats
  record.tokenUsage = last.values.tokenUsage
  record.contextBreakdown = last.values.contextBreakdown
  record.turnOutline = last.values.turnOutline

  record.elapsedMs = Date.now() - started
  record.status = 'PASS'
  // Snapshot the durable log through the session-query service so the run's
  // evidence sits beside its verdict (never re-derived from the reply text).
  const snapshot = spawnSync(process.execPath, [join(here, 'evidence.mjs'), sessionId, '--project', cwd], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (snapshot.status === 0) {
    writeFileSync(join(outDir, 'session-evidence.json'), snapshot.stdout)
    const parsed = JSON.parse(snapshot.stdout)
    record.sessionEvidence = {
      eventCount: parsed.eventCount,
      counts: parsed.counts,
      toolCalls: parsed.toolCalls.map(call => call.name),
      ptcDispatches: parsed.ptcDispatches.map(call => call.name),
      errors: parsed.errors,
      header: parsed.header,
    }
  } else {
    record.sessionEvidenceError = (snapshot.stderr ?? '').slice(0, 500)
  }
} catch (error) {
  record.status = 'FAIL'
  record.error = error instanceof Error ? error.message : String(error)
  record.elapsedMs = Date.now() - started
}
writeFileSync(join(outDir, 'web-run.json'), `${JSON.stringify(record, null, 2)}\n`)
console.log(JSON.stringify({
  out: join(outDir, 'web-run.json'),
  status: record.status,
  sessionId: record.sessionId ?? null,
  agentPreset: record.agentPreset ?? null,
  elapsedMs: record.elapsedMs,
  error: record.error ?? null,
}, null, 2))
process.exit(record.status === 'PASS' ? 0 : 1)
