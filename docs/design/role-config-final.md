# 角色模型配置（2026-11-11 更新：角色路由按 preset 分化）

> **2026-11-11 更新**：本文原定稿表已过时。角色路由现在由 Host 行 `agent-team` 的
> `presetRoles` **按 preset** 决定（各 preset 一张**完整**角色表），不再是单一一组固定路由。
> 原表写的 `architect = codex/gpt-6.1-sol`、`validator = auto/mimo-v2.6-flash` 等取值均已被取代。

依据实验（`evidence/design/experiment-results.md`）与实机验证（`evidence/e2e/case-d/route-proof.md`），
以及 2026-11-11 的 per-preset 路由改造（源码补丁 `patches/0003-team-preset-role-routes.patch`）。

## 当前真实的两张表

路由来源唯一：`config/bundle-ai-compiler/bundles.patch.yml` 中 `- id: agent-team` 的
`config.presetRoles`。键是 preset 自己的 `config.id`（`cordis.patch.yml`）。

| 角色 | `ai-compiler`（order 5） | `ai-compiler-magpie`（order 6） | maxConcurrent |
|---|---|---|---|
| architect | `magpie` / `group/architect` | `magpie` / `group/architect` | 1 |
| explorer | `corp` / `Qwen3.8-Flash` | `magpie` / `group/explorer` | 2 |
| implementer | `corp` / `DeepSeek-V4.1-Flash-1017` | `magpie` / `group/implementer` | 2 |
| reviewer | `corp` / `GLM-5.3-Flash` | `magpie` / `group/reviewer` | 1 |
| challenger | `magpie` / `group/challenger` | `magpie` / `group/challenger` | 1 |
| validator | `magpie` / `group/validator` | `magpie` / `group/validator` | 1 |

- Lead 本身的模型不在此表内：它由会话启动时的模型选择决定（本机为 `magpie` / `auto/deepseek-v4.1-flash`）。
- **reasoningEffort 全部不设**：六个角色模型**都没有**声明 `reasoningEfforts`，任何显式 effort 会被
  `UNSUPPORTED_REASONING_EFFORT` 拒绝（实验 1）。`RoleSpec` 也**没有** `reasoningEffort` 字段。
  （magpie 上确有 `auto/deepseek-v4.1-flash`、`auto/glm-5.3-flash`、`auto/mimo-v2.6-flash` 三个模型声明了
  low/medium/high，但本表六个角色都不路由到它们。）
- **maxTokens 全部省略**：框架不校验上限（实验 2），省略即用 provider 声明值，最安全。
- 成员上限 8（不含 Lead）。

## 承载方式（2026-11-11 起）

1. **路由**：Host 行 `agent-team.presetRoles`（`config/bundle-ai-compiler/bundles.patch.yml`）。
   解析代码唯一实现于 `packages/experimental/agent-team/src/routes.ts` 的 `resolveRoles()`：
   取 Lead 的 preset id（优先 `ctx.get('agentPresets').composedPreset(agent.ctx)`，回落
   `agent.session.header.agentPreset`），返回 `presetRoles[id] ?? roles`。
   spawn 时经 `roster.ts` 的 `startActivation({ request: { agentOptions: { provider, model } } })` 下发给子会话。
2. **文案**：`cordis.patch.yml` 的 `persona.prefix` 只是**文档**，与表逐字对齐；
   `tests/preset/verify-preset.mjs` 将它作为已声明差异（persona）门禁。
   模型真正看到的角色目录由 `tool-agent-team` 在运行时从 `agentTeams.rolesFor(agent)` 生成。

**关键事实**：`spawn_teammate` 只接受 `role/task/context/slot/description`，**没有**
provider/model/`agent_options` 参数。Lead 无法按人格表"传"路由——路由是配置侧固定的。

## 实机验证结论

4/4 角色路由与 persona 表一致，且**没有任何角色回退到 Lead 的模型**
（逐个子会话 `request/header` 核对，见 `evidence/e2e/case-d/route-proof.md`）。

2026-11-11 起该一致性由 `tests/integration/composition-suite.mjs` 的 `routes` 组持续守护：
逐 preset 断言 `rolesFor(agent)` 的六条路由、`team:policy` 文本、**以及手写的
`deployment:persona-prefix` 文本**三者一致。此前 persona 写 magpie 而实际走 corp 的漂移
正是该组要抓的缺陷（已用故意改坏配置的方式验证该断言确实会 FAIL）。

## 已知限制（不是缺陷）

- `member.model` 只在成员 live 时可见；inactive 时 roster 显示 null。
  真相在子会话的 `subagent/descriptor` / `request/header`。
- `member.provider` 恒为 `spawn`/`fork`（后端名），不是模型 provider 名。
- `reasoningEffort` 若要可用，需在 profile 里给模型声明 `reasoningEfforts`
  （改用户模型配置，未授权，未做）。
- 未配置 `presetRoles` 时回落内置 `DEFAULT_ROLES`，行为与改造前完全一致。
