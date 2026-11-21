/**
 * dsh-modpack —— 从 npm / 插件市场源取包。
 *
 * 只信任 https；主机名必须在 allowHosts 里；重定向每一跳都重新校验
 * （不然一个 302 就能把请求带到任意地址）。下载有体积上限，拿到 tarball
 * 后先核对 registry 给的 sha512，再解包。
 */
import { createHash } from 'node:crypto'
import { readTarball, stripPackagePrefix } from './tar.mjs'
import { parseVersion, satisfies, compareVersions } from './semver.mjs'
import { assertAllowedUrl, requestBuffer, requestJson } from './net.mjs'

const NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/iu

// 传输细节（逐跳校验、重试、curl 兜底）都在 lib/net.mjs；这里保留旧名字给调用方与测试用。
export { assertAllowedUrl }
export const fetchLimited = requestBuffer
export const fetchJson = requestJson

export function validatePackageName(name) {
  if (typeof name !== 'string' || name.length > 214 || !NAME_RE.test(name)) {
    throw new Error('不是合法的 npm 包名：' + String(name).slice(0, 80))
  }
  return name
}

/** npm 的「精简清单」：只带依赖与 dist，体积通常比完整清单小得多。 */
const META_ACCEPT = 'application/vnd.npm.install-v1+json'
const EXACT_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

/**
 * 版本清单的体积上限（字节）。
 * billion-context 这类包的清单曾经十几 MB，固定 16 MB 会让它整个装不上，
 * 所以默认放宽到 64 MB，并且允许在设置里调（maxMetadataBytes，单位 MB）。
 */
export function metadataLimit(config) {
  const mb = Number(config?.maxMetadataBytes)
  if (Number.isFinite(mb) && mb > 0) return Math.max(4, Math.min(512, Math.floor(mb))) * 1024 * 1024
  return 64 * 1024 * 1024
}

/**
 * 取一个包的版本清单，按「精简 → 完整 → 单版本」三层退让。
 *
 * 为什么不是一条路：vnd.npm.install-v1+json 通常最小，但个别包反而更大；
 * 完整清单有时更小；而只要调用方知道确切版本，/name/1.2.3 这条 REST 永远最小。
 * 三层都失败才算失败，错误信息里带上每层的原因，方便看出是被体积挡住还是网络。
 */
/**
 * 快速探一下 registry 通不通（npm 的 /-/ping 很轻）。
 * 用来决定「懒人包要不要先按市场版本装」：没网就直接用包里自带的，
 * 免得每个插件都等一遍超时，装个包要好几分钟。
 */
export async function probeRegistry(config, timeoutMs = 4000) {
  const registries = Array.isArray(config && config.registries) && config.registries.length
    ? config.registries
    : ['https://registry.npmjs.org']
  let last = null
  for (const base of registries.slice(0, 2)) {
    try {
      const url = String(base).replace(/\/+$/u, '') + '/-/ping'
      await requestJson(url, config, { maxBytes: 64 * 1024, timeoutMs, retries: 0 })
      return true
    } catch (error) {
      last = error
    }
  }
  return false
}

export async function npmMetadata(name, config, options = {}) {
  validatePackageName(name)
  const registries = Array.isArray(config?.registries) && config.registries.length > 0
    ? config.registries
    : ['https://registry.npmjs.org']
  const limit = metadataLimit(config)
  const wanted = typeof options.version === 'string' ? options.version.trim() : ''
  const exact = EXACT_VERSION_RE.test(wanted) ? wanted : ''
  const errors = []
  for (const base of registries) {
    const root = base.replace(/\/+$/u, '')
    const url = root + '/' + encodeURIComponent(name).replace(/^%40/u, '@')
    const attempts = [
      { label: '精简清单', target: url, accept: META_ACCEPT, maxBytes: limit, full: false },
      { label: '完整清单', target: url, accept: 'application/json', maxBytes: limit, full: true },
    ]
    if (options.full === true) attempts.reverse()
    if (exact) {
      attempts.push({
        label: '单版本清单',
        target: url + '/' + encodeURIComponent(exact),
        accept: 'application/json',
        maxBytes: Math.min(limit, 8 * 1024 * 1024),
        version: exact,
      })
    }
    for (const attempt of attempts) {
      try {
        const doc = await fetchJson(attempt.target, config, { accept: attempt.accept, maxBytes: attempt.maxBytes, timeoutMs: 45000 })
        if (attempt.version) {
          if (!doc || typeof doc !== 'object' || !doc.version) throw new Error('没有版本信息')
          return {
            meta: { 'dist-tags': { latest: doc.version }, versions: { [doc.version]: doc }, time: {} },
            registry: root,
            doc: 'version',
          }
        }
        if (!doc || typeof doc !== 'object' || !doc.versions || Object.keys(doc.versions).length === 0) {
          throw new Error('元数据缺少 versions')
        }
        return { meta: doc, registry: root, doc: attempt.full ? 'full' : 'abbrev' }
      } catch (error) {
        errors.push(root + '（' + attempt.label + '）→ ' + String((error && error.message) || error))
      }
    }
  }
  const oversize = errors.some((line) => /超过上限/u.test(line))
  const hint = oversize
    ? '（版本清单太大：可在设置里把 maxMetadataBytes 调大，或改用确定的版本号，插件会直接取单版本清单）'
    : ''
  throw new Error('registry 都失败了：' + errors.join('；') + hint)
}

