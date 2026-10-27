# 05 — Permissions and Sandbox

Two mechanisms are separated here because they are enforced by different code and fail differently.

## 1. Tool visibility (what the model may name)

- `tools` registry: preset rows register in the preset scope; the model-facing wire list is
  projected from the agent's own scope chain.
- In `ptc` mode the wire list collapses to **only `run_code`**; the PTC SDK is generated from the
  same view, so *the prompt and the program always agree*.
- `ai-compiler` deliberately has **one** delegation surface: the Team tools. The four direct
  delegation rows are declared `disabled: true` in the preset (Q18 defect, measured — the model
  preferred `subagent` and never touched the Team API).

Verified by `tests/integration/composition-suite.mjs` (47 checks): wire list is `[run_code]`,
SDK binds 31 tools, direct delegation absent, Team tools present.

## 2. Runtime permission (what a call may actually do)

| Layer | Enforces | Where |
|---|---|---|
| `permission-presets` | named bundles of sandbox mode + approval policy | `packages/interaction/permission-presets` |
| `sandbox-policy` | current mode per session | `packages/sandbox/sandbox-policy` |
| `fs-sandbox` | `write`/`edit` containment fence (in-process) | `packages/fs/fs-sandbox/src/index.ts:122-144` |
| `bash-sandbox` / `sandbox-local` | OS confinement of `bash` and the PTC Node child | `packages/shell/bash-sandbox`, `packages/sandbox/sandbox-local` |
| `user-approval` | `ask` / `never` per call | `packages/interaction/user-approval` |

Delegation: a teammate inherits the Lead's **explicit** sandbox override and its approval policy is
**pinned to `never`** (`packages/subagent/subagent/src/child-agent.ts:248-255`), so a child can never
widen its own scope. The child's own log records those facts as `source: 'delegation'` events.

## 3. Measured behaviour on THIS host

`tests/permissions/permission-suite.mjs` (4 PASS / 0 FAIL):

| Assertion | Result |
|---|---|
| `workspace-write` allows a write **inside** the workspace root | PASS (`ALLOWED`) |
| `workspace-write` denies a write **outside** the root and `/tmp` | PASS (`FS_SANDBOX_DENIED`) |
| `read-only` denies even an in-root write | PASS (`FS_SANDBOX_DENIED`) |
| `danger-full-access` allows a write outside the root | PASS (`ALLOWED`) |

Note: `workspace-write` also grants `/tmp` and `$TMPDIR` by design
(`packages/sandbox/sandbox/src/roots.ts:52-55`), so the negative probe targets `$HOME`.

### The OS sandbox cannot run here — recorded, not hidden

```
SandboxUnavailableError: sandbox mode "workspace-write" is requested but no sandbox backend
is usable on this host; refusing to run the command unconfined.
```

Two independent reasons, both measured:

1. `bwrap` cannot create a user namespace —
   `kernel.apparmor_restrict_unprivileged_userns = 1` (Ubuntu AppArmor), so
   `bwrap: setting up uid map: Permission denied`.
2. The `landlock-run` launcher that `sandbox-local` expects
   (`native/system/packages/linux-x64/prebuilds.json`) is **absent** from the build output;
   only `bin/glibc/system.node` exists.

**Consequence.** On this machine only `danger-full-access` runs `bash` and the PTC child. The
in-process `fs-sandbox` fence still works for `write`/`edit` (that is what the four assertions
above exercise). This is a property of the host, not of `ai-compiler`: the mode adds **no**
sandbox configuration, no exemption and no allowlist, and the profile's existing
`defaultPreset: danger-full-access` was left exactly as the user set it.

### What that means for the mode's safety claim

- Verified: the mode does not weaken any fence, and its children cannot escalate.
- Not verified on this host: filesystem containment of `bash` and of direct Node calls inside
  `run_code`. A deployment that needs it must have `bwrap` working (privileged user namespaces
  enabled) or a built `landlock-run`; the mode then works unchanged because the policy is the
  Host's, not the preset's.

## 4. Approval surfaces

- **Web**: a per-call panel (`ui-approval`) — the only answerer in the Web profile.
- **Headless**: no answerer, so an `ask` resolves `unavailable` and **fails closed**; the model
  reads a denial instead of hanging. `danger-full-access` + `never` (this profile) bypasses it.
- **Teammates**: always `never`, whatever the Lead selected.
