> **已被取代（历史）**：本文档描述旧的动态回收方案；现行实现为「角色一等契约 + 4 保留槽/4 弹性槽」，见 `patches/0002-team-roles-slots.patch` 与 `docs/03-decisions.md` 的 ADR-013。

# Agent Team 队友名额回收：候选机制、权衡与分阶段推荐路线（T3）

- 上游事实基础：`docs/design/team-member-reclaim-rootcause.md`（T1 源码审计，9 张证据表）、`evidence/design/team-member-reclaim-real-session.md`（真实会话 `session-b4aa3158`）、`evidence/design/member-reclaim-probe.json` + `tests/design/member-reclaim-probe.mjs`（T2 可重复实测）。
- 审计对象 commit：`296181d1c2`。本文件为**只读分析 + 方案设计**，未改动 `deepseek-harness` 下任何文件。
- 本文目标：给 T4（补丁 spike）一份**可直接执行的文件级改动清单**，并对每个候选机制给出不变量影响与取舍。

---

## 1. 问题重述与根因

**现象**：长程会话里反复 `spawn_teammate`，撞上 `maxMembers` 后，该会话再也无法创建队友；不存在任何"清理/移除队友"的工具或 API。用户在现场试过 `interrupt_agent` 3 次、`inactive` 等待、任务板增删，全部无效（真实会话 `session-b4aa3158`：8 个成员 **全部 `active`、0 个 `failed`**，seq 3752 满员，4 次 `TEAM_MEMBER_LIMIT`，从 seq 3756 到 5593 名册一个名额都没回落）。

**一句根因**：**名额是"累计创建数"而非"当前占用数"，且累计创建数只增不减**——判定处只看 `state.members.length`（`roster.ts:262`），而 `members` 是只增投影，没有任何事件能移除成员（`projection.ts:279-284` / `:288-306`）；`inactive` 只是读取时按 live agent 算出的视图字段（`roster.ts:145-153`、`:484-486`），耐久 `phase` 仍是 `active`；`failed` 成员更是永久占位（`roster.ts:286-292`）。因此长程会话每轮"起几个新名字"就必然在累计 N 条后**永久**撞墙。

> 补充定性（来自 T1 §5）：实现与 README 文档自洽（`README.md:51` 明写 "Maximum teammates a team may ever create, including failed ones"），所以这**是模型/语义与用法不匹配**，不是"忘了写 delete 的 bug"。方案必须同时纠正"计数语义"，而不只是补一个删除动作。

### 1.1 用法层根因（同等重要，很多方案会漏掉）

除"计数模型"这一机制层根因外，真实会话还暴露了一条**用法层根因：spawn-per-task 反模式**。现场 8 个队友全是**任务专用名**：`devkit-reg-explorer` / `devkit-mem-explorer` / `implementer-v33` / `doc-writer` / `archivist` / `ledger-builder` / `trajectory-writer` / `tla-auditor`——即"**每个任务 spawn 一个新名字**"。

而 Team 的正确长期用法是"**固定角色名册 + `send_message` 复用**"：名字永久且唯一（`README.md:60`、`roster.ts:259-261`），只要开局建好一小组稳定角色（如 explorer / implementer / reviewer / archivist），之后所有轮次都用 `send_message({ target: "implementer" })` 派活，**根本不会消耗新名额**。用户自己的 `docs/design/role-model-routing.md` 其实已设计了 7 个固定角色，正是这个模型。

两层根因的关系：
- **用法层（spawn-per-task）**：可以从源头避免撞墙——只要不"每任务新建"。
- **机制层（累计只增、无回收）**：一旦已经建错了名字、角色阶段性用完或留下失败占位，就**再也收不回来**，只能靠回收机制。

两者**互补、不可互相替代**：P0-a（改用法）解决"从一开始就不该每任务新建"；P1 的 `retire` 解决"已经建错 / 阶段性用完 / 失败占位"这三类**真实残留**。因为成员身份字段不可变（`projection.ts:299-301`、`roster.ts:444-453`），一旦名字建错**无法改名让位**——只有 `retire` 能回收名额。

> 可直接给用户的一句话结论：**"长程任务应当把 teammates 当固定岗位，用消息派活；retire 是纠错与止损，不是日常流转手段。"**

---

## 2. 候选方案逐个分析

下面 A–F 各自给：**机制（改哪些文件、diff 形状）→ 破坏的不变量 → 兼容与迁移 → 风险成本 → 是否解决真实场景**。

### 方案 A：只对"在用"成员计数（active-only / live-only 配额）

**机制**
- 改动面极小，核心一行在 `agent-team/src/roster.ts:262`：
  ```diff
  - if (state.members.length >= this.maxMembers) {
  + if (state.members.filter(m => m.phase !== 'failed').length >= this.maxMembers) {
  ```
  ——但这只是"排除 failed"，**不解决 8/8 全 active**。
- 若"在用"定义为 live agent（`this.ctx.agents.get(m.id) !== undefined`）：
  ```diff
  - if (state.members.length >= this.maxMembers) {
  + const inUse = state.members.filter(m => this.ctx.agents.get(m.id) !== undefined).length
  + if (inUse >= this.maxMembers) {
  ```
  ——能腾出"未加载/被 drain"成员的名额。

