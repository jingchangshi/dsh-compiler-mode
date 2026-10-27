#!/usr/bin/env bash
# Verify the installed mode end to end, without a model.
#
# Checks, in order:
#   1. the profile records the bundle layer and the ai-compiler preset row
#   2. the preset declaration still matches official PTC + the declared diffs
#   3. the deterministic composition suite passes (tools, planes, isolation)
#   4. the permission suite passes (allow/deny)
#   5. the profile's cordis.patch.yml is byte-identical to the pre-install backup
#
# Usage: scripts/verify.sh [--quick]
# Exit: 0 all pass, 1 a check failed.
set -uo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
checkout="${DSH_CHECKOUT:-$repo/../deepseek-harness}"
profile_dir="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
quick=0
[ "${1:-}" = "--quick" ] && quick=1
failures=0
step() { printf '\n== %s ==\n' "$*"; }
ok()   { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }

step "1. profile records the mode"
if node -e "const p=require('$profile_dir/package.json');process.exit((p.dsh?.profile?.bundles||[]).includes('@local/dsh-ai-compiler-preset')?0:1)"; then
  ok "bundle layer selected"
else
  bad "bundle layer NOT selected in $profile_dir/package.json"
fi
if node "$checkout/apps/cli/lib/bin.js" --profile web --dump-config 2>/dev/null | grep -q 'preset-ai-compiler'; then
  ok "preset-ai-compiler row composes"
else
  bad "preset-ai-compiler row missing from --dump-config"
fi

step "2. preset declaration vs official PTC"
if node "$repo/tests/preset/verify-preset.mjs" >/dev/null 2>&1; then
  ok "declaration matches PTC + declared diffs"
else
  bad "preset differs from the declared diff set (run tests/preset/verify-preset.mjs)"
fi

if [ "$quick" = 0 ]; then
  step "3. composition suite"
  if node "$repo/tests/integration/composition-suite.mjs" >/tmp/ai-compiler-composition.log 2>&1; then
    ok "composition suite $(grep -c '^PASS' /tmp/ai-compiler-composition.log) checks"
  else
    bad "composition suite failed (see /tmp/ai-compiler-composition.log)"
  fi

  step "4. permission suite"
  if node "$repo/tests/permissions/permission-suite.mjs" >/tmp/ai-compiler-permissions.log 2>&1; then
    ok "permission suite $(grep -c '^PASS' /tmp/ai-compiler-permissions.log) checks"
  else
    bad "permission suite failed (see /tmp/ai-compiler-permissions.log)"
  fi
fi

step "5. user model configuration untouched"
orig="$repo/evidence/backup/profile-web-orig/cordis.patch.yml"
if [ -f "$orig" ] && cmp -s "$orig" "$profile_dir/cordis.patch.yml"; then
  ok "profile cordis.patch.yml is byte-identical to the pre-install backup"
elif [ -f "$orig" ]; then
  bad "profile cordis.patch.yml differs from the pre-install backup"
else
  printf 'INFO  no pre-install backup to compare against\n'
fi

printf '\n%s\n' "verify: $failures failure(s)"
exit $([ "$failures" -eq 0 ] && echo 0 || echo 1)
