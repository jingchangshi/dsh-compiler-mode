# 00 — Baseline（P0）

> **本基线采集自旧服务器 `/home/s00653124`，其中的绝对路径不适用于其他机器；功能代码在运行时
> 从仓库位置推导路径（`scripts/lib/paths.mjs`），不再引用本文件中的任何路径。**

冻结时间：2026-10-27（Asia/Shanghai）
DSH 固定基线：`dsh-v0.2.1-rc.3`

本文件记录 P0 阶段实测的环境、版本、Git 状态与配置快照。机器可读版本清单见
`evidence/env/versions.json`，配置快照见 `evidence/config-snapshots/`。

## 1. DSH 源码与 Git 状态

| 项目 | 值 | 取证方式 |
|---|---|---|
| 源码目录 | `/home/s00653124/workspace/deepseek-harness` | `pwd` |
| 当前分支 | `dsh-v0.2.1-rc.3` | `git branch` |
| `git rev-parse HEAD` | `1f81c047fc48fa190a683e469daa699857e9afe8` | 与任务要求的 `1f81c04` **一致** |
| `git status` | `nothing to commit, working tree clean`（开工时） | `git status` |
| Tag | **仓库中不存在任何 tag**（`git tag -l` 为空） | 见下方说明 |
| 远端 | `origin` = `git@github.com:deepseek-ai/deepseek-harness.git`；`jcshi` = `git@github.com:jingchangshi/deepseek-harness.git` | `git remote -v` |
| Worktree | 仅主 worktree，`1f81c047fc [dsh-v0.2.1-rc.3]` | `git worktree list` |
| 其他分支 | `dev`、`master`、`remotes/origin/{dev,master}`、`remotes/jcshi/dev` | `git branch -a` |

**关于 Tag 的判定（与任务书表述的差异，需记录）**

任务书要求基线为 Tag `dsh-v0.2.1-rc.3` / commit `1f81c04`。实测：

- commit `1f81c047fc` **存在且与任务书一致**；
- 该 commit 是 `Merge pull request #6999 from deepseek-harness/worktree/release-dsh-0.2.1-rc.3`，
  其父提交 `d02ea370ee release(dsh): 0.2.1-rc.3` 是发布提交；
- 但本地仓库 `git tag -l` 输出为空，`git describe --tags` 报 `No names found`。
  即**该 checkout 没有获取 tag 引用**（未执行 `git fetch --tags`，避免引入与任务无关的远端操作）。

**决策**：以 commit `1f81c047fc` 作为不可变基线（逐字比对满足任务要求的 `1f81c04`），
不依赖 tag 对象；在 `docs/08-compatibility.md` 记录该差异。所有工作区内的改动以
**独立本地 Git 仓库**（本交付仓库 `dsh-compiler-mode`）承载，不向 `deepseek-harness` 提交。

**未在 DSH 仓库内创建 worktree 的理由**：本任务不修改 DSH 源码（原则 9「避免修改 DSH Core」）。
基线仓库保持只读使用（`node apps/cli/lib/bin.js …` 仅读取）。交付物是**独立 Git 仓库**
（`/home/s00653124/workspace/dsh-compiler-mode`），从第一个提交开始受版本管理，
因此「避免影响 dev 分支 / 不覆盖他人改动」的要求由仓库隔离而非 worktree 满足。
凡对 DSH 的读取均在 `evidence/` 下留档。

## 2. 运行时与工具链

| 组件 | 版本 | 路径 / 说明 |
|---|---|---|
| Node.js | `v24.20.0` | `/home/s00653124/Softwares/node/bin/node` |
| pnpm | `11.28.5` | 由 DSH checkout 的 `packageManager` 固定 |
| DSH CLI | `0.2.1-rc.3` | `node apps/cli/lib/bin.js --version`（`dsh` 不在 PATH 上，直接调用 `apps/cli/lib/bin.js`） |
| clangd（PATH 默认） | 15.0.6（LLVM 15.0.6） | `/home/s00653124/Softwares/clang+llvm-15.0.6/bin/clangd`；与生成 AscendNPU-IR `compile_commands.json` 的编译器同源 |
| clangd（备用） | 22.1.0 | `/home/s00653124/Softwares/clangd/bin/clangd` |
| clang / clang++ | 15.0.6 | 同上目录 |
| cmake | `/home/s00653124/Softwares/cmake/bin/cmake` | |
| ninja | `/home/s00653124/.local/bin/ninja` | |
| ripgrep | `/home/s00653124/.local/bin/rg` | |
| bwrap | bubblewrap 0.4.0 | `/home/s00653124/.local/bin/bwrap`；**该内核上不可用**，见 §5 |
| 内核 | Landlock 已启用（`/sys/kernel/security/lsm` 含 `landlock`）；`apparmor_restrict_unprivileged_userns=1` | |

