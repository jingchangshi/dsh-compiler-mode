#!/usr/bin/env node
/** Record a machine-readable version/dependency lock for the delivery. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const checkout = process.env.DSH_CHECKOUT ?? '/home/s00653124/workspace/deepseek-harness'
const sh = (command) => spawnSync('bash', ['-lc', command], { encoding: 'utf8' }).stdout.trim()
const manifest = (relative) => {
  const parsed = JSON.parse(readFileSync(join(checkout, relative, 'package.json'), 'utf8'))
  return { dir: relative, name: parsed.name, version: parsed.version }
}

const profileManifestPath = process.env.DSH_PROFILE_DIR ?? '/home/s00653124/.dsh/profiles/web'
const lock = {
  generatedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    pnpm: sh('pnpm -v'),
    os: sh('uname -sr'),
    kernelLsm: readFileSync('/sys/kernel/security/lsm', 'utf8').trim(),
    apparmorRestrictUnprivilegedUserns: sh('cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
  },
  dsh: {
    version: sh(`node ${join(checkout, 'apps/cli/lib/bin.js')} --version`),
    commit: sh(`git -C ${checkout} rev-parse HEAD`),
    branch: sh(`git -C ${checkout} rev-parse --abbrev-ref HEAD`),
    tags: sh(`git -C ${checkout} tag -l`) === '' ? [] : sh(`git -C ${checkout} tag -l`).split('\n'),
  },
  toolchain: {
    clangdPath: sh('command -v clangd'),
    clangdVersion: sh('clangd --version | head -1'),
    clangdLLVM22: '/home/s00653124/Softwares/clangd/bin/clangd',
    clangdLLVM22Version: sh('/home/s00653124/Softwares/clangd/bin/clangd --version | head -1'),
    clang: sh('clang --version | head -1'),
    cmake: sh('cmake --version | head -1'),
    ninja: sh('ninja --version'),
    ripgrep: sh('rg --version | head -1'),
    bwrap: sh('bwrap --version'),
  },
  /** Every DSH workspace package the preset composes directly. */
  composedPackages: [
    'packages/preset/agent-preset',
    'packages/preset/agent-preset-registry',
    'packages/preset/persona',
    'packages/context/agent-instructions',
    'packages/context/time-context',
    'packages/shell/tool-bash',
    'packages/fs/tool-fs',
    'packages/fs/tool-fs-search',
    'packages/jobs/tool-jobs',
    'packages/schedule/tool-schedule',
    'packages/skill/skill-filesystem',
    'packages/skill/tool-skill',
    'packages/goal/command-goal',
    'packages/goal/tool-goal',
    'packages/plan/plan-mode',
    'packages/compaction/compaction-basic',
    'packages/compaction/command-compact',
    'packages/compaction/compaction-tool-result-pruner',
    'packages/subagent/tool-subagent-control',
    'packages/subagent/tool-subagent',
    'packages/workflow/workflow-ptc',
    'packages/workflow/tool-workflow',
    'packages/interaction/tool-ask-user',
    'packages/todo/tool-todo',
    'packages/web/tool-web',
    'packages/core/agent-tool-presentation',
    'packages/core/tools',
    'packages/ptc-runtime/ptc-runtime-node',
    'packages/spill/spill-local',
    'packages/spill/spill-policy',
    'packages/lsp/lsp',
    'packages/lsp/lsp-stdio',
    'packages/lsp/tool-lsp',
    'packages/experimental/agent-team-profile',
    'packages/experimental/agent-team',
    'packages/experimental/tool-agent-team',
    'packages/experimental/client-ui-agent-team',
    'packages/sandbox/sandbox-local',
    'packages/sandbox/sandbox-policy',
    'packages/sandbox/bash-sandbox',
    'packages/fs/fs-sandbox',
    'packages/interaction/permission-presets',
    'packages/interaction/user-approval',
    'packages/bundle/base',
    'packages/bundle/web-app',
    'packages/bundle/headless',
  ].map(relative => {
    try { return manifest(relative) } catch (error) {
      return { dir: relative, error: error instanceof Error ? error.message : String(error) }
    }
  }),
  profile: {
    dir: profileManifestPath,
    manifest: JSON.parse(readFileSync(join(profileManifestPath, 'package.json'), 'utf8')),
  },
  deliveryBundle: {
    dir: join(repo, 'config/bundle-ai-compiler'),
    manifest: JSON.parse(readFileSync(join(repo, 'config/bundle-ai-compiler/package.json'), 'utf8')),
  },
}
mkdirSync(join(repo, 'evidence/env'), { recursive: true })
writeFileSync(join(repo, 'evidence/env/versions.json'), `${JSON.stringify(lock, null, 2)}\n`)
console.log(JSON.stringify({ out: 'evidence/env/versions.json', packages: lock.composedPackages.length, dsh: lock.dsh }, null, 2))
