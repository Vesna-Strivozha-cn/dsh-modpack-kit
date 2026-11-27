/**
 * dsh-modpack —— Host 侧。
 *
 * 只做四件事：把本机状况喂给页面、在内存里打包、在安装前把包拆开看清楚、调官方 CLI 装。
 * 所有网络请求走 lib/registry 的白名单与体积上限；所有文件写入落在 <DSH_HOME>/dsh-modpack。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { loadConfig, saveConfig, pathsFor, profileName, readHistory, appendHistory, clearHistory, removeHistory, appendLog, ensureDir, slugify, DEFAULT_CONFIG } from './lib/store.mjs'
import { listInstalled, dshVersion, readProfilePackage, readBundles } from './lib/profile.mjs'
import { downloadPackage, npmMetadata, pickVersion, fetchLimited, relativeTime, probeRegistry } from './lib/registry.mjs'
import { buildPack, PackRefused } from './lib/pack.mjs'
import { inspectPackBuffer, installPack, readPackFromUrl, InstallRefused } from './lib/install.mjs'
import { checkCompatibility } from './lib/compat.mjs'
import { readMarketGroups, groupViews } from './lib/groups.mjs'
import { classifyPlugin } from './lib/classify.mjs'
import { groupFindings } from './lib/scan.mjs'
import { catalogSummary, searchCatalog, syncCatalog, categoryMapFor, lookupPlugins } from './lib/market-catalog.mjs'
import { marketSummary, searchMarket, syncMarket, findMarketPack, fetchMarketPack } from './lib/modpack-catalog.mjs'
import { parseYaml } from './lib/yamlish.mjs'
import { readPatch } from './lib/profile.mjs'
import { buildReadme } from './lib/manifest.mjs'
import { sendJson as json, readBody, readRawBody, readJsonBody, MAX_JSON_BODY, MAX_DROP_BODY } from './lib/http.mjs'

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0.0.0' } catch { return '0.0.0' }
})()
const PENDING_TTL = 30 * 60 * 1000
const PENDING_MAX = 4
const PENDING_BYTES = 512 * 1024 * 1024


export default {
  name: 'dsh-modpack-kit',
  inject: ['webServer'],
  apply(ctx) {
    let config = loadConfig()
    let pending = new Map()
    const disposers = []
    const log = (...args) => { try { console.log('[dsh-modpack-kit]', ...args) } catch {} }

    const profileDir = () => pathsFor(config).profile

    const snapshot = () => {
      const dir = profileDir()
      let installed = []
      let version = ''
      let bundles = []
      let error = ''
      try {
        installed = listInstalled(dir)
        version = dshVersion(dir)
        bundles = readBundles(readProfilePackage(dir))
      } catch (e) {
        error = String((e && e.message) || e)
      }
      let catalog = null
      try { catalog = catalogSummary(config) } catch {}
      // 词条分类以插件市场为准；市场目录里没有的（本机私有插件）才退回本地猜测
      let marketCategories = {}
      try { marketCategories = categoryMapFor(config, installed.map((p) => p.name)) } catch {}
      // 只列 profile 直接声明的插件；插件自带的内部子包由父包带进来，单独列出会被重复打包
      const direct = installed.filter((p) => p.isPlugin && p.isDirect)
      // 插件市场的分组（只读人家 profile 下的 state.json）：整理信息，不决定启用状态
      let groups = []
      let ungrouped = direct.map((p) => p.name)
      let groupSource = 'none'
      try {
        const market = readMarketGroups(dir)
        const views = groupViews(direct, market)
        // 分组只用来整理与批量勾选，不再在组头算兼容：装之前的兼容检查有单独的列表
        groups = views.groups.map((group) => ({ name: group.name, members: group.members, missing: group.missing }))
        ungrouped = views.ungrouped
        groupSource = market.present ? 'market' : 'none'
      } catch {}
      return {
        ok: !error,
        error,
        version,
        platform: process.platform,
        node: process.version,
        electron: process.versions.electron || '',
        dshVersion: version,
        pluginVersion: VERSION,
        profile: profileName(config),
        paths: pathsFor(config),
        catalog,
        // 社区资源（自建目录）：只读缓存，界面拿摘要与首页；真正的搜索走 /market/search
        modpackMarket: (() => {
          try { return marketSummary(config) } catch { return { present: false, stale: true, count: 0, categories: [], repo: '' } }
        })(),
        placements: {
          settings: config.showInSettings !== false,
          sidebar: config.showInSidebar !== false,
          pluginsTab: config.showInPluginsTab === true,
        },
        installedTotal: installed.length,
        // 插件自带的内部子包（由父包依赖一起装进来）与残留包不单独列；只给数字，界面上说明一句
        installedHidden: installed.filter((p) => p.isPlugin && !p.isDirect).length,
        installedOrphans: installed.filter((p) => !p.isDirect && p.isOrphan).length,
        // 只列 profile 直接声明的插件；插件自带的内部子包（如壁纸引擎的 fonts/fx/glass…）由父包带进来，
        // 单独列出来会被重复打包、重复安装。
        installed: direct.map((p) => ({
          name: p.name,
          version: p.version,
          description: p.description || '',
          category: marketCategories[p.name] || classifyPlugin({ name: p.name, description: p.description || '' }).id,
          dirName: p.dirName,
          isBundle: p.isBundle,
          hasClient: p.hasClient,
          hasPatch: p.hasPatch,
          size: p.size,
        })),
        // 插件市场的分组：只是「哪些插件一起看」的整理信息，默认勾选逻辑完全不变
        groups,
        ungrouped,
        groupSource,
        market: (() => {
          const hit = installed.find((p) => p.name === 'dshmarket' || p.name === '@dsh-market/client')
          return { installed: Boolean(hit), name: hit ? hit.name : 'dshmarket', version: hit ? hit.version : '' }
        })(),
        bundled: bundles,
        config,
        defaults: DEFAULT_CONFIG,
        history: readHistory().slice(-12).reverse(),
      }
    }

    function trusted(req) {
      const host = String(req.headers?.host ?? '').toLowerCase()
      const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      if (h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1') return true
      try {
        const conn = ctx.get('connection')
        if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
      } catch {}
      return false
    }

    function fenced(req, res) {
      if (!trusted(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return true }
      try {
        const conn = ctx.get('connection')
        if (conn && typeof conn.requestRejection === 'function') {
          const code = conn.requestRejection(req)
          if (code !== undefined && code !== null && code !== false) {
            res.statusCode = typeof code === 'number' ? code : 403
            res.end()
            return true
          }
        }
      } catch {}
      return false
    }

    function route(pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          if (fenced(req, res)) return
          try {
            await handler(req, res)
          } catch (error) {
            const code = error && error.statusCode ? error.statusCode : 500
            try { json(res, code, { ok: false, error: String((error && error.message) || error) }) } catch {}
          }
        },
      }))
    }

    const needPost = (req, res) => {
      if (req.method === 'POST') return true
      json(res, 405, { ok: false, error: '只接受 POST' })
      return false
    }

    function pendingBytes() {
      let total = 0
      for (const item of pending.values()) total += item.buffer ? item.buffer.length : 0
      return total
    }

    function rememberPending(fileName, payload) {
      const size = payload && payload.buffer ? payload.buffer.length : 0
      // 按条数与总字节双重淘汰：4 个 256MB 的包不该常驻 1GB
      while (pending.size > 0 && (pending.size >= PENDING_MAX || pendingBytes() + size > PENDING_BYTES)) {
        const oldest = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        pending.delete(oldest[0])
      }
      const token = randomBytes(12).toString('hex')
      pending.set(token, { at: Date.now(), fileName, ...payload })
      return token
    }

    function sweeper() {
      const now = Date.now()
      for (const [token, item] of pending) if (now - item.at > PENDING_TTL) pending.delete(token)
    }

    // 读 profile 里的插件清单要遍历几百个包的 package.json，刷新时连着调十几次很慢：
    // 这里按 profile 目录的 mtime 记住上一次结果，目录没变就直接复用（插件增删会改 mtime）
    let installedMemo = { key: '', at: 0, value: [] };
    const installedOrEmpty = () => {
      let key = '';
      try {
        const dir = profileDir();
        const stat = fs.statSync(path.join(dir, 'package.json'));
        key = dir + '|' + stat.mtimeMs + '|' + stat.size;
      } catch { key = ''; }
      const now = Date.now();
      if (key && installedMemo.key === key && now - installedMemo.at < 5000) return installedMemo.value;
      let value = [];
      try { value = listInstalled(profileDir()) } catch { value = []; }
      installedMemo = { key, at: now, value };
      return value;
    };

    // 三种策略能不能选：按「这次勾了哪些插件」实时算，客户端拿去做卡片灰显与原因弹窗；
    // 打包时也再算一遍，挡住「界面上换了插件、策略却没跟着变」的情况。
    const computePlan = (selection) => {
      const installed = installedOrEmpty()
      // spec 可能是 名字@版本，也可能是纯版本；统一抠出版本号再判能不能按版本装
      const versionOf = (item, entry) => {
        const spec = String(item.spec || '')
        const fromSpec = spec.includes('@') && !spec.startsWith('@') ? spec.slice(spec.lastIndexOf('@') + 1) : spec
        const candidates = [item.version, fromSpec, entry && entry.version]
        for (const value of candidates) {
          const text = String(value || '')
          if (/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(text) && text !== '0.0.0') return text
        }
        return ''
      }
      const rows = selection.map((item) => {
        const name = String(item.name || '')
        const entry = installed.find((p) => p.name === name)
        const version = versionOf(item, entry)
        const local = Boolean(entry)
        const market = item.source === 'npm' || item.source === 'market'
        const custom = item.choice === 'custom'
        return { name, version, semver: Boolean(version), local, market, custom }
      })
      const noCode = rows.filter((r) => !r.local && r.market)
      const noVersion = rows.filter((r) => !r.semver)
      const customRows = rows.filter((r) => r.custom)
      const names = (list) => list.slice(0, 6).map((r) => r.name).join('、') + (list.length > 6 ? ' 等 ' + list.length + ' 个' : '')
      const liteBlockers = []
      if (noVersion.length) liteBlockers.push({ kind: 'version', text: '这些插件没有确定的版本号，安装时找不到对应的包：' + names(noVersion) })
      if (customRows.length) liteBlockers.push({ kind: 'config', text: '给这些插件选了「自定义配置」，轻量包只记版本、带不走配置与数据：' + names(customRows) + '（改回「插件预设」，或换完整包 / 混合包）' })
      const hybridBlockers = []
      const noCodeNoVersion = noVersion.filter((r) => !r.local)
      if (noCodeNoVersion.length) hybridBlockers.push({ kind: 'version', text: '这些插件没有确定的版本号，本机又没装、取不到代码：' + names(noCodeNoVersion) })
      const strategies = [
        {
          id: 'full',
          title: '完整包（懒人包）',
          online: false,
          ok: true,
          reason: '',
          blockers: [],
          note: '插件本体一起装进包，不联网也能装；有网时优先按市场版本装（profile 依赖是 ^版本，插件市场认成市场版），离线才退回包内副本、显示本地安装。允许带自定义配置与数据。',
        },
        {
          id: 'lite',
          title: '轻量包（轻量包）',
          online: true,
          ok: liteBlockers.length === 0,
          reason: liteBlockers.map((b) => b.text).join('；'),
          blockers: liteBlockers,
          note: '只记 名字@版本，体积最小；安装时必须联网从市场取包，不带自定义配置与数据。',
        },
        {
          id: 'hybrid',
          title: '混合包（轻量为主 + 必要的完整）',
          online: true,
          ok: hybridBlockers.length === 0,
          reason: hybridBlockers.map((b) => b.text).join('；'),
          blockers: hybridBlockers,
          note: '能按版本装的就只记 名字@版本（安装时联网取包）；没有确定版本、或者要带走本机改动的插件，连代码一起打进来（这部分安装时不用联网）。配置/数据/补丁片段照样带。',
        },
      ]
      if (noCode.length > 0) strategies[0].note += '（其中 ' + names(noCode) + ' 本机没有代码，打包时要联网取一次）'
      return { strategies, plugins: rows, counts: { selected: rows.length, custom: customRows.length, noVersion: noVersion.length, localOnly: rows.filter((r) => r.local).length } }
    }

    const compatFor = (manifest) => checkCompatibility(manifest.plugins, {
      format: manifest && manifest.format,
      installed: installedOrEmpty(),
      dshVersion: (() => { try { return dshVersion(profileDir()) } catch { return '' } })(),
      nodeVersion: process.versions.node,
      config,
    })

    // —— 概览 ——
    route('/dsh-modpack-kit/api/status', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false }); return }
      json(res, 200, snapshot())
    })

    // —— 设置 ——
    route('/dsh-modpack-kit/api/settings', async (req, res) => {
      if (req.method === 'GET') { json(res, 200, { ok: true, config, defaults: DEFAULT_CONFIG }); return }
      if (!needPost(req, res)) return
      const body = await readJsonBody(req, null)
      if (!body || typeof body !== 'object') { json(res, 400, { ok: false, error: '请求体不是对象' }); return }
      const patch = body.patch && typeof body.patch === 'object' ? body.patch : body
      const next = { ...config }
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key]
      }
      // 三处显示位全关 = 插件没有入口了，拦掉
      if (next.showInSettings === false && next.showInSidebar === false && next.showInPluginsTab === false) {
        json(res, 400, { ok: false, error: '三处显示至少留一处，否则就没有入口能关回来了' })
        return
      }
      config = saveConfig(next)
      json(res, 200, { ok: true, config })
    })

    // —— 插件目录：分类、词条、分页搜索都照插件市场的来 ——
    // 首屏只要「已装 + 分类」，不再整份目录下发；搜索走服务端分页，一次一页。
    route('/dsh-modpack-kit/api/catalog', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false }); return }
      const installedList = installedOrEmpty().filter((p) => p.isPlugin && p.isDirect).map((p) => ({
        name: p.name, version: p.version, isBundle: p.isBundle, hasClient: p.hasClient, description: p.description || '',
      }))
      let catalog = null
      try { catalog = catalogSummary(config) } catch (e) { catalog = { present: false, error: String((e && e.message) || e) } }
      json(res, 200, { ok: true, catalog, installed: installedList, categories: catalog ? catalog.categories : [] })
    })

    route('/dsh-modpack-kit/api/catalog/status', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false }); return }
      try {
        const summary = catalogSummary(config)
        // 没有或者过期了就在后台自己去补，不让页面等
        if (!summary.present || summary.stale) ensureCatalog(false)
        json(res, 200, { ok: true, ...summary, pageSize: config.catalogPageSize, refreshHours: config.catalogRefreshHours })
      } catch (e) {
        json(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    })

    route('/dsh-modpack-kit/api/catalog/lookup', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const names = Array.isArray(body.names) ? body.names.filter((n) => typeof n === 'string').slice(0, 400) : []
      try {
        json(res, 200, { ok: true, items: lookupPlugins(config, names) })
      } catch (e) {
        json(res, 200, { ok: false, error: String((e && e.message) || e), items: {} })
      }
    })

    route('/dsh-modpack-kit/api/catalog/sync', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const hours = Math.max(1, Number(config.catalogRefreshHours) || 24)
      const result = await syncCatalog(config, { force: body.force === true, maxAgeMs: hours * 3600 * 1000 })
      if (result.ok && !result.skipped) appendLog(`目录同步 ${result.count} 条（${result.source}，${Math.round((result.ms || 0) / 100) / 10}s）`)
      json(res, result.ok ? 200 : 502, { ...result, catalog: (() => { try { return catalogSummary(config) } catch { return null } })() })
    })

    // 同一个词来回翻页、切分类时不必重算：结果只跟目录、已装清单和参数有关，留 20 秒
    const searchCache = new Map()
    route('/dsh-modpack-kit/api/catalog/search', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const localPlugins = installedOrEmpty().filter((p) => p.isPlugin && p.isDirect)
      const localCategories = categoryMapFor(config, localPlugins.map((p) => p.name))
      const installed = localPlugins.map((p) => ({
        name: p.name, version: p.version, description: p.description || '',
        // 和市场侧统一用同一套 23 类，否则按 theme/memory 筛时本机独有的插件会被漏掉
        category: localCategories[p.name] || classifyPlugin({ name: p.name, description: p.description || '' }).id,
      }))
      const cacheKey = JSON.stringify([body.query || '', body.category || 'all', Number(body.page) || 1, Number(body.pageSize) || 0, body.sort || '', installed.length])
      const cached = searchCache.get(cacheKey)
      if (cached && Date.now() - cached.at < 20000) {
        json(res, 200, cached.data)
        return
      }
      try {
        const data = searchCatalog(config, {
          query: body.query,
          category: body.category,
          page: body.page,
          pageSize: body.pageSize,
          sort: body.sort,
          installed,
        })
        searchCache.set(cacheKey, { at: Date.now(), data })
        if (searchCache.size > 40) searchCache.delete(searchCache.keys().next().value)
        json(res, 200, data)
      } catch (e) {
        json(res, 500, { ok: false, error: String((e && e.message) || e), items: [] })
      }
    })

    // —— 社区资源（自建目录） ——
    // 只做三件事：读目录、检索、取包；校验/扫描/安装全部复用 /inspect 与 /install 那条老路。
    route('/dsh-modpack-kit/api/market', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false }); return }
      let summary = null
      try { summary = marketSummary(config) } catch (e) { summary = { present: false, stale: true, count: 0, categories: [], error: String((e && e.message) || e) } }
      // 没目录、或过期了：后台自己去拉，页面先拿空壳（首屏不该被网络拖住）
      if (!summary.present || summary.stale) ensureMarket(false)
      const installed = new Set(installedOrEmpty().filter((p) => p.isPlugin).map((p) => p.name))
      let first = { items: [], total: 0, hasMore: false }
      if (summary.present) {
        try {
          first = searchMarket(config, { page: 1, pageSize: config.catalogPageSize, installed })
        } catch (e) { first = { items: [], total: 0, hasMore: false, error: String((e && e.message) || e) } }
      }
      json(res, 200, { ok: true, summary, ...first, page: 1, pageSize: config.catalogPageSize })
    })

    // 社区资源的检索同样按 key 缓存 20 秒：连按几个键不该每次都重新打分
    const marketSearchCache = new Map()
    route('/dsh-modpack-kit/api/market/search', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const installed = installedOrEmpty().filter((p) => p.isPlugin).map((p) => p.name)
      const cacheKey = JSON.stringify([body.query || '', body.category || 'all', body.sort || 'new', body.page || 1, body.pageSize || 20, installed.length])
      const cached = marketSearchCache.get(cacheKey)
      if (cached && Date.now() - cached.at < 20000) { json(res, 200, cached.data); return }
      try {
        const data = searchMarket(config, {
          query: body.query,
          category: body.category,
          page: body.page,
          pageSize: Number(body.pageSize) || config.catalogPageSize,
          sort: body.sort,
          installed,
        })
        marketSearchCache.set(cacheKey, { at: Date.now(), data })
        if (marketSearchCache.size > 40) marketSearchCache.delete(marketSearchCache.keys().next().value)
        json(res, 200, data)
      } catch (e) {
        json(res, 200, { ok: false, error: String((e && e.message) || e), items: [], total: 0 })
      }
    })

    route('/dsh-modpack-kit/api/market/sync', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      try {
        const result = await syncMarket(config, { force: body.force === true || config.modpackRefreshHours === 0 })
        if (result.ok && !result.skipped) appendLog('modpack market synced: ' + result.count + ' packs / ' + result.source)
        const installed = installedOrEmpty().filter((p) => p.isPlugin).map((p) => p.name)
        const first = result.ok ? searchMarket(config, { page: 1, pageSize: config.catalogPageSize, installed }) : null
        json(res, 200, { ok: result.ok, error: result.error || '', summary: marketSummary(config), ...(first || { items: [], total: 0, hasMore: false }) })
      } catch (e) {
        json(res, 200, { ok: false, error: String((e && e.message) || e) })
      }
    })

    // 下载一个整合包：只认目录里登记过的条目，sha256 必须对得上，
    // 下完直接在内存里交给原来的 inspect（安全检测、兼容、许可证那一套原样走）。
    route('/dsh-modpack-kit/api/market/download', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const found = findMarketPack(config, body.id)
      if (!found.ok) { json(res, 200, { ok: false, error: found.error }); return }
      const pack = found.pack
      try {
        const fetched = await fetchMarketPack(config, pack)
        const bytes = fetched.buffer
        if (pack.size > 0 && bytes.length !== pack.size) {
          throw new Error('包体积和目录里登记的不一致（登记 ' + pack.size + ' 字节，实际 ' + bytes.length + ' 字节）')
        }
        const actual = createHash('sha256').update(bytes).digest('hex')
        if (pack.sha256 && actual !== pack.sha256) {
          throw new Error('sha256 对不上：目录登记 ' + pack.sha256.slice(0, 12) + '…，实际 ' + actual.slice(0, 12) + '…')
        }
        const inspected = inspectPackBuffer(bytes, {
          config,
          force: body.force === true,
          scanBeforeInstall: config.scanBeforeInstall !== false,
          extraScanRules: Array.isArray(config.extraScanRules) ? config.extraScanRules : [],
        })
        const fileName = slugify(inspected.manifest.name || pack.id, 'pack') + '.dshpack'
        const token = rememberPending(fileName, { buffer: bytes, manifest: inspected.manifest, report: inspected.report, scan: inspected.scan })
        appendLog('market download ' + pack.id + ' ' + bytes.length + ' bytes')
        json(res, 200, {
          ok: true,
          token,
          fileName,
          size: bytes.length,
          packId: pack.id,
          packName: pack.name,
          url: fetched.url,
          manifest: inspected.manifest,
          integrity: inspected.integrity,
          scan: inspected.scan,
          scanGroups: groupFindings(inspected.scan.findings, inspected.manifest.plugins),
          report: inspected.report,
          blockingReasons: inspected.blockingReasons,
          notes: inspected.notes,
          compat: compatFor(inspected.manifest),
        })
      } catch (e) {
        json(res, 200, { ok: false, error: String((e && e.message) || e) })
      }
    })


    // —— 查某个包的可用版本 ——
    route('/dsh-modpack-kit/api/versions', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const name = String(body.name || '')
      try {
        const { meta, registry } = await npmMetadata(name, config, { full: true })
        const versions = Object.keys((meta && meta.versions) || {})
          .map((v) => ({ version: v, time: (meta.time && meta.time[v]) || '', deprecated: Boolean(meta.versions[v] && meta.versions[v].deprecated) }))
          .reverse()
        json(res, 200, { ok: true, name, registry, versions: versions.slice(0, 60), relative: relativeTime })
      } catch (e) {
        json(res, 200, { ok: false, error: String((e && e.message) || e) })
      }
    })

    // —— 打包（支持后台任务：左下角悬浮窗要进度，且允许同时打多个包） ——
    const jobs = new Map()
    let jobSeq = 0
    // 任务记录默认留到 DSH 下次启动（或点「清空进程」），切页面、换入口都不丢。
    // 设置里给 jobKeepSeconds 正数才按秒自动清；0 = 不按时间清。
    const FAILED_KEEP = 15 * 1000
    const RUNNING_STALE = 10 * 60 * 1000
    const keepMs = () => {
      const seconds = Number(config.jobKeepSeconds)
      return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
    }
    const heartbeatAge = (job, now) => {
      const stamp = Date.parse(job.updatedAt || job.finishedAt || job.startedAt || '') || 0
      return stamp > 0 ? now - stamp : 0
    }
    // 卡住的 running（进程还在但心跳没了）：标成失败，让它走失败那条清理路径
    const reapStuck = (job, now) => {
      if (job.status !== 'running') return
      if (heartbeatAge(job, now) <= RUNNING_STALE) return
      job.status = 'failed'
      job.error = '卡住了：很久没有新进度，已自动收掉'
      job.note = '已自动收掉'
      job.finishedAt = new Date().toISOString()
      job.updatedAt = job.finishedAt
    }
    const pruneJobs = () => {
      const now = Date.now()
      const keep = keepMs()
      for (const [id, job] of jobs) {
        reapStuck(job, now)
        // 停在风险点等你决定的，一直留着
        if (job.status === 'paused') continue
        if (job.status === 'running') continue
        // keep === 0：一直留到重启或手动清空（主人要求切界面、退出面板都不丢）
        if (keep <= 0) continue
        const age = heartbeatAge(job, now)
        const limit = job.status === 'done' || job.status === 'acked' ? keep : Math.min(keep, FAILED_KEEP)
        if (age > limit) jobs.delete(id)
      }
      for (const id of [...jobs.keys()]) {
        if (jobs.size <= 200) break
        const job = jobs.get(id)
        if (job.status === 'running' || job.status === 'paused') continue
        jobs.delete(id)
      }
    }
    const createJob = (kind, label) => {
      const job = {
        id: 'job_' + (++jobSeq).toString(36) + '_' + Date.now().toString(36),
        kind,
        label,
        status: 'running',
        pct: 0,
        note: '准备中',
        startedAt: new Date().toISOString(),
        // 最近一次有动静的时间：用来判断「还活着」还是「卡住了」
        updatedAt: new Date().toISOString(),
        finishedAt: '',
        error: '',
        data: null,
        // 风险停下来的任务：保留原始请求，等你选「立即停止」还是「我知道在干什么」
        risk: null,
        body: null,
      }
      jobs.set(job.id, job)
      pruneJobs()
      return job
    }
    const publicJob = (job) => ({
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      pct: job.pct,
      note: job.note,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      data: job.data,
      risk: job.risk,
      // 只有「可确认继续」的风险任务才给「我知道在干什么」；停下来的任务都能删
      canAck: Boolean(job.risk && job.risk.needsAck && job.status === 'paused'),
      canDismiss: job.status !== 'running',
    })

    class JobCancelled extends Error {}
    const performPack = async (body, job, resume = null) => {
      const selection = Array.isArray(body.selection) ? body.selection : []
      const options = body.options && typeof body.options === 'object' ? body.options : {}
      const dir = profileDir()
      const installed = installedOrEmpty()
      const dshVersionNow = (() => { try { return dshVersion(dir) } catch { return '' } })()
      // 市场目录里能查到的插件：风险项默认放行，但需调用方 acknowledge
      let trusted = []
      try {
        const look = lookupPlugins(config, selection.map((item) => String(item.name || '')).filter(Boolean))
        trusted = Object.keys(look || {})
      } catch { trusted = [] }
      const onProgress = (event) => {
        if (!job) return
        if (job.cancelled) throw new JobCancelled('已取消')
        job.pct = event.pct
        job.note = event.note || job.note
      }
      try {
        const result = await buildPack({
          selection: selection.map((item) => {
            const name = String(item.name || '')
            const entry = installed.find((p) => p.name === name)
            if (entry && entry.isDirect === false) {
              // 插件自带的内部子包（例如壁纸引擎的 fonts/fx/glass…）会随父包一起装，
              // 单独打包会让它被重复安装；既没人声明、也不在依赖树里的残包同理不单独打。
              const why = entry.transitiveOf
                ? '是「' + entry.transitiveOf + '」的内部组件，会随父包一起装上'
                : '不在 profile 的依赖清单里（像是删插件后留下的残包），重新装一次它所属的插件即可'
              throw new Error('「' + name + '」' + why + '，不能单独打包')
            }
            const here = Boolean(entry)
            // 市场里没装的插件也能打包：本机没有这份代码，就从 registry 按版本取包
            const source = item.source === 'npm' || item.source === 'market' || !here ? 'npm' : 'profile'
            // 每个插件自带「插件预设 / 自定义配置」：自定义 = 带本机配置与数据快照，
            // 本机来源的还连带本机代码改动（旧字段 mode 的 local）。老客户端只发 mode 也认。
            const choice = item.choice === 'preset' || item.choice === 'custom'
              ? item.choice
              : item.configMode === 'preset' || item.mode === 'base' || item.mode === 'preset'
                ? 'preset'
                : item.configMode === 'custom' || item.mode === 'local' || item.mode === 'custom'
                  ? 'custom'
                  : (source === 'profile' ? 'custom' : 'preset')
            return {
              name,
              source,
              spec: item.spec ? String(item.spec) : (source === 'npm' ? String(item.version || '') : ''),
              mode: choice === 'custom' ? 'local' : 'base',
              configMode: choice,
              group: item.group ? String(item.group).slice(0, 40) : '',
              download: (spec) => downloadPackage(name, spec || item.spec || String(item.version || ''), config),
            }
          }),
          options: {
            strategy: (() => {
              const raw = String(options.strategy || options.format || '').toLowerCase()
              if (raw === 'lite' || raw === 'hybrid' || raw === 'full') return raw
              return options.includePayload === false ? 'lite' : 'full'
            })(),
            includePayload: options.includePayload !== false,
            includeConfig: options.includeConfig !== false,
            includeLocalEdits: options.includeLocalEdits === true,
            confirmLicense: options.confirmLicense === true,
            force: options.force === true,
            acknowledge: options.acknowledge === true,
            trusted,
            keepLocal: options.keepLocal !== false,
            scanBeforePack: true,
            onProgress,
            name: String(options.name || 'DSH 整合包'),
            description: String(options.description || ''),
            author: String(options.author || ''),
            license: String(options.license || ''),
            homepage: String(options.homepage || ''),
            extensions: options.extensions && typeof options.extensions === 'object' ? options.extensions : {},
            resume: resume && typeof resume === 'object' ? resume : null,
          },
          context: {
            config,
            profileDir: dir,
            dshVersion: dshVersionNow,
            installed,
            pluginVersion: VERSION,
            extraScanRules: Array.isArray(config.extraScanRules) ? config.extraScanRules : [],
            parsePatch: parseYaml,
            patchText: readPatch(dir),
          },
        })
        const token = rememberPending(result.fileName, { buffer: result.buffer, manifest: result.manifest, report: result.report, scan: result.scan })
        appendHistory({ at: new Date().toISOString(), kind: 'pack', name: result.manifest.name, format: result.manifest.format, plugins: result.manifest.plugins.map((p) => p.name + '@' + p.version), size: result.size, high: result.scan.counts.high }, config.historyLimit)
        return {
          ok: true,
          token,
          fileName: result.fileName,
          size: result.size,
          manifest: result.manifest,
          scan: result.scan,
          scanGroups: result.scanGroups,
          report: result.report,
          notes: result.notes,
          compat: checkCompatibility(result.manifest.plugins, { installed, dshVersion: dshVersionNow, nodeVersion: process.versions.node, config, format: result.manifest && result.manifest.format }),
        }
      } catch (error) {
        if (error instanceof JobCancelled) {
          // 取消发生在内存里：没有写入任何文件，直接丢弃缓冲
          return { ok: false, cancelled: true, error: '已取消（未生成文件，本地没有残留）' }
        }
        if (error instanceof PackRefused) {
          const scanGroups = (() => { try { return error.scan ? groupFindings(error.scan.findings, (selection || []).map((item) => ({ name: String(item.name || '') }))) : [] } catch { return [] } })()
          return {
            ok: false,
            refused: true,
            needsAck: error.needsAck === true,
            trustedOnly: error.trustedOnly === true,
            error: error.message,
            scan: error.scan,
            scanGroups,
            checkpoint: error.checkpoint || null,
          }
        }
        return { ok: false, error: String((error && error.message) || error) }
      }
    }

    // 任务收尾：只有「能确认继续」的风险才停下等你点一下；其余情况照旧判失败
    const finishPackJob = (job, payload) => {
      if (payload && payload.ok !== true && payload.refused === true) {
        const counts = (payload.scan && payload.scan.counts) || {}
        job.risk = {
          high: counts.high || 0,
          medium: counts.medium || 0,
          low: counts.low || 0,
          needsAck: payload.needsAck === true,
          trustedOnly: payload.trustedOnly === true,
          message: payload.error || '检测到风险',
          // 只留分组摘要，不给界面塞整份 findings
          groups: Array.isArray(payload.scanGroups)
            ? payload.scanGroups.map((g) => ({
              plugin: g.plugin || '',
              label: g.label,
              origin: g.origin,
              counts: g.counts,
              samples: Array.isArray(g.findings)
                ? g.findings.slice(0, 4).map((f) => ({ label: f.label, severity: f.severity, file: f.file, line: f.line }))
                : [],
            }))
            : [],
        }
        job.finishedAt = new Date().toISOString()
        job.updatedAt = job.finishedAt
        if (payload.needsAck === true) {
          job.status = 'paused'
          job.note = '检测到风险，等你决定'
          job.pct = Math.min(job.pct || 0, 66)
          job.checkpoint = payload.checkpoint || null
        } else {
          // 市场目录里查不到：没有「我知道在干什么」这条路，直接判失败
          job.status = 'failed'
          job.error = payload.error || '检测到风险'
          job.note = '检测到风险，已拒绝出包'
          job.data = payload
        }
        return
      }
      job.status = payload && payload.ok ? 'done' : payload && payload.cancelled === true ? 'cancelled' : 'failed'
      job.data = payload
      job.pct = payload && payload.ok ? 100 : job.pct
      job.note = payload && payload.ok ? '完成' : ((payload && payload.error) || '已停止')
      // 失败/取消也把原因放进 error，进度窗那一行能直接看到为什么卡住
      if (!(payload && payload.ok)) job.error = (payload && payload.error) || job.note
      job.finishedAt = new Date().toISOString()
      job.updatedAt = job.finishedAt
    }
    const startPackJob = (body, label) => {
      const job = createJob('pack', label || ('打包「' + String((body.options && body.options.name) || 'DSH 整合包') + '」'))
      // 留一份原始请求：风险停下来之后，界面上点「我知道在干什么」要能照原样再跑一次
      try {
        job.body = JSON.parse(JSON.stringify({
          selection: Array.isArray(body.selection) ? body.selection : [],
          options: body.options && typeof body.options === 'object' ? body.options : {},
        }))
      } catch { job.body = null }
      // 烟测用：假 ctx 里整包是同步 CPU 活，会在微任务里一口气跑完，
      // 「正在跑的任务不能删」这类用例没有观察窗口。仅当显式设了环境变量才延后开跑。
      const testDelay = Number(process.env.DSH_MODPACK_TEST_JOB_DELAY_MS || 0)
      const run = testDelay > 0
        ? new Promise((resolve) => setTimeout(resolve, testDelay)).then(() => performPack(body, job))
        : performPack(body, job)
      run
        .then((payload) => finishPackJob(job, payload))
        .catch((error) => {
          job.status = 'failed'
          job.error = String((error && error.message) || error)
          job.note = '失败'
          job.finishedAt = new Date().toISOString()
          job.updatedAt = job.finishedAt
        })
      return job
    }

    // 三种打包策略能不能选：客户端据此把卡片画成可点/灰掉，灰掉时给出原因。
    route('/dsh-modpack-kit/api/pack/plan', async (req, res) => {
      if (!needPost(req, res)) return
      {
        const body = await readJsonBody(req)
        const selection = Array.isArray(body.selection) ? body.selection : []
        if (selection.length === 0) return json(res, 400, { ok: false, error: '还没选插件' })
        return json(res, 200, { ok: true, ...computePlan(selection) })
      }
    })

    route('/dsh-modpack-kit/api/pack', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const selection = Array.isArray(body.selection) ? body.selection : []
      if (selection.length === 0) { json(res, 400, { ok: false, error: '没有选择任何插件' }); return }
      const strategy = String((body.options && body.options.strategy) || 'full')
      if (strategy === 'lite' || strategy === 'hybrid') {
        const plan = computePlan(selection)
        const chosen = plan.strategies.find((entry) => entry.id === strategy)
        if (chosen && chosen.ok === false) {
          json(res, 400, { ok: false, error: '这个打包策略现在不适用：' + chosen.reason, plan })
          return
        }
      }
      if (body.async === true || body.background === true) {
        const job = startPackJob(body)
        json(res, 200, { ok: true, async: true, job: publicJob(job) })
        return
      }
      const payload = await performPack(body, null)
      json(res, 200, payload)
    })

    // 风险停下来之后：只有「我知道在干什么」，点它就在同一个任务里接着跑完
    route('/dsh-modpack-kit/api/jobs/ack', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const job = jobs.get(String(body.id || ''))
      if (!job) { json(res, 404, { ok: false, error: '没有这个任务（可能已完成并过期）' }); return }
      if (!job.risk) { json(res, 400, { ok: false, error: '这个任务没有风险项，不需要确认' }); return }
      if (job.risk.needsAck !== true) { json(res, 400, { ok: false, error: '这些风险不在插件市场目录里，没法确认继续' }); return }
      if (job.status === 'running') { json(res, 409, { ok: false, error: '任务还在跑，等它到风险点再说' }); return }
      if (job.status !== 'paused') { json(res, 400, { ok: false, error: '这个任务已经收尾了，不能再确认' }); return }
      // 同一个任务接着跑：复用停下来的那份检测结果，进度从检测点继续，不重新检测
      const checkpoint = job.checkpoint || null
      job.checkpoint = null
      job.status = 'running'
      job.cancelled = false
      job.acked = true
      // 确认过了就不该再吓人：红字（risk）撤掉，只留 status 与进度
      job.risk = null
      job.error = ''
      job.note = checkpoint ? '已确认风险，从检测点继续' : '已确认风险，继续完成'
      job.pct = Math.min(job.pct || 0, 66)
      job.finishedAt = ''
      const source = job.body || { selection: [] }
      const replay = { selection: source.selection || [], options: { ...(source.options || {}), acknowledge: true } }
      performPack(replay, job, checkpoint)
        .then((payload) => finishPackJob(job, payload))
        .catch((error) => {
          job.status = 'failed'
          job.error = String((error && error.message) || error)
          job.note = '失败'
          job.finishedAt = new Date().toISOString()
          job.updatedAt = job.finishedAt
        })
      json(res, 200, { ok: true, job: publicJob(job) })
    })

    route('/dsh-modpack-kit/api/jobs/dismiss', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const id = String(body.id || '')
      const job = jobs.get(id)
      if (!job) { json(res, 404, { ok: false, error: '没有这个任务（可能已经删了）' }); return }
      if (job.status === 'running') { json(res, 400, { ok: false, error: '还在跑，先终止再删' }); return }
      jobs.delete(id)
      json(res, 200, { ok: true, removed: id })
    })

    // 清空进程：除了「正在跑」与「停在风险点等决定」，其余一律删——
    // 完成的、失败的、取消的、超上限卡住的、以及假 running（心跳停了）都带走。
    route('/dsh-modpack-kit/api/jobs/clear', async (req, res) => {
      if (!needPost(req, res)) return
      const removed = []
      const now = Date.now()
      for (const [id, job] of [...jobs.entries()]) {
        if (job.status === 'paused') continue
        if (job.status === 'running') {
          // 还活着的不动；心跳停了的先标成失败，再按收尾清掉
          reapStuck(job, now)
          if (job.status === 'running') continue
        }
        // 卡住的 running：没有文件落盘（包在内存里组装），直接摘掉即可
        jobs.delete(id)
        removed.push(id)
      }
      pruneJobs()
      json(res, 200, { ok: true, removed, jobs: [...jobs.values()].map(publicJob) })
    })

    route('/dsh-modpack-kit/api/jobs/cancel', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const job = jobs.get(String(body.id || ''))
      if (!job) { json(res, 404, { ok: false, error: '没有这个任务（可能已完成并过期）' }); return }
      if (job.status !== 'running') {
        // 停在风险点的任务：立即停止就是把它标成已停止，不留文件
        if (job.status === 'paused') {
          job.checkpoint = null
          job.status = 'cancelled'
          job.note = '已停止（未生成文件，本地没有残留）'
          job.finishedAt = job.finishedAt || new Date().toISOString()
          json(res, 200, { ok: true, job: publicJob(job) })
          return
        }
        json(res, 200, { ok: true, already: true, job: publicJob(job) })
        return
      }
      job.cancelled = true
      job.note = '正在停止…'
      json(res, 200, { ok: true, job: publicJob(job) })
    })

    route('/dsh-modpack-kit/api/jobs', (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只支持 GET' }); return }
      pruneJobs()
      json(res, 200, { ok: true, jobs: [...jobs.values()].map(publicJob) })
    })

    // —— 下载 / 落盘 ——
    route('/dsh-modpack-kit/api/download', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const item = pending.get(String(body.token || ''))
      if (!item) { json(res, 404, { ok: false, error: '打包结果已过期，请重新打包' }); return }
      const safeName = String(body.fileName || item.fileName || 'pack.dshpack').replace(/[^\w.\-]+/gu, '_')
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="' + safeName + '"',
        'Content-Length': item.buffer.length,
        'Cache-Control': 'no-store',
      })
      res.end(item.buffer)
    })

    route('/dsh-modpack-kit/api/save', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const item = pending.get(String(body.token || ''))
      if (!item) { json(res, 404, { ok: false, error: '打包结果已过期，请重新打包' }); return }
      const paths = pathsFor(config)
      ensureDir(paths.packs)
      const fileName = slugify(body.fileName || item.fileName.replace(/\.dshpack$/u, ''), 'pack') + '.dshpack'
      const target = path.join(paths.packs, fileName)
      fs.writeFileSync(target, item.buffer)
      pending.delete(String(body.token || ''))
      json(res, 200, { ok: true, path: target, size: item.buffer.length })
    })

    // 列某个目录下的整合包：GET 读本插件自己的 packs 目录，POST { dir } 读你指定的目录
    const listPacks = (dir) => {
      const items = []
      let error = ''
      try {
        const stat = fs.statSync(dir)
        if (!stat.isDirectory()) error = '这个路径不是目录'
      } catch (e) {
        error = '这个目录读不到（不存在或没有权限）'
      }
      if (!error) {
        try {
          for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith('.dshpack')) continue
            const stat = fs.statSync(path.join(dir, dirent.name))
            items.push({ name: dirent.name, size: stat.size, mtime: stat.mtime.toISOString(), path: path.join(dir, dirent.name) })
          }
        } catch (e) {
          error = String((e && e.message) || e)
        }
      }
      items.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
      return { error, items }
    }

    route('/dsh-modpack-kit/api/packs', async (req, res) => {
      if (req.method === 'GET') {
        const dir = pathsFor(config).packs
        const listed = listPacks(dir)
        json(res, 200, { ok: !listed.error, dir, items: listed.items, error: listed.error })
        return
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = await readJsonBody(req)
      const raw = String(body.dir || '').trim()
      const dir = raw ? path.resolve(raw) : pathsFor(config).packs
      const listed = listPacks(dir)
      json(res, 200, { ok: !listed.error, dir, items: listed.items, error: listed.error })
    })

    // 拖到界面上的整合包：原始字节能走就走原始字节，走不通再走 base64 JSON
    route('/dsh-modpack-kit/api/pack/drop', async (req, res) => {
      if (!needPost(req, res)) return
      let bytes = null
      const contentType = String(req.headers['content-type'] || '').toLowerCase()
      try {
        if (contentType.includes('application/json')) {
          // 有些环境不许 POST 二进制，界面会退回 base64：这里同样收
          const body = await readJsonBody(req, {}, MAX_DROP_BODY)
          const raw = typeof body.data === 'string' ? body.data : ''
          if (!raw) { json(res, 400, { ok: false, error: '没有收到整合包内容' }); return }
          bytes = Buffer.from(raw, 'base64')
        } else {
          bytes = await readRawBody(req)
        }
      } catch (error) {
        json(res, 413, { ok: false, error: String((error && error.message) || error) })
        return
      }
      if (!bytes || bytes.length < 32) { json(res, 400, { ok: false, error: '这个文件看起来不是整合包（太小了）' }); return }
      try {
        const inspected = inspectPackBuffer(bytes, {
          config,
          scanBeforeInstall: config.scanBeforeInstall !== false,
          extraScanRules: Array.isArray(config.extraScanRules) ? config.extraScanRules : [],
        })
        const fileName = slugify(inspected.manifest.name || 'dropped', 'pack') + '.dshpack'
        const token = rememberPending(fileName, { buffer: bytes, manifest: inspected.manifest, report: inspected.report, scan: inspected.scan })
        json(res, 200, {
          ok: true,
          token,
          fileName,
          size: bytes.length,
          manifest: inspected.manifest,
          integrity: inspected.integrity,
          scan: inspected.scan,
          scanGroups: groupFindings(inspected.scan.findings, inspected.manifest.plugins),
          report: inspected.report,
          blockingReasons: inspected.blockingReasons,
          notes: inspected.notes,
          compat: compatFor(inspected.manifest),
        })
      } catch (error) {
        json(res, 200, { ok: false, error: String((error && error.message) || error) })
      }
    })

    async function inspectInput(body) {
      if (body.url) {
        const buffer = await readPackFromUrl(String(body.url), config, fetchLimited)
        return inspectPackBuffer(buffer, { config, force: body.force === true, scanBeforeInstall: config.scanBeforeInstall !== false, extraScanRules: Array.isArray(config.extraScanRules) ? config.extraScanRules : [] })
      }
      if (body.token) {
        const item = pending.get(String(body.token))
        if (!item) throw new Error('打包结果已过期，请重新打包')
        return inspectPackBuffer(item.buffer, { config, force: body.force === true, scanBeforeInstall: config.scanBeforeInstall !== false, extraScanRules: Array.isArray(config.extraScanRules) ? config.extraScanRules : [] })
      }
      if (body.file) {
        const target = path.isAbsolute(String(body.file)) ? String(body.file) : path.join(pathsFor(config).packs, path.basename(String(body.file)))
        if (!target.endsWith('.dshpack')) throw new Error('只读取 .dshpack 文件')
        return inspectPackBuffer(fs.readFileSync(target), { config, force: body.force === true, scanBeforeInstall: config.scanBeforeInstall !== false, extraScanRules: Array.isArray(config.extraScanRules) ? config.extraScanRules : [] })
      }
      throw new Error('需要 url、token 或 file 之一')
    }

    // —— 预览 ——
    route('/dsh-modpack-kit/api/inspect', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      try {
        const inspected = await inspectInput(body)
        const compat = compatFor(inspected.manifest)
        json(res, 200, {
          ok: true,
          manifest: inspected.manifest,
          integrity: inspected.integrity,
          scan: inspected.scan,
          scanGroups: groupFindings(inspected.scan.findings, inspected.manifest.plugins),
          report: inspected.report,
          blockingReasons: inspected.blockingReasons,
          notes: inspected.notes,
          compat,
          readme: buildReadme(inspected.manifest),
        })
      } catch (error) {
        json(res, 200, { ok: false, error: String((error && error.message) || error) })
      }
    })

    // —— 安装 ——
    // —— 安装：先跳过本机已装的，装完其余再问要不要替换 ——
    const pendingInstalls = new Map()
    const rememberInstall = (inspected) => {
      const token = 'inst_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
      pendingInstalls.set(token, { inspected, at: Date.now() })
      // 上限 4 份、30 分钟过期：别让内存一直攒着包
      for (const [key, item] of pendingInstalls) {
        if (pendingInstalls.size <= 4) break
        if (key === token) continue
        pendingInstalls.delete(key)
      }
      for (const [key, item] of pendingInstalls) {
        if (Date.now() - item.at > 30 * 60 * 1000) pendingInstalls.delete(key)
      }
      return token
    }

    const installOptionsOf = (body) => ({
      force: body.force === true,
      keepLocal: body.keepLocal !== false,
      applyConfig: body.applyConfig !== false,
      dryRun: body.dryRun === true,
      // 是否登记 bundle：请求里给了就听请求的，没给就听设置里的 enableOnInstall（默认关）。
      enableBundles: typeof body.enableBundles === 'boolean' ? body.enableBundles : config.enableOnInstall === true,
      // 默认：本机已装（同名或同插件不同版本）先跳过，其余照装，最后再问
      deferExisting: body.deferExisting !== false && body.replaceExisting !== true,
      replaceExisting: body.replaceExisting === true,
      only: Array.isArray(body.only) && body.only.length > 0 ? body.only.map(String) : null,
      // 联网且有插件市场时优先按市场版本装（默认开；请求里能逐次关掉）
      preferMarket: typeof body.preferMarket === 'boolean' ? body.preferMarket : config.preferMarketOnInstall !== false,
      // 离线安装：true = 不问 registry 直接用包里自带的；不给 = 由 installPack 先探一下网络决定
      offline: typeof body.offline === 'boolean' ? body.offline : undefined,
    })

    const runInstall = async (inspected, body, job) => {
      const options = installOptionsOf(body)
      const push = (pct, note) => {
        if (!job) return
        if (job.cancelled) throw new JobCancelled('已取消')
        job.pct = pct
        job.note = note || job.note
        job.updatedAt = new Date().toISOString()
      }
      const scanGroups = groupFindings(inspected.scan.findings, inspected.manifest.plugins)
      if (inspected.blockingReasons.length > 0 && !options.force) {
        return {
          ok: false,
          refused: true,
          error: inspected.blockingReasons.join('；'),
          integrity: inspected.integrity,
          scan: inspected.scan,
          scanGroups,
          report: inspected.report,
        }
      }
      push(12, '开始安装')
      const result = await installPack({
        manifest: inspected.manifest,
        entries: inspected.entries,
        config,
        options: { preferMarketOnInstall: options.preferMarketOnInstall !== false || config.preferMarketOnInstall !== false, ...options, onProgress: (event) => push(event.pct, event.note) },
        context: {
          profileDir: profileDir(),
          // 离线判断：registry 探不通就直接用包里自带的，别让每个插件都等超时
          probeRegistry: () => probeRegistry(config),
          // 优先用宿主自带的插件管理器（pnpm、激活、重启判定都由它负责）；
          // 服务不在或调用抛错时 installPack 会自动退回 dsh 命令行。
          installBundle: (() => {
            const manager = ctx.get('pluginManager')
            if (!manager || typeof manager.installBundle !== 'function') return undefined
            return (spec, opts) => manager.installBundle(spec, opts)
          })(),
          // 联网且市场可用时，优先按市场版本装（能用就返回 name@version，用不了返回 null 走包内）
          resolveMarket: async (plugin) => {
            try {
              const { meta } = await npmMetadata(plugin.name, config, { version: plugin.version || plugin.spec || '' })
              const version = pickVersion(meta, plugin.version || plugin.spec || '') || pickVersion(meta, '')
              if (!version) return null
              appendLog('market ' + plugin.name + '@' + version + ' 优先于包内 ' + (plugin.version || '（未标版本）'))
              return { spec: plugin.name + '@' + version, version }
            } catch (error) {
              appendLog('market miss ' + plugin.name + ': ' + String((error && error.message) || error))
              return null
            }
          },
          // 轻量包：只把条目取回内存（不落临时目录），扫描与安装都在内存里完成
          resolveSourceEntries: async (plugin) => {
            const downloaded = await downloadPackage(plugin.name, plugin.version || plugin.requested || '', config)
            appendLog('resolve ' + plugin.name + '@' + downloaded.version + ' from ' + downloaded.registry + ' (memory, ' + downloaded.entries.length + ' files)')
            return downloaded.entries
          },
          resolveSource: async (plugin, packRoot) => {
            const downloaded = await downloadPackage(plugin.name, plugin.version || plugin.requested || '', config)
            const target = path.join(packRoot, 'plugins', plugin.dirName || plugin.name)
            ensureDir(target)
            for (const entry of downloaded.entries) {
              const dest = path.join(target, entry.name)
              if (!path.resolve(dest).startsWith(path.resolve(target) + path.sep)) continue
              ensureDir(path.dirname(dest))
              fs.writeFileSync(dest, entry.data)
            }
            appendLog('resolve ' + plugin.name + '@' + downloaded.version + ' from ' + downloaded.registry)
            return target
          },
        },
      })
      appendHistory({ at: new Date().toISOString(), kind: 'install', name: inspected.manifest.name, format: inspected.manifest.format, ok: result.ok, pack: inspected.manifest.name, actions: result.actions.length }, config.historyLimit)
      const token = rememberInstall(inspected)
      return {
        ok: result.ok,
        ...result,
        token,
        manifest: inspected.manifest,
        scan: inspected.scan,
        scanGroups,
        report: inspected.report,
        integrity: inspected.integrity,
      }
    }

    const performInstall = async (body, job) => {
      try {
        const push = (pct, note) => {
          if (!job) return
          if (job.cancelled) throw new JobCancelled('已取消')
          job.pct = pct
          job.note = note || job.note
        }
        push(4, '读取整合包')
        const inspected = await inspectInput(body)
        return await runInstall(inspected, body, job)
      } catch (error) {
        if (error instanceof JobCancelled) return { ok: false, cancelled: true, error: '已取消（没有改动 profile）' }
        return { ok: false, error: String((error && error.message) || error) }
      }
    }

    const finishInstallJob = (job, payload) => {
      job.status = payload && payload.ok ? 'done' : payload && payload.cancelled === true ? 'cancelled' : 'failed'
      job.data = payload
      job.pct = payload && payload.ok ? 100 : job.pct
      job.note = payload && payload.ok ? '完成' : ((payload && payload.error) || '已停止')
      if (!(payload && payload.ok)) job.error = (payload && payload.error) || job.note
      job.finishedAt = new Date().toISOString()
      job.updatedAt = job.finishedAt
    }

    const startInstallJob = (body, label) => {
      const job = createJob('install', label || '安装整合包')
      performInstall(body, job)
        .then((payload) => finishInstallJob(job, payload))
        .catch((error) => {
          job.status = 'failed'
          job.error = String((error && error.message) || error)
          job.note = '失败'
          job.finishedAt = new Date().toISOString()
          job.updatedAt = job.finishedAt
        })
      return job
    }

    route('/dsh-modpack-kit/api/install', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      if (body.async === true || body.background === true) {
        const job = startInstallJob(body, body.label ? String(body.label) : undefined)
        json(res, 200, { ok: true, async: true, job: publicJob(job) })
        return
      }
      const payload = await performInstall(body, null)
      json(res, 200, payload)
    })

    // 装完的追问：把刚才跳过的那些换成包内版本
    route('/dsh-modpack-kit/api/install/replace', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const token = String(body.token || '')
      const item = pendingInstalls.get(token)
      if (!item) { json(res, 400, { ok: false, error: '这次安装的上下文已过期，请重新读一遍整合包' }); return }
      const names = Array.isArray(body.names) && body.names.length > 0 ? body.names.map(String) : null
      if (body.async === true || body.background === true) {
        const job = createJob('install', '替换为包内版本' + (names ? '（' + names.length + ' 个）' : ''))
        runInstall(item.inspected, { ...body, replaceExisting: true, keepLocal: false, only: names }, job)
          .then((payload) => finishInstallJob(job, payload))
          .catch((error) => {
            job.status = 'failed'
            job.error = String((error && error.message) || error)
            job.note = '失败'
            job.finishedAt = new Date().toISOString()
            job.updatedAt = job.finishedAt
          })
        json(res, 200, { ok: true, async: true, job: publicJob(job) })
        return
      }
      const payload = await runInstall(item.inspected, { ...body, replaceExisting: true, keepLocal: false, only: names }, null)
      json(res, 200, payload)
    })

    // —— 历史 ——
    route('/dsh-modpack-kit/api/history', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false }); return }
      json(res, 200, { ok: true, items: readHistory().slice().reverse() })
    })

    // 清空最近记录（文件留着，只是写空）
    route('/dsh-modpack-kit/api/history/clear', async (req, res) => {
      if (!needPost(req, res)) return
      json(res, 200, { ok: true, items: clearHistory() })
    })

    // 删掉某一条：按 at 时间戳匹配
    route('/dsh-modpack-kit/api/history/remove', async (req, res) => {
      if (!needPost(req, res)) return
      const body = await readJsonBody(req)
      const items = removeHistory(body.at)
      appendLog('history remove ' + String((body && body.at) || '') + ' left=' + items.length)
      json(res, 200, { ok: true, items })
    })

    route('/dsh-modpack-kit/api/plugin-summary', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false }); return }
      const installed = installedOrEmpty()
      json(res, 200, { ok: true, items: installed.map((p) => ({ name: p.name, version: p.version, size: p.size, isBundle: p.isBundle, hasClient: p.hasClient })) })
    })

    // —— 目录：启动后自己补一次（不阻塞启动）；太旧了在问状态时补一次 ——
    let catalogJob = null
    let lastAutoTry = 0
    const ensureCatalog = (force) => {
      if (catalogJob) return catalogJob
      // 自动尝试十分钟内只来一次，避免没网时每个请求都去敲一遍
      if (force !== true && Date.now() - lastAutoTry < 10 * 60 * 1000) return Promise.resolve({ ok: false, skipped: true })
      if (force !== true) lastAutoTry = Date.now()
      const hours = Math.max(1, Number(config.catalogRefreshHours) || 24)
      catalogJob = syncCatalog(config, { force: force === true, maxAgeMs: hours * 3600 * 1000 })
        .then((result) => {
          if (result && result.ok && !result.skipped) {
            appendLog(`目录自动更新 ${result.count} 条（${result.source}，${Math.round((result.ms || 0) / 100) / 10}s）`)
          } else if (result && !result.ok) {
            log('catalog sync failed:', result.error)
          }
          return result
        })
        .catch((error) => {
          log('catalog sync failed:', String((error && error.message) || error))
          return { ok: false, error: String((error && error.message) || error) }
        })
        .finally(() => { catalogJob = null })
      return catalogJob
    }

    // 社区资源也照这个套路：启动补一次、过期在后台补、十分钟内失败不重敲
    let marketJob = null
    let lastMarketTry = 0
    const ensureMarket = (force) => {
      if (marketJob) return marketJob
      if (force !== true && Date.now() - lastMarketTry < 10 * 60 * 1000) return Promise.resolve({ ok: false, skipped: true })
      if (force !== true) lastMarketTry = Date.now()
      const hours = Math.max(1, Number(config.modpackRefreshHours) || 24)
      marketJob = syncMarket(config, { force: force === true, maxAgeMs: hours * 3600 * 1000 })
        .then((result) => {
          if (result && result.ok && !result.skipped) appendLog(`整合包目录更新 ${result.count} 个（${result.source}）`)
          else if (result && !result.ok) log('modpack market sync failed:', result.error)
          return result
        })
        .catch((error) => {
          log('modpack market sync failed:', String((error && error.message) || error))
          return { ok: false, error: String((error && error.message) || error) }
        })
        .finally(() => { marketJob = null })
      return marketJob
    }

    log('routes ready')
    // 起来就把目录补一次；没有网也不影响其它功能，失败只写日志
    if (process.env.DSH_MODPACK_OFFLINE !== '1') {
      ensureCatalog(false).catch(() => {})
      if (config.showModpackMarket !== false) ensureMarket(false).catch(() => {})
    }
    ctx.effect(() => {
      const timer = setInterval(sweeper, 60 * 1000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => {
        clearInterval(timer)
        pending.clear()
        for (const dispose of disposers) { try { dispose() } catch {} }
      }
    }, 'dsh-modpack-kit:routes')
  },
}

