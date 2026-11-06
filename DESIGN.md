# Agent 控制台：多 Agent 统一监控与下发 —— 可行性结论与实施方案

> 结论日期：2026-11-03。全部为作者本机（Windows）实测。
> 证据来源：Codex / Grok Bot、Marvis / WorkBuddy 两组本地调研笔记（未随本仓库发布）。
> 执行前置：Node（22+）、Python 3.10+（含 sqlite3）、Codex CLI、WorkBuddy 内置 `codebuddy` CLI——均已验证可用。

---

## 一、结论

**能做，但要拆成三件独立的事，可行性差别很大。**

| 能力 | Codex | Grok Bot | Marvis | WorkBuddy | DeepSeek Harness |
|---|---|---|---|---|---|
| 只读监控"在做什么" | ✅ 可直接做 | ✅ 可直接做（仅本机副本） | ✅ 中高 | ✅ 高 | ✅ 原生 |
| 界面里下发提示词 | ✅ 官方 CLI | ⚠️ 仅 UI 自动化（灰区） | ⚠️ 仅 UI 自动化（灰区） | ✅ 官方 CLI/ACP | ✅ 原生 |
| 接入成本 | 低 | 低（读）/ 高（写） | 中（读）/ 极高（写） | 低 | 无 |

一句话：**"看见"这件事基本全部可做，且不用注入进程、不用逆向；"接管"只有 Codex 和 WorkBuddy 有官方入口，Grok Bot 与 Marvis 只能 UI 自动化。**

另外，你想的"调用 WorkBuddy 的 DeepSeek token"——**可以实现，而且不需要插件**，它本质是一个配置项（见第五节）。

---

## 二、关键实测事实

### 2.1 为什么"看"能成立：它们都把状态落在本地

