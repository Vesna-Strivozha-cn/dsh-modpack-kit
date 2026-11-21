#!/usr/bin/env node
/**
 * DSH 整合包独立安装器（由 dsh-modpack-kit 打包时写入包内 install/install.mjs）。
 *
 * 不依赖任何插件：只要本机有 DSH 与 Node 20+，解压后即可安装。
 *
 * 用法：
 *   node install/install.mjs [--profile desktop] [--dry-run] [--no-bundles] [--replace] [--force]
 *                            [--dsh "<DSH 可执行文件或 cli.js>"]
 *
 * 参数：
 *   --profile <名字>  目标 profile，默认 desktop（也读 DSH_PROFILE）
 *   --dry-run         只打印要执行的命令，不改任何文件
 *   --no-bundles      装文件但不登记到 dsh.profile.bundles（重启也不加载）
 *   --replace         本机已装的也换成包内版本（默认跳过已装的）
 *   --force           兼容性检查发现问题也继续（不推荐）
 *   --dsh <path>      指定 DSH：可执行文件，或 app.asar 里那份 cli.js
 *
 * 目标目录固定是本机的 ~/.dsh：DSH 的命令行只认自己的家目录（实测不认
 * DSH_HOME / USERPROFILE），所以这里不去猜别的位置。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const val = (name, fallback = '') => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const say = (text) => console.log(text)
const die = (text) => {
  console.error(text)
  process.exit(1)
}

const manifestFile = path.join(root, 'dsh-modpack.json')
if (!fs.existsSync(manifestFile)) {
  die('找不到 dsh-modpack.json：请把 dsh-modpack.json 与 plugins/ 解压到同一目录后再运行 install/install.mjs。')
}
let manifest
try {
  manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
} catch (error) {
  die('dsh-modpack.json 不是合法 JSON：' + error.message)
}

const profile = val('--profile', process.env.DSH_PROFILE || process.env.DSH_PROFILE_NAME || 'desktop')
const home = path.join(os.homedir(), '.dsh')
const profileDir = path.join(home, 'profiles', profile)
const dryRun = has('--dry-run')
const noBundles = has('--no-bundles')
const force = has('--force')
// 默认跳过本机已装的（同名或同插件不同版本都算已有）；--replace 才覆盖
const replaceExisting = has('--replace') || has('--force-existing')

say('DSH 整合包：' + (manifest.name || '(未命名)') + ' · ' + (manifest.format === 'full' ? '完整版' : '轻量版'))
if (manifest.author) say('打包者：' + manifest.author)
if (manifest.createdAt) say('打包时间：' + new Date(manifest.createdAt).toLocaleString())
const pluginCount = Array.isArray(manifest.plugins) ? manifest.plugins.length : 0
say('包含插件：' + pluginCount + ' 个' + (pluginCount ? '（' + manifest.plugins.map((item) => item.name + (item.version ? '@' + item.version : '')).join('、') + '）' : ''))
if (manifest.description) {
  say('说明：')
  for (const line of String(manifest.description).split(/\r?\n/u)) say('  ' + line)
}
say('目标 profile：' + profile + '  目录：' + profileDir)
if (process.env.DSH_HOME && path.resolve(process.env.DSH_HOME) !== path.resolve(home)) {
  say('提示：环境变量 DSH_HOME 已设成 ' + process.env.DSH_HOME + '，但 DSH 的命令行只认 ' + home + '；本安装器按实际生效的位置安装。')
}
if (fs.existsSync(profileDir) && !fs.existsSync(path.join(profileDir, 'package.json'))) {
  die('目标 profile 缺少 package.json：' + profileDir)
}
if (!fs.existsSync(profileDir)) {
  say('提示：这个 profile 还没建过，DSH 会在第一次装插件时自动初始化它。')
}

/** 找 DSH 的命令行入口：显式参数 > PATH 里的 dsh > 常见安装位置。 */
function resolveCli() {
  const explicit = val('--dsh') || process.env.DSH_CLI || ''
  if (explicit) {
    if (/\.(?:mjs|cjs|js)$/iu.test(explicit)) {
      return { exe: process.execPath, args: ['--expose-internals', path.resolve(explicit)], env: { ELECTRON_RUN_AS_NODE: '1' }, label: explicit }
    }
    return { exe: explicit, args: [], env: {}, label: explicit }
  }
  // 自己就跑在 DSH 的 Electron 里（打包页「用系统 node 打开」不算，那时 execPath 是 node）
  if (process.env.ELECTRON_RUN_AS_NODE === '1' && !/^node(\.exe)?$/iu.test(path.basename(process.execPath))) {
    const dir = path.dirname(process.execPath)
    const cli = path.join(dir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    if (fs.existsSync(cli)) return { exe: process.execPath, args: ['--expose-internals', cli], env: { ELECTRON_RUN_AS_NODE: '1' }, label: process.execPath }
  }
  const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (probe.status === 0) return { exe: 'dsh', args: [], env: {}, label: 'dsh（PATH）', shell: process.platform === 'win32' }
  const guesses = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join(process.env.ProgramFiles || '', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ].filter(Boolean)
  for (const exe of guesses) if (fs.existsSync(exe)) return { exe, args: [], env: {}, label: exe }
  // 标准安装目录里的 dsh 命令行垫片
  for (const base of guesses.map((exe) => path.dirname(exe))) {
    const shim = path.join(base, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
    if (fs.existsSync(shim)) return { exe: shim, args: [], env: {}, label: shim, shell: true }
  }
  return null
}

const cli = resolveCli()
if (!cli) {
  say('')
  say('没找到 DSH 的命令行入口。两种办法：')
  say('  1. 加参数指定：node install/install.mjs --dsh "D:\\你的安装位置\\DeepSeek Harness.exe"')
  say('  2. 手工装：对 plugins/ 下每个目录执行')
  say('       dsh plugin --profile ' + profile + ' add "file:<绝对路径>"')
  if (manifest.format === 'lite') {
    say('     轻量版没有插件本体，改为按版本从 registry 安装：dsh plugin --profile ' + profile + ' add <插件名>@<版本>')
  }
  process.exit(3)
}

say('使用命令行：' + cli.label)
say('')

/** 把插件目录复制到 ~/.dsh/dsh-modpack/vendor/<包名>/ 下再装，避免「解压目录一删就断」。 */
function vendorRoot() {
  const ascii = String(manifest.slug || manifest.name || '')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  const tag = createHash('sha256')
    .update(String(manifest.name || '') + '|' + String(manifest.createdAt || '') + '|' + String((manifest.plugins || []).length))
    .digest('hex')
    .slice(0, 8)
  return path.join(home, 'dsh-modpack', 'vendor', (ascii || 'pack') + '-' + tag)
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to)
  }
}

