# 真实现场证据：用户会话 `session-b4aa3158` 的名额耗尽

> 来源：`/home/<user>/.dsh/sessions/--home-<user>-workspace-ForgeKernel--/session-b4aa3158-3a90-427c-8cc8-39fc612df673/session.v4.jsonl.zstd`
> 解压后 5999 条事件；按 `team/member` 事件与 `TEAM_MEMBER_LIMIT` 错误码直接统计。
> 该会话工作目录为 `~/workspace/ForgeKernel`，不在本仓库 workspace 内，因此通过直接读取会话日志取证（只读）。

## 1. 一句话结论

**这不是"用错了"，是机制缺口**：8 个队友全部创建成功且全部为 `active`（没有任何 `failed`），
名额在第 8 个之后立刻耗尽；此后会话中段和末段共 4 次 `spawn_teammate` 被
`TeamError / TEAM_MEMBER_LIMIT: Team member limit 8 reached` 拒绝，
而 9 个 Team 工具里没有任何一个能释放名额。

## 2. 名册实际演化（`team/member` 事件，共 16 条 = 8 成员 × 2 次边沿）

| 顺序 | 成员名 | provisioning seq | active seq | 终态 |
|---|---|---|---|---|
| 1 | `devkit-reg-explorer` | 358 | 360 | active |
| 2 | `devkit-mem-explorer` | 363 | 365 | active |
| 3 | `implementer-v33` | 1630 | 1632 | active |
| 4 | `doc-writer` | 2200 | 2202 | active |
| 5 | `archivist` | 2432 | 2434 | active |
| 6 | `ledger-builder` | 2893 | 2895 | active |
| 7 | `trajectory-writer` | 2903 | 2905 | active |
| 8 | `tla-auditor` | 3750 | 3752 | active |

- 上限来自 `config/bundle-ai-compiler/bundles.patch.yml:69` 的 `maxMembers: 8`。
- **0 个 `failed` 成员**：名额不是被失败记录吃掉的，是被"正常用完"吃掉的。
  也就是说即使把失败回收做了，这个现场依然会撞墙。
- 第 8 个成员 `active` 于 seq 3752，**4 个事件之后**（seq 3756）就出现了拒绝。

## 3. 拒绝记录（`isError: true` 的 `spawn_teammate` dispatch）

| seq | 错误 |
|---|---|
| 3756 | `TeamError { code: "TEAM_MEMBER_LIMIT" }` — `Team member limit 8 reached` |
| 3757 | 同上（同一次 `run_code` 内的第二个 spawn） |
| 5584 | 同上（会话末段，**1800+ 事件之后**依然满员） |
| 5593 | 同上 |

时间跨度说明：从中段（3756）到末段（5593），名册从未回落一个名额。

## 4. 用户实际尝试过的"清理"，以及为什么无效

| 尝试 | 现场证据 | 结果 |
|---|---|---|
| `interrupt_agent` | seq 4418 `interrupt_agent({target:"tla-auditor"})` → `{"previousStatus":"running"}` | 只中断当轮 turn，**不删 roster 条目、不释放名额** |
| 让成员 `inactive` | seq 5057 compaction 摘要记录 `tla-auditor` 跑 ~40 分钟无输出、被中断 | `phase` 仍是 `active`，名额仍占用 |
| 任务板操作 | 19 次 `team_task_update`（release/reassign/delete 等） | 任务归属与名额完全无关 |
| 大量 `list_agents` | 182 次 | 只能"看到"满员，无法改变 |

`interrupt_agent` 与 `stopTeammates` 走的是 `subagents.drainChildren()`（`agent-team/src/roster.ts:229-231`），
语义是**停运行时子会话**，而不是**从名册移除记录**。这正是用户"想清理却找不到清理机制"的直接原因。

## 5. 用户自己的诊断（会话内，seq 5826 起的 assistant 消息）

原会话在受限工具面下已经独立得出同一结论：

- 11 个工具中没有任何删除/移除队友的工具；
- `TeamRoster` 公开方法只有 `spawn` / `recoverFor` / `stopTeammates`，`stopTeammates` 只 drain；
- `TeamMemberPhase` 只有 `provisioning | active | failed`。

本文档把该结论升级为**带真实现场数据的证据**，并交由 T1/T2 从源码与可重复实测两侧补全，
由 T3 给出方案、T4 给出最小补丁。

## 6. 对方案的硬约束（由本现场推导）

1. 只回收 `failed` 成员**不足以**解决本现场（0 个 failed）；必须让 `active` 成员也能主动退役。
2. 退役必须是**用户/Lead 可显式触发**的动作（自动回收会误杀正在长跑的成员，例如
   `tla-auditor` 曾连续运行 ~40 分钟）。
3. 退役必须与运行时解耦：`tla-auditor` 在 `running` 时被 interrupt 过，
   所以退役流程要能安全处理 "running / inactive / 未加载" 三种状态。
4. 若不修改 DSH 源码，唯一的即时缓解是 **新开会话**（`TeamId == root SessionId`，
   新会话即新 Team、新名册）；其次是调大 `maxMembers`，但那只是推迟撞墙。
