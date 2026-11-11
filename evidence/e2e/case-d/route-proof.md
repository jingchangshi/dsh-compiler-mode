# Case D — 角色路由独立验证

> ## ⚠️ 历史记录（测量于 2026-10-27，早于 2026-11-11 的 per-preset 路由改造）
>
> **本文是真实的历史测量，数值一律保持原样、未做修改。** 方法（直接读子会话自己的
> `request/header`，不采信 Lead 自述与 roster 字段）至今有效，4/4 全匹配的结论当时也成立。
> 但下表有 **2 个角色的路由取值已被取代**，请勿照抄。
>
> ### 路由取值：旧 → 新（`ai-compiler` 预设）
>
> | 角色 | 本文记录的旧路由（历史，真实测量） | 当前真实路由 | 变化 |
> |---|---|---|---|
> | architect | `magpie / codex/gpt-6.1-sol` | `magpie / group/architect` | **已变** |
> | explorer | （本文未测） | `corp / Qwen3.8-Flash` | 本文未覆盖 |
> | implementer | `corp / DeepSeek-V4.1-Flash-1017` | `corp / DeepSeek-V4.1-Flash-1017` | 不变 |
> | reviewer | `corp / GLM-5.3-Flash` | `corp / GLM-5.3-Flash` | 不变 |
> | challenger | （本文未测） | `magpie / group/challenger` | 本文未覆盖 |
> | validator | `magpie / auto/mimo-v2.6-flash` | `magpie / group/validator` | **已变** |
>
> 只有 architect 与 validator 两个角色变了；implementer 与 reviewer 至今仍是同一路由。
> 本文只测了 4 个角色（architect/implementer/reviewer/validator），explorer 与 challenger
> 当时未测，因此没有历史值可对照。
>
> ### 本文的“承载方式 ①”结论已被推翻
>
> 文末第 1 条写“**承载方式 ① 有效**：Lead 完全从 persona 角色表取到 4 个路由”。
> 当时 Lead 确实按 persona 表**手动传参**取得路由；**这个机制现在已经不存在**：
> `spawn_teammate` 只接受 `role/task/context/slot/description`，没有 provider/model/`agent_options` 参数。
> 现在的路由由 Host 配置 `agent-team.presetRoles` 在 spawn 时固定下发，Lead 无法也不需选择。
> 换句话说：4/4 匹配这个**结果**依然成立且更强（不再依赖 Lead 是否照表填写），
> 但达成它的**机制**已经从“persona 提示 + Lead 传参”换成“配置表 + 服务端注入”。
>
> ### 仍然完全成立的部分
>
> - 方法：读子会话 `request/header` 是本项目验证路由的标准做法，未变。
> - **“没有任何角色继承了 Lead 的 `auto/deepseek-v4.1-flash`”至今成立**，且现在由
>   `tests/integration/composition-suite.mjs` 的 `routes` 组自动守护（逐 preset 比对角
>   色表、persona 文本，并检查未配置 preset 时回落到基表）。
> - 任务板 DAG（`blocked_by` 串联）有效，未变。
> - `maxTokens` 观测（architect `128000`、validator `131072`、corp 模型为 `-`）是当时的实测值，
>   其中 architect/validator 已换模型，这两个数字不再适用于当前路由。

会话：`session-803c9d74-ffb4-43ef-8bee-fccd7874e014`（`ai-compiler` 预设，真实 Web Host）

## 方法

不采信 Lead 的自述，也不采信 roster 字段；**直接读取每个子会话自己的持久化
`request/header`**（`ctx.sessionQuery.observeSession()`），即真正发给 provider 的请求头。

## 结果：4/4 匹配

| 角色 | persona 角色表要求 | 子会话自己的 `request/header` | 结果 |
|---|---|---|---|
| architect | `magpie` / `codex/gpt-6.1-sol` | `magpie/codex/gpt-6.1-sol` | ✅ |
| implementer | `corp` / `DeepSeek-V4.1-Flash-1017` | `corp/DeepSeek-V4.1-Flash-1017` | ✅ |
| reviewer | `corp` / `GLM-5.3-Flash` | `corp/GLM-5.3-Flash` | ✅ |
| validator | `magpie` / `auto/mimo-v2.6-flash` | `magpie/auto/mimo-v2.6-flash` | ✅ |

`maxTokens` 观测：architect `128000`（模型声明值，自动带入）、validator `131072`
（`mimo` 的声明值）、implementer/reviewer 为 `-`（corp 模型未声明，按约定不设）。
**没有任何角色继承了 Lead 的 `auto/deepseek-v4.1-flash`。**

## 子会话 ID（可复查）

```
611e585f-7866-4157-afc2-882d7b1fe2a9  -> magpie/auto/mimo-v2.6-flash   (validator)
f8139d16-3aea-457c-a6fb-b9c7967c6975  -> corp/GLM-5.3-Flash             (reviewer)
d1ca4175-753e-4553-8125-21f8427c7fcb  -> corp/DeepSeek-V4.1-Flash-1017  (implementer)
385f01be-7f31-4882-aaf7-31033234c37e  -> magpie/codex/gpt-6.1-sol      (architect)
所有父会话: session-803c9d74-ffb4-43ef-8bee-fccd7874e014
```

## 同时验证的两件事

1. **承载方式 ① 有效**：Lead 完全从 persona 角色表取到 4 个路由，没有额外指令。
2. **任务板 DAG 有效**：design → implement → review → verify 四任务按 `blocked_by` 串联。