版本清单（机器可读）：`evidence/env/versions.json`。

## 3. DSH Home / Profile

| 项目 | 值 |
|---|---|
| `DSH_HOME` | `/home/s00653124/.dsh` |
| `DSH_PROFILE`（会话） | `web` |
| `DSH_PROFILE_DIR` | `/home/s00653124/.dsh/profiles/web` |
| 现有 profile | `web`、`headless` |
| 凭据存储 | `$DSH_HOME/.credentials.yaml`（0600），含 `refs: MAGPIE_API_KEY`、`CORP_API_KEY`；**启动环境变量中没有这两个值** |

Web profile 组成（`package.json` `dsh.profile.bundles`，安装前）：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
```

`cordis.patch.yml`（用户层，2760 字节）覆盖了 `ui-settings-general`、`permission`
（presets + `defaultPreset: danger-full-access`）、`llm-pi-ai`（`magpie` / `corp` 两个
provider 及模型目录）、`agent-default-model`（`magpie` / `auto/deepseek-v4.1-flash`）。

**默认模型（不修改）**：`magpie` / `auto/deepseek-v4.1-flash`，`contextWindow=1048576`，
`maxTokens=393216`。

### 配置快照（`evidence/config-snapshots/`）

| 文件 | 命令 |
|---|---|
| `web-dump-config.orig.yml`（1300 行） | `node apps/cli/lib/bin.js --profile web --dump-config` |
| `web-composed-tree.txt` | 上述快照的树形摘要（`scripts/lib/dumptree.mjs`） |
| `dump-config-schema.json` | `--dump-config-schema` |
| `headless-dump-default-config.yml` | `node apps/cli/lib/bin.js --profile headless --dump-default-config` |

### 备份

`evidence/backup/profile-web-orig/` 保存了安装前的 profile 四件套
（`package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-workspace.yaml`）；
`scripts/rollback.sh` 依据该目录恢复。

其中 `cordis.patch.yml` 是**用户层**：模型目录与默认模型由操作者自己维护，
安装不得改动它。该文件在 2026-10-28 22:29 被操作者追加了
`group/architect|validator|challenger` 三个模型并把默认模型改为
`workbuddy/step-5-preview`，因此基线已刷新为刷新时刻的实况；
`scripts/verify.sh` 第 6 步据此比对"安装未触碰用户配置"。
`package.json` 仍保留安装前的干净版本——它属于安装的作用域，
不能拿安装后的版本充当回滚点。

## 4. 现有 Profile / 插件装配（真实，来自 dump-config）

Web profile 的**宿主平面**已启用、且与本任务相关的行（完整树见
`evidence/config-snapshots/web-composed-tree.txt`）：

| row id | 插件 | 状态 |
|---|---|---|
| `ptc-runtime` | `@deepseek-ai/dsh-ptc-runtime-node` | enabled，无 config（`per-call` 默认） |
| `spill-local` | `@deepseek-ai/dsh-spill-local` | enabled，无 `root` → `/tmp/dsh-spill-*/` |
| `spill-policy` | `@deepseek-ai/dsh-spill-policy` | enabled，`maxInlineTokens: 12500` |
| `token-meter` | `@deepseek-ai/dsh-token-meter` | enabled（host） |
| `session-checkpoint-policy` / `timeout-policy` / `image-offload` | — | enabled（host） |
| `subagent`, `subagent-spawn-in-process`, `subagent-fork-in-process` | — | enabled（host，注册表/后端） |
| `agent-preset-registry` | `@deepseek-ai/dsh-agent-preset-registry` | enabled，`default: standard` |
| `preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis` | — | enabled |
| `tools` | `@deepseek-ai/dsh-tools` | `mode: !!js process.env.DSH_TOOLS_MODE`（未设置时走 schema 默认 `native`） |

**agent 平面（preset 平面）行在宿主被禁用**（`web-app/cordis.patch.yml` 466–585 行）：
`tool-bash`、`tool-fs`、`tool-fs-search`、`tool-jobs`、`tool-todo`、`tool-web`、
`tool-skill`、`skill-filesystem`、`agent-instructions`、`plan-mode`、`compaction-basic`、
`command-compact`、`tool-result-pruner`、`tool-subagent*`、`workflow-ptc`、`tool-goal`、
`command-goal` 等。这正是「preset 负责 agent 能力组合」的落点。

可选的官方 bundle（`list_bundles`）：`@deepseek-ai/dsh-experimental-agent-team-profile`
（`official: true`, `optional: true`, 默认 `enabled: false`）。

## 5. 宿主平台事实（影响 P7 的结论）

实测（不是文档推断）：

| 检查 | 命令 | 结果 |
|---|---|---|
| bwrap 可用性 | `bwrap --unshare-user --dev-bind / / -- true` | **失败**：`bwrap: setting up uid map: Permission denied` |
| unprivileged userns | `unshare --user --map-root-user …` | **失败**：`unshare: write failed /proc/self/uid_map: Operation not permitted` |
| 原因 | `sysctl kernel.apparmor_restrict_unprivileged_userns` | `1`（Ubuntu AppArmor 限制非特权 user namespace） |
| Landlock | `/sys/kernel/security/lsm` | 含 `landlock` |
| landlock-run 启动器 | `native/system/packages/linux-x64/prebuilds.json` 声明 `bin/landlock-run` | **该二进制未出现在构建产物中**（只有 `bin/glibc/system.node`） |

**推论（后续由 E2E 实测，见 `docs/05-permissions.md`）**：本机上 `dsh-sandbox-local`
的 Linux 链（`bwrap` → `landlock`）两档都不可用，`confine()` 会抛
`SandboxUnavailableError`。因此 `read-only` / `workspace-write` 两种沙箱模式会**失败关闭**
（工具调用报错），而 `danger-full-access` 不经过 `confine()` 因而正常工作。

这是**宿主环境限制**，不是 `ai-compiler` 引入的缺陷。验收策略：权限正/反向测试分为
两组——(a) 在真实 session 上实测确认「workspace-write 在此宿主不可用且失败关闭」，
(b) 在隔离目录上用**真实文件系统栅栏**（`fs-sandbox` 的 `workspace-write` 路径检查）
验证允许/拒绝语义。两者都记录实际执行证据。

## 6. 模型可用性

- Web GUI 正在运行（`http://127.0.0.1:3092`），会话模型 `auto/deepseek-v4.1-flash`。
- `$DSH_HOME/.credentials.yaml` 中有 `MAGPIE_API_KEY`，启动环境中没有。
- headless profile 默认只装 `dsh-base + dsh-headless`，**不含 preset 平面**，也不含
  `llm-pi-ai` 与 `credentials` 行；`dsh-headless` 的 `assertAdoptable()` 会**拒绝**任何
  记录了 `agentPreset` 的 session（`packages/bundle/headless/src/index.ts:212-231`）。
