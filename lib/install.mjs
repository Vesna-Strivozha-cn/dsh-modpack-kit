/**
 * dsh-modpack —— 读包 / 检测 / 安装。
 *
 * 安装只有一条腿：调用官方 `dsh plugin add file:<目录>`。整合包不自己写 node_modules，
 * 也不自己改 pnpm 锁——那样迟早和插件市场打架。本模块负责的是它前面那一步：
 * 解出文件、校验完整性、扫一遍风险、判断兼容、再把配置补回去。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readZip, readZipText, safeEntryName } from './zip.mjs'
import { scanEntries, renderScanReport } from './scan.mjs'
import { MANIFEST_NAME, normalizeManifest, sha256 } from './manifest.mjs'
import { checkCompatibility } from './compat.mjs'
import { captureConfigs, collectFiles } from './pack.mjs'
import { upsertPatchItem, parseYaml } from './yamlish.mjs'
import {
  ensureDir,
  writeJsonAtomic,
  appendLog,
  pathsFor,
  slugify,
} from './store.mjs'
import {
  ensureBundles,
  setBundles,
  readBundles,
  readProfilePackage,
  listInstalled,
  dshVersion,
  patchPath,
  readPatch,
  writePatch,
  runDshPlugin,
} from './profile.mjs'

export class InstallRefused extends Error {
  constructor(message, scan) {
    super(message)
    this.name = 'InstallRefused'
    this.scan = scan
  }
}

const META_ENTRIES = new Set([MANIFEST_NAME, 'README.txt', 'integrity.json'])
const isMeta = (name) => META_ENTRIES.has(name) || name.startsWith('security/')

/**
 * 在内存里检查一个包：解 zip → 找清单 → 校验完整性 → 扫描。
 * 不写任何东西；调用方拿到结果后再决定要不要装。
 */
export function inspectPackBuffer(buffer, options = {}) {
  const config = options.config || {}
  const notes = []
  const entries = readZip(buffer, {
    maxEntryBytes: config.maxFileBytes ?? 16 * 1024 * 1024,
    maxTotalBytes: config.maxPackBytes ?? 256 * 1024 * 1024,
  })

  const manifestText = readZipText(entries, MANIFEST_NAME)
  if (!manifestText) throw new Error('这个文件不是 DSH 整合包：缺少 ' + MANIFEST_NAME)
  let raw
  try {
    raw = JSON.parse(manifestText)
  } catch (error) {
    throw new Error('清单无法解析：' + String(error?.message || error))
  }
  const manifest = normalizeManifest(raw)

  const integrity = { present: false, ok: true, mismatches: [], missing: [] }
  const integrityText = readZipText(entries, 'integrity.json')
  if (integrityText) {
    integrity.present = true
    try {
      const record = JSON.parse(integrityText)
      const files = record && typeof record.files === 'object' ? record.files : {}
      const present = new Map(entries.map((e) => [e.name, e]))
      for (const [name, expected] of Object.entries(files)) {
        const entry = present.get(name)
        if (!entry) { integrity.missing.push(name); continue }
        const actual = sha256(entry.data)
        if (actual !== expected) integrity.mismatches.push(name)
      }
      integrity.ok = integrity.mismatches.length === 0 && integrity.missing.length === 0
    } catch (error) {
      integrity.present = true
      integrity.ok = false
      notes.push('integrity.json 解析失败：' + String(error?.message || error))
    }
  } else {
    integrity.present = false
    integrity.ok = false
    notes.push('包内没有 integrity.json，无法确认文件没被改过（已阻止安装；来源可信时可用「强制」跳过）')
  }

  const payload = entries.filter((e) => !isMeta(e.name))
  const scan = options.scanBeforeInstall === false
    ? { findings: [], counts: { high: 0, medium: 0, low: 0 }, scannedFiles: 0, scannedBytes: 0, skipped: [], redacted: true, note: '未执行扫描（调用方关闭）' }
    : scanEntries(payload.map((e) => ({ name: e.name, data: e.data })), { extraRules: options.extraScanRules })
  const report = renderScanReport(manifest.name, scan, { approvedRisk: Boolean(options.force) })

  const blockingReasons = []
  if (!integrity.present && !options.force) {
    blockingReasons.push('包里没有 integrity.json，无法确认文件没被改过')
  }
  if (integrity.present && !integrity.ok) {
    blockingReasons.push('完整性校验失败（' + (integrity.mismatches.length + integrity.missing.length) + ' 个文件对不上）')
  }
  if (scan.counts.high > 0 && !options.force) {
    blockingReasons.push('安全检测发现 ' + scan.counts.high + ' 个高风险项')
  }

  return { manifest, entries, integrity, scan, report, blockingReasons, notes }
}

