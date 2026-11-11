#!/usr/bin/env bash
# Verify the installed mode end to end, without a model.
#
# Checks, in order:
#   0. external prerequisites exist
#   1. the profile records the bundle layer and the ai-compiler preset row
#   1c. the harness team-reclaim patch is applied AND built (retireTeammate in lib)
#   1d. the capability-patch helper passes its apply/idempotent/revert/conflict test
#   1f. the FIRST composed agent-team row (the one cordis keeps) still carries
#       the presetRoles routing tables - ORDER-SENSITIVE, see the step itself
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
# Share the launcher's environment with every test below.
#
# The delivered rows resolve their machine parameters from the DSH process
# environment (AGENT_GATES_MCP_PYTHON, AGENT_GATES_ROOT, AGENT_GATES_CONFIG),
# and the launcher reads $DSH_HOME/.env as the USER env layer. Without this,
# the tests boot the presets with those variables unset and the bridge either
# does not start or starts the wrong interpreter -- a result that says nothing
# about the installation the user actually runs.
set -a
[ -f "$HOME/.dsh/.env" ] && . "$HOME/.dsh/.env"
set +a
repo="$(cd "$(dirname "$0")/.." && pwd)"
checkout="${DSH_CHECKOUT:-$repo/../deepseek-harness}"
profile_dir="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
quick=0
[ "${1:-}" = "--quick" ] && quick=1
failures=0
step() { printf '\n== %s ==\n' "$*"; }
ok()   { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }

step "0. external prerequisites"

# The same dependencies install.sh refuses to install without. Checked again
# here because verify.sh is what an operator runs BEFORE trusting the mode, and
# a dependency that disappeared since the install (a removed PATH entry, an
# unmounted toolchain) must be reported by name rather than inferred from a
# downstream warning nobody reads.
for tool in clangd docker python3; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "prerequisite $tool -> $(command -v "$tool")"
  else
    bad "prerequisite $tool is MISSING - install it (see scripts/install.sh for what needs it)"
  fi
done

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

step "1c. harness team capability (role/slot topology)"
# The role/slot topology is a source patch, not a bundle row, so a Host can look
# healthy while lacking it. Report its state, and when applied assert the BUILT
# lib actually contains it: applying a patch without rebuilding lib/ is the exact
# silent-stale failure this check exists to catch.
hp="$(node "$repo/scripts/lib/harness-patches.mjs" status --checkout "$checkout" 2>&1)"
lib="$checkout/packages/experimental/agent-team/lib/index.js"
p_state="$(printf '%s\n' "$hp" | awk -F '\t' '/0002-team-roles-slots/{print $1; exit}')"
case "$p_state" in
  applied)
    if grep -q 'TEAM_NO_CAPACITY' "$lib" 2>/dev/null; then
      ok "role/slot topology patch applied and built"
    else
      bad "role/slot topology patch applied in source but lib/ is stale — run: pnpm run build:lib:host"
    fi ;;
  pending)
    printf 'INFO  role/slot topology patch NOT applied; the role-based Team tools are unavailable (run scripts/install.sh)\n' ;;
  conflict)
    bad "role/slot topology patch does not apply to this checkout (base moved?) — see scripts/lib/harness-patches.mjs status" ;;
  *)
    printf 'INFO  role/slot topology patch state unknown\n' ;;
esac

step "1d. capability-patch helper self-test"
if node "$repo/tests/integration/harness-patches.mjs" >/tmp/ai-compiler-harness-patch.log 2>&1; then
  ok "harness-patches helper: apply / idempotent / revert / conflict all correct"
else
  bad "harness-patches helper self-test failed (see /tmp/ai-compiler-harness-patch.log)"
fi

step "1e. provider-route fallback plugin"
# The fallback is a local bundle plugin (TS, loaded through the Host's tsx
# loader), so there is no lib to rebuild; its correctness is proven by its unit
# and wiring tests, and its presence by the composed profile. A row that failed
# to compose would silently leave corp-family roles dying on a spent daily
# budget again.
fb="$repo/config/bundle-ai-compiler/plugins/llm-fallback"
if node --test "$fb/logic.test.ts" "$fb/wiring.test.ts" >/tmp/ai-compiler-fallback.log 2>&1; then
  ok "llm-fallback unit + wiring tests pass"
