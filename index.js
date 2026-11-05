/**
 * Agent Console — Host half.
 *
 * Read-only snapshot routes plus the two official send channels:
 *   - Codex:      `codex queue --thread <id> --message <text>`  (appends to that thread)
 *   - WorkBuddy:  `codebuddy -p <text>` in the session's cwd     (a new headless run)
 *
 * Nothing here writes application data directly; the CLIs own their own state.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, createReadStream, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const COLLECTOR = path.join(HERE, 'collector.py')

const ROUTES = {
  cards: '/agent-console/cards',
  session: '/agent-console/session',
  send: '/agent-console/send',
  job: '/agent-console/job',
}

const CACHE_MS = 1500
const COLLECT_TIMEOUT_MS = 12_000
const JOB_TIMEOUT_MS = 15 * 60 * 1000
const JOB_TTL_MS = 20 * 60 * 1000
const MAX_SEND_CHARS = 8000

// Everything below is discovered at runtime; no machine-specific path is baked in.
function pythonCandidates() {
  const local = path.join(os.homedir(), 'AppData', 'Local', 'Python')
  const list = [process.env.AGENT_CONSOLE_PYTHON]
  try {
    for (const name of readdirSync(local)) {
      if (name.toLowerCase().startsWith('pythoncore-')) {
        list.push(path.join(local, name, 'python.exe'))
      }
    }
  } catch {}
  list.push('python3.exe', 'python.exe')
  return list.filter(Boolean)
}

function codexCandidates() {
  const list = [process.env.CODEX_CLI_PATH]
  // Managed CLI: %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
  const managedBin = path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin')
  try {
    for (const name of readdirSync(managedBin)) {
      list.push(path.join(managedBin, name, 'codex.exe'))
    }
  } catch {}
  // MSIX install: C:\Program Files\WindowsApps\OpenAI.Codex_<version>\app\resources\codex.exe
  const apps = 'C:\\Program Files\\WindowsApps'
  try {
    for (const name of readdirSync(apps)) {
      if (name.startsWith('OpenAI.Codex_')) {
        list.push(path.join(apps, name, 'app', 'resources', 'codex.exe'))
      }
    }
  } catch {}
  list.push('codex.exe')
  return list.filter(Boolean)
}

function nodeCandidates() {
  const list = [process.env.AGENT_CONSOLE_NODE]
  const programs = path.join(os.homedir(), 'AppData', 'Local', 'Programs')
  try {
    for (const name of readdirSync(programs)) {
      if (name.toLowerCase().startsWith('nodejs')) {
        list.push(path.join(programs, name, 'node.exe'))
      }
    }
  } catch {}
  list.push('node.exe')
  return list.filter(Boolean)
}

const CODEBUDDY_LAUNCHER = path.join(
  os.homedir(), 'AppData', 'Local', 'Programs', 'WorkBuddy',
  'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy',
)

const SEND_UI = path.join(HERE, 'send_ui.ps1')

const POWERSHELL_CANDIDATES = [
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  'powershell.exe',
  'pwsh.exe',
]

let cache = { at: 0, payload: null }
let inFlight = null
const resolved = {}
const jobs = new Map()

function firstExisting(candidates, kind) {
  if (resolved[kind]) return resolved[kind]
  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate)
    if (absolute ? existsSync(candidate) : true) {
      resolved[kind] = candidate
      return candidate
    }
  }
  resolved[kind] = candidates[0]
  return resolved[kind]
}

function runCollector(args) {
  return new Promise((resolve, reject) => {
    execFile(
      firstExisting(pythonCandidates(), 'python'),
      [COLLECTOR, ...args],
      {
        cwd: HERE,
        timeout: COLLECT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`collector failed: ${error.message}${stderr ? ` · ${String(stderr).slice(0, 300)}` : ''}`))
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch (parseError) {
          reject(new Error(`collector emitted invalid JSON: ${parseError.message}`))
        }
      },
    )
  })
}

/** One rollout line -> a panel event, mirroring the collector's rules. */
function extractCodexEvent(obj) {
  const kind = obj?.type
  const payload = obj?.payload ?? {}
  const stamp = obj?.timestamp ?? null
  if (kind === 'response_item') {
    const ptype = payload.type
    if (ptype === 'message') {
      const parts = Array.isArray(payload.content) ? payload.content : []
      const text = parts
        .map((part) => (typeof part === 'string' ? part : (part?.text ?? part?.content ?? '')))
        .join('')
      if (!text.trim()) return null
      const role = payload.role || 'assistant'
      return { role: role === 'developer' ? 'system' : role, kind: 'message', text: text.slice(0, 1500), at: stamp }
    }
    if (ptype === 'function_call' || ptype === 'custom_tool_call') {
      const raw = payload.arguments || payload.input || ''
      return { role: 'assistant', kind: 'tool', text: `${payload.name} ${String(raw).slice(0, 300)}`, at: stamp }
    }
    if (ptype === 'agent_message') {
      const text = payload.message || payload.text || ''
      if (text) return { role: 'assistant', kind: 'message', text: String(text).slice(0, 1500), at: stamp }
    }
    return null
  }
  if (kind === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(payload.type)) {
    return { role: 'system', kind: 'event', text: payload.type, at: stamp }
  }
  return null
}

