/**
 * Host 半边烟测：不启动 DSH，用假的 ctx 把 index.js 的路由跑一遍。
 * 只读 + dryRun，安装一律 dryRun:true，不碰 profile 之外的东西。
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import plugin from '../index.js'

const routes = new Map()
const ctx = {
  webServer: {
    register(entry) {
      routes.set(entry.path, entry.handler)
      return () => routes.delete(entry.path)
    },
  },
  get() { return undefined },
  effect(fn) {
    const dispose = fn()
    return () => { try { dispose && dispose() } catch {} }
  },
}

plugin.apply(ctx)

function fakeRes() {
  const state = { code: 200, headers: {}, chunks: [] }
  return {
    state,
    set statusCode(v) { state.code = v },
    get statusCode() { return state.code },
    writeHead(code, headers) { state.code = code; Object.assign(state.headers, headers || {}) },
    end(buf) { if (buf) state.chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))); state.done = true },
  }
}

async function call(pathname, { method = 'GET', body = null, headers = {} } = {}) {
  const handler = routes.get(pathname)
  assert.ok(handler, 'route missing: ' + pathname)
  const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { host: '127.0.0.1:51882', 'content-type': 'application/json', ...headers }
  const res = fakeRes()
  await handler(req, res)
  const text = Buffer.concat(res.state.chunks).toString('utf8')
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { code: res.state.code, headers: res.state.headers, data, raw: Buffer.concat(res.state.chunks) }
}

const report = []
const step = async (name, fn) => {
  try { await fn(); report.push('ok   ' + name) } catch (e) { report.push('FAIL ' + name + ' :: ' + ((e && e.message) || e)); process.exitCode = 1 }
}

await step('status 返回已装插件与配置', async () => {
  const r = await call('/dsh-modpack-kit/api/status')
  assert.equal(r.code, 200)
  assert.equal(r.data.ok, true)
  assert.ok(r.data.installed.length > 5, '已装插件太少')
  assert.ok(r.data.paths.home)
  assert.equal(typeof r.data.config.scanBeforePack, 'boolean')
  assert.ok(r.data.market && typeof r.data.market.installed === 'boolean', 'status 应报插件市场是否在场')
  assert.ok(Array.isArray(r.data.installed) && r.data.installedTotal >= r.data.installed.length, 'installed 应是过滤后的插件列表')
  assert.ok(r.data.installed.every((p) => typeof p.category === 'string' && p.category), '每个已装插件都带分类')
  assert.ok(r.data.installed.every((p) => typeof p.description === 'string'), '每个已装插件都带描述')
})

await step('settings 读回默认值', async () => {
  const r = await call('/dsh-modpack-kit/api/settings')
  assert.equal(r.data.ok, true)
  assert.ok(r.data.config && r.data.config.maxPackBytes > 0)
})

await step('settings 拒绝非白名单键', async () => {
  const r = await call('/dsh-modpack-kit/api/settings', { method: 'POST', body: { patch: { evil: 1 } } })
  assert.equal(r.data.ok, true)
  assert.equal(r.data.config.evil, undefined)
})

await step('pack 用本机插件打轻量包并给出扫描与兼容', async () => {
  const r = await call('/dsh-modpack-kit/api/pack', {
    method: 'POST',
    body: {
      selection: [{ name: 'dsh-bili-account-bridge', source: 'profile' }],
      options: { includePayload: false, name: '烟测包', confirmLicense: true },
    },
  })
  assert.equal(r.code, 200)
  assert.equal(r.data.ok, true, r.data.error)
  assert.equal(r.data.manifest.format, 'lite')
  assert.equal(r.data.manifest.plugins[0].name, 'dsh-bili-account-bridge')
  assert.ok(r.data.token)
  assert.equal(typeof r.data.scan.counts.high, 'number')
  assert.ok(Array.isArray(r.data.compat.findings))
  globalThis.__token = r.data.token
})

await step('inspect 读回同一个包', async () => {
  const r = await call('/dsh-modpack-kit/api/inspect', { method: 'POST', body: { token: globalThis.__token } })
  assert.equal(r.data.ok, true, r.data.error)
  assert.equal(r.data.integrity.ok, true)
  assert.equal(r.data.manifest.format, 'lite')
  assert.ok(r.data.readme.includes('dsh-bili-account-bridge'))
})

await step('download 吐二进制', async () => {
  const r = await call('/dsh-modpack-kit/api/download', { method: 'POST', body: { token: globalThis.__token } })
  assert.equal(r.code, 200)
  assert.equal(r.headers['Content-Type'], 'application/octet-stream')
  assert.ok(r.raw.length > 1000)
})

await step('install 演练不落地', async () => {
  const r = await call('/dsh-modpack-kit/api/install', {
    method: 'POST',
    body: { token: globalThis.__token, dryRun: true, keepLocal: true, applyConfig: true },
  })
  assert.equal(r.code, 200)
  assert.equal(r.data.ok, true, r.data.error)
  assert.equal(typeof r.data.needsRestart, 'boolean')
  assert.ok(r.data.actions.length >= 1)
  assert.equal(r.data.actions[0].ok, true)
})

await step('坏包被拒（伪造 JSON）', async () => {
  const r = await call('/dsh-modpack-kit/api/inspect', { method: 'POST', body: { url: 'https://registry.npmjs.org/' } })
  assert.equal(r.data.ok, false)
  assert.ok(String(r.data.error).length > 0)
})

await step('不接受非 POST', async () => {
  const r = await call('/dsh-modpack-kit/api/pack', { method: 'GET' })
  assert.equal(r.code, 405)
})

await step('非回环来源被拒', async () => {
  const r = await call('/dsh-modpack-kit/api/status', { headers: { host: 'evil.example.com' } })
  assert.equal(r.code, 403)
})

await step('status 带三处显示位与目录摘要', async () => {
  const r = await call('/dsh-modpack-kit/api/status')
  assert.equal(r.code, 200)
  const pl = r.data.placements
  assert.ok(pl && typeof pl === 'object', '缺 placements')
  for (const key of ['settings', 'sidebar', 'pluginsTab']) assert.equal(typeof pl[key], 'boolean', key + ' 不是布尔')
  assert.ok(r.data.catalog && typeof r.data.catalog.count === 'number', '缺 catalog 摘要')
  assert.equal(typeof r.data.catalog.present, 'boolean')
  assert.ok(Array.isArray(r.data.catalog.categories))
  assert.ok(r.data.installed.every((p) => typeof p.category === 'string' && p.category))
})

await step('三处显示全关会被拒', async () => {
  const r = await call('/dsh-modpack-kit/api/settings', {
    method: 'POST',
    body: { showInSettings: false, showInSidebar: false, showInPluginsTab: false },
  })
  assert.equal(r.code, 400, '应当 400，实际 ' + r.code)
  assert.equal(r.data.ok, false)
  // 还原：至少留一处
  const back = await call('/dsh-modpack-kit/api/settings', { method: 'POST', body: { showInSidebar: true } })
  assert.equal(back.code, 200)
})

await step('catalog 只回摘要不下发整份目录', async () => {
  const r = await call('/dsh-modpack-kit/api/catalog')
  assert.equal(r.code, 200)
  assert.ok(Array.isArray(r.data.installed))
  assert.ok(r.data.catalog && typeof r.data.catalog.count === 'number')
  assert.equal(r.data.plugins, undefined, '不该整份下发目录')
})

await step('catalog/search 形状正确（有无索引都能回）', async () => {
  const r = await call('/dsh-modpack-kit/api/catalog/search', {
    method: 'POST',
    body: { query: 'memory', page: 1, pageSize: 5 },
  })
  assert.equal(r.code, 200)
  assert.ok(Array.isArray(r.data.items))
  assert.equal(typeof r.data.total, 'number')
  assert.ok(r.data.items.length <= 5)
  if (r.data.ok === false) assert.ok(String(r.data.error).length > 0, '失败要说明原因')
})

await step('catalog/lookup 按名查', async () => {
  const r = await call('/dsh-modpack-kit/api/catalog/lookup', {
    method: 'POST',
    body: { names: ['dshmarket', 'this-plugin-does-not-exist-xyz'] },
  })
  assert.equal(r.code, 200)
  assert.ok(r.data.items && typeof r.data.items === 'object')
})

await step('设置里能打开「装完直接启用」并回读', async () => {
  const on = await call('/dsh-modpack-kit/api/settings', { method: 'POST', body: { patch: { enableOnInstall: true } } })
  assert.equal(on.data.config.enableOnInstall, true, '设置应接受 enableOnInstall')
  const st = await call('/dsh-modpack-kit/api/status')
  assert.equal(st.data.config.enableOnInstall, true, 'status 应回读 enableOnInstall')
  const off = await call('/dsh-modpack-kit/api/settings', { method: 'POST', body: { patch: { enableOnInstall: false } } })
  assert.equal(off.data.config.enableOnInstall, false, '应能改回 false')
})

await step('进度窗坐标已从配置里移除（位置改由界面拖动）', async () => {
  const r = await call('/dsh-modpack-kit/api/settings', { method: 'POST', body: { patch: { dockX: 30, dockY: 40 } } })
  assert.equal(r.code, 200)
  assert.equal(r.data.config.dockX, undefined, 'dockX 不该再被接受')
  assert.equal(r.data.config.dockY, undefined, 'dockY 不该再被接受')
})

await step('打包前扫描关不掉：设置里写 false 也被拉回 true', async () => {
  const r = await call('/dsh-modpack-kit/api/settings', { method: 'POST', body: { scanBeforePack: false } })
  assert.equal(r.code, 200)
  assert.equal(r.data.config.scanBeforePack, true, '强制项应恒为 true')
})

await step('异步打包：立即返回任务，/jobs 可查，终止后不留包', async () => {
  const started = await call('/dsh-modpack-kit/api/pack', {
    method: 'POST',
    body: {
      async: true,
      selection: [{ name: 'dsh-bili-account-bridge', source: 'profile' }],
      options: { includePayload: false, name: '异步烟测', confirmLicense: true },
    },
  })
  assert.equal(started.code, 200)
  assert.equal(started.data.ok, true, started.data.error)
  assert.equal(started.data.async, true, '异步模式应立即返回')
  assert.ok(started.data.job && started.data.job.id, '应带任务 id')
  const jobId = started.data.job.id

  const listed = await call('/dsh-modpack-kit/api/jobs')
  assert.equal(listed.data.ok, true)
  assert.ok(listed.data.jobs.some((job) => job.id === jobId), '/jobs 应能看到刚启动的任务')

  const stopped = await call('/dsh-modpack-kit/api/jobs/cancel', { method: 'POST', body: { id: jobId } })
  assert.equal(stopped.code, 200)
  assert.ok(['running', 'cancelled', 'done'].includes(stopped.data.job.status))

  let final = null
  for (let i = 0; i < 80; i++) {
    const snap = await call('/dsh-modpack-kit/api/jobs')
    final = snap.data.jobs.find((job) => job.id === jobId)
    if (!final || final.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  assert.ok(final, '任务不该消失')
  assert.ok(['done', 'cancelled', 'failed'].includes(final.status), '任务应已收尾，实际 ' + final.status)
  if (final.status === 'cancelled') assert.ok(!(final.data && final.data.token), '取消后不应留下可用包')
})

await step('inspect 返回按来源分组的风险列表', async () => {
  const r = await call('/dsh-modpack-kit/api/inspect', { method: 'POST', body: { token: globalThis.__token } })
  assert.equal(r.data.ok, true, r.data.error)
  assert.ok(Array.isArray(r.data.scanGroups), 'inspect 应带 scanGroups')
  for (const group of r.data.scanGroups) {
    assert.equal(typeof group.key, 'string')
    assert.equal(typeof group.label, 'string')
    assert.ok(group.counts && typeof group.counts.high === 'number')
    assert.ok(Array.isArray(group.findings))
  }
})

await step('任务收尾后能删掉，删完再查就是 404；没有风险的任务不能「我知道在干什么」', async () => {
  const started = await call('/dsh-modpack-kit/api/pack', {
    method: 'POST',
    body: {
      async: true,
      selection: [{ name: 'dsh-bili-account-bridge', source: 'profile' }],
      options: { includePayload: false, name: '删除烟测', confirmLicense: true },
    },
  })
  assert.equal(started.code, 200, JSON.stringify(started.data))
  const jobId = started.data.job.id
  let final = null
  for (let i = 0; i < 120; i++) {
    const snap = await call('/dsh-modpack-kit/api/jobs')
    final = snap.data.jobs.find((job) => job.id === jobId)
    if (final && final.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  assert.ok(final, '任务不该消失')
  assert.equal(final.canDismiss, true, '收尾后应允许删除')
  assert.equal(final.canAck, false, '没有风险的任务不该给确认按钮')
  assert.equal(final.risk, null, '没有风险的任务 risk 应为 null')

  const ack = await call('/dsh-modpack-kit/api/jobs/ack', { method: 'POST', body: { id: jobId } })
  assert.equal(ack.code, 400, '没风险却确认，应被拒')

  const gone = await call('/dsh-modpack-kit/api/jobs/dismiss', { method: 'POST', body: { id: jobId } })
  assert.equal(gone.data.ok, true, gone.data.error)
  const after = await call('/dsh-modpack-kit/api/jobs')
  assert.ok(!after.data.jobs.some((job) => job.id === jobId), '删掉后列表里不该再有它')
  const again = await call('/dsh-modpack-kit/api/jobs/dismiss', { method: 'POST', body: { id: jobId } })
  assert.equal(again.code, 404, '重复删除应 404')
})

await step('跑着的任务不能删，只能先终止', async () => {
  const started = await call('/dsh-modpack-kit/api/pack', {
    method: 'POST',
    body: {
      async: true,
      selection: [{ name: 'dsh-bili-account-bridge', source: 'profile' }],
      options: { includePayload: true, name: '在跑烟测', confirmLicense: true },
    },
  })
  const jobId = started.data.job.id
  const denied = await call('/dsh-modpack-kit/api/jobs/dismiss', { method: 'POST', body: { id: jobId } })
  assert.equal(denied.code, 400, '进行中的任务不该被删掉')
  await call('/dsh-modpack-kit/api/jobs/cancel', { method: 'POST', body: { id: jobId } })
  for (let i = 0; i < 80; i++) {
    const snap = await call('/dsh-modpack-kit/api/jobs')
    const job = snap.data.jobs.find((item) => item.id === jobId)
    if (!job || job.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
})

await step('清空进程：清掉收尾与失败的，跑着的留着；已完成的任务带可下载 token', async () => {
  const started = await call('/dsh-modpack-kit/api/pack', {
    method: 'POST',
    body: {
      async: true,
      selection: [{ name: 'dsh-bili-account-bridge', source: 'profile' }],
      options: { includePayload: false, name: '清空烟测', confirmLicense: true },
    },
  })
  const jobId = started.data.job.id
  let final = null
  for (let i = 0; i < 120; i++) {
    const snap = await call('/dsh-modpack-kit/api/jobs')
    final = snap.data.jobs.find((job) => job.id === jobId)
    if (final && final.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  assert.equal(final.status, 'done', '轻量包应能打完，实际 ' + final.status + ' ' + (final.error || ''))
  assert.ok(final.data && final.data.token, '跑完的任务要带 token，进度窗才能给出「下载安装包」')

  const running = await call('/dsh-modpack-kit/api/pack', {
    method: 'POST',
    body: {
      async: true,
      selection: [{ name: 'dsh-bili-account-bridge', source: 'profile' }],
      options: { includePayload: true, name: '清空烟测-在跑', confirmLicense: true },
    },
  })
  const runningId = running.data.job.id
  const cleared = await call('/dsh-modpack-kit/api/jobs/clear', { method: 'POST', body: {} })
  assert.equal(cleared.data.ok, true, cleared.data.error)
  assert.ok(cleared.data.removed.includes(jobId), '已完成的应被清掉')
  const listed = await call('/dsh-modpack-kit/api/jobs')
  assert.ok(!listed.data.jobs.some((job) => job.id === jobId), '清空后列表里不该再有已完成的')
  assert.ok(listed.data.jobs.some((job) => job.id === runningId && job.status === 'running'), '跑着的任务不能被清掉')
  await call('/dsh-modpack-kit/api/jobs/cancel', { method: 'POST', body: { id: runningId } })
  for (let i = 0; i < 80; i++) {
    const snap = await call('/dsh-modpack-kit/api/jobs')
    const job = snap.data.jobs.find((item) => item.id === runningId)
    if (!job || job.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  // 失败卡住的记录也要能被清掉（比如选了一个本机没有的插件、或超过体积上限）
  const broken = await call('/dsh-modpack-kit/api/pack', {
    method: 'POST',
    body: { async: true, selection: [{ name: 'no-such-plugin-xyz', source: 'profile' }], options: { includePayload: true, confirmLicense: true, name: '失败烟测' } },
  })
  const brokenId = broken.data.job.id
  let brokenJob = null
  for (let i = 0; i < 80; i++) {
    const snap = await call('/dsh-modpack-kit/api/jobs')
    brokenJob = snap.data.jobs.find((job) => job.id === brokenId)
    if (brokenJob && brokenJob.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  assert.equal(brokenJob.status, 'failed', '选不存在的插件应判失败，实际 ' + brokenJob.status)
  assert.ok(brokenJob.error, '失败原因应写进 error，进度窗那一行才能显示为什么卡住')
  const clearedBroken = await call('/dsh-modpack-kit/api/jobs/clear', { method: 'POST', body: {} })
  assert.ok(clearedBroken.data.removed.includes(brokenId), '失败卡住的进程也应被清空进程带走')
  const afterBroken = await call('/dsh-modpack-kit/api/jobs')
  assert.ok(!afterBroken.data.jobs.some((job) => job.id === brokenId), '清空后不该再有失败进程')
})

console.log(report.join('\n'))
if (process.exitCode) console.log('host smoke: 有失败项')
else console.log('host smoke: 全部通过（' + report.length + ' 项）')
