#!/usr/bin/env node
/**
 * Assert that a preset declaration equals a shipped baseline plus an explicit
 * DIFF list, so "what changed from official PTC" is machine-checkable.
 *
 * The baseline is read from the checkout
 * (`packages/bundle/web-app/presets/ptc.patch.yml`), never copied, so an RC
 * upgrade that changes the shipped PTC list makes this check fail loudly
 * instead of silently drifting.
 *
 * Usage: node verify-preset.mjs [--baseline <ptc.patch.yml>] [--preset <yml>]
 * Exit: 0 when the diff matches the declared set, 1 otherwise, 2 on usage error.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const layout = JSON.parse(readFileSync(join(repo, 'evidence/env/layout.json'), 'utf8'))
const require = createRequire(join(layout.dshCheckout, 'package.json'))
const YAML = require('js-yaml')
const schema = YAML.DEFAULT_SCHEMA.extend([
  new YAML.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => ({ __js: String(value).trim() }) }),
])

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(name)
  return index < 0 ? fallback : argv[index + 1]
}
const baselinePath = flag('--baseline', join(layout.dshCheckout, 'packages/bundle/web-app/presets/ptc.patch.yml'))
const presetPath = flag('--preset', join(repo, 'config/bundle-ai-compiler/cordis.patch.yml'))

/**
 * The declared deviations from official PTC. Every entry is a claim this
 * script verifies; docs/08-compatibility.md is generated from the same list.
 */
const DECLARED = [
  { kind: 'changed', key: 'persona', why: 'compiler-engineering persona prefix' },
  { kind: 'changed', key: 'compaction.tool-result-pruner', why: 'larger evidence-preserving prune budget (8192/4096/1024 -> 20480/12288/4096)' },
  // Q18 fix: the Team API is the only delegation surface, so the four direct
  // delegation rows are disabled (measured defect: the model used `subagent`).
  { kind: 'changed', key: 'delegation.tool-subagent-control', why: 'disabled: Team owns delegation' },
  { kind: 'changed', key: 'delegation.tool-subagent-list-agents', why: 'disabled: Team owns delegation' },
  { kind: 'changed', key: 'delegation.tool-subagent', why: 'disabled: Team owns delegation' },
  { kind: 'changed', key: 'delegation.tool-subagent-fork', why: 'disabled: Team owns delegation' },
]

/** Flatten a preset child list into id → row, descending into `cordis:group` rows. */
function flatten(plugins, prefix = '') {
  const rows = new Map()
  for (const row of plugins ?? []) {
    const path = prefix === '' ? row.id : `${prefix}.${row.id}`
    rows.set(path, row)
    if (row.group === true && Array.isArray(row.config)) flatten(row.config, path).forEach((value, key) => rows.set(key, value))
  }
  return rows
}

const baseline = YAML.load(readFileSync(baselinePath, 'utf8'), { schema })[0].insert[0]
const preset = YAML.load(readFileSync(presetPath, 'utf8'), { schema })[0].insert[0]
const baseRows = flatten(baseline.config.plugins)
const newRows = flatten(preset.config.plugins)

const differences = []
for (const [key, row] of baseRows) {
  if (!newRows.has(key)) {
    differences.push({ kind: 'removed', key, base: JSON.stringify(row).length, ours: null })
    continue
  }
  // `disabled` markers that evaluate at load compare structurally.
  const before = JSON.stringify(row)
  const after = JSON.stringify(newRows.get(key))
  // A `cordis:group` row is a container: reporting it as changed would only
  // repeat its children, which are compared in their own right.
  if (before !== after && row.group !== true) {
    const changedKeys = new Set()
    const keys = new Set([...Object.keys(row), ...Object.keys(newRows.get(key))])
    for (const field of keys) if (JSON.stringify(row[field]) !== JSON.stringify(newRows.get(key)[field])) changedKeys.add(field)
    differences.push({ kind: 'changed', key, base: row, ours: newRows.get(key), fields: [...changedKeys] })
  }
}
for (const key of newRows.keys()) {
  if (!baseRows.has(key)) differences.push({ kind: 'added', key, ours: newRows.get(key) })
}

const failures = []
for (const declared of DECLARED) {
  const found = differences.find(entry => entry.key === declared.key && entry.kind === declared.kind)
  if (found === undefined) failures.push(`declared ${declared.kind} "${declared.key}" is not present in the delivered preset`)
}
for (const difference of differences) {
  const declared = DECLARED.some(entry => entry.key === difference.key && entry.kind === difference.kind)
  if (!declared) failures.push(`undeclared ${difference.kind}: "${difference.key}"`)
}

// Structural invariants the preset depends on.
if (preset.config.id !== 'ai-compiler') failures.push(`config.id must be ai-compiler, got ${JSON.stringify(preset.config.id)}`)
if (typeof preset.config.name !== 'string' || preset.config.name === '') failures.push('config.name is required for the roster')
if (baseRows.get('tool-presentation')?.config?.mode !== 'ptc') failures.push('baseline PTC presentation row missing')
if (newRows.get('tool-presentation')?.config?.mode !== 'ptc') failures.push('delivered preset must keep tool-presentation mode: ptc')
if (newRows.has('planning') !== true) failures.push('planning group missing')
if (newRows.has('compaction') !== true) failures.push('compaction group missing')

const report = {
  baseline: baselinePath,
  preset: presetPath,
  presetId: preset.config.id,
  rows: { baseline: baseRows.size, delivered: newRows.size },
  declared: DECLARED,
  differences,
  failures,
  verdict: failures.length === 0 ? 'PASS' : 'FAIL',
}
console.log(JSON.stringify(report, null, 2))
process.exit(failures.length === 0 ? 0 : 1)
