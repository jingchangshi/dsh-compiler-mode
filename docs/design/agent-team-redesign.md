> **已实现**：本设计已落地为 `patches/0002-team-roles-slots.patch`（见 ADR-013）。

# DSH Agent Teams 整体重设计：角色契约、容量槽位与成员代际

> architect 审阅稿，2026-11-03；任务 task-5。本文只提出设计，不实施源码、配置或补丁修改。
> 审阅基准：只读 `/tmp/reclaim-spike/repo`，由 Lead 恢复 0003 后重新读取的 0002+0003 源码；不是声称基线已经运行这些能力。初读时副本仅含 0002，该临时状态已排除出下文结论。

## 1. 结论摘要

**推荐混合方案：角色是一等契约，少量核心槽位保留，弹性成员按角色按需创建；DSH 负责模型选择、容量准入、同角色复用与失败重建。** 不推荐把“8 个永不更换的成员名字”当作长期架构，也不推荐继续依赖角色盲 LRU 加“优先复用空闲队友”的自然语言约定。

用户担心“探索工作会发给空闲 architect”是真实风险，但因果必须准确：**回收不会把消息自动改投 architect。现有发送路径只查精确名字与 active phase，没有任何自动替代路由。角色误发来自任务需求、成员身份、模型路由没有共同的机器可验证契约；回收、容量压力和无条件复用提示会放大 Lead 的错误选择。** 即使完全关闭回收，这一风险也存在。角色模型昂贵或能力不同，会把错误进一步放大为成本漂移和工作质量风险。

更本质的问题是把四种不同责任交给了“成员名字”：岗位发现、具体执行者身份、上下文容器、容量占用。0002 分离了“历史台账”和“当前占用”，解决累计名额墙；0003 仍没有分离“角色承诺”和“可替换执行者”，也没有让路由与回收共享一致的准入边界。

本轮还发现 0003 的确定性实现缺陷，必须先修：空闲时间键错误导致 LRU 退化；失败成员并非立刻回收；重名请求可能先淘汰其他成员；回收候选与任务认领/发送之间存在竞态。**P1 的优先级是纠正这些事实与安全边界，并引入最小角色校验；P2 再完成槽位与代际。** 本文没有运行补丁测试，新增复现及目标实现均标为待验证。

## 2. 证据范围与独立问题复核

### 2.1 阅读材料与证据优先级

