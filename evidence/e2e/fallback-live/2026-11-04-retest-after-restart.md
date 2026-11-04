# llm-fallback — live re-test after Host restart (2026-11-04)

Re-verification of the AI-Compiler provider-route fallback on the **current** running
Host, closing the one pending item from `2026-11-04-live-test.md` (the qwen route
fallback used to 404 because the bundle declared the phantom `auto/qwen3.8-flash`).

## Environment under test

| Fact | Value |
|---|---|
| Host | `node --import tsx/esm apps/cli/src/bin.ts web --port 3092` (pid 2817828) |
| Host started | 2026-11-04 00:53:05 +08:00 (after the 00:33 bundle fix — so the corrected route is loaded) |
| Profile | `web` (bundles include `@local/dsh-ai-compiler-preset`) |
| Fallback row | `ai-compiler-llm-fallback` present in `--dump-config` (line 1377) |
| qwen route | `corp/Qwen3.8-Flash -> magpie/opencode-go/qwen3.8-flash, magpie/auto/claude-haiku-5-5` |

Corp gateway state at test time is a terminal per-day budget exhaustion:

```
HTTP 429
{"error":{"message":"Budget has been exceeded! Key=00653124 (sk-...QmYQ)
 Current cost: 50.00672699999992, Max budget: 50.0","type":"budget_exceeded","code":"429"}}
```

The adapter flattens this to `RATE_LIMIT` with `Budget has been exceeded` in the
message — exactly what `isEligible()` treats as quota-class.

## Offline checks (green)

- `node --test plugins/llm-fallback/{logic,wiring}.test.ts` -> **16/16 pass**.
- `dsh --profile web --dump-config` -> `ai-compiler-llm-fallback` row present with the
  corrected `opencode-go/qwen3.8-flash` target.

## Live probes (each = one trivial "reply PONG" turn by a fresh role)

Read from the child session log: `request/header` (per attempt) + `assistant/attempt`
(failure) + `turn/end`.

| Role (primary) | Attempt 1 (initial) | Failure | Attempt 2 (change) | End | Verdict |
|---|---|---|---|---|---|
| explorer · corp/Qwen3.8-Flash | corp/Qwen3.8-Flash | RATE_LIMIT 429 budget_exceeded | magpie/opencode-go/qwen3.8-flash | PONG · completed | ✅ (was broken) |
| implementer · corp/DeepSeek-V4.1-Flash-1017 | corp/DeepSeek-V4.1-Flash-1017 | RATE_LIMIT 429 budget_exceeded | magpie/auto/deepseek-v4.1-flash | PONG · completed | ✅ |
| reviewer · corp/GLM-5.3-Flash | corp/GLM-5.3-Flash | RATE_LIMIT 429 budget_exceeded | magpie/auto/glm-5.3-flash | PONG · completed | ✅ |

Child session ids:

- explorer:    `2114b41b-1094-41bf-b270-be271414a946`
- implementer: `1b57a74f-e0e7-4599-81e3-2e20071f88ff`
- reviewer:    `2be3e019-fec4-4a5f-bd27-00de0bdeab3a`

Explorer raw sequence (the route that used to fail):

```
seq 12 request/header  initial  corp/Qwen3.8-Flash
seq 13 request/context          corp/Qwen3.8-Flash
seq 16 assistant/attempt        finish=error RATE_LIMIT "Budget has been exceeded" (429 budget_exceeded)
seq 17 request/header  change   magpie/opencode-go/qwen3.8-flash   (maxTokens 131072)
seq 18 request/context          magpie/opencode-go/qwen3.8-flash
seq 19 assistant/message        "PONG"
seq 21 turn/end                 { kind: "completed" }
```

## Conclusion

The current llm-fallback is **in effect**. On a quota-exhausted corp gateway the plugin:

1. detects the eligible `RATE_LIMIT`/`budget_exceeded` failure on the pinned corp route,
2. rewrites the same turn's request to the same-family magpie route (`reason: "change"`),
3. keeps the full conversation and completes the turn.

All three corp primary routes (qwen, deepseek, glm) fail over to a **served** magpie
model and complete. The previously pending qwen defect (`auto/qwen3.8-flash` 404) is
resolved by the `opencode-go/qwen3.8-flash` id; it responds `PONG` and the turn
completes. `llm-retry` cannot change provider/model on the same route, so the observed
route change is unambiguously the fallback plugin.

Not exercised in this pass: the magpie-primary safety hops (architect/challenger/
validator) and the sticky/globalSticky re-probe — covered by the 16 offline tests and
the earlier `2026-11-04-live-test.md` run.
