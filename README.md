# Agent Console（DeepSeek Harness 插件）

在 DeepSeek Harness 里用一个面板同时查看、并驱动本机的多个 AI Agent：**Codex / Grok Bot / Marvis / WorkBuddy**，外加 Harness 自己。

主界面是「办公室」视图：每个 Agent 一个工位，屏幕亮着表示在干活，头顶气泡表示在等你确认，点工位进入它的会话列表与正文。

## 功能

- **办公室 / 列表两种总览**：在岗、忙碌、待确认数量一眼可见。
- **每个 Agent 多会话**：Codex 上百个（含归档与云端），WorkBuddy / Marvis / Grok 各数十个以内。
- **会话详情**：读取各家本地正文（Codex rollout、Marvis messages、WorkBuddy projects 日志、Grok 最后一条消息）。
- **下发提示词**（两段式确认，先预览再执行）：
  - Codex：`codex queue --thread <id> --message`（追加到该会话队列）
  - WorkBuddy：`codebuddy -p`（在该会话目录新起一次 CLI 运行）
  - Grok Bot / Marvis：窗口自动化（聚焦窗口 → 粘贴 → 回车）
- **官方形象**：每个 Agent 的工位使用该应用自带的官方图标（从本机安装包提取，非重绘、非第三方图库）。
- **自动发现更多 Agent**：扫描机器上的其它 AI Agent 应用，以「已发现」工位列出安装位置/数据目录/运行状态（暂无会话与下发，补适配器后升级为完整卡片）。
- **只读采集**：SQLite 全部 `mode=ro`，不修改任何应用数据。

## 官方图标

`assets/*.png` 里的形象全部来自本机已安装应用的官方资源，脚本 `tools/extract-icons.ps1`（工作区里，不在本仓库）用 `PrivateExtractIcons` 从各 exe 提取 256×256 图标：

| 文件 | 来源 |
|---|---|
| `codex.png` | ChatGPT / Codex 应用图标 |
| `grokbot.png` | Grok Bot 应用图标 |
| `marvis.png` | Marvis 安装目录 `resources/icons/icon-original.png` |
| `workbuddy.png` | WorkBuddy 应用图标 |
| `dsh.png` | DeepSeek Harness 应用图标 |
| `copilot.png` | Microsoft Copilot 应用图标 |
| `gemini.png` | Google Gemini 应用图标 |

Host 通过 `GET /agent-console/asset?name=<app>.png` 提供，带文件名白名单，不允许路径穿越；客户端 `onError` 时回退到内置卡通形象。

说明：这些图标是各自厂商的商标/版权素材，这里仅用于**标识对应应用**（nominative use）。如果权利人要求，删除 `assets/` 下对应文件即可，界面会自动回退到内置形象。

## 自动发现

发现器读取注册表卸载项、`%LOCALAPPDATA%\Programs`、`%APPDATA%`、`%LOCALAPPDATA%`、用户主目录 dotfiles，按关键词库（codex / claude / cursor / copilot / gemini / qwen / kimi / doubao / 通义 / 豆包 / 元宝 / 智谱 …）识别 AI Agent 应用；已适配的四家及其同族目录（OpenAI、Anthropic、CodeBuddy）会被排除，避免重复。

发现的卡片显示：是否在运行、安装位置、数据目录、最近活动时间。点进去会说明"尚未适配"。要真正接入某个应用：在 `collector.py` 里加一个 `collect_<name>()`（返回统一卡片结构）并在 `main()` 里注册即可，UI 无需改动。

已知限制：纯 Appx/MSIX 安装且注册表无 DisplayName 的应用可能漏；目录名恰好含关键词时可能误报；最多展示 10 个。

## 架构

```
agent-console/
├─ index.js          Host 半：注册 /agent-console/* 路由，调用采集器与下发通道
├─ collector.py      采集器（Python stdlib）：读 SQLite / JSON / 进程，输出统一 JSON
├─ send_ui.ps1       窗口自动化的兜底发送（Grok / Marvis）
├─ client.js         Client 半：sidebar 图标 + main 面板（办公室视图、会话列表、正文、输入框）
├─ cordis.patch.yml  bundle patch：插入插件行
├─ package.json      dsh bundle + dsh.client 声明
├─ locale/           中英文案
└─ icon.svg          插件图标
```

数据流：`Client` 每 5 秒请求 `GET /agent-console/cards` → Host 调用 `collector.py` → 统一结构返回。会话详情走 `GET /agent-console/session?app=&id=`；下发走 `POST /agent-console/send`（预览 / 确认两段），任务用 `GET /agent-console/job?id=` 轮询。

## 安装

需要 DeepSeek Harness（Desktop 或 CLI）与 Python 3（本机为 3.14）。把本仓库克隆/下载到本地任意目录，然后在 Harness 里：

```js
plugin_manager install_bundle <仓库目录的绝对路径>
```

`install_bundle` 会把它作为 bundle 安装进当前 profile。安装后侧栏会出现面板图标。

可选环境变量：

| 变量 | 用途 |
|---|---|
| `AGENT_CONSOLE_PYTHON` | 指定 Python 解释器（默认自动探测常见路径与 PATH） |
| `AGENT_CONSOLE_NODE` | 指定 Node（WorkBuddy CLI 启动器需要） |
| `CODEX_CLI_PATH` | 指定 `codex.exe`（默认探测托管 CLI 与 WindowsApps 安装路径） |

## 数据来源（只读）

| Agent | 会话列表 | 正文 | 活跃判断 |
|---|---|---|---|
| Codex | `state_5.sqlite` 用户线程 ∪ `local_thread_catalog` | rollout 文件；压缩包用 Node zstd 流式解压；缺失时用 `thread_history_1.sqlite` 投影恢复 | `active_chat_turns` |
| Grok Bot | `sand-client-persistence` 的 roster | 每个 Bot 的最后一条消息（完整会话在云端） | 进程 + `desktop-status.json` + 本地执行守护 |
| Marvis | `~/.marvis/database/data.db` 的 conversations | messages + agent_activities + approvals | `Marvis.exe` 进程（常驻服务不算在岗） |
| WorkBuddy | `~/.workbuddy/workbuddy.db` 的 sessions | `projects/<cwd>/<sessionId>.jsonl` | 进程 + CLI host 心跳 |

## 安全与边界

- 采集只读：SQLite `mode=ro`，不写任何应用数据；不读取凭证文件内容。
- 下发需要二次确认；窗口自动化在找不到窗口时**直接拒绝**，不会盲按键。
- Grok / Marvis 的窗口自动化依赖窗口可见与输入框焦点，可能发到当前聚焦的会话；这是兜底方案，不是官方通道。
- ChatGPT 云端会话（Codex 里 `host_id=chatgpt:*`）本机只有标题与时间，无法读取正文。
- Harness 自身暂不支持从这里下发（等价于新建 DSH 会话，留待后续）。

## 开发

```bash
# 语法检查
node --check index.js && node --check client.js
python -m py_compile collector.py

# 无浏览器渲染烟雾测试（vm + 桩 React，验证组件树可渲染）
node tools/smoke-client.mjs
```

设计文档见 [DESIGN.md](DESIGN.md)。
