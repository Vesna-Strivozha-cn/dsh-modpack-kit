/**
 * dsh-modpack —— 插件市场目录（分类 + 分页搜索）。
 *
 * 分类与词条都照插件市场的来：市场自己把目录发布成 npm 包 `dsh-plugin-catalog`
 * （`package/plugins.json`，另有一份 CDN 上的 `index.json`），里面带 23 个分类
 * 与每条插件的 `metadata.category`、版本、描述。这里只读它，不改任何东西，
 * 也不替它编造分类。
 *
 * 读取路径按顺序回退，前一个失败才走下一个：
 *   1. CDN 的 index.json（最快，一次 4~5MB）
 *   2. npm 包 tarball 里的 plugins.json（与市场安装插件同一条链路）
 *
 * 拿到后压成一份尽量小的本地索引（描述截断、丢掉截图与埋点字段），
 * 之后搜索与分页都在内存里做，页面只拿一页，不再整份下发。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, pathsFor, writeJsonAtomic } from './store.mjs'
import { downloadPackage, fetchLimited } from './registry.mjs'
import { compareVersions } from './semver.mjs'

/** 市场目录的分类表。市场新增分类时，同步里会用远端那份覆盖这里。 */
export const CATEGORY_FALLBACK = [
  { id: 'agi', zh: 'AGI 架构探索', en: 'AGI Architecture Exploration' },
  { id: 'ui', zh: 'UI 增强', en: 'UI Enhancements' },
  { id: 'usage', zh: '用量与计费', en: 'Usage & Billing' },
  { id: 'theme', zh: '主题与外观', en: 'Themes & Appearance' },
  { id: 'model', zh: '模型与账号接入', en: 'Models & Providers' },
  { id: 'identity', zh: '身份与通信', en: 'Identity & Communication' },
  { id: 'session', zh: '会话与消息', en: 'Sessions & Messages' },
  { id: 'memory', zh: '记忆', en: 'Memory' },
  { id: 'tools', zh: '工具与能力', en: 'Tools & Capabilities' },
  { id: 'wsl', zh: 'WSL 与 Windows 互操作', en: 'WSL & Windows Interop' },
  { id: 'browser', zh: '浏览器与网页', en: 'Browser & Web' },
  { id: 'vision', zh: '视觉与多模态', en: 'Vision & Multimodal' },
  { id: 'voice', zh: '语音与音频', en: 'Voice & Audio' },
  { id: 'docs', zh: '文档与渲染', en: 'Docs & Rendering' },
  { id: 'skill', zh: '技能包', en: 'Skills' },
  { id: 'workflow', zh: '工作流与自动化', en: 'Workflow & Automation' },
  { id: 'git', zh: 'Git 与代码评审', en: 'Git & Code Review' },
  { id: 'notify', zh: '通知与集成', en: 'Notifications & Integrations' },
  { id: 'dev', zh: '开发与运行时', en: 'Development & Runtime' },
  { id: 'security', zh: '安全与权限', en: 'Security & Permissions' },
  { id: 'remote', zh: '远程与移动端', en: 'Remote & Mobile' },
  { id: 'market', zh: '插件市场与管理', en: 'Marketplace & Management' },
  { id: 'fun', zh: '娱乐', en: 'Fun' },
]

/** 目录来源，按顺序试。 */
export const CATALOG_SOURCES = [
  { id: 'cdn', label: 'jsDelivr', kind: 'json', url: 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json' },
  { id: 'npm', label: 'npm 包', kind: 'package', name: 'dsh-plugin-catalog' },
]

export const PAGE_SIZE_DEFAULT = 20
// 索引里最多留多少条：目录现在约 1.1 万条，留 2 万够用，也不至于被超大目录拖死
const INDEX_LIMIT = 20000
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000

export function catalogPaths(config) {
  const dir = path.join(pathsFor(config).home, 'catalog')
  return { dir, index: path.join(dir, 'market.json') }
}

const text = (value) => (typeof value === 'string' ? value : value && typeof value === 'object' ? String(value.zh || value.en || value.name || value.url || '') : '')

/** 市场目录的分类映射：id -> {zh,en}。 */
export function categoriesOf(raw) {
  const meta = raw && raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : raw
  const fromSource = meta && meta.categories && typeof meta.categories === 'object' ? meta.categories : null
  if (!fromSource) return CATEGORY_FALLBACK.slice()
  const out = []
  for (const [id, value] of Object.entries(fromSource)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(id)) continue
    const title = value && typeof value === 'object' && value.title && typeof value.title === 'object' ? value.title : value
    const zh = text(title && title.zh) || text(value)
    const en = text(title && title.en) || zh
    if (zh) out.push({ id, zh, en })
  }
  // 顺序按内置表来，内置没有的接在后面：市场自己的顺序是声明顺序，这里保持稳定。
  const order = new Map(CATEGORY_FALLBACK.map((item, i) => [item.id, i]))
  out.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
  return out.length ? out : CATEGORY_FALLBACK.slice()
}

