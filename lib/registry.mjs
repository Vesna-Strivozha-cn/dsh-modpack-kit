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

const NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/iu
const TIMEOUT_MS = 30000

export function assertAllowedUrl(url, config) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('地址无法解析：' + String(url).slice(0, 200))
  }
  if (parsed.protocol !== 'https:') throw new Error('只允许 https 地址：' + parsed.protocol)
  const host = parsed.hostname.toLowerCase()
  const allowed = Array.isArray(config?.allowHosts) && config.allowHosts.length > 0 ? config.allowHosts : ['registry.npmjs.org']
  if (!allowed.some((h) => host === h.toLowerCase() || host.endsWith('.' + h.toLowerCase()))) {
    throw new Error('主机不在允许列表：' + host + '（可在设置里添加）')
  }
  return parsed
}

/** 手工跟重定向，每一跳都校验主机与协议。 */
export async function fetchLimited(url, config, options = {}) {
  const maxBytes = options.maxBytes ?? config?.maxDownloadBytes ?? 128 * 1024 * 1024
  let current = url
  for (let hop = 0; hop < 6; hop += 1) {
    assertAllowedUrl(current, config)
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      headers: { 'user-agent': 'dsh-modpack', accept: options.accept ?? '*/*' },
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new Error('重定向没有 location：' + current)
      current = new URL(location, current).href
      continue
    }
    if (!res.ok) throw new Error('HTTP ' + res.status + '：' + current)
    const length = Number(res.headers.get('content-length') || '0')
    if (length > maxBytes) throw new Error('响应体过大（' + length + ' 字节）')
    if (!res.body) return Buffer.alloc(0)
    const chunks = []
    let total = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        try { await reader.cancel() } catch {}
        throw new Error('下载超过上限（' + maxBytes + ' 字节）')
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }
  throw new Error('重定向次数过多：' + url)
}

export async function fetchJson(url, config, options = {}) {
  const buf = await fetchLimited(url, config, { ...options, maxBytes: options.maxBytes ?? 16 * 1024 * 1024, accept: 'application/json' })
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new Error('返回内容不是 JSON：' + url)
  }
}

export function validatePackageName(name) {
  if (typeof name !== 'string' || name.length > 214 || !NAME_RE.test(name)) {
    throw new Error('不是合法的 npm 包名：' + String(name).slice(0, 80))
  }
  return name
}

/** 依次尝试每个 registry，第一个成功的算。 */
export async function npmMetadata(name, config) {
  validatePackageName(name)
  const registries = Array.isArray(config?.registries) && config.registries.length > 0
    ? config.registries
    : ['https://registry.npmjs.org']
  const errors = []
  for (const base of registries) {
    try {
      const url = base.replace(/\/+$/u, '') + '/' + encodeURIComponent(name).replace(/^%40/u, '@')
      const meta = await fetchJson(url, config, { accept: 'application/json' })
      if (!meta || typeof meta !== 'object' || !meta.versions) throw new Error('元数据缺少 versions')
      return { meta, registry: base.replace(/\/+$/u, '') }
    } catch (error) {
      errors.push(base + ' → ' + String(error?.message || error))
    }
  }
  throw new Error('registry 都失败了：' + errors.join('；'))
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
  const { meta, registry } = await npmMetadata(name, config)
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
