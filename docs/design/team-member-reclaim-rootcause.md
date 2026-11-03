> **已被取代（历史）**：本文档描述旧的动态回收方案；现行实现为「角色一等契约 + 4 保留槽/4 弹性槽」，见 `patches/0002-team-roles-slots.patch` 与 `docs/03-decisions.md` 的 ADR-013。

# Agent Team 队友名额不可回收：根因溯源（源码审计）

- 审计对象：`~/workspace/deepseek-harness`，commit `296181d1c2`（`feat(agent-team): generic Team task completion policy extension point`）。
- 审计范围：`packages/experimental/agent-team/src/{index,roster,projection,types,journal,lifecycle,task-board}.ts`、`packages/experimental/tool-agent-team/src/index.ts`、该两包的 README 与 tests、`packages/subagent/subagent/src/{index,manager}.ts`、`packages/session/session-projection/src/index.ts`、历史实测 `evidence/design/member-limit-probe.json`。
- 方式：只读分析。基线仓库未做任何写操作（无编辑、无分支、无 stash）。
- 结论口径：本文只回答"为什么名额只增不减"，不重新判断产品需求。

---

## 1. 结论摘要

1. 唯一的录取闸门是 `state.members.length >= maxMembers`，计数对象是**持久投影里"该 Team 一生出现过的 teammate 快照条数"**，与成员是否存活、是否在跑、是否还有用处完全无关（`packages/experimental/agent-team/src/roster.ts:262-264`）。
2. `members` 是只增集合：Team 事件域只有 4 种事件，没有任何一种能表达"移除成员"；`team/member` 全仓仅 3 个写入点，且每处都写整条快照（`packages/experimental/agent-team/src/projection.ts:209-213`、`types.ts:268-287`、`roster.ts:265`、`roster.ts:419`、`roster.ts:467`）。
3. `provisioning / active / failed` 三个 phase 全都占名额；致命点在于 `provisioning` 记录在**启动子会话之前**就已落盘，所以任何创建失败都会留下一条永久占位的 `failed` 行（`roster.ts:257-266` 先写盘、`roster.ts:268-305` 才启动，失败只改 phase：`roster.ts:286-292`、`roster.ts:456-474`）。
4. 名字同样永久占用：provisioning 记录即占名，重名在命令边界（`roster.ts:259-261`）与重放边界（`projection.ts:292-295`）各被拒一次，且成员身份字段不可改（`projection.ts:299-301`）。
5. 公有面**完全没有回收路径**：`TeamService` 自己声明的 12 个公有方法、9 个模型可见 tool 中都没有删除/退役成员；`stopTeammates`/`drainChildren` 只释放子会话执行句柄，不改名册（`packages/experimental/agent-team/src/index.ts:134-256`、`packages/experimental/tool-agent-team/src/index.ts:235-499`、`roster.ts:229-231` → `packages/subagent/subagent/src/manager.ts:348-373`）。
6. 于是名额语义是"团队一生累计上限"而非"并发上限"，长程会话反复 spawn 必然在累计 N 条后**永久**撞墙；这一语义被 README 明确写成设计意图，而不是实现 bug（`packages/experimental/agent-team/README.md:51`、`:60`、`:205`）。

---

## 2. 证据表

### 2.1 上限判定点与计数对象

