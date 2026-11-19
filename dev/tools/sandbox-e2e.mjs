/**
 * 沙箱端到端：从真实 profile 里挑一个小插件 → 打包（full）→ 读包校验 →
 * 装进一个**临时 profile**（不是 desktop），并且**不登记 bundle**（装好不启用）→ 断言 → 全部删掉。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "<exe>" dev/tools/sandbox-e2e.mjs
 * 结束后不留任何文件：临时 profile、vendor、packs、包本身都清掉。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, pathsFor, profileDir, dshHome } from '../../lib/store.mjs'
import { listInstalled, readJson, readBundles } from '../../lib/profile.mjs'
import { buildPack } from '../../lib/pack.mjs'
import { inspectPackBuffer, installPack, materializePayload } from '../../lib/install.mjs'

const SB_NAME = 'modpack-sandbox-tmp'
const log = (msg) => console.log(msg)
const fail = (msg) => { throw new Error(msg) }

const base = loadConfig()
const realProfile = pathsFor(base).profile
const PREFERRED = ['dsh-whale-widget', 'dsh-theme-endfield', 'dsh-plugin-memory', 'dsh-context']
const pool = listInstalled(realProfile).filter((p) => p.isPlugin && p.isDirect && p.name !== 'dsh-modpack-kit')
if (pool.length === 0) fail('profile 里没有可用来打包的插件')
const pick = pool.find((p) => PREFERRED.includes(p.name)) || pool[0]
log(`挑中：${pick.name}@${pick.version}（${pick.dir}）`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-modpack-sandbox-'))
const sbDir = path.join(dshHome(), 'profiles', SB_NAME)
let ok = true
const report = []
const step = async (name, fn) => {
  try { await fn(); report.push('ok   ' + name); log('ok   ' + name) } catch (e) { ok = false; report.push('FAIL ' + name + ' :: ' + ((e && e.message) || e)); log('FAIL ' + name + ' :: ' + ((e && e.message) || e)) }
}

try {
  // 干净起步
  fs.rmSync(sbDir, { recursive: true, force: true })
  fs.mkdirSync(sbDir, { recursive: true })
  fs.writeFileSync(path.join(sbDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + SB_NAME, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2) + '\n')
  fs.writeFileSync(path.join(sbDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  fs.writeFileSync(path.join(sbDir, 'cordis.yml'), '# sandbox profile\n[]\n')
  fs.writeFileSync(path.join(sbDir, 'cordis.patch.yml'), '# sandbox patch layer\n[]\n')

  const config = {
    ...base,
    profile: SB_NAME,
    packDir: path.join(tmp, 'packs'),
    vendorDir: path.join(tmp, 'vendor'),
  }
  assert.equal(profileDir(config), profileDir({ profile: SB_NAME }), '临时 profile 路径应一致')

  let pack = null
  await step('打包（full，含配置快照）', async () => {
    pack = await buildPack({
      selection: [{ name: pick.name, source: 'profile', mode: 'local' }],
      options: {
        includePayload: true,
        includeConfig: true,
        includeLocalEdits: true,
        keepLocal: false,
        confirmLicense: true,
        name: '沙箱自测包',
        description: 'sandbox e2e',
        author: 'selftest',
      },
      context: { config, profileDir: realProfile, dshVersion: base.dshVersion || '', installed: pool, pluginVersion: 'selftest' },
    })
    assert.ok(pack.buffer.length > 1000, '包太小')
    assert.equal(pack.manifest.plugins.length, 1)
    assert.equal(pack.manifest.security.scanned, true, '扫描必须是 true')
    log(`     包 ${pack.fileName} · ${pack.buffer.length} 字节 · 扫描 ${JSON.stringify(pack.scan.counts)}`)
  })

  let inspected = null
  await step('读包：完整性 + 清单 + 扫描', async () => {
    inspected = inspectPackBuffer(pack.buffer, { config })
    assert.equal(inspected.integrity.ok, true, '完整性校验应通过')
    assert.equal(inspected.manifest.format, 'full')
    assert.equal(inspected.manifest.plugins[0].name, pick.name)
    assert.equal(inspected.blockingReasons.length, 0, '不该有阻断项：' + inspected.blockingReasons.join('；'))
    assert.equal(inspected.scan.counts.high, 0, '自己打包不该有高风险')
  })

  let result = null
  await step('装进临时 profile，但先不启用（enableBundles:false）', async () => {
    result = await installPack({
      manifest: inspected.manifest,
      entries: inspected.entries,
      config,
      options: { dryRun: false, keepLocal: false, applyConfig: false, enableBundles: false },
      context: { profileDir: sbDir },
    })
    assert.equal(result.ok, true, '安装应成功：' + JSON.stringify(result.actions))
    assert.equal(result.needsRestart, false, '不启用就不该提示重启')
    assert.ok(result.lines.some((l) => l.includes('未启用')), '应说明未启用（bundle 未登记）')
    log('     ' + (result.actions[0] && result.actions[0].message))
  })

  await step('临时 profile 状态复核', async () => {
    const pkg = readJson(path.join(sbDir, 'package.json'))
    assert.ok(pkg.dependencies && pkg.dependencies[pick.name], '依赖应写进 package.json')
    assert.deepEqual(readBundles(pkg), [], 'bundles 必须还是空的（= 不启用）')
    const entries = fs.readdirSync(path.join(sbDir, 'node_modules')).filter((n) => !n.startsWith('.'))
    assert.ok(entries.includes(pick.name) || entries.includes('@'), 'node_modules 里应有它')
    const after = listInstalled(sbDir).filter((p) => p.name === pick.name)
    assert.equal(after.length, 1, '应能在临时 profile 里读到它')
  })

  await step('真的没被启用：desktop profile 一字未动', async () => {
    const desktopPkg = readJson(path.join(pathsFor(base).profile, 'package.json'))
    const bundles = readBundles(desktopPkg)
    assert.equal(bundles.includes(SB_NAME), false)
    assert.equal(bundles.includes(pick.name), true, 'desktop 本来就装着它（不是我们加的）')
    assert.equal(desktopPkg.dependencies[SB_NAME], undefined, 'desktop 不该出现沙箱 profile 依赖')
  })
} finally {
  // Windows 上目录刚被 pnpm 用过，删太快会 EPERM；多试几次
  try { fs.rmSync(sbDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch (e) { log('清理临时 profile 失败：' + e.message) }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch (e) { log('清理临时目录失败：' + e.message) }
  log(`清理：${sbDir} 与 ${tmp} 已删除`)
}

console.log('\n' + report.join('\n'))
if (!ok || report.some((r) => r.startsWith('FAIL'))) { console.log('sandbox e2e: 有失败项'); process.exitCode = 1 }
else console.log(`sandbox e2e: 全部通过（${report.length} 项）`)
