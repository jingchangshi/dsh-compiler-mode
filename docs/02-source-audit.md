# 02 — Source Audit（P1：Q01–Q18）

基线：`/home/s00653124/workspace/deepseek-harness` @ `1f81c047fc`（`0.2.1-rc.3`，下称 RC.3）。
本文件只记录**实际读过源码 + 实际跑过实验**得到的结论。每条包含：相关源文件/函数、
当前机制、测试方法、测试结果、架构决策、是否需要改代码。

> 读法约定：`packages/core/session` ↔ 包名 `@deepseek-ai/dsh-session`；包名与目录名不再
> 一一对应（`dsh-lsp` 在 `packages/lsp/lsp`，`dsh-plugin-manager` 在 `packages/boot/plugin-manager`）。
> 任务书列出的 `packages/preset/`、`packages/core/agent-tool-presentation/`、
> `packages/ptc-runtime/`、`packages/experimental/agent-team*/`、`packages/spill/`、
> `packages/compaction/`、`packages/subagent/`、`packages/interaction/` 均存在，`packages/guard/`
> 存在（`timeout-policy`），但**不存在** `packages/permission/`、`packages/user-approval/`、
> `packages/host/plugin-manager/`、`packages/core/token-meter/`（分别位于
> `packages/interaction/{permission-presets,user-approval}`、`packages/boot/plugin-manager`、
> `packages/llm/token-meter`）。

---

## Q01 — Creator 如何生成 Custom Preset

**源码**

- `packages/bundle/web-app/package.json`：`dsh.bundle.patch` =
  `[cordis.patch.yml, presets/{standard,ptc,minimal,cordis}.patch.yml]`。
- `packages/bundle/web-app/presets/cordis.patch.yml`：`insert: [{id: preset-cordis,
  name: '@deepseek-ai/dsh-agent-preset', config:{...}}]`；该 preset 是唯一把
  `tool-plugin-manager` 设为**启用**的 shipped preset（`disabled: !!js "!ctx.get('profileContext')"`），
  其余三个为 `disabled: true`。
- `packages/client/ui-agent-preset/src/client/index.ts:216-222`：Creator 入口只做
  `stage('cordis', true)` + `uiWorkspace.startSession(undefined, {agentPreset:'cordis'})`。
- `packages/preset/agent-preset-registry/README.md:48`：
  "The registry writes no declarations … **nothing accepts YAML back**. A new preset or an
  override of a shipped one is a bundle patch … **Creator mode authors such bundles in
  conversation**."
- `packages/client/ui-agent-preset/README.md:76`："**Web creates and edits no preset**"。

**当前机制**

Creator 不是「表单/编辑器」：它是一个**对话流**。它在 `cordis` preset 下开新会话，
模型用 `plugin_manager` 工具在工作区写一个 bundle 目录（`package.json` 声明
`dsh.bundle.patch`，patch 文件 `insert` 一个 `@deepseek-ai/dsh-agent-preset` 行），
再调用 `install_bundle` 安装。安装 = pnpm 把包装进 profile + `selectBundle()` 把包名
**追加**到 `dsh.profile.bundles`（`packages/boot/plugin-manager/src/index.ts:808-828`）。
profile 的 `cordis.patch.yml` **不会被 install 修改**（唯一会写它的是单行
`disabled` 切换 `writePluginEnabled`，`src/patch.ts:25-77`）。

**测试方法 / 结果**

1. 我按 Creator 的产物形态写了自己的 bundle（`config/bundle-ai-compiler/`）；
2. `plugin_manager install_bundle` 指向该目录 → `application: "applied"`（证据：
   `evidence/install/install-01.json`）；
3. 安装后 `dsh --profile web --dump-config` 出现 `[preset-ai-compiler]` 行
   （`evidence/config-snapshots/web-with-ai-compiler-installed.dump-config.yml`）；
4. `cordis_inspect_query Config.listConfigs name=@deepseek-ai/dsh-agent-preset` 列出 5 行，
   含 `include:preset-ai-compiler`，`status: schema`；
5. profile `package.json` 的 `dsh.profile.bundles` 变为
   `[dsh-base, dsh-web-app, @local/dsh-ai-compiler-preset]`；`cordis.patch.yml` 与备份逐字节相同。

**架构决策**：复用官方 Creator 的**产物形态**（bundle + patch），不依赖其 Web 入口按钮；
不对 Creator 做任何修改。`ai-compiler` 用独立 bundle，安装/卸载走 `plugin_manager` /
`dsh plugin`，可重复执行（见 Q15）。