| 事实 | 位置(file:line) | 影响 |
|---|---|---|
| 上限判定是 `if (state.members.length >= this.maxMembers) throw TEAM_MEMBER_LIMIT`，判定发生在 `journal.transact` 事务内、`team/member` append 之前 | `packages/experimental/agent-team/src/roster.ts:262-264`（事务见 `:257`，append 见 `:265`） | 计数对象是**已持久化的成员快照条数**，不是 live agent 数、不是 active 数、不是并发数；名额一旦用掉，判定永远只看"历史上出现过几条" |
| `TeamState.members` 是 `readonly TeamMemberSnapshot[]`，即全量成员快照集合 | `packages/experimental/agent-team/src/projection.ts:164` | 没有任何"当前有效成员"的独立集合；`members` 同时承担"历史台账"和"容量计数"两个职责 |
| Team 是 Lead Session 的隐式团队，`TeamId` 就是 root Session id | `packages/experimental/agent-team/src/types.ts:14-24` | 名额绑定在"这个会话"上；换会话 = 换 Team = 重新计数，但长程上下文随之丢失 |
| 默认上限 `DEFAULT_MAX_MEMBERS = 16` | `packages/experimental/agent-team/src/index.ts:58` | 默认 16 个 teammate（Lead 不计入，见下条） |
| Lead 行不进入 `members`；`buildTeamProjection` 单独把 Lead 追加进视图 | `packages/experimental/agent-team/src/projection.ts:394-395`（Lead 行构造）、`projection.ts:396-404`（teammate 行遍历） | `maxMembers` 是 teammate 名额，不是"含 Lead 的席位" |
| `maxMembers` 是构造期校验的部署级配置，被 roster 以 `readonly` 捕获 | `packages/experimental/agent-team/src/index.ts:75-80`、`index.ts:95`、`index.ts:108`、`roster.ts:68` | 运行时没有改配入口；调大必须改配置并重载服务（详见 §4.5） |

### 2.2 `members` 单调只增：没有任何事件能移除成员

| 事实 | 位置(file:line) | 影响 |
|---|---|---|
| Team 事件域只有 4 种：`team/member`、`team/task`、`team/message/queued`、`team/message/delivered` | `packages/experimental/agent-team/src/projection.ts:209-213`（`TeamEventType`）、`projection.ts:223-228`（`isTeamEvent`） | 枚举闭合：不存在"成员移除/退役"事件类型 |
| `SessionEventMap` 的 Team 事件同样是这 4 种，全部为"整值快照"载荷 | `packages/experimental/agent-team/src/types.ts:268-287` | 载荷模型里没有 delete/remove 语义；`team/member` 只能携带一条完整成员快照（`:271`） |
| 可写事件被收窄为 `'team/member' \| 'team/task'`，它们是**整值覆盖**而非增量/删除操作 | `packages/experimental/agent-team/src/journal.ts:9`、`journal.ts:60-72` | 任何名册变化都只能是"再写一条快照"，写不出"删除某条" |
| 全仓 `team/member` 写入点只有 3 处：spawn 的 provisioning、reconcile 的结算、settleProvisioning 的终态 | `roster.ts:265`、`roster.ts:419`、`roster.ts:467` | 三处都是 append 整条快照；没有任何一处执行"过滤/截断/删除" |
| 投影应用 `team/member` 时用 `replaceAt`，`findIndex` 未命中即 `push` | `packages/experimental/agent-team/src/projection.ts:279-284`（`replaceAt`：`if (index < 0) next.push(item)`）、`projection.ts:290`（按 id 找）、`projection.ts:306` | 集合操作只有"替换"和"追加"，没有删除；只要历史上出现过一条，它就永远在 `members` 里 |
| 视图构造对 task 过滤 `deleted`，对 member **不做任何过滤** | `packages/experimental/agent-team/src/projection.ts:407-409`（task 过滤）对比 `projection.ts:396-404`（member 全量遍历） | 任务有墓碑机制、成员没有；这是"缺回收"的最直观投影层证据 |

### 2.3 三个 phase 全部占名额，`failed` 永久占位

