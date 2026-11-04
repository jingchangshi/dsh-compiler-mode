# dsh-web 远程 SSH 转发下「切标签页后重连 / 状态刷新慢 / 通知不及时」根因分析与解决方案

分析对象：DeepSeek Harness `v0.2.1-rc.3`（commit `296181d1c2`），checkout：`/home/s00653124/workspace/deepseek-harness/`
场景：`dsh web` 跑在远程服务器，本机用 `ssh -L` 转发端口，浏览器访问 `127.0.0.1:<port>`。

---

## 0. 结论速览（TL;DR）

你观察到的现象是**两件独立但叠加的事**：

1. **「重新连接中 → 连接成功」= 一次真实的重连（Connection generation 丢失并重建），不是 UI 抖动。**
   服务端 WebSocket 心跳默认 **每 2 秒 ping 一次、连续 2 次没收到 pong 就 `terminate()`**（≈ **4–6 秒无响应即断**）。后台标签页被浏览器节流/冻结、笔记本休眠、或远程 Node 事件循环卡顿超过这个窗口，就会把这条**唯一的**长连接判死。
2. **「再过一会儿会话才刷新出最新状态」= 重连后要重新拉一遍基线，而且不是无缝续传。**
   重连成功（`$events` ready）之后，客户端还要：重新拉会话列表（含 running 状态）→ 逐个 session 拉投影 → 重开 control 流拿全量 baseline → 每个打开的会话重开 follow 流并重新发一页 **全量快照（最多 500 条）** → 另有 ~25 个插件在 `connection/reset` 时各自重新 RPC。这些 RPC 在 SSH 链路上**串行叠加**，就是「过一会儿才刷新」。

你的**通知插件运行在页面里**，只能等上面两步都完成、状态重新同步后，才观察到「完成 / 待回答」，所以通知必然滞后；如果标签页被彻底冻结，插件连回调都跑不了。

**最优解分三层**：① 立刻可做（改配置 + SSH keepalive + 禁止浏览器冻结该站点）；② 客户端加「可见性驱动即时重连」小补丁；③ 把「完成 / 待回答」通知搬到 **Host 侧**，用外部通道（ntfy / Bark / Telegram / webhook）推送，彻底摆脱浏览器标签页生命周期。

---

## 1. 现象的时间线拆解

```
[标签页在前台] 一切正常，WebSocket(remote.mux) 存活
        │  切到别的标签页 / 锁屏 / 休眠
        ▼
[标签页在后台] 浏览器节流/冻结 renderer；setTimeout 被降频（1s，5 分钟后 1/min）
        │  同时服务端每 2s ping；连续 2 次无 pong → terminate（≈4–6s）
        ▼
[连接已死] Connection generation 丢失 → state='connecting'（但标签页隐藏，你看不到）
        │  重连的退避 setTimeout 也被节流 → 重试被推迟
        ▼
[切回标签页] 定时器恢复 → 显示「重新连接中」→ 重连握手 + $events ready → 「连接成功」（绿色约 2s）
        ▼
[重同步] 列表 RPC → 投影 RPC×N → control 全量 baseline → 每会话 follow 全量快照(≤500) → 多插件各自 refetch
        ▼
[通知插件] 直到此刻才看到 running=false / pendingInteraction → 才发通知
```

> UI 证据：`重新连接中 / 连接成功` 就是 `ConnectionIndicator` 的 `connecting → recovered` 两态，且 `connecting` 至少显示 800ms、`recovered` 显示 2000ms。`packages/client/ui-settings-general/src/client/locales.ts:35-36`、`SettingsRoot.tsx:26,29,205-212`、`packages/client/ui-primitives/src/ConnectionIndicator.tsx:60-101`。

---

## 2. 根因（逐条带代码证据）

### 2.1 整个连接只有「一个 generation 来源」，就是那条长连 WebSocket

- `$events`（`/api/remote.mux` 上的内部逻辑流）是 `ConnectionHandle` 的**唯一** generation 来源，与有多少业务监听无关。
  `packages/api/gateway/src/client/index.ts:163-184`（注册 generation 源并启动 loop）、`packages/api/gateway/src/client/remote-events.ts:107-145`（ready 帧之后才算就绪）。