- 已验证可用于测试的 headless 驱动方式：`tests/e2e/headless-run.mjs` —— 生成
  `preset-overlay.yml`（插入 registry + 四个 shipped preset + `preset-ai-compiler` 本体）
  与 `model-overlay.yml`（`llm-pi-ai` 路由 + `credentials` 行 + `agent-default-model`），
  以 `dsh --profile headless --patch … --patch … --json` 运行。
  首次跑通见 `evidence/e2e/smoke/`（输出 `HEADLESS_OK`，exit 0）。

## 7. 既有仓库（只读）

| 仓库 | 路径 | 规模 |
|---|---|---|
| AscendNPU-IR | `/home/s00653124/workspace/AscendNPU-IR-1` | `build/compile_commands.json` 4913 条，编译器 `/home/s00653124/Softwares/clang+llvm-15.0.6/bin/clang++` |
| TileLang | `/home/s00653124/workspace/tilelang` | 只读 |
| PiEngineeringHarness | `/home/s00653124/workspace/PiEngineeringHarness` | 只读 |
| AgentGates | `/home/s00653124/workspace/AgentGates` | 只读 |

本任务对以上四个仓库**不写、不提交、不清理**。

## 8. P0 结论

1. 基线 commit 与任务书一致；tag 引用缺失（已记录，不影响可复现性）。
2. 现有 4 个 shipped preset 与宿主装配已完整快照；`ai-compiler` 以**新增 bundle 层**
   追加，绝不覆盖 shipped preset。
3. 宿主沙箱在本机只能跑 `danger-full-access`；权限验收因此改为「实测失败关闭 +
   隔离目录真实栅栏」双轨，绝不通过伪造 PASS 掩盖。
4. headless 无 preset 平面是 RC.3 的**设计**（不是 bug），本交付以 patch overlay
   在 headless 上复现同一 `ai-compiler` 组合用于 live E2E，并以 Web 会话验证
   真正的模式选择入口。
