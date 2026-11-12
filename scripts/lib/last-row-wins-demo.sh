#!/usr/bin/env bash
# Prove scripts/verify.sh step 1f really FAILS on the duplicate agent-team row
# and PASSES on the fixed state -- WITHOUT EVER MUTATING THE LIVE PROFILE.
#
# WHY THIS EXISTS (see docs/15-tool-call-failure-postmortem.md)
# ------------------------------------------------------------
# step 1f lives in scripts/verify.sh and reads the LIVE web profile. The only
# way to see it fail is to add @deepseek-ai/dsh-experimental-agent-team-profile
# back into a profile's dsh.profile.bundles. Doing that on the LIVE profile while
# the Host is running is what broke a real validation run: HMR watches
# ~/.dsh/profiles/web/package.json, and a bundle-list change makes it RECOMPOSE
# the running profile (Hmr.reconcileProfile -> recomposeProfile), stopping and
# restarting the agent-team / tool-agent-team plugin entries. That aborts any
# in-flight run_code program ("code run failed (abort)") and transiently drops
# the agent-scoped Team tools, so a concurrent program's tools.team_task_list()
# resolves to `unknown tool "team_task_list"` (core/tools index.ts:535).
#
# This helper therefore copies the live profile to a THROWAWAY profile, mutates
# only the copy, demonstrates FAIL then PASS, and deletes the copy. The live
# profile's package.json is opened read-only and never written.
#
# Usage: scripts/lib/last-row-wins-demo.sh [--profile <live>] [--demo <name>]
# Exit:  0 the check failed on duplicate and passed on fixed (as required),
#        1 it did not (a false green, or the composition could not be read).
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
checkout="${DSH_CHECKOUT:-$repo/../deepseek-harness}"
dsh_cli="${DSH_CLI:-$checkout/apps/cli/lib/bin.js}"
dsh_home="${DSH_HOME:-$HOME/.dsh}"
live="${DSH_PROFILE:-web}"
demo="${DSH_DEMO_PROFILE:-ai-compiler-lastrow-demo}"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) live="${2:?}"; shift 2 ;;
    --demo) demo="${2:?}"; shift 2 ;;
    *) printf 'last-row-wins-demo: unknown option %s\n' "$1" >&2; exit 2 ;;
  esac
done

SHADOW='@deepseek-ai/dsh-experimental-agent-team-profile'

src="$dsh_home/profiles/$live"
dst="$dsh_home/profiles/$demo"
if [ ! -f "$src/package.json" ]; then
  printf 'last-row-wins-demo: live profile not found: %s\n' "$src" >&2
  exit 1
fi
if [ "$live" = "$demo" ]; then
  printf 'last-row-wins-demo: refusing to use the live profile as the demo copy (%s)\n' "$demo" >&2
  exit 2
fi

cleanup() { rm -rf "$dst"; }
trap cleanup EXIT

# Copy the live profile once; every mutation below targets $dst only.
rm -rf "$dst"
cp -a "$src" "$dst"

# Inspect one --dump-config dump and print rows=<n> hasPresetRoles=<bool> ok=<bool>.
# Equivalent to scripts/verify.sh step 1f's awk over the EFFECTIVE (last) row.
inspect() {
  node -e '
    const dump = require("node:fs").readFileSync(0, "utf8");
    const lines = dump.split("\n");
    const segs = []; let cur = null;
    for (const line of lines) {
      if (/^- id: /.test(line)) {
        if (cur) { segs.push(cur); cur = null; }
        if (/^- id: agent-team\s*$/.test(line)) cur = [line];
        continue;
      }
      if (cur) cur.push(line);
    }
    if (cur) segs.push(cur);
    const n = segs.length;
    if (n === 0) { console.log("rows=0 hasPresetRoles=false ok=false"); process.exit(0); }
    const eff = segs[n - 1].join("\n");
    const hasPreset = /^\s+presetRoles:\s*$/m.test(eff)
      && /^\s+ai-compiler-magpie:\s*$/m.test(eff)
      && /^\s+ai-compiler:\s*$/m.test(eff);
    console.log("rows=" + n + " hasPresetRoles=" + hasPreset + " ok=" + (n === 1 && hasPreset));
  '
}

add_shadow() {
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const p = process.argv[1], S = process.argv[2];
    const m = JSON.parse(readFileSync(p, "utf8"));
    const b = (m.dsh = m.dsh || {}).profile = m.dsh.profile || {};
    b.bundles = b.bundles || [];
    if (!b.bundles.includes(S)) b.bundles.push(S);
    writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  ' "$dst/package.json" "$SHADOW"
}

drop_shadow() {
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const p = process.argv[1], S = process.argv[2];
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.dsh.profile.bundles = (m.dsh.profile.bundles || []).filter(x => x !== S);
    writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  ' "$dst/package.json" "$SHADOW"
}

dump() { node "$dsh_cli" --profile "$demo" --dump-config 2>/dev/null; }

printf 'last-row-wins-demo: live=%s (read-only)  demo=%s (throwaway)\n' "$src" "$dst"

# --- BROKEN: duplicate row appended LAST shadows our presetRoles ---
add_shadow
broken="$(dump | inspect)"
printf '  duplicate-row state : %s  (expect ok=false)\n' "$broken"

# --- FIXED: shadow bundle removed, single row carries presetRoles ---
drop_shadow
fixed="$(dump | inspect)"
printf '  fixed state         : %s  (expect ok=true)\n' "$fixed"

case "$broken" in *"ok=false"*) b_bad=1 ;; *) b_bad=0 ;; esac
case "$fixed"  in *"ok=true"*)  f_ok=1  ;; *) f_ok=0  ;; esac

if [ "$b_bad" = 1 ] && [ "$f_ok" = 1 ]; then
  printf 'PASS  step 1f is not a false green: FAILS on duplicate row, PASSES when fixed (live profile untouched)\n'
  exit 0
fi
printf 'FAIL  step 1f is a false green: duplicate=%s fixed=%s\n' "$broken" "$fixed" >&2
exit 1
