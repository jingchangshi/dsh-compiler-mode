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

# 2. lsp-stdio / tool-lsp are not dependencies of the rc.3 installation, so the
#    profile must carry them itself. `dsh plugin add --link` writes the link.
for pkg in lsp/lsp lsp/lsp-stdio lsp/tool-lsp; do
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
say "then run scripts/verify.sh to confirm the roster and the wire tool surface."