| 事实 | 位置(file:line) | 影响 |
|---|---|---|
| `TeamMemberPhase = 'provisioning' \| 'active' \| 'failed'`，只有三态 | `packages/experimental/agent-team/src/types.ts:51`（schema 同：`projection.ts:82`、`projection.ts:365`） | 没有 `retired`/`removed`/`deleted` 终态，名册不存在"退出成员"的表达 |
| spawn 先把 `phase: 'provisioning'` 的完整快照持久化，**之后**才 `startActivation` 创建子会话 | `packages/experimental/agent-team/src/roster.ts:248-255`（构造快照）、`roster.ts:257-266`（落盘）、`roster.ts:268-283`（启动） | 名额在"创建是否成功"之前就被计入；启动失败也回不去 |
| 启动失败分支的核心只有两件事：把快照改成 `failed` 落盘、drain 该子会话（另有 provisioning 冲突检测抛出，不涉及名册） | `roster.ts:285-305`（`phase: 'failed'` 在 `:288`，落盘在 `:292`），结算实现 `roster.ts:456-474` | 失败成员成为永久占位的 `failed` 行；drain 不触碰名册 |
| 限额判定对 phase 一视同仁（只看 `members.length`） | `roster.ts:262` | `provisioning`、`active`、`failed` 三者等价消耗名额 |
| 重启/重开时 provisioning 只会被 reconcile 成 `active` 或 `failed`，不会删除 | `roster.ts:384-426`（`:391` 默认 `failed`、`:410-424` 写回快照） | 半成品 provisioning 记录最终必然变成 active 或 failed，两种都占名额 |
| `resolveActiveMember` 只认 `phase === 'active'`，failed 成员已不可寻址 | `roster.ts:49-53` | failed 成员既不能收消息、也不能被 interrupt，纯粹占坑（对比 `listMembers` 仍会显示它：`roster.ts:137-159`） |
| 测试固化该语义："records failed provisioning durably, reserves its name, and counts it against the limit" | `packages/experimental/agent-team/tests/team.spec.ts:331`（断言：`:336-339` failed 行保留、`:340` 重名被拒、`:341` 另一名字撞限额） | 失败成员"占名 + 占名额"是被测试锁定的预期行为 |
| 历史实测：一次 `TEAM_PROVISIONING_CONFLICT` 失败后 roster 仍保留 `member-1`（`status: failed`，`rosterSize: 2`） | `evidence/design/member-limit-probe.json:1-24`（失败尝试 `:5-9`、failed 行 `:18-22`、`rosterSize` `:11`） | 线上行为与源码一致：失败不回收名额 |

### 2.4 名字永久占用

| 事实 | 位置(file:line) | 影响 |
|---|---|---|
| spawn 在事务内先查重名，命中即 `TEAM_MEMBER_NAME_TAKEN` | `packages/experimental/agent-team/src/roster.ts:259-261` | provisioning 记录一落盘就占住了这个名字，即使随后失败 |
| 投影重放同样拒绝"同名不同 id" | `packages/experimental/agent-team/src/projection.ts:292-295` | 名字唯一性在耐久层被强制，不只是命令层校验 |
| 成员身份字段（name/provider/context）不可变，改名会抛错 | `packages/experimental/agent-team/src/projection.ts:299-301` | 无法把旧成员"改名让位"——名字只进不出 |
| 名字校验带"never-reused"语义 | `packages/experimental/agent-team/src/roster.ts:444-453`（`memberName`，doc 即 "Validate a never-reused model-facing teammate name"） | 名字复用被明确排除在契约之外 |
| README 明文："Teammate names are permanent — even a teammate whose creation failed keeps its name, and no name is ever reused" | `packages/experimental/agent-team/README.md:60` | 文档与实现一致 |

### 2.5 projection 成员状态机：只有 `provisioning → active|failed`

| 事实 | 位置(file:line) | 影响 |
|---|---|---|
| 新成员必须以 `provisioning` 起步，否则重放抛 "must begin provisioning" | `packages/experimental/agent-team/src/projection.ts:296-297` | 状态机入口固定 |
| 已有成员：身份字段不可变；`prior.phase` 必须是 `provisioning`，且新 phase 不得再是 `provisioning` | `projection.ts:298-304` | 合法迁移只有 `provisioning → active` 与 `provisioning → failed`；没有 `active → *`、没有 `* → removed` |
| 同一约束被单元测试逐条锁定（must begin provisioning / immutable identity / invalid active -> failed / 重名） | `packages/experimental/agent-team/tests/projection-events.spec.ts:135-163`（`:135` 用例名、`:146` immutable、`:155` `invalid active -> failed`、`:157-162` 重名） | 状态机不是偶然实现，而是带回归测试的契约 |
| 每应用一次 `team/member` 都返回 `{ ...state, members: replaceAt(...) }`，只能替换或追加 | `projection.ts:306` | 想表达"删除"必须新增集合操作，现有 event→state 折叠函数做不到 |
| checkpoint 用 `stateVersion: 4` + 严格 schema（`members` 为数组，无墓碑概念） | `packages/experimental/agent-team/src/projection.ts:440`、`projection.ts:198-206` | 恢复旧 checkpoint 时成员数组原样通过校验；"已删除"没有可表达的记录形态（见 §5.2） |
| 支持的事件版本集合为 `{2, 3}` | `packages/experimental/agent-team/src/projection.ts:235` | 新增回收事件等于扩展事件域 + 版本集合，而非改一处判断（见 §6） |

