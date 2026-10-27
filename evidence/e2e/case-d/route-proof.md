# Case D — 角色路由独立验证

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
