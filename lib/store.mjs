/**
 * dsh-modpack —— 本地状态：设置、历史、目录解析。
 *
 * 只写 `$DSH_HOME/dsh-modpack/` 下面：settings.json、history.json、
 * packs/（产出的整合包）、vendor/（从整合包解出来的插件源码）。
 * 不碰 profile 里别人的文件；唯一例外在 install.mjs 里，且带备份。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function pluginHome() {
  return path.join(dshHome(), 'dsh-modpack')
}

export function profileName(config) {
  const fromEnv = process.env.DSH_PROFILE || process.env.DSH_PROFILE_NAME || ''
  const name = (config && config.profile) || fromEnv || 'desktop'
  return /^[A-Za-z0-9_-]{1,64}$/u.test(name) ? name : 'desktop'
}

export function profileDir(config) {
  return path.join(dshHome(), 'profiles', profileName(config))
}

export const HOSTS_VERSION = 2
// 网络默认值迁移版本：20 秒是早期默认值，慢链路连一个 tarball 都下不完，一次性抬到 60 秒
export const NET_VERSION = 2

export const DEFAULT_CONFIG = {
  profile: '',
  packDir: '',
  vendorDir: '',
  includePayload: true,
  includeConfig: true,
  includeLocalEdits: true,
  keepLocal: true,
  scanBeforePack: true,
  scanBeforeInstall: true,
  blockHighRisk: true,
  applyPackedConfig: true,
  licenseAllow: [
    'MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Unlicense', 'CC0-1.0',
    'MPL-2.0', 'LGPL-2.1', 'LGPL-3.0', 'GPL-2.0', 'GPL-3.0', 'AGPL-3.0',
    'PolyForm-Noncommercial-1.0.0', 'PolyForm-Shield-1.0.0',
  ],
  registries: ['https://registry.npmjs.org', 'https://registry.npmmirror.com'],
  allowHosts: [
    'registry.npmjs.org', 'registry.npmmirror.com', 'awesome-dsh-plugin.com', 'dshmarket.com',
    'cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'gh-proxy.com',
    'github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com',
  ],
  // 网络：宿主 fetch 在个别代理/证书环境下会直接失败，这里给重试与 curl 兜底
  netTimeoutSeconds: 60,
  netVersion: NET_VERSION,
  netRetries: 1,
  curlFallback: true,
  maxDownloadBytes: 256 * 1024 * 1024,
  // 版本清单（packument）的体积上限，单位 MB。
  // 有的包清单十几 MB（billion-context 曾经超过 16 MB），旧版固定 16 MB 会直接装不上。
  maxMetadataBytes: 64,
  maxPackBytes: 256 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  // 进度窗里「收尾」的记录留多久（秒）：0 = 留到 DSH 下次启动（或手动清空）；给正数就按秒自动清
  jobKeepSeconds: 0,
  // 二次开发用：额外扫描规则（形状同 lib/scan.mjs 的 SECRET_RULES）
  extraScanRules: [],
  historyLimit: 50,
  // 插件目录（分类与词条照插件市场）：每页多少条、隔多久自己去更新一次
  catalogPageSize: 20,
  catalogRefreshHours: 24,
  // 三处显示位，各自独立；关闭只是不挂载，不影响功能与 API
  showInSettings: true,
  showInSidebar: true,
  showInPluginsTab: false,
  // 安装后是否直接登记到 bundles（默认关：只装文件，重启也不加载）
  enableOnInstall: false,
  // 装整合包时若联网且插件市场有同名条目，优先按市场版本装（关掉则严格按包内那份）
  preferMarketOnInstall: true,
  // 白名单迁移标记：跑过一次就别再往里并默认域名，尊重用户自己的增删
  hostsVersion: HOSTS_VERSION,
}

export function pathsFor(config) {
  const home = pluginHome()
  return {
    home,
    settings: path.join(home, 'settings.json'),
    history: path.join(home, 'history.json'),
    log: path.join(pluginHome(), 'modpack.log'),
    packs: (config && config.packDir) || path.join(home, 'packs'),
    vendor: (config && config.vendorDir) || path.join(home, 'vendor'),
    profile: profileDir(config || {}),
  }
}

export function clampConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG }
  if (!raw || typeof raw !== 'object') return cfg
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = raw[key]
    if (value === undefined) continue
    const def = DEFAULT_CONFIG[key]
    if (Array.isArray(def)) {
      if (Array.isArray(value)) cfg[key] = value.filter((v) => typeof v === 'string').slice(0, 200)
    } else if (typeof def === 'boolean') {
      if (typeof value === 'boolean') cfg[key] = value
    } else if (typeof def === 'number') {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) cfg[key] = Math.floor(value)
    } else if (typeof value === 'string') {
      cfg[key] = value.slice(0, 512)
    }
  }
  // 分页大小与刷新周期：给了边界，避免有人把 10000 写进设置把页面拖死
  cfg.catalogPageSize = Math.min(100, Math.max(5, Number(cfg.catalogPageSize) || DEFAULT_CONFIG.catalogPageSize))
  cfg.catalogRefreshHours = Math.min(168, Math.max(1, Number(cfg.catalogRefreshHours) || DEFAULT_CONFIG.catalogRefreshHours))
  // 0 是合法的：等于「收尾就立刻清掉」，测试也靠它把时间压到零
  const keepRaw = raw && typeof raw.jobKeepSeconds === 'number' ? raw.jobKeepSeconds : DEFAULT_CONFIG.jobKeepSeconds
  cfg.jobKeepSeconds = Math.min(3600, Math.max(0, Math.floor(Number(keepRaw) || 0)))
  // 网络参数：超时 5~120 秒、重试 0~5 次，curl 兜底只能是布尔
  cfg.netTimeoutSeconds = Math.min(120, Math.max(5, Math.floor(Number(cfg.netTimeoutSeconds) || DEFAULT_CONFIG.netTimeoutSeconds)))
  cfg.netRetries = Math.min(5, Math.max(0, Math.floor(Number(cfg.netRetries) || 0)))
  cfg.curlFallback = cfg.curlFallback !== false
  // 体积上限：界面按 MB 输入，这里按范围夹住，别让手滑写出 25 GB 这种值
  const oneMb = 1024 * 1024
  cfg.maxPackBytes = Math.min(4096 * oneMb, Math.max(16 * oneMb, Math.floor(Number(cfg.maxPackBytes) || DEFAULT_CONFIG.maxPackBytes)))
  cfg.maxFileBytes = Math.min(256 * oneMb, Math.max(1 * oneMb, Math.floor(Number(cfg.maxFileBytes) || DEFAULT_CONFIG.maxFileBytes)))
  cfg.maxDownloadBytes = Math.min(4096 * oneMb, Math.max(16 * oneMb, Math.floor(Number(cfg.maxDownloadBytes) || DEFAULT_CONFIG.maxDownloadBytes)))
  // 版本清单上限：4~512 MB，默认 64
  cfg.maxMetadataBytes = Math.min(512, Math.max(4, Math.floor(Number(cfg.maxMetadataBytes) || DEFAULT_CONFIG.maxMetadataBytes)))
  // 进度窗位置不在这里管：它由界面自己拖动并存在浏览器本地，服务端不需要知道
  // 打包前安全检测是强制的：设置里怎么写都不认，打包一律扫。
  cfg.scanBeforePack = true
  return cfg
}

export function loadConfig() {
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(pathsFor({}).settings, 'utf8')) } catch { raw = null }
  const cfg = clampConfig(raw)
  // 老版本存下的白名单里没有后来新增的域名（例如目录用的 CDN）：并一次，之后尊重用户自己的增删
  const known = Number((raw && raw.hostsVersion) || 0)
  if (known < HOSTS_VERSION) {
    const merged = new Set(Array.isArray(cfg.allowHosts) ? cfg.allowHosts : [])
    for (const host of DEFAULT_CONFIG.allowHosts) merged.add(host)
    cfg.allowHosts = [...merged]
    cfg.hostsVersion = HOSTS_VERSION
    if (raw) { try { writeJsonAtomic(pathsFor({}).settings, cfg) } catch {} }
  }
  // 老配置里的 20 秒是早期默认值：一次性抬到新的默认值，之后尊重用户自己写的数
  const netKnown = Number((raw && raw.netVersion) || 0)
  if (netKnown < NET_VERSION) {
    if (Number(cfg.netTimeoutSeconds) < DEFAULT_CONFIG.netTimeoutSeconds) cfg.netTimeoutSeconds = DEFAULT_CONFIG.netTimeoutSeconds
    cfg.netVersion = NET_VERSION
    if (raw) { try { writeJsonAtomic(pathsFor({}).settings, cfg) } catch {} }
  }
  return cfg
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function saveConfig(config) {
  const cfg = clampConfig(config)
  writeJsonAtomic(pathsFor(cfg).settings, cfg)
  return cfg
}

export function readHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(pathsFor({}).history, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

export function appendHistory(entry, limit = DEFAULT_CONFIG.historyLimit) {
  const list = readHistory()
  list.unshift({ ...entry, at: new Date().toISOString() })
  writeJsonAtomic(pathsFor({}).history, list.slice(0, Math.max(1, limit)))
  return list
}

export function appendLog(line) {
  try {
    fs.mkdirSync(pluginHome(), { recursive: true })
    fs.appendFileSync(pathsFor({}).log, new Date().toISOString() + ' ' + line + '\n')
  } catch {
    // 日志写不进去不该影响主流程
  }
}

/** 文件名安全的 slug：保留中文，去掉路径分隔符与控制字符。 */
export function slugify(text, fallback = 'modpack') {
  const cleaned = String(text ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .slice(0, 60)
  return cleaned || fallback
}

/** 同步建目录：调用点全是同步写盘，异步版本会有竞态。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
