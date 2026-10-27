# 方案 3 设计：多角色 + 按角色分模型（Team 保留）

状态：调研完成，待实施。所有结论均有源码位置或实测证据。

---

## 0. 需求

| 角色 | provider | model | reasoningEffort | maxTokens |
|---|---|---|---|---|
| lead | magpie | auto/deepseek-v4.1-flash | 待定 | 待定 |
| architect | magpie | codex/gpt-6.1-sol | 待定 | 待定 |
| explorer | corp | Qwen3.8-Flash | 待定 | 待定 |
| implementer | corp | DeepSeek-V4.1-Flash-1017 | 待定 | 待定 |
| challenger | magpie | codex/gpt-6.1-sol | 待定 | 待定 |
| reviewer | corp | GLM-5.3-Flash | 待定 | 待定 |

要求：**保留 Agent Teams**（名册/消息/任务板/中断），同时每个角色使用不同路由。

---

## 1. 调研结论（决定方案形状）

### 1.1 已证实的机制（全部来自 rc.3 源码）

| 事实 | 位置 | 影响 |
|---|---|---|
| `SubagentStartRequest.agentOptions?: { provider, model, reasoningEffort, maxTokens }` **已存在** | `subagent/src/types.ts:167-174` | 路由走这里，Core 已有字段 |
| `resolveChildAgentOptions(parent, requested, depth)` 已实现"未指定则继承父、指定则覆盖" | `child-agent.ts:98-119` | 无需自写合并逻辑 |
| spawn provider 声明 `agentOptions: true` / `agentPreset: true` | `subagent-spawn-in-process/src/index.ts:40-45` | 能力门控通过 |
| descriptor 持久化 `agentProvider/agentModel/agentReasoningEffort`，冷恢复会还原 | `descriptor.ts:77-107`、`manager.ts:1369-1374` | **重启后角色路由自动恢复** |
| `tool-subagent` config 已有 `agentOptions`（含 reasoningEffort/maxTokens） | `tool-subagent/src/index.ts:85-96` | 直连委派本来就能分模型 |
| `SpawnTeammateRequest` **没有** `agentOptions` / `agentPreset` | `agent-team/src/types.ts:165-172` | **唯一缺口** |
| `roster.ts:264-274` 调 `startActivation()` 时不传 `agentOptions` | — | 缺口的确切位置 |
| `maxMembers` 默认 16，我方 bundle 设 8 | `agent-team/src/index.ts:42`、`agent-team-profile/cordis.patch.yml` | 7 个角色需要 ≥8，当前刚好 |

### 1.2 实测证据（本机）

**跨 provider 路由可用**（在子会话自己的 `request/header` 里验证）：

```
magpie/codex/gpt-6.1-sol            -> child route: magpie/codex/gpt-6.1-sol
corp/GLM-5.3-Flash                  -> child route: corp/GLM-5.3-Flash
corp/DeepSeek-V4.1-Flash-1017       -> child route: corp/DeepSeek-V4.1-Flash-1017
corp/Qwen3.8-Flash                  -> child 回复自身 model id "Qwen3.8-Flash"
```

即 `agentOptions` 的 provider/model **真实生效**，不是被静默忽略。

**reasoningEffort 已确认不可用**（实验 1，见
`reports/experiment-results`）：6 个模型 `resolveModelInfo().reasoning` **全部为 null**，
任何显式 effort 都被 `UNSUPPORTED_REASONING_EFFORT` 拒绝。**角色差异只能落在 provider/model/maxTokens。**

**预设作用域不能改模型**：`presets.serviceFor(lead, 'agentDefaultModel')` 返回 `undefined`，
说明 `agent-default-model` 是 Host 平面服务；**在预设里声明它不会改变子 Agent 的模型**。
→ 所以"多预设分模型"必须走 `agentOptions` 或 `agentPreset`，不能靠预设里的默认模型行。

---

## 2. 方案 3 的三种落地形态

### 形态 A：**改 Core 3 处**（最小、最稳）

```diff
// 1. packages/experimental/agent-team/src/types.ts
 export interface SpawnTeammateRequest {
   readonly name: string
   readonly description: string
   readonly prompt: ContentBlock[]
   readonly context: 'fresh' | 'fork'
   readonly provider: string
+  /** Optional child route override; omitted inherits the Lead's route. */
+  readonly agentOptions?: AgentOptions
   readonly signal: AbortSignal
 }

// 2. packages/experimental/agent-team/src/roster.ts
   const started = await this.ctx.subagents.startActivation({
     delivery: 'parent', childId, provider: request.provider, label: description,
     request: {
       prompt: request.prompt,
       parent: root,
+      ...request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions },
     },
     signal,
   })

// 3. packages/experimental/tool-agent-team/src/index.ts
   parameters: {
     name: …, description: …, prompt: …, context: …,
+    agent_options: {
+      type: 'object',
+      description: 'Route override for this teammate. Omit to inherit the Lead route.',
+      properties: {
+        provider: { type: 'string', required: true },
+        model: { type: 'string', required: true },
+        reasoningEffort: { type: 'string' },
+        maxTokens: { type: 'integer' },
+      },
+    },
   },
   execute: … ctx.agentTeams.spawnTeammate(agent, { …, ...args.agent_options ? { agentOptions: args.agent_options } : {} })
```

- **优点**：Team 能力全部保留；descriptor 持久化天然生效；改动约 15 行。
- **风险**：改 3 个 experimental 包 → 需要一个 patch 提交和升级时的重打流程。
- **你已说"不常升级"** → 可接受。

### 形态 B：**不动 Core，另注册一个 Team 工具集**（不推荐）

