# 角色路由：live 验证结果（2026-10-27 17:2x）

## 结论：路由真实生效，且持久化到 descriptor

从两个子会话**自己的持久化日志**读出的真相（不是父视角、不是 UI 字段）：

```
5b0770b1 | route: corp/Qwen3.8-Flash          | descriptor: corp/Qwen3.8-Flash
6152923e | route: magpie/codex/gpt-6.1-sol    | maxTokens: 128000 | descriptor: magpie/codex/gpt-6.1-sol
```

`subagent/descriptor` 里也写入了 `agentProvider/agentModel`，所以**冷恢复会还原同一路由**
（`descriptor.ts:77-107`、`manager.ts:1369-1374`）。

## 三个曾经造成误判的陷阱（都已修/已澄清）

| 现象 | 真相 | 处置 |
|---|---|---|
| 模型报告「`agent_options` 未生效，roster 显示 lead 的模型」 | 那是**旧 Host 进程**（重启前启动，加载旧 `lib/`），新代码从未运行 | 重启 Host 后消失 |
| 修好之后 roster 显示 `model: null` | 这是我修掉的一个**真实显示缺陷**：`list()` 在成员不 live 时回退到 `root.options.model`，把 Lead 的模型当成成员的 | 已改为 `live?.options.model`，未知就留空（`roster.ts:137-143`） |
| `member.provider` 显示 `"spawn"` 而不是 `"magpie"`/`"corp"` | **设计如此**：`provider` 字段表示**后端**（spawn/fork），不是模型 provider；模型 provider 在 `model`/descriptor 里 | 文档说明，不改 |

## model 字段的可见时机

| 时机 | 是否可见 | 来源 |
|---|---|---|
| spawn 返回时（成员 running） | ✅ 可见、且是**成员自己的** | `spawnTeammate` 返回的 live member view |
| 成员 inactive（已完成/未加载） | ⬜ 显示 null | 不猜；真相在子会话 descriptor |
| 重启后 | ⬜ null，但 descriptor 有，冷恢复会还原 | `subagent/descriptor` 事件 |

> 若要在 roster 里**始终**显示成员路由，需要把 model 写进 `team/member` 事件
> （目前只有 `provider`/`context`）。这是一个可选增强，本次未做——因为那会改动
> Team 的持久化事件 schema，属于实验性 API 的更进一步侵入。
