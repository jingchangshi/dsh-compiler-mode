#!/usr/bin/env bash
# Install the `ai-compiler` mode into the live Web profile.
#
# Idempotent: re-running re-installs the same bundle. Never edits the profile's
# cordis.patch.yml (verified by scripts/verify.sh). Requires the DSH Host to be
# (re)started afterwards so the new rows exist in its composition.
#
# Usage: scripts/install.sh [--dry-run]
# Exit: 0 installed, 1 failed, 2 usage error.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
bundle="$repo/config/bundle-ai-compiler"
profile_dir="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
dsh_cli="${DSH_CLI:-$repo/../deepseek-harness/apps/cli/lib/bin.js}"
dry=0
[ "${1:-}" = "--dry-run" ] && dry=1

say() { printf '%s\n' "$*"; }
fail() { printf 'install: %s\n' "$*" >&2; exit 1; }

[ -f "$bundle/package.json" ] || fail "bundle manifest missing: $bundle/package.json"
[ -f "$bundle/cordis.patch.yml" ] || fail "preset patch missing"
[ -d "$profile_dir" ] || fail "profile not found: $profile_dir"

say "== prerequisite checks =="

# Every dependency this bundle needs EXTERNAL to the DSH installation is checked
# here, and a missing one FAILS the install. The alternative, letting the rows
# fail to activate at runtime, produces a mode that looks installed and is
# silently half-alive: lsp-stdio reports only a startup warning while the lsp
# tool never appears, and the model discovers the gap by being denied a call.
#
# Dependency: why it is needed, and how to satisfy it.
missing=0
require() {
  name="$1"; why="$2"; hint="$3"
  if command -v "$name" >/dev/null 2>&1; then
    say "prereq   : $name  -> $(command -v "$name")"
  else
    printf "install: MISSING PREREQUISITE %s\n" "$name" >&2
    printf "  needed for : %s\n" "$why" >&2
    printf "  install    : %s\n" "$hint" >&2
    missing=$((missing + 1))
  fi
}

# clangd backs the code-navigation surface: host row lsp-stdio, consumed by the
# lsp tool both compiler presets declare.
require clangd \
  "code navigation: the presets declare the lsp tool, served by host row lsp-stdio" \
  "install LLVM/clangd, or put a clangd binary on PATH"

# docker runs every compiler gate for both adapters.
require docker \
  "compiler gates: both adapters exec a container" \
  "install Docker Engine and ensure this user can reach the daemon"

# The AgentGates bridge is a Python program; the interpreter recorded for the
# preset row must exist before the install claims success.
require python3 \
  "the AgentGates MCP bridge and CLI" \
  "install Python >= 3.11"

if [ "$missing" -ne 0 ]; then
  printf "install: %d prerequisite(s) missing; nothing was changed\n" "$missing" >&2
  exit 1
fi

say ""
say "== ai-compiler install =="
say "bundle   : $bundle"
say "profile  : $profile_dir"
say "dsh      : $dsh_cli"

# 1. Back up the profile the first time only (never overwrite a good backup).
backup="$repo/evidence/backup/profile-install-$(date +%Y%m%d-%H%M%S)"
if [ "$dry" = 0 ]; then
  mkdir -p "$backup"
  cp -a "$profile_dir/package.json" "$profile_dir/cordis.patch.yml" "$backup/" 2>/dev/null || true
  say "backup   : $backup"
fi

# 2. lsp-stdio / tool-lsp / mcp-client are not dependencies of the rc.3
#    installation, so the profile must carry them itself. `dsh plugin add --link`
#    writes the link.
#
#    mcp-client is what mounts the AgentGates gate server (the mcp-agentgates
#    row inside each compiler preset). Without this link that row cannot import
#    and the compiler modes would silently have no gate tools at all.
for pkg in lsp/lsp lsp/lsp-stdio lsp/tool-lsp mcp/mcp-client; do
  name="@deepseek-ai/dsh-${pkg##*/}"
  if node -e "process.exit(Object.keys(require('$profile_dir/package.json').dependencies||{}).includes('$name')?0:1)"; then
    say "dep      : $name already present"
  else
    [ "$dry" = 1 ] && { say "dep      : would add $name"; continue; }
    node "$dsh_cli" plugin --profile web add --link "$repo/../deepseek-harness/packages/$pkg" >/dev/null \
      || fail "could not add $name"
    say "dep      : added $name"
  fi
done

