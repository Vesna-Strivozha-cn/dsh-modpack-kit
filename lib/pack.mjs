/**
 * dsh-modpack —— 打包。
 *
 * 两个版本：
 *   full  完整版：插件本体一起装进 zip，没装 dsh-modpack 的人解压也能按 README 手工装；
 *   lite  轻量版：只有清单和来源，必须由 dsh-modpack 联网按版本取包。
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
    prefix: 'plugins/' + installed.dirName + '/',
    maxFileBytes: options.maxFileBytes,
    maxTotalBytes: options.maxTotalBytes,
  })
  return { files, notes, pkg: installed.pkg }
}

/**
 * 抓 profile 补丁层里的配置（每个插件一条）。
 * 解析失败就整体放弃自动抓取，只留一句 note——宁可少带，也不带错。
 */
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
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const name = typeof item.name === 'string' ? item.name : ''
    const id = typeof item.id === 'string' ? item.id : ''
    const hit = byName.get(name) || byName.get(id)
    if (!hit) continue
    captured.set(hit.name, { id: item.id, name: item.name, disabled: item.disabled === true ? true : undefined, config: item.config ?? null })
  }
  return { captured, notes }
}

function dataDirsFor(name) {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
  const candidates = [name, name.replace(/^dsh-/u, '')].filter(Boolean)
  const out = []
  for (const candidate of candidates) {
    const dir = path.join(home, candidate)
    try {
      if (fs.statSync(dir).isDirectory()) out.push({ dir, prefix: 'data/' + name + '/' })
    } catch {}
  }
  return out
}

/** 插件数据快照：只收小体积文本类，凭证类文件名直接跳过。 */
export function captureData(name, options = {}) {
  const files = []
  const notes = []
  let total = 0
  const limit = options.maxBytes ?? 8 * 1024 * 1024
  for (const { dir, prefix } of dataDirsFor(name)) {
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
    for (const entry of entries) {
      try { files.push({ name: entry.name, data: fs.readFileSync(entry.abs), mtime: new Date() }) } catch {}
    }
  }
  return { files, notes }
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
  let capturedFiles = []
  let scan = null
  let trustedOnly = false
  const scanRules = context.extraScanRules || []
  const format = options.includePayload === false ? 'lite' : 'full'
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
    let localEdits = false
    let payloadDir = ''
    // 每个插件可以单独选：base = 上游原版 + 插件基础配置；local = 连本机改动一起打
    const wantLocal = pick.mode === 'local' ? true : pick.mode === 'base' ? false : options.includeLocalEdits === true

    if (source === 'profile') {
      const installed = context.installed.find((p) => p.name === pick.name)
      if (!installed) throw new Error('本地找不到插件：' + pick.name)
      const loaded = readInstalledPlugin(installed, { maxFileBytes: config?.maxFileBytes, maxTotalBytes: config?.maxPackBytes })
      files = loaded.files
      pkg = loaded.pkg
      notes.push(...loaded.notes)
      payloadDir = installed.dirName || installed.name
      localEdits = true
      if (!wantLocal && typeof pick.download === 'function') {
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
      if (typeof pick.download !== 'function') throw new Error('缺少下载器')
      const downloaded = await pick.download(requested)
      pkg = downloaded.pkg
      registry = downloaded.registry
      tarball = downloaded.tarball
      integrity = downloaded.integrity
      const dirName = pkg.name
      payloadDir = dirName
      files = downloaded.entries.map((e) => ({ name: 'plugins/' + dirName + '/' + e.name, data: e.data }))
      localEdits = false
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
    if (licenseState !== 'ok' && !options.confirmLicense) {
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
      mode: localEdits ? 'local' : 'base',
      configIncluded: false,
      dataIncluded: false,
      peerDependencies: pkg.peerDependencies && typeof pkg.peerDependencies === 'object' ? pkg.peerDependencies : {},
      engines: pkg.engines && typeof pkg.engines === 'object' ? pkg.engines : {},
      dirName,
    }
    manifestPlugins.push(entry)
    payload.push(...files.map((f) => ({ ...f, plugin: name })))
    tick('collect', 6 + 34 * (manifestPlugins.length / Math.max(1, selection.length)), '收集 ' + name + ' 的文件')
  }

  // 配置与数据快照
  capturedFiles = []
  if (options.includeConfig) {
    const { captured, notes: configNotes } = captureConfigs(context.patchText || '', manifestPlugins, context.parsePatch)
    notes.push(...configNotes)
    for (const plugin of manifestPlugins) {
      // 选了「基础配置」就没有本地改动可打
      if (plugin.mode === 'base') continue
      const snap = captured.get(plugin.name)
      if (snap && (snap.config !== null || snap.disabled !== undefined)) {
        const body = JSON.stringify({ id: snap.id, name: snap.name, disabled: snap.disabled, config: snap.config, capturedAt: new Date().toISOString() }, null, 2)
        capturedFiles.push({ name: 'configs/' + plugin.name + '.json', data: Buffer.from(body, 'utf8') })
        plugin.configIncluded = true
        plugin.config = snap.config
        if (snap.disabled) plugin.note = '打包时该插件被禁用'
      }
      const data = captureData(plugin.name, { maxBytes: 8 * 1024 * 1024 })
      if (data.files.length > 0) {
        capturedFiles.push(...data.files)
        plugin.dataIncluded = true
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
      includePayload: format === 'full',
      includeConfig: Boolean(options.includeConfig),
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
