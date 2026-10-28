# 用 AI Compiler Mode 做 AscendNPU-IR 与 TileLang HIVM 开发

本文说明安装完成后，**日常开发循环**怎么走。所有 Gate 都在独立 systemd 单元里
异步执行，因此提交后可以继续做别的事，也可以让多个 Agent 并行。

---

## 0. 进入模式

新建会话 → 选择 **AI Compiler Engineering**（或 *all-magpie* 版本）→ 得到 10 个
`mcp__agentgates__*` 工具。用 `run_code` 调用它们（PTC 模式）。

```ts
// 确认机器与 workspace 状态
const ws = await tools.mcp__agentgates__list_workspaces({})
const gates = await tools.mcp__agentgates__list_gates({
  workspace: "tilelang", adapter: "tilelang-hivm"
})
```

常见错误：在 **Standard / Creator** 模式下找不到这些工具——那是设计如此，
AgentGates 只在这两个 compiler preset 内可见。

---

## 1. AscendNPU-IR 开发循环

**改什么**：`workspaces.ascendnpu-ir.source_root` 指向的那棵源码树
（见 `~/.config/agent-gates/config.toml`；本机是 `~/workspace/AscendNPU-IR`）。
路径只写在机器配置里，Gate 的工具输入没有「源码目录」这个字段。

### 两个 Gate

| Gate | 实际动作 | 典型耗时 |
|---|---|---|
| `ascend-build` | 容器内 `ninja` 增量构建 `bishengir-opt` / `bishengir-compile` + 发布产物 | 0.8 s（已构建）/ 2–6 min（触发 CMake reconfigure）|
| `ascend-regression` | `check-bishengir`：lit 全量，1142 个测试，256 并发 | **2.7 s**（实测）|

`ascend-regression` 依赖 `ascend-build`，提交后者会自动带上前者，无需手动列两个。

### 循环

```ts
// 1. 改代码（用 fs 工具正常编辑即可）
// 2. 提交构建 + 回归
const s = await tools.mcp__agentgates__submit({
  workspace: "ascendnpu-ir",
  adapter: "ascendnpu-ir",
  gates: ["ascend-regression"],
  request_id: "ascend-" + Date.now(),   // 每次改动用新 id
})

// 3. 有界等待（单次最多 60 s，可重复调用）
let out = await tools.mcp__agentgates__wait({
  execution_id: s.structured_content.execution_id,
  timeout_seconds: 45,
})

// 4. 看结论
if (out.structured_content.status.run_id) {
  const rep = await tools.mcp__agentgates__report({
    run_id: out.structured_content.status.run_id,
  })
  // rep.structured_content.gates[*].status -> PASS / FAIL / BLOCKED_ENV ...
}
```

**关键**：`execution` 变成 `FINISHED` **不等于** Gate PASS。判断结论只看
`gate_status` / `gates[*].status`。

### 读结论

| 状态 | 含义 | 你该做什么 |
|---|---|---|
| `PASS` | 构建成功、1142 个 lit 测试 0 失败 | 继续 |
| `FAIL` | 真的失败了 | 看 `report.gates[*].failures`，或读证据目录下的 stdout.log |
| `BLOCKED_ENV` | 环境问题，测试**没跑** | 看 `configReason`：容器没起、配置缺键、驱动读不到 |
| `STALE` | 跑过 PASS，但之后源码/产物又变了 | 重新提交——这是**正确**行为，历史 PASS 不能用于当前源码 |

---

## 2. TileLang HIVM 后端开发循环

**改什么**：`workspaces.tilelang.source_root` 指向的那棵源码树
（见 `~/.config/agent-gates/config.toml`；本机是 `~/workspace/tilelang`）。

### 三个 Gate

| Gate | 实际动作 | 典型耗时 |
|---|---|---|
| `tilelang-hivm-build` | 容器内 `ninja` 构建 `libtilelang.so` | 1–3 min（增量多为 no-op）|
| `tilelang-hivm-regression` | 2 个 JUnit 回归文件，14 个测试，断言原生库哈希与宿主一致 | 2–5 min |
| `tilelang-hivm-npu-sanity` | 真机：编译 vecadd 内核 + 数值比对 + 设备同步 | 9 s（实测）|

回归 Gate 的断言比「测试通过」严格得多，它同时检查：