/** Stream-decompress a .jsonl.zst rollout and keep only its tail, so a 100 MB
 * archive never has to fit in memory or be parsed line by line in full. */
function codexEventsFromZst(filePath, options = {}) {
  const tailBytes = options.tailBytes ?? 4 * 1024 * 1024
  const maxEvents = options.maxEvents ?? 40
  const timeoutMs = options.timeoutMs ?? 20_000
  return new Promise((resolve, reject) => {
    const input = createReadStream(filePath)
    const stream = input.pipe(zlib.createZstdDecompress())
    let tail = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      input.destroy()
      stream.destroy()
      reject(new Error('zstd decompression timed out'))
    }, timeoutMs)
    timer.unref?.()

    stream.on('data', (chunk) => {
      tail += chunk.toString('utf8')
      if (tail.length > tailBytes) {
        const cut = tail.lastIndexOf('\n')
        tail = cut > 0 ? tail.slice(cut + 1) : tail.slice(-tailBytes)
      }
    })
    stream.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    stream.on('end', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const events = []
      for (const line of tail.split('\n')) {
        if (!line.trim()) continue
        try {
          const found = extractCodexEvent(JSON.parse(line))
          if (found) events.push(found)
        } catch {}
      }
      resolve(events.slice(-maxEvents))
    })
  })
}

function withHarnessCard(payload) {
  const cards = Array.isArray(payload?.agents) ? payload.agents.slice() : []
  cards.unshift({
    app: 'dsh',
    displayName: 'DeepSeek Harness',
    online: true,
    busy: false,
    session: null,
    sessions: [],
    lastActivityAt: Date.now(),
    pendingApprovals: 0,
    canSendPrompt: false,
    sendMode: '',
    note: '本面板运行在此进程内',
    detail: 'harness',
  })
  return { ...payload, agents: cards }
}

async function snapshot() {
  const now = Date.now()
  if (cache.payload && now - cache.at < CACHE_MS) return cache.payload
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const payload = withHarnessCard(await runCollector([]))
      cache = { at: Date.now(), payload }
      return payload
    } catch (error) {
      const message = String(error?.message ?? error)
      const stale = cache.payload
        ? { ...cache.payload, stale: true, errors: [...(cache.payload.errors ?? []), { app: 'collector', message }] }
        : { generatedAt: Date.now(), host: '', agents: [], errors: [{ app: 'collector', message }] }
      return stale
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

function pruneJobs() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id)
  }
}

function jobView(job) {
  if (!job) return null
  return {
    id: job.id,
    app: job.app,
    sessionId: job.sessionId,
    semantics: job.semantics,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    exitCode: job.exitCode ?? null,
    output: job.output ?? '',
    error: job.error ?? '',
  }
}

/** Window-based fallback for agents without a supported CLI/local API. */
const UI_APP_LABEL = { grokbot: 'Grok Bot', marvis: 'Marvis' }

function probeUiWindow(app) {
  return new Promise((resolve) => {
    execFile(
      firstExisting(POWERSHELL_CANDIDATES, 'powershell'),
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SEND_UI, '-App', app, '-Probe'],
      { cwd: HERE, timeout: 8_000, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: `probe failed: ${error.message}${stderr ? ` · ${String(stderr).slice(0, 200)}` : ''}`,
          })
          return
        }
        try {
          resolve(JSON.parse(String(stdout).trim()))
        } catch {
          resolve({ ok: false, error: 'probe returned non-JSON' })
        }
      },
    )
  })
}

