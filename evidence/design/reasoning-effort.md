# reasoningEffort 实测与启用

## 启用前的状态

6 个角色模型 `llm.resolveModelInfo().reasoning` **全部为 null**，任何显式 effort 都被
`UNSUPPORTED_REASONING_EFFORT` 拒绝（`packages/llm/llm/src/index.ts:915-923`）。

## 启用步骤（已执行）

1. 在 profile 的 `llm-pi-ai.providers.magpie.models` 中给 5 个模型加声明：

```yaml
reasoningEfforts:
  low: low
  medium: medium
  high: high
```

涉及模型：`auto/deepseek-v4.1-flash`、`codex/gpt-6.1-sol`、`auto/mimo-v2.6-flash`、
`auto/glm-5.3-flash`、`auto/qwen3.8-flash`。
改动方式：**用 YAML AST 编辑**，保留全部注释与格式；diff 只有 5 个新增块，无其他改动。
备份：`evidence/backup/profile-pre-effort-20261027-174123.yml`。

2. 补 Core 工具参数（原先 `agent_options` 是 `additionalProperties: false`，
   `reasoningEffort` 会被拒绝）：

```ts
reasoningEffort: { type: 'string', description: '…' }
```

刻意**不写 enum**：档位名来自模型目录，随 profile 变化；写死会在目录升级后失效。
未知档位由运行时以 `UNSUPPORTED_REASONING_EFFORT` 拒绝，这是诚实的行为。

## 实测结果

| 检查 | 结果 |
|---|---|
| 声明被解析 | `resolveModelInfo().reasoning.efforts` = `[low, medium, high]` ✅ |
| 三个档位真实调用 | `low`/`medium`/`high` 全部 `stopReason: completed` ✅ |
| 端到端到 provider 请求头 | 子会话 `request/header.config.reasoningEffort = "high"` ✅ |
| 未声明 effort 的模型 | 仍拒绝，行为不变 ✅ |
| 单元测试 | 新增 1 条（透传 effort），110/110 通过 ✅ |

## 未声明的模型

`claude/claude-opus-5-5` 等未加声明的模型保持 `reasoning: null` —— 对它们传 effort
仍然报错，这是正确的：不是所有模型都支持思考档位。

## 待确认

`low/medium/high` 映射到 `low/medium/high` 是**按字面**的假设。若某家 API 的 wire 值不同
（如 `high` 应写作 `xhigh`），需要按该提供商文档调整。本次三个档位调用均成功，
说明 magpie 路由接受这组字面值。