- `importedModuleSha256MatchesHost` —— 容器里 import 的模块就是宿主构建的那份
- `loadedNativeSha256MatchesHost` —— 实际加载的 `.so` 与宿主文件逐字节一致
- `testsCollected > 0` 且 `notAllSkipped` —— 防止「零测试也算通过」

### 循环

```ts
const s = await tools.mcp__agentgates__submit({
  workspace: "tilelang",
  adapter: "tilelang-hivm",
  gates: ["tilelang-hivm-regression"],   // 自动带上 build
  request_id: "tl-" + Date.now(),
})
```

### 涉及设备时

```ts
const s = await tools.mcp__agentgates__submit({
  workspace: "tilelang",
  adapter: "tilelang-hivm-npu",
  gates: ["tilelang-hivm-npu-sanity"],
  request_id: "npu-" + Date.now(),
})
```

设备**由本地配置决定**，工具调用不能指定。默认全部卡可用、选择设备 0、
允许与他人共享。配置检查会输出 `occupancy=shared(n)`，据此判断卡的实际负载。

若这次运行对时序/显存敏感，在 `~/.config/agent-gates/config.toml` 里：

```toml
[devices]
require_exclusive_device = true    # 被占用时报 BLOCKED_ENV，而不是给出可能失真的结论
```

---

## 3. 用 Agent Teams 并行推进

典型分工（写作用域互不重叠才安全）：

```
Lead        : 拆任务、评审、跑最终 Gate
implementer : 改代码（唯一动文件的人）
validator   : 提交 Gate、把 Run ID 回传
```

顺序建议：

1. Lead 建任务，写 `write_scopes`。
2. implementer 改代码 → 完成后**不**自己宣称通过。
3. validator `submit` 两个 Gate（build + regression），把 `execution_id` 记到任务里。
4. 等待期间 Lead 可以做别的事（异步 Worker 不占用会话）。
5. validator 把 `run_id` 发给 Lead。
6. Lead 独立执行 `verify_requirements` 复核——**不要**只信消息里的结论。

让任务带强制门禁（这样没人能「口头完成」）：

```ts
// 建任务时声明要求
team_task_create({
  subject: "修复 HIVM tail 对齐",
  description: "...",
  requirements: [{
    key: "gate",
    kind: "agentgates",
    payload: {
      workspace: "tilelang",
      adapter: "tilelang-hivm",
      required_gates: ["tilelang-hivm-build", "tilelang-hivm-regression"],
    },
  }],
})

// 完成时必须附证据（run id），否则被拒
team_task_update({
  task_id: "task-12",
  expected_revision: 3,
  action: "complete",
  evidence: [{ key: "gate", reference: "<run_id>" }],
})
```

没有声明 `requirements` 的任务行为完全不变。

---

## 4. 常见陷阱

**改完源码立刻用旧 Run ID 完成任务** → 会被拒绝（`SOURCE_IDENTITY_MISMATCH` /
`STALE`）。这是设计目标，不是 bug：PASS 只对产生它的那棵代码树有效。

**把 `FINISHED` 当成通过** → 最常见的误判。`FINISHED` 只说明 Worker 停了。

**同一 workspace 并发提交** → 第二个会得到 `RESOURCE_BUSY`（源码/构建目录 flock）。
这是有意的：两个构建同时改一个 build 目录会互相破坏。等前一个结束再提。

**`request_id` 重复使用** → 相同请求返回原 execution（幂等），不同请求报
`CONFLICT`。每次改动请用新的 request id。

**`ascend-regression` 超时** → 已实测全量 1142 个测试仅 2.7 s（256 并发），
内层超时 1140 s 充裕。若真的超时，几乎一定是构建阶段卡住，看 `ascend-build` 的日志。

---

## 5. 相关文档

| 文档 | 内容 |
|---|---|
| `AgentGates/docs/v2/env-sh-guide.md` | 本机 `env.sh` 与单元环境变量怎么配 |
| `AgentGates/docs/v2/execution-state-machine.md` | 状态机与 Gate 判定语义 |
| `AgentGates/docs/v2/mcp-api-schema.md` | 10 个工具的输入输出 |
| `AgentGates/docs/v2/install-and-recovery.md` | 安装、卸载、故障诊断 |
