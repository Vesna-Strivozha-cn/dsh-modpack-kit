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
import { scanEntries, renderScanReport, groupFindings } from './scan.mjs'
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
  dshHome,
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
  // 打包方已确认（市场收录插件的确认放行）时，不再用高风险拦人；报告照常列明细。
  const acknowledged = Boolean(manifest.security && (manifest.security.acknowledged === true || manifest.security.trustedOnly === true))
  if (scan.counts.high > 0 && !options.force && !acknowledged) {
    blockingReasons.push('安全检测发现 ' + scan.counts.high + ' 个高风险项')
  }
  if (scan.counts.high > 0 && acknowledged) {
    notes.push('打包方已确认 ' + scan.counts.high + ' 个高风险项（市场收录插件），明细见扫描报告')
  }

  // 界面要按来源（插件 / 配置 / 整合包本体）分栏展示，分组结果一并给出去
  const scanGroups = groupFindings(scan.findings, manifest.plugins)

  return { manifest, entries, integrity, scan, scanGroups, report, blockingReasons, notes }
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
  // profile 名必须跟着 profileDir 走：DSH 命令行只认 --profile <名字>，
  // 若拿 config.profile（桌面环境里恒为 desktop）去装，装进的是真 profile 而不是 targetDir。
  const targetName = path.basename(path.resolve(profileDir))
  const profile = targetName && targetName !== 'profiles' ? targetName : config.profile || 'desktop'
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
      deferred: [],
      lines,
      needsRestart: false,
    }
  }

  const touchedBundles = []
  const configItems = []
  const packRoot = packDirOf(config, manifest)
  // CLI 自己会把 bundle 登记进 profile；「装好先不启用」靠装完撤回列表实现，所以先记一份原始清单。
  const bundlesBefore = readBundles(readProfilePackage(profileDir))
  // 打包方已确认过风险的包，安装时不再因为 high 拦人（明细照样进报告）
  const acknowledged = Boolean(manifest.security && (manifest.security.acknowledged === true || manifest.security.trustedOnly === true))

  // 进度：和打包共用同一个进度窗（kind=install）
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  progress({ pct: 8, note: '检查本机已装的插件' })
  const only = Array.isArray(options.only) && options.only.length > 0 ? new Set(options.only.map(String)) : null
  // 默认「先跳过已装的，装完再问要不要换」；replaceExisting 时反过来，直接覆盖
  const deferExisting = options.replaceExisting === true ? false : options.deferExisting !== false
  const deferred = []
  const total = manifest.plugins.length
  let restartFromManager = false

  for (const plugin of manifest.plugins) {
    const index = manifest.plugins.indexOf(plugin)
    progress({ pct: 12 + Math.round(((index + 1) / total) * 68), note: '安装 ' + plugin.name + (plugin.version ? ' ' + plugin.version : '') })
    if (only && !only.has(plugin.name)) {
      actions.push({ plugin: plugin.name, action: 'skipped', ok: true, message: '这次不动它（你只选了替换其中几个）' })
      continue
    }
    const existing = installed.find((p) => p.name === plugin.name)
    if (existing && deferExisting) {
      // 同名或同插件不同版本都算已装：先跳过，其余照装，最后让你决定换不换
      deferred.push({ name: plugin.name, localVersion: existing.version || '', packVersion: plugin.version || '', sameVersion: String(existing.version || '') === String(plugin.version || '') })
      actions.push({ plugin: plugin.name, action: 'deferred', ok: true, message: '本机已装 ' + (existing.version || '（版本未知）') + '，先跳过；装完再问你换不换' })
      continue
    }
    const keepLocal = options.keepLocal !== false && config.keepLocal !== false && manifest.options.keepLocalOnInstall !== false
    if (existing && !deferExisting && keepLocal && options.replaceExisting !== true) {
      actions.push({ plugin: plugin.name, action: 'kept', ok: true, message: '本地已装 ' + existing.version + '，按“保留本地修改”跳过覆盖' })
      continue
    }

    // 联网且插件市场可用时，优先按市场版本装（用户要求：装整合包时优先同步市场版本）
    // 取不到 / 离线 / 关掉开关（options.preferMarket === false）时，按包内带来的那份装
    let marketHit = null
    if (options.preferMarket !== false && typeof context.resolveMarket === 'function') {
      try {
        marketHit = await context.resolveMarket(plugin)
      } catch (error) {
        lines.push('查不到市场版本（' + plugin.name + '）：' + String(error?.message || error) + '，按包内的来')
      }
    }

    let dir = null
    if (!marketHit) {
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
          if (deep.counts.high > 0 && !options.force && !acknowledged) {
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
    } else if (options.dryRun) {
      actions.push({ plugin: plugin.name, action: 'install', ok: true, message: '演练：将按市场版本安装 ' + marketHit.spec })
      continue
    }

    const targetSpec = marketHit ? marketHit.spec : 'file:' + dir
    // 优先交给 DSH 自带的插件管理器：pnpm、激活与「要不要重启」都由宿主判断，
    // 我们不再拼命令行，也就绕开了引号、编码、硬链接这些坑。拿不到服务时退回命令行。
    const installBundle = typeof context.installBundle === 'function' ? context.installBundle : null
    let code = 0
    let output = ''
    let application = ''
    let usedManager = false
    if (installBundle) {
      let change = null
      try {
        change = await installBundle(targetSpec, {
          enabled: options.enableBundles !== false,
          ...(marketHit && marketHit.version ? { expected: { name: plugin.name, version: marketHit.version } } : {}),
        })
      } catch (error) {
        // 管理器出错时不要让整次安装悬着：记一行，退回命令行再试一次。
        lines.push('插件管理器没能装成（' + String((error && error.message) || error) + '），改用命令行重试')
        change = null
      }
      if (change && change.application === 'failed') {
        const reason = change.error && change.error.code ? '（' + change.error.code + '）' : ''
        lines.push('插件管理器安装失败' + reason + '，改用命令行重试')
        change = null
      }
      if (change) {
        usedManager = true
        application = change.application ? String(change.application) : ''
        code = 0
        if (application === 'restart-required') restartFromManager = true
        const bits = []
        if (change.stage) bits.push('stage=' + change.stage)
        if (application) bits.push('application=' + application)
        if (change.error && change.error.code) bits.push('error=' + change.error.code)
        if (change.packageResult && change.packageResult.output) bits.push(String(change.packageResult.output))
        output = bits.join(' ')
      }
    }
    if (!usedManager) {
      const runCli = typeof context.runCli === 'function' ? context.runCli : runDshPlugin
      const result = await runCli(profile, ['plugin', '--profile', profile, 'add', targetSpec], {
        cwd: profileDir,
        onLine: (line) => { lines.push(line); onLine(line) },
      })
      code = result && typeof result.code === 'number' ? result.code : 1
      output = String((result && result.output) || '')
    }
    if (output) lines.push(output)
    appendLog('install ' + plugin.name + ' exit=' + code + ' via=' + (usedManager ? 'manager' : 'cli') + (marketHit ? '/market' : '/pack') + (application ? ' ' + application : ''))
    if (code !== 0) {
      actions.push({ plugin: plugin.name, action: 'install', ok: false, message: 'dsh plugin add 失败（退出码 ' + code + '），详见日志' })
      continue
    }
    if (plugin.isBundle && plugin.hasPatch) touchedBundles.push(plugin.name)
    actions.push({
      plugin: plugin.name,
      action: 'install',
      ok: true,
      source: marketHit ? 'market' : 'pack',
      message: marketHit ? ('已按市场版本安装 ' + marketHit.spec) : ('已装 ' + (plugin.version || '')),
    })
  }

  progress({ pct: 84, note: '登记启用清单' })
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

  progress({ pct: 92, note: '回填包内配置' })
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
      // 打包时被擦掉的凭据只剩占位符，明确要求重填，避免装完才发现认证失败
      const redacted = Array.isArray(snapConfig.configRedacted) ? snapConfig.configRedacted : []
      if (redacted.length > 0) {
        lines.push('配置 ' + plugin.name + ' 有 ' + redacted.length + ' 处凭据已替换为 ${REDACTED}，需自行重填：' + redacted.slice(0, 6).join(', ') + (redacted.length > 6 ? ' 等' : ''))
      }
      actions.push({ plugin: plugin.name, action: 'config', ok: true, message: (result.action === 'replaced' ? '已对齐配置' : '已补上配置条目') })
    }
    if (text !== patch && !options.dryRun) {
      const backup = writePatch(profileDir, text)
      lines.push('配置层已更新，备份：' + backup)
    }
  }

  // 数据快照回填：插件自己写在 ~/.dsh/<目录>/ 下的文本数据（记忆、词库、笔记…）。
  // 默认只补缺、不覆盖本机已有文件——避免装个包把人家攒的东西冲掉。
  if (manifest.options.includeConfig !== false) {
    const home = dshHome()
    const written = []
    const kept = []
    for (const plugin of manifest.plugins) {
      const dirs = Array.isArray(plugin.dataDirs) ? plugin.dataDirs : []
      if (!plugin.dataIncluded || dirs.length === 0) continue
      for (const base of dirs) {
        const prefix = 'data/' + base + '/'
        const baseDir = path.resolve(home, base)
        for (const entry of entries) {
          if (!entry.name.startsWith(prefix)) continue
          const rel = entry.name.slice(prefix.length)
          const target = path.resolve(baseDir, rel)
          if (target !== baseDir && !target.startsWith(baseDir + path.sep)) continue
          if (options.dryRun) {
            lines.push('演练：将写回数据 ' + base + '/' + rel)
            continue
          }
          if (fs.existsSync(target) && options.overwriteData !== true) {
            kept.push(base + '/' + rel)
            continue
          }
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, entry.data)
          written.push(base + '/' + rel)
        }
      }
    }
    for (const plugin of manifest.plugins) {
      if (plugin.dataRedacted > 0) {
        lines.push('数据快照 ' + plugin.name + ' 有 ' + plugin.dataRedacted + ' 处凭据已替换为 ${REDACTED}，相关功能可能需要重填凭据')
      }
    }
    if (written.length > 0) {
      lines.push('数据快照已写回 ' + written.length + ' 个文件：' + written.slice(0, 6).join(', ') + (written.length > 6 ? ' 等' : ''))
      actions.push({ plugin: '', action: 'data', ok: true, message: '数据快照写回 ' + written.length + ' 个文件' })
    }
    if (kept.length > 0) {
      lines.push('有 ' + kept.length + ' 个数据文件本机已有，未覆盖（需要覆盖就重新装一次并选择覆盖数据）')
      actions.push({ plugin: '', action: 'data', ok: true, message: '本机已存在、未覆盖 ' + kept.length + ' 个数据文件' })
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

  progress({ pct: 100, note: '安装完成' })
  return {
    ok,
    compat,
    actions,
    deferred,
    configItems,
    lines,
    needsRestart: options.enableBundles === false ? false : (restartFromManager || actions.some((a) => a.action === 'install' && a.ok)),
  }
}

export { patchPath }