- 这条流一断，整个 generation 丢失：`packages/client/connection/src/client/index.ts:313-320` 发布 `undefined` generation 并把 state 变为非 connected。**没有第二条独立通道兜底。**

### 2.2 服务端心跳策略对「远程 + 后台标签页」过于激进（本次问题的放大器）

- `MAX_MISSED_HEARTBEATS = 2`（硬编码，**不可配置**）：`packages/api/gateway/src/stream-server.ts:42`。
- 心跳循环：每 tick 若 `missed >= 2` 就 `socket.terminate()`，否则 `missed++` 并 `ping()`：`stream-server.ts:108-127`（关键 `:113-123`）。
- 默认间隔 **2000ms**：`packages/api/gateway/src/index.ts:147`（`DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS = 2_000`），schema `:212-213`，注入 mux `:255`。
- **终止时间线**：最后一次对端活动后 → +2s 第 1 次 ping（missed=1）→ +4s 第 2 次 ping（missed=2）→ 第 3 个 tick（≈+6s，相位决定 4.0~6.0s）`terminate()`。测试固定：`packages/api/gateway/tests/stream-server.host.spec.ts:55-67`。
- **历史回归**：早期默认是 **30_000ms**（commit `af562d3649`「keep idle websocket alive」），在 `ccfbbb443af`（2026-08-29「centralize websocket recovery」）被降到 **2_000ms**。
- 官方 README 也明说了这个坑：**“The Host terminates a peer that shows no activity for two intervals, so a deployment whose event loop or network can stall longer than this interval must raise it.”** —— `packages/api/gateway/README.md:93`。

> 结论：对 LAN/本机 2s 足够灵敏；但远程 SSH + 后台标签页/休眠/事件循环卡顿，4–6 秒的容忍窗口太窄，极易被击穿。

### 2.3 客户端没有任何 Page Visibility / 冻结恢复处理，重连完全依赖会被节流的 `setTimeout`

- 只监听 `online/offline`：`packages/client/connection/src/client/index.ts:196-215`（`watchBrowserNetwork`）。
- 全仓 `visibilitychange` 只出现在 `ui-user-questions/QuestionComposer.tsx:282-290` 和 `ui-settings-account/AccountNotice.tsx:107-116`，**连接层完全没有**。
- 退避 sleep 用裸 `setTimeout`：`packages/client/connection/src/client/connection.ts:23-33`；节流后重试被推迟，回到前台才「补跑」。
- **客户端不发任何应用层 ping**：连接健康 100% 依赖服务端 ping，浏览器端一旦被挂起就无法自证存活。

### 2.4 重连是「重建基线」，不是「增量续传」（决定「过一会儿才刷新」）

- 重连流程：Connection 丢失 → `ConnectionController` 重置并重开 `$events`（`connection.ts:112-121,164-268`）→ 就绪后 `onConnected` 触发 `connection/reset`（`gateway/src/client/index.ts:179`）。
- 会话重同步由 generation 订阅驱动：`packages/api/session-controller/src/client/index.ts:132-140`（`sessions.handleConnected()` + `control.restart()/start()`）。
- `handleConnected`（`sessions/manager.ts:761-775`）：清空所有投影 store → **1 次** `remote.session.list`（`:413-423`，覆盖全部会话）→ 每个打开的会话/父会话 **各 1 次** `remote.session.projections`（`:346-357`）；control 流重启后**全量重发**所有会话投影 baseline（host 侧 `control.ts:42-76`）。
- 会话事件 journal **不是游标续传**：`RemoteJournalStream` 每次 carrier 丢失都重新 `follow()`（`journal-stream.ts:115-127,261-303`），host 端 yield 一页**全量 snapshot**（`maxMessages: 500`，`session.ts:50-54`）；物理重试等新 generation 后从头再来（`remote-stream.ts:160-197`）。
- 另有 ~25 个插件在 `connection/reset` 时各自重新 RPC（terminal/settings/models/commands/tool/workspace/goal/schedule/skill/plugin market…）。**这些往返在 SSH 隧道上串行排队，≥4 个顺序阶段，典型 0.3–3s+，长会话更大。**

### 2.5 通知插件为什么「不及时」

