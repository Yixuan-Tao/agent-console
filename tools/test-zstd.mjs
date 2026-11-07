/** Check compressed transcript tails and UTF-8 decoding without touching app data. */
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import zlib from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(path.join(root, 'index.js'), 'utf8')
const start = source.indexOf('function extractCodexEvent(')
const end = source.indexOf('\nfunction withHarnessCard(', start)
assert.ok(start >= 0 && end > start)
const context = { createReadStream, zlib, setTimeout, clearTimeout }
vm.runInNewContext(source.slice(start, end) + '\nglobalThis.readEvents = codexEventsFromZst', context)

const directory = await mkdtemp(path.join(root, 'zstd-test-'))
try {
  const file = path.join(directory, 'fixture.jsonl.zst')
  const text = '表格与命令\n\n| 名称 | 结果 |\n| --- | --- |\n| 中文 | 好 |\n\n    保留缩进 😀'
  const lines = Array.from({ length: 160 }, (_, i) => JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ text: `${i}\n${text}` }] },
  }))
  const jsonl = lines.join('\n') + '\n'
  await writeFile(file, zlib.zstdCompressSync(Buffer.from(jsonl)))
  const events = await context.readEvents(file, { tailBytes: 16000, maxEvents: 40 })
  assert.equal(events.length, 40)
  assert.deepEqual(Array.from(events, event => event.text),
    Array.from({ length: 40 }, (_, i) => `${i + 120}\n${text}`))

  // A tail trim on a newline must retain preceding complete records.
  await writeFile(file, zlib.zstdCompressSync(Buffer.from(lines.slice(0, 5).join('\n') + '\n')))
  const shortTail = await context.readEvents(file, { tailBytes: lines[0].length * 3, maxEvents: 40 })
  assert.ok(shortTail.length >= 2)
  assert.equal(shortTail.at(-1).text, `4\n${text}`)
  await assert.rejects(context.readEvents(path.join(directory, 'missing.zst')), /ENOENT/)
} finally {
  assert.equal(path.dirname(directory), root)
  await rm(directory, { recursive: true, force: true })
}
console.log('ZSTD TEST OK (tail retention, UTF-8, missing files)')