**需要改代码？** 否。

---

## Q02 — 官方 PTC Preset 如何派生

**源码**：`packages/bundle/web-app/presets/ptc.patch.yml` 全量 23 个顶层子行 /
33 个（含分组内）行。分层规则由 `packages/boot/app-boot/src/profile-context.ts:74-85`
决定：**bundle 层（`dsh.profile.bundles` 顺序）→ profile `cordis.patch.yml` →
`$DSH_HOME/cordis.patch.yml` → `--patch` 叠加 → telemetry**，后写覆盖先写。

**关键实测（派生方式的硬约束）**

- 覆盖某个 preset 行必须 `config` **整体替换**：`vendor/include/src/index.ts:115-124`
  对每行做 `target[key] = value`，`config` 是整体赋值，不深合并。
- 因此「用新 row id + 完整 config」是唯一安全的派生方式（新增预设），
  而「只覆盖 `config.plugins`」不可行（会丢 `id`/`order`）；若覆盖 shipped preset，
  必须整段重述。
- shipped presets 的 patch 注释「Edits saved from the Web editor override this row's
  `config.plugins` by id from the profile patch」**已过时**（Web 无编辑器），
  与本交付无关，仅在 `docs/08-compatibility.md` 记录为上游文档漂移。

**交付实现**：`config/bundle-ai-compiler/cordis.patch.yml` = PTC 全量 + 2 处显式改动，
由 `tests/preset/verify-preset.mjs` **对照 checkout 中的 ptc.patch.yml 逐行核对**：

```
verdict PASS
rows { baseline: 33, delivered: 33 }
diffs [('changed','persona'), ('changed','compaction.tool-result-pruner')]
failures []
```

即：除 persona 前缀与 pruner 阈值之外，`ai-compiler` 与官方 PTC **结构完全一致**。

**一个必须修正的发现（Q02b）**：最初我把 LSP（`lsp`/`lsp-stdio`/`tool-lsp`）放进预设内的
`cordis:group isolate: lsp`。实测预设 mount 失败：

```
agent-preset/invalid: lsp (@deepseek-ai/dsh-lsp): never started
lsp-stdio (@deepseek-ai/dsh-lsp-stdio): never started
tool-lsp (@deepseek-ai/dsh-tool-lsp): never started
```

根因（源码）：`packages/lsp/lsp/src/index.ts:158` 是 `export default Lsp`——`Lsp extends
Service` 是**抽象服务基类**而不是 `apply()` 插件；`vendor/cordis/src/registry.ts:8-10`
的 `isApplicable()` 只认 `function` 或带 `apply` 的对象，模块命名空间两者都
不是 → `entry.fiber === undefined` → `agent-preset-registry/src/mount.ts:142` 判
`never started` → 整个预设被视为 unusable。**结论：`@deepseek-ai/dsh-lsp` 只能是
Host/Profile 行**，预设只拥有 provider（`lsp-stdio`）与消费者（`tool-lsp`）。
已把三行移到 bundle 的**宿主层** `config/bundle-ai-compiler/bundles.patch.yml`。
（`dsh-agent-preset` 自己之所以能工作，是因为它显式实现了 `async *[Service.init]()`
并以 `export default class` 导出——`packages/preset/agent-preset/src/index.ts:12-29`。）

**需要改代码？** 否（改的是我自己的配置）。

---

## Q03 — PTC Runtime 作用域

**源码**

- `packages/bundle/base/cordis.patch.yml:397-398`：`ptc-runtime` 行
  = `@deepseek-ai/dsh-ptc-runtime-node`，**Host 平面**（web-app 层未禁用它）。
- `packages/ptc-runtime/ptc-runtime-node/src/index.ts:38`：
  `static inject = ['fs','subprocess','sandbox','sandboxPolicy']`。
- `packages/core/tools/src/ptc.ts:691-694`：绑定枚举
  `registry.schemas(exec.agent)` —— **按调用 agent 的可见视图**逐个生成 SDK 函数；
  `ptc.ts:717-727` 用 `stateOwner: exec.agent`（仅当策略与 standing 一致时）。
- `packages/core/tools/src/index.ts:1019-1037`：`wireSchemas()` 在 ptc 模式下把**线上
  工具列表**折叠为 `[run_code]`。

**测试方法**：`tests/diagnostics/preset-probe.mjs` —— 用 `runProfile()` 启动真实组合，
对每个预设建一个一次性 Agent（`agents.create({setup: c => agentPresets.mount(c, id)})`），
读 `systemPrompt.assemble({scope: scopeOf(agent.ctx)})` 的 `tools` 与 `tools:sdk` 段。

