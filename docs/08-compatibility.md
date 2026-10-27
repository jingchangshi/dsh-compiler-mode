# 08 — Compatibility

Baseline: `dsh-v0.2.1-rc.3`, commit `1f81c047fc`.

## Version facts

- The checkout's branch is `dsh-v0.2.1-rc.3`, but **the repository carries no tags**
  (`git tag -l` is empty, `git describe --tags` fails). The commit matches the required
  `1f81c04`, so the commit — not a tag object — is the immutable baseline.
- Machine-readable lock: `evidence/env/versions.json` (46 composed workspace packages, the
  toolchain, the profile manifest and the delivery bundle manifest).

## Upgrade procedure

1. Re-copy the new `packages/bundle/web-app/presets/ptc.patch.yml`.
2. Re-apply the diffs listed by `tests/preset/verify-preset.mjs` (`DECLARED`).
3. `node tests/preset/verify-preset.mjs` must exit 0; a changed shipped PTC list shows up as an
   *undeclared difference* instead of drifting silently.
4. Re-run `scripts/verify.sh` and the deterministic suites.

## rc.3 divergences that shaped this delivery

| Finding | Consequence |
|---|---|
| `@deepseek-ai/dsh-headless` composes **no preset roster** and refuses a session that recorded one (`packages/bundle/headless/src/index.ts:212-221`) | Acceptance runs on the **Web Host**; headless is a smoke test + Q17 note |
| `@deepseek-ai/dsh-lsp` exports a **class extending `Service`**, not an `apply()` plugin | The LSP rows live on the **Host plane**; a preset row for `lsp` makes the whole preset unusable (`never started`) |
| `lsp-stdio` / `tool-lsp` are **not installation dependencies** | A profile that mounts them must depend on them (`dsh plugin add --link …`); the install script does this |
| A running Host keeps its start-up composition | Installing rows requires a **restart**; measured symptom: Team tools present in `--dump-config`, absent from the model's surface |
| `spawn_teammate({context:'fork'})` seeds only the Lead's **completed** turns (`packages/subagent/subagent-fork-in-process/src/index.ts:46-53`) | A fork requested *before* the Lead finishes a turn is silently unseeded — measured: `isSeeded:false, inherited:0` with 0 completed turns; `isSeeded:true, inherited:10` after one |
| `read` caps at 2 000 lines; `bash` capture caps at 64 000 chars | A PTC program consuming a whole artifact must page or use `bash` |
| Upstream doc drift: `presets/*.patch.yml` comments claim a Web preset editor that does not exist | Recorded here; the delivery does not depend on it |

## clangd dialect selection

AscendNPU-IR is built with clang 15.0.6 but cannot be *parsed* by clangd 15 for C++20 headers,
while clangd 22.1.0 parses it. The provider supports one command per server id, so:

- default row: `command: clangd` (PATH-resolved, currently 15.0.6);
- `config/overlays/clangd-llvm22.patch.yml` pins `/home/s00653124/Softwares/clangd/bin/clangd`
  for trees needing the newer dialect.

`tests/clangd/cdb-parse-audit.mjs` records exactly how clangd reads
`build/compile_commands.json` (4 913 entries, 0 errors), including the flags its driver **drops**
(`-fno-exceptions`, `-fPIC`, `-fno-common`, `--driver-mode`, `-UNDEBUG`, …) and the resource dir it
substitutes. Evidence: `evidence/code-intelligence/cdb-parse-*.json`.

## FFF evaluation (Q13) — evaluated, not adopted

Requirement: an rc.3-compatible DSH plugin packaging of the FFF engine, with path/line/candidate
counts preserved, multi-agent safe, no conflict with native search, and a measured win.

Result: **no such installable package was found.** `dsh-pi` is a third-party experimental agent
harness (not a dsh plugin bundle for rc.3), and FFF itself is an engine, not a dsh plugin. There is
therefore nothing to install without writing an adapter — which this delivery explicitly does not do
(no compiler adapters, no unvalidated third-party code).

**Decision:** native `glob`/`grep` (ripgrep) stay the only search surface; FFF remains an optional
future plugin. Evidence that native search is sufficient in practice: case C matched 6 000 lines
with one `grep` and case A located two real MLIR passes in 29 nested PTC calls.

## Worktree (A8)

`@deepseek-ai/dsh-experimental-tool-worktree` is an official **optional** bundle
(`OPTIONAL_BUNDLES`). It is not a dependency of this mode: the base contract is single-writer on a
shared directory, and Worktree-based multi-writer isolation remains an optional add-on.
