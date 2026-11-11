# Decisive evidence: why `ai-compiler-magpie` served the `corp` role table

Source of truth: the attached session archive
`dsh-session-session-757fa075-1ba4-4184-83f0-f29814830fbb.zip`
(`session.v4.jsonl`, 592 events), plus this session's own log.

## 1. The two records disagree

| Record | Value |
|---|---|
| Session **header** `agentPreset` (seq 0, deep-frozen creation fact) | `"standard"` |
| `agent-preset/selected` event (seq 3) | `"ai-compiler-magpie"` |

The header is written once at session creation and is immutable. Choosing a preset in the GUI
chip appends an `agent-preset/selected` event; it does **not** rewrite the header — by design,
per `packages/preset/agent-preset-registry/src/session.ts`:

> Reconstruction reads the `agentPreset` Session projection, **never the header alone**.

## 2. The mounted composition was correct

The persona block in the session's system message is the **magpie** persona
(`config/bundle-ai-compiler/cordis.patch.yml`, `ai-compiler-magpie` section):

> This preset is the one-provider mode: its table routes all six roles through `magpie`:
> architect magpie/group/architect … implementer magpie/group/implementer …

So the preset itself mounted. The composition was right.

## 3. The role catalog was wrong — and came from DEFAULT_ROLES

The *same* system message also contains, rendered at runtime by
`packages/experimental/tool-agent-team/src/index.ts` `roleCatalog()`:

> explorer (corp/Qwen3.8-Flash, …) · **implementer (corp/DeepSeek-V4.1-Flash-1017, …)** ·
> reviewer (corp/GLM-5.3-Flash, …)

That is character-for-character `DEFAULT_ROLES` in
`packages/experimental/agent-team/src/index.ts`:

```ts
export const DEFAULT_ROLES: readonly RoleSpec[] = [
  { id: 'architect',   provider: 'magpie', model: 'group/architect',         maxConcurrent: 1 },
  { id: 'explorer',    provider: 'corp',   model: 'Qwen3.8-Flash',           maxConcurrent: 2 },
  { id: 'implementer', provider: 'corp',   model: 'DeepSeek-V4.1-Flash-1017', maxConcurrent: 2 },
  { id: 'reviewer',    provider: 'corp',   model: 'GLM-5.3-Flash',           maxConcurrent: 1 },
  ...
]
```

The Lead therefore read two contradictory tables **in one prompt**: prose said *magpie*,
the tool catalog said *corp*. Nothing in the runtime noticed.

## 4. The exact defect (code)

`packages/experimental/agent-team/src/routes.ts`

```ts
export function presetIdOf(agent: Agent): string | undefined {
  const presets = agent.ctx.get('agentPresets') as PresetRoster | undefined
  return presets?.composedPreset(agent.ctx) ?? agent.session.header.agentPreset   // <-- FAULT
}

export function resolveRoles(config: Required<Config>, lead: Agent): readonly RoleSpec[] {
  const presetId = presetIdOf(lead)
  if (presetId === undefined) return config.roles                    // <-- silent
  return config.presetRoles[presetId] ?? config.roles                // <-- silent
}
```

Fault 1 — **wrong record in the fallback.** When `composedPreset()` is unavailable,
`presetIdOf` reads the frozen creation header (`"standard"`) instead of the live
`agentPreset` projection. `presetRoles` has no `standard` key, so `resolveRoles` returns
`config.roles` = `DEFAULT_ROLES` = the corp table.

Other code already does this correctly:
`packages/api/session-controller/src/agent.ts:367` reads
`stateOf(session, 'agentPreset')`. `agent-team` has `sessionProjections` injected
(`index.ts:127`) but never consults it for routing.

Fault 2 — **the fallback is silent.** `resolveRoles` cannot distinguish
*"this preset genuinely has no table"* (expected) from
*"we could not determine the preset"* (a fault). Both collapse to `config.roles`, and the
rendered catalog gives the model no way to see which happened.

## 5. Blast radius

The header is `standard` for **every** session created before a preset chip was chosen,
i.e. the normal GUI flow. Whenever the live composition is unavailable to the resolver, all
sessions started that way silently route teammates by `DEFAULT_ROLES`, whatever the operator
configured. The `--dump-config` output is correct throughout — which is why
`scripts/verify.sh` step 1f passed: **it verifies the config file, not the resolved table the
model is shown.**

## 6. What would have caught it

No prompt or skill can fix this, because the model was told the truth twice and the two
truths disagreed. The defect is a resolver reading the wrong record and a renderer that hides
its own fallback. The fix is code:

1. `presetIdOf` must read `composedPreset() ?? projection('agentPreset') ?? header`.
2. The resolved table must carry its **source**, and the catalog must render it — with an
   explicit WARNING when a named preset fell back to the base table.
3. `verify.sh` must assert the **resolved** table for the active preset, not only the
   composed config text.