const vendor = vendorRoot()
if (manifest.format === 'full' && !dryRun) say('插件会先复制到：' + vendor)

const results = []
const skipped = []
// 本机已装的插件名：同名或同插件不同版本都算「已有」，默认不覆盖
function readDependencies() {
  const pkgFile = path.join(profileDir, 'package.json')
  if (!fs.existsSync(pkgFile)) return {}
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    return pkg && typeof pkg.dependencies === 'object' && pkg.dependencies ? pkg.dependencies : {}
  } catch {
    return {}
  }
}
const installedBefore = readDependencies()

for (const plugin of manifest.plugins || []) {
  if (plugin.transitiveOf) {
    // 父包会把它带进来：单独装一遍只会重复
    results.push({ plugin, ok: true, skipped: true, message: '是「' + plugin.transitiveOf + '」的内部组件，随父包一起安装' })
    say('跳过 ' + plugin.name + '：它是「' + plugin.transitiveOf + '」的内部组件，父包会一起装上')
    continue
  }
  const already = installedBefore[plugin.name]
  if (already && !replaceExisting) {
    // 需求：先跳过已装的，其余照装；装完再告诉用户怎么换
    skipped.push({ name: plugin.name, localVersion: String(already), packVersion: plugin.version || '' })
    results.push({ plugin, ok: true, skipped: true, message: '本机已装 ' + already + '，跳过（要换成包内版本，加 --replace 重跑）' })
    say('跳过 ' + plugin.name + '：本机已装 ' + already)
  } else {
  const dirName = plugin.dirName || plugin.name
  let fileSpec = ''
  if (manifest.format === 'full') {
    const dir = path.join(root, 'plugins', dirName)
    if (!fs.existsSync(dir)) {
      results.push({ plugin, ok: false, message: '包里缺少 plugins/' + dirName })
      continue
    }
    if (dryRun) {
      fileSpec = 'file:' + dir.replace(/\\/gu, '/')
    } else {
      const target = path.join(vendor, dirName)
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      copyTree(dir, target)
      fileSpec = 'file:' + target.replace(/\\/gu, '/')
    }
  }
  const marketSpec = plugin.name + (plugin.version ? '@' + plugin.version : '')
  // 需求：包里这份当初是从插件市场取的（source npm/market），安装时优先按市场版本装，
  // 取不到（离线 / registry 上没有这个版本）再退回包内自带的那份。
  const fromMarket = plugin.source === 'npm' || plugin.source === 'market'
  const attempts = []
  if (fromMarket) attempts.push({ spec: marketSpec, from: 'market' })
  if (fileSpec) attempts.push({ spec: fileSpec, from: 'pack' })
  if (!fromMarket && !fileSpec) attempts.push({ spec: marketSpec, from: 'market' })
  if (attempts.length === 0) attempts.push({ spec: marketSpec, from: 'market' })
  const runAdd = (spec) => {
    const args = [...cli.args, 'plugin', '--profile', profile, 'add', spec]
    if (dryRun) return { ok: true, output: '', args }
    const res = spawnSync(cli.exe, args, {
      encoding: 'utf8',
      env: { ...process.env, CI: '1', ...(cli.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      shell: cli.shell === true,
      maxBuffer: 32 * 1024 * 1024,
    })
    return { ok: res.status === 0, output: String(res.stdout || '') + String(res.stderr || ''), args }
  }
  if (dryRun) {
    results.push({ plugin, ok: true, message: '演练：' + [cli.exe, ...runAdd(attempts[0].spec).args].join(' ') + (attempts.length > 1 ? '（失败则退回包内那份）' : '') })
    continue
  }
  const started = Date.now()
  let last = null
  let usedFrom = ''
  for (const attempt of attempts) {
    say('安装 ' + plugin.name + (plugin.version ? '@' + plugin.version : '') + '（' + (attempt.from === 'market' ? '插件市场版本' : '包内自带') + '）…')
    const res = runAdd(attempt.spec)
    last = res
    if (res.ok) { usedFrom = attempt.from; break }
    if (attempts.length > 1 && attempt.from === 'market') say('  市场版本没装上，改用包内自带的那份再试一次')
  }
  const ok = Boolean(last && last.ok)
  const message = ok
    ? '已安装（' + Math.round((Date.now() - started) / 100) / 10 + ' 秒' + (usedFrom === 'market' ? '，市场版本' : usedFrom === 'pack' ? '，包内自带' : '') + '）'
    : '失败：' + String(last && last.output || '').trim().split(/\r?\n/u).slice(-3).join(' | ')
  results.push({ plugin, ok, message })
  say('  ' + (ok ? '完成' : '失败'))
  }
}

/** 把 configs/<插件>.json 合并回 cordis.patch.yml（只在目标条目不存在时追加）。 */
function restoreConfigs() {
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const dir = path.join(root, 'configs')
  if (!fs.existsSync(dir)) return []
  const restored = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    let snap
    try {
      snap = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const id = String(snap.id || snap.name || name.replace(/\.json$/u, ''))
    let text = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : ''
    // DSH 新建 profile 的补丁文件是「几行注释 + []」：只把 [] 当成空文档去掉，
    // 否则追加会写出两份 YAML 文档（[] 之后再跟 - id: …），整个文件就废了。
    const bare = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
    const emptyDoc = bare.length === 0 || (bare.length === 1 && /^(?:\[\s*\]|\{\s*\}|null|~)$/u.test(bare[0]))
    if (emptyDoc) text = ''
    if (new RegExp('(^|\\n)\\s*-\\s*id:\\s*' + id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).test(text)) {
      say('  配置条目已存在，保持本机原样：' + id)
      continue
    }
    const block = ['- id: ' + id, '  name: ' + String(snap.name || id)]
    if (snap.disabled) block.push('  disabled: true')
    if (snap.config && typeof snap.config === 'object') block.push('  config: ' + JSON.stringify(snap.config))
    if (dryRun) {
      restored.push(id + '（演练）')
      continue
    }
    const next = (text === '' ? '' : text.replace(/\s*$/u, '\n')) + block.join('\n') + '\n'
    fs.writeFileSync(patchFile, next, 'utf8')
    restored.push(id)
  }
  return restored
}

/** --no-bundles：把刚登记的 bundle 名从 package.json 里撤回。 */
function stripBundles() {
  const pkgFile = path.join(profileDir, 'package.json')
  if (!fs.existsSync(pkgFile)) return 0
  const raw = fs.readFileSync(pkgFile, 'utf8')
  let pkg
  try {
    pkg = JSON.parse(raw)
  } catch {
    return 0
  }
  const list = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : null
  if (!list) return 0
  const names = new Set((manifest.plugins || []).map((p) => p.name))
  const next = list.filter((name) => !names.has(name))
  const removed = list.length - next.length
  if (removed > 0 && !dryRun) {
    pkg.dsh.profile.bundles = next
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  }
  return removed
}

say('')
if (skipped.length > 0) {
  say('以下 ' + skipped.length + ' 个插件本机已经装了，安装器按规则先跳过、没动它们：')
  for (const item of skipped) say('  - ' + item.name + '：本机 ' + item.localVersion + ' → 包内 ' + (item.packVersion || '未知'))
  say('如果要换成包内版本，重跑并加 --replace：node install/install.mjs --profile ' + profile + ' --replace')
  say('（保留本机版本就不用管，其余插件已经装好了。）')
  say('')
}
const failed = results.filter((r) => !r.ok)
for (const r of results) say((r.ok ? '  ok   ' : '  FAIL ') + r.plugin.name + ' :: ' + r.message)

if (manifest.options && manifest.options.includeConfig) {
  const restored = restoreConfigs()
  if (restored.length > 0) say('配置已回填：' + restored.join(', '))
  const data = restoreData()
  if (data.written.length > 0) say('数据快照已写回 ' + data.written.length + ' 个文件：' + data.written.slice(0, 6).join('、') + (data.written.length > 6 ? ' 等' : ''))
  if (data.kept.length > 0) say('有 ' + data.kept.length + ' 个数据文件本机已有，未覆盖（要覆盖就加 --replace 重跑）')
}
const groupResult = restoreGroups()
if (groupResult.applied) say('已按包内分组并入插件市场：' + groupResult.applied)
if (groupResult.skipped) say('这个包按分组打包（' + groupResult.skipped + '），但目标 profile 没装插件市场，分组没有写入')
/** 分组：把包里记的组名并进目标 profile 的 .dsh-market/state.json（只加成员，不动别的）。 */
function restoreGroups() {
  const adds = new Map()
  for (const plugin of manifest.plugins || []) {
    if (!plugin.group || plugin.transitiveOf) continue
    if (!adds.has(plugin.group)) adds.set(plugin.group, [])
    adds.get(plugin.group).push(plugin.name)
  }
  if (adds.size === 0) return { applied: '', skipped: '' }
  const text = [...adds].map(([name, members]) => name + '（' + members.length + ' 个）').join('、')
  const marketDir = path.join(profileDir, '.dsh-market')
  if (!fs.existsSync(marketDir)) return { applied: '', skipped: text }
  const stateFile = path.join(marketDir, 'state.json')
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    raw = {}
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) raw = {}
  const groups = raw.groups && typeof raw.groups === 'object' && !Array.isArray(raw.groups) ? { ...raw.groups } : {}
  const order = Array.isArray(raw.groupOrder) ? raw.groupOrder.filter((x) => typeof x === 'string') : []
  const parts = []
  for (const [name, members] of adds) {
    const current = Array.isArray(groups[name]) ? groups[name].filter((x) => typeof x === 'string') : []
    let added = 0
    for (const member of members) {
      if (current.includes(member)) continue
      current.push(member)
      added += 1
    }
    if (added === 0 && groups[name] !== undefined) continue
    groups[name] = current
    if (!order.includes(name)) order.push(name)
    parts.push(name + '（+' + added + '）')
  }
  if (parts.length === 0) return { applied: '', skipped: '' }
  raw.groups = groups
  raw.groupOrder = order
  if (!dryRun) {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(raw, null, 2) + '\n', 'utf8')
    } catch {
      return { applied: '', skipped: '' }
    }
  }
  return { applied: parts.join('、'), skipped: '' }
}