**结果（证据 `evidence/probes/preset-probe.json`）**

| 预设 | 线上 tools | SDK 绑定数 |
|---|---|---|
| `ptc` | `run_code` | 23 |
| `ai-compiler` | `run_code` | 24（多出 `lsp`、`spawn_teammate`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`、`team_task_*`，少 `subagent_control` 等） |

**子 Agent**：teammate 通过 `subagents.startActivation` 创建
（`packages/experimental/agent-team/src/roster.ts:264-274`），走
`packages/subagent/subagent/src/child-agent.ts:186-202` 的
`composeFrom(childCtx, parent.ctx)` —— **沿用父 Agent 的同一个预设 revision**，
因此 teammate 与 Lead 共用同一套工具/同一套 PTC 呈现，`ptc-runtime` 是 Host 单例、
所有 Agent 共用（但每次 `run_code` 是独立 Node 进程）。

**决策**：`ptc-runtime` 保持在 Host（不重复注册），预设只声明
`tool-presentation: ptc`。**需要改代码？** 否。

---

## Q04 — PTC 中 Team 工具是否可见

**源码**

- Team 工具由 `packages/experimental/tool-agent-team/src/index.ts:411-432` 在
  **Agent scope** 注册（`agent.ctx.tools.register(...)`），`tryMembership(agent)` 非空即安装。
- PTC SDK 枚举用同一 `view()`（`ptc.ts:691`），因此 Agent scope 的注册必然出现。
- 线上工具列表被折叠成 `run_code`，Team 工具**不会**作为独立 schema 出现。

**测试**：上表 SDK 绑定列表（`evidence/probes/preset-probe.json`）含
`spawn_teammate / send_message / list_agents / wait_agent / interrupt_agent /
team_task_create / team_task_get / team_task_list / team_task_update` 9 个工具。
真实调用证据见 Q04-live（Case A 的会话日志 `tool/ptc-dispatch` 事件）。

**需要改代码？** 否。

---

## Q05/Q06/Q07/Q08/Q09/Q10/Q11/Q12 —（Case A/B/C 实测后回填，见下）

> 本节结果来自 `evidence/e2e/case-a`、`case-b`、`case-c` 的会话日志与 `tests/e2e/session-metrics.mjs`
> 统计。**每一条都是真实运行**，没有一条是 README 推断。填写状态在
> `docs/06-tests.md` 的测试矩阵里逐项复核。

## Q13 — FFF 是否比原生检索有用

见 `docs/08-compatibility.md` §FFF 与 `docs/07-benchmarks.md` §A/B：结论是**不默认启用**，
原因是**不存在可运行于 RC.3 的 FFF 插件包**（仅有第三方实验仓库 `dsh-pi`，非 RC.3 兼容包，
未经审计），并且原生 `rg`/`glob` 在本基准里已达到判定标准。

## Q14 — Preset 更新如何影响旧 Session

**源码**

- 预设声明每变一次就是「旧 generation 退位 + 新 generation 激活」
  （`agent-preset-registry/src/index.ts:81-122,148-152`）；
- 活着的 Agent 保留自己绑定的 generation（`bindings` 不动，`collect()` 在 `users === 0` 前不 dispose）；
- 冷恢复（重启后 `--session-id` / 新进程打开旧会话）只按 **id** 在当前配置里查找：
  找不到 → `agent-preset/not-found`；激活失败 → `agent-preset/invalid`
  （`index.ts:232-248`）。README 明确 "Old revision implementations are not retained
  across process restarts"。

**测试**：Q14 由 `tests/preset/revision-test.sh` 实测（新会话生效 / 旧会话保留 / 删除
预设后冷恢复报 `agent-preset/not-found`）。

## Q15 — Profile 卸载后能否完整回滚

见 `scripts/uninstall.sh` + `scripts/rollback.sh` 与 `docs/04-installation.md`：
`plugin_manager remove_bundle` 会 deselect → reload → `pnpm remove`；profile 的
`cordis.patch.yml` 全程不变；恢复备份可回到安装前逐字节状态。

## Q16 — 共享工作目录是否引入竞争

官方 team 策略文本（`tool-agent-team/src/index.ts:34-46`）明确：共享目录、编辑立即可见、
**写作用域是建议不是锁**、`FS_STALE_VERSION` 需重读再重试、Bash/格式化器/代码生成器不受
版本守卫保护。`team_task_*` 的 `write_scopes` 只是 advisory。

**架构决策**：单写入者 + 多只读 + 独立验证（A8），并在预设 persona 与
`tests/e2e/cases/case-b.prompt.md` 中把该约束写成**可检查的任务分解规则**，
而不是假装 Runtime 会加锁。

## Q17 — Headless/Web 是否行为一致

**实测结论：不一致，而且是 RC.3 的设计差异。**

- Web profile = `dsh-base + dsh-web-app`：宿主平面禁用所有 agent 行，每个 session
  mount 一个 preset（`web-app/cordis.patch.yml:466-585`）。
- headless profile = `dsh-base + dsh-headless`：**没有 preset registry**，
  agent 行留在宿主平面；`packages/bundle/headless/src/index.ts:212-221`
  主动拒绝任何记录了 `agentPreset` 的会话。
- 我最初用 `--profile headless` + `--patch` 插入 preset 行的做法实测**无效**：模型仍然
  看到原生工具集（证据 `evidence/e2e/case-a/run-00-failed-native-plane/`，final 答案里
  模型自己指出 "no `run_code` tool"）。原因是只 insert 预设行并不能禁掉 base 层
  的 `tool-bash`/`tool-fs`/`tool-*` 宿主行。
- **修正**：验收驱动 `tests/e2e/headless-run.mjs` 改为构建一个**临时 profile**：
  `[dsh-base, dsh-web-app, dsh-headless, @local/dsh-ai-compiler-preset]`，
  禁掉一次性进程无法启动的 Web 传输行，并把 `agent-preset-registry.default` 设为
  `ai-compiler`。这样 headless 用的是与 Web **同一个 agent 平面**。

## Q18 — 是否存在重复 Tool 或 Plugin 注册

**方法**：`scripts/lib/dumptree.mjs` 对 `--dump-config` 输出逐行统计 + `preset-probe`
的线上工具列表 / SDK 列表对照。

**发现**

1. Host 层 agent 行在 Web profile 中**明确 disabled**（不是删除），预设行同名不同 scope，
   这是官方设计（"disabled rather than deleted"），不构成重复注册。
2. **Team 与直连委派并存**：`ai-compiler` 的 `delegation` 组声明
   `tool-subagent*`，而 team bundle 会把同样的 id 设为 `disabled: true`（先应用）。
   实测 `ai-compiler` 的 SDK 同时出现 `subagent`/`subagent_fork` 与 Team 工具 —— 
   这是**有意保留的兜底**（未安装 team bundle 时仍可委派），但会带来工具面冗余。
3. 预设内**没有**重复 id；`verify-preset.mjs` 与 `dump-config` 都未发现同 scope 同 id 两行。

**决策**：保留直连委派作为兜底，但在 persona/文档中要求 "Team 可用时优先用 Team"，
并在 `docs/01-architecture.md` 的工具清单表里标出两者并列的代价。

---

## 追加审计：PTC 与工具管线的等价性（支撑 A3/F2）

源码（`packages/core/tools/src/ptc.ts`）：

| 机制 | 直接调用 | `run_code` 内子调用 | 证据 |
|---|---|---|---|
| 可见性过滤 | `view(scope)` | 同一 `view`（`ptc.ts:691`），且每次子调用重新解析 | 是 |
| `tools/pre-execute` | 是 | `scheduler.prepare`（`ptc.ts:624`）→ `prepareExecution`（`index.ts:1501-1547`） | 是 |
| 审批 `ask` | 是 | `serviceAsk`（`index.ts:1735-1776`），走同一 `ctx.approval` | 是 |
| 单调 guard | 是 | `guardReason`（`index.ts:1527`） | 是 |
| 超时策略 | 是 | `tools/execute` waterfall 内同时生效 | 是 |
| post-execute / result | 是 | `finalize`/`finish`（`ptc.ts:635-656`） | 是 |
| 会话日志 | `tool/call`+`tool/result` | `tool/ptc-dispatch-start` + `tool/ptc-dispatch`（**日志专用事件**） | 是（但模型不可见） |
| 外层输出上限 | — | `maxOutputBytes` 67,108,864（`ptc-runtime-node/src/config.ts:35`），溢出 → `output-limit` | 是 |

## 追加审计：Sandbox 在本机的可用性

见 `docs/00-baseline.md` §5 与 `docs/05-permissions.md`：bwrap 因 AppArmor 禁 user
namespace 不可用；`landlock-run` 二进制不在构建产物中 → `dsh-sandbox-local` 的
Linux 链不可用 → `read-only`/`workspace-write` **失败关闭**，只有
`danger-full-access` 可用。这条**不是配置错误**，已在权限验收里分开处理。
