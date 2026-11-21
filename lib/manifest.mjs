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
    // 谁的内部组件：装父包时会一起装上，安装侧据此跳过，不重复装
    transitiveOf: typeof raw.transitiveOf === 'string' && /^[@A-Za-z0-9._\/-]{1,160}$/u.test(raw.transitiveOf) ? raw.transitiveOf : '',
    // 打包时按市场分组整体加入的组名（目标机器有插件市场时并进去）
    group: typeof raw.group === 'string' && /^[\p{L}\p{N}_ -]{1,40}$/u.test(raw.group) ? raw.group : '',
    localEdits: bool(raw.localEdits),
    configMode: raw.configMode === 'preset' ? 'preset' : raw.configMode === 'custom' ? 'custom' : (bool(raw.localEdits) || bool(raw.configIncluded) ? 'custom' : 'preset'),
    // 老包没有 mode 字段，用 localEdits 兜底
    mode: raw.mode === 'local' ? 'local' : raw.mode === 'base' ? 'base' : bool(raw.localEdits) ? 'local' : 'base',
    configIncluded: bool(raw.configIncluded),
    // 打包时被替换成 ${REDACTED} 的配置路径（安装后需要重填）
    configRedacted: Array.isArray(raw.configRedacted)
      ? raw.configRedacted.map((item) => str(item, 200)).filter(Boolean).slice(0, 50)
      : [],
    dataIncluded: bool(raw.dataIncluded),
    // 数据快照里被替换成 ${REDACTED} 的凭据条数（安装后可能需要重填）
    dataRedacted: num(raw.dataRedacted),
    // 插件数据目录的真名（安装时原路放回 ~/.dsh/<名字>）
    dataDirs: Array.isArray(raw.dataDirs)
      ? raw.dataDirs
          .map((item) => str(item, 120))
          .filter((item) => /^[A-Za-z0-9._-]+$/u.test(item))
          .slice(0, 20)
      : [],
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
  const schema = Number(raw.schema)
  if (schema > SCHEMA) {
    throw new Error('这个整合包是更新的格式（schema ' + schema + '），请先升级 dsh-modpack-kit 再装；现在这份只认到 schema ' + SCHEMA)
  }
  if (raw.schema !== SCHEMA) throw new Error('不支持的清单版本：' + String(raw.schema) + '（这份插件只认 schema ' + SCHEMA + '）')
  if (raw.kind !== KIND) throw new Error('不是 dsh 整合包：kind=' + String(raw.kind))
  const plugins = Array.isArray(raw.plugins) ? raw.plugins.slice(0, 200).map(normalizePlugin) : []
  if (plugins.length === 0) throw new Error('整合包里没有插件')
  const seen = new Set()
  for (const p of plugins) {
    if (seen.has(p.name)) throw new Error('重复插件：' + p.name)
    seen.add(p.name)
  }
  const format = raw.format === 'full' ? 'full' : raw.format === 'hybrid' ? 'hybrid' : 'lite'
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
    strategy: format,
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
  const formatText = manifest.format === 'full'
    ? '完整包：包含插件本体，不联网也能装（有网时优先按市场版本装，装完照样是市场版）'
    : manifest.format === 'hybrid'
      ? '混合包：只带版本号与配置/数据快照，安装时联网按版本取包，体积最小但保留自定义配置'
      : '仅下载码：只有清单与版本号，安装时联网按版本取包，不带配置'
  lines.push('格式：' + manifest.format + '（' + formatText + '）')
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
  if (manifest.format !== 'full') {
    lines.push('  方式 A（有 dsh-modpack 插件）：侧栏「整合包 → 安装」选择本文件，会联网按版本取包并校验完整性。')
    lines.push('  方式 B（裸 DSH 也能装）：解压后运行 install/ 里的安装器，它会按清单里的名字与版本从 registry 取包：')
    lines.push('    Windows: install\\install.cmd        其它: sh install/install.sh')
    lines.push('    指定 profile 或 DSH 位置：加 --profile <名字>  --dsh "<DSH 可执行文件或 cli.js>"')
  } else {
    lines.push('  方式 A（推荐，有 dsh-modpack 插件）：侧栏「整合包 → 安装」选择本文件，会校验完整性、')
    lines.push('          重新扫描安全项、检查兼容性，并把打包时保存的配置同步回来。')
    lines.push('  方式 B（没有任何插件、裸 DSH 也能装，推荐给没装本插件的人）：')
    lines.push('    1. 解压整个 zip；')
    lines.push('    2. 运行包内安装器（需要 Node 20+）：')
    lines.push('         Windows: install\\install.cmd        其它: sh install/install.sh')
    lines.push('       可加参数：--profile <名字>（默认 desktop）--dry-run（只看要做什么）')
    lines.push('                 --no-bundles（装了但先不启用）--replace（本机已装的也换成包内版本）')
    lines.push('                 --dsh "<DSH 可执行文件或 cli.js>"')
    lines.push('    3. 安装器会逐插件执行官方 dsh plugin add、把 configs/ 里的配置合并进 cordis.patch.yml；')
    lines.push('       本机已经装了的插件它会先跳过、装完列出来；要换成包内版本，加 --replace 重跑一次。')
    lines.push('    4. 重启 DSH。')
    lines.push('  方式 C（手工，没有 Node 时）：解压后对 plugins/ 下每个目录执行')
    lines.push('       dsh plugin --profile <你的profile> add "file:<绝对路径>/plugins/<插件名>"')
    lines.push('     再把插件名加进 ~/.dsh/profiles/<你的profile>/package.json 的 dsh.profile.bundles。')
  }
  lines.push('')
  lines.push('目录结构')
  lines.push('  dsh-modpack.json   清单（机器可读，schema ' + SCHEMA + '）')
  lines.push('  integrity.json     每个文件的 sha256')
  lines.push('  security/          安全检测报告（已打码）')
  lines.push('  install/           独立安装器（不依赖本插件，裸 DSH 可用）')
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
  lines.push('')
  lines.push('项目与更新：https://github.com/Vesna-Strivozha-cn/dsh-modpack-kit')
  lines.push('  这个整合包由 dsh-modpack-kit 生成；觉得省事可以到仓库点个 Star。')
  if (extra.footer) lines.push(extra.footer)
  return lines.join('\n')
}