/** 数据快照：把包里 data/<目录>/ 下的文本文件放回 ~/.dsh/<目录>/，默认不覆盖本机已有文件。 */
function restoreData() {
  const dir = path.join(root, 'data')
  if (!fs.existsSync(dir)) return { written: [], kept: [] }
  const written = []
  const kept = []
  const walk = (current, relBase) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const abs = path.join(current, entry.name)
      const rel = path.join(relBase, entry.name)
      if (entry.isDirectory()) { walk(abs, rel); continue }
      if (!entry.isFile()) continue
      const [base, ...rest] = rel.split(/[\\/]/u)
      if (!rest.length) continue
      const baseDir = path.resolve(home, base)
      const target = path.resolve(baseDir, rest.join(path.sep))
      if (!target.startsWith(baseDir + path.sep)) continue
      if (dryRun) { written.push('（演练）' + rel); continue }
      if (fs.existsSync(target) && !replaceExisting) { kept.push(rel); continue }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(abs, target)
      written.push(rel)
    }
  }
  walk(dir, '')
  return { written, kept }
}

if (noBundles) {
  const removed = stripBundles()
  say(removed > 0 ? '按 --no-bundles 撤回了 ' + removed + ' 条 bundle 登记（装了但不加载）。' : '没有需要撤回的 bundle 登记。')
}

say('')
if (failed.length > 0) {
  say(failed.length + ' 个插件没装上。整理好上面的报错后可重跑本脚本（已装上的会被跳过或覆盖）。')
  if (!force) process.exit(1)
}
say('完成。重启 DSH 后生效' + (noBundles ? '（本次按参数未启用，重启也不会加载）。' : '。'))
