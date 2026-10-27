# AI Compiler Engineering Mode for DSH rc.3

A persistent, version-controlled **custom agent mode** for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `dsh-v0.2.1-rc.3`
(commit `1f81c047fc`), built on the official **PTC** preset, the native
**spill/compaction** stack, the official **Agent Teams** runtime, and a **clangd** code-navigation
surface.

| | |
|---|---|
| Preset id | `ai-compiler` |
| Display name | **AI Compiler Engineering** |
| Base | official `ptc` preset (33/33 rows, 2 declared diffs) |
| Model surface | `run_code` only (PTC), **31 tools** bound inside the SDK |
| Delegation | Agent Teams only (`spawn_teammate`, `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`, `team_task_*`) |
| Code navigation | `lsp` over clangd, real `compile_commands.json` |
| Skills | none preinstalled; the standard `skill-filesystem` + `tool-skill` pair is unchanged |
| Compiler adapters | none (reserved entry point documented, not implemented) |

## Quick start

```bash
scripts/install.sh        # link the bundle + the LSP packages into the Web profile
# restart the DSH Web Host
scripts/verify.sh         # 5 checks, exit 0 = installed
```

Then: new chat → preset chip → **AI Compiler Engineering**.

Uninstall / rollback:

```bash
scripts/uninstall.sh      # deselect + remove the linked package
scripts/rollback.sh       # restore the profile from the pre-install backup
```

## Layout

```
config/bundle-ai-compiler/     the deliverable bundle
  bundles.patch.yml              HOST plane: lsp, lsp-stdio(clangd), tool-lsp, agent-team, tool-agent-team, ui-agent-team
  cordis.patch.yml               PRESET plane: the preset-ai-compiler declaration
config/overlays/               alternative clangd builds (LLVM 22)
scripts/                       install / uninstall / verify / rollback + shared helpers
tests/
  preset/                      declaration vs official PTC (declared-diff gate)
  integration/                 composition suite (47 deterministic checks)
  permissions/                 real allow/deny assertions
  clangd/                      how clangd parses a real compile_commands.json
  e2e/                         Web-session driver, case A/B/C, independent verifiers
  bench/                       A/B benchmark harness
  diagnostics/                 preset probe (what the model would see)
docs/    00 baseline · 01 architecture · 02 source audit · 03 ADRs · 04 installation
         05 permissions · 06 test matrix · 07 benchmarks · 08 compatibility · 09 operations
evidence/  config snapshots, backups, e2e session logs, benchmark data, machine-readable results
```

## Status at a glance

| Area | Result |
|---|---|
| Custom mode registered, selectable, no shipped preset modified | PASS |
| PTC inside the mode | PASS (`run_code` real; 31 SDK bindings) |
| Agent Teams + PTC | PASS (Leader + teammates + task DAG + interrupt + restart recovery) |
| Spill / compaction | spill storage PASS; **compaction NOT_TESTED** (needs a small-context model) |
| LSP on a real C++ tree | PASS (`goToDefinition` / `findReferences` at real symbols) |
| Permissions | in-process fence PASS; **OS sandbox BLOCKED on this host** (documented, not worked around) |
| FFF | evaluated, **not adopted** (no rc.3 packaging) |

The full matrix with evidence links is in `docs/06-tests.md`.
