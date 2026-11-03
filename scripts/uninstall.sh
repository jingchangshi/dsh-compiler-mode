#!/usr/bin/env bash
# Remove the `ai-compiler` mode from the live Web profile.
#
# Reverses scripts/install.sh: deselects the bundle layer, then removes the linked
# package. The profile's cordis.patch.yml is never touched. Restart the Host
# afterwards so the removed rows disappear from its composition.
#
# The AGENT_GATES_* lines that install.sh adds to $DSH_HOME/.env are ALSO
# removed: they are this repository's own machine parameters (the MCP bridge's
# interpreter and config, and the completion policy's package root), and leaving
# them behind would point the next installation at a stale checkout. Any other
# line in that file belongs to the operator and is preserved.
#
# Usage: scripts/uninstall.sh [--dry-run] [--keep-deps] [--revert-harness]
#   --revert-harness also reverses the capability patch that install.sh applied
#   to the DSH checkout. It is opt-in because the patch is a source change the
#   operator may want to keep; leaving it applied is harmless once no preset
#   mounts the Team bundle.
# Exit: 0 removed, 1 failed, 2 usage error.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
profile_dir="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
checkout="${DSH_CHECKOUT:-$repo/../deepseek-harness}"
manifest="$profile_dir/package.json"
dry=0; keep=0; revert_harness=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --keep-deps) keep=1 ;;
    --revert-harness) revert_harness=1 ;;
    *) printf 'uninstall: unknown option %s\n' "$arg" >&2; exit 2 ;;
  esac
done
say() { printf '%s\n' "$*"; }

[ -f "$manifest" ] || { printf 'uninstall: no profile manifest at %s\n' "$manifest" >&2; exit 1; }

say "== ai-compiler uninstall =="
node - "$manifest" "$dry" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const [path, dry] = [process.argv[2], process.argv[3] === '1']
const manifest = JSON.parse(readFileSync(path, 'utf8'))
const name = '@local/dsh-ai-compiler-preset'
const bundles = manifest.dsh?.profile?.bundles ?? []
if (!bundles.includes(name)) { console.log('bundle   : not selected'); process.exit(0) }
if (dry) { console.log('bundle   : would deselect ' + name); process.exit(0) }
manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: bundles.filter(b => b !== name) } }
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
console.log('bundle   : deselected ' + name)
NODE

if [ "$keep" = 0 ] && [ -d "$profile_dir/node_modules/@local/dsh-ai-compiler-preset" ]; then
  if [ "$dry" = 1 ]; then
    say "package  : would remove @local/dsh-ai-compiler-preset"
  else
    ( cd "$profile_dir" && pnpm remove @local/dsh-ai-compiler-preset >/dev/null 2>&1 ) \
      && say "package  : removed @local/dsh-ai-compiler-preset" \
      || say "package  : removal failed (the layer is already deselected; remove manually if needed)"
  fi
fi

# mcp-client is only in the profile because the compiler presets need it.
if [ "$keep" = 0 ] && [ -d "$profile_dir/node_modules/@deepseek-ai/dsh-mcp-client" ]; then
  if [ "$dry" = 1 ]; then
    say "dep      : would remove @deepseek-ai/dsh-mcp-client"
  else
    ( cd "$profile_dir" && pnpm remove @deepseek-ai/dsh-mcp-client >/dev/null 2>&1 ) \
      && say "dep      : removed @deepseek-ai/dsh-mcp-client" \
      || say "dep      : removal failed (no compiler preset references it now)"
  fi
fi

# Drop every AGENT_GATES_* name install.sh wrote; keep every other line.
dsh_env="${DSH_HOME:-$HOME/.dsh}/.env"
if [ -f "$dsh_env" ]; then
  if [ "$dry" = 1 ]; then
    say "gates    : would drop AGENT_GATES_* from $dsh_env"
  else
    node - "$dsh_env" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const path = process.argv[2]
const kept = readFileSync(path, 'utf8').split('\n')
  .filter(line => /^AGENT_GATES_/.test(line) === false)
while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
writeFileSync(path, kept.length === 0 ? '' : kept.join('\n') + '\n')
console.log('gates    : dropped AGENT_GATES_* from ' + path)
NODE
  fi
fi

# Optionally reverse the capability patch install.sh applied to the DSH checkout.
# Opt-in: the patch is a source change, and leaving it applied is harmless once
# no preset mounts the Team bundle.
if [ "$revert_harness" = 1 ]; then
  if [ "$dry" = 1 ]; then
    say "harness  : would revert capability patches"
    node "$repo/scripts/lib/harness-patches.mjs" revert --dry-run --checkout "$checkout" || true
  else
    node "$repo/scripts/lib/harness-patches.mjs" revert --checkout "$checkout" \
      || say "harness  : revert FAILED (run git status in $checkout, then revert by hand)"
    say "harness  : rebuild the Host lib (pnpm run build:lib:host) before restarting"
  fi
fi

say ""
say "Restart the DSH Web Host to drop the rows from its live composition."