/** 从链接读取整合包（只允许 https 与白名单域名）。 */
export async function readPackFromUrl(url, config, fetchLimitedFn) {
  const buffer = await fetchLimitedFn(url, config, {
    maxBytes: config.maxDownloadBytes ?? 128 * 1024 * 1024,
    accept: 'application/octet-stream, application/zip, */*',
  })
  return buffer
}

function pluginPayload(entries, dirName) {
  const prefix = 'plugins/' + dirName + '/'
  return entries.filter((e) => e.name.startsWith(prefix))
}

/**
 * 把某个插件的文件释放到 vendor 目录，返回可交给 `dsh plugin add file:` 的目录。
 * 目录名带包 id，避免不同整合包互相覆盖。
 */
export function materializePayload(entries, manifest, plugin, config) {
  const base = pathsFor(config).vendor
  const packDir = path.join(base, slugify(manifest.id || manifest.name || 'pack', 'pack'))
  const target = path.join(packDir, 'plugins', plugin.dirName || plugin.name)
  const files = pluginPayload(entries, plugin.dirName || plugin.name)
  if (files.length === 0) throw new Error(plugin.name + '：包里没有它的文件（轻量版需要用网络取）')
  // 重装时旧文件必须清掉：pnpm 会把目录里的一切都装进去，残留文件会让新版本带上旧代码
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {}
  ensureDir(target)
  for (const entry of files) {
    const rel = entry.name.slice(('plugins/' + (plugin.dirName || plugin.name) + '/').length)
    const safeRel = safeEntryName(rel)
    const dest = path.join(target, safeRel)
    const resolved = path.resolve(dest)
    if (!resolved.startsWith(path.resolve(target) + path.sep) && resolved !== path.resolve(target)) {
      throw new Error('包内路径逃逸：' + entry.name)
    }
    ensureDir(path.dirname(resolved))
    fs.writeFileSync(resolved, entry.data)
  }
  return target
}

function packDirOf(config, manifest) {
  return path.join(pathsFor(config).vendor, slugify(manifest.id || manifest.name || 'pack', 'pack'))
}

/**
 * 安装整合包。
 * @param {object} input
 * @param {object} input.manifest
 * @param {object[]} input.entries
 * @param {object} input.config
 * @param {object} input.options {force, keepLocal, applyConfig, dryRun}
 * @param {object} input.context {profileDir, onLine}
 */