else
  bad "llm-fallback tests failed (see /tmp/ai-compiler-fallback.log)"
fi
if node "$checkout/apps/cli/lib/bin.js" --profile web --dump-config 2>/dev/null | grep -q 'ai-compiler-llm-fallback'; then
  ok "llm-fallback row composes into the profile"
else
  bad "llm-fallback row missing from --dump-config"
fi

step "1f. agent-team presetRoles survive the duplicate row (ORDER-SENSITIVE)"
# WHY THIS CHECK EXISTS
# ---------------------
# Profile "web" composes TWO rows with id "agent-team":
#   * one from @local/dsh-ai-compiler-preset (config/bundle-ai-compiler/
#     bundles.patch.yml) that carries the presetRoles routing tables;
#   * one from the shipped bundle @deepseek-ai/dsh-experimental-agent-team-profile
#     that has no presetRoles (it only carries the capacity limits).
# cordis is FIRST-PROVIDE-WINS for a duplicated provide, so the row that takes
# effect is simply the one whose bundle is listed first in
# $profile_dir/package.json -> dsh.profile.bundles. Today that is the local
# bundle, so the tables win -- but only by ORDER. Swap the two entries and the
# second row silently takes over: the preset still mounts, the Host still looks
# healthy, the Team tools still answer, and every teammate silently falls back
# to the built-in "roles" table instead of the declared routes. No other check
# notices, because the composition suite boots the scratch profile, which does
# not select the shipped agent-team bundle at all.
#
# So this check asserts the FIRST composed agent-team segment -- the only one
# that can win -- and deliberately does not use "grep -A" over the whole dump:
# a global match would also hit the dropped row and report a false green while
# the routing tables were inactive.
dump="$(node "$checkout/apps/cli/lib/bin.js" --profile web --dump-config 2>/dev/null)"
if [ -z "$dump" ]; then
  bad "cannot read --dump-config for profile web, so agent-team presetRoles are UNVERIFIED (run the CLI by hand)"
