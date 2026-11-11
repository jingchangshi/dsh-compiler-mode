# Per-preset role routing

Status: implemented and verified (2026-11-11). Every claim below points at a source or
config location you can check.

## What the capability is

One Host serves several **presets** (the chip you pick when you start a chat). Before this
change, Agent Teams had exactly one role table for the whole Host, so `ai-compiler` and
`ai-compiler-magpie` routed the six Team roles to the **same** models — the second preset
could only describe a different fleet in prose, never actually run one.

Now the Team-service config has `presetRoles`: a map from preset id to a **complete** role
table. A Team's table is chosen by its **Lead's** preset, so each preset really runs its own
fleet in the same Host.

## Why the Lead cannot choose

`spawn_teammate` accepts `role`, `task`, `context`, `slot`, `description` and nothing else
(`packages/experimental/tool-agent-team/src/index.ts`). There is no provider/model argument
and no `agent_options` — that parameter existed briefly in `patches/0001-team-agent-options.patch`
and was removed by `0002`. A route is deployment configuration, fixed before any session starts.

## Resolution order (one implementation)

`packages/experimental/agent-team/src/routes.ts`:

1. `presetIdOf(agent)` — `agent.ctx.get('agentPresets')?.composedPreset(agent.ctx)` first,
   then `agent.session.header.agentPreset`. The live composition wins because a Lead may
   switch preset while its session is still blank; the durable header covers a cold resume
   where no preset roster is composed.
2. `resolveRoles(config, lead)` — `config.presetRoles[presetId] ?? config.roles`.

`TeamService.rolesFor(agent)` exposes the same function, and `roster.ts` uses it when it
spawns. A teammate never selects a table: the **root** agent's preset decides for the whole Team.

## Config shape

In `config/bundle-ai-compiler/bundles.patch.yml`, on the Host row `- id: agent-team`:

```yaml
- id: agent-team
  name: '@deepseek-ai/dsh-experimental-agent-team'
  config:
    presetRoles:
      ai-compiler:            # this is the preset's `config.id`, not its row id
        - { id: architect, description: Architecture and design, provider: magpie, model: group/architect, maxConcurrent: 1 }
        # … five more
      ai-compiler-magpie:
        - { id: architect, description: Architecture and design, provider: magpie, model: group/architect, maxConcurrent: 1 }
        # … five more
```

Rules the implementation enforces at startup (`validateTopology` in
`packages/experimental/agent-team/src/index.ts`):

- Keys are matched against the preset's **`config.id`** (`ai-compiler`), not the row id
  (`preset-ai-compiler`). A key that matches nothing simply never applies.
- Each table is validated by the **same** rules as `roles`: unique lower-kebab ids, not
  `lead`, non-empty description/provider/model, positive `maxConcurrent`, optional positive
  `maxTokens`.
- Each table must contain every role named by `slotPlan.reserved` (architect, reviewer,
  explorer, implementer) — one slot plan serves all presets, so a table missing one of those
  could never fill that pinned position.
- A table **replaces** `roles`; it is not merged field by field.
- No `presetRoles` at all (or no matching key) ⇒ `roles` ⇒ `DEFAULT_ROLES`. Behaviour is
  byte-identical to before the change.

## Adding a table for a new preset

1. Find the preset's `config.id` in `config/bundle-ai-compiler/cordis.patch.yml`.
2. Add that exact string as a key under `agent-team.presetRoles`, with a complete six-role
   table (copy an existing one and edit `provider`/`model`).
3. Make sure every model id you write is declared by the live profile
   (`~/.dsh/profiles/web/cordis.patch.yml`) — an unknown id fails at request time, not at startup.
4. Update that preset's `persona.prefix` table so the prose still matches (the `routes` group
   in the composition suite will fail if you forget).
5. Reinstall the bundle and **restart the Host**.

## How to verify

```bash
# The tables are in the composed tree:
node apps/cli/lib/bin.js --profile web --dump-config   # from the HARNESS checkout
#   → grep -A40 'id: agent-team'  shows presetRoles with both tables

# The real proof: an actual spawn, then read the child's own request header.
#   evidence/e2e/case-d/route-proof.md  shows the method: each child session's
#   request/header.config.provider|model must equal the table's route for that role.

# Regression guard (per preset: resolved table == team:policy text == hand-written persona):
node tests/integration/composition-suite.mjs     # the `routes` group
```

The `routes` group exists because the original defect was **silent**: the persona told the
Lead `magpie/group/architect` while the deployment routed that role to `corp`, and every test
still passed. The guard compares the runtime table against both texts, so that class of drift
now fails loudly. The persona half was verified by deliberately corrupting the config and
confirming the suite exits 1.

## Known limits

- `member.provider` in the roster is the **backend** (`spawn`/`fork`), not the model provider.
  The model route is only visible while the member is live (`member.model`), or in the child's
  `request/header`.
- Switching a Lead's preset mid-session changes which table its **future** spawns use; already
  spawned teammates keep the route they were started with.
- `RoleSpec` has no `reasoningEffort` field and none of the six route models declares
  `reasoningEfforts`, so an explicit effort would be rejected with
  `UNSUPPORTED_REASONING_EFFORT`.
