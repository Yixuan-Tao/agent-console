/**
 * Smoke test for the Agent Console client half.
 *
 * No browser and no installed React here, so this executes client.js inside a vm
 * with a stub React, captures the plugin factory, then renders the Office view
 * component tree by calling it directly. It catches top-level errors, apply()
 * wiring mistakes, and runtime TypeErrors inside OfficeView/Station/Mascot.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(here, '..', 'client.js')
let source = fs.readFileSync(target, 'utf8')

// Expose the office components to the test without shipping test hooks.
const marker = "    return {\n      inject: ['slots', 'locale'],"
if (!source.includes(marker)) throw new Error('factory return marker not found')
source = source.replace(
  marker,
  '    __acTest = { OfficeView, Station, Mascot, Panel, DiscoveryInfo }\n' + marker,
)

function makeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
  })
  return {
    createElement,
    Fragment: 'Fragment',
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    createContext: () => ({ Provider: 'Provider', Consumer: 'Consumer' }),
    useContext: () => undefined,
  }
}

const React = makeReact()
const captured = {}
const sandbox = {
  __acTest: null,
  window: {
    __ModuleLoader__: {
      load(definition) {
        captured.definition = definition
      },
    },
    setInterval: () => 0,
    clearInterval: () => {},
  },
  document: { hidden: false },
  console,
  Date,
  JSON,
  Math,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  encodeURIComponent,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async () => {
    throw new Error('fetch is not available in the smoke test')
  },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

if (!captured.definition) throw new Error('client.js did not register a factory')
console.log('factory id:', captured.definition.id)

const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
}
const plugin = captured.definition.factory(requireStub)
console.log('inject:', JSON.stringify(plugin.inject))

const registrations = []
const localeRegs = []
const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  slots: {
    inject(key, callback) {
      registrations.push({ key, callback })
      return () => {}
    },
    register(options, component) {
      return { ...options, component }
    },
  },
  locale: {
    register(ns, locale, dict) {
      localeRegs.push({ ns, locale, keys: Object.keys(dict).length })
      return () => {}
    },
    bind() {
      return (key) => key
    },
  },
}
plugin.apply(ctx)
console.log('slots injected:', registrations.map((r) => r.key).join(', '))
for (const reg of registrations) {
  const value = reg.callback()
  console.log('  registered', reg.key, '->', JSON.stringify({ name: value.name, id: value.id, key: value.key }))
}
console.log('locale dictionaries:', JSON.stringify(localeRegs))

const components = sandbox.__acTest
if (!components) throw new Error('office components were not exposed to the test')

const agents = [
  {
    app: 'codex', displayName: 'Codex', online: true, busy: true,
    sessions: [{ id: 's1', title: 'working', step: 'running tests', lastActivityAt: Date.now() }],
    session: { id: 's1', title: 'working', step: 'running tests' },
    pendingApprovals: 0, canSendPrompt: true,
  },
  { app: 'grokbot', displayName: 'Grok Bot', online: true, busy: false, sessions: [], session: null, pendingApprovals: 1 },
  { app: 'marvis', displayName: 'Marvis', online: false, busy: false, sessions: [], session: null, pendingApprovals: 2 },
  { app: 'workbuddy', displayName: 'WorkBuddy', online: false, busy: false, sessions: [], session: null, pendingApprovals: 0 },
  { app: 'dsh', displayName: 'DeepSeek Harness', online: true, busy: false, sessions: [], session: null, pendingApprovals: 0 },
  {
    app: 'copilot', displayName: 'Copilot', online: false, busy: false, sessions: [], session: null,
    pendingApprovals: 0, discovered: true, installDir: 'C:\\Program Files\\Copilot', dataDirs: ['C:\\demo\\copilot-data'],
  },
]
const t = (key) => key

const officeTree = components.OfficeView({ agents, onOpen: () => {}, t })
console.log('OfficeView rendered, root type:', officeTree.type,
  'children:', Array.isArray(officeTree.props.children) ? officeTree.props.children.length : 1)

function walk(node, fn, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return
  if (typeof node.type === 'function') {
    // Expand a function component the way a renderer would.
    walk(node.type(node.props), fn, depth + 1)
    return
  }
  fn(node)
  const children = node.props?.children
  if (Array.isArray(children)) children.forEach((child) => walk(child, fn, depth + 1))
  else walk(children, fn, depth + 1)
}
let stations = 0
let svgs = 0
let images = 0
walk(officeTree, (node) => {
  if (node.type === 'img') images += 1
  if (node.type === 'button' && typeof node.props?.onClick === 'function') stations += 1
  if (node.type === 'svg') svgs += 1
})
console.log('interactive stations:', stations, '| svg nodes:', svgs, '| official icon imgs:', images)

// Each station's click handler must be callable (it opens the workspace).
let opened = 0
walk(officeTree, (node) => {
  if (node.type === 'button' && node.props?.['aria-label']) {
    node.props.onClick()
    opened += 1
  }
})
console.log('stations clickable:', opened)

// Panel header (with the office/list toggle) must render without a session.
const panel = components.Panel({ t })
console.log('Panel rendered:', panel.type ? 'ok' : 'empty')
let toggles = 0
walk(panel, (node) => {
  if (node.type === 'button' && node.props?.['aria-pressed'] !== undefined) toggles += 1
})
console.log('view toggle buttons:', toggles, '| office default label present:', JSON.stringify(panel).includes('view.office'))

// Discovered (unadapted) agents must render the explanation block.
const discoveredAgent = agents.find((agent) => agent.discovered)
const info = components.DiscoveryInfo({ agent: discoveredAgent, t })
const infoText = JSON.stringify(info)
console.log('DiscoveryInfo rendered:', info.type === 'div',
  '| has install/data:', infoText.includes('discovered.install') && infoText.includes('discovered.data'))

console.log('SMOKE OK')
