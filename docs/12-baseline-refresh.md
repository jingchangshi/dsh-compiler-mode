# Baseline refresh: `reasoningEfforts` is now part of the reference configuration

## What changed

`evidence/backup/profile-web-orig/cordis.patch.yml` was refreshed to match the
live `~/.dsh/profiles/web/cordis.patch.yml`. The only difference between the two
was 20 added lines, all of them `reasoningEfforts: {low, medium, high}` blocks
inside model entries.

```
34a35,38
>             reasoningEfforts:
>               low: low
>               medium: medium
>               high: high
(and four more identical blocks)
```

No other line differed. `verify.sh` step 6 asserts byte-identity between the live
profile and the backup, so the drift made it report FAIL.

## Why the baseline moved rather than the live file

The `reasoningEfforts` blocks are the **operator's** model configuration and are
kept. Refreshing the backup records the current model configuration as the
reference state. Rewriting the live file to match an older backup would have been
a change to model configuration — which this work package is explicitly forbidden
to make, and which is exactly the kind of edit the check exists to catch.

## What the check still proves

Step 6 remains meaningful after the refresh: it still fails if anything installs,
removes or reorders a profile row, which is the property it was written for. It
no longer carries an unrelated historical diff alongside that signal.

## Verification

```
scripts/verify.sh
  1. profile records the mode                     PASS
  2b. MCP bridge registers the agentgates tools   PASS (13 checks)
  2. preset declaration vs official PTC           PASS
  4. composition suite                            PASS (47 checks)
  5. permission suite                             PASS (4 checks)
  6. user model configuration untouched           PASS
  verify: 0 failure(s)
```
