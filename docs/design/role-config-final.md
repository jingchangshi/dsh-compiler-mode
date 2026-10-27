# 角色模型配置（定稿，2026-10-27）

依据实验（`evidence/design/experiment-results.md`）与实机验证（`evidence/e2e/case-d/route-proof.md`）。

## 定稿表

| 角色 | provider | model | maxTokens |
|---|---|---|---|
| lead | magpie | `auto/deepseek-v4.1-flash` | 继承（393216） |
| architect | magpie | `codex/gpt-6.1-sol` | 省略（声明值 128000 自动生效） |
| explorer | corp | `Qwen3.8-Flash` | 省略 |
| implementer | corp | `DeepSeek-V4.1-Flash-1017` | 省略 |
| reviewer | corp | `GLM-5.3-Flash` | 省略 |
| challenger | magpie | `codex/gpt-6.1-sol` | 省略 |
| validator | magpie | `auto/mimo-v2.6-flash` | 省略（声明值 131072 自动生效） |

- **reasoningEffort 全部不设**：6 个模型 `reasoning` 均为 `null`，任何显式 effort 会被
  `UNSUPPORTED_REASONING_EFFORT` 拒绝（实验 1）。
- **maxTokens 全部省略**：框架不校验上限（实验 2），省略即用 provider 声明值，最安全。
- 成员上限 8（不含 Lead），7 角色方案余量 1。

## 承载方式

写进 `config/bundle-ai-compiler/cordis.patch.yml` 的 `persona.prefix`（承载方式 ①），
含角色表 + tier 选择 + "只有 implementer 写文件" + "用 blocked_by 表达顺序"。
`tests/preset/verify-preset.mjs` 将其作为已声明差异（persona）门禁。

## 实机验证结论

4/4 角色路由与 persona 表一致，且**没有任何角色回退到 Lead 的模型**
（逐个子会话 `request/header` 核对，见 `evidence/e2e/case-d/route-proof.md`）。

## 已知限制（不是缺陷）

- `member.model` 只在成员 live 时可见；inactive 时 roster 显示 null。
  真相在子会话的 `subagent/descriptor` / `request/header`。
- `member.provider` 恒为 `spawn`/`fork`（后端名），不是模型 provider 名。
- `reasoningEffort` 若要可用，需在 profile 里给模型声明 `reasoningEfforts`
  （改用户模型配置，未授权，未做）。
