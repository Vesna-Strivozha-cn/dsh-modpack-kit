/**
 * dsh-modpack —— 打包。
 *
 * 三种打包策略：
 *   full    完整包：插件本体装进 zip，不联网也能装；允许带自定义配置与数据。
 *   lite    仅下载码：只有清单与版本号，体积最小；不带配置，装完依赖写成 ^版本（市场认市场版）。
 *   hybrid  混合包：只带版本号与配置/数据/补丁片段，不带插件本体；体积接近 lite，配置照样能带。
 *
 * 打包顺序是刻意的：先收集 → 先扫描 → 再决定是否允许写盘。扫描在内存里做，
 * 命中原文不落盘；高风险默认拒绝出包，除非调用方显式 force 并写进报告。
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeZip } from './zip.mjs'
import { scanEntries, renderScanReport, groupFindings } from './scan.mjs'
import { MANIFEST_NAME, SCHEMA, KIND, normalizeManifest, buildReadme, sha256, shortHash } from './manifest.mjs'
import { scanFileName } from './scan.mjs'
import { slugify } from './store.mjs'

const STUB_DIR = new URL('../assets/', import.meta.url)
const stub = (name) => fs.readFileSync(new URL(name, STUB_DIR))

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '.cache', '.turbo', '.next', 'coverage'])
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
const DATA_EXT = new Set(['.json', '.md', '.txt', '.yml', '.yaml', '.csv', '.toml', '.ini'])

export class PackRefused extends Error {
  constructor(message, scan, extra = {}) {
    super(message)
    this.name = 'PackRefused'
    this.scan = scan
    this.needsAck = extra.needsAck === true
    this.trustedOnly = extra.trustedOnly === true
    this.checkpoint = extra.checkpoint || null
  }
}

/** 递归收集目录里的普通文件；符号链接一律跳过（不跟随、不打包）。 */
export function collectFiles(root, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? 16 * 1024 * 1024
  const maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024
  const prefix = options.prefix ?? ''
  const out = []
  const notes = []
  let total = 0

  const walk = (dir, rel) => {
    let dirents
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      notes.push('读不到目录 ' + rel + '：' + String(error?.message || error))
      return
    }
    for (const dirent of dirents) {
      const abs = path.join(dir, dirent.name)
      const relPath = rel ? rel + '/' + dirent.name : dirent.name
      if (dirent.isSymbolicLink()) { notes.push('跳过符号链接 ' + prefix + relPath); continue }
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) continue
        walk(abs, relPath)
        continue
      }
      if (!dirent.isFile()) continue
      if (SKIP_FILES.has(dirent.name)) continue
      let stat
      try { stat = fs.statSync(abs) } catch { continue }
      if (stat.size > maxFileBytes) { notes.push('跳过超大文件 ' + prefix + relPath + '（' + stat.size + ' 字节）'); continue }
      total += stat.size
      if (total > maxTotalBytes) throw new Error('内容超过打包上限（' + maxTotalBytes + ' 字节），请减少插件')
      let data
      try { data = fs.readFileSync(abs) } catch (error) { notes.push('读不到 ' + prefix + relPath + '：' + String(error?.message || error)); continue }
      out.push({ name: prefix + relPath, data, mtime: stat.mtime })
    }
  }
  walk(root, '')
  return { files: out, notes }
}

/** 从 profile 读一个已装插件。 */
export function readInstalledPlugin(installed, options = {}) {
  const { files, notes } = collectFiles(installed.dir, {
    // 调用方若没带 dirName（例如直接按名字选插件），退回到包名，避免写出 plugins/undefined/
    prefix: 'plugins/' + (installed.dirName || installed.name) + '/',
    maxFileBytes: options.maxFileBytes,
    maxTotalBytes: options.maxTotalBytes,
  })
  return { files, notes, pkg: installed.pkg }
}

/**
 * 抓 profile 补丁层里的配置（每个插件一条）。
 * 解析失败就整体放弃自动抓取，只留一句 note——宁可少带，也不带错。
 */
/**
 * 配置里的凭据擦除。
 *
 * 打包会把插件的 config 一起带走，而 config 最容易藏 token。做法是两道：
 * 字段名归一化后命中名单（`api_key` / `apiKey` / `api-key` 都算），或者值本身
 * 长得像密钥，就替换成字面量 ${REDACTED}。只按“归一化后完全相等”判字段名，
 * 免得把 `apiKeyEnv` 这种写环境变量名的字段误伤。
 */