**破坏的不变量**
- `members` 仍是只增集合：durable 行、名字、checkpoint 体积永久膨胀（`projection.ts:164`、`teamProjectionEntrySchema` `:198-206`）。名额与"持久台账长度"脱钩后，台账可无限增长。
- live-only 版本把限额语义改成"当前加载的 Agent 数"，与重启/reconcile 强耦合：重启后所有子会话未加载 → 计数骤降为 0，可继续 spawn，但 durable 名册早已巨大。
- 名字仍永久占用（`roster.ts:259-261`、`projection.ts:292-295`）→ 会话内名字空间照样耗尽。

**兼容与迁移**：无持久形状变化 → **不需要升 stateVersion**；旧日志、旧 checkpoint 全部可读。

**风险成本**：代码量最小（1 文件 ~10 行）。但**语义含糊**（"在用"到底指 phase 还是 live？两种都不完备），且不解决名字/台账膨胀。

**是否解决真实场景**：**否（或至多个案缓解）**。真实会话 8 人全部 durable `active`；若这 8 人恰好都仍 loaded（`inactive` 但 Agent 在册），live-only 仍判满；若已卸载则腾位，但会带来"重启后计数归零"的新歧义，并永久泄漏名字。**单独不成立**。

---

### 方案 B：新增成员生命周期终态 `retired`（墓碑）+ `retire_teammate` 工具，从名额中扣除

**机制**
- `types.ts:51` 扩 `TeamMemberPhase` 加 `'retired'`；`types.ts:69` `TeamMemberView['status']` 加 `'retired'`。
- `projection.ts:82` `teamMemberSnapshotSchema.phase` enum 加 `'retired'`；`projection.ts:365` `teamMemberProjectionSchema.phase` enum 加 `'retired'`。
- `projection.ts:296-304` 状态机新增合法迁移：`active → retired`、`failed → retired`；`retired → *` 拒绝；`provisioning → retired` 拒绝（留给 reconcile 把 provisioning 收敛成 active/failed 后再退役）。**保留墓碑在 `members` 数组里（不物理删除）**，因此 `replaceAt`（`:279-284`）语义不变。
- `roster.ts:262` 计数改为"非 retired 条数"：
  ```diff
  - if (state.members.length >= this.maxMembers) {
  + if (state.members.filter(m => m.phase !== 'retired').length >= this.maxMembers) {
  ```
- 新增 `roster.retire(caller, targetName)` + `TeamService.retireTeammate(...)`（`index.ts` 第 13 个公有方法）+ 第 10 个 tool `retire_teammate`（`tool-agent-team/src/index.ts`）。
- `projection.ts:440` `stateVersion: 4 → 5`；`team/member` 事件版本建议同步 `2 → 3`（见 §4、§3-P1）。
- 客户端：`TeamAction.tsx:27/43-50/52-58/84-89` 与 `src/client/locales.ts` 的 `memberStatus.*` 增 `retired`。

**破坏的不变量**
- 成员状态机由"1 步"变"2 步到终态"；但仍是**整值快照 + replace-or-push**，不引入删除形状（`projection.ts:306`）。✅ 与"whole value"契约一致。
- `immutable identity`（name/provider/context，`:299-301`）仍保持不变，只有 `phase` 迁移。✅
- 名字永久性**不变**（retired 不释放名字，见 §4 决策 2）。✅
- `resolveActiveMember`（`roster.ts:49-53`）只认 `active` → retired 自动不可寻址，无需改。✅
- ⚠️ **`tryMembership` 陷阱**：`roster.ts:97-105` 在"成员存在但 phase 非 active/provisioning"时会 fall through 把该 live agent 重新解释成**自己的 lead 根**。若 retired 成员仍有 live Agent（drain 未完成/被延迟），会被误判为 lead。**必须**在 `:97` 分支显式处理 retired → `return undefined`（或确保 retire 一定先 drain 掉 child，见 §4 决策 3）。这是一条容易被漏掉的不变量破坏点。
- `projectTaskView`（`task-view.ts:42-49`）靠 `state.members.find(id)` 解析 `ownerName`；墓碑保留 → retired 成员仍能解析出 ownerName（任务不会突然显示"未分配"）。✅（这是"墓碑而非删除"的直接好处）
- wire 投影 `buildTeamProjection`（`projection.ts:396-404`）对 member 不做过滤 → retired 行照常进入客户端只读视图。⚠️ 其余 4 个闭合状态枚举（`types.ts:69`、`projection.ts:82/365`、`tool index.ts:59`、`TeamAction.tsx:27`）都要同步，否则类型/序列化/工具 schema 全线报错。

**兼容与迁移**
- 旧日志（只有 `provisioning/active/failed`）在新 code 下重放，仍得到等价状态（新 enum 是超集）。✅
- `stateVersion 4 → 5`：旧 checkpoint 行 `row.ver !== 5` → `usable=false` → 从 `seq 0` 全量重放（`session-projection/src/index.ts:512-513`、`:604-618`），**安全但一次性全量 refold**。若走 crash-repair 且 `baseSeq>0` 会抛 "re-read from seq 0"（`:514-519`），由调用方回退读 0，仍安全。
- 事件版本 `team/member 2→3`：旧二进制读到 v3 会在 `SUPPORTED_TEAM_EVENT_VERSIONS`（`:235`）被拒并让投影进 `failure` 终态（`:269-276`）——**这是"降级会明确失败"而非静默错读**的期望行为；本包明确"实验、无稳定性承诺"（`README.md:200`），可接受。
- 迁移成本：无需数据迁移脚本（重放即迁移），但需接受"每会话首次加载多一次全量 refold"。