# 2b. Locate the AgentGates gate server and record it for the preset row.
#
#     The row resolves its command from AGENT_GATES_MCP_PYTHON (an !!js
#     expression evaluated against the DSH process environment), so the machine
#     parameter stays out of the delivered YAML and out of any shell string. The
#     value is written to $DSH_HOME/.env, which the launcher loads as the USER
#     env layer -- one file for every profile.
#
#     Both variables are written together: a server reading a different config
#     than the operator's `agent-gates` CLI would answer about the wrong
#     instance, which is worse than not starting.
# Both paths are canonicalised before being written: the value is consumed by a
# long-lived systemd unit whose working directory is unrelated to this repo, so
# a relative or un-normalised path ("$repo/../AgentGates/...") would resolve
# somewhere else, or nowhere.
agentgates_repo="$(cd "${AGENT_GATES_REPO:-$repo/../AgentGates}" 2>/dev/null && pwd)" \
  || agentgates_repo="${AGENT_GATES_REPO:-$repo/../AgentGates}"
ag_python="${AGENT_GATES_MCP_PYTHON:-$agentgates_repo/.venv/bin/python}"
ag_config="${AGENT_GATES_CONFIG:-$HOME/.config/agent-gates/config.toml}"
ag_config="$(cd "$(dirname "$ag_config")" 2>/dev/null && pwd)/$(basename "$ag_config")"
dsh_env="${DSH_HOME:-$HOME/.dsh}/.env"
if [ ! -x "$ag_python" ]; then
  say "gates    : WARNING no interpreter at $ag_python — the bridge will not start"
  say "gates    : set AGENT_GATES_REPO or AGENT_GATES_MCP_PYTHON and re-run"
elif [ "$dry" = 1 ]; then
  say "gates    : would record AGENT_GATES_MCP_PYTHON=$ag_python"
  say "gates    : would record AGENT_GATES_CONFIG=$ag_config"
  say "gates    : would record AGENT_GATES_ROOT=$agentgates_repo"
else
  # Rewrite only these two names; every other line in the user env layer is the
  # operator's own and is preserved verbatim.
  node - "$dsh_env" "$ag_python" "$ag_config" "$agentgates_repo" <<'NODE'
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs')
const { dirname } = require('node:path')
const [path, python, config, root] = process.argv.slice(2)
// Three names, one file: the MCP bridge row reads the first two, and the
// completion-policy row reads AGENT_GATES_ROOT to locate the package it
// invokes. Recording all three keeps both rows on the SAME installation --
// two rows reading different checkouts would let the bridge and the policy
// disagree about what a receipt means.
const wanted = { AGENT_GATES_MCP_PYTHON: python, AGENT_GATES_CONFIG: config, AGENT_GATES_ROOT: root }
const kept = existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(line => (line.split('=')[0] in wanted) === false)
  : []
while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
for (const [name, value] of Object.entries(wanted)) kept.push(name + '=' + value)
mkdirSync(dirname(path), { recursive: true })
writeFileSync(path, kept.join('\n') + '\n')
console.log('gates    : recorded in ' + path)
NODE
  say "gates    : AGENT_GATES_MCP_PYTHON=$ag_python"
  say "gates    : AGENT_GATES_CONFIG=$ag_config"
  say "gates    : AGENT_GATES_ROOT=$agentgates_repo"
  if [ -f "$ag_config" ]; then
    say "gates    : config present"
  else
    say "gates    : WARNING no config at $ag_config — the server starts and reports it"
  fi
fi

# 3. Install + select the bundle.
if [ "$dry" = 1 ]; then
  say "bundle   : would run plugin_manager install_bundle $bundle"
else
  marker="$profile_dir/package.json"
  before="$(sha256sum "$marker" | cut -d' ' -f1)"
  say "bundle   : installing through dsh plugin (link) ..."
  node "$dsh_cli" plugin --profile web add --link "$bundle" >/dev/null || fail "bundle install failed"
  after="$(sha256sum "$marker" | cut -d' ' -f1)"
  [ "$before" = "$after" ] && say "bundle   : already installed"
fi

# 4. Select the bundle as a profile layer (idempotent append).
if [ "$dry" = 0 ]; then
  node - "$profile_dir/package.json" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const path = process.argv[2]
const manifest = JSON.parse(readFileSync(path, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles ?? []
const name = '@local/dsh-ai-compiler-preset'
if (bundles.includes(name)) { console.log('bundle   : already selected'); process.exit(0) }
manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, name] } }
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
console.log('bundle   : selected')
NODE
fi

say ""
say "Next: restart the DSH Web Host so the new rows exist in its composition,"
say "then run scripts/verify.sh to confirm the roster, the agentgates tool names"
say "and the wire tool surface."
say ""
say "The agentgates tools only register if the bridge started. If verify.sh"
say "reports them missing, run the server by hand to see why:"
say "  $ag_python -s -m agent_gates.mcp_server    # expects JSON-RPC on stdin"
say "  $ag_python -m agent_gates.cli doctor       # server-side self check"