const SECRET_KEY_SET = new Set([
  'apikey', 'apitoken', 'token', 'accesstoken', 'refreshtoken', 'secret',
  'clientsecret', 'password', 'passwd', 'credential', 'credentials',
  'authorization', 'cookie', 'privatekey', 'secretkey', 'sessionkey',
  'sessdata', 'bilijct', 'dedeuserid',
])

const SECRET_VALUE_PATTERN = 'sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}'
const SECRET_VALUE_TEST = new RegExp(SECRET_VALUE_PATTERN)
const SECRET_VALUE_GLOBAL = new RegExp(SECRET_VALUE_PATTERN, 'gu')

export const REDACTED = '${REDACTED}'

export function normalizeConfigKey(key) {
  return String(key ?? '').toLowerCase().replace(/[-_\s]/gu, '')
}

/**
 * @returns {{value: unknown, paths: string[]}} 擦除后的值与命中路径
 */
export function redactConfig(value, path = '', paths = []) {
  if (Array.isArray(value)) {
    return { value: value.map((item, index) => redactConfig(item, path + '[' + index + ']', paths).value), paths }
  }
  if (value && typeof value === 'object') {
    const next = {}
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? path + '.' + key : key
      const empty = child === undefined || child === null || child === ''
      if (SECRET_KEY_SET.has(normalizeConfigKey(key))) {
        if (!empty && typeof child !== 'boolean') paths.push(childPath)
        next[key] = REDACTED
        continue
      }
      next[key] = redactConfig(child, childPath, paths).value
    }
    return { value: next, paths }
  }
  if (typeof value === 'string' && SECRET_VALUE_TEST.test(value)) {
    const replaced = value.replace(SECRET_VALUE_GLOBAL, REDACTED)
    if (replaced !== value) paths.push(path || '(值)')
    return { value: replaced, paths }
  }
  return { value, paths }
}

export function captureConfigs(patchText, plugins, parsePatch) {
  const captured = new Map()
  const notes = []
  let items = []
  try {
    items = parsePatch(patchText)
  } catch (error) {
    notes.push('配置层解析失败，未抓取任何配置：' + String(error?.message || error))
    return { captured, notes }
  }
  if (!Array.isArray(items)) return { captured, notes }
  const byName = new Map(plugins.map((p) => [p.name, p]))
  const duplicateIds = new Set()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const name = typeof item.name === 'string' ? item.name : ''
    const id = typeof item.id === 'string' ? item.id : ''
    const hit = byName.get(name) || byName.get(id)
    if (!hit) continue
    // 同一个 id 可能有多条（常见的是早先一条带 config、后来又追加一条 disabled 的）。
    // 抓配置要挑有内容的那条，别让后面的空条目把前面的盖掉。
    const seen = captured.get(hit.name)
    const hasConfig = item.config !== null && item.config !== undefined
    if (seen && (!hasConfig || (seen.config !== null && seen.config !== undefined))) {
      duplicateIds.add(item.id || hit.name)
      continue
    }
    // 配置里最可能藏 token；打包前按字段名与明文特征先抹掉，包离手之后就不会再漏。
    const redacted = redactConfig(item.config ?? null)
    if (redacted.paths.length > 0) {
      notes.push('配置 ' + hit.name + ' 里 ' + redacted.paths.length + ' 处疑似凭据已替换为 ${REDACTED}：' + redacted.paths.slice(0, 6).join(', ') + (redacted.paths.length > 6 ? ' 等' : ''))
    }
    captured.set(hit.name, {
      id: item.id,
      name: item.name,
      disabled: item.disabled === true ? true : undefined,
      config: redacted.value,
      ...(redacted.paths.length > 0 ? { configRedacted: redacted.paths } : {}),
    })
  }
  if (duplicateIds.size > 0) {
    notes.push('补丁层里有重复条目的 id（以带 config 的那条为准）：' + [...duplicateIds].slice(0, 6).join(', '))
  }
  return { captured, notes }
}

