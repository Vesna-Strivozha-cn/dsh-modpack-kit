/**
 * 体积基准：同一批插件，三种打包策略各打一次，比较大小。
 *
 *   1. full      —— 现状：把插件源码（含本地改动）一起塞进包
 *   2. lite      —— 只记清单与版本，代码安装时从 registry 下
 *   3. hybrid    —— 假设改成「下载码（名字@版本）+ 保留的配置文件 / 数据快照 /
 *                   市场识别需要的清单与补丁片段」，不带插件源码：
 *                   实测做法是把 full 包里的 plugins/ 前缀条目摘掉再压一次，
 *                   其余（dsh-modpack.json、cordis.patch.yml 片段、configs/、data/、
 *                   security/report.txt、integrity.json、install/、README.txt）全保留。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "<exe>" dev/tools/bench-packs.mjs [插件个数]
 *      例：… bench-packs.mjs 8
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, profileDir as resolveProfile } from '../../lib/store.mjs'
import { listInstalled } from '../../lib/profile.mjs'
import { buildPack } from '../../lib/pack.mjs'
import { downloadPackage } from '../../lib/registry.mjs'
import { writeZip, readZip } from '../../lib/zip.mjs'
import { parseYaml } from '../../lib/yamlish.mjs'

const config = loadConfig()
const profile = resolveProfile(config)
const want = Math.max(6, Number(process.argv[2] || 6))

const bytes = (n) => (n / 1024 / 1024).toFixed(2) + ' MB'
const pct = (a, b) => (b === 0 ? '—' : ((a / b) * 100).toFixed(1) + '%')

const list = await listInstalled(profile, { config })
const direct = list.filter((p) => p.isDirect !== false && p.name)
if (direct.length < want) throw new Error('本机直接依赖只有 ' + direct.length + ' 个，不够 ' + want)

// 挑体积有代表性的：按目录体积降序取前 want 个，小插件也留一个（避免只测大包）
const sizeOf = (p) => {
  const dir = path.join(profile, 'node_modules', p.name)
  let total = 0
  const walk = (d) => {
    let items = []
    try { items = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const full = path.join(d, it.name)
      if (it.isDirectory()) walk(full)
      else { try { total += fs.statSync(full).size } catch { /* 忽略 */ } }
    }
  }
  walk(dir)
  return total
}

const sized = direct.map((p) => ({ ...p, size: sizeOf(p) })).sort((a, b) => b.size - a.size)
const chosen = [...sized.slice(0, want - 1), sized[sized.length - 1]]
if (new Set(chosen.map((p) => p.name)).size !== want) {
  // 去重（最小的那个可能和前面重复），用剩下的补
  const seen = new Set()
  const out = []
  for (const p of [...sized.slice(0, want), sized[sized.length - 1]]) {
    if (seen.has(p.name)) continue
    seen.add(p.name)
    out.push(p)
    if (out.length === want) break
  }
  chosen.length = 0
  chosen.push(...out)
}

console.log('profile：' + profile)
console.log('配置层：' + (process.env.BENCH_CONFIG === '0' ? '关闭（不注入）' : '给每个插件注入约 3 KB 合成配置（本机这批插件本身没有自定义配置）'))
console.log('插件数：' + chosen.length + '（本机直接依赖 ' + direct.length + ' 个里选的）')
for (const p of chosen) console.log('  - ' + p.name + '@' + p.version + ' · 目录 ' + bytes(p.size))

const selection = chosen.map((p) => {
  const entry = sized.find((x) => x.name === p.name)
  return {
    name: p.name,
    source: 'profile',
    mode: 'local',
    configMode: 'custom',
    // 本机有这份代码，不需要联网取上游
    download: (version) => downloadPackage(p.name, version || p.version, config),
    localSize: entry ? entry.size : 0,
  }
})

