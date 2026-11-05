/**
 * Agent Console — Client half.
 *
 * Sidebar icon + full main-panel page. Three levels:
 *   1. agent cards (what every local agent is doing right now)
 *   2. one agent's conversations (multiple sessions, not just the latest)
 *   3. one conversation's events + a composer for agents with an official send channel
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-agent-console',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'agent-console'
    const ROUTES = {
      cards: '/agent-console/cards',
      session: '/agent-console/session',
      send: '/agent-console/send',
      job: '/agent-console/job',
    }
    const POLL_MS = 5000
    const JOB_POLL_MS = 1200

    const DICT = {
      zh: {
        'panel.title': 'Agent 控制台',
        'panel.subtitle': '本机 AI Agent 的实时状态',
        'panel.refresh': '刷新',
        'panel.updated': '更新于',
        'panel.loading': '读取中…',
        'panel.error': '读取失败',
        'panel.stale': '数据可能已过期',
        'panel.auto': '每 5 秒自动刷新',
        'state.busy': '运行中',
        'state.idle': '空闲',
        'state.offline': '离线',
        'state.waiting': '等待你',
        'badge.readonly': '只读',
        'badge.canSend': '可下发',
        'badge.cloud': '云端',
        'badge.archived': '已归档',
        'badge.discovered': '已发现',
        'discovered.title': '已发现，尚未适配',
        'discovered.body': '扫描到了这个应用，但还没有对应的适配器：目前只能看到安装位置与数据目录，无法列出会话或下发提示词。',
        'discovered.install': '安装位置',
        'discovered.data': '数据目录',
        'discovered.adapt': '适配方式：在 collector.py 里加一个 collect_<name>() 适配器，即可把它的会话接进来。',
        'view.office': '办公室',
        'view.list': '列表',
        'office.hint': '点击工位进入该 Agent 的会话',
        'office.mgr': '本进程',
        'office.away': '不在岗',
        'office.tasks': '个任务',
        'office.legend': '屏幕亮着 = 正在干活，气泡里的数字 = 等你确认',
        'office.colleagues': '位同事',
        'office.onDuty': '在岗',
        'office.busyCount': '忙碌',
        'office.waitCount': '等你',
        'badge.pending': '项待确认',
        'badge.sessions': '个会话',
        'workspace.back': '返回',
        'workspace.pick': '从左侧选择一个会话查看详情',
        'workspace.empty': '该 Agent 没有可读的会话',
        'send.cloud': '这是 ChatGPT 云端会话，正文与队列都在账号侧，本机不能下发。',
        'detail.title': '详情',
        'detail.session': '会话',
        'detail.sessionId': '会话 ID',
        'detail.lastActivity': '最后活动',
        'detail.source': '数据来源',
        'detail.note': '备注',
        'detail.cwd': '工作目录',
        'detail.loading': '读取会话…',
        'detail.events': '事件',
        'detail.noEvents': '这个会话没有可读的正文事件。',
        'detail.close': '收起',
        'role.user': '你',
        'role.assistant': '助手',
        'role.system': '系统',
        'role.tool': '工具',
        'send.title': '下发提示词',
        'send.placeholder': '输入要发给这个 Agent 的提示词…',
        'send.button': '发送',
        'send.append': '会追加到该会话的队列（codex queue），桌面端取走后继续执行。',
        'send.new-run': '会在该会话的工作目录新起一次 CLI 运行（不是续写图形界面里那段对话）。',
        'send.ui': '该 Agent 没有官方命令行：会聚焦它的窗口，把文字粘贴进输入框并回车。请先在应用里打开目标会话、把光标停在输入框；窗口不在前台时可能发到别的会话。',
        'send.disabled': '这个 Agent 在本版本只提供只读监控。',
        'send.confirm': '确认执行？这一步会真的把内容发出去。',
        'send.confirmYes': '确认发送',
        'send.cancel': '取消',
        'send.running': '已提交，等待执行结果…',
        'send.done': '执行完成',
        'send.failed': '执行失败',
        'send.output': '输出',
        'send.again': '再发一条',
        'errors.title': '采集异常',
        'none': '—',
      },
      en: {
        'panel.title': 'Agent Console',
        'panel.subtitle': 'Live state of the local AI agents',
        'panel.refresh': 'Refresh',
        'panel.updated': 'Updated',
        'panel.loading': 'Loading…',
        'panel.error': 'Failed to load',
        'panel.stale': 'Snapshot may be stale',
        'panel.auto': 'Auto-refresh every 5 s',
        'state.busy': 'Working',
        'state.idle': 'Idle',
        'state.offline': 'Offline',
        'state.waiting': 'Needs you',
        'badge.readonly': 'Read-only',
        'badge.canSend': 'Can send',
        'badge.cloud': 'Cloud',
        'badge.archived': 'Archived',
        'badge.discovered': 'Discovered',
        'discovered.title': 'Discovered, not adapted yet',
        'discovered.body': 'This app was found on the machine but has no adapter yet: the console can show its install and data locations, but not its conversations or a prompt channel.',
        'discovered.install': 'Install location',
        'discovered.data': 'Data directories',
        'discovered.adapt': 'To adapt it: add a collect_<name>() adapter in collector.py.',
        'view.office': 'Office',
        'view.list': 'List',
        'office.hint': 'Click a workstation to open that agent’s sessions',
        'office.mgr': 'This process',
        'office.away': 'Away',
        'office.tasks': 'tasks',
        'office.legend': 'Lit screen = working · the number in the bubble = waiting for you',
        'office.colleagues': 'colleagues',
        'office.onDuty': 'on duty',
        'office.busyCount': 'busy',
        'office.waitCount': 'waiting',
        'badge.pending': 'pending',
        'badge.sessions': 'sessions',
        'workspace.back': 'Back',
        'workspace.pick': 'Pick a conversation on the left',
        'workspace.empty': 'This agent has no readable conversations',
        'send.cloud': 'This is a ChatGPT cloud conversation; its history and queue live on the account side, so it cannot be sent to from here.',
        'detail.title': 'Details',
        'detail.session': 'Conversation',
        'detail.sessionId': 'Conversation ID',
        'detail.lastActivity': 'Last activity',
        'detail.source': 'Source',
        'detail.note': 'Note',
        'detail.cwd': 'Working directory',
        'detail.loading': 'Loading conversation…',
        'detail.events': 'Events',
        'detail.noEvents': 'No readable events in this conversation.',
        'detail.close': 'Close',
        'role.user': 'You',
        'role.assistant': 'Assistant',
        'role.system': 'System',
        'role.tool': 'Tool',
        'send.title': 'Send a prompt',
        'send.placeholder': 'Prompt to send to this agent…',
        'send.button': 'Send',
        'send.append': 'Appends to this conversation’s queue (codex queue); the desktop picks it up.',
        'send.new-run': 'Starts a new CLI run in this conversation’s directory (it does not continue the GUI thread).',
        'send.ui': 'No official CLI for this agent: the console focuses its window, pastes the text into the composer and presses Enter. Open the target conversation first and keep the caret in the composer; if another window is in front the text may land in the wrong conversation.',
        'send.disabled': 'This agent is read-only in this version.',
        'send.confirm': 'Run it for real? This actually sends the text.',
        'send.confirmYes': 'Send now',
        'send.cancel': 'Cancel',
        'send.running': 'Submitted, waiting for the run…',
        'send.done': 'Finished',
        'send.failed': 'Failed',
        'send.output': 'Output',
        'send.again': 'Send another',
        'errors.title': 'Collector issues',
        'none': '—',
      },
    }

    const TOKENS = {
      bg: 'var(--dsw-alias-bg-base)',
      card: 'var(--dsw-alias-bg-layer-1)',
      card2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    function relTime(ms, t) {
      if (!ms) return t('none')
      const diff = Date.now() - ms
      if (diff < 45_000) return '刚刚'
      const m = Math.floor(diff / 60_000)
      if (m < 60) return `${m} 分钟前`
      const hr = Math.floor(m / 60)
      if (hr < 24) return `${hr} 小时前`
      return `${Math.floor(hr / 24)} 天前`
    }

    function stateOf(agent, t) {
      if (agent.busy) return { label: t('state.busy'), color: TOKENS.ok }
      if (agent.online) return { label: t('state.idle'), color: TOKENS.idle }
      return { label: t('state.offline'), color: TOKENS.idle }
    }

    function sessionState(session, t) {
      if (session.status === 'busy') return { label: t('state.busy'), color: TOKENS.ok }
      if (session.status === 'waiting') return { label: t('state.waiting'), color: TOKENS.warn }
      return null
    }

    const pill = (text, color, extra) =>
      h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '1px 8px', borderRadius: 999,
          fontSize: 11, lineHeight: '18px',
          color: color || TOKENS.sub,
          background: TOKENS.card2,
          border: `1px solid ${TOKENS.border}`,
          whiteSpace: 'nowrap',
          ...extra,
        },
      }, text)

    const btn = (label, onClick, opts = {}) =>
      h('button', {
        type: 'button',
        onClick,
        disabled: opts.disabled,
        style: {
          font: 'inherit', fontSize: 12,
          cursor: opts.disabled ? 'not-allowed' : 'pointer',
          opacity: opts.disabled ? 0.55 : 1,
          padding: '5px 12px', borderRadius: 8,
          color: opts.primary ? '#fff' : TOKENS.text,
          background: opts.primary ? TOKENS.brand : TOKENS.card,
          border: `1px solid ${opts.primary ? TOKENS.brand : TOKENS.border}`,
        },
      }, label)

    function Dot({ color, pulse }) {
      return h('span', {
        'aria-hidden': true,
        style: {
          width: 8, height: 8, borderRadius: '50%',
          background: color, flex: '0 0 auto',
        },
      })
    }

    const scrollBox = {
      minHeight: 0, overflow: 'auto',
      border: `1px solid ${TOKENS.border}`, borderRadius: 10,
      background: TOKENS.card,
    }

    async function getJSON(url) {
      const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    async function postJSON(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const doc = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(doc.error || `HTTP ${response.status}`)
      return doc
    }

    // ---------------------------------------------------------------- office
    const ACCENTS = {
      codex: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 78%, #8b5cf6)',
      grokbot: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, #14b8a6)',
      marvis: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, #f59e0b)',
      workbuddy: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, #ef4444)',
      dsh: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 60%, #22c55e)',
    }

    const OFFICE_CSS = `
      .ac-station {
        display: flex; flex-direction: column; align-items: center;
        padding: 8px 10px 12px; border-radius: 14px; background: transparent;
        border: 1px solid transparent; cursor: pointer; font: inherit; color: inherit;
        transition: transform .16s ease, border-color .16s ease, background .16s ease;
      }
      .ac-station:hover { transform: translateY(-3px); border-color: var(--ac-border); background: var(--ac-hover); }
      .ac-station:focus-visible { outline: 2px solid var(--ac-focus); outline-offset: 2px; }
      .ac-mascot { animation: ac-bob 3.2s ease-in-out infinite; transform-origin: 50% 90%; }
      .ac-station[data-busy="true"] .ac-mascot { animation: ac-type .9s ease-in-out infinite; }
      .ac-station[data-offline="true"] .ac-mascot { animation: none; opacity: .5; }
      .ac-bubble { animation: ac-pop .45s ease-out both; }
      .ac-zzz { animation: ac-float 2.6s ease-in-out infinite; }
      @keyframes ac-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-1.5px) } }
      @keyframes ac-type { 0%,100% { transform: translateY(0) rotate(-1deg) } 50% { transform: translateY(1.2px) rotate(1.2deg) } }
      @keyframes ac-pop { from { transform: scale(.5); opacity: 0 } to { transform: scale(1); opacity: 1 } }
      @keyframes ac-float { 0%,100% { transform: translateY(0); opacity: .55 } 50% { transform: translateY(-4px); opacity: .95 } }
    `

    function Mascot({ accent, busy, offline, waiting }) {
      return h('svg', {
        viewBox: '0 0 64 64', width: 64, height: 64,
        className: 'ac-mascot', 'aria-hidden': true,
      },
        h('path', { d: 'M18 18 L16 8 L26 14 Z', fill: TOKENS.card, stroke: TOKENS.border2, strokeWidth: 1.2 }),
        h('path', { d: 'M46 18 L48 8 L38 14 Z', fill: TOKENS.card, stroke: TOKENS.border2, strokeWidth: 1.2 }),
        h('path', {
          d: 'M32 12 C44 12 51 22 51 33 C51 47 44 55 32 55 C20 55 13 47 13 33 C13 22 20 12 32 12 Z',
          fill: TOKENS.card, stroke: TOKENS.border2, strokeWidth: 1.4,
        }),
        h('circle', { cx: 25, cy: 30, r: 3.2, fill: TOKENS.text }),
        h('circle', { cx: 39, cy: 30, r: 3.2, fill: TOKENS.text }),
        h('circle', { cx: 25.9, cy: 29.1, r: 1.1, fill: TOKENS.card }),
        h('circle', { cx: 39.9, cy: 29.1, r: 1.1, fill: TOKENS.card }),
        h('path', { d: 'M16 40 Q32 47 48 40 L48 46 Q32 53 16 46 Z', fill: accent }),
        h('path', { d: 'M44 44 L50 56 L43 57 L39 45 Z', fill: accent, opacity: 0.85 }),
        busy ? h('rect', { x: 19, y: 47, width: 9, height: 3.4, rx: 1.7, fill: accent, opacity: 0.95 }) : null,
        busy ? h('rect', { x: 36, y: 47, width: 9, height: 3.4, rx: 1.7, fill: accent, opacity: 0.95 }) : null,
        offline ? h('g', { className: 'ac-zzz' },
          h('text', { x: 47, y: 20, fontSize: 11, fill: TOKENS.sub, fontFamily: 'sans-serif' }, 'z'),
          h('text', { x: 53, y: 13, fontSize: 8, fill: TOKENS.sub, fontFamily: 'sans-serif' }, 'z'),
        ) : null,
        waiting ? h('g', { className: 'ac-bubble' },
          h('circle', { cx: 52, cy: 13, r: 8, fill: TOKENS.warn, opacity: 0.18 }),
          h('text', {
            x: 52, y: 17.5, textAnchor: 'middle', fontSize: 11, fontWeight: 700,
            fill: TOKENS.warn, fontFamily: 'sans-serif',
          }, '!'),
        ) : null,
      )
    }

    function Station({ agent, onOpen, t }) {
      const sessions = agent.sessions ?? []
      const pending = agent.pendingApprovals ?? 0
      const discovered = !!agent.discovered
      const offline = !agent.online
      const busy = !!agent.busy
      const top = agent.session
      const accent = ACCENTS[agent.app] || TOKENS.brand
      const state = discovered ? t('badge.discovered')
        : offline ? t('office.away') : busy ? t('state.busy') : t('state.idle')
      const stateColor = discovered ? TOKENS.sub : offline ? TOKENS.idle : busy ? TOKENS.ok : TOKENS.sub
      const screenLine = (width, dim) => h('span', {
        style: {
          height: 3, width, borderRadius: 2,
          background: busy ? accent : TOKENS.border,
          opacity: busy ? dim : 1,
        },
      })
      return h('button', {
        type: 'button',
        className: 'ac-station',
        'data-busy': busy ? 'true' : 'false',
        'data-offline': offline ? 'true' : 'false',
        onClick: () => onOpen(agent.app),
        'aria-label': `${agent.displayName} · ${state}`,
        style: { '--ac-border': TOKENS.border, '--ac-hover': TOKENS.card2, '--ac-focus': TOKENS.brand },
      },
        h('div', {
          style: {
            position: 'relative', display: 'flex', justifyContent: 'center',
            alignItems: 'flex-end', height: 64,
          },
        },
          h(Mascot, { accent, busy, offline, waiting: pending > 0 }),
          agent.app === 'dsh'
            ? h('span', {
              style: {
                position: 'absolute', left: 0, top: 2, fontSize: 9, color: TOKENS.sub,
                border: `1px solid ${TOKENS.border}`, borderRadius: 999,
                padding: '0 5px', background: TOKENS.card,
              },
            }, t('office.mgr'))
            : null,
        ),
        h('div', {
          style: {
            width: 96, height: 38, borderRadius: 6,
            border: `1.4px solid ${offline ? TOKENS.border : TOKENS.border2}`,
            background: offline ? TOKENS.card : TOKENS.card2,
            boxShadow: busy
              ? `0 0 10px color-mix(in srgb, ${TOKENS.ok} 30%, transparent)`
              : 'none',
            display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3,
            padding: '0 8px', boxSizing: 'border-box',
          },
        },
          screenLine('80%', 1),
          screenLine('56%', 0.7),
          screenLine('32%', 0.45),
        ),
        h('div', {
          style: {
            width: 132, height: 9, marginTop: -2, borderRadius: 4,
            background: TOKENS.card, border: `1px solid ${TOKENS.border2}`,
          },
        }),
        h('div', {
          style: {
            marginTop: 8, display: 'flex', alignItems: 'center', gap: 5,
            maxWidth: 220, minWidth: 0,
          },
        },
          h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: accent, flex: '0 0 auto' } }),
          h('span', { style: { fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' } }, agent.displayName),
          h('span', { style: { fontSize: 10, color: stateColor, whiteSpace: 'nowrap' } }, state),
          sessions.length
            ? h('span', { style: { fontSize: 10, color: TOKENS.sub, whiteSpace: 'nowrap' } },
              `· ${sessions.length} ${t('office.tasks')}`)
            : null,
        ),
        h('div', {
          style: {
            marginTop: 3, fontSize: 11, color: TOKENS.sub, lineHeight: '15px',
            maxWidth: 220, minHeight: 15, overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, top ? (top.step || top.title) : (offline ? t('office.away') : t('state.idle'))),
        pending > 0
          ? h('div', { style: { marginTop: 2, fontSize: 10, color: TOKENS.warn } },
            `${pending} ${t('badge.pending')}`)
          : null,
      )
    }

    function Plant() {
      return h('svg', { viewBox: '0 0 40 48', width: 40, height: 48, 'aria-hidden': true, style: { opacity: 0.7 } },
        h('path', { d: 'M20 44 L20 26', stroke: TOKENS.sub, strokeWidth: 1.5 }),
        h('path', { d: 'M20 26 C10 24 6 16 8 8 C16 10 20 18 20 26 Z', fill: TOKENS.card2, stroke: TOKENS.sub, strokeWidth: 1 }),
        h('path', { d: 'M20 26 C30 24 34 16 32 8 C24 10 20 18 20 26 Z', fill: TOKENS.card2, stroke: TOKENS.sub, strokeWidth: 1 }),
        h('path', { d: 'M12 40 L28 40 L25 46 L15 46 Z', fill: TOKENS.card, stroke: TOKENS.sub, strokeWidth: 1 }),
      )
    }

    function OfficeView({ agents, onOpen, t }) {
      const onDuty = agents.filter((agent) => agent.online).length
      const busy = agents.filter((agent) => agent.busy).length
      const waiting = agents.reduce((sum, agent) => sum + (agent.pendingApprovals || 0), 0)
      return h(React.Fragment, null,
        h('style', null, OFFICE_CSS),
        h('div', {
          style: {
            position: 'relative', borderRadius: 16, overflow: 'hidden',
            padding: '14px 16px 14px',
            border: `1px solid ${TOKENS.border}`,
            background: `linear-gradient(180deg, ${TOKENS.card2} 0%, ${TOKENS.card} 100%)`,
          },
        },
          h('div', {
            'aria-hidden': true,
            style: {
              position: 'absolute', inset: 0, pointerEvents: 'none', opacity: 0.3,
              backgroundImage: `linear-gradient(${TOKENS.border} 1px, transparent 1px), linear-gradient(90deg, ${TOKENS.border} 1px, transparent 1px)`,
              backgroundSize: '32px 32px',
            },
          }),
          h('div', {
            style: {
              position: 'relative', display: 'flex', alignItems: 'center',
              gap: 6, flexWrap: 'wrap', padding: '0 2px 10px',
            },
          },
            pill(`${agents.length} ${t('office.colleagues')}`),
            pill(`${t('office.onDuty')} ${onDuty}`, TOKENS.sub),
            busy > 0 ? pill(`${t('office.busyCount')} ${busy}`, TOKENS.ok) : null,
            waiting > 0 ? pill(`${t('office.waitCount')} ${waiting}`, TOKENS.warn) : null,
          ),
          h('div', { style: { position: 'absolute', right: 16, bottom: 8, pointerEvents: 'none' } }, h(Plant)),
          h('div', {
            style: { position: 'absolute', left: 16, bottom: 8, pointerEvents: 'none', transform: 'scaleX(-1)' },
          }, h(Plant)),
          h('div', {
            style: {
              position: 'relative', display: 'flex', flexWrap: 'wrap',
              justifyContent: 'center', alignItems: 'flex-start', gap: 4,
            },
          },
            agents.map((agent) => h(Station, { key: agent.app, agent, onOpen, t })),
          ),
        ),
        h('div', {
          style: {
            marginTop: 8, fontSize: 11, color: TOKENS.sub,
            display: 'flex', gap: 12, flexWrap: 'wrap',
          },
        },
          h('span', null, t('office.hint')),
          h('span', null, `· ${t('office.legend')}`),
        ),
      )
    }

    // ---------------------------------------------------------------- cards
    function Card({ agent, onOpen, t }) {
      const state = stateOf(agent, t)
      const sessions = agent.sessions ?? []
      const top = agent.session
      return h('button', {
        type: 'button',
        onClick: () => onOpen(agent.app),
        style: {
          textAlign: 'left', cursor: 'pointer',
          display: 'flex', flexDirection: 'column', gap: 8,
          padding: 14, borderRadius: 12,
          background: TOKENS.card,
          border: `1px solid ${TOKENS.border}`,
          color: TOKENS.text, font: 'inherit', minWidth: 0,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
          h(Dot, { color: state.color, pulse: agent.busy }),
          h('span', { style: { fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' } }, agent.displayName),
          h('span', { style: { flex: 1 } }),
          pill(state.label, agent.busy ? TOKENS.ok : TOKENS.sub),
        ),
        h('div', {
          style: {
            fontSize: 13, fontWeight: 500,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: top ? TOKENS.text : TOKENS.sub,
          },
        }, top ? top.title : t('none')),
        top && top.cwd
          ? h('div', {
            style: {
              fontFamily: MONO, fontSize: 11, color: TOKENS.sub,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, top.cwd)
          : null,
        top && top.step
          ? h('div', {
            style: {
              fontSize: 12, color: TOKENS.sub, lineHeight: '18px',
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              overflow: 'hidden', minHeight: 18,
            },
          }, top.step)
          : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 } },
          sessions.length ? pill(`${sessions.length} ${t('badge.sessions')}`) : null,
          agent.pendingApprovals > 0 ? pill(`${agent.pendingApprovals} ${t('badge.pending')}`, TOKENS.warn) : null,
          agent.discovered
            ? pill(t('badge.discovered'))
            : agent.canSendPrompt ? pill(t('badge.canSend'), TOKENS.brand) : pill(t('badge.readonly')),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 11, color: TOKENS.sub } }, relTime(agent.lastActivityAt, t)),
        ),
      )
    }

    // ---------------------------------------------------------------- detail
    function EventRow({ item, t }) {
      const role = item.role || 'system'
      const color = role === 'user' ? TOKENS.brand
        : role === 'assistant' ? TOKENS.text
          : role === 'tool' ? TOKENS.warn
            : TOKENS.sub
      const label = t(`role.${role}`) !== `role.${role}` ? t(`role.${role}`) : role
      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 3,
          padding: '8px 10px', borderRadius: 8,
          background: TOKENS.card2,
          borderLeft: `2px solid ${color}`,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: TOKENS.sub } },
          h('span', { style: { fontWeight: 600, color } }, label),
          item.kind && item.kind !== 'message' ? h('span', null, `· ${item.kind}`) : null,
          h('span', { style: { flex: 1 } }),
          item.at ? h('span', null, relTime(typeof item.at === 'number' ? item.at : Date.parse(item.at), t)) : null,
        ),
        h('div', {
          style: {
            fontSize: 12, lineHeight: '19px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            color: TOKENS.text,
            display: '-webkit-box', WebkitLineClamp: 14, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          },
        }, item.text || ''),
      )
    }

    function Composer({ agent, session, cwd, t }) {
      const [text, setText] = useState('')
      const [preview, setPreview] = useState(null)
      const [job, setJob] = useState(null)
      const [error, setError] = useState('')

      useEffect(() => {
        setText('')
        setPreview(null)
        setJob(null)
        setError('')
      }, [agent.app, session.id])

      const poll = useRef(null)
      useEffect(() => {
        if (!job || job.status !== 'running') return undefined
        poll.current = window.setInterval(async () => {
          try {
            const next = await getJSON(`${ROUTES.job}?id=${encodeURIComponent(job.id)}`)
            setJob(next)
          } catch (caught) {
            setError(String(caught?.message ?? caught))
          }
        }, JOB_POLL_MS)
        return () => window.clearInterval(poll.current)
      }, [job])

      const askPreview = async () => {
        setError('')
        try {
          const doc = await postJSON(ROUTES.send, {
            app: agent.app, sessionId: session.id, text, cwd,
          })
          if (!doc.ok) {
            setError(doc.error || 'rejected')
            return
          }
          setPreview(doc.preview)
        } catch (caught) {
          setError(String(caught?.message ?? caught))
        }
      }

      const confirmSend = async () => {
        setError('')
        setPreview(null)
        try {
          const doc = await postJSON(ROUTES.send, {
            app: agent.app, sessionId: session.id, text, cwd, confirm: true,
          })
          if (!doc.ok) {
            setError(doc.error || 'rejected')
            return
          }
          setJob(doc.job)
        } catch (caught) {
          setError(String(caught?.message ?? caught))
        }
      }

      if (!agent.canSendPrompt) {
        return h('div', {
          style: {
            padding: '10px 12px', borderRadius: 10, fontSize: 12,
            color: TOKENS.sub, background: TOKENS.card2,
            border: `1px solid ${TOKENS.border}`,
          },
        }, t('send.disabled'))
      }

      if (session.source === 'chatgpt') {
        return h('div', {
          style: {
            padding: '10px 12px', borderRadius: 10, fontSize: 12,
            color: TOKENS.sub, background: TOKENS.card2,
            border: `1px solid ${TOKENS.border}`,
          },
        }, t('send.cloud'))
      }

      const running = job && job.status === 'running'

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 8,
          padding: 12, borderRadius: 10,
          background: TOKENS.card, border: `1px solid ${TOKENS.border}`,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: 12, fontWeight: 600 } }, t('send.title')),
          pill(t('badge.canSend'), TOKENS.brand),
          h('span', { style: { flex: 1 } }),
        ),
        h('div', { style: { fontSize: 11, color: TOKENS.sub } },
          agent.sendMode === 'append' ? t('send.append')
            : agent.sendMode === 'new-run' ? t('send.new-run')
              : t('send.ui')),
        h('textarea', {
          value: text,
          onChange: (event) => setText(event.target.value),
          placeholder: t('send.placeholder'),
          rows: 3,
          style: {
            width: '100%', boxSizing: 'border-box', resize: 'vertical',
            font: 'inherit', fontSize: 12, lineHeight: '18px',
            padding: '8px 10px', borderRadius: 8,
            color: TOKENS.text, background: TOKENS.card2,
            border: `1px solid ${TOKENS.border}`,
            outline: 'none',
          },
        }),
        preview
          ? h('div', {
            style: {
              display: 'flex', flexDirection: 'column', gap: 6,
              padding: '8px 10px', borderRadius: 8,
              background: TOKENS.card2, border: `1px solid ${TOKENS.warn}`,
            },
          },
            h('div', { style: { fontSize: 12, color: TOKENS.warn, fontWeight: 600 } }, t('send.confirm')),
            h('div', { style: { fontFamily: MONO, fontSize: 11, color: TOKENS.sub, wordBreak: 'break-all' } },
              preview.command),
            h('div', { style: { display: 'flex', gap: 8 } },
              btn(t('send.confirmYes'), confirmSend, { primary: true }),
              btn(t('send.cancel'), () => setPreview(null)),
            ),
          )
          : null,
        job
          ? h('div', {
            style: {
              display: 'flex', flexDirection: 'column', gap: 6,
              padding: '8px 10px', borderRadius: 8,
              background: TOKENS.card2, border: `1px solid ${TOKENS.border}`,
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } },
              pill(
                job.status === 'running' ? t('send.running')
                  : job.status === 'done' ? t('send.done') : t('send.failed'),
                job.status === 'done' ? TOKENS.ok : job.status === 'running' ? TOKENS.sub : TOKENS.err,
              ),
              h('span', { style: { flex: 1 } }),
              job.status === 'running' ? null : btn(t('send.again'), () => setJob(null)),
            ),
            job.output
              ? h('pre', {
                style: {
                  margin: 0, maxHeight: 180, overflow: 'auto',
                  fontFamily: MONO, fontSize: 11, lineHeight: '16px',
                  color: TOKENS.sub, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                },
              }, job.output.slice(-4000))
              : null,
            job.error
              ? h('div', { style: { fontSize: 11, color: TOKENS.err } }, job.error)
              : null,
          )
          : null,
        error
          ? h('div', { style: { fontSize: 11, color: TOKENS.err, wordBreak: 'break-word' } }, error)
          : null,
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          btn(t('send.button'), askPreview, { primary: true, disabled: running || !text.trim() }),
        ),
      )
    }

    function DiscoveryInfo({ agent, t }) {
      const rows = [
        [t('discovered.install'), agent.installDir || t('none')],
        [t('discovered.data'), (agent.dataDirs ?? []).join('\n') || t('none')],
      ]
      return h('div', {
        style: {
          padding: 18, borderRadius: 10, border: `1px dashed ${TOKENS.border}`,
          background: TOKENS.card, display: 'flex', flexDirection: 'column', gap: 10,
        },
      },
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('discovered.title')),
        h('div', { style: { fontSize: 12, color: TOKENS.sub, lineHeight: '19px' } }, t('discovered.body')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          rows.map(([label, value], index) => h('div', {
            key: index,
            style: { display: 'flex', gap: 8, fontSize: 11, alignItems: 'flex-start' },
          },
            h('span', { style: { color: TOKENS.sub, minWidth: 64, flex: '0 0 auto' } }, label),
            h('span', {
              style: {
                fontFamily: MONO, color: TOKENS.text,
                whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              },
            }, value),
          )),
        ),
        h('div', { style: { fontSize: 11, color: TOKENS.sub } }, t('discovered.adapt')),
      )
    }

    function Workspace({ agent, view, onBack, onPickSession, t }) {
      const session = (agent.sessions ?? []).find((item) => item.id === view.session) ?? null
      const [detail, setDetail] = useState({ loading: false, data: null, error: '' })

      useEffect(() => {
        if (!session) {
          setDetail({ loading: false, data: null, error: '' })
          return undefined
        }
        let alive = true
        setDetail({ loading: true, data: null, error: '' })
        getJSON(`${ROUTES.session}?app=${encodeURIComponent(agent.app)}&id=${encodeURIComponent(session.id)}`)
          .then((doc) => {
            if (alive) setDetail({ loading: false, data: doc, error: '' })
          })
          .catch((caught) => {
            if (alive) setDetail({ loading: false, data: null, error: String(caught?.message ?? caught) })
          })
        return () => { alive = false }
      }, [agent.app, session?.id])

      const data = detail.data

      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '20px 24px 12px', flexWrap: 'wrap',
          },
        },
          btn(`← ${t('workspace.back')}`, onBack),
          h('span', { style: { fontSize: 15, fontWeight: 600 } }, agent.displayName),
          pill(stateOf(agent, t).label, agent.busy ? TOKENS.ok : TOKENS.sub),
          agent.discovered
            ? pill(t('badge.discovered'))
            : agent.canSendPrompt ? pill(t('badge.canSend'), TOKENS.brand) : pill(t('badge.readonly')),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 11, color: TOKENS.sub } }, `${(agent.sessions ?? []).length} ${t('badge.sessions')}`),
        ),
        h('div', {
          style: {
            flex: 1, minHeight: 0, display: 'grid', gap: 12,
            gridTemplateColumns: 'minmax(240px, 330px) minmax(0, 1fr)',
            padding: '0 24px 20px',
          },
        },
          h('div', { style: { ...scrollBox, padding: 6 } },
            (agent.sessions ?? []).length
              ? (agent.sessions ?? []).map((item) => {
                const active = item.id === view.session
                const badge = sessionState(item, t)
                return h('button', {
                  key: item.id,
                  type: 'button',
                  onClick: () => onPickSession(item.id),
                  style: {
                    width: '100%', textAlign: 'left', cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', gap: 4,
                    padding: '8px 10px', marginBottom: 4, borderRadius: 8,
                    background: active ? TOKENS.card2 : 'transparent',
                    border: `1px solid ${active ? TOKENS.brand : 'transparent'}`,
                    color: TOKENS.text, font: 'inherit',
                  },
                },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                    h('span', {
                      style: {
                        fontSize: 12, fontWeight: active ? 600 : 500, minWidth: 0,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      },
                    }, item.title),
                    h('span', { style: { flex: 1 } }),
                    item.pending > 0 ? pill(`${item.pending} ${t('badge.pending')}`, TOKENS.warn) : null,
                    item.source === 'chatgpt' ? pill(t('badge.cloud')) : null,
                    item.archived ? pill(t('badge.archived')) : null,
                    badge ? pill(badge.label, badge.color) : null,
                  ),
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: TOKENS.sub } },
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } },
                      item.step || item.cwd || ''),
                    h('span', { style: { whiteSpace: 'nowrap' } }, relTime(item.lastActivityAt, t)),
                  ),
                )
              })
              : h('div', { style: { padding: 16, fontSize: 12, color: TOKENS.sub } }, t('workspace.empty')),
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 } },
            !session
              ? (agent.discovered
                ? h(DiscoveryInfo, { agent, t })
                : h('div', {
                  style: {
                    padding: 24, borderRadius: 10, textAlign: 'center',
                    fontSize: 12, color: TOKENS.sub,
                    border: `1px dashed ${TOKENS.border}`,
                  },
                }, t('workspace.pick')))
              : h(React.Fragment, null,
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  h('div', { style: { fontSize: 14, fontWeight: 600, wordBreak: 'break-word' } }, session.title),
                  h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: TOKENS.sub } },
                    h('span', { style: { fontFamily: MONO } }, `${t('detail.sessionId')}: ${session.id.slice(0, 18)}…`),
                    session.cwd ? h('span', { style: { fontFamily: MONO, wordBreak: 'break-all' } }, session.cwd) : null,
                    h('span', null, `${t('detail.lastActivity')}: ${relTime(session.lastActivityAt, t)}`),
                  ),
                ),
                h('div', { style: { fontSize: 11, color: TOKENS.sub } },
                  data?.note || (detail.loading ? t('detail.loading') : ''),
                ),
                h('div', { style: { ...scrollBox, flex: 1, padding: 8, display: 'flex', flexDirection: 'column', gap: 8 } },
                  detail.error
                    ? h('div', { style: { fontSize: 12, color: TOKENS.err } }, detail.error)
                    : null,
                  detail.loading
                    ? h('div', { style: { padding: 12, fontSize: 12, color: TOKENS.sub } }, t('detail.loading'))
                    : null,
                  data && (data.events ?? []).length === 0 && !detail.loading
                    ? h('div', { style: { padding: 12, fontSize: 12, color: TOKENS.sub } }, t('detail.noEvents'))
                    : null,
                  (data?.events ?? []).map((item, index) => h(EventRow, { key: index, item, t })),
                ),
                h(Composer, {
                  agent, session,
                  cwd: data?.cwd || session.cwd || '',
                  t,
                }),
              ),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------- panel
    function Panel(props) {
      const t = props.t
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState(null)
      const [view, setView] = useState({ agent: null, session: null })
      const [mode, setMode] = useState('office')
      const alive = useRef(true)

      const load = useCallback(async () => {
        try {
          const doc = await getJSON(`${ROUTES.cards}?t=${Date.now()}`)
          if (!alive.current) return
          setSnapshot(doc)
          setError(null)
        } catch (caught) {
          if (!alive.current) return
          setError(String(caught?.message ?? caught))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        load()
        const timer = window.setInterval(() => {
          if (!document.hidden) load()
        }, POLL_MS)
        return () => {
          alive.current = false
          window.clearInterval(timer)
        }
      }, [load])

      const agents = snapshot?.agents ?? []
      const current = useMemo(
        () => agents.find((agent) => agent.app === view.agent) ?? null,
        [agents, view.agent],
      )
      const errors = snapshot?.errors ?? []

      const openAgent = (app) => {
        const agent = agents.find((item) => item.app === app)
        const first = agent?.sessions?.[0]?.id ?? null
        setView({ agent: app, session: first })
      }

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column',
          height: '100%', minHeight: 0,
          background: TOKENS.bg, color: TOKENS.text,
        },
      },
        current
          ? h(Workspace, {
            agent: current,
            view,
            onBack: () => setView({ agent: null, session: null }),
            onPickSession: (id) => setView((prev) => ({ ...prev, session: id })),
            t,
          })
          : h(React.Fragment, null,
            h('header', {
              style: {
                display: 'flex', alignItems: 'flex-end', gap: 12,
                padding: '20px 24px 12px', flexWrap: 'wrap',
              },
            },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                h('h1', { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t('panel.title')),
                h('span', { style: { fontSize: 12, color: TOKENS.sub } }, t('panel.subtitle')),
              ),
              h('span', { style: { flex: 1 } }),
              h('span', { style: { fontSize: 11, color: TOKENS.sub } },
                snapshot?.generatedAt
                  ? `${t('panel.updated')} ${new Date(snapshot.generatedAt).toLocaleTimeString()}`
                  : t('panel.loading')),
              h('div', {
                style: {
                  display: 'inline-flex', padding: 2, gap: 2, borderRadius: 9,
                  background: TOKENS.card2, border: `1px solid ${TOKENS.border}`,
                },
              },
                [
                  ['office', t('view.office')],
                  ['list', t('view.list')],
                ].map(([value, label]) => h('button', {
                  key: value,
                  type: 'button',
                  onClick: () => setMode(value),
                  'aria-pressed': mode === value ? 'true' : 'false',
                  style: {
                    font: 'inherit', fontSize: 11, cursor: 'pointer',
                    padding: '3px 10px', borderRadius: 7,
                    color: mode === value ? '#fff' : TOKENS.sub,
                    background: mode === value ? TOKENS.brand : 'transparent',
                    border: 'none',
                  },
                }, label)),
              ),
              btn(t('panel.refresh'), load),
            ),
            h('div', {
              style: {
                flex: 1, minHeight: 0, overflow: 'auto',
                padding: '4px 24px 32px',
                display: 'flex', flexDirection: 'column', gap: 12,
              },
            },
              snapshot?.stale
                ? h('div', {
                  style: {
                    padding: '8px 12px', borderRadius: 8, fontSize: 12,
                    color: TOKENS.warn, background: TOKENS.card2,
                    border: `1px solid ${TOKENS.border}`,
                  },
                }, t('panel.stale'))
                : null,
              error
                ? h('div', {
                  style: {
                    padding: '10px 12px', borderRadius: 8, fontSize: 12,
                    color: TOKENS.err, background: TOKENS.card2,
                    border: `1px solid ${TOKENS.border}`,
                  },
                }, `${t('panel.error')}：${error}`)
                : null,
              errors.length
                ? h('details', {
                  style: {
                    padding: '8px 12px', borderRadius: 8, fontSize: 12,
                    color: TOKENS.sub, background: TOKENS.card2,
                    border: `1px solid ${TOKENS.border}`,
                  },
                },
                  h('summary', { style: { cursor: 'pointer' } }, `${t('errors.title')} (${errors.length})`),
                  h('ul', { style: { margin: '6px 0 0', paddingLeft: 18 } },
                    errors.map((item, index) => h('li', { key: index, style: { lineHeight: '18px' } },
                      `${item.app}: ${item.message}`)),
                  ),
                )
                : null,
              agents.length
                ? (mode === 'office'
                  ? h(OfficeView, { agents, onOpen: openAgent, t })
                  : h('div', {
                    style: {
                      display: 'grid', gap: 12,
                      gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                    },
                  },
                    agents.map((agent) => h(Card, { key: agent.app, agent, onOpen: openAgent, t })),
                  ))
                : h('div', {
                  style: {
                    padding: 24, borderRadius: 12, textAlign: 'center',
                    border: `1px dashed ${TOKENS.border}`, color: TOKENS.sub,
                  },
                },
                  h('div', { style: { fontSize: 13, fontWeight: 600, color: TOKENS.text, marginBottom: 4 } }, t('panel.loading')),
                ),
              h('div', {
                style: {
                  marginTop: 4, fontSize: 11, color: TOKENS.sub,
                  display: 'flex', alignItems: 'center', gap: 8,
                },
              },
                h('span', null, t('panel.auto')),
                snapshot?.host ? h('span', null, `· ${snapshot.host}`) : null,
              ),
            ),
          ),
      )
    }

    function PanelIcon(props) {
      const size = props?.size || 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 20 20',
        fill: 'none', 'aria-hidden': true,
        style: { display: 'block', opacity: props?.active ? 1 : 0.72 },
      },
        h('rect', { x: 1.5, y: 3, width: 17, height: 11.5, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M6 17.2h8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('circle', { cx: 6, cy: 8.6, r: 1.25, fill: 'currentColor' }),
        h('circle', { cx: 10, cy: 8.6, r: 1.25, fill: 'currentColor', opacity: 0.65 }),
        h('circle', { cx: 14, cy: 8.6, r: 1.25, fill: 'currentColor', opacity: 0.4 }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        for (const locale of ['zh', 'en']) {
          ctx.effect(() => ctx.locale.register(NS, locale, DICT[locale]))
        }
        const translate = ctx.locale.bind(NS)
        const t = (key) => {
          const value = translate(key)
          return value === key ? DICT.zh[key] ?? key : value
        }

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'agent-console',
          order: 20,
          label: () => t('panel.title'),
        }, PanelIcon)))

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'agent-console',
        }, (props) => h(Panel, { ...props, t }))))
      },
    }
  },
})