function dataDirsFor(name) {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
  // 插件的数据目录名不一定等于包名（例如 dsh-plugin-memory 存在 plugin-memory 下），
  // 所以按目录真名打包，安装时才能原路放回。
  const candidates = [name, name.replace(/^dsh-/u, '')].filter(Boolean)
  const out = []
  const seen = new Set()
  for (const candidate of candidates) {
    const dir = path.join(home, candidate)
    try {
      if (!fs.statSync(dir).isDirectory()) continue
      const base = path.basename(dir)
      if (seen.has(base)) continue
      seen.add(base)
      out.push({ dir, base, prefix: 'data/' + base + '/' })
    } catch {}
  }
  return out
}

/**
 * 数据快照里的文本擦除：只动「明显的凭据值」，不改结构。
 * - sk-/ghp_/xoxb-/AKIA 这类明文 token 直接替换；
 * - SESSDATA=… / password: … / api_key=… 这类键值对，只保留键名。
 * 原文不落盘，替换后写进包里；命中条数记在 note 上。
 */
const DATA_SECRET_PAIR = /(\b(?:sessdata|bili_jct|dedeuserid|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|password|passwd|authorization|cookie)\b\s*[:=]\s*)(["']?)([^\s"',;}]{8,})\2/giu

function scrubText(text) {
  let count = 0
  let out = text.replace(SECRET_VALUE_GLOBAL, () => { count += 1; return REDACTED })
  out = out.replace(DATA_SECRET_PAIR, (whole, head, quote) => {
    count += 1
    return head + quote + REDACTED + quote
  })
  return { text: out, count }
}

/** 插件数据快照：只收小体积文本类，凭证类文件名直接跳过。 */
export function captureData(name, options = {}) {
  const files = []
  const notes = []
  const dirs = []
  let total = 0
  let redacted = 0
  const limit = options.maxBytes ?? 8 * 1024 * 1024
  for (const { dir, base, prefix } of dataDirsFor(name)) {
    const entries = []
    const walk = (d, rel) => {
      let dirents
      try { dirents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) continue
        const abs = path.join(d, dirent.name)
        const relPath = rel ? rel + '/' + dirent.name : dirent.name
        if (dirent.isDirectory()) { if (!SKIP_DIRS.has(dirent.name)) walk(abs, relPath); continue }
        if (!dirent.isFile()) continue
        const ext = path.extname(dirent.name).toLowerCase()
        if (!DATA_EXT.has(ext)) continue
        if (scanFileName(prefix + relPath).some((f) => f.severity === 'high')) { notes.push('跳过疑似凭证文件 ' + prefix + relPath); continue }
        let stat
        try { stat = fs.statSync(abs) } catch { continue }
        if (stat.size > 1024 * 1024) continue
        total += stat.size
        if (total > limit) { notes.push('数据快照超过上限，后面的没带'); return }
        entries.push({ abs, name: prefix + relPath, size: stat.size })
      }
    }
    walk(dir, '')
    if (entries.length > 0) dirs.push(base)
    for (const entry of entries) {
      try {
        const raw = fs.readFileSync(entry.abs)
        const { text, count } = scrubText(raw.toString('utf8'))
        if (count > 0) {
          redacted += count
          notes.push('数据文件 ' + entry.name + ' 里 ' + count + ' 处疑似凭据已替换为 ${REDACTED}')
          files.push({ name: entry.name, data: Buffer.from(text, 'utf8'), mtime: new Date() })
        } else {
          files.push({ name: entry.name, data: raw, mtime: new Date() })
        }
      } catch {}
    }
  }
  return { files, notes, dirs, redacted }
}

function licenseId(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses) && pkg.licenses[0]) return String(pkg.licenses[0].type || '')
  return ''
}

function authorOf(pkg) {
  if (typeof pkg.author === 'string') return pkg.author
  if (pkg.author && typeof pkg.author.name === 'string') return pkg.author.name
  return ''
}

/**
 * 生成整合包。
 * @param {object} input
 * @param {{name: string, source: 'profile'|'npm'|'url', spec?: string, download?: Function}[]} input.selection
 * @param {object} input.options {includePayload, includeConfig, includeLocalEdits, blockHighRisk, force, confirmLicense}
 * @param {object} input.context {config, profileDir, dshVersion, installed, pluginVersion, extraScanRules, parsePatch}
 */