已读 [根因审计](</home/s00653124/workspace/dsh-compiler-mode/docs/design/team-member-reclaim-rootcause.md>)、[A–F 方案](</home/s00653124/workspace/dsh-compiler-mode/docs/design/team-member-reclaim-solution.md>)、[总览](</home/s00653124/workspace/dsh-compiler-mode/docs/design/team-member-reclaim-summary.md>)、[ADR-011/012](</home/s00653124/workspace/dsh-compiler-mode/docs/03-decisions.md#L171>)、[角色配置定稿](</home/s00653124/workspace/dsh-compiler-mode/docs/design/role-config-final.md>)、[角色模型路由研究](</home/s00653124/workspace/dsh-compiler-mode/docs/design/role-model-routing.md>) 与 [运维口径](</home/s00653124/workspace/dsh-compiler-mode/docs/09-operations.md>)。

旧审计描述的是未打 0002 的累计名额模型，不能直接代替当前副本。下表及后续源码行号均指恢复后的只读副本；角色路由实测采用上述定稿记录，未重复做 live E2E。新接口、字段、模块明确标注为“拟新增”，不表示现有 API。

| 源码事实 | 直接依据 | 判断 |
|---|---|---|
| 持久成员有 id/name/description/provider/context/phase/error，没有业务 role、slot 或 pinned | [types.ts:54](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/types.ts#L54>) | description/prompt 中的角色无法被命令层验证 |
| 现有 role 是 lead/teammate 的成员资格，非 architect/explorer | [types.ts:68](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/types.ts#L68>) | 不应直接把现有 role 联合类型改成七角色，须另加 roleId |
| send 按 name 查 active 成员，随后向该 id 的子会话发送 | [roster.ts:43](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L43>)；[index.ts 的 sendAdmitted 模块](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/index.ts>) | 找不到会拒绝；不会自动转给其他空闲成员 |
| 只数非 retired，名字查重覆盖历史墓碑 | [roster.ts:396](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L396>) | 容量可恢复；同名旧实例不能复活，但同角色新名字可以新建 |
| 回收跳过 provisioning/running、有 open task 的 active 成员；不看业务角色 | [roster.ts:94](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L94>) | “下一轮仍需要这个角色”的需求无法表达；不能说它会正常回收正在跑的长任务 |
| 退役拒绝 running/provisioning，先 drain 后落 retired，重复调用幂等 | [roster.ts:297](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L297>) | 是显式生命周期变化，不是暂停；不能把 send 当作恢复 retired 的手段 |
| policy 只要求优先复用 idle，没有限定“同角色且能力/上下文兼容” | [tool index.ts:35](</tmp/reclaim-spike/repo/packages/experimental/tool-agent-team/src/index.ts#L35>) | 这是诱导因素，无法据此量化“很可能误发”的概率 |
| task ownerId 是具体 SessionId；claim/reassign 未校验业务角色 | [task-board.ts:217](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/task-board.ts#L217>)、[task-board.ts:282](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/task-board.ts#L282>) | 只给 send 加 expectedRole 仍会留下任务板旁路 |
| 事件严格 schema，身份不可变，retired 为吸收态；stateVersion=5 | [projection.ts:76](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/projection.ts#L76>)、[projection.ts:288](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/projection.ts#L288>)、[projection.ts:450](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/projection.ts#L450>) | 新字段不能随意塞进旧事件；任何新生命周期必须有重放与版本方案 |

### 2.2 对原问题链的纠正

1. **角色盲回收成立，LRU 现状却并非真正 LRU。** 角色相位交替会产生淘汰下一轮所需角色的合理风险；没有负载统计，不能断言概率或频率。且当前实现有 §2.3 的计时键错误，实际行为通常先退役最早创建的合格成员。
2. **“名字不可复用，所以角色永久消失”表述过强。** 永久消失的是那个名字和具体成员的可寻址性；角色并非持久实体，可用新名字重建相同职责/模型，但当前需要 Lead 自己记住映射和交接。槽位解决稳定寻址和自动恢复，不是为了允许重用旧成员名字。
3. **固定 8 个成员确实没有第 9 个成员的同时准入余量，但固定角色不等于预热 8 个成员。** 稳定的逻辑岗位可按需创建、不一定消耗 8 个物理成员。纯固定名字方案中一次 provisioning 失败不会使“业务职责”永远无法执行，只会封死原名字，且没有透明替代机制。
4. **“spawn-per-task 是反模式”不是通用系统不变量。** 独立上下文、污染隔离、失败替代和不同阶段模型确实可能需要新成员；问题是无约束地以任务名字代替岗位与容量管理。长程任务既需要同角色复用，也需要受控重建。
5. **自动管理不等于每次 spawn 必成功。** 所有成员 running、有任务、被 pin 或角色并发已满时，必须排队/返回有原因的背压。退役有用角色或换一个不匹配角色不能算成功管理。

### 2.3 0003 现状缺陷：和目标设计分开

| 编号 | 现状与源码依据 | 影响及证据强度 |
|---|---|---|
| D1 空闲时间使用错误键 | [roster.ts:81](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L81>) 以 membership.id 写 map；[roster.ts:172](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L172>) 返回 TeamId(root.id)；[roster.ts:115](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L115>)、[roster.ts:123](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L123>) 按 member.id 读 | 正常不同 SessionId 下全 miss，回落 startedAt。grace 变成距服务启动的时长，排序相等时按名册次序退役最早创建的合格成员。源码确定性推导，Lead 独立复核认可；未新增执行测试 |
| D2 “失败立刻退役/下一次 spawn 必清除”不符合实现 | [roster.ts:129](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L129>) 在未满额时直接返回；[roster.ts:430](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L430>) catch 只 settle failed 并 drain | 精确口径是“满额时 spawn 优先尝试回收 failed”；未满额 failed 仍占计数。policy 与 Config 注释过度承诺。failed 分支还先于 owned 判断，不能宣称所有 failed 也受 open-task 保护 |
| D3 非法请求可能先淘汰有用成员 | [roster.ts:394](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L394>) 回收先于 [roster.ts:398](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L398>) 重名校验 | 满员、有合格受害者时，历史重名 spawn 可先退役其他人，再 NAME_TAKEN；不存在有效新成员却损失旧上下文。未新增执行测试 |
| D4 候选检查与使用不原子 | [roster.ts:94](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L94>) 在事务外读 owner/running；[roster.ts:315](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L315>) 检查 running 后 await drain；[roster.ts:322](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L322>) 仅重读 phase；[task-board.ts:147](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/task-board.ts#L147>) 的 claim/reassign 可排入另一事务 | 可能退役刚获得 open task 的成员；send 也不共用回收准入锁。源码显示竞态窗口，具体调度复现待验证；不能说 journal 的串行写盘自动保护了事务外的 drain/投递 |

D1 应改成用 agent.id 记录空闲时间，**不修改 TeamMembership.id 的 TeamId 语义**，否则通知/任务调用者会受影响。修正后冷重启没有既往 idle 数据时，从启动时开始重新等待完整 grace；这是一种保守冷启动规则，不冒称恢复了历史 LRU。

D3 的最小承诺是“可在无副作用阶段确定为无效的请求不得淘汰成员”。provider 首次请求、网络或凭据仍可能在启动后失败，不能承诺预校验消除全部失败。

## 3. 目标架构与数据责任

### 3.1 三种身份必须分离

| 概念 | 拟新增字段/标识 | 生命周期与责任 |
|---|---|---|
| 角色 Role | roleId、roleRevision、职责、能力类别、允许路由、并发上限、默认上下文策略 | 部署声明、团队启动时绑定版本；决定“这类工作交给谁/成本上限是什么” |
| 槽位 Slot | slotId、revision、roleId、pinned、currentMemberId、generation | Team 内稳定，可空置；代表一个容量位置及稳定岗位。预留槽不等于已经启动模型 |
| 成员 Member | 现有 SessionId 与永久 name，加 roleId/slotId/generation/routePolicyRevision | 一次具体上下文实例；provisioning→active/failed→retired；旧实例永不复活、旧名字永不复用 |

示例为拟议数据，不是当前可调用 API：

```text
role explorer: maxConcurrent=2
slot explorer-primary: role=explorer, pinned=true
  generation 1 -> member name=explorer-primary-g1, id=session-A (retired)
  generation 2 -> member name=explorer-primary-g2, id=session-B (active)
flex slot flex-2: role=implementer, pinned=false
  generation 1 -> member name=flex-2-g1, id=session-C
```

角色可有多个 slot；slot 的不同 generation 只能有一个非 retired 成员。reserved slot 的 roleId 不变；flex slot 只有在旧成员退役、任务与消息租约清空后才能改角色并递增 generation。名字由 DSH 生成，保证格式和 64 字符上限；slotId 与 roleId 使用独立命名空间，不把 role alias 混入历史成员名字。

保留现有 role='lead'|'teammate' 作为权限身份，业务职责使用 roleId。Lead 不进入 teammate slots、maxMembers 或 per-role worker 计数；不能通过请求 roleId='lead' 获得 Lead 权限。

### 3.2 混合容量：以 8 为例

“7 角色”包含 Lead，因此是 6 种 teammate 角色。architect、explorer、implementer、reviewer、challenger、validator 各一份为 6 个；explorer 与 implementer 各增一份后为 **8 个 teammate，余量 0**。既有“7 角色余量 1”的字面口径不能用于推导此配置。

推荐部署默认（是提案，可调，非硬编码七角色）：

| 角色 | 角色最大同时占用 | 默认槽位策略 |
|---|---:|---|
| architect | 1 | 一个 reserved/pinned slot，延迟启动 |
| reviewer | 1 | 一个 reserved/pinned slot，延迟启动 |
| explorer | 2 | 一个 reserved/pinned primary；第二份申请 flex |
| implementer | 2 | 一个 reserved/pinned primary；第二份申请 flex |
| challenger | 1 | 按需申请 flex |
| validator | 1 | 按需申请 flex |

4 个 reserved + 4 个 flex = 8 个容量位置。primary 角色槽位稳定，四个 flex 可用于两个副本及 challenger/validator，也可在它们未被需求占用时承载已声明的临时角色；不允许 Lead 临时编造未知角色绕过成本限制。纯默认六角色配置的各角色峰值之和为 8，全部同时使用时没有额外临时角色余量，此时排队。

maxMembers 定义继续是**非 retired 的已准入 teammate 实例数上限**（含 provisioning，旧 failed 在清理前也计数），不是正在运行的 turn 数、不是总历史数。再增加策略约束 `reservedSlots + maxFlexSlots <= maxMembers`，以及 `nonRetiredByRole <= role.maxConcurrent`。空 reserved slot 不增加实例计数，但其容量承诺不借给 flex，因此实际可准入仍受槽位策略限制。降低 maxMembers 不会强杀现存成员；冻结新增，待自然释放满足新限制；保留槽位总量不合法则配置启动失败。

pinned 精确定义：**保留槽位职责与成功成员的上下文，不因空闲自动退役**。不是“失败实例永不退役”，不是“running 可强杀”，也不要求开局预热。失败的 pinned 成员可以退役，slot 保留，后续同 role 重建。显式重置 pinned 上下文必须是有原因的 Lead 管理动作；默认调度不得为了别的角色挪用其 slot。P1 的实例级 pinned 是这一语义的暂时子集，P2 才实现持久 slot。

### 3.3 角色模型与成本契约

角色表使用 [已验证的定稿值](</home/s00653124/workspace/dsh-compiler-mode/docs/design/role-config-final.md#L7>)：

| 角色 | 模型 provider | 模型 | 默认上限 |
|---|---|---|---|
| lead | magpie | auto/deepseek-v4.1-flash | 由 Lead 配置管理 |
| architect / challenger | magpie | codex/gpt-6.1-sol | 各最多 1 个 teammate |
| explorer | corp | Qwen3.8-Flash | 最多 2 |
| implementer | corp | DeepSeek-V4.1-Flash-1017 | 最多 2 |
| reviewer | corp | GLM-5.3-Flash | 最多 1 |
| validator | magpie | auto/mimo-v2.6-flash | 最多 1 |

快照中的 provider 是 spawn/fork 后端，不能拿它与 magpie/corp 比较。目标字段使用 backendProvider 和 resolvedRoute.provider/model 区别语义；旧 provider 字段保持不动。role registry 产生完整模型 provider/model 覆盖，禁止遗漏后继承 Lead 错误模型；若兼容保留 agentOptions，只有与角色允许路由相符才接受。能力与成本降级必须来自已声明的候选链，结果附实际路由，不跨角色静默降级。

reasoningEffort 全部省略；本机六模型 reasoning=null，显式值会失败。maxTokens 全部省略，采用模型 provider 声明值；不能把“省略后由声明值生效”解释成存在服务端强预算校验。实测框架不校验模型上限，故新成本策略若支持输出硬限制必须单独验证。角色并发与模型 allowlist 是 P1 可实现的成本约束；累计金额/令牌硬预算需要可靠 usage/price 来源、持久扣账及在途预留，**当前审阅未验证该接口，不能宣称现有实现已有或绝无此 API**。

冷恢复沿用现有 descriptor 路由机制，依据 [路由研究中的持久化证据](</home/s00653124/workspace/dsh-compiler-mode/docs/design/role-model-routing.md#L28>)。新代际另保存角色/策略版本和解析后路由以便审计；不能用 inactive roster 中缺失的 model 值回填 Lead 模型。新 registry 变更不追溯改写已创建成员；老会话继续原 policy revision，显式迁移才影响下一代。P1 在成员创建事实中保存足够的角色/路由策略快照，不能仅存不可解析的版本号；P2 再统一到 topology 的不可变团队策略。若旧版本策略不可获得，应拒绝新 managed 创建并报策略缺失，不能默默使用当前默认值。

新 generation 也不代表自动继承旧成员的全部上下文。调度器应从任务板、已提交结论及交接产物构造有界启动材料，保留原成员 SessionId 供审计；交接指针必须可恢复，内容缺失时标明缺口。不得把退役成员仍有未提交工作解释成可无损重建。成功 pinned 成员保留原 continuation，正是为了保护这种不可轻易重建的长期上下文。

## 4. 路由、调度与自动管理

### 4.1 创建和复用

拟议 managed spawn 输入是 roleId、任务说明、可选 slotId；name、模型路由、角色提示由 DSH 生成。底层现有 raw spawn 仅保留给未启用 managed mode 的兼容调用。

准入顺序：

1. 验证角色存在、角色版本、路由允许、slot 属于该角色、请求字段及已有名字冲突。可确定无效的请求在此无副作用失败。
2. 如果请求是分派而非要求隔离上下文：只在同 role、同能力契约、上下文允许复用的成员中选择；“便宜/空闲”本身不足以匹配。独立 fresh 需求不可强塞给已污染的上下文。
3. 同时满足全局容量、角色并发、槽位占用和预算约束后，记录 slot generation 与 provisioning。并发两次创建同一 slot 仅有一个成功准入。
4. 需要空间时，优先清 failed 实例；再考虑无任务/投递租约、非 pinned、非 running、超过 grace 的 flex 成员。角色保障和待派任务优先级先于 LRU。只淘汰跨角色资源的执行实例，不删除角色定义或 slot 历史。
5. 没有合格容量就进入有上限的等待队列或返回结构化背压：包含受限角色、running/pinned/task/lease 阻塞原因及可重试条件。重试不产生第二份任务或第二条初始提示；不得把请求转给 architect 以“完成派发”。

P2 的任务调度按 taskId/revision 处理，身份为一次 assignment attempt；并行重复请求通过该标识去重。采用有限公平队列、按任务依赖 readiness 放行，避免长期角色饥饿。provisioning 失败使用指数退避和有限重试；超过阈值报告错误，不无限创建名字或烧钱。队列、已提交分派意图和重试计数须可恢复；内存 cache 不是权威。

### 4.2 send_message 与任务板必须共同校验

必须区分“联系某个人”和“分派一类工作”：

- **精确成员消息**沿用 target=name。新可选 expectedRole/expectedGeneration 用于断言；不匹配直接拒绝，不搜索另一成员。retired 名字始终失败，不把旧 target 自动解析到新 generation。
- **任务分派**在 managed mode 必须引用 taskId 与 expectedRevision，任务持久字段 requiredRole（P1 拟新增）必须匹配当前成员 roleId；claim/reassign 与发送同样验证，防止任务板成为旁路。roleId 不从任务 prose 自动猜测。
- **按 role/slot 分派**是 P2 拟新增操作，不复用裸字符串 target 的含糊命名空间。Lead 提交角色需求；DSH 选择合格 slot/currentMemberId，并把实际成员、generation、路由和排队原因返回给 Lead。
- **普通协作通信**允许 explorer 向 architect 请教，不能把“跨角色发一条信息”全禁掉。新 managed Lead 的工作分派走任务路径；普通 message 是 communication，不授予任务所有权。无法从自然语言可靠识别“把探索任务伪装成普通消息”，因此角色契约不能承诺语义零误判。

若 Lead 把探索任务的 requiredRole 本身标错为 architect，结构校验仍可能通过。可通过角色职责上下文、任务模板、日志审计以及后续质量评估降低该剩余风险；不靠关键词分类器宣称完全消除。若要求读写能力真正隔离，还须独立实施权限/工具限制；roleId/prompt 不构成文件安全边界。

### 4.3 同步边界、退役与崩溃恢复

[TeamJournal.transact](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/journal.ts#L42>) 只串行它所包围的 mutation；当前 send 和 drain 不在同一边界。目标必须为“校验→取得投递/工作租约→回收关闭准入”提供统一协议。

P1 最低可行实现：在现有生命周期内新增 per-Team 准入协调器（内部模块，拟新增），让 managed spawn/reclaim、send 的目标准入、task claim/reassign 以及显式 retire 都参与。自动退役原子地重新检查 role/pin/open-task/running/租约并关闭该成员的新准入，再 drain、落墓碑；失败则恢复可用准入或保留明确的失败状态。普通发送持有有界租约直到 inbox 接受；租约归零之前不能自动退役。不能仅在 drain 后再检查任务，因为那时已经伤害运行状态。队列锁顺序统一为准入协调器→journal；不在 journal 队列中等待可能回调 Team 的 drain，防止死锁。

P1 不增加 durable retiring phase：崩溃时未落盘的关闭准入消失，成员仍 active、可由原 continuation 恢复；落盘 retired 后则永不重新接收。这以保留现有“先 drain 后墓碑”的恢复口径为前提，必须用屏障测试证明无死锁和已接收输入丢失。若现有子会话生命周期无法满足这种协调，P1 应先关闭 active 自动回收，保留 failed 清理和显式退役；不能用未经证实的锁方案交付安全声明。

P2 将 slot 更新、generation 绑定、任务 assignment intent 和成员状态一并纳入可恢复的协议：先在 journal 下持久化已准入分派意图/slot reservation，再启动或投递，最后记录接受结果。现有 send 没有 Team 级 retry/dedup，不能盲目承诺 exactly-once；必须以 task assignment attempt 的标识配合子 inbox 接受事实恢复。若无法确认是否接收，则标记需协调，禁止不加判断地重发。方案的具体投递去重实现是 P2 验证项。

### 4.4 “用户零提示词”的边界

用户只选择已有模式并描述业务目标；不要求用户输入角色表、模型参数、回收指令或正确复用提示。DSH 从部署的 role registry 生成：Lead 的紧凑能力目录、teammate 的角色身份与边界、工具参数、结果中的下一步与背压原因。模型仍负责任务拆解和 requiredRole 的业务选择，运行时负责验证和执行，二者不能混淆。

角色职责长文本按需取，不把七份说明重复塞入每回合；身份与重要约束保持可见。结果返回 taskId、slotId、generation、实际成员和路由，审计详情按 id 获取。P1 修改工具文案时比较首回合 prompt token 数，目标减少重复规则而非单纯增加长 policy；用角色相位交替的长程评估观察误发/重建/费用，而不是以一个工具注册成功作为验收。

## 5. 不变量与兼容矩阵

| 契约 | 保留或新增规则 | 迁移/失败行为 |
|---|---|---|
| 严格 projection 重放 | fold 只依赖事件，不能读取当前 registry、wall-clock、live status 决定历史成员角色或是否被退役；非法迁移保持 failure 终态 | 空闲和路由决策在命令侧做，提交后的事实重放；同日志全量与 checkpoint+tail 结果相同 |
| team/member 版本 | 当前 reader 支持 2/3，writer provisioning/settle 写2、retired写3；P1 新角色字段写拟议 v4，P2 slot代际字段写拟议 v5 | 为各版本显式 schema/兼容转换；保持历史已接受 v2/v3 语义，不借升级追溯收紧老日志。不要把全局支持版本集合当成每种 event 都支持任意版本 |
| stateVersion | 当前5；纯D1/D3修复及文案变动不升；P1持久角色/任务字段升6；P2 topology/slot/assignment状态升7（拟议） | 旧 checkpoint 不直接重解释，依现有机制从0 refold；实际落地若中间已有版本，取下一空闲版本。超长日志评估首次加载代价 |
| 名字永久性 | member name 永久不复用，id 始终 SessionId，retired 吸收态，保留墓碑 | slot alias 可绑定新一代，但旧成员 target 不重定向；不能改 projection 同名约束来实现 slot |
| immutable identity | roleId、roleRevision、解析后路由、slotId/generation 一经成员创建不可变；pin策略独立管理 | P1实例级 pin为创建时不可变元数据；后续 pin动作应走独立版本化政策记录，不能滥用 active→active 快照 |
| task ownerId | 始终指向执行成员 SessionId，绝不改为roleId/slotId | 新一代不继承旧owner；通过正常revision递增的reassign/release迁移，完成任务保留历史owner。显式retire如允许留open task，必须列出并要求调度修复；自动retire禁止此情况 |
| task字段 | P1 requiredRole，P2 assignment attempt/role revision（拟议） | 新带角色任务写拟议 team/task v4；P2再升相应版本。旧task无requiredRole即legacy，不猜；保留依赖图与completion receipt/requirement不可削弱检查 |
| 客户端状态枚举 | MemberStatus 仍为 running/inactive/provisioning/failed/retired | role、pin、slot空缺、排队、backoff是独立字段/展示，不伪造成员status；若未来加phase须同步所有闭合schema及本地化 |
| maxMembers | 非retired已准入实例上限；Lead排除，reserved空slot不计实例但占容量承诺，running turn另计 | 不按live注册表计数，重启不自动释放已准入名额；默认16、bundle8均保持可配置 |
| legacy成员 | roleId缺失即unclassified/legacy；不从name或description推断 | 可精确消息与审计；不得被managed role路由选中。允许其自然完成任务；显式映射须记录独立迁移事实，或退役后新建，不伪造旧创建事件 |
| 降级 | 0002 reader不支持v4，旧member strict schema不认识新字段；P2新事件也需要更新事件域/Session类型 | 停止新写入后，旧程序仍不能安全读取已含新记录的日志。源码patch逆向apply≠日志降级；备份/隔离新日志或采用forward修复。禁止删字段/墓碑/历史事件以回滚 |

P2 拟新增 `team/topology` 全值事件，承载团队绑定的角色策略版本、slot集合及其revision；slot更新必须校验当前成员存在、角色匹配、generation递增、唯一占用。这个类型**当前不存在**，需要同时更新 SessionEventMap、TeamEventType、isTeamEvent、journal可写联合与投影 schema，不作为外置插件私自追加未知事件。旧程序可能在 Session 解码层即拒绝未知事件，不能假设只会“忽略它”；版本门禁和降级测试必须覆盖 Session 打开与 Team failure 两层。

对成员与slot多事件提交，不能假设 flush提供数据库多事件原子提交：事件序列必须允许可恢复的中间态（reservation→member provisioning→binding/settlement），每步重放可验证，恢复器收敛未完成reservation。role registry 的完整决策数据或可用的不可变策略快照随 topology 固定，不能只存一个重启后可能找不到的 hash。

## 6. 分阶段路线与文件级清单

下列都是后续实施清单，本次只写本文。模块路径均为当前已读包或明确标为拟新增；源码行号以本次 0002+0003 副本为准。部署流程延续 [ADR-011](</home/s00653124/workspace/dsh-compiler-mode/docs/03-decisions.md#L171>) 的 pinned capability patch→可逆检查→Host重建，不能只改bundle声称新增了服务能力。

### P0：零改动的即时工作策略

**改动文件：无。迁移：无。** 当前部署暂用明确的角色名字与已验证角色表；Lead 复用前读取名册和任务板，只给职责/模型相符的成员派活。核心角色尽量复用，在满员时减少新建；创建失败后用新名字重试，不重用历史名字。固定8成员不能得到pin保护，不应宣称现有DSH会保留固定岗位。

P0不包含改persona或关闭自动回收配置，后两者都是改动，不称“零改动”。如需关闭active回收，可在已授权部署变更中设置memberIdleGraceMs=0并保留autoRetireFailed，归入P1运维变更。P0仍依赖Lead遵守约定，**不能满足角色硬校验和完全自动管理目标**。

验证：不新增源码测试；只读检查每次实际target与预期角色/子会话request/header一致，记录相位交替时是否发生重建或误发。风险：名册历史角色不可机器验证、D1/D3/D4依然存在，因此仅为过渡。

### P1：低风险、可单独发布的修正与最小角色契约

分两个可独立审查的提交：P1a修复0003行为和文案，不改持久形状；P1b增加可选角色元数据与managed mode，新事件/state版本发布。低风险是相对P2而言，P1b仍属于有迁移门禁的协议变更。

| 文件/模块 | P1拟议改动 |
|---|---|
| [agent-team roster.ts:81](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L81>)、[roster.ts:94](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L94>) | D1用agent.id键，删除/更新时间与member一致；缺少观测时间按冷启动保守grace。D2明确清理时机；先做请求无副作用校验再回收。自动候选加pinned/role保障/任务与投递租约检查 |
| [roster.ts:297](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L297>)、[roster.ts:368](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L368>)、[index.ts 的 sendAdmitted 模块](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/index.ts>) | 使用统一准入协议；automatic退役与explicit退役区别校验；send校验expectedRole/task约束；重复/非法spawn不淘汰成员 |
| agent-team/src/admission.ts、role-policy.ts（拟新增模块） | 前者协调send/claim/reassign/retire的租约与关闭准入；后者持有已声明role→路由及并发规则，避免在tool/service重复实现策略 |
| [types.ts:54](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/types.ts#L54>)、[types.ts:176](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/types.ts#L176>)、[types.ts:203](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/types.ts#L203>) | 可选roleId/roleRevision/pinned/resolvedRoute元数据；Config声明角色策略；spawn角色字段，send断言/task引用；task requiredRole及对应请求/视图字段；member v4/task v4 |
| [projection.ts:76](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/projection.ts#L76>)、[projection.ts:132](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/projection.ts#L132>)、[projection.ts:288](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/projection.ts#L288>)、[projection.ts:450](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/projection.ts#L450>) | 按事件版本解析；旧值等价折叠；新身份不可变；wire/schema同步；stateVersion5→6。角色新task与owner匹配校验不得追溯否定旧legacy任务 |
| [task-board.ts:217](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/task-board.ts#L217>)、[task-board.ts:282](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/task-board.ts#L282>) | claim/reassign也校验requiredRole/成员有效性并参与准入协调；保留CAS、依赖图、completion policy |
| [tool index.ts:35](</tmp/reclaim-spike/repo/packages/experimental/tool-agent-team/src/index.ts#L35>)、[tool index.ts:53](</tmp/reclaim-spike/repo/packages/experimental/tool-agent-team/src/index.ts#L53>)、[tool index.ts:245](</tmp/reclaim-spike/repo/packages/experimental/tool-agent-team/src/index.ts#L245>) | policy改成“复用同角色且上下文兼容成员”；managed spawn从角色填路由，不要求Lead填模型表；send/task schema及输出元数据一致；纠正lifetime/失败立即退役文案，区分精确消息和任务分派 |
| [TeamAction.tsx:27](</tmp/reclaim-spike/repo/packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx#L27>) 与同包 [locales.ts](</tmp/reclaim-spike/repo/packages/experimental/client-ui-agent-team/src/client/locales.ts>) | 状态枚举保持5态，另展示role/pin/legacy/实际路由；计数区分当前占用与墓碑；补真实成员状态字典，不改仅含meta的locale JSON来冒充状态本地化 |
| 后续交付的capability patch、[安装/补丁管理模块](</home/s00653124/workspace/dsh-compiler-mode/scripts/lib/harness-patches.mjs>) 与 [安装脚本](</home/s00653124/workspace/dsh-compiler-mode/scripts/install.sh>) | 为固定基线生成下一份补丁；冲突失败、不fuzzy apply；按链顺序应用/逆序退回源码并重建；检查built lib包含新能力，不能误报已部署 |
| [ADR-012](</home/s00653124/workspace/dsh-compiler-mode/docs/03-decisions.md#L198>)、[运维说明:13](</home/s00653124/workspace/dsh-compiler-mode/docs/09-operations.md#L13>)、[总览](</home/s00653124/workspace/dsh-compiler-mode/docs/design/team-member-reclaim-summary.md>)、agent-team包README模块 | 文案明确失败清理时机、pin例外、角色复用条件、容量背压；运维failure表删除“lifetime exhausted”的旧口径；说明源码回滚与数据兼容区别。以上本次均不修改 |

D2推荐P1a先采取**如实修正文案**，保留“满额spawn清failed”的当前机制，减少异步清理引入的竞态。若决定提供“失败终结后立即释放”，须在settle/catch/reconcile共用路径、drain成功后写failed→retired，并与并发admission协调；这是另一项明确行为变更，单独测试，不将注释当成功能。

P1迁移：不开managed mode的旧调用保留原精确name行为；旧日志重放后role缺失为legacy。新managed任务必须requiredRole，新managed成员必须roleId；旧任务完成不受新角色表阻断。已有核心成员不能凭名字自动pin/归类；先完成任务再建立带元数据的新成员，或后续显式迁移事件。P1没有slot，所以失败pinned成员仍需DSH按role生成新名字，无法对外承诺稳定slot target。

### P1 缺陷门禁：每条有复现、修复点和通过条件

以下是待编写/执行用例，**不是已经通过的测试结果**。使用fake clock与可控屏障，不用随意sleep证明时序。

| 缺陷/约束 | 必须复现的用例 | 修复点与通过条件 |
|---|---|---|
| D1 | 两成员先后idle，创建顺序与idle先后相反；服务运行超过grace后，刚idle者不应被立刻回收；再测两个Team同名成员 | [roster.ts:81](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L81>) 改agent.id；[roster.ts:115](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L115>) 一致读取。按成员真实idle时长淘汰；grace与Team隔离正确；重启重新等完整grace |
| D2 | maxMembers=3，失败1次后再成功spawn1次，应观察failed仍存在；到满额再spawn才优先回收failed | [roster.ts:129](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L129>) 保留当前触发范围时，policy、Config注释和ADR/operations全部对应实际行为；若改立即清理，则另测settle/reconcile/drain失败分支 |
| D3 | 满额、合格idle受害者存在，提交历史重名请求；也测不存在role/不允许route | [roster.ts:394](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L394>) 前预校验、事务下重新确认；返回原错误且成员集合/phase未变、没有retired事件 |
| D4-owner | 在候选选出与drain之间插入claim或reassign，分别让任务赋予受害者；反向让回收先拿关闭准入 | [roster.ts:297](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts#L297>) 与 [task-board.ts:217](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/task-board.ts#L217>) 共用准入。前者先成功则回收拒绝；回收先成功则claim/reassign拒绝或重选，不留下open task指向自动retired成员 |
| D4-send | send已选target但未inbox接受时，另一请求回收；再反向插入send；测试drain失败与超时 | [index.ts 的 sendAdmitted 模块](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/index.ts>) 与admission协调。已接受投递不因回收丢失；已关闭准入不得再接受；错误可重试、无锁泄漏/死锁 |
| 角色误发 | explorer requiredRole任务发送/claim/reassign给architect；直接显式message请architect评审探索结论 | 三个工作入口一致拒绝角色不匹配，无实际inbox工作投递；普通请教仍允许。无合适explorer时排队或背压，不退化为architect |
| pin/成本 | 满员且仅pinned idle；failed pinned；路由不在allowlist、部分agentOptions继承Lead | 成功pinned不自动淘汰；失败实例可清但职责保留；非法路由在副作用前拒绝，实际child header与role策略一致 |

补充发布门禁：沿用 agent-team 的 team/projection-events/completion 测试模块和 tool/client 包测试；新增旧v2/v3日志fixture→v6全量重放、checkpoint失效重建、非法新identity修改→failure；三包类型构建、补丁apply/idempotent/revert/conflict与built lib检查。再通过现有Web Host执行长程“探索→实现→设计→探索”回合，核对子会话实际request/header；不另起替代服务器冒充现有GUI验收。

P1主要风险：准入协调死锁、旧任务兼容漏项、strict tool/wire schema漏同步、pin导致容量不足。若D4门禁不通过，关闭active自动回收再发布，其余角色校验与failed回收仍有价值；不能以“多数时候闲置”豁免竞态。

### P2：结构性角色/槽位/代际管理

| 文件/模块 | P2拟议改动 |
|---|---|
| agent-team/src/roles.ts、slots.ts、scheduler.ts（拟新增） | 不可变角色策略快照、reserved/flex分配、slot revision/generation、持久等待意图、有限重试与公平队列 |
| [types.ts 的事件与公开请求模块](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/types.ts>) | 新Role/Slot/Assignment类型；team/topology事件；member v5包含slot代际；task相应新版本；role/slot分派输入与结构化背压结果 |
| [projection.ts 的事件选择/schema/apply/checkpoint模块](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/projection.ts>)、[journal.ts:9](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/journal.ts#L9>) | 扩完整事件域、纯函数校验slot/member绑定及代际、stateVersion6→7；journal允许topology写；中间reservation可重放且可恢复 |
| [roster.ts 的 spawn/retire/recover 模块](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/roster.ts>)、[index.ts 的公开服务/发送/生命周期模块](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/index.ts>)、[task-board.ts](</tmp/reclaim-spike/repo/packages/experimental/agent-team/src/task-board.ts>) | 分派基于task/role→slot→member；队列不调用模型；冷恢复收敛reservation与接受事实；owner保持具体SessionId；显式重置pinned需可追责 |
| [tool-agent-team 的工具/schema/identity/policy模块](</tmp/reclaim-spike/repo/packages/experimental/tool-agent-team/src/index.ts>) | managed派活隐藏底层模型/成员命名参数；提供按role/slot分派的独立可发现入口，原send保留精确人际通信；结果返回实际generation，旧target不重定向 |
| [客户端TeamAction模块](</tmp/reclaim-spike/repo/packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx>) 及同包视图/schema/locales模块 | 按稳定slot展示当前generation、空岗、等待原因及历史成员；沿用闭合MemberStatus，另呈现slot/queue状态；占用与历史计数分离 |
| [现有角色persona承载文件](</home/s00653124/workspace/dsh-compiler-mode/config/bundle-ai-compiler/cordis.patch.yml>) 与 [Host bundle配置](</home/s00653124/workspace/dsh-compiler-mode/config/bundle-ai-compiler/bundles.patch.yml>) | 从重复persona路由表迁移为声明式role registry；保留精简角色目录。具体Loader字段须实施时依据实际schema检查，本文不提供未经验证的YAML语法 |
| [补丁管理模块](</home/s00653124/workspace/dsh-compiler-mode/scripts/lib/harness-patches.mjs>)、[安装脚本](</home/s00653124/workspace/dsh-compiler-mode/scripts/install.sh>)、[验证脚本](</home/s00653124/workspace/dsh-compiler-mode/scripts/verify.sh>)、[运维文档](</home/s00653124/workspace/dsh-compiler-mode/docs/09-operations.md>) | 下一份结构性能力补丁；升级前备份、单向日志协议、恢复与背压诊断；新配置与built能力匹配，否则启动失败 |

P2迁移：新Team采用topology；旧Team先保留legacy，不自动把历史成员塞进slot。采用显式“开始managed topology”的一次提交，给无任务且可替换的成员逐步退役/重建；在途任务先完成或按CAS正常reassign，完成owner留历史。P1 role成员可在任务空闲时建立独立binding迁移事实，不能通过回写原member snapshot违反identity不可变。迁移事件与策略版本永久保留。

P2验证：每个崩溃点（slot reservation、provisioning落盘、子prompt接受、active落盘、drain完成、retired落盘、新generation绑定）重启后收敛；同slot并发请求仅产生一份占用；旧generation消息不误投新代；冷恢复角色模型不漂移；实现×2/探索×2并行、所有pin满员、公平排队、失败退避、completion任务与legacy混存；旧二进制打开新Session明确失败；超长历史重放时间和内存有记录。费用/质量改善须有对照实测，目前未验证。

## 7. A / B / 混合方案比较

这里A/B是本任务的“纯动态/固定8岗位”，不是旧A–F文档里的同名字母。

| 维度 | A 纯动态：当前0002+0003 | B 固定8个成员岗位 | 推荐混合：角色契约+4 reserved/4 flex |
|---|---|---|---|
| 默认启动实例数 | 0，按需 | 8（若采用预热） | 0，reserved职责存在但延迟启动 |
| 8份全部存在时新角色同时余量 | 0，可尝试回收 | 0，固定名册不允许替代 | 0，必须排队；空闲flex可在安全退役后改配 |
| 实现×2/探索×2 | Lead自行管理 | 8格可容纳6种teammate+两副本，余量0 | per-role max=2，global≤8，DSH分配primary与flex |
| 角色误发保护 | 无，只有prompt约定 | 单靠命名依然无；若加校验才改善 | spawn/send任务/claim/reassign共同角色契约 |
| 核心上下文保存 | 可能被角色盲回收 | 当前无pin会被回收；全pin又无弹性 | 成功pinned实例不idle回收；flex允许更替 |
| 失败恢复 | 新名字、Lead手动记映射；满额优先清failed | 固定名字失败后不能复用，需额外恢复机制 | slot保留，自动新generation；旧name仍永久 |
| 模型/成本 | 每次由Lead填agentOptions，可能漂移（**该做法已废弃**，见 `docs/design/preset-role-routing.md`） | 每岗指定模型但仍需机器校验 | registry注入/allowlist/并发；累计费用硬限另验 |
| 上下文隔离 | 灵活但可频繁丢上下文 | 长驻污染风险，重置不方便 | role+context compatibility决定复用或新代 |
| 用户零生命周期提示 | 部分；当前策略不能保证正确角色 | 常被固定规划与失败要求打断 | 默认由DSH管理；业务角色选择仍由Lead负责 |
| 实施成本 | 已有，但D1–D4必须修 | 表面低；补pin/role/重建后接近结构性方案 | P1中等，P2高；协议边界明确，可分阶段 |
| 长程可持续性 | 能腾名额，但角色/上下文/墓碑管理不完整 | 有限职责场景可用，不适合不断变化的任务 | 同角色复用+安全更替+背压；历史增长仍需观察 |

B可以作为稳定、职责固定工作流的部署策略，但必须建在角色契约和可恢复slot之上；做到这一步，它已经不再是“8个固定名字”的低成本替代方案。混合不承诺凭8个名额同时执行9类工作；它保证容量紧张时不会靠错误角色去伪造成功。

## 8. 明确不做什么及理由

- 不物理删除成员、不复用member名字、不把retired重新激活：保留重放、任务归属、审计与精确寻址；slot新代承担替换。
- 不把普通send改成“找不到就找空闲者/同名最新代”：迟到消息可能携带旧假设，静默重定向会制造真正的错误投递。
- 不用“全部预热并pin八人”作为默认：占满预算而没有临时需求余量，失败与长驻上下文污染仍需治理；逻辑角色定义即可提供发现能力。
- 不依赖自然语言分类器判断所有消息真实职责：成本、误判和不可确定性无法替代结构化task.requiredRole；业务标签错误保留为可观测的剩余风险。
- 不引入新的默认累计member lifetime硬墙：会重新制造长程任务永久失败。墓碑/日志增长应有分页、checkpoint与资源观测，若确需历史保留/归档则另立数据生命周期设计，不悄悄丢审计记录。
- 不让roleId或write_scopes充当权限边界：当前共享目录和advisory scope的事实不变。真正隔离工具/文件权限必须单独授权与实施验证。
- 不改变completion requirements/receipt、任务CAS和依赖图契约，不自动把旧owner转给新代：岗位稳定不能覆盖工作已由谁承担的证据。
- 不改用户模型能力声明以启用reasoningEffort，不擅自配置maxTokens或宣称省略等于预算硬限：遵守既有实测与授权范围。
- 不为此重写官方Team工具集、引入第二份名册真相或用外部插件私有内存充当持久角色数据库；源能力变化按capability patch交付。
- 不修改基线或本次任何源码/patch/其他文档；本文列出的改动清单是未来实施范围，尚未执行。

## 9. 验收结论与剩余风险

本设计的核心验收场景是：保留architect上下文，经过多轮explorer/implementer相位交替和失败重建后，探索任务仍只能由符合explorer契约的实例接收；槽位紧张时等待或给出背压，旧target消息不会误入新代，任务ownerId与历史重放始终可追踪。

源码层可确定D1、D2、D3及D4的竞态窗口，不能从本次只读审阅声称它们的新修复测试已通过，也不能量化角色误发实际概率。P1/P2仍需验证准入锁与子会话生命周期的相互作用、assignment接受恢复、超长日志refold成本、token/价格来源以及实际Host的能力构建。P0只降低风险；通过P1门禁后才能宣称基本角色保护，通过P2恢复与队列门禁后才能宣称岗位自动管理。
