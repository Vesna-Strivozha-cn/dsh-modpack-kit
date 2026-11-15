/**
 * 联网烟测：只读。验证目录抓取、npm 元数据、取包校验、本机打包读回。
 * 需要外网；失败不写任何东西，只打印。
 */
import assert from 'node:assert/strict'
import { fetchCatalog, npmMetadata, downloadPackage } from '../lib/registry.mjs'
import { loadConfig, pathsFor } from '../lib/store.mjs'
import { listInstalled, dshVersion, readPatch } from '../lib/profile.mjs'
import { buildPack } from '../lib/pack.mjs'
import { inspectPackBuffer } from '../lib/install.mjs'
import { parseYaml } from '../lib/yamlish.mjs'

const config = loadConfig()
const profileDir = pathsFor(config).profile
const report = []
const step = async (name, fn) => {
  const t0 = Date.now()
  try { await fn(); report.push('ok   ' + name + '（' + (Date.now() - t0) + 'ms）') }
  catch (e) { report.push('FAIL ' + name + ' :: ' + ((e && e.message) || e)); process.exitCode = 1 }
}

let catalog = []
await step('插件市场目录（官方或 npm 兜底）', async () => {
  catalog = await fetchCatalog(config)
  assert.ok(catalog.length > 0, '目录为空')
  assert.ok(catalog.every((item) => typeof item.name === 'string' && item.name.length > 0))
})

let picked = null
await step('npm 元数据 + 取包校验', async () => {
  const name = (catalog.find((item) => /^dsh-/.test(item.name)) || {}).name || 'dshmarket'
  const { meta, registry } = await npmMetadata(name, config)
  const latest = meta['dist-tags'] && meta['dist-tags'].latest
  assert.ok(latest, '没有 latest 版本')
  const pkg = await downloadPackage(name, latest, config)
  assert.equal(pkg.name, name)
  assert.ok(pkg.entries.length > 0)
  picked = pkg
  report.push('     取到 ' + name + '@' + latest + ' 来自 ' + registry + '，' + pkg.entries.length + ' 个文件')
})

await step('本机插件打包（完整版）并读回完整性', async () => {
  const installed = listInstalled(profileDir)
  const target = installed.find((p) => p.name === 'dsh-bili-account-bridge') || installed.find((p) => p.isBundle && p.hasClient)
  assert.ok(target, '没有可打包的插件')
  const built = await buildPack({
    selection: [{ name: target.name, source: 'profile' }],
    options: { includePayload: true, includeConfig: true, name: 'live 烟测', confirmLicense: true, force: true },
    context: { config, profileDir, dshVersion: dshVersion(profileDir), installed, pluginVersion: '0.1.0', parsePatch: parseYaml, patchText: readPatch(profileDir) },
  })
  assert.ok(built.buffer.length > 0)
  const inspected = inspectPackBuffer(built.buffer, { config })
  assert.equal(inspected.integrity.ok, true)
  assert.equal(inspected.manifest.format, 'full')
  report.push('     包体 ' + built.size + ' 字节，扫描 高/中/低 = ' + built.scan.counts.high + '/' + built.scan.counts.medium + '/' + built.scan.counts.low)
})

console.log(report.join('\n'))
console.log(process.exitCode ? 'live: 有失败项' : 'live: 全部通过（' + report.length + ' 项）')
