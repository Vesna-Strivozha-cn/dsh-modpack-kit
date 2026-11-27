/**
 * 轻量自检：没有引入 eslint/babel，只做两件对「屎山」最有用的事。
 *  1. 找出 lib/ 里导出但没人引用的符号（死代码）。
 *  2. 找出两个文件之间重复的 5 行以上连续块（抄来抄去的代码）。
 * 用法：ELECTRON_RUN_AS_NODE=1 "<exe>" dev/tools/lint.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCAN_DIRS = ['lib', '.', 'test', 'dev/tools']
const CODE_EXT = new Set(['.mjs', '.js'])

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'dsh-refs') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (CODE_EXT.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

const files = [...new Set(SCAN_DIRS.flatMap((d) => walk(path.join(root, d))))]
const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]))

// —— 1) 死导出 ——
const EXPORT_RE = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gmu
const PUBLIC = new Set(['zipLimits', 'tarLimits']) // 文档里写明的上限常量，保留
const dead = []
for (const file of files) {
  const text = sources.get(file)
  if (!file.startsWith(path.join(root, 'lib'))) continue
  for (const match of text.matchAll(EXPORT_RE)) {
    const name = match[1]
    const word = new RegExp('\\b' + name.replace(/[$]/gu, '\\$') + '\\b', 'gu')
    const others = files.filter((f) => f !== file && word.test(sources.get(f)))
    // 自己文件里除了定义行还有别的引用也算「内部在用」，但那不是死代码
    const selfUses = [...text.matchAll(word)].length - 1
    if (others.length === 0 && selfUses === 0 && !PUBLIC.has(name)) dead.push(path.relative(root, file) + ' → ' + name)
  }
}

// —— 2) 跨文件重复块 ——
const BLOCK = 5
const seen = new Map()
const dupes = []
for (const file of files) {
  const lines = sources.get(file).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
  for (let i = 0; i + BLOCK <= lines.length; i += 1) {
    const block = lines.slice(i, i + BLOCK).join('\n')
    if (block.length < 120) continue
    const key = block
    const prev = seen.get(key)
    const current = path.relative(root, file)
    if (!prev) { seen.set(key, current); continue }
    if (prev === current) continue
    // 独立安装器必须是单文件、不能 import 本项目的模块，所以分组写入那几行只能抄一份；
    // import fs 这种一行样板也不算「抄来抄去」。
    const pair = [prev, current].sort().join('|')
    if (pair === 'assets\\install-stub.mjs|lib\\groups.mjs') continue
    if (lines[i] === "import fs from 'node:fs'") continue
    dupes.push(prev + ' ↔ ' + current + ' :: ' + lines[i].slice(0, 70))
  }
}

const uniqDupes = [...new Set(dupes)]
console.log('files scanned:', files.length)
console.log('\n[dead exports] ' + (dead.length || 'none'))
for (const item of dead) console.log('  - ' + item)
console.log('\n[duplicated blocks ≥' + BLOCK + ' lines] ' + (uniqDupes.length || 'none'))
for (const item of uniqDupes.slice(0, 20)) console.log('  - ' + item)
if (dead.length > 0) process.exitCode = 1
