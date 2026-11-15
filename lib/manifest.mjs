/**
 * dsh-modpack —— 整合包清单（dsh-modpack.json）。
 *
 * 清单是整个格式的契约：读的一方只认 `schema` + `kind`，看不到就拒绝；
 * 每一项都有上限，防止一个坏包把界面撑爆。
 */
import { createHash } from 'node:crypto'

export const SCHEMA = 1
export const KIND = 'dsh-modpack'
export const MANIFEST_NAME = 'dsh-modpack.json'

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
export const shortHash = (buf) => sha256(buf).slice(0, 16)

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const bool = (v) => v === true

function normalizePlugin(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('插件条目不是对象')
  const name = str(raw.name, 214)
  if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/iu.test(name)) throw new Error('插件名不合法：' + name)
  const config = raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config) ? raw.config : null
  const peers = raw.peerDependencies && typeof raw.peerDependencies === 'object' ? raw.peerDependencies : {}
  const peerList = {}
  for (const [key, value] of Object.entries(peers).slice(0, 100)) {
    if (typeof key === 'string' && typeof value === 'string') peerList[key] = value.slice(0, 200)
  }
  return {
    name,
    version: str(raw.version, 64) || '0.0.0',
    requested: str(raw.requested, 64),
    source: ['profile', 'npm', 'file', 'url', 'vendor'].includes(raw.source) ? raw.source : 'npm',
    registry: str(raw.registry, 300),
    tarball: str(raw.tarball, 500),
    integrity: str(raw.integrity, 200),
    license: str(raw.license, 80),
    repository: str(raw.repository, 300),
    author: str(raw.author, 120),
    files: num(raw.files),
    size: num(raw.size),
    hasClient: bool(raw.hasClient),
    hasPatch: bool(raw.hasPatch),
    isBundle: raw.isBundle !== false,
    localEdits: bool(raw.localEdits),
    // 老包没有 mode 字段，用 localEdits 兜底
    mode: raw.mode === 'local' ? 'local' : raw.mode === 'base' ? 'base' : bool(raw.localEdits) ? 'local' : 'base',
    configIncluded: bool(raw.configIncluded),
    dataIncluded: bool(raw.dataIncluded),
    peerDependencies: peerList,
    engines: raw.engines && typeof raw.engines === 'object' ? raw.engines : {},
    // pnpm 别名 / link 安装时目录名可能不等于包名，payload 前缀以它为准
    dirName: (() => {
      const value = str(raw.dirName, 200)
      return /^[@A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/u.test(value) ? value : ''
    })(),
    config,
    note: str(raw.note, 300),
  }
}

export function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('清单不是对象')
  if (raw.schema !== SCHEMA) throw new Error('不支持的清单版本：' + String(raw.schema))
  if (raw.kind !== KIND) throw new Error('不是 dsh 整合包：kind=' + String(raw.kind))
  const plugins = Array.isArray(raw.plugins) ? raw.plugins.slice(0, 200).map(normalizePlugin) : []
  if (plugins.length === 0) throw new Error('整合包里没有插件')
  const seen = new Set()
  for (const p of plugins) {
    if (seen.has(p.name)) throw new Error('重复插件：' + p.name)
    seen.add(p.name)
  }
  const format = raw.format === 'full' ? 'full' : 'lite'
  return {
    schema: SCHEMA,
    kind: KIND,
    format,
    id: str(raw.id, 80),
    name: str(raw.name, 120) || '未命名整合包',
    description: str(raw.description, 2000),
    author: str(raw.author, 120),
    license: str(raw.license, 80),
    homepage: str(raw.homepage, 300),
    createdAt: str(raw.createdAt, 40) || new Date().toISOString(),
    generator: {
      name: str(raw.generator?.name, 80) || 'dsh-modpack',
      version: str(raw.generator?.version, 40) || '0.0.0',
    },
    dshVersion: str(raw.dshVersion, 40),
    options: {
      includePayload: format === 'full',
      includeConfig: raw.options ? bool(raw.options.includeConfig) : true,
      includeLocalEdits: raw.options ? bool(raw.options.includeLocalEdits) : false,
      keepLocalOnInstall: raw.options ? raw.options.keepLocalOnInstall !== false : true,
    },
    plugins,
    files: Array.isArray(raw.files)
      ? raw.files.slice(0, 5000).map((f) => ({ path: str(f.path, 500), sha256: str(f.sha256, 64), size: num(f.size) })).filter((f) => f.path && f.sha256)
      : [],
    security: {
      scanned: raw.security ? raw.security.scanned === true : false,
      high: num(raw.security?.high),
      medium: num(raw.security?.medium),
      low: num(raw.security?.low),
      approvedRisk: bool(raw.security?.approvedRisk),
      acknowledged: bool(raw.security?.acknowledged),
      trustedOnly: bool(raw.security?.trustedOnly),
      note: str(raw.security?.note, 500),
    },
    install: {
      restartRequired: true,
      notes: Array.isArray(raw.install?.notes) ? raw.install.notes.slice(0, 30).map((n) => str(n, 300)) : [],
    },
    extensions: raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {},
  }
}

