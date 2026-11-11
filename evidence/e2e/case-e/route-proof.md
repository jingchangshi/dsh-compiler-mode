# Case E — 第二个预设（ai-compiler-magpie）角色路由验证

> ## ⚠️ 历史记录（测量于 2026-10-27，早于 2026-11-11 的 per-preset 路由改造）
>
> **本文是真实的历史测量，数值一律保持原样、未做修改。** 但其中的路由取值与 preset order
> 都已被后续改动取代。**请不要把本文当作当前行为**：当前真实路由见
> `docs/design/role-config-final.md`、`docs/09-operations.md` 的表格，以及
> `config/bundle-ai-compiler/bundles.patch.yml` 中 `agent-team.presetRoles` 的 `ai-compiler-magpie` 表。
>
> ### 1) 路由取值：旧 → 新（`ai-compiler-magpie` 预设）
>
> | 角色 | 本文记录的旧路由（历史，真实测量） | 当前真实路由 |
> |---|---|---|
> | architect | `magpie / codex/gpt-6.1-sol` | `magpie / group/architect` |
> | explorer | （本文未测） | `magpie / group/explorer` |
> | implementer | `magpie / auto/deepseek-v4.1-flash` | `magpie / group/implementer` |
> | reviewer | `magpie / auto/glm-5.3-flash` | `magpie / group/reviewer` |
> | challenger | （本文未测） | `magpie / group/challenger` |
> | validator | `magpie / auto/qwen3.8-flash` | `magpie / group/validator` |
>
> 注意 `auto/qwen3.8-flash` 与 `group/qwen-3.8-flash` 是两个不同的 id；本文记录的旧 id 已不再被
> `ai-compiler-magpie` 表使用。**provider（`magpie`）在改造前后不变**——变的是 model 部分。
>
> ### 2) 预设顺序：本文的 order 数字已过时
>
> 本文写 `ai-compiler` 为 **order 3**、`ai-compiler-magpie` 为 **order 4**。
> **当前实际是 order 5 和 order 6**（`config/bundle-ai-compiler/cordis.patch.yml` 中 `preset-ai-compiler` / `preset-ai-compiler-magpie` 两行）。
> 下面的表格保留原值以维持测量记录的真实性，阅读时请按此说明换算。
>
> ### 3) 仍然成立的部分
>
> - 方法有效：直接读子会话自己的 `request/header`，不采信 Lead 自述与 roster 字段——
>   这一点至今是本项目验证路由的标准做法。
> - **“所有角色都在 magpie 上、没有任何角色回退到 Lead 的路由”这个结论今天依然成立**，
>   只是具体 model id 换了（见上表）。
> - 两个预设可切换、共享同一份插件树、差异只在 persona 角色表——**这一点已被后续改造推翻**：
>   现在两个预设的差异还包括 `agent-team.presetRoles` 里各自完整的角色表，
>   即差异不再“只在 persona”。persona 只是文档，真正生效的是配置表。

Lead 会话：`session`（`ai-compiler-magpie`，order 4）
方法同 Case D：**直接解压并读取每个子会话自己的 `request/header`**（`zstd -dc` 后解析 JSONL），
不采信 Lead 的自述，也不采信 roster 字段。

## 结果：4/4 匹配

| 角色 | 角色表要求 | 子会话 `request/header` | 结果 |
|---|---|---|---|
| architect | magpie / `codex/gpt-6.1-sol` | `magpie/codex/gpt-6.1-sol` | ✅ |
| implementer | magpie / `auto/deepseek-v4.1-flash` | `magpie/auto/deepseek-v4.1-flash` | ✅ |
| reviewer | magpie / `auto/glm-5.3-flash` | `magpie/auto/glm-5.3-flash` | ✅ |
| validator | magpie / `auto/qwen3.8-flash` | `magpie/auto/qwen3.8-flash` | ✅ |

子会话 ID 前缀（可复查）：`01cebb36`(architect)、`4bcc7ea0`(implementer)、
`c741a8fd`(reviewer)、`e79930ab`(validator)。

**没有任何角色回退到 Lead 的 `auto/deepseek-v4.1-flash`。** 全 magpie 路由成立。

## 两个预设均可切换

| 预设 | id | order | 选择结果 |
|---|---|---|---|
| AI Compiler Engineering | `ai-compiler` | 3 | 会话头 `agentPreset: "ai-compiler"`，回答 PRESET_OK |
| AI Compiler Engineering (all-magpie fleet) | `ai-compiler-magpie` | 4 | 会话头 `agentPreset: "ai-compiler-magpie"`，回答 PRESET_OK |

两者共享同一份 23 项插件树（`plugins` 列表逐项相同），差异只在 persona 角色表。