export async function installPack(input) {
  const { manifest, entries, config, options = {}, context = {} } = input
  const profileDir = context.profileDir || pathsFor(config).profile
  const profile = config.profile || 'desktop'
  const installed = listInstalled(profileDir)
  const compat = checkCompatibility(manifest.plugins, {
    installed,
    dshVersion: dshVersion(profileDir),
    nodeVersion: process.versions.node,
    config,
  })

  const actions = []
  const lines = []
  const onLine = typeof context.onLine === 'function' ? context.onLine : () => {}

  if (compat.blocking && !options.force) {
    return {
      ok: false,
      refused: true,
      reason: '兼容性检测有 ' + compat.counts.error + ' 个阻断问题',
      compat,
      actions,
      lines,
      needsRestart: false,
    }
  }

  const touchedBundles = []
  const configItems = []
  const packRoot = packDirOf(config, manifest)
  // CLI 自己会把 bundle 登记进 profile；「装好先不启用」靠装完撤回列表实现，所以先记一份原始清单。
  const bundlesBefore = readBundles(readProfilePackage(profileDir))

  for (const plugin of manifest.plugins) {
    const existing = installed.find((p) => p.name === plugin.name)
    const keepLocal = options.keepLocal !== false && config.keepLocal !== false && manifest.options.keepLocalOnInstall !== false
    if (existing && keepLocal) {
      actions.push({ plugin: plugin.name, action: 'kept', ok: true, message: '本地已装 ' + existing.version + '，按“保留本地修改”跳过覆盖' })
      continue
    }

    let dir = null
    if (manifest.format === 'full' && pluginPayload(entries, plugin.dirName || plugin.name).length > 0) {
      try {
        dir = materializePayload(entries, manifest, plugin, config)
      } catch (error) {
        actions.push({ plugin: plugin.name, action: 'install', ok: false, message: String(error?.message || error) })
        continue
      }
    } else if (typeof context.resolveSource === 'function') {
      try {
        dir = await context.resolveSource(plugin, packRoot)
      } catch (error) {
        actions.push({ plugin: plugin.name, action: 'install', ok: false, message: '取包失败：' + String(error?.message || error) })
        continue
      }
    } else {
      actions.push({ plugin: plugin.name, action: 'install', ok: false, message: '轻量包需要在联网环境下解析来源' })
      continue
    }

    if (manifest.format !== 'full') {
      // 轻量包本体不夹带源码，真正的代码是刚下载回来的：装之前必须补扫一遍，否则「安装前检测」是空转
      try {
        const brought = collectFiles(dir, {
          prefix: '',
          maxFileBytes: config.maxFileBytes ?? 16 * 1024 * 1024,
          maxTotalBytes: 64 * 1024 * 1024,
        })
        const deep = scanEntries(brought.files, { extraRules: Array.isArray(config.extraScanRules) ? config.extraScanRules : [] })
        if (deep.counts.high > 0 && !options.force) {
          actions.push({ plugin: plugin.name, action: 'install', ok: false, message: '从市场取回的代码里有 ' + deep.counts.high + ' 个高风险项，已拦下' })
          continue
        }
        lines.push('轻量包：已补扫从市场取回的 ' + deep.scannedFiles + ' 个文件（高 ' + deep.counts.high + '）')
      } catch (error) {
        actions.push({ plugin: plugin.name, action: 'install', ok: false, message: '补充扫描失败：' + String(error?.message || error) })
        continue
      }
    }

    if (options.dryRun) {
      actions.push({ plugin: plugin.name, action: 'install', ok: true, message: '演练：将添加 ' + dir })
      continue
    }

    const runCli = typeof context.runCli === 'function' ? context.runCli : runDshPlugin
    const result = await runCli(profile, ['plugin', '--profile', profile, 'add', 'file:' + dir], {
      cwd: profileDir,
      onLine: (line) => { lines.push(line); onLine(line) },
    })
    appendLog('install ' + plugin.name + ' exit=' + result.code)
    if (result.code !== 0) {
      actions.push({ plugin: plugin.name, action: 'install', ok: false, message: 'dsh plugin add 失败（退出码 ' + result.code + '），详见日志' })
      continue
    }
    if (plugin.isBundle && plugin.hasPatch) touchedBundles.push(plugin.name)
    actions.push({ plugin: plugin.name, action: 'install', ok: true, message: '已装 ' + (plugin.version || '') })
  }

  if (!options.dryRun) {
    const before = bundlesBefore
    const after = readBundles(readProfilePackage(profileDir))
    if (options.enableBundles === false) {
      // 沙箱/试验场景：文件与依赖都装好，但不登记 bundle —— 重启也不会加载。
      if (after.length !== before.length || after.some((x) => !before.includes(x))) {
        const restored = setBundles(profileDir, before)
        if (restored) lines.push('按设置未启用：已把 bundle 清单撤回原样（' + touchedBundles.join(', ') + ' 装了但不加载）')
      } else {
        lines.push('按设置未启用：' + (touchedBundles.join(', ') || '本次插件') + ' 没有登记 bundle，重启也不会加载')
      }
    } else if (touchedBundles.length > 0) {
      const ensured = ensureBundles(profileDir, touchedBundles)
      if (ensured.changed) lines.push('已登记 bundle：' + ensured.added.join(', ') + '（原清单备份 ' + ensured.backup + '）')
    }
  }

  // 配置回填：只改目标条目，其它字节不动
  if (options.applyConfig !== false && manifest.options.includeConfig) {
    const patch = readPatch(profileDir)
    let text = patch
    for (const plugin of manifest.plugins) {
      const snap = manifest.plugins.find((p) => p.name === plugin.name && p.configIncluded)
      if (!snap) continue
      if (options.keepLocal !== false && config.keepLocal !== false) {
        const captured = captureConfigs(text, [snap], (t) => parseYaml(t)).captured
        if (captured.size > 0) {
          actions.push({ plugin: plugin.name, action: 'config', ok: true, message: '本地已有配置，按“保留本地”不覆盖' })
          continue
        }
      }
      const entry = entries.find((e) => e.name === 'configs/' + plugin.name + '.json')
      if (!entry) continue
      let snapConfig
      try { snapConfig = JSON.parse(entry.data.toString('utf8')) } catch { continue }
      const result = upsertPatchItem(text, {
        id: snapConfig.id || plugin.name,
        name: snapConfig.name || plugin.name,
        config: snapConfig.config ?? null,
        disabled: snapConfig.disabled,
      })
      text = result.text
      configItems.push({ plugin: plugin.name, action: result.action })
      actions.push({ plugin: plugin.name, action: 'config', ok: true, message: (result.action === 'replaced' ? '已对齐配置' : '已补上配置条目') })
    }
    if (text !== patch && !options.dryRun) {
      const backup = writePatch(profileDir, text)
      lines.push('配置层已更新，备份：' + backup)
    }
  }

  const ok = actions.every((a) => a.ok)
  const record = {
    at: new Date().toISOString(),
    kind: 'install',
    pack: manifest.name,
    id: manifest.id,
    format: manifest.format,
    ok,
    actions,
    configItems,
  }
  if (!options.dryRun) writeJsonAtomic(path.join(packRoot, 'install-result.json'), record)

  return {
    ok,
    compat,
    actions,
    configItems,
    lines,
    needsRestart: options.enableBundles === false ? false : actions.some((a) => a.action === 'install' && a.ok),
  }
}

export { patchPath }