- 规范观察面是 `uiSession.sessionStatus`：`HostObservable<Map<SessionId, {running, pendingInteraction, completionUnread}>>`（`packages/client/ui-session/src/client/index.ts:60-72,299-305`），`publishStatus` 是**同步**通知（`:544`），列表 Notifier 走微任务（`sessions/notifier.ts:31-36,78`）——所以问题**不在**通知回调本身被 rAF 卡住，而在**数据没到**。
- 数据来源有两类：
  - **fire-and-forget 的 emit 事件**（`api-session/status/added/activity`）：断开期间**直接丢失**，只能靠重连后的 baseline 重拉恢复（`gateway/src/client/index.ts:601-621`）。
  - **waterfall 请求**（提问 `user-questions/request`、审批 `approval/request`）：**不会丢**，会被持久化并在新 owner 流建立时**重投**（`gateway/src/index.ts:227,632-672,570-571`），且 durable 投影 `userQuestions.active` 会在 baseline 里恢复（`ui-user-questions/src/client/index.ts:286-359`）。
- **一个真实的缺口**：`reconcileStatus` 对「从没见过」的 running 状态是**静默播种**（`ui-session/src/client/index.ts:507` `previous===undefined → set`，不触发 `observeRunning`），所以**如果一次「运行→完成」完全发生在断连窗口内**，`completionUnread` 可能**永远不置位**——你的插件若依赖这个标志就会**漏通知**（不是延迟，是丢失）。依赖 `running` 的前后变化判断完成时要注意这个边界。
- 另外，若你的插件用 React/`flush:'raf'` 的 store 渲染，后台标签页 rAF 不触发会额外拖延；会话流的「三帧渲染门」在隐藏态也不会推进（`ui-conversation/src/client/conversation/assembly.ts:143-153`）。但**根因仍是连接与基线重建**。

---

## 3. 如何快速确认（10 分钟自证）

浏览器侧（唯一能直接看到的证据，因为**服务端 heartbeat terminate 不留日志**）：

1. DevTools → Network → WS → `/api/remote.mux`：记录你切走标签页后大约多久出现 **close**，以及 close code：
   - `1006` = 异常断开（典型为服务端 `terminate()`）；
   - `1001` = Peer 释放；`4000` = 客户端主动 `reconnect()`。
2. Console 里搜 `[connection]`：
   - `[connection] connection lost, retry #N`（`connection.ts:196`）——它的**时间戳**与「你切回标签」的时刻对比，可区分「后台其实已重连、只是没绘制」vs「重试被节流到回前台才跑」；
   - `[connection] generation is still not ready after 3000ms` / `…not ready within 15000ms; cancelling generation`（`connection.ts:296,300`）——说明是**握手慢**（SSH 链路/RTT），不是心跳杀。
3. 对照实验：同一会话，一次全程前台；一次后台 5–10 分钟后切回。后置对比 `retry #` 次数与恢复耗时。

> 注意一个易混淆点：也可能「后台期间其实已经重连成功，只是没 paint」，回前台才刷新。**只有用上面的 console 时间戳才能区分**。不管哪种，方案都适用。

---

## 4. 解决方案

### 4.1 第一层：立即缓解（改配置 + 环境，0 代码，通常解决 80–90%）

**(a) 调大 WebSocket 心跳间隔（最关键的一招）**

在远程服务器的 profile 补丁里覆盖 `typert-gateway` 的 `websocketHeartbeatIntervalMs`。文件：`~/.dsh/profiles/<profile>/cordis.patch.yml`（其中 `<profile>` 是你 `dsh web --profile` 用的名字，比如 `web`）：

```yaml
# 把心跳从 2s 调到 15s：容忍窗口从 ~4-6s 变为 ~30-45s
- id: typert-gateway
  name: '@deepseek-ai/dsh-api-gateway'
  config:
    websocketHeartbeatIntervalMs: 15000
```

- 建议先 `15000`；若仍偶发，可到 `30000`（即回到历史默认行为）。代价：**真正断线被检测到会变慢**（最坏 ≈ 2×间隔），但换来对后台节流/抖动/短休眠的宽容。
- 说明：`MAX_MISSED_HEARTBEATS=2` 是硬编码常量，改不了；只能通过拉长间隔来放大容忍窗口。

