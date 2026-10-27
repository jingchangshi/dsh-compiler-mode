#!/usr/bin/env node
/**
 * Q-P6-a: record exactly how clangd parses a real, large C++ compile_commands.json.
 *
 * Runs `clangd --check=<file> --compile-commands-dir=<dir>` with `--log=info` and
 * captures, per file, the flag translation clangd performs:
 *   - "Compilation database" load line + entry count
 *   - "Compile command from CDB is:" (the command clangd actually uses)
 *   - "internal (cc1) args are:"   (the driver -> cc1 translation)
 *   - "All checks completed, N errors"
 *
 * It then diffs the CDB command against the cc1 args to list flags clangd
 * DROPPED, and reports the resource-dir it substituted. This is evidence for
 * docs/08-compatibility.md; it modifies nothing.
 *
 * Usage: node cdb-parse-audit.mjs <compile_commands.json> <repoRoot> <relFile>
 * Exit: 0 when clangd loaded the CDB and completed a check; 1 otherwise.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [cdb, repoRoot, relFile] = process.argv.slice(2)
if (cdb === undefined || repoRoot === undefined || relFile === undefined) {
  console.error('usage: cdb-parse-audit.mjs <compile_commands.json> <repoRoot> <relFile>')
  process.exit(2)
}
const clangd = process.env.CLANGD ?? 'clangd'
const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../../evidence/code-intelligence')
mkdirSync(outDir, { recursive: true })

const db = JSON.parse(readFileSync(cdb, 'utf8'))
const target = db.find(entry => entry.file.endsWith(relFile))
if (target === undefined) {
  console.error(`no CDB entry for ${relFile}`)
  process.exit(1)
}

const run = spawnSync(clangd, [
  '--log=info',
  '--background-index=0',
  `--check=${join(repoRoot, relFile)}`,
  `--compile-commands-dir=${dirname(cdb)}`,
], { cwd: repoRoot, encoding: 'utf8', timeout: 180_000 })
const log = `${run.stdout ?? ''}${run.stderr ?? ''}`

const pick = (pattern) => {
  const match = new RegExp(pattern, 'm').exec(log)
  if (match === null) return undefined
  // Array.prototype.slice would coerce a RegExpExecArray into an object; index explicitly.
  return match.length === 2 ? match[1] : match.slice(1)
}
const cdbCommand = pick('Compile command from CDB is: \\[(.*?)\\] (.+)')
const internalArgs = pick('internal \\(cc1\\) args are: (.*)')
const loaded = pick('Loaded compilation database from (.*)')
const completed = pick('All checks completed, (\\d+) errors')

/** Flags present in the CDB command but absent from the cc1 arg list. */
function droppedFlags(commandText, cc1Text) {
  if (commandText === undefined || cc1Text === undefined) return undefined
  const tokens = commandText.split(/\s+/).filter(token => token.startsWith('-'))
  const dropped = new Set()
  for (const token of tokens) {
    const name = token.split('=')[0]
    // Ignore driver-only noise: paths, output, compiler, and color/pipe knobs.
    if (/^-([IDo]|resource-dir|target-cpu)/.test(name)) continue
    if (name === '-pipe' || name === '-fdiagnostics-color' || name === '-std') continue
    if (!cc1Text.includes(name)) dropped.add(name)
  }
  return [...dropped]
}

const result = {
  clangd,
  clangdVersion: spawnSync(clangd, ['--version'], { encoding: 'utf8' }).stdout.trim().split('\n')[0],
  compileCommands: cdb,
  entries: db.length,
  compilers: [...new Set(db.map(entry => entry.command.split(/\s+/)[0]))],
  file: target.file,
  workingDirectory: cdbCommand?.[0],
  loadedDatabase: loaded,
  checksCompleted: completed,
  droppedByClangdDriver: droppedFlags(cdbCommand?.[1], internalArgs),
  headerSearchFromGccInstall: internalArgs === undefined
    ? undefined
    : [...new Set([...internalArgs.matchAll(/-internal-isystem (\S+)/g)].map(m => m[1]))],
  resourceDir: internalArgs?.match(/-resource-dir (\S+)/)?.[1],
  exitCode: run.status,
}
const outFile = join(outDir, `cdb-parse-${relFile.replace(/[^\w.-]+/gu, '_')}.json`)
writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`)
const logFile = join(outDir, `cdb-parse-${relFile.replace(/[^\w.-]+/gu, '_')}.log`)
writeFileSync(logFile, log)
console.log(JSON.stringify({ ...result, droppedByClangdDriver: result.droppedByClangdDriver }, null, 2))
process.exit(loaded !== undefined && completed === '0' && run.status === 0 ? 0 : 1)
