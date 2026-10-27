#!/usr/bin/env bash
# Restore the Web profile to the state captured before `ai-compiler` existed.
#
# Uses the backup directory recorded by scripts/install.sh (or the original
# capture in evidence/backup/profile-web-orig). Only the profile's own files are
# restored; the DSH checkout, the model configuration and every compiler
# repository are never touched.
#
# Usage: scripts/rollback.sh [--backup <dir>] [--dry-run]
# Exit: 0 restored, 1 failed, 2 usage error.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
profile_dir="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
backup=""
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --backup) backup="${2:?--backup needs a directory}"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) printf 'rollback: unknown option %s\n' "$1" >&2; exit 2 ;;
  esac
done
if [ -z "$backup" ]; then
  # Newest install backup wins; the original capture is the last resort.
  backup="$(ls -d "$repo"/evidence/backup/profile-install-* 2>/dev/null | sort | tail -1)"
  [ -n "$backup" ] || backup="$repo/evidence/backup/profile-web-orig"
fi
say() { printf '%s\n' "$*"; }
[ -d "$backup" ] || { printf 'rollback: backup not found: %s\n' "$backup" >&2; exit 1; }
[ -d "$profile_dir" ] || { printf 'rollback: profile not found: %s\n' "$profile_dir" >&2; exit 1; }

say "== ai-compiler rollback =="
say "from: $backup"
say "to  : $profile_dir"
for f in package.json cordis.patch.yml cordis.yml pnpm-workspace.yaml; do
  [ -f "$backup/$f" ] || continue
  if [ "$dry" = 1 ]; then
    say "would restore $f"
  else
    cp -a "$backup/$f" "$profile_dir/$f"
    say "restored $f"
  fi
done
if [ "$dry" = 0 ] && [ -d "$profile_dir/node_modules/@local/dsh-ai-compiler-preset" ]; then
  ( cd "$profile_dir" && pnpm install --ignore-scripts >/dev/null 2>&1 ) || true
  say "pruned node_modules to the restored manifest"
fi
say ""
say "Restart the DSH Web Host. Verify with: node $repo/scripts/verify.sh"