**(b) SSH 保活（防止隧道本身被中间设备/空闲回收）**

本机 `~/.ssh/config` 或命令行：

```sshconfig
Host dsh-remote
    HostName <server>
    User <user>
    LocalForward 3092 127.0.0.1:3092
    ServerAliveInterval 15
    ServerAliveCountMax 3
    TCPKeepAlive yes
```

服务器 `sshd_config`（可选加固）：`ClientAliveInterval 15`、`ClientAliveCountMax 3`。
（注：2s 心跳本身已让链路不空闲，所以 SSH 空闲超时通常不是主因；但加上更稳。）

**(c) 阻止浏览器冻结/挂起 dsh 这个站点**

- Chrome：设置 → 性能 → **Memory Saver** 里把 `127.0.0.1:3092`（或该站点）加入**「始终保持活跃」**名单；或用带参数的独立快捷方式：
  `chrome --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`
- 关掉系统的「低电量/省电模式」自动挂起后台标签；笔记本接电源、不要自动休眠。
- Safari：后台标签会被挂起，建议改用 Chrome/Edge 的上述配置，或保持窗口在前台/用独立窗口。

**(d)（可选）微调客户端重连退避** —— 让回到前台后的重试更勤快

> ⚠️ 注意：loader 的补丁层是**整块替换 `config`，不是深合并**（`vendor/loader/src/config/entry.ts:117-133`）。`connection` 在 web-app bundle 里原本带有 `trustedHosts: !!js ctx.webStartup.trustedHosts`，如果要覆盖它，必须把 `trustedHosts` 一并写上，否则会丢。SSH 本地转发走 127.0.0.1 loopback，一般不受影响，但仍建议保留：

```yaml
- id: connection
  name: '@deepseek-ai/dsh-client-connection'
  config:
    trustedHosts: !!js ctx.webStartup.trustedHosts
    recovery:
      backoffBaseMs: 300
      backoffFactor: 2
      backoffMaxMs: 5000
      generationReadyWarnMs: 3000
      generationReadyTimeoutMs: 15000
```

改完配置需重启 `dsh web`（`recovery` 会注入到新打开的页面，页面需刷新）。

### 4.2 第二层：客户端「可见性驱动即时重连」小补丁（强烈推荐，收益最大/改动最小）

当前最大体验痛点是：连接在后台已死，但重连的 `setTimeout` 被节流，回到前台才「补跑」，于是恰好在你切回时看到「重新连接中」。

建议在 `packages/client/connection/src/client/index.ts` 的 `watchBrowserNetwork` 旁边增加 visibility 监听（约 20 行）：

```ts
// 伪代码：在 installConnection 里，与 watchBrowserNetwork(controller) 并列
function watchBrowserVisibility(controller: ConnectionController): () => void {
  const doc = (globalThis as any).document
  if (doc === undefined || typeof doc.addEventListener !== 'function') return () => {}
  const onVisible = (): void => {
    if (doc.visibilityState !== 'visible') return
    // 回到前台：若当前没有活跃 generation，立刻重连（重置退避、跳过 sleep）
    if (!controller.isConnected()) controller.reconnect()
  }
  doc.addEventListener('visibilitychange', onVisible)
  return () => { doc.removeEventListener('visibilitychange', onVisible) }
}
```

要点：
- `controller.reconnect()` 会把 `attempt` 归零、`immediateRetry=true`、立即重试（`connection.ts:112-121`），从而**跳过被节流的退避等待**；
- 需要一个 `isConnected()` 判断（可读内部 `lastState === 'connected'`），避免健康时也重连；
- 可选增强：记录最后一次收到消息的时间，`visible` 时若「连接态但长时间无消息」也触发一次重连/探测；
- 可同时在 `visibilitychange` 变可见时刷新/放行前台被 rAF 积压的渲染。

这样「切回标签 → 连接成功」从「等一个被节流的退避周期」缩短到**近乎即时**，通知随之提前。

### 4.3 第三层：把通知搬到 Host 侧（根治「及时通知」，应对标签页被冻结/关闭/断网）

