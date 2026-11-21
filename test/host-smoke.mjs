/**
 * Host 半边烟测：不启动 DSH，用假的 ctx 把 index.js 的路由跑一遍。
 * 只读 + dryRun，安装一律 dryRun:true，不碰 profile 之外的东西。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import plugin from '../index.js'

import { mountFakeHost } from '../dev/tools/fake-host.mjs'

// 假 ctx 里打包是同步 CPU 活，会在微任务里一口气跑完；延后 1200ms 开跑，
// 才有窗口验证「跑着的任务不能被删 / 不能被清空」。
const { call, callRaw } = mountFakeHost(plugin, { jobDelay: 1200 })

// 找一个「打包会明显花时间」的插件：默认按本机版打，小插件几十毫秒就完了，
// 测「跑着的任务不能删 / 清空不能带走」时需要任务确实还在跑。
const heavyPluginName = async () => {
  const st = await call('/dsh-modpack-kit/api/status')
  const names = (st.data.installed || []).map((p) => p.name)
  return ['dsh-dafeiyu-life', 'dsh-plugin-wallpaper-engine', 'dsh-whale-widget', 'dsh-modpack-kit'].find((n) => names.includes(n)) || names[0]
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
  assert.ok(Array.isArray(r.data.groups), 'status.groups 应该是数组')
  assert.ok(Array.isArray(r.data.ungrouped), 'status.ungrouped 应该是数组')
  assert.ok(r.data.groupSource === 'market' || r.data.groupSource === 'none', 'groupSource 只有两种')
  assert.ok(r.data.groups.every((g) => typeof g.name === 'string' && Array.isArray(g.members)), '分组带名字与成员')
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

await step('最近记录：删一条 / 清空 都落盘，测完还原', async () => {
  const file = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-modpack', 'history.json')
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  try {
    const list = await call('/dsh-modpack-kit/api/history')
    assert.equal(list.data.ok, true)
    const first = list.data.items[0]
    assert.ok(first && first.at, '打包成功后应至少有一条记录，且带 at')

    const removed = await call('/dsh-modpack-kit/api/history/remove', { method: 'POST', body: { at: first.at } })
    assert.equal(removed.data.ok, true)
    assert.ok(!removed.data.items.some((item) => item.at === first.at), '删掉的那条不该再出现')

    const cleared = await call('/dsh-modpack-kit/api/history/clear', { method: 'POST', body: {} })
    assert.equal(cleared.data.ok, true)
    assert.equal(cleared.data.items.length, 0, '清空后应为空')
    assert.equal(fs.readFileSync(file, 'utf8').trim(), '[]', '清空要写进文件')
  } finally {
    if (backup === null) { try { fs.rmSync(file, { force: true }) } catch { /* 清不掉就别管 */ } }
    else fs.writeFileSync(file, backup)
  }
})

await step('离线安装：请求给了 offline，轻量包缺本体时明确拒绝', async () => {
  const r = await call('/dsh-modpack-kit/api/install', {
    method: 'POST',
    body: { token: globalThis.__token, dryRun: true, offline: true, deferExisting: false, keepLocal: false },
  })
  assert.equal(r.code, 200)
  assert.equal(r.data.ok, false, '没带本体的轻量包离线装不了')
  const failed = (r.data.actions || []).find((a) => a.plugin === 'dsh-bili-account-bridge')
  assert.ok(failed, '应有一条针对该插件的结果')
  assert.equal(failed.ok, false)
  assert.ok(/当前没网/u.test(failed.message), '应说明没网、需要联网或换完整包，实际：' + failed.message)
})