export function pluginSummary(manifest) {
  return {
    name: manifest.name,
    format: manifest.format,
    plugins: manifest.plugins.length,
    createdAt: manifest.createdAt,
    dshVersion: manifest.dshVersion,
    bytes: manifest.files.reduce((sum, f) => sum + (f.size || 0), 0),
    payloadBytes: manifest.plugins.reduce((sum, p) => sum + (p.size || 0), 0),
    security: manifest.security,
  }
}

/** 给人看的 README.txt：不装本插件也能照着装。 */
export function buildReadme(manifest, extra = {}) {
  const lines = []
  lines.push('DSH 整合包 —— ' + manifest.name)
  lines.push('='.repeat(60))
  if (manifest.description) {
    lines.push('')
    for (const line of manifest.description.split(/\r?\n/u)) lines.push(line)
  }
  lines.push('')
  lines.push('格式：' + manifest.format + '（' + (manifest.format === 'full' ? '完整版：包含插件本体，任何工具解压即可读' : '轻量版：只有清单，需要 dsh-modpack 插件联网安装') + '）')
  lines.push('生成：' + manifest.createdAt + '  生成器：' + manifest.generator.name + ' ' + manifest.generator.version)
  if (manifest.author) lines.push('打包者：' + manifest.author)
  if (manifest.dshVersion) lines.push('打包时 DSH 版本：' + manifest.dshVersion)
  lines.push('')
  lines.push('包含的插件（' + manifest.plugins.length + ' 个）')
  for (const p of manifest.plugins) {
    lines.push('  · ' + p.name + '@' + p.version + (p.license ? '  [' + p.license + ']' : '  [未标注 license]') + (p.localEdits ? '  （含打包者的本地修改）' : ''))
  }
  lines.push('')
  lines.push('安全检测')
  lines.push('  扫描：' + (manifest.security.scanned ? '已执行' : '未执行') + '，高风险 ' + manifest.security.high + ' / 中 ' + manifest.security.medium + ' / 低 ' + manifest.security.low)
  lines.push('  报告：security/report.txt（片段已打码；命中的原始内容没有落盘）')
  lines.push('  提醒：静态检测不是杀毒，未命中不代表保证安全；安装前请自行确认来源。')
  lines.push('')
  lines.push('怎么装')
  if (manifest.format === 'lite') {
    lines.push('  1. 在 DSH 里安装 dsh-modpack 插件；')
    lines.push('  2. 侧栏打开「整合包 → 安装」，选择本文件或粘贴下载链接；')
    lines.push('  3. 按提示确认安全扫描与兼容性结果，然后安装。')
  } else {
    lines.push('  方式 A（推荐，有 dsh-modpack 插件）：侧栏「整合包 → 安装」选择本文件，会校验完整性、')
    lines.push('          重新扫描安全项、检查兼容性，并把打包时保存的配置同步回来。')
    lines.push('  方式 B（没有装 dsh-modpack，也能装）：')
    lines.push('    1. 解压本 zip；')
    lines.push('    2. 对 plugins/ 下每个目录执行：')
    lines.push('         dsh plugin --profile <你的profile> add file:<本机绝对路径>/plugins/<插件名>')
    lines.push('    3. 把插件名追加到 ~/.dsh/profiles/<你的profile>/package.json 的 dsh.profile.bundles；')
    lines.push('    4. 配好的选项在 configs/ 里，按 cordis.patch.yml 的格式手工合并；')
    lines.push('    5. 重启 DSH。')
  }
  lines.push('')
  lines.push('目录结构')
  lines.push('  dsh-modpack.json   清单（机器可读，schema ' + SCHEMA + '）')
  lines.push('  integrity.json     每个文件的 sha256')
  lines.push('  security/          安全检测报告（已打码）')
  lines.push('  configs/           打包时的非默认配置（每个插件一个 json）')
  if (manifest.format === 'full') lines.push('  plugins/           插件本体，一个目录一个插件')
  lines.push('  data/              插件数据快照（如果打包时选了保留）')
  lines.push('')
  lines.push('合规与免责')
  lines.push('  · 整合包只应包含你有权再分发的插件；每个插件的 license 列在上面，')
  lines.push('    原作者的版权仍归原作者，分发前请自行确认许可条款。')
  lines.push('  · 包里不包含账号凭证；打包时检测到疑似凭证的文件不会被打进去。')
  lines.push('  · 不绕过任何官方渠道，不提供破解、破解依赖或规避授权的功能。')
  lines.push('  · 使用前请遵守所在地法律与 B 站/DeepSeek 等平台的服务条款。')
  lines.push('')
  if (extra.footer) lines.push(extra.footer)
  return lines.join('\n')
}