function normalizePlugin(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const name = text(raw.name)
  if (!name) return null
  const meta = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}
  const category = text(meta.category) || text(raw.category) || 'other'
  const versions = Array.isArray(raw.versions) ? raw.versions.filter((v) => v && typeof v === 'object') : []
  let latest = ''
  let publishedAt = ''
  for (const item of versions) {
    const v = text(item.version)
    if (!v) continue
    latest = v
    const ts = Number(item.publishTimestamp)
    if (Number.isFinite(ts) && ts > 0) publishedAt = new Date(ts * 1000).toISOString()
  }
  const description = text(raw.description).slice(0, 360)
  const repository = raw.repository && typeof raw.repository === 'object' ? text(raw.repository.url) : text(raw.repository)
  const homepage = text(raw.homepage)
  const keywords = Array.isArray(meta.keywords) ? meta.keywords.filter((k) => typeof k === 'string').slice(0, 8) : []
  return {
    name,
    title: text(raw.title) || name,
    description,
    category,
    keywords,
    version: latest,
    publishedAt,
    homepage,
    repository,
    owner: text(raw.owner),
    rank: index,
  }
}

/** 把任意一份市场目录（CDN 的 index.json 或 npm 包的 plugins.json）压成索引。 */
export function buildIndex(raw, sourceId) {
  const list = raw && Array.isArray(raw.plugins) ? raw.plugins : Array.isArray(raw) ? raw : []
  const plugins = []
  const cap = Math.min(list.length, INDEX_LIMIT)
  for (let i = 0; i < cap; i++) {
    const item = normalizePlugin(list[i], i)
    if (item) plugins.push(item)
  }
  const categories = categoriesOf(raw)
  return {
    builtAt: new Date().toISOString(),
    source: sourceId,
    count: plugins.length,
    categories,
    plugins,
  }
}

const memory = { key: '', data: null }

export function readIndex(config) {
  const { index } = catalogPaths(config)
  let stat
  try { stat = fs.statSync(index) } catch { return null }
  const key = index + ':' + stat.mtimeMs + ':' + stat.size
  if (memory.key === key && memory.data) return memory.data
  try {
    const raw = JSON.parse(fs.readFileSync(index, 'utf8'))
    if (!raw || !Array.isArray(raw.plugins)) return null
    const data = {
      builtAt: raw.builtAt || '',
      source: raw.source || '',
      count: raw.count || raw.plugins.length,
      categories: Array.isArray(raw.categories) && raw.categories.length ? raw.categories : CATEGORY_FALLBACK.slice(),
      plugins: raw.plugins,
    }
    memory.key = key
    memory.data = data
    return data
  } catch {
    return null
  }
}

export function writeIndex(config, index) {
  const { dir, index: file } = catalogPaths(config)
  ensureDir(dir)
  writeJsonAtomic(file, index)
  return file
}

/** 分类 + 计数 + 目录是否就绪（页面首屏只读这个，很轻）。 */
export function catalogSummary(config) {
  const index = readIndex(config)
  const builtAt = index ? index.builtAt : ''
  const built = builtAt ? Date.parse(builtAt) : 0
  const stale = Boolean(built) && Date.now() - built > CACHE_MAX_AGE_MS
  const counts = new Map()
  if (index) {
    for (const plugin of index.plugins) counts.set(plugin.category, (counts.get(plugin.category) || 0) + 1)
  }
  const categories = (index ? index.categories : CATEGORY_FALLBACK).map((item) => ({
    id: item.id,
    label: item.zh,
    en: item.en,
    count: counts.get(item.id) || 0,
  }))
  const total = index ? index.count : 0
  return {
    present: Boolean(index),
    builtAt,
    stale,
    count: total,
    source: index ? index.source : '',
    sourceLabel: (CATALOG_SOURCES.find((s) => s.id === (index && index.source)) || {}).label || '',
    categories,
    total,
    pageSizeDefault: PAGE_SIZE_DEFAULT,
  }
}

