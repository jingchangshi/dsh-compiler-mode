#!/usr/bin/env bash
# Provision the throwaway acceptance profile the suites boot.
#
# WHY THIS EXISTS
# The acceptance suites (tests/mcp/tool-scope.mjs, the composition and
# permission suites, tests/mcp/team-gate.mjs) boot a profile that is NOT the
# live Web profile: booting the live one starts the webserver and the whole web
# plane, which is a different (and much slower) thing to assert, and it would
# collide with the UI already listening on its port. They default to the
# profile name `ai-compiler-scratch`, which nothing else creates, so on a fresh
# machine every one of them fails with `profile "ai-compiler-scratch" does not
# exist` -- a message that reads like a defect in the bundle.
#
# The profile is composed the same way the live one is -- the shipped web
# template, the packages rc.3 does not ship (lsp, lsp-stdio, tool-lsp,
# mcp-client), then the delivered bundle -- so a suite that passes here is
# evidence about the bundle, not about a hand-built profile.
#
# The one deliberate difference is the HTTP surface, disabled in the profile's
# user layer (see the block written below). Without that, a suite's dummy
# argument is handed to the Web app's command line, which rejects an argument
# it never declared and aborts the boot before any roster exists.
#
# Idempotent: a profile that already carries the bundle is left alone.
#
# Usage: scripts/scratch-profile.sh [--name <profile>]
# Exit: 0 profile ready, 1 could not prepare it.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
checkout="$(cd "$repo/../deepseek-harness" && pwd)"
dsh_cli="${DSH_CLI:-$checkout/apps/cli/lib/bin.js}"
bundle="$repo/config/bundle-ai-compiler"
marker='@local/dsh-ai-compiler-preset'

name="${DSH_SCRATCH_PROFILE:-ai-compiler-scratch}"
if [ "${1:-}" = "--name" ]; then name="$2"; fi
profile_dir="${DSH_HOME:-$HOME/.dsh}/profiles/$name"

if node -e "process.exit((require(process.argv[1]).dsh?.profile?.bundles ?? []).includes(process.argv[2]) ? 0 : 1)" \
     "$profile_dir/package.json" "$marker" 2>/dev/null; then
  printf 'scratch    : %s already carries the bundle\n' "$name"
  exit 0
fi

if [ ! -f "$profile_dir/package.json" ]; then
  # The shipped template, not a hand-written manifest: the profile must contain
  # exactly the rows the live Web profile contains, or the suite would be
  # asserting a composition nobody runs.
  node "$dsh_cli" --profile "$name" --from-default-profile web --dump-config >/dev/null 2>&1
  printf 'scratch    : created %s from the shipped web template\n' "$name"
fi

# rc.3 does not ship these packages, so the profile must carry them itself --
# the same four the live install links, plus the bundle.
for pkg in lsp/lsp lsp/lsp-stdio lsp/tool-lsp mcp/mcp-client; do
  node "$dsh_cli" plugin --profile "$name" add --link "$checkout/packages/$pkg" >/dev/null 2>&1
done
node "$dsh_cli" plugin --profile "$name" add --link "$bundle" >/dev/null 2>&1

# The user layer: keep every host row, drop the browser surface.
#
# The four disabled rows are exactly the ones the boot audit marks `required`
# for the HTTP plane. Their consumers stay pending, which is what a boot with no
# server looks like; everything the suites assert -- the preset registry, the
# host plane, the preset realms -- is above them and unaffected.
cat > "$profile_dir/cordis.patch.yml" <<'YAML'
# Acceptance profile: the Web composition WITHOUT the browser surface.
#
# The suites pass a dummy argument to the launcher. The Web app's own command
# line owns every argument it is given, and `web-startup` rejects one it never
# declared, aborting the boot before the roster exists. Disabling the HTTP rows
# here keeps `agent-preset-registry` and the rest of the host plane mounted, so
# this profile differs from the live one only in the server nobody asserts.
- id: web-startup
  disabled: true
- id: webserver
  disabled: true
- id: web-runtime
  disabled: true
- id: connection
  disabled: true
YAML

printf 'scratch    : bundle selected and HTTP rows disabled in %s\n' "$name"