| Agent | 主数据源 | 活跃判据（可靠度从高到低） |
|---|---|---|
| Codex | `~/.codex/state_5.sqlite`（`threads` 596 行，含 `cwd`/`project_id`/`recency_at_ms`）、`sqlite/codex.db` | `active_chat_turns` 有行 ★★★★★；rollout 尾部 `task_started` 无配对 `task_complete` ★★★★★；`logs_2.sqlite` 近 10s ★★★★ |
| Grok Bot | `%APPDATA%\Grok Bot\sand-client-persistence\`（base32 文件名 + 明文 JSON） | `sand-client-persistence` 里 `transcript.replicas.<id>.value.persistedAt` 新鲜度；`local-exec-daemon.json` 的 `inflightCount>0`；进程存活 |
| Marvis | `~/.marvis/database/data.db` | `agent_activities.status`、`agui_events.timestamp`、`approvals.status='pending'`（待人工确认，实测有 2 条） |
| WorkBuddy | `~/.workbuddy/workbuddy.db` + `sessions/<pid>.json` 心跳 + `logs/<date>/*.log` | `sessions.status`/`last_activity_at`；CLI host 的 `lastHeartbeat`；`tasks/<uuid>/*.json` 的 todo 状态（能细到"当前第几步"） |
| DSH | `~/.dsh/sessions/**` + `ctx.agents.list()` | 宿主服务原生提供 |

### 2.2 为什么"写"只有两家有门

- **Codex**：`codex queue --thread <id> --message "<text>"`（官方），落 `queue_1.sqlite.queued_items`，底层 `thread/queue/add`；另有 `codex exec` / `app-server --listen ws://` + JSON-RPC v2（`thread/*`、`turn/start`）。**坑：有 `thread-writer-locks` 独占写者，不要抢 resume，优先 queue。**
- **WorkBuddy**：包内自带完整 CLI（`resources\app.asar.unpacked\cli`，`@tencent-ai/codebuddy-code` 2.115.0），支持 `-p/--print`、`--acp`（JSON-RPC over stdio）、`daemon`/`ps`/`logs`/`attach`/`kill`、`--bg`。GUI 本身就是通过 ACP 驱动这个 CLI 的。
- **Grok Bot**：无 CLI、无本地端口（唯一本地 HTTP 是 dev-only，代码原文要求未打包 + `SAND_DEV_CAPABILITY=1`），IPC 只对自己渲染进程开放（`assertTrustedRequester`），且 `sendPrompt` 在内部表里被标为 `"person"`（需用户在场）。→ 只能 UI 自动化。
- **Marvis**：无 CLI。本地通道是 UI↔agent 私有 JSON-RPC + NNG，带 tunnel/cdp token 鉴权。→ 只能 UI 自动化。

---

## 三、方案架构：一个 DSH Cordis 插件「Agent 控制台」

选在 DSH 里做，是因为它同时有：可编程的 UI 插槽、Host 侧文件/子进程/定时器能力、以及能把外部 Agent 变成"工具"给模型调用。

### 3.1 两半结构

**Host 半（采集 + 动作）**

```
ctx.fs            读状态文件 / SQLite 副本
ctx.subprocess    调 codex.exe、codebuddy CLI；SQLite 查询走 python -c
ctx.timer         自适应轮询（活跃 2s / 空闲 10–30s）
ctx.webServer     或 @Remote 方法，供 Client 半取数
ctx.tools.register 暴露 agents_console_list / agents_console_send 给模型自己用
```

- **适配器（adapter）模式**：每个 Agent 一个 collector 模块，输出同一种 `AgentCard`。新增 Agent = 加一个文件，不动 UI。
- **只读纪律**：SQLite 一律 `mode=ro`（`thread_history_1.sqlite` 需 `immutable=1`）；运行中的库**先复制 db+wal+shm 到临时目录再读**，避免加锁/写 WAL。
- **采集脱敏**：`~/.codex/config.toml`（含明文 token）、`auth.json`、Grok 的 `Local State`/密封凭证、WorkBuddy 的 `models.json`/`settings.json` 一律**不进 UI、不进日志**，只允许白名单字段。

**Client 半（UI）**

- `sidebar.panellist` 注册一个图标 → 点开是 `main` 插槽里的整页面板（该插槽 `keyDomain` 开放，当前只被 `conversation` 占用）。
- 页面三块：**总览卡片墙**（每个 Agent 一张卡：存活、当前会话、当前步骤、最后活动、待你确认的事）→ **详情抽屉**（实时日志尾巴 / 消息流）→ **底部输入框**（对"可下发"的 Agent 启用，不可下发的显示"仅监控"并注明原因）。

### 3.2 统一数据模型

```ts
interface AgentCard {
  app: 'codex' | 'grokbot' | 'marvis' | 'workbuddy' | 'dsh'
  displayName: string
  online: boolean                    // 进程/心跳
  busy: boolean                      // 有活跃 turn
  session: {
    id: string
    title: string
    cwd?: string
    step?: string                    // "正在跑 pnpm test" / todo 第 2 步
    startedAt?: number
  } | null
  lastActivityAt?: number
  pendingApprovals?: number          // Marvis approvals、Codex 审批
  canSendPrompt: boolean             // 只有 codex / workbuddy / dsh 为 true
  channels?: ('cli' | 'acp' | 'rpc' | 'ui-automation')[]
}
```

### 3.3 下发通道分级（重要：不要把所有 Agent 当同级）

| 级别 | 通道 | 用于 | 稳定性 |
|---|---|---|---|
| L1 | 官方 CLI / ACP | Codex `queue`、WorkBuddy `codebuddy -p/--acp` | 高（版本内稳定） |
| L2 | 官方 RPC | Codex `app-server` JSON-RPC | 中（需自己管进程/鉴权） |
| L3 | UI 自动化 | Grok Bot、Marvis | 低（灰区、易碎、输入法/焦点问题） |

**建议：v1 只做 L1。** L3 做成"默认关闭、明确标注实验性"的开关，且失败即静默降级为只读，不让它污染核心链路。

---

## 四、风险与边界（必须接受的部分）

1. **版本脆弱**：全部依赖别家的本地 schema（SQLite 表、日志字段、CLI 参数）。→ 每个适配器带 schema 探测 + 版本号，解析失败降级为"仅进程存活"，不崩整个面板。
2. **数据不完整**：Grok Bot 本机只是云端副本（transcript 上限 200 条）；Marvis 私有协议无文档。
3. **合规灰区**：Grok/Marvis 的 UI 自动化与逆向都可能触碰服务条款；WorkBuddy 的 SaaS 协议对自动化调用通常有限制。→ 只用官方 CLI，不做逆向。
4. **隐私放大**：聚合后一处可见全部聊天/路径/审批内容（可能包含个人文档、浏览记录、文件操作等私人会话）。→ 数据只在本机渲染，不落盘、不上云；默认脱敏展示。
5. **风控**：高频轮询/频繁起会话可能被判异常。→ 事件驱动（文件 watcher + 去抖）替代高频轮询，CLI 调用加节流。

---

## 五、关于"在 DSH 里用 WorkBuddy 的 DeepSeek token"

### 5.1 先纠正一个认知

`~/.workbuddy/models.json` 里那条 **不是 WorkBuddy 的账号 token，而是你自己填进去的 DeepSeek 开放平台 API key**：

```json
{ "id": "deepseek-v4-flash", "vendor": "DeepSeek",
  "url": "https://api.deepseek.com/chat/completions",
  "apiKey": "sk-…（35 字符，明文存储）" }
```

判定依据：`sk-` + 32 hex 形态、端点是官方 `api.deepseek.com`（WorkBuddy 自家域名只有 `copilot.tencent.com`/`codebuddy.cn`）、无任何 OAuth refresh/expiry 字段、明文无 DPAPI、日志显示它由 `CustomModelsProductProvider` 作为"用户自定义 provider"加载。

对照：WorkBuddy 的**账号身份**（Chromium Cookies + `Local State` 的 `os_crypt`，DPAPI 加密）只能调腾讯 SaaS 后端，**不可复用、也不该复用**。Marvis 则完全没有 DeepSeek 凭证（`model_configs` 表为空）。

### 5.2 所以：可以，而且是纯配置，不用写插件

DSH 自带通用 provider 插件 `@deepseek-ai/dsh-llm-pi-ai`，支持 `baseURL` + `apiKeyEnv`（凭据引用，**密钥不进配置文件**）：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      deepseek-byok:
        displayName: DeepSeek (自有 Key)
        api: openai-completions
        baseURL: https://api.deepseek.com
        apiKeyEnv: DEEPSEEK_API_KEY
        models:
          - id: deepseek-chat
            name: DeepSeek Chat
            contextWindow: 131072
```

`DEEPSEEK_API_KEY` 通过 DSH 的凭证开关/设置页写入凭证库（不写进 yaml）。

### 5.3 三个必须先验证/决策的点

1. **`deepseek-v4-flash` 是 WorkBuddy 的内部别名**，直连 `api.deepseek.com` 大概率不认。接之前先用该 key 调一次 `GET https://api.deepseek.com/models` 拿到真实可用 model id（未验证，本次刻意没发请求、不消耗你的额度）。
2. **"复用 token" ≠ 用 WorkBuddy 的额度**。它花的是你自己 DeepSeek 账户的钱，只是省了"再填一次 key"。
3. **安全建议**：这把 key 在 `models.json` 里是**明文**，同用户任何进程都能读。建议给 DSH 单独申请一把新 key、轮换旧的旧 key，并把 `models.json` 收紧 ACL。

---

## 六、分期实施

| 阶段 | 范围 | 产出 | 风险 |
|---|---|---|---|
| **P0**（1–2 天） | 只读看板：5 个 Agent 的 `AgentCard` + 总览页 + 详情抽屉 | 能一眼看到"谁在跑、跑到哪、谁卡在等你确认" | 零写操作，零风险 |
| **P1**（2–3 天） | L1 下发：Codex `queue`、WorkBuddy `codebuddy -p`；下发后回读校验 | 在界面里直接给这两个 Agent 派活 | 低 |
| **P2**（按需） | 协议级接入：Codex `app-server` 常驻连接（实时事件流）；WorkBuddy `--acp` 长驻会话 | 秒级推送、真正的"会话托管" | 中（进程/鉴权管理） |
| **P3**（可选） | L3 UI 自动化（Grok Bot / Marvis），默认关闭 | 补齐最后两家 | 灰区、易碎 |
| **附带**（10 分钟） | 5.2 的 BYOK provider 配置 | DSH 可用自有 DeepSeek key | 低 |

### P0 验收标准

- 五个 Agent 全部出现在面板，状态与实际一致（用 `~/.codex/sqlite/codex.db` 的 `active_chat_turns`、WorkBuddy `sessions.status`、Marvis `approvals` 交叉核对）。
- 应用未运行时显示"离线"，不是"空闲"。
- 打开面板不产生任何应用侧写入（`mode=ro` + 副本读，可验证）。
- 解析失败降级为"仅存活"，面板不白屏。

---

## 七、P0 实现状态（2026-11-03 已落地）

插件已实现并安装到当前 profile（`~/.dsh/profiles/desktop`），包路径 [agent-console/](../agent-console/)。

| 组件 | 文件 | 说明 |
|---|---|---|
| Host 半 | `index.js` + `collector.py` | 注册只读路由 `GET /agent-console/cards`；采集器用 `mode=ro` 读 SQLite、读 JSON、枚举进程，1.5s 结果缓存，失败时回退上一次快照并标注 stale |
| Client 半 | `client.js` | `sidebar.panellist` 图标（order 20）+ `main` 面板（key `agent-console`），卡片墙 + 详情抽屉，5s 自动刷新，仅用 `--dsw-alias-*` 主题变量 |
| 元数据 | `locale/zh.json`、`locale/en.json`、`icon.svg` | 中英标题与描述、原创图标 |

已验证：

- 路由返回真实数据（HTTP 200），5 个 Agent 全部有卡片，采集错误 0 条。
- 客户端两个插槽均注册为 active（`sidebar.panellist#agent-console`、`main#agent-console`）。
- 只读性：App 数据目录无 `-journal` 残留，三个 SQLite 的 mtime 未变（仍是应用自己最后写入的时间）。
- 未验证：面板的像素级渲染（本会话无浏览器控制），需人工看一眼侧栏图标与卡片样式。

已知边界：路由未加鉴权（仅 127.0.0.1 可访问）；Grok/Marvis 的"空闲/运行"是启发式判断；`restart-required` 未触发——两半都已热加载生效。

## 八、P1 实现状态（2026-11-04）

在 P0 基础上增加了两层：**多会话**与**官方下发通道**。

| 能力 | 实现 | 验证 |
|---|---|---|
| 每个 Agent 多会话 | 采集器为每家返回 `sessions[]`：Codex 为 `state_5` 用户线程 ∪ `local_thread_catalog`（见 8.1），WorkBuddy 取 `sessions` 表，Marvis 取 `conversations` + 每条最近 activity，Grok 取 roster 的 8 个 Bot | 实测 Codex 40（含归档/云端）/ WorkBuddy 20 / Marvis 17 / Grok 8 |
| 会话详情 | `GET /agent-console/session?app=&id=`，按家读取正文：Codex rollout（未压缩直接读尾；`.jsonl.zst` 由 Host 用 Node 的 zstd 流式解压、只保留尾部 4 MB）、Marvis `messages`、WorkBuddy `projects/<cwd>/<id>.jsonl`、Grok 最后一条消息 | 实测 Marvis 19 条、WorkBuddy 22 条、Codex 40 条（4 MB 压缩包 314 ms，18 MB 包 702 ms） |
| UI 三层导航 | 卡片墙 → 点击进入 Agent 工作台（左会话列表 / 右正文）→ 底部输入框 | 插槽注册已确认；像素渲染未验证 |
| 下发（Codex） | `codex queue --thread <id> --message <text>`，**追加**到该会话队列 | 预览已验证，含中文参数；真实发送未由我触发 |
| 下发（WorkBuddy） | `codebuddy -p <text> --output-format json`，在该会话 cwd **新起一次 CLI 运行** | 同上 |
| 安全设计 | 两段式：先返回预览命令与语义 → 用户确认后才 spawn；任务异步执行，前端 1.2s 轮询结果 | 预览/拒绝/404 均验证；无写入残留（queue 仍 0 条） |

### 8.1 历史可读性修复（同日）

原因：`local_thread_catalog` 只列了 **89** 个近期本机会话，而 `state_5.sqlite` 存了 **597** 个线程——其中 97 个是用户会话、101 个已归档（2026-08 至 10 月）。旧版只按 catalog 取数，所以"以前在本机做的工作"根本进不了列表。

改法：

1. 会话列表改为 **`state_5` 用户线程 ∪ `local_thread_catalog`**：本机近期 20 + 本机已归档 12 + ChatGPT 云端 8，分别标注「本机 / 已归档 / 云端」。
2. 详情改为四级回退：rollout 文件 → 压缩 rollout（Host 流式解压）→ `thread_history_1.sqlite` 的 `thread_items` 投影（rollout 已删也能还原 user/agent 消息、命令、MCP 调用、文件改动）→ 元数据里的首条消息/预览 → 云端会话给出明确说明。
3. 会话列表的一行摘要也来自投影：取该会话最后一条 `agentMessage`。

实测（当前 40 条列表）：

| 分组 | 条数 | 可读正文 | 来源 |
|---|---|---|---|
| 本机近期 | 20 | 20 | rollout |
| 本机已归档 | 12 | 9 | 8 条由 `thread_history` 投影恢复，1 条 rollout |
| ChatGPT 云端 | 8 | 0 | 正文在账号侧，界面明确提示 |

已知限制：ChatGPT 云端会话（catalog 里 `host_id=chatgpt:*`，106 个）本机只有标题与时间，无法从本地读取正文，也不支持下发；3 条已归档会话确实没有任何正文（会话被中断或从未产生条目）。

### 8.2 修正：Marvis 显示 2 条等待，但打开 Marvis 看不到（2026-11-06）

现象：面板给 Marvis 标了「2 项待确认」，用户打开 Marvis 却没有任何待审批提示。

查证（`~/.marvis/database/data.db`）：

- 两条 `approvals` 行 `status='pending'`，创建于 2026-10-31 03:07 / 03:38，属于会话「排查电脑故障并总结日志」。
- 该会话 `conversations.status='completed'`，最后更新 2026-10-31 23:30；之后 `agent_activities` 里 computer-agent 仍是 `success`（11-01 07:30）。
- 即：**运行结束后 Marvis 没有回写这两行**，数据库里留下永不消解的 pending；而 Marvis 的界面只在**运行中的会话**里展示审批，所以打开看不到。

根因在采集器：原来直接 `count(*) where status='pending'`，把历史残留算成了"等你确认"。

改法：

1. `approvals` 与 `conversations` 关联后再分类：会话已结束（completed / cancelled / failed / archived）或缺失、或记录超过 7 天 → 归为 **历史残留**；只有会话仍在进行中的 pending 才算**待你确认**。
2. 卡片新增 `staleApprovals` 字段：顶部汇总与工位气泡只统计真正的待确认；残留以备注文字呈现（「2 项历史待确认（会话已结束）」）。
3. 会话列表对仍待确认的会话加琥珀色徽标；会话详情额外列出审批记录，并对残留行标注「历史残留：会话已结束，Marvis 界面不再展示」。

验证：HTTP 快照 `marvis pending=0 stale=2`，备注与详情说明均生效。

### 8.3 修正：关闭 Marvis 后仍显示在岗；以及全 Agent 可下发（2026-11-06）

**在岗判断**：Marvis 有一个开机自启的 `MarvisSvr` 服务（LocalSystem，进程快照里通常看不到），关掉客户端它仍在跑。原逻辑 `online = 客户端进程 or 服务进程` 把"服务在跑"当成了"用户在用"，所以关了客户端仍显示在岗。现在：**只有 `Marvis.exe` / `MarvisAgent.exe` 才算在岗**，服务状态通过 `sc.exe query MarvisSvr` 单独检测并写进备注（「客户端已关闭（常驻服务 MarvisSvr 在跑）」）。顺手修了 Grok：`desktop-status.json` 里的 pid 重启后会失效，现在按进程名 `Grok Bot.exe` 兜底。

**全 Agent 下发**：现在四个外部 Agent 都能从控制台发提示词，通道分三档：

| Agent | 通道 | 语义 |
|---|---|---|
| Codex | `codex queue --thread <id> --message` | 追加到该会话队列 |
| WorkBuddy | `codebuddy -p ... --output-format json` | 在该会话目录新起一次 CLI 运行 |
| Grok Bot / Marvis | `send_ui.ps1`：聚焦窗口 → 剪贴板 `Ctrl+V` → `Enter` | 发到应用当前聚焦的会话 |

窗口自动化是兜底方案（这两家没有官方 CLI，私有 IPC 带鉴权且不建议逆向）：先 `-Probe` 找到 `MainWindowHandle != 0` 的窗口并回报 pid/标题，找不到就**直接拒绝发送**并提示「打开窗口、停在目标会话」；找到则预览里显示目标窗口标题，用户二次确认后才真正按键。限制：依赖窗口可见与输入框焦点，窗口切走可能发到别的会话；输入法/快捷键改动会影响它。

DSH 自己（本面板所在进程）仍不支持从这里下发——向它发提示词等价于"新建一个 DSH 会话"，需要走宿主 Agent 服务，留到下一步。

验证：`grokbot` 探到窗口（pid 41260，标题「Grok Bot」）并可进入预览；Marvis 关闭时返回明确错误且不按键；Codex 预览保持正常；未实际向任何 Agent 发送测试消息（避免污染用户会话）。

P1 其余限制：WorkBuddy 的 CLI 运行是**新起一次运行**，不会续写图形界面里的那段对话；Grok 只缓存每个 Bot 最后一条消息。

## 九、办公室视图（2026-11-06）

参考对象：Marvis 的办公室界面。它的实现是 Tiled 地图（`office.tmj`，17×14 房间）+ 两组工位（普通工位 + 老板工位，各含 desk / chair / computer 对象层）+ 一群系彩色围巾的小吉祥物 + 岗位标签（文件管家 / 电脑管家 / 浏览器管家）+「正在执行 N」的状态文案。

本插件的映射：

| Marvis | Agent Console |
|---|---|
| 工位（桌 + 椅 + 显示器） | 每个 Agent 一个工位：显示器 + 桌面 + 围巾吉祥物 |
| 屏幕亮 / 灭 | 屏幕亮 = 该 Agent 正在干活；熄灭 = 空闲 |
| 头顶气泡 | 有 `pendingApprovals` 时显示「!」气泡 + 待办数字 |
| 离席 / 打盹 | Agent 离线时吉祥物淡出并飘 z |
| 岗位标签 | 工位铭牌：名字 + 状态 + 会话数 + 当前任务一行 |
| 「正在执行 N」 | 办公室顶部汇总：N 位同事 / 在岗 X / 忙碌 Y / 等你 Z |
| 房间装饰 | 像素地板网格 + 两盆植物（纯装饰） |

实现：`client.js` 的 `OfficeView` / `Station` / `Mascot` / `Plant`，全部用 `--dsw-alias-*` 主题变量（围巾用 `color-mix(brand, 强调色)` 区分），动效用组件内 `<style>` 注入（卸载即移除）。头部新增 **办公室 / 列表** 视图切换，默认办公室；点工位进入原有的会话工作台。

验证（无浏览器控制，改用沙箱渲染测试）：[tools/smoke-client.mjs](../tools/smoke-client.mjs) 用 vm + 桩 React 执行 `client.js`，确认工厂注册、两个插槽注册、64 个文案键；并展开组件树得到 **5 个可点击工位、7 个 SVG 节点、2 个视图切换按钮**，无运行期异常。像素级观感仍未验证，需人工看一眼。

### 9.1 角色形象改为官方图标（2026-11-06）

原来工位上是我们自己画的围巾小怪兽。现在每个 Agent 直接用**对应应用自带的官方图标**：

- 来源：本机已安装应用的官方资源——`PrivateExtractIcons` 从各 exe 提取 256×256（Codex/ChatGPT、Grok Bot、WorkBuddy、DeepSeek Harness、Copilot、Gemini），Marvis 用其安装目录里的 `resources/icons/icon-original.png`。不联网抓图、不重绘、不引第三方图库。
- 分发：`assets/<app>.png` 随插件走，Host 新增 `GET /agent-console/asset?name=<app>.png`（文件名白名单 + 目录越界校验）；客户端 `onError` 回退到内置卡通形象，所以发现的应用没有图标时也不会破版。
- 状态表达保留：忙碌时图标外发光、离线时降饱和并飘 z、待确认时右上角「!」气泡；工位铭牌、显示器、汇总逻辑不变。
- 版权说明：这些图标是各厂商商标，仅用于标识对应应用；删除 assets 下文件即可回退。

验证：沙箱渲染展开后 6 个工位、2 个 SVG（植物）、**12 个官方图标 `<img>`**（工位头像 + 铭牌小图标）；`/agent-console/asset` 返回 `image/png`，非法文件名被拒。

### 9.2 会话详情结构化渲染（2026-11-06）

现象：详情把事件流当纯文本贴出来——工具调用是一整段 `exec const r=await Promise.allSettled(...)`，消息里的 Markdown（标题、加粗、表格）原样显示。

根因：采集器把每条 item 压成 `{role, kind, text}`，把命令、MCP 结果、diff 全拼进 text。

改法：采集器按 item 原样输出结构化事件，前端按类型渲染：

| kind | 字段 | 前端渲染 |
|---|---|---|
| `message` | role / text / phase | Markdown：标题、列表、引用、表格、代码块、行内 `code`/粗体/斜体/链接 |
| `command` | command / output / status / exitCode / durationMs / cwd | 命令卡：命令码块 + 可折叠输出 + 退出码/耗时 |
| `mcp` | server / tool / status / arguments / result | MCP 卡：`server.tool` + 参数、结果折叠 |
| `tool` | tool / input | 工具卡：名称 + 输入（JS/参数）折叠 |
| `file` | changes[{path, changeType, diff}] | 文件卡：路径 + 增/改/删徽标 + 着色 diff |
| `search` | queries / results[{domain, snippet}] | 搜索卡：查询 + 结果片段 |
| 其它 | text | 细行系统事件 |

实现要点：`client.js` 内置一个轻量 Markdown 渲染器（无外部依赖，避免加载 Harness Client 包）；命令/输出/参数/结果用原生 `<details>` 折叠；diff 逐行着色。数据侧优先用 `thread_history` 投影（带 command/aggregatedOutput/mcp result/diff），rollout 兜底时 `custom_tool_call` 也按 `tool + input` 结构化输出。

附带收益：优先走投影后，压缩 rollout 的 100 MB 流式解压只在"投影也没有"时才触发。

时间单位修正（同日）：投影里的 `created_at_ms` 本来就是毫秒，采集器早期多除了一次 1000，前端又按毫秒计算，导致所有事件显示成「20742 天前」。现在采集器原样透传，前端 `toMs()` 兼容毫秒 / 秒 / ISO 三种形态，并加了回归断言（三种输入都必须读作「刚刚」）。

验证：HTTP 实测某 Codex 会话 25 条事件（4 message + 21 command，含 exitCode/输出）；沙箱渲染 6 类事件卡全部通过（含 1 个表格、5 个代码块）。

### 9.3 Markdown 渲染对齐 Codex（2026-11-06）

调研：解析 Codex 桌面端 `app.asar` 的 19,396 个文件条目，在其 webview 打包产物里命中 `remark` / `micromark` / `katex` / `mermaid` / `shiki` / `prism` / `lowlight` / `sanitize` —— 说明它用的是 **remark/micromark 系 GFM 管线 + KaTeX 公式 + Mermaid 图 + Shiki/Prism 高亮 + HTML 消毒**。这就是它能把表格、任务列表、公式、图渲染出来的原因。

按这个标准补齐了内置渲染器（不引外部依赖）：

| 语法 | 处理 |
|---|---|
| GFM 表格 | 渲染真表格，支持 `:---` / `:---:` / `---:` 对齐 |
| 任务列表 | `- [ ]` / `- [x]` → ☐ / ☑ |
| 嵌套列表 | 按缩进生成子列表 |
| 删除线 / 粗斜体 / 行内码 | `~~x~~`、`**x**`、`*x*`、`` `x` `` |
| 链接 | 支持 `[text](url)` 与 `[text](<C:/path with spaces>)`（角括号会被剥离），图片降级为链接 |
| 公式 | `$$...$$` 区块与 `$...$` 行内按等宽块展示（不引 KaTeX） |
| Mermaid | 代码块标注「mermaid 图（源码）」（不执行） |
| 代码块 | 保留语言标签 |

另外补了 Codex 的**回合用时**：`thread_turns.duration_ms` 关联到该回合第一条助手消息，显示「用时 N 秒」。

排障标记：面板底部显示构建版本（当前 `v0.4.0`）。如果看不到这个标记，说明页面跑的还是旧前端 bundle，需要刷新页面（或重启 DSH）。

验证：用真实会话消息（含表格、角括号链接、多级标题）跑渲染器 → 8 个块、1 个表格、3 个链接（href 已剥离 `<>`）；GFM 扩展用例（任务列表 / 嵌套列表 / 删除线 / 公式 / 对齐表格）5 项断言全部通过。

## 十、自动发现更多 Agent（2026-11-06）

原来只有四个写死的适配器（Codex / Grok / Marvis / WorkBuddy），换一台机器或装新应用就看不到。现在增加一层**发现器**：显式适配器负责"能读会写"的深度集成，发现器负责把机器上其它 AI Agent 应用先列出来，标成「已发现」，等有人补适配器。

扫描来源（全部只读）：

| 来源 | 用途 |
|---|---|
| 注册表卸载项（HKLM / HKCU，含 WOW6432Node） | 安装目录、显示名 |
| `%LOCALAPPDATA%\Programs` | 每用户安装目录 |
| `%APPDATA%`、`%LOCALAPPDATA%`、用户主目录 dotfiles | 数据目录、活动时间 |
| 进程快照 | 是否在运行（按显示名/别名推断 exe 名） |

匹配方式是**关键词库**（codex / claude / cursor / copilot / gemini / qwen / kimi / doubao / 通义 / 豆包 / 元宝 / 智谱 …）；已适配的四家与同族目录（OpenAI、Anthropic、CodeBuddy）被显式排除，避免重复卡片。发现结果按"在运行优先、最近活动其次"排序，最多 10 个。

每张「已发现」卡片提供：运行状态、安装位置、数据目录、最近活动时间；会话列表为空，详情页说明"尚未适配"，并给出适配方式。UI 不需要为新应用改代码——卡片/工位/工作台都按数据渲染。

实测本机（2026-11-06）：发现 Copilot、Gemini、豆包三个新应用；面板从 5 张卡变成 8 张（4 适配器 + Harness 自身 + 3 已发现）。

已知限制：关键词匹配会有漏（例如只有 MSIX Appx 安装、注册表里没有 DisplayName 的应用）与少量误报（目录名恰好包含关键词）；未扫描 Appx/Store 包；发现结果不缓存，每次采集重算（注册表遍历约几十毫秒，可接受）。

## 十一、一句话回答最初的三个问题


1. **"能不能同时看到所有 Agent 在干什么"** → 能，五个里有四个的状态都在本地落盘，不需要注入或逆向；难点不在"看"，在"归一化不同家的数据"。
2. **"能不能在界面里给它们派活"** → Codex 和 WorkBuddy 能（官方入口）；Grok Bot 和 Marvis 只能 UI 自动化，不建议作为正式通道。
3. **"能不能用 WorkBuddy 的 DeepSeek token"** → 能，但那是你自己的 DeepSeek API key，不是 WorkBuddy 的额度；纯配置即可，先验证 model id，再建议换独立 key。
