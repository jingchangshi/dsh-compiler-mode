#!/usr/bin/env bash
# Verify the installed mode end to end, without a model.
#
# Checks, in order:
#   1. the profile records the bundle layer and the ai-compiler preset row
#   2. the preset declaration still matches official PTC + the declared diffs
#   3. the MCP bridge actually registers the agentgates tools (see below)
#   4. the deterministic composition suite passes (tools, planes, isolation)
#   5. the permission suite passes (allow/deny)
#   6. the profile's cordis.patch.yml is byte-identical to the pre-install backup
#
# WHY CHECK 3 EXISTS
# ------------------
# The mcp-agentgates row sets failOnStartupError: false, so that an unconfigured
# or down AgentGates server cannot take the whole compiler mode offline --
# mountPreset() rejects the entire preset when a single row fails. The price of
# that robustness is silence: a broken bridge and a working bridge both produce
# a healthy-looking preset, and the only difference is that one has no tools.
# This check closes that hole by asserting the REGISTERED TOOL NAMES, so a stale
# interpreter path, a moved venv, a crashing server or a forgotten install is
# reported as a failure instead of looking like a working installation.
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

step "2b. the MCP bridge registers the agentgates tools"
# One compiler preset and one control preset is enough to prove scoping, and it
# keeps this step to about three seconds. The full six-preset sweep, with the
# process/RSS measurements, is tests/mcp/tool-scope.mjs run directly.
if [ ! -f "${AGENT_GATES_CONFIG:-$HOME/.config/agent-gates/config.toml}" ]; then
  printf 'INFO  no AgentGates config at %s — the bridge will report tools but no workspaces\n' \
    "${AGENT_GATES_CONFIG:-$HOME/.config/agent-gates/config.toml}"
fi
if node "$repo/tests/mcp/tool-scope.mjs" --presets ai-compiler,standard \
     >/tmp/ai-compiler-mcp.log 2>&1; then
  ok "agentgates tools registered in ai-compiler and absent from standard ($(grep -c '^PASS' /tmp/ai-compiler-mcp.log) checks)"
else
  bad "agentgates tools are NOT correctly registered (see /tmp/ai-compiler-mcp.log)"
  # Surface the actionable line rather than making the operator open the log.
  grep -E '^(FAIL|MEASURED)' /tmp/ai-compiler-mcp.log | head -4 | sed 's/^/      /'
  printf '      the bridge is silent by design; run it by hand to see why:\n'
  printf '      %s -s -m agent_gates.mcp_server\n' \
    "${AGENT_GATES_MCP_PYTHON:-$repo/../AgentGates/.venv/bin/python}"
fi

step "2. preset declaration vs official PTC"
if node "$repo/tests/preset/verify-preset.mjs" >/dev/null 2>&1; then
  ok "declaration matches PTC + declared diffs"
else
  bad "preset differs from the declared diff set (run tests/preset/verify-preset.mjs)"
fi

if [ "$quick" = 0 ]; then
  step "4. composition suite"
  if node "$repo/tests/integration/composition-suite.mjs" >/tmp/ai-compiler-composition.log 2>&1; then
    ok "composition suite $(grep -c '^PASS' /tmp/ai-compiler-composition.log) checks"
  else
    bad "composition suite failed (see /tmp/ai-compiler-composition.log)"
  fi

  step "5. permission suite"
  if node "$repo/tests/permissions/permission-suite.mjs" >/tmp/ai-compiler-permissions.log 2>&1; then
    ok "permission suite $(grep -c '^PASS' /tmp/ai-compiler-permissions.log) checks"
  else
    bad "permission suite failed (see /tmp/ai-compiler-permissions.log)"
  fi
fi

step "6. user model configuration untouched"
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