/** 选版本：精确版 > dist-tags.latest > 范围里最高的稳定版。 */
export function pickVersion(meta, spec) {
  const versions = Object.keys(meta.versions || {})
  if (versions.length === 0) throw new Error('该包没有任何版本')
  const wanted = typeof spec === 'string' && spec.trim() !== '' && spec !== 'latest' ? spec.trim() : ''
  if (wanted && meta.versions[wanted]) return wanted
  if (!wanted) {
    const latest = meta['dist-tags'] && meta['dist-tags'].latest
    if (latest && meta.versions[latest]) return latest
  }
  const candidates = versions
    .filter((v) => (wanted ? satisfies(v, wanted) === true : true))
    .sort((a, b) => (compareVersions(b, a) ?? 0))
  if (candidates.length === 0) throw new Error('没有版本满足「' + (wanted || 'latest') + '」')
  const stable = candidates.find((v) => !parseVersion(v)?.pre)
  return stable || candidates[0]
}

export function relativeTime(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const days = Math.round((Date.now() - t) / 86400000)
  return days <= 0 ? '今天' : days + ' 天前'
}

/**
 * 下载并解析一个 npm 包。
 * @returns {Promise<{name, version, registry, tarball, integrity, sha256, license, repository, pkg, entries, files, unpackedBytes}>}
 */
export async function downloadPackage(name, spec, config) {
  const { meta, registry } = await npmMetadata(name, config, { version: spec })
  const version = pickVersion(meta, spec)
  const manifest = meta.versions[version]
  if (!manifest || !manifest.dist || !manifest.dist.tarball) throw new Error('版本 ' + version + ' 没有 tarball')
  const tarballUrl = new URL(manifest.dist.tarball, registry + '/').href
  assertAllowedUrl(tarballUrl, config)
  const tgz = await fetchLimited(tarballUrl, config, { maxBytes: config?.maxDownloadBytes })
  const expected = typeof manifest.dist.integrity === 'string' ? manifest.dist.integrity : ''
  if (expected.startsWith('sha512-')) {
    const actual = 'sha512-' + createHash('sha512').update(tgz).digest('base64')
    if (actual !== expected) throw new Error('tarball 校验失败（sha512 不符）：' + name + '@' + version)
  }
  const entries = stripPackagePrefix(readTarball(tgz))
  const pkgEntry = entries.find((e) => e.name === 'package.json')
  if (!pkgEntry) throw new Error('包里没有 package.json：' + name)
  let pkg
  try {
    pkg = JSON.parse(pkgEntry.data.toString('utf8'))
  } catch {
    throw new Error('package.json 不是合法 JSON：' + name)
  }
  return {
    name: pkg.name || name,
    version: pkg.version || version,
    registry,
    tarball: tarballUrl,
    integrity: expected,
    sha256: 'sha256-' + createHash('sha256').update(tgz).digest('hex'),
    license: typeof pkg.license === 'string' ? pkg.license : (pkg.license && pkg.license.type) || '',
    repository: typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository && pkg.repository.url) || '',
    pkg,
    entries,
    unpackedBytes: entries.reduce((sum, e) => sum + e.data.length, 0),
  }
}

/** 市场目录（awesome-dsh-plugin.com），失败就返回空——它只是锦上添花。 */
/**
 * 插件市场目录。官方站点在国内经常连不上或极慢，所以：
 * 先试官方 JSON（短超时，不让页面干等），失败就退回 npm 搜索。
 * 两条路都失败时返回空数组，调用方展示"目录不可用"而不是白屏。
 */
export async function fetchCatalog(config) {
  try {
    const data = await fetchJson('https://awesome-dsh-plugin.com/plugins.json', config, {
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 8000,
    })
    const list = Array.isArray(data) ? data : (Array.isArray(data?.plugins) ? data.plugins : [])
    if (list.length > 0) return list
  } catch {
    // 站点慢/被挡，走 npm 兜底
  }
  return npmSearchCatalog(config)
}

/** npm 搜索兜底：以 keywords 找同类插件，字段摊平成官方目录的近似形状。 */
export async function npmSearchCatalog(config) {
  const queries = ['keywords:dsh-plugin', 'keywords:dsh-bundle']
  const seen = new Map()
  for (const text of queries) {
    const url = 'https://registry.npmjs.org/-/v1/search?size=250&text=' + encodeURIComponent(text)
    try {
      const data = await fetchJson(url, config, { maxBytes: 8 * 1024 * 1024, timeoutMs: 20000 })
      const objects = Array.isArray(data?.objects) ? data.objects : []
      for (const entry of objects) {
        const pkg = entry && entry.package
        if (!pkg || !pkg.name || seen.has(pkg.name)) continue
        const repo = pkg.links?.repository || (pkg.repository && (pkg.repository.url || pkg.repository)) || ''
        const author = pkg.author && typeof pkg.author === 'object' ? pkg.author.name || '' : pkg.author || ''
        seen.set(pkg.name, {
          name: pkg.name,
          title: pkg.name,
          description: String(pkg.description || ''),
          version: String(pkg.version || ''),
          author: String(author || ''),
          repository: String(repo || ''),
          license: String(pkg.license || ''),
          tags: Array.isArray(pkg.keywords) ? pkg.keywords.slice(0, 10) : [],
          source: 'npm-search',
        })
      }
    } catch {
      // 单个查询失败不影响另一个
    }
  }
  return [...seen.values()]
}