### 2.6 服务公有方法表：没有任何 retire/remove

`TeamService` 自身声明的公有方法（`packages/experimental/agent-team/src/index.ts`，逐个列出，共 12 个）：

| 方法 | 位置 | 是否触及名册删除 |
|---|---|---|
| `membership` | `index.ts:134` | 否（读角色） |
| `listMembers` | `index.ts:143` | 否（读） |
| `spawnTeammate` | `index.ts:153` | 否（只增） |
| `sendMessage` | `index.ts:163` | 否（发消息） |
| `createTask` | `index.ts:177` | 否（任务） |
| `getTask` | `index.ts:187` | 否（任务） |
| `listTasks` | `index.ts:196` | 否（任务） |
| `updateTask` | `index.ts:206` | 否（任务变更，含任务 `delete` 动作，但只影响 `tasks`） |
| `registerCompletionPolicy` | `index.ts:219` | 否（完成策略） |
| `waitForChange` | `index.ts:234` | 否（等待） |
| `interrupt` | `index.ts:245` | 否（只中断回合，见 §2.8） |
| `tryMembership` | `index.ts:254` | 否（非抛错探测） |

- 私有方法同样只增不改：`sendAdmitted`（`index.ts:259-283`）、`scheduleRecovery`（`index.ts:286-294`）、`disposeRuntime`（`index.ts:296-311`）。
- 基类 `Service` 是通用服务注册/注销基类，不感知 Team 名册（`vendor/cordis/src/service.ts:11-24`）。其"服务随 fiber 卸载自动注销"（`service.ts:14-16`）是服务生命周期，不是成员回收。
- 全仓 grep `retireTeammate|removeTeammate|deleteTeammate|reclaimTeammate` 及 `retire|reclaim|removeMember|deleteMember|dropMember|releaseMember`：除一条与本主题无关的注释（`projection.ts:56` 的 "retired tool-result tags"）外零命中。

### 2.7 9 个 tool：没有任何删除类工具

`packages/experimental/tool-agent-team/src/index.ts` 注册的全部 tool（逐个列出，共 9 个；`defineTool(` 计数为 9）：

| tool | 位置 | 作用域 | 是否能删除成员 |
|---|---|---|---|
| `spawn_teammate` | `:235` | 成员创建 | 否（只增） |
| `send_message` | `:301` | 消息 | 否 |
| `list_agents` | `:319` | 读名册 | 否 |
| `wait_agent` | `:329` | 等待 | 否 |
| `interrupt_agent` | `:365` | 中断回合（仅 `config.interrupt` 开启时注册，`:363`） | 否 |
| `team_task_create` | `:378` | 任务 | 否 |
| `team_task_list` | `:408` | 任务 | 否 |
| `team_task_get` | `:440` | 任务 | 否 |
| `team_task_update` | `:455` | 任务 | 否（其 `action` 枚举 `:463` 里的 `delete` 是**任务删除**，对应 `TeamTaskAction`：`types.ts:233-241`；成员没有对应动作） |

- 模型提示词里同样没有任何"删除队友/释放名额"的指引：`teamPolicy`（`tool-agent-team/src/index.ts:35-43`）只描述 spawn/send/interrupt/task 工作流。
- 因此对模型而言，"清理队友"这件事在工具面上不可达——不存在被遗忘调用的隐藏工具。

### 2.8 `stopTeammates`/`drainChildren`：只 drain 子会话，不改名册（"停掉" ≠ "释放名额"）

