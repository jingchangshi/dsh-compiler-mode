#!/usr/bin/env node
/** Experiment 2 — does an explicit maxTokens reach the provider request, and what happens when it is out of range? */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { layout } from '../../scripts/lib/paths.mjs'
const here = dirname(fileURLToPath(import.meta.url)); const repo = resolve(here, '../..')
const { runProfile } = await import(`file://${layout.dshCheckout}/apps/cli/lib/profile-boot.js`)
const entries = Object.fromEntries(Object.entries(process.env).map(([n,v])=>[n,{value:v??''}]))
const { ctx, shutdown } = await runProfile({ environment:{entries,get:n=>entries[n],has:n=>entries[n]!==undefined},
  profile:'ai-compiler-scratch', patchFiles:[join(repo,'tests/e2e/cases/model-overlay.yml')], args:['probe'] })
const agents = ctx.get('agents'), subagents = ctx.get('subagents'), persistence = ctx.get('sessionPersistence')
const lead = (await agents.create({ sessionId:`session-mt-${Date.now()}`, meta:{cwd:process.cwd()} })).agent
const rows = []
const CASES = [
  { provider:'magpie', model:'auto/deepseek-v4.1-flash', maxTokens: 4096,  why:'well under cap' },
  { provider:'magpie', model:'auto/deepseek-v4.1-flash', maxTokens: 393216, why:'exactly at cap' },
  { provider:'magpie', model:'auto/deepseek-v4.1-flash', maxTokens: 999999, why:'above model cap' },
  { provider:'corp',   model:'GLM-5.3-Flash',            maxTokens: 8192,  why:'corp route, no declared maxTokens' },
]
for (const [i, c] of CASES.entries()) {
  const childId = `child-mt-${i}`
  let out
  try {
    const a = await subagents.startActivation({ delivery:'parent', childId, provider:'spawn', label:`mt-${i}`,
      request:{ prompt:[{type:'text',text:'Reply OK.'}], parent: lead, agentOptions:{ provider:c.provider, model:c.model, maxTokens:c.maxTokens } },
      signal: AbortSignal.timeout(240000) })
    await a.result.catch(()=>undefined)
    await new Promise(r=>setTimeout(r,500))
    const h = await persistence.open(childId,'read',{signal:AbortSignal.timeout(20000)})
    try {
      const { events } = await h.read(0, undefined, { signal: AbortSignal.timeout(20000) })
      const hdr = [...events].reverse().find(e=>e.type==='request/header')
      const cfg = hdr?.data?.header?.config ?? hdr?.data?.config ?? null
      const end = events.filter(e=>e.type==='turn/end').at(-1)
      out = { reachedRequest: cfg!==null, requestedMaxTokens: c.maxTokens, actualMaxTokens: cfg?.maxTokens ?? null,
              stopReason: end?.data?.reason?.kind ?? null, error: end?.data?.reason?.error?.message ?? null }
    } finally { await h.close() }
  } catch (e) { out = { reachedRequest:false, requestedMaxTokens:c.maxTokens, stopReason:'start-failed', error:String(e.message).slice(0,200) } }
  rows.push({ ...c, ...out })
  console.log(`${c.provider}/${c.model}`.padEnd(36), String(c.maxTokens).padEnd(8), (out.stopReason??'?').padEnd(12),
    'actual=', out.actualMaxTokens ?? '-', out.error ? `ERR=${String(out.error).slice(0,90)}` : '')
}
const out='evidence/design/maxtokens-probe.json'; mkdirSync(dirname(resolve(repo,out)),{recursive:true})
writeFileSync(resolve(repo,out), JSON.stringify({ at:new Date().toISOString(), rows }, null, 2)+'\n')
console.log('wrote', out)
await shutdown?.shutdown?.(0); await ctx.fiber?.dispose?.(); process.exit(0)