**风险成本**：改动 6 个源码文件 + 客户端 + 测试/文档；中等工作量。主要风险是**闭合枚举漏改**（类型编译会拦）+ `tryMembership` 陷阱 + 客户端 locale 键。

**是否解决真实场景**：**是**。用户把 8 个 active 成员里不用的 `retire` 掉 → 计数 = 非 retired 条数下降 → 立刻可再 spawn。且解决"0 failed 也满员"这一硬场景（区别于"只回收 failed"的任何方案）。

---

### 方案 C：拆分"并发上限 vs 生命周期总量"两个配置

**机制**
- `types.ts:172-181` `Config` 加 `maxMemberLifetime?`（或 `maxMemberTotal`）；`index.ts:75-80` schema 与 `:94-102` 校验、`:108` 传参同步。
- `roster.ts:262` 分成两个判定：并发（live 或非 retired-active）用 `maxMembers`，累计（`members.length` 或"非 retired 累计"）用 `maxMemberLifetime`。
  ```diff
  + if (state.members.length >= this.maxMemberLifetime) throw TEAM_MEMBER_LIMIT_LIFETIME
    if (state.members.filter(m => m.phase !== 'retired').length >= this.maxMembers) throw TEAM_MEMBER_LIMIT
  ```
- 文档/`docs/config-catalog.md` 同步。

**破坏的不变量**：属于**配置语义澄清**，不新增持久形状本身 → 不升 stateVersion（除非与 B 组合）。但若"累计上限"仍统计含 retired 的 `members.length`，则长程会话**仍会**先撞 lifetime 上限——只是从"并发"问题变成"总量"问题。

**兼容与迁移**：新增可选配置，默认值需谨慎（默认 `maxMemberLifetime` 应足够大或设为 Infinity/不设限，否则旧部署行为变化）。

**风险成本**：小（config + 一行判定）。但**单独不提供任何回收动作**——没有 retire，就没有任何东西能让计数下降。

**是否解决真实场景**：**单独否**。它能防"并发过高"，但用户的问题是"累计只增"，没有回收手段照样撞 lifetime 墙。**推荐与 B 组合**（B 提供回收，C 把 `maxMembers` 的语义明确成"并发/在用上限"，把"历史累计"单列为 `maxMemberLifetime`）。这是 P2 的"命名澄清"。

---

### 方案 D：自动回收（provisioning 失败 / 长期 inactive 自动退役）

**机制**
- 在 `roster.reconcileProvisioning`（`roster.ts:384-426`）里把长期 `provisioning` 收敛为 `failed`（已有）；再叠加一个 sweep：监听 `agent/status`（`index.ts:112-115`）或定时器，把 `inactive` 超过 T 的成员自动写 `retired` 事件（需要 B 的 phase）。
- 或"自动回收 failed"：把 failed 自动转 retired（需要 B）。

**破坏的不变量**：自动写入是 durable 事件 → 重放仍确定（事件在日志里）✅；但**决策依赖 wall-clock / 运行时启发式**，导致"同一个日志不同 wall-clock 下会产生不同历史"在**决策写盘之前**不可复现（写盘后确定）。更关键的是**产品语义风险**：真实会话的 `tla-auditor` 连续跑 ~40 分钟才被人工 interrupt（`team-member-reclaim-real-session.md:48、§6 约束2`），"长期 inactive 自动退役"会**误杀**正在长跑的成员。

**兼容与迁移**：依赖 B 的持久形状；自动 sweep 需可关闭、阈值可配。

**风险成本**：中（sweep 逻辑 + 依赖 B + 误杀风险）。**单独不解决 8/8 全 active**：自动回收 failed 对 0 failed 现场无用；自动回收 inactive 会误杀长跑成员。

**是否解决真实场景**：**否（作为默认策略）**。只适合做 **P2 的安全网**（且仅限 `provisioning` 卡死这种"半成品"边界，不做基于 idle 的主动杀）；用户明确需要**显式**触发（现场约束 2）。

---

### 方案 E：名字槽位复用（退役后允许重名）

**机制**
- 放宽命令层 `roster.ts:259-261` 与重放层 `projection.ts:292-295` 的"同名不同 id"拒绝；但墓碑仍在 `members` 里，`resolveActiveMember`（`roster.ts:49-53`）/`projectTaskView` 都按 `name`/`id` 找，**重名会造成寻址歧义**。
- 要正确实现必须引入"名字 epoch / 代际"（例如 `name#generation` 或持久 `retiredAt` + 取"最新非 retired"），这本身是**新的持久字段 + 新的重放规则**。

**破坏的不变量**：直接破坏 `projection.ts:292-295` 的"name 唯一"重放不变量（旧日志若曾出现同名不同 id 会重放失败，新日志语义反转）；破坏"模型可寻址性"（`send_message(target=name)` 不再唯一）。

**兼容与迁移**：需要新持久形状 + 迁移；旧日志的重名校验语义反转 → 高风险。

**风险成本**：大（重放语义 + 寻址 + 迁移）。**是否解决真实场景**：**否（且不需要）**。B 已用"墓碑 + 只数非 retired"腾出**名额**；名字继续永久占用**完全够用**（长程会话真正缺的是"位子"而非"名字"）。**不推荐**，见 §4 决策 2。

---

