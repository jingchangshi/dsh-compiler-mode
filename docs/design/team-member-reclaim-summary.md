> **已被取代（历史）**：本文档描述旧的动态回收方案；现行实现为「角色一等契约 + 4 保留槽/4 弹性槽」，见 `patches/0002-team-roles-slots.patch` 与 `docs/03-decisions.md` 的 ADR-013。

# Agent Team 队友名额不可回收：根因与解决方案（总览）

> 任务：长程会话中多次创建队友后撞上 `maxMembers` 上限，同一会话后续任务再也无法创建队友；且系统**没有任何清理/移除队友的机制**。
> 本目录为 Agent Team 分工产出的完整分析（1 名 Lead + 4 名队友，共享任务板 T1–T4 全部 completed）。

## 一句话结论

**名额语义是"该 Team 一生累计创建过的成员条数"，而不是"当前占用/并发席位"；而这个累计数只增不减——没有任何事件、服务方法或工具能让它回落。**
所以长程会话只要持续"每任务 spawn 一个新名字的队友"，就必然在累计 N 条后**永久**撞墙。

- 默认 `maxMembers = 16`（`agent-team/src/index.ts:58`）；本项目 bundle 设为 **8**（`config/bundle-ai-compiler/bundles.patch.yml:69`）。
- 这是**与文档一致的设计选择**（README："Maximum teammates a team may ever create, including failed ones"），不是实现 bug；但它与"长程任务反复新建队友"的用法直接冲突。

## 现场证据（最重要）

用户真实会话 `session-b4aa3158`（解压 5999 条事件）：
- 8 个队友**全部创建成功且全部 `active`，0 个 `failed`** → 名额不是被失败吃掉的，是被"正常用完"吃掉的；
- 第 8 个 `active` 后 4 个事件即出现 `TeamError / TEAM_MEMBER_LIMIT: Team member limit 8 reached`，会话中段到末段共 4 次被拒，名册从未回落；
- 用户试过 3 次 `interrupt_agent`，无效（只中断回合，不释放名额）。
→ 详见 [`evidence/design/team-member-reclaim-real-session.md`](../../evidence/design/team-member-reclaim-real-session.md)。
→ **推论：只回收 `failed` 成员不足以解决问题，必须让 `active` 成员也能显式退役。**

## 根因（源码）

唯一闸门：`roster.ts:262` `if (state.members.length >= this.maxMembers) throw TEAM_MEMBER_LIMIT`。
- `TeamState.members` 是只增集合：Team 事件域只有 4 种、无删除型（`projection.ts:209-213`），`team/member` 全仓仅 3 个写点、均写整条快照，投影只做 replace-or-push（`projection.ts:279-306`）；
- 三个 phase（`provisioning|active|failed`）全部占名额；`provisioning` 在子会话启动**之前**就落盘，故任何创建失败都留永久 `failed` 占位；
- 成员状态机只允许 `provisioning → active|failed`，没有退役迁移；
- 9 个 tool 与 12 个服务公有方法里，**没有任何 retire/remove**；`interrupt` 不写 journal，`stopTeammates/drainChildren` 只释放运行时句柄、不改名册（"停掉" ≠ "释放名额"）；
- 重启同一会话会从 Lead Session 日志重放同一名册，仍是满额；调大 `maxMembers` 只是把墙推远。
→ 完整证据表：[`docs/design/team-member-reclaim-rootcause.md`](team-member-reclaim-rootcause.md)。

## 实测复现

真实 `runProfile` 探针（overlay 把 `maxMembers` 压到 2）：第 1、2 次 spawn 成功，第 3 次 `TEAM_MEMBER_LIMIT`。
5 种"清理"尝试（等全员 inactive、interrupt 空闲成员、任务 claim/release/delete、send_message 唤醒后再等 idle、`ctx.subagents.drainChildren`）**全部 rosterSize 不变**，后续 spawn 仍被拒。失败 1 次（`NO_PROVIDER`）+ 成功 1 次即打满名额。
→ 脚本 [`tests/design/member-reclaim-probe.mjs`](../../tests/design/member-reclaim-probe.mjs) · 证据 [`evidence/design/member-reclaim-probe.json`](../../evidence/design/member-reclaim-probe.json)。

## 解决方案（推荐）