只要通知依赖浏览器页面，就必然受标签页生命周期和连接状态影响。**真正稳的做法**：写一个 **Host 插件**订阅会话生命周期，向外部通道推送。Host 侧事件齐全、与浏览器无关：

- `ctx.on('agent/status', ({ agent, status }) => …)`：`agent-loop/src/agent.ts:150` → 转发为 `api-session/status`（`api/session-controller/src/index.ts:204-206`）。在 `running → idle` 时判断「完成」。
- `ctx.on('session/created' | 'session/disposed' | 'agent/error' | 'session/event', …)`：`session-controller/src/index.ts:191-221`；`session/event` 里可识别 `turn/end`。
- 「需要用户回答」：可监听提问/审批 waterfall 的产生，或轮询会话投影 `userQuestions.active`（`interaction/user-questions/src/projection.ts:105,256-291`）；也可用 `gateway.hasLiveClient()`（`api/gateway/src/index.ts:322-328`）判断当前有没有活跃浏览器。
- 推送通道：仓库内**没有**现成的出站通知器（`packages/webhook`、`packages/hooks` 都是空目录；`packages/experimental/webhook` 是**入站**建会话，不发出）。但写一个几十行的 Host 插件即可：`fetch()` POST 到 **ntfy / Bark / Telegram Bot / 企业微信 / 邮件网关**。
- 现有可参考：`packages/experimental/webhook/src/index.ts:58-133` 展示了 host 插件注册/生命周期写法。

**验收口径**：完成/待回答的通知应「不依赖标签页是否在前台、是否还开着」——这正是 Host 侧推送能做到、页面插件做不到的。

### 4.4 第四层：上游改进建议（若你能改 DSH 源码）

1. 让「容忍的 miss 次数」可配置，或做**自适应心跳**（至少把 `MAX_MISSED_HEARTBEATS` 提升/可配）；
2. 加 **Page Visibility / freeze / resume** 处理（4.2）；
3. 心跳 `terminate()` 时**补一条日志**（现在服务端完全没有记录，排障困难）；
4. control baseline 增量游标化（现在每次重连全量重发全部会话投影）；
5. 提供 Host 侧 **outbound notifier** 插件点（4.3）。

---

## 5. 优先级建议

| 优先级 | 动作 | 成本 | 预期收益 |
|---|---|---|---|
| **P0** | 4.1(a) 调大心跳 + 4.1(b) SSH keepalive + 4.1(c) 禁止浏览器冻结 | 改配置/环境，分钟级 | 通常解决 80–90% 的「切回即重连」 |
| **P1** | 4.2 客户端可见性即时重连补丁 | ~20 行代码 | 「切回→连接成功」近乎即时，通知显著提前 |
| **P2** | 4.3 Host 侧通知插件 | 几十行 Host 插件 | 彻底解决「及时通知」，与浏览器解耦 |
| **P3** | 4.4 上游增强 | 中 | 长期稳定性 |

---

## 6. 关键文件索引（证据）

- 心跳/终止：`packages/api/gateway/src/stream-server.ts:42,108-127`；`packages/api/gateway/src/index.ts:147,212-213,255`；`packages/api/gateway/README.md:93`；测试 `tests/stream-server.host.spec.ts:55-67`。
- 客户端重连/无可见性处理：`packages/client/connection/src/client/connection.ts:23-33,112-121,164-268,296-301`；`src/client/index.ts:196-215,313-320`；`src/recovery-config.ts:26-30`。
- generation 唯一来源：`packages/api/gateway/src/client/index.ts:163-184,179`；`remote-events.ts:107-145`。
- 重同步/基线：`packages/api/session-controller/src/client/index.ts:132-140`；`sessions/manager.ts:346-357,413-423,761-775`；`control.ts:42-76`；`journal-stream.ts:115-127,261-303`；`transport.ts:172-220`；`sessions/session.ts:50-54`。
- 通知观察面/缺口：`packages/client/ui-session/src/client/index.ts:60-72,299-305,490-521,544`；`sessions/notifier.ts:31-44`；`ui-user-questions/src/client/index.ts:286-359`。
- 提问/审批不丢：`packages/api/gateway/src/index.ts:227,570-571,632-672`。
- Host 侧事件：`packages/core/agent-loop/src/agent.ts:150`；`packages/api/session-controller/src/index.ts:191-221`。
- UI 文案：`packages/client/ui-settings-general/src/client/locales.ts:35-36`；`SettingsRoot.tsx:26,29,205-212`。
- 历史默认变更：`af562d3649`（30s）→ `ccfbbb443af`（2s）。
- Loader 补丁替换语义：`vendor/loader/src/config/entry.ts:117-133`。

