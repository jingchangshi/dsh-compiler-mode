# 04 — Installation

The mode ships as one bundle: `@local/dsh-ai-compiler-preset`
(`config/bundle-ai-compiler/`). Installing it never edits a shipped preset and never
touches the profile's `cordis.patch.yml` (your model settings stay byte-identical;
`scripts/verify.sh` step 5 asserts that).

## What gets installed

| Bundle patch | Plane | Rows |
|---|---|---|
| `bundles.patch.yml` | Host | `lsp`, `lsp-stdio` (clangd), `tool-lsp`, `agent-team`, `tool-agent-team`, `ui-agent-team` |
| `cordis.patch.yml` | Preset | one `preset-ai-compiler` declaration (`config.id: ai-compiler`) |

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
scripts/install.sh            # backs up the profile, links the LSP packages, links + selects the bundle
# restart the DSH Web Host, then:
scripts/verify.sh             # 5 checks, exit 0 = installed correctly
```

`scripts/install.sh --dry-run` prints every action without writing.

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
  `team_task_create`, `lsp` and does **not** contain `subagent`/`subagent_fork`.

## Uninstall

```bash
scripts/uninstall.sh          # deselects the bundle layer and removes the linked package
# restart the Host
```

`--keep-deps` leaves the package on disk (deselect only); `--dry-run` prints the plan.

## Rollback to the pre-install state

```bash
scripts/rollback.sh                       # the canonical capture: evidence/backup/profile-web-orig/
scripts/rollback.sh --backup <dir>        # a specific snapshot
scripts/rollback.sh --dry-run
```

Rollback restores `package.json`, `cordis.patch.yml`, `cordis.yml`, `pnpm-workspace.yaml`, prunes
`node_modules` back to the restored manifest, and tells you to restart the Host. The DSH checkout,
the model configuration and every compiler repository are outside its scope and are never touched.

## Where things live

| Artifact | Path |
|---|---|
| Bundle source | `config/bundle-ai-compiler/` |
| clangd LLVM 22 overlay | `config/overlays/clangd-llvm22.patch.yml` |
| Pre-install capture (the one rollback restores) | `evidence/backup/profile-web-orig/` |
| Test + benchmark output | `evidence/tests/`, `evidence/e2e/`, `evidence/benchmarks/` |
