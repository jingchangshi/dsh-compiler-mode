# 04 — Installation

The mode ships as one bundle: `@local/dsh-ai-compiler-preset`
(`config/bundle-ai-compiler/`). Installing it never edits a shipped preset and never
touches the profile's `cordis.patch.yml` (your model settings stay byte-identical;
`scripts/verify.sh` step 6 asserts that).

One capability is not expressible as a bundle row and ships as **pinned source patches** instead:
the Agent Teams member-reclaim feature. `patches/0002-team-member-reclaim.patch` adds the `retired`
phase and `retire_teammate`; `patches/0003-team-auto-reclaim.patch` makes the runtime manage slots
automatically (a failed creation never holds a slot, and at the limit the least-recently-active,
task-free, idle-beyond-grace member is retired to make room). `scripts/install.sh` applies both in
order, idempotently and reversibly, then rebuilds the Host `lib/`. This is the only step that writes
to the checkout; it is opt-out (`--no-harness-patch`) and reversible
(`scripts/uninstall.sh --revert-harness`). See ADR-011 and ADR-012.

## What gets installed

| Bundle patch | Plane | Rows |
|---|---|---|
| `bundles.patch.yml` | Host | `lsp`, `lsp-stdio` (clangd), `tool-lsp`, `agent-team`, `tool-agent-team`, `ui-agent-team` |
| `cordis.patch.yml` | Preset | one `preset-ai-compiler` declaration (`config.id: ai-compiler`) |

Plus two source patches, applied in order: `patches/0002-team-member-reclaim.patch` (explicit
`retire_teammate`) and `patches/0003-team-auto-reclaim.patch` (automatic slot reclamation) → the DSH
checkout (`agent-team`, `tool-agent-team`, `client-ui-agent-team`; rebuilds `lib/`).

Two extra steps are unavoidable in rc.3 and are handled by the script:

- **`lsp-stdio` and `tool-lsp` are not dependencies of the dsh installation**, so the profile must
  carry them itself. With `dsh-experimental-agent-team-profile` you hit the same fact: that bundle
  is installed into the profile, not shipped by the installation. The script adds the three LSP
  packages with `dsh plugin add --link`.
- **The Host must be restarted** after installation. A running Host keeps its start-up
  composition; measured symptom: Team rows present in `--dump-config` but absent from the
  model's tool surface until restart.

## Automated install

```bash
scripts/install.sh            # backs up the profile, links the LSP packages, links + selects the bundle,
                              # applies + builds the team-reclaim patch
# restart the DSH Web Host, then:
scripts/verify.sh             # all checks, exit 0 = installed correctly
```

Flags: `--dry-run` prints every action without writing; `--no-harness-patch` leaves the DSH
checkout untouched (then `retire_teammate` is unavailable); `--no-build` applies the patch but
skips the Host `lib/` rebuild (run `pnpm run build:lib:host` before restarting).

## Manual equivalent (Web GUI)

1. **Settings → Plugins → Install** (or Creator mode) with the absolute path of this
   repository's `config/bundle-ai-compiler` directory. The dialog needs an absolute path,
   so print one where the repository lives:
   `cd config/bundle-ai-compiler && pwd -P`.
2. That runs `install_bundle`: it adds the `link:` dependency and **appends** the bundle to
   `dsh.profile.bundles`.
3. The same dialog cannot add the LSP packages (they declare no `dsh.bundle`). Add them with
   `dsh plugin --profile web add --link <dir>` for `packages/lsp/{lsp,lsp-stdio,tool-lsp}`.
4. Restart the Host.

## Verify the mode is live

- `Settings → Agent presets` lists **AI Compiler Engineering**.
- A new chat's preset chip offers it; `session/create {agentPreset:'ai-compiler'}` returns
  `agentPreset: "ai-compiler"`.
- Inside a `run_code` program, `Object.keys(tools)` contains `spawn_teammate`,
  `retire_teammate`, `team_task_create`, `lsp` and does **not** contain `subagent`/`subagent_fork`.

## Uninstall

```bash
scripts/uninstall.sh          # deselects the bundle layer and removes the linked package
scripts/uninstall.sh --revert-harness   # also reverse the team-reclaim source patch
# restart the Host (rebuild lib/ first if you used --revert-harness)
```

`--keep-deps` leaves the package on disk (deselect only); `--dry-run` prints the plan.
`--revert-harness` is opt-in: the patch is a source change, and leaving it applied is harmless once
no preset mounts the Team bundle.

## Rollback to the pre-install state

```bash
scripts/rollback.sh                       # the canonical capture: evidence/backup/profile-web-orig/
scripts/rollback.sh --backup <dir>        # a specific snapshot
scripts/rollback.sh --dry-run
```

Rollback restores `package.json`, `cordis.patch.yml`, `cordis.yml`, `pnpm-workspace.yaml`, prunes
`node_modules` back to the restored manifest, and tells you to restart the Host. The model
configuration and every compiler repository are outside its scope and are never touched. Rollback
is profile-only by design: the team-reclaim patch is source, not profile state, and is reversed with
`scripts/uninstall.sh --revert-harness` (or `node scripts/lib/harness-patches.mjs revert`).

## Where things live

| Artifact | Path |
|---|---|
| Bundle source | `config/bundle-ai-compiler/` |
| Capability source patches | `patches/0002-team-member-reclaim.patch`, `patches/0003-team-auto-reclaim.patch` |
| Capability patch helper | `scripts/lib/harness-patches.mjs` |
| clangd LLVM 22 overlay | `config/overlays/clangd-llvm22.patch.yml` |
| Pre-install capture (the one rollback restores) | `evidence/backup/profile-web-orig/` |
| Test + benchmark output | `evidence/tests/`, `evidence/e2e/`, `evidence/benchmarks/` |