### P0 — 立即缓解（零代码，今天就能用）
- **P0-a（首推）用法修正：把 teammates 当固定岗位，用 `send_message` 派活。**
  一次建好一小组稳定角色（如 explorer / implementer / reviewer / archivist），之后每轮都复用、不新建名字 → **完全不消耗新名额，且不丢上下文**。用户自己的 `docs/design/role-model-routing.md` 正是 7 固定角色的设计。用户现场那种"每任务 spawn 一个新名字"（devkit-reg-explorer / doc-writer / ledger-builder…）才是反模式。
- **P0-b** 调大 `maxMembers`（8 → 64）：只推迟撞墙，不解决。
- **P0-c** 新开会话：`TeamId == root SessionId`，新会话即新名册；但丢失长程上下文。

> 结论句：**长程任务应当把 teammates 当固定岗位、用消息派活；`retire` 是纠错与止损，不是日常流转手段。**

### P1 — 最小可用（核心回收能力，已出补丁）
新增 `retired` 墓碑终态 + 名额改为"只数非 retired" + 新 `retire_teammate` 工具 + `stateVersion 4→5`。
它解决的是 P0-a 无法覆盖的三类真实残留：**建错名字**（名字 immutable，改不了只能退役）、**角色阶段性用完**、**失败占位**。
→ 方案对比（A–F 六方案）+ 六条设计决策：[`docs/design/team-member-reclaim-solution.md`](team-member-reclaim-solution.md)。

### P2 — 完整
把"并发上限"与"生命周期总量"拆成两个配置（`maxMembers` = 并发，另设 `maxMemberLifetime`）；可选自动回收策略。

## 已产出补丁（可直接 apply，未改基线）

[`patches/0002-team-member-reclaim.patch`](../../patches/0002-team-member-reclaim.patch) — 11 files, +283/−23，applies to `296181d1c2`：
- `retired` 终态；`active|failed → retired`，retired 为吸收态；名额只统计非 retired；
- `retire()`：Lead-only、running 拒绝（`TEAM_MEMBER_RUNNING`）、provisioning 拒绝、**先 drain 子会话再写墓碑**、重复调用幂等、**名字永久保留**（只回收位子不回收名字）；
- `team/member` 事件版本 `2|3`（退役边写 3，旧边字节不变）；投影 `stateVersion 4→5`；retired 墓碑保留在客户端视图（UI 灰显/不可点开）；
- 新增 `retire_teammate` 工具 + 策略文案；`TeamMemberView['status']`、`MEMBER_VIEW_SCHEMA.status` 增 `'retired'`。

### 独立复核（Lead 亲自跑）
- `git apply --check` 打真实基线 → **exit 0**（11 个 Checking patch，无 error）；基线工作树 `git status` 干净。
- 在 `/tmp` 副本复跑三包测试 → **7 files / 173 tests passed**。
- 三包 `tsc -b` → **clean（exit 0）**。
→ 验证记录与风险：[`evidence/design/member-reclaim-spike.md`](../../evidence/design/member-reclaim-spike.md)。

## 剩余风险（未验证）

1. **未做真实 Host build/boot**：`lib/` 未重建、未在真实会话跑"接近满员 → retire → 再 spawn"的端到端闭环（需 `tsc -b tsconfig.host.json` + `tsdown --env.DSH_BUILD_FACE host` + 重启）。
2. `stateVersion 4→5` 会让升级后每个会话首次加载多一次全量 refold（一次性成本）。
3. 事件版本降级是单向的：旧二进制读 v3 事件会得到明确的 projection failure（不会静默错读）。
4. 名字永久保留 ⇒ 长会话反复退役会累积 `retired` 墓碑（只受会话体积约束），这是"名字不复用"的既定取舍。

## 文件索引

| 类别 | 文件 |
|---|---|
| 根因（源码审计） | [`docs/design/team-member-reclaim-rootcause.md`](team-member-reclaim-rootcause.md) |
| 方案（A–F 对比与推荐） | [`docs/design/team-member-reclaim-solution.md`](team-member-reclaim-solution.md) |
| 真实会话现场证据 | [`evidence/design/team-member-reclaim-real-session.md`](../../evidence/design/team-member-reclaim-real-session.md) |
| 可重复实测探针 | [`tests/design/member-reclaim-probe.mjs`](../../tests/design/member-reclaim-probe.mjs) · [`evidence/design/member-reclaim-probe.json`](../../evidence/design/member-reclaim-probe.json) |
| 最小补丁 | [`patches/0002-team-member-reclaim.patch`](../../patches/0002-team-member-reclaim.patch) · [`patches/README.md`](../../patches/README.md) |
| 补丁验证记录 | [`evidence/design/member-reclaim-spike.md`](../../evidence/design/member-reclaim-spike.md) |