export async function buildPack(input) {
  const { selection, options, context } = input
  const config = context.config
  const plugins = []
  let payload = []
  let notes = []
  let manifestPlugins = []
  // 每个插件自己的依赖名（用来判断「谁是谁的内部组件」）
  const depsOf = new Map()
  let capturedFiles = []
  let scan = null
  let trustedOnly = false
  const scanRules = context.extraScanRules || []
  const strategy = options.strategy === 'lite' || options.strategy === 'hybrid'
    ? options.strategy
    : options.includePayload === false ? 'lite' : 'full'
  const format = strategy
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const tick = (stage, pct, note) => { try { progress({ stage, pct: Math.max(0, Math.min(100, Math.round(pct))), note }) } catch {} }

  const resume = options && typeof options.resume === 'object' ? options.resume : null
  if (resume) {
    // 停在风险点之后点「我知道在干什么」：复用上次的结果，不重新收集、也不重新检测
    payload = Array.isArray(resume.payload) ? resume.payload : []
    capturedFiles = Array.isArray(resume.capturedFiles) ? resume.capturedFiles : []
    manifestPlugins = Array.isArray(resume.manifestPlugins) ? resume.manifestPlugins : []
    notes = Array.isArray(resume.notes) ? resume.notes.slice() : []
    scan = resume.scan
    trustedOnly = resume.trustedOnly === true
    notes.push('已确认风险：检测结果沿用上一次，不重复扫描')
    tick('capture', 62, '已确认风险，从检测点继续')
  } else {
  tick('collect', 4, '读取插件清单')
  for (const pick of selection) {
    if (!pick || typeof pick.name !== 'string') continue
    let files = []
    let pkg = null
    let source = pick.source
    let registry = ''
    let tarball = ''
    let integrity = ''
    let requested = pick.spec || ''
    // 「名字@版本」里取出真正的版本号（可能带作用域，所以取最后一个 @）
    const parseSpecVersion = (spec) => {
      const text = String(spec || '')
      const at = text.lastIndexOf('@')
      return at > 0 ? text.slice(at + 1).trim() : ''
    }
    let localEdits = false
    let payloadDir = ''
    // 每个插件可以单独选：base = 上游原版 + 插件基础配置；local = 连本机改动一起打
    const wantLocal = pick.mode === 'local' ? true : pick.mode === 'base' ? false : options.includeLocalEdits === true
    // 每个插件自己带「插件预设 / 自定义配置」：预设只打插件默认配置，自定义才抓本机配置与数据快照。
    // 老客户端不发 configMode 时退回全局 includeConfig，保持兼容。
    const wantConfig = pick.configMode === 'preset'
      ? false
      : pick.configMode === 'custom'
        ? true
        : pick.mode === 'base'
          ? false
          : pick.mode === 'local'
            ? true
            : options.includeConfig !== false

    // 混合包按插件分档：能按「名字@版本」装的就只记版本（轻量那部分），
    // 没有确定版本、或要带走本机改动的插件才连代码一起打进包里（完整那部分）。
    // 判断版本号时先看本机已装的那份（profile 源的对象里带 version）。
    const installedForVersion = source === 'profile' && Array.isArray(context.installed)
      ? context.installed.find((p) => p.name === pick.name)
      : null
    const candidateVersion = String((installedForVersion && installedForVersion.version) || pick.version || pick.spec || '')
    const versionOk = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(candidateVersion) && candidateVersion !== '0.0.0'
    const embedded = format === 'full' || (format === 'hybrid' && (!versionOk || (wantLocal && source === 'profile')))
    if (format === 'hybrid') {
      notes.push(embedded
        ? pick.name + '：没有确定的版本号或要带走本机改动，完整打包（安装时不需要联网）'
        : pick.name + '：只记版本号，安装时联网从市场取包')
    }
    const needPayload = embedded
    if (source === 'profile') {
      const installed = context.installed.find((p) => p.name === pick.name)
      if (!installed) throw new Error('本地找不到插件：' + pick.name)
      if (!needPayload) {
        // 只带版本号：读一下 package.json 就够（清单要用 license / peer / engines），不碰几万个文件
        pkg = installed.pkg || null
        payloadDir = installed.dirName || installed.name
        localEdits = false
      }
      const loaded = needPayload ? readInstalledPlugin(installed, { maxFileBytes: config?.maxFileBytes, maxTotalBytes: config?.maxPackBytes }) : { files: [], notes: [], pkg }
      files = loaded.files
      pkg = loaded.pkg
      notes.push(...loaded.notes)
      payloadDir = installed.dirName || installed.name
      localEdits = true
      if (needPayload && !wantLocal && typeof pick.download === 'function') {
        // 想打“上游原版”就从 registry 重下，失败则保留本地并标注
        try {
          const downloaded = await pick.download(installed.version)
          files = downloaded.entries
            .filter((e) => !SKIP_DIRS.has(e.name.split('/')[0]))
            .map((e) => ({ name: 'plugins/' + installed.dirName + '/' + e.name, data: e.data }))
          pkg = downloaded.pkg
          registry = downloaded.registry
          tarball = downloaded.tarball
          integrity = downloaded.integrity
          localEdits = false
        } catch (error) {
          notes.push(pick.name + '：取上游原版失败，改打本地文件（' + String(error?.message || error) + '）')
        }
      }
    } else if (source === 'npm') {
      if (!needPayload) {
        // 只记版本的插件不打代码：客户端给什么版本号就记什么，不去 registry 校验。
        // 打包器不替注册表当裁判；「市场版」这个身份要等安装时联网取包才确认。
        const specVersion = parseSpecVersion(requested) || String(pick.version || '') || String(pick.spec || '')
        pkg = { name: pick.name, version: specVersion, license: '', peerDependencies: {}, engines: {}, dist: {} }
        payloadDir = pick.name
        localEdits = false
        registry = ''
        tarball = ''
        integrity = ''
        if (!pkg) throw new Error('取不到版本信息：' + pick.name)
      } else if (typeof pick.download !== 'function') throw new Error('缺少下载器')
      if (needPayload) {
      const downloaded = await pick.download(parseSpecVersion(requested) || String(pick.version || '') || undefined)
      pkg = downloaded.pkg
      registry = downloaded.registry
      tarball = downloaded.tarball
      integrity = downloaded.integrity
      const dirName = pkg.name
      payloadDir = dirName
      files = downloaded.entries.map((e) => ({ name: 'plugins/' + dirName + '/' + e.name, data: e.data }))
      localEdits = false
      }
    } else {
      throw new Error('不支持的来源：' + source)
    }

    const name = (pkg && pkg.name) || pick.name
    const dirName = payloadDir || name
    if (!pkg || typeof pkg !== 'object') throw new Error('插件缺少 package.json：' + name)
    const license = licenseId(pkg)
    const allow = new Set((config?.licenseAllow || []).map((x) => String(x).toLowerCase()))
    let licenseState = 'ok'
    if (!license || /^unlicensed$/iu.test(license)) licenseState = 'missing'
    else if (!allow.has(license.toLowerCase())) licenseState = 'unlisted'
    // 只有真把代码打进包里才需要确认许可证；只记版本号的清单不转手代码。
    if (needPayload && licenseState !== 'ok' && !options.confirmLicense) {
      throw new Error(pick.name + '：license 为「' + (license || '未标注') + '」，不在允许列表。确认你有权再分发后再打包（需要显式勾选）。')
    }

    const entry = {
      name,
      version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
      requested,
      source,
      registry,
      tarball,
      integrity,
      license,
      repository: typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository && pkg.repository.url) || '',
      author: authorOf(pkg),
      files: files.length,
      size: files.reduce((sum, f) => sum + f.data.length, 0),
      hasClient: Boolean(pkg.dsh && pkg.dsh.client) || Boolean(pkg.exports && (pkg.exports['./client'] || pkg.exports['./client.js'])),
      hasPatch: Boolean(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch),
      isBundle: Boolean(pkg.dsh && (pkg.dsh.bundle || pkg.dsh.client)),
      localEdits,
      embedded,
      mode: localEdits ? 'local' : 'base',
      configMode: wantConfig ? 'custom' : 'preset',
      configIncluded: false,
      dataIncluded: false,
      peerDependencies: pkg.peerDependencies && typeof pkg.peerDependencies === 'object' ? pkg.peerDependencies : {},
      engines: pkg.engines && typeof pkg.engines === 'object' ? pkg.engines : {},
      dirName,
      // 按市场分组整体加入时记下组名：装到同样有插件市场的机器上会并进同名分组
      group: typeof pick.group === 'string' ? pick.group.trim().slice(0, 40) : '',
    }
    manifestPlugins.push(entry)
    depsOf.set(name, {
      ...(pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}),
      ...(pkg.optionalDependencies && typeof pkg.optionalDependencies === 'object' ? pkg.optionalDependencies : {}),
    })
    payload.push(...files.map((f) => ({ ...f, plugin: name })))
    tick('collect', 6 + 34 * (manifestPlugins.length / Math.max(1, selection.length)), '收集 ' + name + ' 的文件')
  }

  // 同一个包里若 A 依赖 B，B 就是 A 的内部组件：装 A 时会被一起装上，
  // 清单里标出 transitiveOf，安装侧（插件内与独立安装器）据此跳过 B，避免重复装两遍。
  const namesInPack = new Set(manifestPlugins.map((plugin) => plugin.name))
  for (const plugin of manifestPlugins) {
    if (plugin.transitiveOf) continue
    const deps = depsOf.get(plugin.name) || {}
    for (const dep of Object.keys(deps)) {
      if (dep === plugin.name || !namesInPack.has(dep)) continue
      const target = manifestPlugins.find((candidate) => candidate.name === dep)
      if (!target || target.transitiveOf) continue
      target.transitiveOf = plugin.name
      notes.push('「' + dep + '」是「' + plugin.name + '」的内部组件：装机时随父包一起装，不单独装一遍')
    }
  }

  // 配置与数据快照
  capturedFiles = []
  const configAllowed = format !== 'lite'
  if (configAllowed && options.includeConfig !== false && manifestPlugins.some((plugin) => plugin.configMode === 'custom')) {
    const { captured, notes: configNotes } = captureConfigs(context.patchText || '', manifestPlugins, context.parsePatch)
    notes.push(...configNotes)
    for (const plugin of manifestPlugins) {
      // 选了「插件预设」就只打插件默认配置，不抓本机配置与数据快照
      if (plugin.configMode !== 'custom') continue
      const snap = captured.get(plugin.name)
      if (snap && (snap.config !== null || snap.disabled !== undefined)) {
        const body = JSON.stringify({ id: snap.id, name: snap.name, disabled: snap.disabled, config: snap.config, ...(snap.configRedacted ? { configRedacted: snap.configRedacted } : {}), capturedAt: new Date().toISOString() }, null, 2)
        capturedFiles.push({ name: 'configs/' + plugin.name + '.json', data: Buffer.from(body, 'utf8') })
        plugin.configIncluded = true
        plugin.config = snap.config
        if (Array.isArray(snap.configRedacted) && snap.configRedacted.length > 0) plugin.configRedacted = snap.configRedacted
        if (snap.disabled) plugin.note = '打包时该插件被禁用'
      }
      const data = captureData(plugin.name, { maxBytes: 8 * 1024 * 1024 })
      if (data.redacted > 0) plugin.dataRedacted = (plugin.dataRedacted || 0) + data.redacted
      if (data.files.length > 0) {
        capturedFiles.push(...data.files)
        plugin.dataIncluded = true
        plugin.dataDirs = data.dirs
        notes.push(...data.notes)
      }
    }
  }

  // 先扫描，再决定要不要写盘。扫描是强制的：没有「关掉扫描」这条路，
  // 只有高风险默认阻断、显式 force 才继续（决定会写进清单 security.approvedRisk）。
  // 信任名单：插件市场目录里能查到的插件（options.trusted）视为市场发行版。
  // 这类插件的高危项不直接阻断，但必须由调用方 acknowledge 之后才出包。
  const trustedSet = new Set((Array.isArray(options.trusted) ? options.trusted : []).map((n) => String(n)))
  const dirToName = new Map()
  for (const plugin of manifestPlugins) if (plugin.dirName) dirToName.set(plugin.dirName, plugin.name)
  const dirOf = (file) => {
    const hit = /^plugins\/([^/]+)\//.exec(String(file || ''))
    return hit ? hit[1] : ''
  }

  tick('capture', 42, '抓取配置与数据快照')
  const scanTargets = [...payload, ...capturedFiles]
  tick('scan', 55, '扫描敏感信息与风险代码')
  scan = scanEntries(scanTargets.map((f) => ({ name: f.name, data: f.data })), { extraRules: scanRules })

  const highFindings = scan.findings.filter((f) => f.severity === 'high')
  const highFromUntrusted = highFindings.filter((f) => {
    const name = dirToName.get(dirOf(f.file))
    return !name || !trustedSet.has(name)
  })
  trustedOnly = highFindings.length > 0 && highFromUntrusted.length === 0
  // 高风险一律停在「等你点一下」：acknowledge 之后才出包，决定记进清单。
  // 市场目录能查到的（trustedOnly）与查不到的（含本机自己改的）走同一条路，
  // 只是提示措辞不同——这样界面上永远有「我知道在干什么」这个出口。
  if (config?.blockHighRisk !== false && highFindings.length > 0 && options.acknowledge !== true && options.force !== true) {
    const where = trustedOnly
      ? '均来自插件市场已收录的插件'
      : (highFromUntrusted.length === highFindings.length ? '来自本机插件，市场目录里查不到同名条目' : '有一部分来自本机插件（市场目录里查不到同名条目）')
    throw new PackRefused(
      '检出 ' + highFindings.length + ' 个高风险项（' + where + '）；确认了解风险后可继续打包',
      scan,
      {
        needsAck: true,
        trustedOnly,
        checkpoint: {
          payload,
          capturedFiles,
          manifestPlugins: JSON.parse(JSON.stringify(manifestPlugins)),
          notes: notes.slice(),
          scan,
          trustedOnly,
        },
      },
    )
  }
  }

  tick('scan', 66, '完成安全检测')
  const scanGroups = groupFindings(scan.findings, manifestPlugins)
  const manifestBase = {
    schema: SCHEMA,
    kind: KIND,
    format,
    id: 'mp_' + Date.now().toString(36) + '_' + shortHash(Buffer.from(String(Math.random()))),
    name: options.name || 'DSH 整合包',
    description: options.description || '',
    author: options.author || '',
    license: options.license || '',
    homepage: options.homepage || '',
    createdAt: new Date().toISOString(),
    generator: { name: 'dsh-modpack', version: context.pluginVersion || '0.0.0' },
    dshVersion: context.dshVersion || '',
    options: {
      includePayload: format === 'full' || payload.length > 0,
      strategy: format,
      includeConfig: manifestPlugins.some((plugin) => plugin.configMode === 'custom'),
      includeLocalEdits: manifestPlugins.some((plugin) => plugin.mode === 'local'),
      keepLocalOnInstall: options.keepLocal !== false,
    },
    plugins: manifestPlugins,
    files: [...payload, ...capturedFiles].map((f) => ({ path: f.name, sha256: sha256(f.data), size: f.data.length })),
    security: {
      scanned: true,
      high: scan.counts.high,
      medium: scan.counts.medium,
      low: scan.counts.low,
      approvedRisk: scan.findings.some((f) => f.severity === 'high'),
      acknowledged: options.acknowledge === true,
      trustedOnly,
      note: scan.note,
    },
    install: {
      restartRequired: true,
      notes: notes.slice(0, 30),
    },
    extensions: options.extensions || {},
  }

  const manifest = normalizeManifest(manifestBase)
  const manifestText = JSON.stringify(manifest, null, 2)
  const manifestBuf = Buffer.from(manifestText, 'utf8')

  const report = renderScanReport(manifest.name, scan, { approvedRisk: manifest.security.approvedRisk })
  const readme = buildReadme(manifest)

  tick('write', 78, '写入清单与安装器')
  const installScripts = [
    { name: 'install/install.mjs', data: stub('install-stub.mjs') },
    { name: 'install/install.cmd', data: stub('install-stub.cmd') },
    { name: 'install/install.sh', data: stub('install-stub.sh') },
  ]
  const entries = [
    { name: MANIFEST_NAME, data: manifestBuf },
    { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
    { name: 'security/report.txt', data: Buffer.from(report, 'utf8') },
    ...installScripts,
    ...(options.includePayload === false ? [] : payload),
    ...capturedFiles,
  ]

  const integrity = {
    generatedAt: new Date().toISOString(),
    algorithm: 'sha256',
    files: Object.fromEntries(entries.map((e) => [e.name, sha256(e.data)])),
  }
  entries.push({ name: 'integrity.json', data: Buffer.from(JSON.stringify(integrity, null, 2), 'utf8') })

  tick('write', 90, '压缩打包')
  const buffer = writeZip(entries)
  if (config?.maxPackBytes && buffer.length > config.maxPackBytes) {
    throw new Error('整合包体积 ' + buffer.length + ' 字节，超过上限 ' + config.maxPackBytes)
  }
  const stamp = new Date().toISOString().slice(0, 10)
  const fileName = slugify(manifest.name) + '-' + stamp + '-' + format + '.dshpack'
  tick('done', 100, '完成')
  return { buffer, fileName, manifest, scan, scanGroups, report, notes, size: buffer.length }
}