---

## 附录 A：4.2 的参考补丁（可直接落地，约 20 行）

`packages/client/connection/src/client/connection.ts`：给 `ConnectionController` 暴露一个只读连接态：

```ts
/** 当前 generation 是否已就绪（供可见性唤醒判断）。 */
get connected(): boolean { return this.lastState === 'connected' }
```

`packages/client/connection/src/client/index.ts`：新增可见性监听，并在 `start()`/`releaseOwner` 中挂载/卸载：

```ts
interface BrowserVisibilityTarget {
  readonly visibilityState?: string
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

function watchBrowserVisibility(controller: ConnectionController): () => void {
  const browser = (globalThis as { readonly document?: BrowserVisibilityTarget }).document
  if (browser?.visibilityState === undefined) return () => {}
  // 回到前台时若连接并未就绪，立刻重连（reset 退避 + 跳过 sleep）
  const onVisibility = (): void => {
    if (browser.visibilityState !== 'visible') return
    if (!controller.connected) controller.reconnect()
  }
  browser.addEventListener('visibilitychange', onVisibility)
  return () => { browser.removeEventListener('visibilitychange', onVisibility) }
}
```

- `ConnectionOwner` 增加 `readonly stopVisibilityWatch: () => void`；`releaseOwner` 里调用 `current.stopVisibilityWatch()`；
- `start()` 里 `const current = { token, source, controller, stopNetworkWatch: watchBrowserNetwork(controller), stopVisibilityWatch: watchBrowserVisibility(controller) }`。
- 可选增强：`onVisibility` 中若 `controller.connected` 为真但「距上次收到消息已超过 N 秒」，也调用一次 `controller.reconnect()` 做探活（需要额外记录 lastMessageAt）。

> 该补丁不改变任何既有语义，只是把「回到前台」变成一次即时重连触发点；实际连接/握手仍走原有受控路径。

---

## 附录 B：P0/P1 与 P2 的关系（不是二选一），以及 GitHub 生态现状

### B.1 它们解决的是不同维度，不能互相替代

| 场景 | P0+P1（连接保活 + 可见性即时重连） | P2（Host 侧推送） |
|---|---|---|
| 标签页仍开着、只是切到后台（未被冻结） | ✅ 通知基本能及时（浏览器后台仍会弹系统通知） | ✅ |
| 标签页被浏览器冻结 / 内存回收丢弃 | ⚠️ 可能失效（页面 JS 停摆） | ✅（Host 不受影响） |
| 关闭标签页 / 关闭浏览器 | ❌ 页面插件无从运行 | ✅ |
| 笔记本休眠 / 断网 / SSH 断开 | ❌ | ✅（Host 侧仍跑，恢复后补发） |
| 想推送到手机 / 锁屏 / 人不在电脑前 | ❌ | ✅ |
| **网页端切回是否还转圈/卡顿** | ✅ 只有它能治 | ❌ P2 不管网页体验 |

结论：
- **要根治「网页切回转圈、会话刷新慢」→ 只有 P0/P1。**
- **要根治「页面不可用时通知仍及时到达」→ 只有 P2。**
- 你描述的主场景是「切标签页再切回」（标签页一直开着），**这种 P0+P1 就够了**；但如果要「关标签页 / 手机 / 休眠也能收到」或「绝不漏报」，必须 P2。
- 还有一个 P0/P1 覆盖不到的小坑：断连窗口内完整发生的「运行→完成」，可能因 `completionUnread` 静默播种而漏报（见 §2.5）。P0/P1 只缩小窗口，不消除；Host 侧观察 `agent/status` 跳变则不会漏——这也是 P2 的价值。

### B.2 GitHub 生态：这个「Host 插件订阅事件 + 外发通知」的想法已被实现，而且很成熟

