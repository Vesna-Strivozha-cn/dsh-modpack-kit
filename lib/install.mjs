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
import { applyMarketGroups, hasMarket } from './groups.mjs'
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
  // 装一个规格：先交给宿主的插件管理器（pnpm/激活/重启判定都归它），拿不到服务或它报错时退回命令行。
  // 三条路径（正常、registry 失败退回包内、轻量包退回临时目录）都走这一个函数，省得三处各写一遍。
  const installBundle = typeof context.installBundle === 'function' ? context.installBundle : null
  const runCli = typeof context.runCli === 'function' ? context.runCli : runDshPlugin
  const installSpec = async (spec, expected) => {
    if (installBundle) {
      let change = null
      try {
        change = await installBundle(spec, { enabled: options.enableBundles !== false, ...(expected ? { expected } : {}) })
      } catch (error) {
        lines.push('插件管理器没能装成（' + String((error && error.message) || error) + '），改用命令行重试')
      }
      if (change && change.application === 'failed') {
        const reason = change.error && change.error.code ? '（' + change.error.code + '）' : ''
        lines.push('插件管理器安装失败' + reason + '，改用命令行重试')
        change = null
      }
      if (change) {
        const bits = []
        if (change.stage) bits.push('stage=' + change.stage)
        if (change.application) bits.push('application=' + change.application)
        if (change.error && change.error.code) bits.push('error=' + change.error.code)
        if (change.packageResult && change.packageResult.output) bits.push(String(change.packageResult.output))
        return { code: 0, application: change.application ? String(change.application) : '', manager: true, output: bits.join(' ') }
      }
    }
    const result = await runCli(profile, ['plugin', '--profile', profile, 'add', spec], {
      cwd: profileDir,
      onLine: (line) => { lines.push(line); onLine(line) },
    })
    return { code: result && typeof result.code === 'number' ? result.code : 1, application: '', manager: false, output: String((result && result.output) || '') }
  }
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
    if (plugin.transitiveOf) {
      // 同一个包里父包会把它带进来，单独装一遍会重复
      actions.push({ plugin: plugin.name, action: 'skipped', ok: true, message: '是「' + plugin.transitiveOf + '」的内部组件，随父包一起安装' })
      lines.push('跳过单独安装：' + plugin.name + ' 是「' + plugin.transitiveOf + '」的内部组件，会随父包一起装上')
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
    // 取不到 / 离线 / 关掉开关（options.preferMarket === false）时，按包内带来的那份装。
    // 例外：包里这份当初就是从插件市场取的（source npm/market），无论开关如何都优先走市场，
    // 因为包内那份只是同一份市场包的副本；市场取不到再退回包内副本。
    const fromMarketSource = plugin.source === 'npm' || plugin.source === 'market'
    let marketHit = null
    // 包里这份本来就是从 registry 取的（source npm/market）时，版本号已经记在清单里，
    // 不必再问一次 registry：直接按 name@version 装，插件市场才会把它记成市场版
    // （profile 的依赖写成 file: 时，市场一律显示成「本地」）。
    if (fromMarketSource && plugin.version && String(plugin.version) !== '0.0.0' && /^[0-9][0-9A-Za-z.+-]*$/u.test(String(plugin.version))) {
      marketHit = { spec: plugin.name + '@' + plugin.version, version: String(plugin.version), fromPack: true }
    }
    if (!marketHit && (options.preferMarket !== false || fromMarketSource) && typeof context.resolveMarket === 'function') {
      try {
        marketHit = await context.resolveMarket(plugin)
      } catch (error) {
        lines.push('查不到市场版本（' + plugin.name + '）：' + String(error?.message || error) + '，按包内的来')
      }
      if (!marketHit && fromMarketSource) lines.push('「' + plugin.name + '」是按市场版打包的，但这次没取到市场版本，改用包内自带的副本')
    }

    let dir = null
    // 这个插件的代码是不是就装在包里（完整包全部是；混合包只有「没有确定版本 / 要带本机改动」的那几个是）
    let embedded = false
    // 轻量包的代码是刚从 registry 取回来的，装的时候直接用 name@version：
    // 用 file: 指向临时目录的话，临时目录一删就断，插件市场也会当成「本地安装」。
    let resolvedSpec = null
    // 轻量包在内存里扫：把 tarball 解出来的条目直接交给扫描器，
    // 不再先落一份到临时目录再扫（少一次磁盘写、也不会有残留要清）。
    let memoryEntries = null
    if (!marketHit) {
      if (pluginPayload(entries, plugin.dirName || plugin.name).length > 0) {
        try {
          dir = materializePayload(entries, manifest, plugin, config)
          embedded = true
        } catch (error) {
          actions.push({ plugin: plugin.name, action: 'install', ok: false, message: String(error?.message || error) })
          continue
        }
      } else if (typeof context.resolveSourceEntries === 'function') {
        try {
          memoryEntries = await context.resolveSourceEntries(plugin)
          if (!Array.isArray(memoryEntries) || memoryEntries.length === 0) throw new Error('取回来的包里没有文件')
        } catch (error) {
          actions.push({ plugin: plugin.name, action: 'install', ok: false, message: '取包失败：' + String(error?.message || error) })
          continue
        }
        if (plugin.version && String(plugin.version) !== '0.0.0') resolvedSpec = plugin.name + '@' + plugin.version
        // 轻量包本体不夹带源码，真正的代码是刚取回来的：装之前必须补扫一遍，否则「安装前检测」是空转
        try {
          const deep = scanEntries(memoryEntries, { extraRules: Array.isArray(config.extraScanRules) ? config.extraScanRules : [] })
          if (deep.counts.high > 0 && !options.force && !acknowledged) {
            actions.push({ plugin: plugin.name, action: 'install', ok: false, message: '从市场取回的代码里有 ' + deep.counts.high + ' 个高风险项，已拦下' })
            continue
          }
          lines.push('轻量包：已补扫从市场取回的 ' + deep.scannedFiles + ' 个文件（高 ' + deep.counts.high + '，全程在内存里，没有落盘）')
        } catch (error) {
          actions.push({ plugin: plugin.name, action: 'install', ok: false, message: '补充扫描失败：' + String(error?.message || error) })
          continue
        }
        if (options.dryRun) {
          actions.push({ plugin: plugin.name, action: 'install', ok: true, message: '演练：将按 ' + (resolvedSpec || plugin.name) + ' 从市场安装（已内存扫描 ' + memoryEntries.length + ' 个文件）' })
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

      if (!embedded) {
        if (!resolvedSpec && plugin.version && String(plugin.version) !== '0.0.0') resolvedSpec = plugin.name + '@' + plugin.version
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

    // 完整包默认先按「名字@版本」从市场装：能联网且版本存在时，profile 依赖会写成 ^版本，
    // 插件市场据此认成「市场版」（方案 A）。失败或离线才退回包内副本（file:，市场显示本地安装）。
    let preferMarketSpec = null
    if (!marketHit && embedded && options.preferMarketOnInstall !== false && options.preferMarket !== false && dir && plugin.version && String(plugin.version) !== '0.0.0' && /^[0-9][0-9A-Za-z.+-]*$/u.test(String(plugin.version))) {
      preferMarketSpec = plugin.name + '@' + String(plugin.version)
    }
    const targetSpec = marketHit ? marketHit.spec : preferMarketSpec || resolvedSpec || 'file:' + dir
    let attempt = await installSpec(targetSpec, marketHit && marketHit.version ? { name: plugin.name, version: marketHit.version } : null)
    let code = attempt.code
    let application = attempt.application
    let usedManager = attempt.manager
    if (application === 'restart-required') restartFromManager = true
    if (attempt.output) lines.push(attempt.output)
    appendLog('install ' + plugin.name + ' exit=' + code + ' via=' + (usedManager ? 'manager' : 'cli') + (marketHit ? '/market' : '/pack') + (application ? ' ' + application : ''))

    // registry 这条路断了时，退回包里/本地已有的那份——能装上比装不上强，但依赖会写成 file:，
    // 插件市场会把它当成本地安装，所以下面要明确提示。
    if (code !== 0 && marketHit && marketHit.fromPack && !dir && pluginPayload(entries, plugin.dirName || plugin.name).length > 0) {
      try {
        dir = materializePayload(entries, manifest, plugin, config)
      } catch (error) {
        lines.push('退回包内副本也失败了：' + String(error?.message || error))
      }
      if (dir) {
        appendLog('install ' + plugin.name + ' market failed exit=' + code + ' retry=pack')
        lines.push('按 ' + marketHit.spec + ' 装失败（退出码 ' + code + '），改用包内自带的那份重试')
        marketHit = null
        attempt = await installSpec('file:' + dir, null)
        code = attempt.code
        usedManager = attempt.manager
        application = attempt.application
        if (application === 'restart-required') restartFromManager = true
      }
    }
    if (code !== 0 && preferMarketSpec && dir) {
      appendLog('install ' + plugin.name + ' market failed exit=' + code + ' retry=pack')
      lines.push('按 ' + preferMarketSpec + ' 没装成（退出码 ' + code + '），改用包内自带的那份继续（插件市场会显示成本地安装）')
      attempt = await installSpec('file:' + dir, null)
      code = attempt.code
      usedManager = attempt.manager
      application = attempt.application
      if (application === 'restart-required') restartFromManager = true
      preferMarketSpec = null
    }
    if (code !== 0 && resolvedSpec && dir) {
      appendLog('install ' + plugin.name + ' market failed exit=' + code + ' retry=file')
      lines.push('按 ' + resolvedSpec + ' 装失败（退出码 ' + code + '），改用本地已下载的副本重试')
      attempt = await installSpec('file:' + dir, null)
      code = attempt.code
      usedManager = attempt.manager
      application = attempt.application
      if (application === 'restart-required') restartFromManager = true
    }
    if (code !== 0) {
      actions.push({ plugin: plugin.name, action: 'install', ok: false, message: 'dsh plugin add 失败（退出码 ' + code + '），详见日志' })
      continue
    }
    if (!marketHit && fromMarketSource) {
      // 走到这里说明装的是包内副本（依赖会写成 file:），插件市场会把它显示成「本地」
      lines.push('注意：' + plugin.name + ' 这次是装包内副本，profile 里的依赖是 file: 路径，插件市场会把它显示成本地安装')
    }
    if (marketHit && plugin.localEdits) {
      // 身份与内容都要：依赖写成 名字@版本（插件市场认它是市场版，不是本地开发版），
      // 再把包里带来的本地改动覆盖到装好的那份上——否则本机版的改动就丢了。
      const installName = plugin.dirName || plugin.name
      const prefix = 'plugins/' + installName + '/'
      const payloadEntries = entries.filter((entry) => entry.name.startsWith(prefix))
      if (payloadEntries.length > 0) {
        const installDir = path.join(profileDir, 'node_modules', installName)
        let overlayed = 0
        let failed = 0
        for (const entry of payloadEntries) {
          const rel = entry.name.slice(prefix.length)
          if (!rel) continue
          const target = path.join(installDir, rel)
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.writeFileSync(target, entry.data)
            overlayed += 1
          } catch {
            failed += 1
          }
        }
        lines.push('「' + plugin.name + '」按市场版安装（依赖是 ' + marketHit.spec + '，插件市场认它作市场版），并把包内的本地改动覆盖上去（' + overlayed + ' 个文件' + (failed ? '，' + failed + ' 个写不进去' : '') + '）')
      }
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
      const perPlugin = options.configChoice && typeof options.configChoice === 'object' ? options.configChoice[plugin.name] : undefined
      if (perPlugin === 'local') {
        actions.push({ plugin: plugin.name, action: 'config', ok: true, message: '按你的选择：这个插件保持本机配置，不覆盖' })
        continue
      }
      if (perPlugin === 'pack') {
        // 明确要求用包内配置：跳过「保留本地」的判断
      }
      if (!snap) continue
      if (perPlugin !== 'pack' && options.keepLocal !== false && config.keepLocal !== false) {
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

  // 分组：按市场分组整体打包的插件，装到同样装了插件市场的机器上时，
  // 并进同名分组（只加成员，不动已有的其它分组与顺序）。
  const groupAdds = new Map()
  for (const plugin of manifest.plugins) {
    if (!plugin.group || plugin.transitiveOf) continue
    if (!groupAdds.has(plugin.group)) groupAdds.set(plugin.group, [])
    groupAdds.get(plugin.group).push(plugin.name)
  }
  if (groupAdds.size > 0 && options.syncGroups !== false) {
    const entriesText = [...groupAdds].map(([name, members]) => name + '（' + members.length + ' 个）').join('、')
    if (!hasMarket(profileDir)) {
      lines.push('这个包按分组打包（' + entriesText + '），但目标 profile 没装插件市场，分组没有写入')
    } else if (options.dryRun) {
      lines.push('演练：将把 ' + entriesText + ' 并进插件市场分组')
    } else {
      const applied = applyMarketGroups(profileDir, Object.fromEntries(groupAdds))
      if (applied.changed) {
        lines.push('已按包内分组并入插件市场：' + applied.summary)
        actions.push({ plugin: '', action: 'group', ok: true, message: '并入市场分组：' + applied.summary })
      } else if (applied.error) {
        lines.push('市场分组没能写入（' + applied.error + '）；插件已经装好，分组可以在插件市场里手动加')
      }
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
