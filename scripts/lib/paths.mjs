#!/usr/bin/env node
/**
 * Machine paths, derived at run time.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every path below used to be an absolute path from the machine this delivery
 * was authored on. Copying the repository to another machine kept those paths: an environment variable that the new machine does
 * not export fell back to a directory that does not exist there, and the
 * failure surfaced far away -- as ERR_MODULE_NOT_FOUND inside a test, or as a
 * bridge that starts the interpreter of a machine that is not this one.
 *
 * The rule now, for every value here:
 *
 *   1. an environment variable overrides it;
 *   2. otherwise derive it from the location of this file (the repository
 *      knows where it is, so its siblings are known too);
 *   3. otherwise FAIL LOUD. There is deliberately no fallback to a path from
 *      any other machine: a wrong path that looks plausible costs more to
 *      diagnose than a message that names the missing directory.
 *
 * `evidence/env/layout.json` is a HISTORICAL record produced on the authoring
 * machine. It is never read for a machine path. Only fields that are genuine
 * operator choices and cannot be derived (`webUrl`, `spillRoot`) may still come
 * from it, so an old layout file cannot steer a new machine.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const libDir = path.dirname(fileURLToPath(import.meta.url))

/** First candidate that exists, or the first candidate when none does. */
function firstExisting(candidates) {
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]
}

function deriveDir(envValue, candidates, label, variable) {
  if (envValue !== undefined && envValue !== '') return path.resolve(envValue)
  const chosen = firstExisting(candidates)
  if (!existsSync(chosen)) {
    throw new Error(
      `${label}: none of ${candidates.join(', ')} exists. `
      + `Set ${variable}, or place the checkout beside this repository (${path.resolve(libDir, '..', '..')}).`)
  }
  return chosen
}

/**
 * Load the machine values `install.sh` recorded, at the path the systemd unit
 * reads them from.
 *
 * The Web Host gets these through `EnvironmentFile=$DSH_HOME/.env`. A process
 * that boots a profile BY HAND -- the acceptance suites, a one-off
 * `dsh --profile … --patch …` run -- sees none of them, so a row written as
 * `!!js process.env.AGENT_GATES_MCP_PYTHON` evaluates to undefined and the row
 * either refuses to start or (worse) is silently absent. Loading the file here
 * makes a hand-run boot see exactly what the service sees.
 *
 * An explicit export wins: the file is the machine default, not an override of
 * the operator's current shell. Only `NAME=value` lines are understood, the
 * same grammar install.sh writes.
 */
function loadDshEnv() {
  const home = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')
  const file = path.join(home, '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (match === null) continue
    const [, name, raw] = match
    if (process.env[name] !== undefined) continue
    process.env[name] = raw.replace(/^(['"])(.*)\1$/, '$2')
  }
}

loadDshEnv()

/** This repository's root. */
export const repoRoot = process.env.DSH_REPO_ROOT ?? path.resolve(libDir, '..', '..')
/** The directory the sibling checkouts live in. */
export const workspaceDir = path.resolve(repoRoot, '..')

/** The deepseek-harness checkout the delivery runs against. */
export const harnessCheckout = deriveDir(
  process.env.DSH_CHECKOUT,
  [path.join(workspaceDir, 'deepseek-harness'), path.join(process.env.HOME ?? '', 'workspace', 'deepseek-harness')],
  'harness checkout', 'DSH_CHECKOUT')

/** The AgentGates checkout. */
export const agentGatesRoot = deriveDir(
  process.env.AGENT_GATES_ROOT,
  [path.join(workspaceDir, 'AgentGates'), path.join(process.env.HOME ?? '', 'workspace', 'AgentGates')],
  'AgentGates checkout', 'AGENT_GATES_ROOT')

/** The interpreter that runs the AgentGates MCP server and CLI. */
export const agentGatesPython = process.env.AGENT_GATES_MCP_PYTHON
  ?? process.env.AGENT_GATES_PYTHON
  ?? path.join(agentGatesRoot, '.venv', 'bin', 'python')

/** The AgentGates V2 configuration file. */
export const agentGatesConfig = process.env.AGENT_GATES_CONFIG
  ?? path.join(process.env.HOME ?? '', '.config', 'agent-gates', 'config.toml')

/** The DSH home directory (`--profile` manifests, `.env`, sessions). */
export const dshHome = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')
/** The live Web profile directory. */
export const dshProfileDir = process.env.DSH_PROFILE_DIR ?? path.join(dshHome, 'profiles', 'web')

/** The AscendNPU-IR checkout: the tree AgentGates builds and clangd navigates. */
export const ascendNpuIrRoot = deriveDir(
  process.env.ASCENDNPU_IR_ROOT,
  [
    path.join(workspaceDir, 'AscendNPU-IR'),
    path.join(workspaceDir, 'AscendNPU-IR-1'),
    path.join(workspaceDir, 'AscendNPU-IR-2'),
  ],
  'AscendNPU-IR checkout', 'ASCENDNPU_IR_ROOT')

/** The TileLang checkout. */
export const tilelangRoot = deriveDir(
  process.env.TILELANG_ROOT,
  [path.join(workspaceDir, 'tilelang')],
  'tilelang checkout', 'TILELANG_ROOT')

/** The PiEngineeringHarness checkout (read-only reference). */
export const piHarnessRoot = process.env.PI_HARNESS_ROOT ?? path.join(workspaceDir, 'PiEngineeringHarness')

/** The clangd binary for the LLVM 22 code-navigation overlay. */
export const clangdLLVM22Bin = process.env.CLANGD_LLVM22_BIN ?? ''

/** Fields an operator may still pin, and that no derivation can invent. */
function operatorOverrides() {
  const file = path.join(repoRoot, 'evidence/env/layout.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

const recorded = operatorOverrides()

/** The DSH Web URL; the unit on this machine listens on 3091. */
export const webUrl = process.env.DSH_WEB_URL ?? recorded.webUrl ?? 'http://127.0.0.1:3091'
/** Spill root, when one was pinned; the default is a per-process mkdtemp. */
export const spillRoot = process.env.DSH_SPILL_ROOT ?? recorded.spillRoot

/**
 * The shape `evidence/env/layout.json` used to provide, with every machine
 * path replaced by the derived one. Tests import this instead of parsing the
 * recorded file, so a recorded path from another machine can never drive them.
 */
export const layout = {
  ...recorded,
  dshCheckout: harnessCheckout,
  dshHome,
  profiles: { ...(recorded.profiles ?? {}), web: dshProfileDir },
  references: {
    ...(recorded.references ?? {}),
    ascendNpuIr: ascendNpuIrRoot,
    ascendCompileCommands: path.join(ascendNpuIrRoot, 'build', 'compile_commands.json'),
    tilelang: tilelangRoot,
    piEngineeringHarness: piHarnessRoot,
    agentGates: agentGatesRoot,
  },
  spillRoot,
  webUrl,
}
