/**
 * dsh-modpack —— Host 侧。
 *
 * 只做四件事：把本机状况喂给页面、在内存里打包、在安装前把包拆开看清楚、调官方 CLI 装。
 * 所有网络请求走 lib/registry 的白名单与体积上限；所有文件写入落在 <DSH_HOME>/dsh-modpack。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { loadConfig, saveConfig, pathsFor, profileName, readHistory, appendHistory, appendLog, ensureDir, slugify, DEFAULT_CONFIG } from './lib/store.mjs'
import { listInstalled, dshVersion, readProfilePackage, readBundles } from './lib/profile.mjs'
import { downloadPackage, npmMetadata, fetchLimited, relativeTime } from './lib/registry.mjs'
import { buildPack, PackRefused } from './lib/pack.mjs'
import { inspectPackBuffer, installPack, readPackFromUrl, InstallRefused } from './lib/install.mjs'
import { checkCompatibility } from './lib/compat.mjs'
import { classifyPlugin } from './lib/classify.mjs'
import { catalogSummary, searchCatalog, syncCatalog, categoryMapFor, lookupPlugins } from './lib/market-catalog.mjs'
import { parseYaml } from './lib/yamlish.mjs'
import { readPatch } from './lib/profile.mjs'
import { buildReadme, pluginSummary } from './lib/manifest.mjs'

const VERSION = '0.1.0'
const MAX_JSON_BODY = 1024 * 1024
const PENDING_TTL = 30 * 60 * 1000
const PENDING_MAX = 4
const PENDING_BYTES = 512 * 1024 * 1024

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const readBody = (req, limit = MAX_JSON_BODY) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > limit) { reject(Object.assign(new Error('请求体过大'), { statusCode: 413 })); req.destroy(); return }
    chunks.push(chunk)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

const asJson = (text, fallback) => {
  try { return JSON.parse(text) } catch { return fallback }
}

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
        placements: {
          settings: config.showInSettings !== false,
          sidebar: config.showInSidebar !== false,
          pluginsTab: config.showInPluginsTab === true,
        },
        installedTotal: installed.length,
        installed: installed.filter((p) => p.isPlugin).map((p) => ({
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

    const installedOrEmpty = () => {
      try { return listInstalled(profileDir()) } catch { return [] }
    }

    const compatFor = (manifest) => checkCompatibility(manifest.plugins, {
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
      const body = asJson(await readBody(req), null)
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
      const installedList = installedOrEmpty().filter((p) => p.isPlugin).map((p) => ({
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
      const body = asJson(await readBody(req), {}) || {}
      const names = Array.isArray(body.names) ? body.names.filter((n) => typeof n === 'string').slice(0, 400) : []
      try {
        json(res, 200, { ok: true, items: lookupPlugins(config, names) })
      } catch (e) {
        json(res, 200, { ok: false, error: String((e && e.message) || e), items: {} })
      }
    })

    route('/dsh-modpack-kit/api/catalog/sync', async (req, res) => {
      if (!needPost(req, res)) return
      const body = asJson(await readBody(req), {}) || {}
      const hours = Math.max(1, Number(config.catalogRefreshHours) || 24)
      const result = await syncCatalog(config, { force: body.force === true, maxAgeMs: hours * 3600 * 1000 })
      if (result.ok && !result.skipped) appendLog(`目录同步 ${result.count} 条（${result.source}，${Math.round((result.ms || 0) / 100) / 10}s）`)
      json(res, result.ok ? 200 : 502, { ...result, catalog: (() => { try { return catalogSummary(config) } catch { return null } })() })
    })

    route('/dsh-modpack-kit/api/catalog/search', async (req, res) => {
      if (!needPost(req, res)) return
      const body = asJson(await readBody(req), {}) || {}
      const localPlugins = installedOrEmpty().filter((p) => p.isPlugin)
      const localCategories = categoryMapFor(config, localPlugins.map((p) => p.name))
      const installed = localPlugins.map((p) => ({
        name: p.name, version: p.version, description: p.description || '',
        // 和市场侧统一用同一套 23 类，否则按 theme/memory 筛时本机独有的插件会被漏掉
        category: localCategories[p.name] || classifyPlugin({ name: p.name, description: p.description || '' }).id,
      }))
      try {
        json(res, 200, searchCatalog(config, {
          query: body.query,
          category: body.category,
          page: body.page,
          pageSize: body.pageSize,
          sort: body.sort,
          installed,
        }))
      } catch (e) {
        json(res, 500, { ok: false, error: String((e && e.message) || e), items: [] })
      }
    })


    // —— 查某个包的可用版本 ——
    route('/dsh-modpack-kit/api/versions', async (req, res) => {
      if (!needPost(req, res)) return
      const body = asJson(await readBody(req), {})
      const name = String(body.name || '')
      try {
        const { meta, registry } = await npmMetadata(name, config)
        const versions = Object.keys((meta && meta.versions) || {})
          .map((v) => ({ version: v, time: (meta.time && meta.time[v]) || '', deprecated: Boolean(meta.versions[v] && meta.versions[v].deprecated) }))
          .reverse()
        json(res, 200, { ok: true, name, registry, versions: versions.slice(0, 60), relative: relativeTime })
      } catch (e) {
        json(res, 200, { ok: false, error: String((e && e.message) || e) })
      }
    })

    // —— 打包 ——
    route('/dsh-modpack-kit/api/pack', async (req, res) => {
      if (!needPost(req, res)) return
      const body = asJson(await readBody(req), {})
      const selection = Array.isArray(body.selection) ? body.selection : []
      if (selection.length === 0) { json(res, 400, { ok: false, error: '没有选择任何插件' }); return }
      const options = body.options && typeof body.options === 'object' ? body.options : {}
      const dir = profileDir()
      const installed = installedOrEmpty()
      try {
        const result = await buildPack({
          selection: selection.map((item) => ({
            name: String(item.name || ''),
            source: item.source === 'npm' ? 'npm' : 'profile',
            spec: item.spec ? String(item.spec) : '',
            mode: item.mode === 'local' ? 'local' : item.mode === 'base' ? 'base' : undefined,
            download: (spec) => downloadPackage(String(item.name || ''), spec || item.spec || '', config),
          })),
          options: {
            includePayload: options.includePayload !== false,
            includeConfig: options.includeConfig !== false,
            includeLocalEdits: options.includeLocalEdits === true,
            confirmLicense: options.confirmLicense === true,
            force: options.force === true,
            keepLocal: options.keepLocal !== false,
            // 扫描是强制的，客户端传什么都不认
            scanBeforePack: true,
            name: String(options.name || 'DSH 整合包'),
            description: String(options.description || ''),
            author: String(options.author || ''),
            license: String(options.license || ''),
            homepage: String(options.homepage || ''),
            extensions: options.extensions && typeof options.extensions === 'object' ? options.extensions : {},
          },
          context: {
            config,
            profileDir: dir,
            dshVersion: (() => { try { return dshVersion(dir) } catch { return '' } })(),
            installed,
            pluginVersion: VERSION,
            extraScanRules: Array.isArray(config.extraScanRules) ? config.extraScanRules : [],
            parsePatch: parseYaml,
            patchText: readPatch(dir),
          },
        })
        const token = rememberPending(result.fileName, { buffer: result.buffer, manifest: result.manifest, report: result.report, scan: result.scan })
        appendHistory({ at: new Date().toISOString(), kind: 'pack', name: result.manifest.name, format: result.manifest.format, plugins: result.manifest.plugins.map((p) => p.name + '@' + p.version), size: result.size, high: result.scan.counts.high }, config.historyLimit)
        json(res, 200, {
          ok: true,
          token,
          fileName: result.fileName,
          size: result.size,
          manifest: result.manifest,
          scan: result.scan,
          report: result.report,
          notes: result.notes,
          compat: checkCompatibility(result.manifest.plugins, { installed, dshVersion: (() => { try { return dshVersion(dir) } catch { return '' } })(), nodeVersion: process.versions.node, config }),
        })
      } catch (error) {
        if (error instanceof PackRefused) {
          json(res, 200, { ok: false, refused: true, error: error.message, scan: error.scan })
          return
        }
        json(res, 200, { ok: false, error: String((error && error.message) || error) })
      }
    })

    // —— 下载 / 落盘 ——
    route('/dsh-modpack-kit/api/download', async (req, res) => {
      if (!needPost(req, res)) return
      const body = asJson(await readBody(req), {})
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
      const body = asJson(await readBody(req), {})
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

    route('/dsh-modpack-kit/api/packs', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false }); return }
      const dir = pathsFor(config).packs
      const items = []
      try {
        for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!dirent.isFile() || !dirent.name.endsWith('.dshpack')) continue
          const stat = fs.statSync(path.join(dir, dirent.name))
          items.push({ name: dirent.name, size: stat.size, mtime: stat.mtime.toISOString() })
        }
      } catch {}
      items.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
      json(res, 200, { ok: true, dir, items })
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
      const body = asJson(await readBody(req), {})
      try {
        const inspected = await inspectInput(body)
        const compat = compatFor(inspected.manifest)
        json(res, 200, {
          ok: true,
          manifest: inspected.manifest,
          integrity: inspected.integrity,
          scan: inspected.scan,
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
    route('/dsh-modpack-kit/api/install', async (req, res) => {
      if (!needPost(req, res)) return
      const body = asJson(await readBody(req), {})
      const options = {
        force: body.force === true,
        keepLocal: body.keepLocal !== false,
        applyConfig: body.applyConfig !== false,
        dryRun: body.dryRun === true,
        // 是否登记 bundle：请求里给了就听请求的，没给就听设置里的 enableOnInstall（默认关）。
        enableBundles: typeof body.enableBundles === 'boolean' ? body.enableBundles : config.enableOnInstall === true,
      }
      try {
        const inspected = await inspectInput(body)
        if (inspected.blockingReasons.length > 0 && !options.force) {
          const refused = new InstallRefused(inspected.blockingReasons.join('；'), inspected.scan)
          json(res, 200, { ok: false, refused: true, error: refused.message, integrity: inspected.integrity, scan: inspected.scan, report: inspected.report })
          return
        }
        const result = await installPack({
          manifest: inspected.manifest,
          entries: inspected.entries,
          config,
          options,
          context: {
            profileDir: profileDir(),
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
        json(res, 200, { ok: result.ok, ...result, manifest: inspected.manifest, scan: inspected.scan, report: inspected.report, integrity: inspected.integrity })
      } catch (error) {
        json(res, 200, { ok: false, error: String((error && error.message) || error) })
      }
    })

    // —— 历史 ——
    route('/dsh-modpack-kit/api/history', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false }); return }
      json(res, 200, { ok: true, items: readHistory().slice().reverse() })
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

    log('routes ready')
    // 起来就把目录补一次；没有网也不影响其它功能，失败只写日志
    if (process.env.DSH_MODPACK_OFFLINE !== '1') ensureCatalog(false).catch(() => {})
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

export { pluginSummary }