### 方案 F：会话级重置 / 新 Team 边界

**机制**
- `TeamId` 就是 root Session id（`types.ts:14-24`），`journal.state` 读该 Session 的 `agentTeam` 投影（`journal.ts:29-34`）。所以：
  - **新开一个 root Session = 新 Team = 新名册**（计数从 0 起）。
  - 同一个 Session 内**无法**重置名册：唯一途径是往它的日志追加事件，而现有事件域没有删除语义；改写历史日志既被"只读投影"禁止也不可重放安全。

**破坏的不变量**：无代码改动。但"重置"= 放弃该会话的全部上下文/名册/任务板，是"重开一局"而非"修复"。

**兼容与迁移**：零代码、零迁移。

**风险成本**：零代码；成本是**丢上下文**。**是否解决真实场景**：**否（只是绕过）**——但它是 P0 唯一立即可用的"零代码缓解"之一。

---

### 2.7 对比总表

| 方案 | 改动面 | 兼容性风险 | 是否解决"8/8 全 active"场景 | 是否需升 stateVersion | 工作量 |
|---|---|---|---|---|---|
| **A 只数在用** | `roster.ts:262` 一行（+ live 判定可能扩到循环） | 低（无形状变化，旧日志/checkpoint 全兼容） | **否/个案**：durable 全 active 仍满；live-only 又引入"重启计数归零"歧义，且名字/台账仍泄漏 | **否** | 极小（1 文件 ~10 行） |
| **B retired 墓碑 + retire_teammate** | 6 源文件（`types/projection/roster/index` + tool + client）+ locale + 测试/文档 | 中：5 个闭合枚举须同步；`tryMembership` 陷阱；旧二进制读新事件会 `failure`（可接受）；旧 checkpoint 全量 refold | **是**（0 failed 也能腾位） | **是（4→5）**，事件版本建议 2→3 | 中 |
| **C 拆并发/总量配置** | `types.ts`+`index.ts` config、`roster.ts:262` 双判定、catalog 文档 | 低（纯配置，可选字段） | **单独否**（无回收动作，仍撞 lifetime） | 否（除与 B 组合） | 小 |
| **D 自动回收** | sweep（`index.ts:112` / reconcile `roster.ts:384`）+ 依赖 B | 中：依赖 B；wall-clock 启发式**误杀长跑成员** | **否**（0 failed 现场无用；idle 主动杀会误伤 `tla-auditor`） | 是（继承 B） | 中 |
| **E 名字复用** | `roster.ts:259-261`+`projection.ts:292-295`，需引入 epoch/新持久字段 | **高**：破坏 name 唯一重放不变量、破坏寻址、旧日志语义反转 | 否（且不必要） | **是**（新形状，且大） | 大 |
| **F 新会话/新 Team** | 零代码（运维操作） | 无 | **否（绕过）**：丢上下文/名册/任务板 | 否 | 零（但代价是上下文） |

---

## 3. 推荐：主方案 + 分阶段路线

### 主方案
**B（`retired` 墓碑终态 + 只数"非 retired" + `retire_teammate` 工具）为主干**，并在 **P2 吸收 C**（把 `maxMembers` 明确为"在用/并发上限"，另设 `maxMemberLifetime` 表示"历史累计上限"）。理由：只有 B 同时满足"现场 0 failed 也能腾位""显式可控""不破坏整值快照重放契约""名字永久性与寻址性不变"。C 单独无回收动作，D 会误杀，E 破坏重放，A 不完备，F 丢上下文。

### P0 —— 立即缓解（零代码，今天就能用）

**P0-a 用法修正：固定角色名册 + `send_message` 复用（首推，零成本、无副作用，唯一不牺牲上下文的缓解）**
- 做法：开局一次建好一小组**稳定角色**（如 `explorer` / `implementer` / `reviewer` / `archivist`，与 `docs/design/role-model-routing.md` 的 7 角色一致），之后每轮派活一律 `send_message({ target: "implementer", message: ... })`，**不再按任务新建名字**。
- 依据：名字永久且唯一（`README.md:60`、`roster.ts:259-261`）；`send_message` 可唤醒/续跑 inactive 成员（`index.ts:163`、`roster.ts` 消息路径），不消耗新名额。这是**唯一既不改代码、又不丢长程上下文**的缓解。
- 代价：要求 Lead 在**开局就规划好角色边界**；角色阶段性能力不足时只能靠 `retire` + 重建（P1）——这正是 P0-a 与 P1 互补之处。

**P0-b 调大 `maxMembers`（部署配置，只是推迟撞墙）**
- 位置：`config/bundle-ai-compiler/bundles.patch.yml:69`（当前 `maxMembers: 8`）→ 改成更大值（如 64）。DSH 默认 16（`agent-team/src/index.ts:58`）。
- 代价：① 计数仍是"累计只增"，每轮新建 + 每次失败创建（`roster.ts:265`、`:286-292`）都会消耗 1，长程会话终会再撞；② 构造期 `readonly`（`index.ts:75-108`），须重载服务/重启会话才生效；③ 已满的旧会话重载后仍原值满员，调大后能继续，但语义未变。

**P0-c 新开一个 root Session（新 Team/新名册——绕过，丢上下文）**
- 依据：`TeamId == root SessionId`（`types.ts:14-24`），新会话即新名册、新计数。
- 代价：**丢失当前会话的上下文、名册、任务板**；不能迁移任务/成员（等于"重开一局"）。可先把关键结论/交接写入文件，再在新会话重建。