async function fetchSource(config, source) {
  if (source.kind === 'json') {
    const buffer = await fetchLimited(source.url, config, { maxBytes: 128 * 1024 * 1024, timeoutMs: 120000, accept: 'application/json' })
    return JSON.parse(buffer.toString('utf8'))
  }
  const downloaded = await downloadPackage(source.name, '', config)
  const entry = downloaded.entries.find((e) => /(^|\/)plugins\.json$/u.test(e.name))
  if (!entry) throw new Error(source.name + ' 里没有 plugins.json')
  return JSON.parse(entry.data.toString('utf8'))
}

/**
 * 拉一次市场目录并落成本地索引。
 * @returns {{ok:boolean, skipped?:boolean, count?:number, source?:string, builtAt?:string, bytes?:number, ms?:number, error?:string}}
 */
export async function syncCatalog(config, options = {}) {
  const started = Date.now()
  const existing = readIndex(config)
  if (!options.force && existing && existing.builtAt) {
    const age = Date.now() - Date.parse(existing.builtAt)
    if (Number.isFinite(age) && age >= 0 && age < (options.maxAgeMs ?? CACHE_MAX_AGE_MS)) {
      return { ok: true, skipped: true, count: existing.count, source: existing.source, builtAt: existing.builtAt, ms: Date.now() - started }
    }
  }
  const errors = []
  for (const source of CATALOG_SOURCES) {
    try {
      if (typeof options.onProgress === 'function') options.onProgress({ stage: 'fetch', source: source.id })
      const raw = await fetchSource(config, source)
      if (typeof options.onProgress === 'function') options.onProgress({ stage: 'build', source: source.id })
      const index = buildIndex(raw, source.id)
      if (index.count === 0) throw new Error('目录里没有插件条目')
      const file = writeIndex(config, index)
      const bytes = (() => { try { return fs.statSync(file).size } catch { return 0 } })(file)
      memory.key = ''
      return { ok: true, count: index.count, source: source.id, builtAt: index.builtAt, bytes, ms: Date.now() - started }
    } catch (error) {
      errors.push(source.id + ': ' + String((error && error.message) || error))
    }
  }
  return { ok: false, error: errors.join('；') || '目录没取到', ms: Date.now() - started }
}

/** 市场式相关度：包名 > 所有者/仓库 > 描述 > 分类名。分词后要求全部命中同一字段。 */
function relevance(plugin, query, tokens, categoryLabels) {
  if (!query) return 0
  const field = (value, weight) => {
    if (!value) return 0
    const text = String(value).toLowerCase()
    if (!tokens.every((token) => text.includes(token))) return 0
    if (text === query) return weight + 300
    if (text.includes(query)) return weight + 200
    return weight + 150
  }
  const byName = field(plugin.name, 40)
  if (byName) return byName
  const byOwner = field(plugin.owner, 20) || field(plugin.repository, 10)
  if (byOwner) return byOwner
  const byDescription = field(plugin.description, 0)
  if (byDescription) return byDescription
  const label = categoryLabels.get(plugin.category) || ''
  return field(label, -10)
}

const compareMarket = (sort) => (a, b) => {
  if (sort === 'new') {
    const ta = Date.parse(a.publishedAt) || 0
    const tb = Date.parse(b.publishedAt) || 0
    if (tb !== ta) return tb - ta
  }
  if (sort === 'name') return a.name.localeCompare(b.name)
  return (a.rank ?? 0) - (b.rank ?? 0)
}

/**
 * 搜一页。
 * 排序：已装优先 → 市场相关度（有搜索词时）→ 市场自己的目录顺序。
 * @returns {{ok:boolean, items:object[], total:number, page:number, pageSize:number, pages:number, hasMore:boolean, categories:object[], builtAt:string, source:string, error?:string}}
 */