| 事实 | 位置(file:line) | 影响 |
|---|---|---|
| `stopTeammates` 只调用 `drainChildren`，没有任何 journal 写入 | `packages/experimental/agent-team/src/roster.ts:229-231` | 名册条目原样保留 |
| `drainChildren` 的语义是"释放选中的常驻直接子会话执行句柄" | `packages/subagent/subagent/src/index.ts:380-394`（doc "Release selected resident direct children" `:380-389`、实现 `:390-394`） | 只回收**运行时激活**，不触碰 Team 事件日志 |
| manager 实现只 `dispose(activation)` 常驻激活，不做持久删除 | `packages/subagent/subagent/src/manager.ts:348-373`（`:352-362` 遍历 `resident` 收集目标、`:365-370` 逐个 dispose） | 子会话被摘除后，`members` 里那条快照仍在 |
| `interrupt` 只调用 `subagents.interrupt`，不写 journal | `packages/experimental/agent-team/src/roster.ts:192-203`（`:201`） | 中断后成员 phase 仍是 `active`，名额不变 |
| `disposeRuntime` 在服务释放时也仅 `stopTeammates`，不清理名册 | `packages/experimental/agent-team/src/index.ts:296-311`（`:303-309`） | 服务关闭不产生"成员移除"事件 |

### 2.9 旁证

| 事实 | 位置(file:line) | 影响 |
|---|---|---|
| 任务有墓碑：`delete` 动作把 `status` 置 `'deleted'`，且 `maxTasks` 只统计非 deleted 任务 | `packages/experimental/agent-team/src/task-board.ts:306`（置 deleted）、`task-board.ts:71-73`（`filter(status !== 'deleted').length`）、`task-board.ts:50`（doc "maximum non-deleted tasks"） | 任务上限是"当前占用"语义、可回收；成员上限没有对应机制——这是同一代码库里最直接的不对称 |
| 任务 ownerId 指向成员 SessionId，任务删除/完成都不释放成员 | `packages/experimental/agent-team/src/types.ts:87`、`task-board.ts:224`（claim 写 `ownerId: caller.id`）；README "No automatic ownership release"：`README.md:206` | 删任务只腾任务位，不腾成员位 |
| 名册持久在 Lead Session 日志里（"stored only in the Team Lead Session"） | `packages/experimental/agent-team/src/types.ts:270-271` | 重启后从日志恢复，名额不会清零（见 §4.4） |
| `TeamJournal.state` 直接读 root Session 的 `agentTeam` 投影 | `packages/experimental/agent-team/src/journal.ts:29-34` | 限额判定用的就是重放出的历史台账 |

---

## 3. 失效链：一个长程会话如何把名额吃满

前提：默认 `maxMembers = 16`（`index.ts:58`）；每次 `spawn_teammate` 无论最终成功与否，先在日志里写一条 `provisioning` 快照（`roster.ts:257-266`），失败则改写成 `failed`（`roster.ts:286-292`），永不删除。

1. **第 1 轮**：Lead 需要并行工作，`spawn_teammate` 3 次 → `members` 追加 3 条（`roster.ts:265` 各一次），计数 3/16。
2. **轮次结束，队友空闲**：成员进入 `inactive`。但 `inactive` 只是读取时按 live agent 计算的状态（`roster.ts:145-153`、`roster.ts:484-486`），耐久 `phase` 仍是 `active`；限额只看 `members.length`（`roster.ts:262`）→ 计数仍 3/16。
3. **第 2 轮**：需要新分工，但旧名字永久占用（`roster.ts:259-261`、`README.md:60`），只能起**新名字** → 计数 6/16。老队友无法复用为新角色（身份字段不可变：`projection.ts:299-301`）。
4. **偶发失败**：某轮 `spawn` 因 provider/启动/持久化失败报错。失败路径把它写成 `failed` 并 drain 子会话（`roster.ts:285-305`），**但名额不回收**（`roster.ts:262` 不看 phase；历史实测 `evidence/design/member-limit-probe.json` 中 `member-1` 变 failed 后 `rosterSize` 仍为 2）。概率性失败只会让墙提前到来。
5. **第 3~5 轮**：每轮继续新增 2~3 个名字 → 计数 9/16、12/16、15/16。此时"历史上有多少条成员快照"已达到 15，而当前真正在跑的可能是 0 个。
6. **撞墙那一轮**：下一个 `spawn` 在事务内判定 `15 >= 16` 不成立、成功写下第 16 条；再下一个 `spawn` 判定 `16 >= 16` 成立 → 抛 `TEAM_MEMBER_LIMIT`（`roster.ts:262-264`）。**此时一个子会话都没有被创建**，报错发生在 `startActivation` 之前（`:262` 在 `:269` 之前）。
7. **此后永久不可用**：该会话后续每轮想新建队友，都会在 `:262` 立即失败；`failed` 成员不可寻址（`roster.ts:49-53`）、`interrupt` 不写日志（`roster.ts:192-203`）、没有任何 API/tool 能减少 `members.length`（§2.6、§2.7）。会话只能继续在"剩余 16 个历史成员"里复用，或换新会话。
8. **重启不改变结论**：名册来自 Lead Session 日志重放（`journal.ts:29-34` + `packages/session/session-projection/src/index.ts:604-618`），resume 后仍是 16/16（详见 §4.4）。