await step('安装走任务队列：立即返回任务，/jobs 能轮询到完成', async () => {
  const started = await call('/dsh-modpack-kit/api/install', {
    method: 'POST',
    body: { token: globalThis.__token, dryRun: true, async: true },
  })
  assert.equal(started.code, 200)
  assert.equal(started.data.ok, true, started.data.error)
  assert.equal(started.data.async, true, '安装也应该异步启动')
  assert.ok(started.data.job && started.data.job.id, '应带任务 id')
  assert.equal(started.data.job.kind, 'install', '任务类型应为 install')
  const jobId = started.data.job.id

  let final = null
  for (let i = 0; i < 80; i++) {
    const snap = await call('/dsh-modpack-kit/api/jobs')
    final = snap.data.jobs.find((job) => job.id === jobId)
    if (!final || final.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  assert.ok(final, '任务不该消失')
  assert.equal(final.status, 'done', '安装演练应完成，实际 ' + final.status + ' ' + (final.error || ''))
  assert.equal(final.pct, 100)
  assert.ok(final.data && final.data.ok, '任务数据应带回安装结果')
  assert.ok(Array.isArray(final.data.deferred), '结果应带 deferred 列表')
})

await step('本机已装的先跳过，装完再问换不换', async () => {
  const r = await call('/dsh-modpack-kit/api/install', {
    method: 'POST',
    body: { token: globalThis.__token, dryRun: true },
  })
  assert.equal(r.code, 200)
  assert.equal(r.data.ok, true, r.data.error)
  const deferred = r.data.deferred
  assert.ok(Array.isArray(deferred) && deferred.length >= 1, '本机已装的插件应进 deferred')
  const item = deferred.find((entry) => entry.name === 'dsh-bili-account-bridge')
  assert.ok(item, 'dsh-bili-account-bridge 本机已装，应被跳过')
  assert.equal(typeof item.localVersion, 'string')
  assert.equal(typeof item.packVersion, 'string')
  const action = r.data.actions.find((entry) => entry.plugin === 'dsh-bili-account-bridge')
  assert.ok(action, '应有该插件的动作记录')
  assert.equal(action.action, 'deferred')
  assert.ok(r.data.token, '安装结果应带后续替换用的 token')
  globalThis.__installToken = r.data.token
})

await step('替换为包内版本：只动指定的那几个', async () => {
  const r = await call('/dsh-modpack-kit/api/install/replace', {
    method: 'POST',
    body: { token: globalThis.__installToken, names: ['dsh-bili-account-bridge'], dryRun: true },
  })
  assert.equal(r.code, 200)
  assert.equal(r.data.ok, true, r.data.error)
  const action = r.data.actions.find((entry) => entry.plugin === 'dsh-bili-account-bridge')
  assert.ok(action, '应有该插件的动作记录')
  assert.equal(action.action, 'install', '选择替换后应真的走安装')
  assert.equal(r.data.deferred.length, 0, '替换模式下不该再有 deferred')
})

await step('坏包被拒（伪造 JSON）', async () => {
  const r = await call('/dsh-modpack-kit/api/inspect', { method: 'POST', body: { url: 'https://registry.npmjs.org/' } })
  assert.equal(r.data.ok, false)
  assert.ok(String(r.data.error).length > 0)
})

await step('失败的安装任务也能清掉（清空进程要连失败一起清）', async () => {
  const started = await call('/dsh-modpack-kit/api/install', {
    method: 'POST',
    body: { token: 'bogus-token-for-failure', async: true, dryRun: true },
  })
  assert.equal(started.code, 200)
  assert.equal(started.data.ok, true, started.data.error)
  const jobId = started.data.job.id

  let final = null
  for (let i = 0; i < 80; i++) {
    const snap = await call('/dsh-modpack-kit/api/jobs')
    final = snap.data.jobs.find((job) => job.id === jobId)
    if (!final || final.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  assert.ok(final, '失败任务不该凭空消失')
  assert.equal(final.status, 'failed', '这个任务应该是失败态，实际 ' + final.status)
  assert.equal(final.canDismiss, true, '失败任务应可删')

  const cleared = await call('/dsh-modpack-kit/api/jobs/clear', { method: 'POST', body: {} })
  assert.equal(cleared.code, 200)
  assert.ok(cleared.data.removed.includes(jobId), '失败任务应在清空结果里')

  const after = await call('/dsh-modpack-kit/api/jobs')
  assert.ok(!after.data.jobs.some((job) => job.id === jobId), '清空后列表里不该再有它')
})

await step('拖进来的整合包：原始字节能读取并给出 token', async () => {
  const packed = await call('/dsh-modpack-kit/api/pack', {
    method: 'POST',
    body: {
      selection: [{ name: 'dsh-bili-account-bridge', source: 'profile' }],
      options: { includePayload: false, includeConfig: false, name: '拖拽测试包' },
    },
  })
  assert.equal(packed.code, 200, packed.code)
  assert.equal(packed.data.ok, true, packed.data.error)
  const downloaded = await call('/dsh-modpack-kit/api/download', { method: 'POST', body: { token: packed.data.token } })
  assert.ok(downloaded.raw.length > 100, '包应该有内容')

  const dropped = await callRaw('/dsh-modpack-kit/api/pack/drop', downloaded.raw)
  assert.equal(dropped.code, 200)
  assert.equal(dropped.data.ok, true, dropped.data.error)
  assert.equal(typeof dropped.data.token, 'string')
  assert.ok(dropped.data.token.length > 8)
  assert.equal(dropped.data.manifest.name, '拖拽测试包')
  assert.ok(Array.isArray(dropped.data.scanGroups))
  assert.equal(dropped.data.integrity.ok, true)

  const junk = await callRaw('/dsh-modpack-kit/api/pack/drop', Buffer.from('not-a-pack'))
  assert.equal(junk.code, 400)
  assert.equal(junk.data.ok, false)
})

await step('列别的目录里的整合包（自己选安装包目录）', async () => {
  const dir = path.join(os.tmpdir(), 'dshpack-dir-' + Date.now())
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, 'hand-made.dshpack')
  fs.writeFileSync(target, Buffer.from('stub'))
  try {
    const listed = await call('/dsh-modpack-kit/api/packs', { method: 'POST', body: { dir } })
    assert.equal(listed.code, 200)
    assert.equal(listed.data.ok, true, listed.data.error)
    assert.equal(listed.data.dir, dir)
    const hit = listed.data.items.find((item) => item.name === 'hand-made.dshpack')
    assert.ok(hit, '应该列出这个目录里的包')
    assert.equal(hit.path, target, '条目要带绝对路径，点一下就能读')

    const missing = await call('/dsh-modpack-kit/api/packs', { method: 'POST', body: { dir: path.join(dir, 'nope') } })
    assert.equal(missing.code, 200)
    assert.equal(missing.data.ok, false)
    assert.ok(missing.data.error)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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

await step('体积上限：保存 256 生效，手滑写 25600 会被夹回 4096', async () => {
  const saved = await call('/dsh-modpack-kit/api/settings', { method: 'POST', body: { patch: { maxPackBytes: 256 * 1024 * 1024 } } })
  assert.equal(saved.data.config.maxPackBytes, 256 * 1024 * 1024, '256 MB 应原样保存')
  const huge = await call('/dsh-modpack-kit/api/settings', { method: 'POST', body: { patch: { maxPackBytes: 25600 * 1024 * 1024 } } })
  assert.equal(huge.data.config.maxPackBytes, 4096 * 1024 * 1024, '超大值应被夹到 4096 MB')
  const tiny = await call('/dsh-modpack-kit/api/settings', { method: 'POST', body: { patch: { maxPackBytes: 1 } } })
  assert.equal(tiny.data.config.maxPackBytes, 16 * 1024 * 1024, '过小值应被抬到 16 MB')
  await call('/dsh-modpack-kit/api/settings', { method: 'POST', body: { patch: { maxPackBytes: 256 * 1024 * 1024 } } })
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
      selection: [{ name: '' + (await heavyPluginName()) + '', source: 'profile' }],
      options: { includePayload: true, name: '在跑烟测', confirmLicense: true, acknowledge: true },
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
      selection: [{ name: '' + (await heavyPluginName()) + '', source: 'profile' }],
      options: { includePayload: false, name: '清空烟测', confirmLicense: true, acknowledge: true },
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

await step('任务记录默认留到重启；设置成秒数才自动清；正在跑的照常显示', async () => {
  const prev = await call('/dsh-modpack-kit/api/settings', { method: 'POST', body: { patch: { jobKeepSeconds: 0 } } })
  assert.equal(prev.data.config.jobKeepSeconds, 0, 'jobKeepSeconds 允许为 0（= 留到下次启动）')
  try {
    const broken = await call('/dsh-modpack-kit/api/install', {
      method: 'POST',
      body: { token: 'bogus-token-keep-zero', async: true, dryRun: true },
    })
    const brokenId = broken.data.job.id
    let seen = false
    for (let i = 0; i < 40; i++) {
      const snap = await call('/dsh-modpack-kit/api/jobs')
      if (snap.data.jobs.some((job) => job.id === brokenId)) { seen = true; break }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    assert.ok(seen, '0 时要留在列表里（切页面、换入口不丢）')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const stillThere = await call('/dsh-modpack-kit/api/jobs')
    assert.ok(stillThere.data.jobs.some((job) => job.id === brokenId), '0 时不该按时间自己消失')

    const running = await call('/dsh-modpack-kit/api/pack', {
      method: 'POST',
      body: {
        async: true,
        selection: [{ name: '' + (await heavyPluginName()) + '', source: 'profile' }],
        options: { includePayload: true, name: '在跑照常显示', confirmLicense: true, acknowledge: true },
      },
    })
    const runningId = running.data.job.id
    const cleared = await call('/dsh-modpack-kit/api/jobs/clear', { method: 'POST', body: {} })
    assert.ok(!cleared.data.removed.includes(runningId), '清空不能把正在跑的带走')
    const listed = await call('/dsh-modpack-kit/api/jobs')
    const still = listed.data.jobs.find((job) => job.id === runningId)
    assert.ok(still && still.status === 'running', '正在跑的应该继续正常显示')
    await call('/dsh-modpack-kit/api/jobs/cancel', { method: 'POST', body: { id: runningId } })
    for (let i = 0; i < 80; i++) {
      const snap = await call('/dsh-modpack-kit/api/jobs')
      const job = snap.data.jobs.find((item) => item.id === runningId)
      if (!job || job.status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  } finally {
    await call('/dsh-modpack-kit/api/settings', { method: 'POST', body: { patch: { jobKeepSeconds: 0 } } })
  }
})

await step('拖拽退回 base64：JSON 也能读（环境不许 POST 二进制时走这条）', async () => {
  const packed = await call('/dsh-modpack-kit/api/pack', {
    method: 'POST',
    body: {
      selection: [{ name: 'dsh-bili-account-bridge', source: 'profile' }],
      options: { includePayload: false, includeConfig: false, name: 'base64 测试包' },
    },
  })
  assert.equal(packed.data.ok, true, packed.data.error)
  const downloaded = await call('/dsh-modpack-kit/api/download', { method: 'POST', body: { token: packed.data.token } })
  const dropped = await call('/dsh-modpack-kit/api/pack/drop', {
    method: 'POST',
    body: { name: 'base64.dshpack', data: downloaded.raw.toString('base64') },
  })
  assert.equal(dropped.code, 200)
  assert.equal(dropped.data.ok, true, dropped.data.error)
  assert.equal(dropped.data.manifest.name, 'base64 测试包')
  assert.ok(dropped.data.token)

  const empty = await call('/dsh-modpack-kit/api/pack/drop', { method: 'POST', body: { name: 'x.dshpack' } })
  assert.equal(empty.code, 400)
  assert.equal(empty.data.ok, false)
})

await step('客户端带了「选择文件…」「浏览文件夹…」两个入口', async () => {
  const text = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(text.includes('选择文件…'), '要有打开文件对话框的入口')
  assert.ok(text.includes('浏览文件夹…'), '要有系统目录选择器入口')
  assert.ok(text.includes('uploadPackFile'), '上传逻辑要能复用（拖拽与选文件走同一条）')
  assert.ok(text.includes('pickDirectoryHost'), '宿主目录选择器要能接上')
})

await step('导入列表：多份可以同时留着，装完自动从进度窗摘掉', async () => {
  const text = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(text.includes('已导入的整合包'), '入口文案应是「已导入的整合包」')
  assert.ok(text.includes('importStore'), '要有一个模块级导入列表（可以同时留多份）')
  assert.ok(text.includes('addImport'), '导入成功后要往列表里加一条')
  assert.ok(text.includes('item.description'), '卡片上要显示打包时的描述')
  assert.ok(text.includes('item.author'), '卡片上要显示打包时的作者')
  const installer = fs.readFileSync(new URL('../assets/install-stub.mjs', import.meta.url), 'utf8')
  assert.ok(installer.includes('打包者：'), '裸 DSH 的安装器也要打印作者')
  assert.ok(installer.includes('说明：'), '裸 DSH 的安装器也要打印描述')
})

console.log(report.join('\n'))
if (process.exitCode) console.log('host smoke: 有失败项')
else console.log('host smoke: 全部通过（' + report.length + ' 项）')