export function searchCatalog(config, input = {}) {
  const index = readIndex(config)
  const summary = catalogSummary(config)
  const query = String(input.query || '').trim().toLowerCase()
  const tokens = query.split(/\s+/u).filter(Boolean)
  const category = String(input.category || 'all')
  const sort = ['market', 'new', 'name'].includes(input.sort) ? input.sort : 'market'
  const pageSize = Math.min(100, Math.max(5, Number(input.pageSize) || (Number(config && config.catalogPageSize) || PAGE_SIZE_DEFAULT)))
  const page = Math.max(1, Number(input.page) || 1)
  const installed = Array.isArray(input.installed) ? input.installed : []
  const localVersion = new Map(installed.map((p) => [p.name, p.version || '']))

  if (!index) {
    return {
      ok: false,
      error: '本地还没有市场目录索引，先建立一次（5~30 秒，看网络）。',
      items: [],
      total: 0,
      page,
      pageSize,
      pages: 0,
      hasMore: false,
      categories: summary.categories,
      builtAt: '',
      source: '',
    }
  }

  const categoryLabels = new Map(index.categories.map((c) => [c.id, c.zh + ' ' + c.en]))
  const labelOf = (id) => {
    const hit = index.categories.find((c) => c.id === id)
    if (hit) return hit.zh
    return id === 'other' ? '其它' : id
  }
  const rows = []
  const known = new Set()
  for (const plugin of index.plugins) {
    known.add(plugin.name)
    if (category !== 'all' && plugin.category !== category) continue
    const score = relevance(plugin, query, tokens, categoryLabels)
    if (query && score === 0) continue
    rows.push({ plugin, score, installed: localVersion.has(plugin.name), local: localVersion.get(plugin.name) || '' })
  }
  // 市场目录里没有的本机插件（私有插件、未发布版）照样能被搜到，否则「已装优先」会漏它们
  for (const local of installed) {
    if (!local || !local.name || known.has(local.name)) continue
    const plugin = {
      name: local.name,
      title: local.name,
      description: local.description || '',
      category: local.category || 'other',
      keywords: [],
      version: local.version || '',
      publishedAt: '',
      homepage: '',
      repository: '',
      owner: '',
      rank: Number.MAX_SAFE_INTEGER,
      localOnly: true,
    }
    if (category !== 'all' && plugin.category !== category) continue
    const score = relevance(plugin, query, tokens, categoryLabels)
    if (query && score === 0) continue
    rows.push({ plugin, score, installed: true, local: local.version || '' })
  }
  const marketCompare = compareMarket(sort)
  rows.sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0) || b.score - a.score || marketCompare(a.plugin, b.plugin))

  const total = rows.length
  const pages = Math.ceil(total / pageSize)
  const start = (page - 1) * pageSize
  const items = rows.slice(start, start + pageSize).map(({ plugin, installed: isLocal, local }) => ({
    name: plugin.name,
    title: plugin.title,
    description: plugin.description,
    category: plugin.category,
    categoryLabel: labelOf(plugin.category),
    version: plugin.version,
    publishedAt: plugin.publishedAt,
    homepage: plugin.homepage,
    repository: plugin.repository,
    owner: plugin.owner,
    source: isLocal ? 'profile' : 'market',
    installed: isLocal,
    localVersion: local,
    localOnly: plugin.localOnly === true,
    updateAvailable: Boolean(isLocal && plugin.version && local && compareVersions(plugin.version, local) > 0),
  }))
  return {
    ok: true,
    items,
    total,
    page,
    pageSize,
    pages,
    hasMore: start + items.length < total,
    categories: summary.categories,
    builtAt: index.builtAt,
    source: index.source,
    sort,
  }
}

/** 已装插件在市场目录里属于哪一类（首屏只显示已装时用）。 */
export function categoryMapFor(config, names) {
  const index = readIndex(config)
  const out = {}
  if (!index || !Array.isArray(names)) return out
  const wanted = new Set(names)
  for (const plugin of index.plugins) {
    if (wanted.has(plugin.name) && !out[plugin.name]) out[plugin.name] = plugin.category
  }
  return out
}

/** 按名字取市场条目（首屏给已装插件补上「市场同名版」信息，只读）。 */
export function lookupPlugins(config, names) {
  const index = readIndex(config)
  const out = {}
  if (!index || !Array.isArray(names)) return out
  const wanted = new Set(names)
  for (const plugin of index.plugins) {
    if (!wanted.has(plugin.name) || out[plugin.name]) continue
    out[plugin.name] = {
      name: plugin.name,
      title: plugin.title,
      description: plugin.description,
      category: plugin.category,
      version: plugin.version,
      homepage: plugin.homepage,
      repository: plugin.repository,
    }
  }
  return out
}

