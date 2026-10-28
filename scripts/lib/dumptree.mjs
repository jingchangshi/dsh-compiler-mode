#!/usr/bin/env node
/**
 * Summarize a `dsh --dump-config` entry list as an indented tree.
 * Prints one line per row: `[id] name  disabled=<expr> cfg(a,b)`.
 * `!!js` scalars are shown as `JS(expr)`; groups recurse into `config`.
 * Usage: node scripts/lib/dumptree.mjs <dump-config.yml>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { harnessCheckout } from './paths.mjs'

// `js-yaml` is resolved from the harness checkout, which is the installation
// that owns the YAML dialect being read here (its `!!js` tag).
const checkout = harnessCheckout
const require = createRequire(join(checkout, 'package.json'))
const YAML = require('js-yaml')

const jsType = new YAML.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => `JS(${String(value).split(String.fromCharCode(10))[0]})`,
})
const doc = YAML.load(readFileSync(process.argv[2], 'utf8'), { schema: YAML.DEFAULT_SCHEMA.extend([jsType]) })

function walk(entries, depth = 0) {
  for (const row of entries ?? []) {
    if (row === null || typeof row !== 'object') continue
    const pad = '  '.repeat(depth)
    if (row.name === 'cordis:group') {
      console.log(`${pad}[${row.id}] GROUP isolate=${JSON.stringify(row.isolate)}`)
      walk(row.config, depth + 1)
    } else if (row.name === 'cordis:include') {
      console.log(`${pad}[${row.id}] INCLUDE ${row.config?.path}`)
    } else {
      const keys = row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config)
        ? Object.keys(row.config).join(',')
        : ''
      console.log(`${pad}[${row.id}] ${row.name}${row.disabled === undefined ? '' : ` disabled=${row.disabled}`}${keys === '' ? '' : ` cfg(${keys})`}`)
    }
  }
}
walk(doc)