> 可复述为一句根因：**"上限是累计创建数，不是当前占用数；而累计创建数永不减少。"**

---

## 4. 为什么现有机制救不了

### 4.1 `interrupt_agent` 救不了

- 它只做两件事：解析目标、调用 `subagents.interrupt` 中断当前回合（`roster.ts:192-203`）。
- 不写任何 `team/member` 事件（全仓只有 3 个写入点：`roster.ts:265/419/467`），因此耐久 `phase` 不变、`members.length` 不变、名额不减（`roster.ts:262`）。
- 而且它只能命中 `active` 成员（`resolveActiveMember`：`roster.ts:49-53`）；对已经 `failed` 的那部分"死名额"，连 interrupt 都做不到。
- 结论：中断是"停一下"，不是"注销"；语义上与"释放名额"无关。

### 4.2 让成员 inactive / 闲置 / 自然结束 救不了

- `inactive` 是**读取时**由 live agent 状态算出的视图字段（`roster.ts:145-153`、`roster.ts:484-486`），不是耐久状态迁移；成员耐久 `phase` 仍是 `active`。
- 限额判定只读 `this.journal.state(root).members.length`（`roster.ts:258`、`:262`），完全不查 `ctx.agents`（live 注册表）或 `status`。
- 成员 Agent 被释放/子会话被 drain 也不会产生成员事件（`stopTeammates` 只 drain：`roster.ts:229-231`；`interrupt` 不写日志：`roster.ts:201`）。
- 结论：空转的成员继续占 1 个名额，且没有任何"因闲置而回收"的钩子。

### 4.3 删除任务救不了

- 任务与成员是两个独立集合（`TeamState.tasks` / `members`：`projection.ts:164-165`）；`team_task_update` 的 `delete` 只把任务置 `deleted`（`task-board.ts:306`），并只释放 `maxTasks` 名额（因为 `maxTasks` 统计非 deleted：`task-board.ts:71-73`）。
- 成员侧没有等价的 `deleted`/`retired` 状态（`types.ts:51` 三态；`types.ts:78` 任务才有四态含 `deleted`）。
- 删任务也不会解除 owner 关系（`task.ownerId` 指向成员 SessionId：`types.ts:87`；README 明写 "No automatic ownership release"：`README.md:206`）。
- 结论：任务清空到 0 条，成员名额依旧 16/16。

### 4.4 重启会话 / 重启进程 救不了（对同一会话）

- Team 事件只写在 Lead Session 里（`types.ts:270-271`），`journal.state` 读的是该 Session 的 `agentTeam` 投影（`journal.ts:29-34`）。
- 投影恢复路径：优先用 checkpoint 行，版本不匹配或缺失则从 `seq 0` 重放全部事件（`packages/session/session-projection/src/index.ts:496-534`，`usable` 判定在 `:511-517`）；无 checkpoint 时 `buildCell` 也是 `init` 后折叠整份日志（`:604-618`）。
- 因此 resume 同一个会话 → 重放出的 `members` 与撞墙前完全一致 → `members.length` 仍 ≥ maxMembers → 仍然 `TEAM_MEMBER_LIMIT`。
- 服务层重载/HMR 也不会清零：`lifecycle.close()` 只是 abort 取消在途操作（`lifecycle.ts:46-48`），`disposeRuntime` 只 drain live 子会话（`index.ts:296-311`）；都不写成员移除事件，日志一条不少。
- 唯一"有效"的做法是换一个**新的 root Session**（`TeamId` = root session id：`types.ts:14-24`）——那等于放弃这个长程会话及其全部上下文/名册，不是"修复"，而是"重开一局"。
- 结论：重启只会把"满额"状态原样搬回来。