> P0 只止损、不修复。**P0-a 是首选**（不丢上下文、不改代码）；P0-b 只把墙推远；P0-c 代价最大（丢上下文）。三者可组合：先用 P0-a 纠正用法，必要时 P0-b 扩容，实在不行才 P0-c 重开。

### P1 —— 最小可用（核心回收能力，主线）

以 **retired 墓碑 + 只数非 retired + retire_teammate 工具 + stateVersion 4→5** 为主线，具体改动清单见 **§3.1**。

P1 的 `retire` 明确解决**三类真实残留**（P0-a 无法覆盖，因为名字一旦建错就无法改名）：
1. **已经建错了名字**：按任务起了专用名、角色划分不当，日后无法复用该名字（`roster.ts:444-453` 的 never-reused、`projection.ts:299-301` 的 immutable identity）。
2. **角色阶段性用完**：某专职角色只服务过一轮长任务，之后长期闲置但仍占位（`inactive` 只是运行时视图，耐久 `phase` 仍是 `active`）。
3. **失败占位**：`provisioning` 失败留下的 `failed` 行永久占位与占名（`roster.ts:286-292`、`tests/team.spec.ts:331-341`）。

目标：Lead 可显式退役任意 `active`/`failed` 成员，腾出名额，长程会话可持续创建。**注意**：retire 是"纠错与止损"，不是日常流转手段——日常流转应走 P0-a 的 `send_message` 复用。

### P2 —— 完整

1. **配置语义拆分（吸收 C）**：`maxMembers` = 在用/并发上限（只数非 retired，或"在用"）；新增 `maxMemberLifetime` = 历史累计上限（含 retired），默认足够大/可关闭。更新 `docs/config-catalog.md`。
2. **自动回收安全网（收敛版 D）**：仅对"`provisioning` 卡死超过阈值"的半成品做自动 retired（补 reconcile 的边界），**不做**基于 idle 的主动杀（避免误杀长跑成员）。
3. **retire 增强**：`retire_teammate` 支持批量 / `--force`（先 drain 再 retire，处理 running）、退役前提示"该成员仍持有任务 N 个"、可选 `retiredReason` 持久字段与审计。
4. **客户端**：retired 行默认折叠到"已退役(N)"分区、灰显、不可点开。
5. **文档/测试/迁移**：README（`51/60/205`）+ `README.zh.md` + `README.i18n.yaml` 重录；补 retire 状态机与端到端测试；记录"事件版本单向升级"的运维说明。

### 3.1 P1 文件级改动清单（供 T4 直接执行）

> 约定：保持"整值快照 + replace-or-push"契约，**不物理删除**成员行；名字仍永久；退役是 `team/member` 的终态 `phase`。

**① `packages/experimental/agent-team/src/types.ts`**
- `:51` `export type TeamMemberPhase = 'provisioning' | 'active' | 'failed' | 'retired'`
- `:69` `TeamMemberView['status']` 增 `'retired'`（联合变 `'running' | 'inactive' | 'provisioning' | 'failed' | 'retired'`）
- （可选，P2）`TeamMemberSnapshot` 增 `retiredAt?: string` / `retireReason?: string`；若加则 stateVersion 必升（本 P1 采用"仅 phase"，不加字段）
- `:268-287` 若升级事件版本：`'team/member': { version: 2 | 3; ... }`