自己写一个 `role-aware-tool-agent-team`，把 9 个工具全部重新实现并加 `agent_options`。
- 必须禁用官方 `tool-agent-team`（否则同 scope 同名注册冲突）。
- **等于重写 Team 工具层** → 违反 Part G.4「不允许重写官方 Agent Teams 的核心任务与消息机制」。
- 而且它是**冗余**的：Core 只缺一个字段透传。

### 形态 C：**放弃 Team，用多预设 + `subagent(agent_preset)`**（不满足需求）

- 能分模型、能按角色隔离工具面，但**失去名册/消息/任务板/中断**。
- Case A/B/C 的「可追踪」正是靠任务板证明的，不应放弃。

### 结论

> **选形态 A**：3 个文件、约 15 行、不改任何 Team 内部机制，只补一个透传字段。
> 角色→模型映射写成**预设内的 Team 角色表**（见 §3），由 Lead 在 `spawn_teammate` 时填入。

---

## 3. 角色配置的承载方式

`spawn_teammate` 的 `agent_options` 由 **Lead 在运行时填**。这带来一个风险：
7 个角色 × 4 个字段，Lead 很可能写错。因此需要一个**权威来源**，三选一：

| 选项 | 做法 | 评价 |
|---|---|---|
| **① 预设 persona 表格**（推荐） | 在 `ai-compiler` 的 persona 里写明角色→路由表；Lead 照表填 | 零额外代码；但仍是"提示"，可漂移 |
| ② 每个角色一个预设 | 7 个预设，`spawn_teammate` 加 `agent_preset` 参数 | 能同时隔离工具面；但需 Core 再透传 `agentPreset`，且预设数量×7 |
| ③ 一个团队配置插件 | 读 `$DSH_HOME` 下的 `team-roles.yml`，在 spawn 时注入 | 最可控；需再写一个插件 |

**推荐 ①**：先把映射写进 persona，用现有 `verify-preset` 校验 persona 文本包含 6 个角色行；
若实测发现 Lead 经常写错，再升级到 ③。

> 注意：形态 A 的 `agent_options` 是**模型可见参数**，所以 Lead 可以按 persona 表填写；
> 若要做到"模型无法改错"，需要 ③（把表变成不可见注入）。

---

## 4. 角色表的建议取值（待你确认）

| 角色 | provider/model | reasoningEffort | maxTokens | 依据 |
|---|---|---|---|---|
| lead | magpie / auto/deepseek-v4.1-flash | `high` | 默认 393216 | 协调 + 整合，需要长上下文 |
| architect | magpie / codex/gpt-6.1-sol | `high` | 128000（模型上限） | 设计需要强推理 |
| explorer | corp / Qwen3.8-Flash | `off` 或 `low` | 默认 | 检索是机械任务，低 effort 更快 |
| implementer | corp / DeepSeek-V4.1-Flash-1017 | `medium` | 默认 | 写代码兼顾质量与速度 |
| challenger | magpie / codex/gpt-6.1-sol | `high` | 128000 | 反驳需要强推理 |
| reviewer | corp / GLM-5.3-Flash | `medium` | 默认 | 审查需要细读但不必最深 |

**待确认**：
- `reasoningEffort` 的合法档位是 `off|minimal|low|medium|high|xhigh|max`
  （`llm-pi-ai/src/catalog.ts:76-84`），但**每个模型是否真的支持某一档要它自己的
  `reasoningEfforts` 声明**；用户 profile 里这 6 个模型**都没有声明**，
  所以目前它们继承 pi-ai 安装目录的能力。**实施前必须实测每个模型支持哪些档**。

---

## 5. 实施前必须补的 3 个实验

1. **reasoningEffort 逐模型可用性**：对 6 个模型分别用 `off/low/medium/high` 启动子 Agent，
   记录 `stopReason` 与子会话 `request/header.config.reasoningEffort`。
   预期产物：`evidence/design/reasoning-matrix.json`。
2. **maxTokens 生效性**：用超大 `maxTokens`（超过模型上限）验证是否被拒绝或截断。
3. **8 人上限的边界**：Lead + 6 角色 = 7；验证第 8 个成员能否创建、第 9 个是否报
   `TEAM_MEMBER_LIMIT`。

---

## 6. 实施步骤（确认后执行）

| # | 动作 | 产物 | 验证 |
|---|---|---|---|
| 1 | 补 3 个实验 | `evidence/design/*.json` | 逐模型矩阵 |
| 2 | 打 Core patch（3 文件） | `patches/0001-team-agent-options.patch` | `git apply --check`；TypeScript 编译 |
| 3 | 预设 persona 加角色表 + `# DIFF:` 注释 | `cordis.patch.yml` | `verify-preset.mjs` PASS |
| 4 | 确定性套件加「角色路由」检查 | `composition-suite.mjs` | 6 条新断言 |
| 5 | live Case D：6 角色各跑一次，核对子会话 `request/header` 路由 | `evidence/e2e/case-d/` | 6/6 路由匹配 |
| 6 | 回归：Case A/B/C + 全部套件 | 现有证据 | 全绿 |

---

## 7. 影响面清单

| 区域 | 影响 | 回滚方式 |
|---|---|---|
| DSH Core | 3 个 experimental 包、约 15 行 | `git apply -R patches/0001-*.patch` |
| 预设 | persona 文本 + 角色表 | `verify-preset` 的 DECLARED 更新；bundle 可整体卸载 |
| Team 行为 | 默认行为不变（`agent_options` 省略 = 继承，与现在完全一致） | 不传参数即回退 |
| 冷恢复 | descriptor 已持久化 model/provider，**无需额外改动** | — |
| 权限 | 不变（子 Agent 仍 approval=never） | — |
| 现有证据 | 全部保持有效 | — |
