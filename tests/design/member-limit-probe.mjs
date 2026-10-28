#!/usr/bin/env node
/** Experiment 3 — how many teammates can one Team hold, and what is the exact error past the limit? */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { layout } from '../../scripts/lib/paths.mjs'
const here = dirname(fileURLToPath(import.meta.url)); const repo = resolve(here, '../..')
const { runProfile } = await import(`file://${layout.dshCheckout}/apps/cli/lib/profile-boot.js`)
const entries = Object.fromEntries(Object.entries(process.env).map(([n,v])=>[n,{value:v??''}]))
const { ctx, shutdown } = await runProfile({ environment:{entries,get:n=>entries[n],has:n=>entries[n]!==undefined},
  profile:'ai-compiler-scratch', patchFiles:[join(repo,'tests/e2e/cases/model-overlay.yml')], args:['probe'] })
const agents = ctx.get('agents'), teams = ctx.get('agentTeams'), presets = ctx.get('agentPresets')
const lead = (await agents.create({ sessionId:`session-ml-${Date.now()}`, meta:{cwd:process.cwd()},
  setup: async c => { await presets.mount(c, 'ai-compiler') } })).agent
const rows = []
// Spawn until the Team refuses, recording each edge. maxMembers is 8 in the bundle.
for (let i = 1; i <= 10; i += 1) {
  try {
    const r = await teams.spawnTeammate(lead, { name:`member-${i}`, description:`limit probe ${i}`,
      prompt:[{type:'text',text:'Reply OK.'}], context:'fresh', provider:'spawn',
      signal: AbortSignal.timeout(240_000) })
    rows.push({ index:i, created:true, phase:r.member.status })
    console.log(`member-${i}: created (${r.member.status})`)
  } catch (e) {
    rows.push({ index:i, created:false, code:e.code ?? null, message:String(e.message).slice(0,200) })
    console.log(`member-${i}: REFUSED  code=${e.code}  ${String(e.message).slice(0,120)}`)
    break
  }
}
const members = teams.listMembers(lead)
const out = { at:new Date().toISOString(), attempts:rows, rosterSize:members.length,
  roster: members.map(m=>({ name:m.name, role:m.role, status:m.status })) }
const path='evidence/design/member-limit-probe.json'; mkdirSync(dirname(resolve(repo,path)),{recursive:true})
writeFileSync(resolve(repo,path), JSON.stringify(out,null,2)+'\n')
console.log('roster size:', members.length, '| wrote', path)
await shutdown?.shutdown?.(0); await ctx.fiber?.dispose?.(); process.exit(0)