else
  # First segment only: from the first "^- id: agent-team" up to the next
  # "^- id: " at column 0. Nested rows are indented, so they cannot end it.
  first_seg="$(printf '%s\n' "$dump" | awk '
    /^- id: / {
      if (in_seg) exit
      if ($0 ~ /^- id: agent-team[[:space:]]*$/) { in_seg = 1; print; next }
    }
    in_seg { print }
  ')"
  seg_count="$(printf '%s\n' "$dump" | grep -cE '^- id: agent-team[[:space:]]*$')"

  if [ -z "$first_seg" ]; then
    nested="$(printf '%s\n' "$dump" | grep -cE '^[[:space:]]+- id: agent-team[[:space:]]*$')"
    if [ "$nested" -gt 0 ]; then
      bad "agent-team composes only INSIDE a group ($nested nested row(s), none at top level) - this check only knows how to read a top-level row, so presetRoles are UNVERIFIED"
    else
      bad 'no "- id: agent-team" row composes at all -- the Team plane is missing, so presetRoles cannot route any teammate'
    fi
  else
    # The presetRoles block: from the presetRoles: line down to the first
    # non-blank line indented at or above it. Keys are read from that block
    # only, so a key anywhere else in the segment cannot mask a missing table.
    pr_block="$(printf '%s\n' "$first_seg" | awk '
      function indent(s,  i) { for (i = 1; i <= length(s); i++) if (substr(s, i, 1) != " ") return i - 1; return length(s) }
      !in_block && /^[[:space:]]*presetRoles:[[:space:]]*$/ { in_block = 1; base = indent($0); print; next }
      in_block {
        if ($0 ~ /^[[:space:]]*$/) { print; next }
        if (indent($0) <= base) exit
        print
      }
    ')"

    if [ -z "$pr_block" ]; then
      bad "agent-team: the FIRST composed row (the winner) has NO presetRoles -- teammate routes fall back to the built-in table"
      printf '      ORDER-SENSITIVE, not a broken table: %s selects two bundles that\n' "web"
      printf '      both provide "- id: agent-team" and cordis is first-provide-wins.\n'
      printf '        winner (must carry presetRoles) = the bundle listed FIRST in\n'
      printf '          %s/package.json -> dsh.profile.bundles\n' "$profile_dir"
      printf '        dropped (no presetRoles)        = @deepseek-ai/dsh-experimental-agent-team-profile\n'
      printf '      Fix: move "@local/dsh-ai-compiler-preset" BEFORE\n'
      printf '      "@deepseek-ai/dsh-experimental-agent-team-profile" in that bundles list\n'
      printf '      (re-run scripts/install.sh, which appends in this order), or drop the\n'
      printf '      shipped agent-team row from the profile. Do NOT add presetRoles to the\n'
      printf '      shipped bundle: it is not ours to edit.\n'
      printf '      Observed %s row(s) with id "agent-team"; the winner starts at:\n' "$seg_count"
      printf '%s\n' "$first_seg" | head -3 | sed 's/^/      | /'
    else
      miss=""
      printf '%s\n' "$pr_block" | grep -qE '^[[:space:]]+ai-compiler:[[:space:]]*$' || miss="$miss ai-compiler"
      printf '%s\n' "$pr_block" | grep -qE '^[[:space:]]+ai-compiler-magpie:[[:space:]]*$' || miss="$miss ai-compiler-magpie"
      if [ -z "$miss" ]; then
        ok "first agent-team row (of $seg_count) carries presetRoles for ai-compiler + ai-compiler-magpie"
      else
        bad "agent-team: the FIRST composed row (the winner) has presetRoles but is MISSING key(s):$miss"
        printf '      presetRoles replaces "roles" wholesale, so a preset whose key is\n'
        printf '      absent silently reverts to the built-in routes. Keys must match the\n'
        printf '      presets'"'"' config.id in config/bundle-ai-compiler/cordis.patch.yml.\n'
        printf '      Intended table: config/bundle-ai-compiler/bundles.patch.yml -> agent-team.presetRoles\n'
        printf '      If BOTH keys are reported missing, suspect bundle ORDER first: the\n'
        printf '      winner may already be the shipped row instead of the local one.\n'
        printf '%s\n' "$pr_block" | head -6 | sed 's/^/      | /'
      fi
    fi
  fi
fi

step "1b. acceptance profile"
# The suites below boot a throwaway profile rather than the live Web one, and
# nothing else creates it. Without this step a fresh machine fails at the first
# suite with `profile "ai-compiler-scratch" does not exist`, which reads like a
# defect in the bundle. The script is idempotent and only writes under
# $DSH_HOME/profiles/<scratch>; it never touches the live profile.
if bash "$repo/scripts/scratch-profile.sh" >/tmp/ai-compiler-scratch.log 2>&1; then
  ok "acceptance profile: $(tail -n 1 /tmp/ai-compiler-scratch.log)"
else
  bad "acceptance profile could not be prepared (see /tmp/ai-compiler-scratch.log)"
fi

step "2b. the MCP bridge registers the agentgates tools (scratch profile)"
# One compiler preset and one control preset is enough to prove scoping, and it
# keeps this step to about three seconds. The full six-preset sweep, with the
# process/RSS measurements, is tests/mcp/tool-scope.mjs run directly.
if [ ! -f "${AGENT_GATES_CONFIG:-$HOME/.config/agent-gates/config.toml}" ]; then
  printf 'INFO  no AgentGates config at %s — the bridge will report tools but no workspaces\n' \
    "${AGENT_GATES_CONFIG:-$HOME/.config/agent-gates/config.toml}"
fi
# This boots the SCRATCH profile, not the live Web profile: a live-profile boot
# would start the webserver and the whole web plane, which is a different (and
# much slower) thing to assert. So this step proves the DELIVERED bundle mounts
# the bridge and scopes it correctly; step 1 is what proves the LIVE profile has
# that bundle selected. After a Host restart the two agree; before one, the live
# GUI can still be missing the tools even while this passes.
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
