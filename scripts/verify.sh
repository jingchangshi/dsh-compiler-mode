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

step "1f. agent-team presetRoles survive the duplicate row (LAST-ROW-WINS)"
# WHY THIS CHECK EXISTS
# ---------------------
# Profile "web" can compose TWO top-level rows with id "agent-team":
#   * ours, from @local/dsh-ai-compiler-preset (config/bundle-ai-compiler/
#     bundles.patch.yml), which carries the presetRoles routing tables;
#   * the shipped @deepseek-ai/dsh-experimental-agent-team-profile, which has
#     no presetRoles (it only carries the capacity limits).
#
# THE LOADER IS LAST-ROW-WINS, NOT FIRST-PROVIDE-WINS. Evidence:
#   * vendor/include/src/index.ts:93 -- duplicate inserts are PUSHED with no
#     dedupe, so both rows survive into the config array;
#   * vendor/loader/src/config/group.ts:52 -- Object.fromEntries keys entries
#     by id, and a later key overwrites an earlier one, so the LAST row wins;
#   * vendor/loader/src/config/entry.ts:122-123 -- with create=true the later
#     row REPLACES options wholesale, so the earlier presetRoles are dropped
#     entirely rather than merged.
#
# The consequence is silent: the preset still mounts, the Host looks healthy,
# the Team tools still answer, and every teammate falls back to the built-in
# "roles" table instead of the declared routes. Nothing else notices, because
# the composition suite boots the scratch profile, which does not select the
# shipped agent-team bundle at all.
#
# SO THIS CHECK INSPECTS THE EFFECTIVE (LAST) ROW. An earlier revision read the
# FIRST row -- the one that LOSES -- and therefore reported PASS on a broken
# profile. That is the false-green this step now exists to prevent: a check
# that passes in both the broken and the healthy state is worthless.
dump="$(node "$checkout/apps/cli/lib/bin.js" --profile web --dump-config 2>/dev/null)"
if [ -z "$dump" ]; then
  bad "cannot read --dump-config for profile web, so agent-team presetRoles are UNVERIFIED (run the CLI by hand)"