**② `packages/experimental/agent-team/src/projection.ts`**
- `:82` `phase: z.enum(['provisioning', 'active', 'failed', 'retired'])`
- `:132-136` 若升级事件版本：`version: z.union([z.literal(2), z.literal(3)])`（writer 对 retired 边写 3，其余可写 2）
- `:235` 若升级事件版本：`new Set([2, 3])`（含 3）
- `:296-304` 状态机替换为：
  ```ts
  if (prior === undefined) {
    if (member.phase !== 'provisioning') throw new Error(`teammate "${member.name}" must begin provisioning`)
  } else {
    if (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context) {
      throw new Error(`teammate "${member.id}" changed immutable identity fields`)
    }
    const legal =
      (prior.phase === 'provisioning' && (member.phase === 'active' || member.phase === 'failed')) ||
      ((prior.phase === 'active' || prior.phase === 'failed') && member.phase === 'retired')
    if (!legal) {
      throw new Error(`teammate "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`)
    }
  }
  ```
  （`retired → *` 与 `provisioning → retired` 均被拒；墓碑保留在数组内）
- `:365` `phase: z.enum(['provisioning', 'active', 'failed', 'retired'])`
- `:440` `stateVersion: 4` → `5`
- `:396-404` `buildTeamProjection` **不新增过滤**（retired 行保留进客户端视图，见 §4 决策 6）

**③ `packages/experimental/agent-team/src/roster.ts`**
- `:262` 计数：`if (state.members.filter(m => m.phase !== 'retired').length >= this.maxMembers)`
- `:97` `tryMembership` 分支补 retired 处理（防 fall-through 误判为 lead）：
  ```ts
  const member = this.journal.state(root).members.find(c => c.id === agent.id)
  if (member?.phase === 'active' || member?.phase === 'provisioning') { return { root, id: TeamId(root.id), role: 'teammate', name: member.name } }
  if (member?.phase === 'failed' || member?.phase === 'retired') return undefined   // ← 新增
  ```
- `:145-159` `list()` status 补分支：`member.phase === 'retired' ? 'retired' : ...`（放在 provisioning 分支前或并列）
- 新增 `retire` 方法（Lead-only）：
  - `membership(caller)` → `role==='lead'` 否则 `TEAM_LEAD_REQUIRED`
  - 用新 `resolveRetirableMember(state, name)`：按 name 找 `phase in {active, failed}`（`provisioning` 拒绝、`retired` 拒绝、不存在 `TEAM_MEMBER_NOT_FOUND`）
  - 若 live Agent 存在（`ctx.agents.get(id)`）：先 `await this.stopTeammates(root, [id])`（复用 `:229-231` 的 drainChildren）；drain 失败则抛出、**不写** retired
  - `journal.transact` 内重读 current，确认仍是 active/failed（防并发），`appendAndFlush(root,'team/member',{ version: 3, teamId, member: { ...current, phase:'retired' } })`
  - 返回 `memberView`（沿用 `:429-442`，但需允许 retired：可复用 `list()` 的 status 计算）
- `:49-53` `resolveActiveMember` **不改**（retired 自动不可寻址）

**④ `packages/experimental/agent-team/src/index.ts`**
- 新增公有方法 `retireTeammate(caller: Agent, targetName: string)` → `return this.roster.retire(caller, targetName)`（放在 `interrupt` 附近）
- 若 P2 拆配置：`:76` 加 `maxMemberLifetime` 默认、`:95` 校验、`:108` `new TeamRoster(..., this.config.maxMembers, this.config.maxMemberLifetime)`

**⑤ `packages/experimental/tool-agent-team/src/index.ts`**
- `:59` `MEMBER_VIEW_SCHEMA.status` enum 增 `'retired'`
- 新增第 10 个 tool（建议紧跟 `interrupt_agent` 之后注册，`:363-375` 之后）：
  ```ts
  defineTool({
    name: 'retire_teammate',
    description: 'Retire one active or failed teammate, releasing its member slot while preserving its durable name and history. Team Lead only. A running teammate is drained first.',
    parameters: { target: { type: 'string', required: true, description: 'Teammate target returned by spawn_teammate or list_agents.' } },
    output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
      retired: { type: 'boolean', required: true, const: true },
      previousPhase: { type: 'string', required: true, enum: ['active', 'failed'] },
    }}),
    execute(args, exec) { return Promise.resolve(ctx.agentTeams.retireTeammate(callingAgent(exec.agent,'retire_teammate'), args.target)) },
  })
  ```
  （output 字段按最终 service 返回值定；若返回 member view 则复用 `MEMBER_VIEW_SCHEMA`）
- `:35-43` `teamPolicy()` 增加一句退役指引：`retire_teammate` 用于释放名额；退役后名字不可复用、成员不可寻址；running 成员会先被 drain。

**⑥ `packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx`**
- `:27` `type MemberStatus = 'running' | 'inactive' | 'provisioning' | 'failed' | 'retired'`
- `:43-50` `memberStatusKey` 加 `case 'retired': return 'memberStatus.retired'`
- `:52-58` `memberDotState` 加 `case 'retired': return 'idle'`（`StateDotState = 'done'|'warning'|'ongoing'|'error'|'idle'`，`'idle'` 合法）
- `:84-89` `inert` 增 `status === 'retired'`（不可点开）
- 可选 P2：把 retired 行折叠到"已退役"分区、灰显

**⑦ `packages/experimental/client-ui-agent-team/src/client/locales.ts`**
- `zh`（`:26-29` 附近）加 `'memberStatus.retired': '已退役'`
- `en`（`:58-61` 附近）加 `'memberStatus.retired': 'Retired'`
- ⚠️ **勘误**：Lead 给定事实说"`locale/{en,zh}.json` 需加 `memberStatus.retired`"——**不准确**。经复核，`client-ui-agent-team/locale/en.json` / `zh.json` **只含 `meta.title` / `meta.description`**（包级元数据），真正的成员状态字典在 `src/client/locales.ts`（`zh` 是 key 源、`en` 用 `satisfies Record<TeamKey,string>` 校验）。加键必须改 `src/client/locales.ts`，不是 `locale/*.json`。若只改 JSON 会导致 `TeamKey` 不含该键、`en` 校验失败/漏译。

**⑧ 文档与测试**
- `packages/experimental/agent-team/README.md`：`:51` 的 `maxMembers` 语义、`:60` 名字永久性、`:205` "no deletion" 局限改为"可退役、名字仍不可复用"；`README.zh.md` + `README.i18n.yaml` 重录（`pnpm run verify-translation-pairing --write ...`）。
- `tests/team.spec.ts:331-341` 仍成立（failed 仍占位、仍占名、仍计数）；**新增** retire 后计数下降、再 spawn 成功的用例；新增"retired 不可 `send_message`/`interrupt`"用例。
- `tests/projection-events.spec.ts:135-163`：新增 `active → retired`、`failed → retired` 合法；`retired → active`、`provisioning → retired` 非法。
- `tests/completion.spec.ts:543` `expect(teamProjectionDefinition.stateVersion).toBe(4)` → **改成 5**（否则测试必挂）。

---

## 4. 关键设计决策清单

### 决策 1：retired 用 **phase** 还是新事件类型？
**结论：用 `phase`（扩 `TeamMemberPhase` 枚举），不新增事件类型。**
理由：
- 生命周期本就是"一个整值快照 `team/member` + 一个 phase 状态机"（`types.ts:53-62`、`projection.ts:296-304`），退役是又一个**终态 phase**，语义最自然。
- 新事件类型（如 `team/member/retired`）要新增 `TeamEventType`（`projection.ts:209-213`）、`isTeamEvent`（`:223-228`）、`parseCurrentTeamEvent`（`:247-261`）、`applyCurrentTeamEvent`（`:286-359`）、`SessionEventMap`（`types.ts:268-287`）、`MutableTeamEventType`（`journal.ts:9`），还要么引入第二个"墓碑集合"要么重复 identity——**破坏"每次变更写整条快照"的单写点不变量**，面更大。
- 用 phase 的代价是必须同步 5 个闭合枚举 + 升 stateVersion/事件版本（可控、编译期可发现）。

### 决策 2：退役后名字是否可复用？
**结论：保持不可复用（名字永久占用），只释放"名额"不释放"名字"。**
理由：
- 重放层强约束"同名不同 id"即报错（`projection.ts:292-295`）；若允许退役后重名，旧日志/新日志的同名校验语义反转，重放不再确定。
- 模型寻址性：`send_message`/`interrupt` 以 `target=name` 解析（`resolveActiveMember`，`roster.ts:49-53`）；重名会让寻址歧义。要支持重名必须引入"名字 epoch/generation"这种新持久形状，成本远超收益。
- 现场真正缺的是"位子"不是"名字"：B 的"只数非 retired"已解决名额；名字继续永久占用完全够用（用户在 8 个名字里够用，只是位子满了）。

### 决策 3：running（或 live）成员能否直接退役？
**结论：工具语义为"退役 = 先 drain 再置 retired"（单次调用内先 `interrupt`/`drainChildren`，成功后再写墓碑）；若 drain 失败则整体失败、不写 retired。底层 service 也拒绝"对一个仍有 live Agent 的成员直接翻 phase 而不 drain"。**
理由：
- 现场用户已多次 `interrupt_agent` 却清不掉（真实会话 seq 4418 等），强行要求"模型先 interrupt 再 retire 两步"体验差且易错位。
- `stopTeammates`/`drainChildren`（`roster.ts:229-231` → `subagent/manager.ts:348-373`）已能安全处理 running/inactive/未加载三种状态，直接复用。
- 先 drain 再写墓碑，避免"活跃回合仍在往共享文件写、却被标记退役"的孤儿写冲突；也避免决策 4 提到的 `tryMembership` 把残留 live child 误判为 lead。
- 单次原子语义：drain 成功才写盘；失败则状态不变（不像"先置 retired 再异步 drain"会留下半截）。

### 决策 4：成员持有未完成任务怎么办？
**结论：P1 不阻塞退役；允许任务 `ownerId` 继续指向已退役成员，但要求 `retire_teammate` 的返回里**列出该成员仍在持有的任务 id/数**（提示 Lead 用 `team_task_update action=reassign` 改派）。**
理由：
- 因为采用"墓碑保留"而非物理删除，`projectTaskView`（`task-view.ts:42-49`）仍能从 `state.members.find(id)` 解析出 `ownerName`——任务视图**不会**变成"未分配"，而是显示"已退役成员名"，可读且可追责。这正是墓碑优于删除的又一体现。
- 若要强阻塞（要求先 release/reassign），会让"清理名额"这一紧急诉求被任务状态卡住；且 README 已声明"No automatic ownership release"（`README.md:206`），保持现状一致。
- 折中：工具返回值带 `ownedTaskIds`，由 Lead 决定是否先改派；P2 可加"退役前强制 release"选项。

### 决策 5：stateVersion 是否必须 4→5？
**结论：严格说，纯"加一个 phase 枚举值、不加新持久字段"的增量改动，旧 checkpoint 在 `usable` 判定下**仍可读**（`row.ver===4` 仍成立、旧行 schema 仍是新 enum 的子集），因此**不是"技术上必须"**；但**推荐且应按 4→5 升级**，本方案按"必须执行"对待。**
依据与理由：
- `session-projection` 的 `usable` 判定是 `row.ver === def.stateVersion && seq 范围合法`（`index.ts:512-513`）；升到 5 后，所有旧 ver-4 checkpoint 变 `usable=false` → 从 `seq 0` 全量重放（`:604-618`）。这条路径**安全**（旧日志只有 v2 事件，新 code 重放出等价状态）。
- 升级带来两项**必须**的好处：① 强制一次性全量 refold，等于对"历史所有日志在新状态机下可重放"做一次真实校验（新迁移 `active→retired` 的正确性闸门）；② **版本即契约**——若某 checkpoint 由新二进制写出（含 retired 行）却仍标 ver 4，回溯到旧二进制会"以为能读"而**静默错读**；升 5 让旧二进制命中 `usable=false` 而明确失败/重放失败，而非静默损坏。
- 若 P2 增加 `retiredAt` 等**新持久字段**，则升 stateVersion 变成**硬性必须**（旧 checkpoint 无该字段虽可解析，但语义版本不再一致）。
- 若同时升 `team/member` 事件版本（2→3），`SUPPORTED_TEAM_EVENT_VERSIONS`（`:235`）也必须并入 3，否则新事件被判"unsupported"并让投影 `failure`（`:269-276`）。
- 结论表述：**"为正确性可选、为契约诚实与回滚安全应升"，本方案升 4→5。**

### 决策 6：要不要清理客户端只读投影里的 retired 行？
**结论：保留（不过滤），只做 UI 灰显/折叠；区别于 task 的 `deleted` 过滤。**
理由：
- projection 是"durable client view"（`types.ts:129-138` 注释），应如实反映耐久状态；过滤 retired 会让 UI 名册数与耐久台账不一致、并丢失"谁曾存在/谁持有任务"的历史。
- task 之所以过滤 `deleted`（`projection.ts:407-409`）是因为已删任务确实"不存在于看板"；而 retired 成员仍可被任务 `ownerId` 引用（决策 4），过滤掉会让 `ownerName` 无处可查。
- 所以：`buildTeamProjection` 保留 retired 行，客户端新增 `'retired'` 状态并灰显/折叠（`TeamAction.tsx` + `locales.ts`）。

---

## 5. 剩余风险与未验证项

1. **闭合枚举同步风险**：`phase`/`status` 至少 5 处闭合（`types.ts:51`、`types.ts:69`、`projection.ts:82`、`projection.ts:365`、`tool/index.ts:59`、`TeamAction.tsx:27`）。类型系统能拦 TS 层，但**工具 schema 与 locale 是运行期/资源**，漏改会 schema 校验失败或漏译——必须把这几处列成 checklist 逐项验证。
2. **`tryMembership` 陷阱**（`roster.ts:97-105`）：若 retire 未先 drain、或 drain 只释放部分 live 句柄，残活的 retired child 可能被误判为独立 lead 根。P1 必须"先 drain 后写墓碑"并给 `tryMembership` 显式 retired→undefined 分支；**尚未做端到端对抗测试**（需 T4 spike 覆盖"running 时 retire"这一路径）。
3. **降级/回滚不可逆**：升 `team/member` 事件版本后，旧二进制读新日志会 `unsupported version → failure`；这是**设计选择**（明确失败优于静默错读），但要写进运维说明，且"回滚"意味着隔离含 retired 的日志。
4. **全量 refold 成本**：stateVersion 升级后每会话首次加载多一次 O(events) 重放；对超长日志（真实会话 5999 事件）可接受但需实测加载时延。
5. **`provisioning` 卡死成员仍无法退役**：P1 拒绝 `provisioning → retired`，依赖 reconcile（`roster.ts:384-426`）把它先收敛成 active/failed。若某场景 reconcile 迟迟不跑，该成员仍占位——列为 P2 自动安全网要处理的边界，**当前未验证** reconcile 在长程会话中的及时性。
6. **命令面并发**：`retire` 与 `spawn` 都在 `journal.transact` 内做"非 retired 计数/重名"判定，需确认两事务串行（沿用 `journal` 的事务模型，见 `journal.ts:60-72`）；P1 设计里 `retire` 的 drain 在事务**外**、写盘在事务**内**，需保证 drain 与写盘之间无第二笔 spawn 抢到刚释放的名额——建议写盘前在事务内**重新校验** current 仍为 active/failed（已列入 §3.1③）。
7. **未验证：用户 profile 的多处 `maxMembers`**：除 `config/bundle-ai-compiler/bundles.patch.yml:69` 外，是否存在别的 profile/overlay 覆盖值未穷举（T1 §7 亦标未验证）；P0 调参前应先确认实际生效值。
8. **未验证：`retire_teammate` 的模型使用倾向**：加了工具不等于模型会用（现场模型在受限工具面下已自行诊断出"没有回收机制"）。P1 需在 `teamPolicy` 明确指引，并在 T4 spike 里验证模型在"接近满员"时会不会主动 retire。

---

## 附：本文引用证据索引（file:line）

- 计数/闸门：`agent-team/src/roster.ts:262-264`、`:259-261`、`:265`、`:286-292`、`:419`、`:467`、`:49-53`、`:97-105`、`:145-159`、`:229-231`
- 事件域/状态机/版本：`agent-team/src/projection.ts:164`、`:209-213`、`:223-228`、`:235`、`:247-261`、`:279-284`、`:288-306`（`:296-304` 状态机）、`:361-367`、`:393-412`、`:440`；`agent-team/src/types.ts:51`、`:53-62`、`:69`、`:172-181`、`:268-287`
- 配置/公有面：`agent-team/src/index.ts:58`、`:75-108`、`:134-256`
- 工具面：`tool-agent-team/src/index.ts:35-43`、`:59`、`:234-499`、`:363-375`
- 客户端：`client-ui-agent-team/src/client/TeamAction.tsx:27`、`:43-50`、`:52-58`、`:84-89`；`client-ui-agent-team/src/client/locales.ts:7/26-29/33/36/39/58-61/65`；`client-ui-agent-team/locale/en.json`、`zh.json`（仅 meta）
- 重放/checkpoint：`session/session-projection/src/index.ts:505-535`（`:512-513` usable 判定）、`:590-618`（buildCell 全量折叠）
- 任务视图：`agent-team/src/task-view.ts:42-49`
- 部署配置：`config/bundle-ai-compiler/bundles.patch.yml:69`（`maxMembers: 8`）
- 文档：`agent-team/README.md:51`、`:60`、`:200`、`:205`、`:206`
- 测试锁定：`agent-team/tests/team.spec.ts:331-341`、`tests/projection-events.spec.ts:135-163`、`tests/completion.spec.ts:543`
