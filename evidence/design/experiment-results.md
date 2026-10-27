# 实施前 3 个实验的结果（2026-10-27）

原始数据：`reasoning-matrix.json`、`maxtokens-probe.json`、`member-limit-probe.json`、
`/tmp/member-limit`（真实 Web 会话）。

---

## 实验 1 — reasoningEffort：**6 个模型全部不支持显式指定**

`llm.resolveModelInfo()` 对 6 个目标模型的返回（直接查询服务）：

| provider/model | `reasoning` | defaultMaxTokens | contextWindow |
|---|---|---|---|
| magpie/auto/deepseek-v4.1-flash | **null** | 393216 | 1048576 |
| magpie/codex/gpt-6.1-sol | **null** | 128000 | 500000 |
| corp/Qwen3.8-Flash | **null** | undefined | 262144 |
| corp/DeepSeek-V4.1-Flash-1017 | **null** | undefined | 262144 |
| corp/GLM-5.3-Flash | **null** | undefined | 262144 |
| magpie/claude/claude-opus-5-5 | **null** | 128000 | 1000000 |

矩阵实测（6 角色 × off/low/medium/high = 24 格）**全部 `error`**：

```
lead        high  error  ERR=provider "magpie" model "auto/deepseek-v4.1-flash" does not support reasoning effort "high"
explorer    low   error  ERR=provider "corp" model "Qwen3.8-Flash" does not support reasoning effort "low"
…（24 格同此）
```

**根因**（`packages/llm/llm/src/index.ts:915-923`）：

```ts
const reasoning = info.reasoning
const requested = defaulted.reasoningEffort
if (reasoning === undefined) {
  if (requested !== undefined) {
    throw new LlmError(`… does not support reasoning effort "${requested}"`, 'UNSUPPORTED_REASONING_EFFORT')
  }
}
```

即：**模型没有声明 reasoning 能力时，任何显式 effort 都被拒绝**。
这 6 个模型在你 profile 里都没写 `reasoningEfforts:`

**结论**：按角色区分 reasoningEffort **当前不可用**。三条出路：

1. **不设 effort**（推荐）：省略字段，模型走自身默认。角色差异只体现在 provider/model/maxTokens。
2. **为模型声明 `reasoningEfforts`**：在 profile 的 `llm-pi-ai` 模型条目里加
   `reasoningEfforts: { off: , low: low, medium: medium, high: high }`（wire 值需按各家 API 确认）。
   这是**改用户模型配置**，你之前说"不修改既有模型配置"，需你重新授权。
3. 换用真正声明了 reasoning 的模型（如 `deepseek-reasoner` 一类）。

---

## 实验 2 — maxTokens：**原样透传，不做钳制**

| 请求 | 实际到达请求头 | stopReason |
|---|---|---|
| flash / 4096 | 4096 | completed |
| flash / 393216（模型上限） | 393216 | completed |
| flash / **999999**（超上限） | **999999** | 请求已发出（未报错拒绝） |
| corp/GLM-5.3-Flash / 8192 | —（探针 provider 已失效，见下） | — |

**结论**：`agentOptions.maxTokens` 被如实写入 `request/header.config.maxTokens`，**框架不校验上限**。
超上限是否被 provider 拒绝由上游决定（本次未观察到拒绝，但也没有完成记录，属未确证）。

> **风险**：这意味着角色表里的 `maxTokens` 需要人工对照模型上限，否则可能被上游截断或报错。
> 现有 profile 已为 magpie 的模型声明了 `maxTokens`，`corp` 的三个模型**没有声明**
> （`defaultMaxTokens: undefined`）——给它们设 maxTokens 时尤其要小心。

---

## 实验 3 — 成员上限：**8 个 teammate（不含 Lead）**

真实 Web 会话实测（不是探针）：

```
8 个 teammate 全部创建成功（team/member 事件 16 条 = 8 成员 × 2 条边）
第 9 次 spawn → "Team member limit 8 reached"
名册 9 条 = lead + m1..m8
```

**结论**：
- `maxMembers: 8` 上限**不含 Lead**，所以上限是 Lead + 8 = 9 个 Agent。
- **Lead + 6 角色 = 7 人，余量 2 个**——够用，但如果要让某个角色同时开两个（如两个 implementer 并行）
  就要算进去。
- 已被中断/失败的成员是否占名额：`agent-team-profile` 文档与源码 `member.phase === 'failed'` 仍计入
  roster，所以**失败也占名额**。

---

## 附带发现：宿主探针的 `spawn` provider 在首次失败后失效

在 in-process 探针里，第一个用 `agentOptions.reasoningEffort` 的调用失败后，
后续所有 `startActivation({provider:'spawn'})` 都报
`no subagent provider registered for "spawn"`。真实 Web 会话**不受影响**（8 个成员全部创建成功）。

判定：这是**探针在 host Realm 里吞掉了 provider 注册失败**的副作用，不是产品缺陷。
但记录在此，避免后续误判；所有角色路由结论均以真实 Web 会话为准。