else
  seg_count="$(printf '%s\n' "$dump" | grep -cE '^- id: agent-team[[:space:]]*$')"
  # The EFFECTIVE segment: from the LAST "^- id: agent-team" to the next
  # "^- id: " at column 0. Nested rows are indented, so they cannot end it.
  last_seg="$(printf '%s\n' "$dump" | awk '
    /^- id: / {
      # Leaving an agent-team segment: remember it as the effective row so far.
      # It cannot be printed here, because a LATER agent-team row would win.
      if (in_seg) { last = out; in_seg = 0 }
      if ($0 ~ /^- id: agent-team[[:space:]]*$/) { in_seg = 1; out = $0 }
      next
    }
    in_seg { out = out "\n" $0 }
    # An agent-team row is almost never the final row of the dump, so the
    # still-open case must be closed here; printing only when in_seg is true
    # would silently yield an EMPTY segment and misreport the Team plane.
    END { if (in_seg) last = out; if (last != "") print last }
  ')"
  # A duplicate is ITSELF the defect under last-row-wins: it means two bundles
  # provide the same id and the routing tables are at the mercy of list order.
  if [ "$seg_count" -ne 1 ]; then
    bad "agent-team composes $seg_count top-level rows; exactly one is required (duplicate rows make presetRoles order-dependent)"
    printf '      Under LAST-ROW-WINS a second provider REPLACES the first wholesale, so\n'
    printf '      the routing tables survive only for as long as the ordering happens to\n'
    printf '      favour them -- and they are then dropped silently, with the Host still\n'
    printf '      healthy and every teammate on the built-in corp table.\n'
    printf '      Cause: both @local/dsh-ai-compiler-preset and\n'
    printf '      @deepseek-ai/dsh-experimental-agent-team-profile provide\n'
    printf '      "- id: agent-team" (vendor/include/src/index.ts:93 pushes duplicate\n'
    printf '      inserts; vendor/loader/src/config/group.ts:52 keeps the last).\n'
    printf '      Fix: remove @deepseek-ai/dsh-experimental-agent-team-profile from\n'
    printf '      %s/package.json -> dsh.profile.bundles, then re-run\n' "$profile_dir"
    printf '      scripts/install.sh (it now deselects that bundle for you).\n'
    printf '      Do NOT reorder the list to "fix" it and do NOT add presetRoles to\n'
    printf '      the shipped bundle: neither makes the duplicate go away.\n'
    printf '      Observed %s row(s) with id "agent-team".\n' "$seg_count"
  elif [ -z "$last_seg" ]; then
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
    pr_block="$(printf '%s\n' "$last_seg" | awk '
      function indent(s,  i) { for (i = 1; i <= length(s); i++) if (substr(s, i, 1) != " ") return i - 1; return length(s) }
      !in_block && /^[[:space:]]*presetRoles:[[:space:]]*$/ { in_block = 1; base = indent($0); print; next }
      in_block {
        if ($0 ~ /^[[:space:]]*$/) { print; next }
        if (indent($0) <= base) exit
        print
      }
    ')"

    if [ -z "$pr_block" ]; then
      bad "agent-team: the EFFECTIVE (last) composed row has NO presetRoles -- every teammate silently falls back to the built-in corp table"
      printf '      This is NOT a missing table in our bundle: our row HAS one. The\n'
      printf '      loser is the row that WINS by being listed LATER.\n'
      printf '      Cause: %s provides "- id: agent-team" twice (ours and\n' "web"
      printf '      @deepseek-ai/dsh-experimental-agent-team-profile). The loader keys\n'
      printf '      by id (vendor/loader/src/config/group.ts:52) and the later insert\n'
      printf '      REPLACES the earlier options wholesale\n'
      printf '      (vendor/loader/src/config/entry.ts:122-123), so presetRoles is\n'
      printf '      dropped rather than merged.\n'
      printf '      Fix: remove @deepseek-ai/dsh-experimental-agent-team-profile from\n'
      printf '      %s/package.json -> dsh.profile.bundles and re-run\n' "$profile_dir"
      printf '      scripts/install.sh. Merely moving @local/dsh-ai-compiler-preset\n'
      printf '      EARLIER cannot help: under last-row-wins that makes it WORSE.\n'
      printf '      Do NOT add presetRoles to the shipped bundle: it is not ours to edit.\n'
      printf '      The effective row starts at:\n'
      printf '%s\n' "$last_seg" | head -3 | sed 's/^/      | /'
    else
      miss=""
      printf '%s\n' "$pr_block" | grep -qE '^[[:space:]]+ai-compiler:[[:space:]]*$' || miss="$miss ai-compiler"
      printf '%s\n' "$pr_block" | grep -qE '^[[:space:]]+ai-compiler-magpie:[[:space:]]*$' || miss="$miss ai-compiler-magpie"
      if [ -z "$miss" ]; then
        ok "the effective (last, of $seg_count) agent-team row carries presetRoles for ai-compiler + ai-compiler-magpie"
        # Every routed model must exist in the catalog the SAME profile declares.
        # Core routing accepts an unlisted id, so a typo is not rejected at load:
        # the Host looks healthy and the first spawn of that role dies with
        # UNKNOWN_MODEL. Resolve all 12 routed pairs against the dump's own
        # llm-pi-ai catalog here, where the real profile (not the scratch one,
        # which carries no operator models) is the subject.
        missing_models="$(printf '%s\n' "$dump" | awk -F'\n' '
          function flush(  k) {}
          {
            line = $0
            if (line ~ /^      [a-z][a-z0-9-]*:[[:space:]]*$/) { provider = line; sub(/^ +/, "", provider); sub(/:.*$/, "", provider) }
            if (provider != "" && line ~ /^          - id: /) {
              model = line; sub(/^ *- id:[[:space:]]*/, "", model); sub(/[[:space:]]+$/, "", model)
              catalog[provider SUBSEP model] = 1
            }
          }
          END {
            split("magpie:group/architect magpie:group/explorer magpie:group/implementer magpie:group/reviewer magpie:group/challenger magpie:group/validator corp:Qwen3.8-Flash corp:DeepSeek-V4.1-Flash-1017 corp:GLM-5.3-Flash", want, " ")
            for (i = 1; i <= 9; i++) {
              split(want[i], pair, ":")
              if (!((pair[1] SUBSEP pair[2]) in catalog)) printf "%s/%s ", pair[1], pair[2]
            }
          }')"
        if [ -z "$missing_models" ]; then
          ok "every model a role routes to is declared in the profile's own catalog"
        else
          bad "agent-team routes to model id(s) the profile never declares:$missing_models"
          printf '      A role would spawn and then die with UNKNOWN_MODEL, so the role is\n'
          printf '      unusable even though the Host starts cleanly. Fix either side:\n'
          printf '      add the id under llm-pi-ai.providers.<provider>.models in\n'
          printf '      %s/cordis.patch.yml, or point the table at a declared id\n' "$profile_dir"
          printf '      (config/bundle-ai-compiler/bundles.patch.yml -> agent-team.presetRoles).\n'
          printf '      NOTE: this reads the LIVE profile. A throwaway acceptance profile\n'
          printf '      does not declare the operator models, so a failure here is about\n'
          printf '      the profile under test, not about the suite.\n'
        fi
      else
        bad "agent-team: the EFFECTIVE (last) row has presetRoles but is MISSING key(s):$miss"
        printf '      presetRoles replaces "roles" wholesale, so a preset whose key is\n'
        printf '      absent silently reverts to the built-in routes. Keys must match the\n'
        printf "      presets' config.id in config/bundle-ai-compiler/cordis.patch.yml.\n"
        printf '      Intended table: config/bundle-ai-compiler/bundles.patch.yml -> agent-team.presetRoles\n'
        printf '      If BOTH keys are reported missing, suspect a DUPLICATE agent-team row\n'
        printf '      or an extra bundle provider rather than a broken table in our bundle.\n'
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

  step "4b. session-757fa075 regression guards"
  # WHY THIS STEP EXISTS
  # --------------------
  # docs/14-session-757fa075-postmortem.md records seven ways one session lost
  # its work: an absolute write scope, a promoted result with no .stdout, exit 2
  # treated as a total failure, guessed paths, a search timeout, a sibling abort,
  # and an unwrapped TeamError that ended the run with zero tasks. Prose cannot
  # stop those from coming back, so they are pinned as executable guards: each
  # one was validated by reverting its fix and watching this suite go red.
  #
  # The suite needs NO Host and no model — it reads the checkout's sources and
  # its PURE built helpers — so it is safe to run on every verify. It reports
  # FAIL (never a silent skip) when the checkout or the F4 workspace is missing,
  # because a guard that cannot run must not look green.
  #
  # ORDERING MATTERS: the behavioural guards execute packages/*/lib/index.js,
  # NOT src. A source fix that was never rebuilt therefore changes nothing here,
  # and a stale lib would make those guards pass without ever looking at the fix
  # — the same "green because it never ran" defect this whole suite exists to
  # kill. The suite enforces its own precondition (its F0 group compares each lib
  # mtime against its src mtime and FAILS naming the rebuild command), so this
  # step must never be moved BEFORE a build, and must never treat a stale tree as
  # a pass. It also runs last on purpose: by this point every earlier step has
  # already exercised the built profile, so a lib that was rebuilt for them is
  # the same lib these guards read.
  if node "$repo/tests/integration/session-regressions.mjs" >/tmp/ai-compiler-session-regressions.log 2>&1; then
    ok "session regression guards $(grep -c '^PASS' /tmp/ai-compiler-session-regressions.log) checks"
  else
    bad "session regression guards FAILED — a failure mode from session 757fa075 may have returned"
    # Surface the actionable lines rather than making the operator open the log.
    grep -E '^FAIL' /tmp/ai-compiler-session-regressions.log | head -8 | sed 's/^/      /'
    printf '      full detail: /tmp/ai-compiler-session-regressions.log
'
    printf '      each failing [F<n>] group maps to a section of docs/14-session-757fa075-postmortem.md
'
  fi

  step "4c. tool-call-failure guards (F11)"
  # Pins the fix for session 633b5373: the last-row-wins FAIL/PASS demo must run
  # on a throwaway profile copy (scripts/lib/last-row-wins-demo.sh), never the
  # live HMR-watched profile; and the documented HMR-recomposition mechanism is
  # still real. Structural only: reads source, boots no Host. See docs/15.
  if node "$repo/tests/integration/tool-call-failure-guard.mjs" >/tmp/ai-compiler-tool-call.log 2>&1; then
    ok "tool-call-failure guards $(grep -c '^PASS' /tmp/ai-compiler-tool-call.log) checks"
  else
    bad "tool-call-failure guards failed (see /tmp/ai-compiler-tool-call.log)"
    grep -E '^FAIL' /tmp/ai-compiler-tool-call.log | head -8 | sed 's/^/      /'
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