async function runSend(body) {
  const app = String(body?.app ?? '')
  const sessionId = String(body?.sessionId ?? '')
  const text = String(body?.text ?? '').trim()
  const cwd = typeof body?.cwd === 'string' && body.cwd ? body.cwd : ''

  if (!['codex', 'workbuddy', 'grokbot', 'marvis'].includes(app)) {
    return { ok: false, error: `unsupported app: ${app}` }
  }
  if (!text) return { ok: false, error: 'empty prompt' }
  if (text.length > MAX_SEND_CHARS) return { ok: false, error: `prompt too long (max ${MAX_SEND_CHARS})` }

  let command
  let args
  let semantics
  let workdir = cwd && existsSync(cwd) ? cwd : os.homedir()
  const env = { ...process.env }
  let previewTarget = null

  if (UI_APP_LABEL[app]) {
    const probe = await probeUiWindow(app)
    if (!probe.ok) {
      return {
        ok: false,
        error: `${UI_APP_LABEL[app]} 没有可发送的窗口：如果应用已启动，可能最小化到了托盘或只在后台。请把窗口打开、停在目标会话再把光标放进输入框。`,
      }
    }
    command = firstExisting(POWERSHELL_CANDIDATES, 'powershell')
    args = [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SEND_UI,
      '-App', app, '-TextBase64', Buffer.from(text, 'utf8').toString('base64'),
    ]
    semantics = 'ui-automation'
    workdir = HERE
    previewTarget = { pid: probe.pid, title: probe.title || UI_APP_LABEL[app] }
  } else if (app === 'codex') {
    if (!sessionId) return { ok: false, error: 'codex needs a thread id' }
    command = firstExisting(codexCandidates(), 'codex')
    args = ['queue', '--thread', sessionId, '--message', text]
    semantics = 'append'
  } else {
    command = firstExisting(nodeCandidates(), 'node')
    args = [CODEBUDDY_LAUNCHER, '-p', text, '--output-format', 'json']
    semantics = 'new-run'
    env.CODEBUDDY_SKIP_GIT_BASH_CHECK = '1'
  }

  if (!body.confirm) {
    return {
      ok: true,
      preview: {
        app,
        sessionId,
        semantics,
        cwd: workdir,
        target: previewTarget,
        command: previewTarget
          ? `聚焦「${previewTarget.title}」→ 粘贴文本 → 回车`
          : `${command} ${args.map((a) => (a === text ? `"${text.slice(0, 200)}"` : a)).join(' ')}`,
      },
    }
  }

  pruneJobs()
  const id = randomUUID()
  const job = {
    id, app, sessionId, semantics,
    status: 'running', startedAt: Date.now(), output: '',
  }
  jobs.set(id, job)

  let child
  try {
    child = spawn(command, args, {
      cwd: workdir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    job.status = 'failed'
    job.error = String(error?.message ?? error)
    job.finishedAt = Date.now()
    return { ok: false, error: job.error, job: jobView(job) }
  }
  job.child = child

  let buffer = ''
  const append = (chunk) => {
    buffer += chunk.toString('utf8')
    if (buffer.length > 400_000) buffer = buffer.slice(-400_000)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.on('error', (error) => {
    job.status = 'failed'
    job.error = String(error?.message ?? error)
    job.output = buffer
    job.finishedAt = Date.now()
  })
  child.on('close', (code) => {
    job.exitCode = code
    job.status = code === 0 ? 'done' : 'failed'
    job.output = buffer.slice(-20_000)
    job.finishedAt = Date.now()
    delete job.child
  })

  const timer = setTimeout(() => {
    try {
      child.kill()
    } catch {}
    if (job.status === 'running') {
      job.status = 'failed'
      job.error = 'timed out after 15 minutes'
      job.finishedAt = Date.now()
      job.output = buffer.slice(-20_000)
    }
  }, JOB_TIMEOUT_MS)
  timer.unref?.()

  return { ok: true, job: jobView(job) }
}

export const inject = ['webServer']

export function apply(ctx) {
  const send = (res, status, body) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 64 * 1024) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTES.cards,
      handler: async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        try {
          send(res, 200, await snapshot())
        } catch (error) {
          send(res, 500, { error: String(error?.message ?? error) })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTES.session,
      handler: async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const app = url.searchParams.get('app') ?? ''
        const id = url.searchParams.get('id') ?? ''
        if (!app || !id) return send(res, 400, { error: 'app and id are required' })
        try {
          const doc = await runCollector(['--session', app, id])
          if (doc && doc.compressed && doc.path) {
            const sizeMb = Math.round((doc.compressedBytes ?? 0) / 1_000_000)
            try {
              doc.events = await codexEventsFromZst(doc.path)
              doc.note = `rollout 已压缩（${sizeMb} MB），流式解压后读取尾部事件`
            } catch (error) {
              doc.note = `压缩 rollout 解压失败：${String(error?.message ?? error)}`
            }
            delete doc.compressed
            delete doc.path
            delete doc.compressedBytes
          }
          send(res, 200, doc)
        } catch (error) {
          send(res, 500, { error: String(error?.message ?? error) })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTES.send,
      handler: async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
        const body = await readBody(req)
        try {
          send(res, 200, await runSend(body))
        } catch (error) {
          send(res, 500, { error: String(error?.message ?? error) })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTES.job,
      handler: async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const job = jobs.get(url.searchParams.get('id') ?? '')
        if (!job) return send(res, 404, { error: 'unknown job' })
        send(res, 200, jobView(job))
      },
    }),
  )
}
