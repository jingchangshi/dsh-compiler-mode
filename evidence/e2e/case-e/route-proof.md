# Case E — 第二个预设（ai-compiler-magpie）角色路由验证

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