### 4.5 调大 `maxMembers` 救不了（只是把墙推远）

- `maxMembers` 是构造期从配置读入并用 `positiveLimit` 校验的部署级常量（`index.ts:75-80`、`:92-102`、`:95`），随后以 `readonly` 传给 roster（`index.ts:108`、`roster.ts:68`）；`TeamService` 没有任何改配方法（§2.6 的 12 个公有方法里没有）。
- 所以调大必须"改配置 + 重载 agent-team 服务"。重载后名册从日志重放，计数不变，只是把 16 改成更大的 N（`roster.ts:262`）。
- 语义仍是"一生累计总数"（`README.md:51`："Maximum teammates a team may ever create, including failed ones"），长程会话只要继续"每轮新建几个"，迟早再次撞上 N；而且每次失败创建也会消耗 1（`roster.ts:265`、`:286-292`、测试 `tests/team.spec.ts:331-341`）。
- 结论：调参是延后失效，不是恢复回收能力；根本问题是"累计只增"的计数模型，而非 N 的大小。
- 注：用户实际使用的 AI Compiler bundle 把 `maxMembers` 设为 **8**（`config/bundle-ai-compiler/bundles.patch.yml:69`），其真实会话中 4 次报错均为 `Team member limit 8 reached`，与该值一致（现场见 `evidence/design/team-member-reclaim-real-session.md`）。DSH 默认仍是 16（`index.ts:58`）。

### 4.6 综合

上述五条机制分别作用于"回合、会话加载、任务、进程、上限数值"，没有一条作用于"成员名册本身"。名册的唯一变更入口是 `spawn` 的追加（`roster.ts:265/419/467`），所以系统里不存在"移除"这个动作可被调用——这正是用户观察到的"没有任何清理/移除队友的机制"。

---

## 5. 附带说明：这是设计选择，不是实现 bug

### 5.1 语义与文档一致

- `maxMembers` 的官方定义就是"团队一生可创建的成员总数，含失败成员"：`packages/experimental/agent-team/README.md:51`（原文："Maximum teammates a team may ever create, including failed ones"）。
- 源码 JSDoc 同义："maximum immutable roster entries per Team"（`roster.ts:62`）、"Maximum immutable teammate names retained by one Team"（`types.ts:173-174`）。
- 名字永久性同样是显式设计（`README.md:60`；`roster.ts:444-453` 的 "never-reused"）。
- 局限清单直接写明"不可删除"：`README.md:205`："**Flat immutable roster** — ... there is no nested Team, rename, deletion, or name reuse."
- 失败成员占名且占名额被测试固定预期（`tests/team.spec.ts:331-341`），说明是刻意行为，而非忘记删除。

所以：**实现与文档自洽，根因不是代码缺陷，而是"名额=一生累计"的模型与"长程任务反复创建队友"的用法直接冲突。** 前者把名额当"历史台账长度"，后者需要的是"当前并发/在用席位"。

### 5.2 为什么不能"顺手删一条成员"而不破坏契约（重放视角）

即使只想加一个删除动作，现有契约也会挡住，原因都能在源码里看到：

1. **事件是整值快照，没有删除形状**：`team/member` 载荷就是一条完整 `TeamMemberSnapshot`（`types.ts:53-62`、`:271`），可写事件被收窄为 `team/member | team/task`（`journal.ts:9`），`appendAndFlush` 只能覆盖或追加（`journal.ts:60-72`）。
2. **状态折叠只有 replace-or-push**：`replaceAt` 命中即替换、未命中即 push（`projection.ts:279-284`、`:306`）；折叠函数里没有 splice/filter，删除无法表达。
3. **状态机没有删除迁移**：迁移被限定 `provisioning → active|failed`（`projection.ts:296-304`），并被重放测试锁定（`tests/projection-events.spec.ts:135-155`）。
4. **名字唯一性依赖成员集合**：重名校验同时存在于命令层与重放层（`roster.ts:259-261`、`projection.ts:292-295`）。若把条目从集合里真正删掉，重放历史日志时"同名不同 id"的校验语义会反转，旧日志可能无法重放；因此回收只能以"保留墓碑 + 不再计数"的方式表达，而不是物理删除。
5. **checkpoint 版本闸门**：`stateVersion: 4`（`projection.ts:440`），恢复时只有 `row.ver === stateVersion` 的 checkpoint 才可用，否则从 `seq 0` 全量重放（`packages/session/session-projection/src/index.ts:511-526`）。所以任何改变成员状态形状的改动都必须升 `stateVersion`，并保证旧日志仍能重放出等价状态。
6. **支持版本集合是白名单**：`SUPPORTED_TEAM_EVENT_VERSIONS = {2, 3}`（`projection.ts:235`）；新事件/新版本不在集合内会被判为 "unsupported Agent Teams event version" 并让整个投影进入 `failure` 终态（`projection.ts:269-276`、`:264`）。

