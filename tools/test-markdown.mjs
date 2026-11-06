/**
 * Render the real Codex markdown sample through the panel's renderer and report
 * which block types it produced, so regressions in markdown support are visible
 * without a browser.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
let source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const marker = "    return {\n      inject: ['slots', 'locale'],"
source = source.replace(marker, '    __mdTest = { renderMarkdown, renderInline }\n' + marker)

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
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    createContext: () => ({}),
    useContext: () => undefined,
  }
}

const captured = {}
const sandbox = {
  __mdTest: null,
  window: { __ModuleLoader__: { load(def) { captured.definition = def } } },
  document: { hidden: false },
  console,
  Date, JSON, Math, Object, Array, String, Number, Boolean, Error,
  encodeURIComponent,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  fetch: async () => { throw new Error('no fetch') },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })
const plugin = captured.definition.factory((id) => {
  if (id === 'react') return makeReact()
  throw new Error(`unexpected require: ${id}`)
})
plugin.apply({
  effect: (fn) => { fn(); return () => {} },
  slots: { inject: () => () => {}, register: (options) => options },
  locale: { register: () => () => {}, bind: () => (key) => key },
})

const samplePath = path.join(here, '_md_sample.txt')
const genericSample = [
  '**Roguelite 是好方向。** 这是一段用于测试的说明文字，包含 `inline code` 与 [链接](<C:/demo/doc.md>)。',
  '',
  '| 方向 | 说明 |',
  '|:---|:---:|',
  '| 地形生存 | **推荐** |',
  '| 街机挑战 | 固定种子 |',
  '',
  '### 下一步',
  '',
  '1. 先做一张地图。',
  '2. 再做六波空袭。',
  '',
  '- [x] 已完成',
  '- [ ] 待办',
].join('\n')
const sample = fs.existsSync(samplePath) ? fs.readFileSync(samplePath, 'utf8') : genericSample
const tree = sandbox.__mdTest.renderMarkdown(sample)

const counts = {}
const texts = []
function walk(node) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (typeof node !== 'object') { if (typeof node === 'string') texts.push(node); return }
  if (typeof node.type === 'string') counts[node.type] = (counts[node.type] || 0) + 1
  walk(node.props?.children)
}
walk(tree)

console.log('blocks:', tree.length)
console.log('element counts:', JSON.stringify(counts))
console.log('rendered text chars:', texts.join(' ').length, '| sample chars:', sample.length)

const linkElements = []
function collectLinks(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(collectLinks); return }
  if (node.type === 'a') linkElements.push(node.props.href)
  collectLinks(node.props?.children)
}
collectLinks(tree)
console.log('link hrefs:', JSON.stringify(linkElements))
console.log('has table element:', !!counts.table, '| headings:', counts.div, '| strong:', counts.strong)

// GFM extras that Codex renders via its remark/micromark pipeline.
const extras = [
  '- [x] 已完成的任务',
  '- [ ] 未完成的任务',
  '- 一级条目',
  '  - 嵌套条目',
  '~~删除线~~ 与 **粗体** 和 `代码`',
  '$$',
  'E = mc^2',
  '$$',
  '| 左对齐 | 居中 | 右对齐 |',
  '|:---|:---:|---:|',
  '| a | b | c |',
].join('\n')
const extraTree = sandbox.__mdTest.renderMarkdown(extras)
const extraCounts = {}
const extraTexts = []
function walkExtra(node) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { node.forEach(walkExtra); return }
  if (typeof node !== 'object') { if (typeof node === 'string') extraTexts.push(node); return }
  if (typeof node.type === 'string') extraCounts[node.type] = (extraCounts[node.type] || 0) + 1
  walkExtra(node.props?.children)
}
walkExtra(extraTree)
const extraText = extraTexts.join(' ')
console.log('extras:', JSON.stringify(extraCounts))
const checks = {
  taskList: extraText.includes('☑') && extraText.includes('☐'),
  nestedList: extraCounts.ul >= 2,
  strikethrough: extraCounts.del >= 1,
  mathBlock: extraTexts.some((text) => text.includes('E = mc^2')),
  alignedTable: extraCounts.table === 1 && extraCounts.th === 3,
}
console.log('checks:', JSON.stringify(checks))
if (!Object.values(checks).every(Boolean)) throw new Error(`markdown gaps: ${JSON.stringify(checks)}`)
console.log('MD TEST OK')
