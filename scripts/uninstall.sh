#!/usr/bin/env bash
# Remove the `ai-compiler` mode from the live Web profile.
#
# Reverses scripts/install.sh: deselects the bundle layer, then removes the linked
# package. The profile's cordis.patch.yml is never touched. Restart the Host
# afterwards so the removed rows disappear from its composition.
#
# Usage: scripts/uninstall.sh [--dry-run] [--keep-deps]
# Exit: 0 removed, 1 failed, 2 usage error.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
profile_dir="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
manifest="$profile_dir/package.json"
dry=0; keep=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --keep-deps) keep=1 ;;
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
say ""
say "Restart the DSH Web Host to drop the rows from its live composition."