// 配置层：本机这批插件大多没有自定义配置。为了真测「保留特殊配置文件」这一项，
// 给每个插件注入一份约 3 KB 的合成配置（嵌套对象 + 数组 + 一个假 token），
// 注入前后各测一次，差值就是「配置」这项的真实代价。
const synthConfig = {
  apiKey: 'sk-bench-0123456789abcdef0123456789abcdef',
  endpoint: 'https://example.invalid/v1/chat',
  retries: 3,
  limits: { tokens: 8192, rpm: 60, concurrency: 2 },
  tags: ['bench', 'synthetic', 'config'],
  options: { stream: true, reasoning: 'high', logLevel: 'info' },
}
const makePatch = (plugins) => plugins.map((p) => {
  const id = p.name.replace(/^@[^/]+\//, '')
  return '- id: ' + id + '-bench\n  name: "' + p.name + '"\n  config: ' + JSON.stringify(synthConfig)
}).join('\n')
const USE_SYNTH = process.env.BENCH_CONFIG !== '0'
const patchText = USE_SYNTH ? makePatch(chosen) : ''

const context = { config, profileDir: profile, dshVersion: '', installed: list, pluginVersion: 'bench', patchText, parsePatch: parseYaml }
const common = {
  includeConfig: true,
  includeLocalEdits: true,
  keepLocal: false,
  confirmLicense: true,
  acknowledge: true,
  scanBeforePack: true,
  name: '体积基准',
  description: 'bench',
  author: 'selftest',
}

const timed = async (label, fn) => {
  const t0 = Date.now()
  const value = await fn()
  console.log('  ' + label + ' 用时 ' + (Date.now() - t0) + ' ms')
  return value
}

console.log('\n== 1/3 完整包（现状：带源码）')
const full = await timed('full', () => buildPack({
  selection: selection.map(({ localSize, ...rest }) => rest),
  options: { ...common, includePayload: true },
  context,
}))

console.log('\n== 2/3 轻量包（只记版本）')
const lite = await timed('lite', () => buildPack({
  selection: selection.map(({ localSize, ...rest }) => rest),
  options: { ...common, includePayload: false },
  context,
}))

console.log('\n== 3/3 混合包（下载码 + 必要文件，摘掉 plugins/）')
const fullEntries = readZip(full.buffer, { config })
const groups = { plugins: 0, configs: 0, data: 0, patch: 0, other: 0 }
const counts = { plugins: 0, configs: 0, data: 0, patch: 0, other: 0 }
const kept = []
for (const entry of fullEntries) {
  const isPlugin = entry.name.startsWith('plugins/')
  if (isPlugin) { groups.plugins += entry.data.length; counts.plugins += 1; continue }
  if (entry.name.startsWith('configs/')) { groups.configs += entry.data.length; counts.configs += 1 }
  else if (entry.name.startsWith('data/')) { groups.data += entry.data.length; counts.data += 1 }
  else if (entry.name === 'cordis.patch.yml') { groups.patch += entry.data.length; counts.patch += 1 }
  else { groups.other += entry.data.length; counts.other += 1 }
  kept.push({ name: entry.name, data: entry.data, compress: entry.compress })
}
// 每个插件在包里的未压缩体积（plugins/<目录>/…），以及整体压缩率
const perPlugin = new Map()
for (const entry of fullEntries) {
  const m = /^plugins\/([^/]+)\//.exec(entry.name)
  if (!m) continue
  perPlugin.set(m[1], (perPlugin.get(m[1]) || 0) + entry.data.length)
}

const hybridBuffer = await timed('hybrid zip', async () => writeZip(kept, { config, mtime: new Date() }))

const total = chosen.reduce((sum, p) => sum + p.size, 0)
const rows = [
  ['完整包 full（现状）', full.buffer.length, fullEntries.length],
  ['轻量包 lite', lite.buffer.length, readZip(lite.buffer, { config }).length],
  ['混合包 hybrid（下载码+必要文件）', hybridBuffer.length, kept.length],
]

console.log('\n== 结果 ==')
console.log('插件源码合计：' + bytes(total))
console.log('')
console.log('| 策略 | 包大小 | 相对 full | 条目数 |')
console.log('| --- | --- | --- | --- |')
for (const [label, size, count] of rows) {
  console.log('| ' + label + ' | ' + bytes(size) + '（' + size + ' 字节） | ' + pct(size, full.buffer.length) + ' | ' + count + ' |')
}
console.log('')
console.log('full 包内容分布（未压缩原始字节）：')
console.log('  plugins/   ' + bytes(groups.plugins) + ' · ' + counts.plugins + ' 个文件')
console.log('  configs/   ' + bytes(groups.configs) + ' · ' + counts.configs + ' 个')
console.log('  data/      ' + bytes(groups.data) + ' · ' + counts.data + ' 个')
console.log('  patch      ' + bytes(groups.patch))
console.log('  其余(清单/报告/安装器/README) ' + bytes(groups.other) + ' · ' + counts.other + ' 个')
console.log('')
console.log('')
console.log('每个插件在 full 包里的未压缩体积：')
for (const [dir, size] of [...perPlugin.entries()].sort((a, b) => b[1] - a[1])) {
  const row = chosen.find((p) => p.name === dir || p.name.endsWith('/' + dir))
  console.log('  ' + dir + (row ? '（' + row.name + '@' + row.version + '）' : '') + ' ' + bytes(size))
}
console.log('')
console.log('整体压缩率：' + pct(full.buffer.length, groups.plugins + groups.configs + groups.data + groups.patch + groups.other) + '（包 / 原始内容）')
console.log('若改成 hybrid：' + bytes(full.buffer.length) + ' → ' + bytes(hybridBuffer.length)
  + '（省 ' + (((full.buffer.length - hybridBuffer.length) / full.buffer.length) * 100).toFixed(1) + '%）')

// 沙箱产物别留在 profile 目录里
for (const p of [full, lite]) {
  try { fs.rmSync(path.join(config.home || path.dirname(profile), 'dsh-modpack', 'packs', p.fileName), { force: true }) } catch { /* 忽略 */ }
}