结论：缺的不是一个 if，而是一套"退役/墓碑 + 可回收计数 + 平滑重放"的事件与状态版本设计。

---

## 6. 附：若要新增回收路径，现有契约要求改动的点（分析性，供后续任务参考）

以下不是本次结论，只是把"改动面"按源码位置列清，便于判断工作量与风险：

1. **事件域**：`types.ts:268-287`（`SessionEventMap`）、`projection.ts:209-213`（`TeamEventType`）、`projection.ts:223-228`（`isTeamEvent`）、`projection.ts:247-261`（`parseCurrentTeamEvent` + schema）、`projection.ts:286-359`（`applyCurrentTeamEvent` 新 case）、`journal.ts:9`（`MutableTeamEventType`）。
2. **版本闸门**：`projection.ts:235`（`SUPPORTED_TEAM_EVENT_VERSIONS`）纳入新版本；`projection.ts:440` 升 `stateVersion`（4 → 5），并按 `session-projection/src/index.ts:511-526` 确认旧 checkpoint 会被判定不可用而全量重放。
3. **状态语义**：`types.ts:51` 增加 `retired` 之类终态（或新增"墓碑"集合），`roster.ts:262` 的计数改为"未退役条数 / 活跃名额"；同时对齐 `listMembers` 的运行时状态（`roster.ts:145-153`）、wire 视图（`projection.ts:393-412`）与 `resolveActiveMember`（`roster.ts:42-54`）。
4. **名字策略**：需明确退役后名字是否可复用；不可复用则沿用现有双段校验（`roster.ts:259-261`、`projection.ts:292-295`）即可；可复用则必须靠墓碑（而非删除历史条目）来通过重放。
5. **工具面**：`tool-agent-team/src/index.ts:234-499` 增加第 10 个 tool（如 `retire_teammate`），并在 `teamPolicy`（`:35-43`）中加入相应指引。
6. **文档与测试**：`README.md:51/60/205` 的语义描述与 `tests/team.spec.ts:331-341`、`tests/projection-events.spec.ts:135-163` 的固定预期需要同步更新。

风险提示：第 2、3 点是破坏性契约变更（旧日志重放 + checkpoint 失效重建），需要单独的兼容性验证；不在本次审计（只读）范围内。

---

## 7. 未验证项

- ~~用户实际 profile 配置里的 `maxMembers` 取值~~ → **已核实**：AI Compiler bundle 为 8（`config/bundle-ai-compiler/bundles.patch.yml:69`），真实会话报错 "Team member limit 8 reached" 与之吻合（`evidence/design/team-member-reclaim-real-session.md`）；DSH 默认 16（`index.ts:58`）。
- 宿主/Web UI 是否有独立的"移除成员"入口：在 `packages`、`apps` 内 grep `agentTeam` 仅见测试与 API catalog，未见成员删除 UI；但 UI 组件分布不在本任务范围，标注**未验证**。
- 是否存在第三方插件通过反射/私有字段改写 `journal` 投影状态：**未验证**（正常路径不可能，`TeamJournal.state` 只读投影：`journal.ts:29-34`）。
- 历史实测 `evidence/design/member-limit-probe.json` 只覆盖"失败不回收"一个样本，未覆盖"16/16 后永久失败"的完整链路；该结论由源码推断（`roster.ts:262-264`）而非端到端实测。