DSH 是开源的（`deepseek-ai/deepseek-harness`，topics 含 `dsh-plugin`），第三方插件极多。按架构归类：

**① Host 侧多通道推送（正是 P2 的根治法）**

| 插件 | 亮点 | 说明 |
|---|---|---|
| [THEWOLFWALKER/dsh-notifier](https://github.com/THEWOLFWALKER/dsh-notifier)（~59★） | **28 条出站通道**（Bark / ntfy / Telegram / DingTalk / Feishu / Pushover / ServerChan / Webhook…）+ **6 条入站控制**（手机审批/回答/远程会话/切换任务），Native UI，热更新，零运行时依赖 | 明确是 **Host 插件**：`dsh plugin add dsh-notifier@latest --profile <p>`，重启后加载 Host 插件 + client.js；架构图就是「DSH events → notifier core → 28 outbound」。即你设想的 P2，且更进一步做了远程控制。 |
| [PlutoKeating/dsh-lark-bot](https://github.com/PlutoKeating/dsh-lark-bot)（~41★） | 飞书/Lark bot：流式卡片、并行任务、跨会话通知、崩溃自救 | 若你用飞书，等于一条现成的 Host→IM 通知通道。 |

**② 页面侧桌面通知（仍受「页面必须存活」限制，属于 P0/P1 的受益者而非替代）**

| 插件 | 亮点 |
|---|---|
| [omdsh-dev/dsh-notification](https://github.com/omdsh-dev/dsh-notification)（~91★） | turn 完成通知，按结果/关键词过滤。**README 自己写明**：需要页面开着（后台能弹，关标签页不能）；**断连期间发生的完成不会在重连后补通知**——正好印证本报告 §2.5 的漏报边界。 |
| [chromoany/dsh-notify-me](https://github.com/chromoany/dsh-notify-me)（~91★） | 系统通知 + 提示音 + 标签页标题，区分「需要你操作 / 回复完成」 |
| [Oscar-Williams/dsh-deepcanary](https://github.com/Oscar-Williams/dsh-deepcanary)（~92★） | 本地提醒 / 安静通知 / 任务收件箱 |
| [610la/dsh-notification-center](https://github.com/610la/dsh-notification-center)、[Machine-126/dsh-alert-sound](https://github.com/Machine-126/dsh-alert-sound)、[BillCx330/dsh-plugin-notify-sounds](https://github.com/BillCx330/dsh-plugin-notify-sounds)、[AlonDan/dsh-notifications](https://github.com/AlonDan/dsh-notifications)、[YiMlT/dsh-notify-yimit](https://github.com/YiMlT/dsh-notify-yimit)、[Pasumao/dsh-plugin-notify](https://github.com/Pasumao/dsh-plugin-notify)（Windows 原生 Toast+托盘）、[pitetow/dsh-notify-on-complete](https://github.com/pitetow/dsh-notify-on-complete)、[takboo/dsh-coopanion](https://github.com/takboo/dsh-coopanion) 等 | 各具提示音/托盘/点击跳转等；绝大多数是**浏览器 Notification API**，因此都受「页面存活」约束 |

**③ 手机端 companion（自带独立通道，天然绕开浏览器标签页）**

[sorsama/deepseek-harness-mobile](https://github.com/sorsama/deepseek-harness-mobile)（~251★，Android）、[yiheng-zyh/DSH-Pal](https://github.com/yiheng-zyh/DSH-Pal)、[Mars-Sea/dsh-deeppilot](https://github.com/Mars-Sea/dsh-deeppilot)（iPhone）、[Phant0Meow/dsh-meow-smooth](https://github.com/Phant0Meow/dsh-meow-smooth)。

> 选型建议：如果目标是「彻底不被浏览器标签页生命周期影响」，选 **① 的 dsh-notifier**（或你已在用的 IM 对应的 bot）；页面侧的 ② 只能作为辅助，不能替代 P2。安装前按各仓库的兼容矩阵核对 DSH 版本（本机为 `0.2.1-rc.3`）。生态目录可看 [dshfind.com](https://dshfind.com)。

---

## 附录 C：2026-11-04 实施记录

本机实际情况：`dsh-web` 由 systemd user unit `dsh-web.service` 运行，直接以 tsx 从 checkout
(`/home/s00653124/workspace/deepseek-harness`) 启动，profile 为 `web`。

### C.1 P0（已实施）

- 文件：`~/.dsh/profiles/web/cordis.patch.yml`
- 行：`typert-gateway.config.websocketHeartbeatIntervalMs: 15000`
- 效果：服务端 Ping 容忍窗口由 ~4–6s 放宽到 ~30–45s。
- 校验：`dsh --dump-config --profile web` 合成树中出现该值（exit 0）。

### C.2 P1（已实施）

- 文件：`packages/client/connection/src/client/connection.ts`（新增 `connected` getter）、
  `packages/client/connection/src/client/index.ts`（`watchBrowserVisibility` + owner 生命周期）。
- 行为：`visibilitychange → visible` 且未连接时立即 `reconnect()`（重置退避、跳过被节流的
  setTimeout）；离线时不触发。
- 校验：`tsc -b packages/client/connection/tsconfig.client.json` 通过；
  `vitest run connection.client.spec.ts client-apply.client.spec.ts` **57/57 通过**；
  `tsdown ... client` 重建 `lib/client.browser.js`（含 `visibilitychange`）。
- 该 bundle 变化会被 Host 的 client-hmr stat watcher（500ms）发现并广播 `rebuilt`；重启后必定生效。

### C.3 P2（已实施，等待填通道）

`THEWOLFWALKER/dsh-notifier@0.13.1` **未安装**：其 `peerDependencies` 与自述兼容矩阵只覆盖
DSH **0.1.7-***（`@deepseek-ai/dsh-session: 0.1.7-alpha.1 || … || 0.1.7-rc.2`），
而本机是 **0.2.1-rc.3**（`@deepseek-ai/dsh-session@0.2.1-rc.3`，cordis 4.0.5）。安装会在重启时
按 0.1.7 契约加载，存在加载失败/拖垮 Host 的风险。

改为自建最小 Host 侧插件：

- 插件：`/home/s00653124/workspace/dsh-host-notifier/index.ts`（单文件，仅 import `node:fs`）。
- 观察 Host 事件：`session/event` 的 `turn/end`（完成/出错）、`tool/call` 与 `tool/ptc-dispatch`
  的 `ask_user_question`（待回答）、`approval/asked`（待审批）、`session/title`（标题）。
- 通道：`ntfy` / `bark` / `telegram` / `webhook` / `log`。
- 接线：`~/.dsh/profiles/web/cordis.patch.yml` 的 `- insert:` 行，`name` 为上述文件的绝对路径
  （app-boot 会转成 `file://` URL）。
- 当前配置：`logOnly: true`（只写日志与 `/tmp/dsh-host-notifier.debug`，不外发），
  通道模板以注释给出。
- 校验：真实 `ctx.plugin` 加载测试通过；`--dump-config` 合成树含该行；模拟事件测试输出正确
  （完成/提问/审批/出错；subagent 按配置跳过）。

### C.4 生效方式（必须重启一次）

P0 的 profile 配置与 P2 的**新增行**都需要 Host 重启才会加载（本机 HMR 的 profile-patch 热重载
未能确认生效；日志不可读）。重启命令：

```bash
systemctl --user restart dsh-web
```

重启会中断当前网页会话（页面会自动重连，会话本身持久化）。验证：

```bash
tail -f /tmp/dsh-host-notifier.debug
# 期望首行： [host-notifier] active: events=completed,error,question,approval channels=log
```

### C.5 仍需手工完成的环境项（在“你的笔记本”侧，不在服务器）

- SSH：`ServerAliveInterval 15` / `ServerAliveCountMax 3` / `TCPKeepAlive yes`。
- 浏览器：Chrome 将 `127.0.0.1:3092` 加入 Memory Saver 白名单（或关闭后台冻结）。
- P2 真正外发：把 `dsh-host-notifier` 行里一个通道取消注释并填好，`logOnly: false`，再重启。
  也可用环境变量 `DSH_NOTIFY_CHANNELS='[{...}]'` 放在 systemd unit 里，避免密钥进 profile 文件。
