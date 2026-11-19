/**
 * 全套沙箱自测：随机挑本机已装插件 → 打包（full / lite）→ 读包校验 → 三条安装路都试一遍 →
 * 全部删干净。不碰 desktop profile（前后比对字节）。
 *
 *   A. 打包 full（混合「本地改动 / 基础配置」）+ 读包：清单、完整性、扫描分组、安装器文件
 *   B. 篡改一个载荷文件后重打包，完整性必须报出来
 *   C. 「有插件」路线：用本插件的 installPack 装进临时 profile（走官方 dsh CLI）
 *   D. 「无插件」路线：解压包，用包里自带的 install/install.mjs 装进另一个临时 profile（--no-bundles）
 *   E. 轻量版：只带清单，安装时按版本从 npm 取包再装
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "<exe>" dev/tools/e2e-suite.mjs
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { loadConfig, pathsFor, profileDir, dshHome } from '../../lib/store.mjs'
import { listInstalled, readJson, readBundles } from '../../lib/profile.mjs'
import { buildPack } from '../../lib/pack.mjs'
import { inspectPackBuffer, installPack } from '../../lib/install.mjs'
import { writeZip, readZip } from '../../lib/zip.mjs'
import { downloadPackage, npmMetadata, pickVersion } from '../../lib/registry.mjs'
import { readIndex } from '../../lib/market-catalog.mjs'

const log = (msg) => console.log(msg)
const section = (msg) => console.log('\n== ' + msg)

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const seed = Number(process.env.SEED || (Date.now() % 1000000))
const rand = mulberry32(seed)
const pickRandom = (list, count) => {
  const copy = [...list]
  const out = []
  while (out.length < count && copy.length > 0) {
    out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0])
  }
  return out
}

const dirSize = (dir, limit = 200 * 1024 * 1024) => {
  let total = 0
  const walk = (current) => {
    let items = []
    try { items = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      const full = path.join(current, item.name)
      if (item.isDirectory()) { if (item.name !== 'node_modules' && item.name !== '.git') walk(full) } else {
        try { total += fs.statSync(full).size } catch { /* 忽略读不到的 */ }
      }
      if (total > limit) return
    }
  }
  walk(dir)
  return total
}

const hashFile = (file) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return 'missing' }
}

async function runNode(args, options = {}) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CI: '1' },
      windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.on('error', (error) => resolve({ code: -1, out: out + '\n' + error.message }))
    child.on('close', (code) => resolve({ code, out }))
  })
}

function writeEntriesTo(entries, root) {
  for (const entry of entries) {
    const target = path.join(root, entry.name)
    if (!target.startsWith(root + path.sep) && target !== root) throw new Error('条目逃逸：' + entry.name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.data)
  }
}

function makeProfile(name) {
  const dir = path.join(dshHome(), 'profiles', name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + name, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  fs.writeFileSync(path.join(dir, 'cordis.yml'), '# e2e profile\n[]\n')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# e2e patch layer\n[]\n')
  return dir
}

const base = loadConfig()
const realProfile = pathsFor(base).profile
const realProfilePath = realProfile

const report = []
let failed = 0
async function step(name, fn) {
  try {
    const detail = await fn()
    report.push('ok    ' + name + (detail ? '  · ' + detail : ''))
    log('ok    ' + name + (detail ? '  · ' + detail : ''))
  } catch (error) {
    failed += 1
    report.push('FAIL  ' + name + '  :: ' + ((error && error.message) || error))
    log('FAIL  ' + name + '  :: ' + ((error && error.message) || error))
  }
}

const desktopBefore = {
  pkg: hashFile(path.join(realProfilePath, 'package.json')),
  patch: hashFile(path.join(realProfilePath, 'cordis.patch.yml')),
}

const pool = listInstalled(realProfile).filter((p) => p.isPlugin && p.isDirect && p.name !== 'dsh-modpack-kit')
assert.ok(pool.length >= 3, '本机插件太少，至少要 3 个才能随机挑')
const withSizes = pool.map((p) => ({ ...p, bytes: dirSize(p.realDir || p.dir) })).sort((a, b) => a.bytes - b.bytes)
const chosen = pickRandom(withSizes, 3)
log('随机种子：' + seed)
log('随机挑中：')
for (const p of chosen) log('  - ' + p.name + '@' + p.version + '（' + (p.bytes / 1024).toFixed(0) + ' KB，' + (p.hasClient ? '带界面' : '无界面') + '）')

// 真实插件里常有 child_process 之类，扫描会照实报高危；这里模拟用户点了「我知道在干什么」
const modes = chosen.map((p, index) => (index === 0 ? 'local' : 'base'))
// 「基础配置」要求该版本能从 registry 取到：这里真的把 tarball 预取下来（顺便缓存给 buildPack 用），
// 免得预检过了、打包时下载超时又被降级成 local，把断言打成偶发失败
const prefetched = new Map()
for (let i = 0; i < chosen.length; i += 1) {
  if (modes[i] !== 'base') continue
  try {
    const { meta } = await npmMetadata(chosen[i].name, base)
    const version = pickVersion(meta, chosen[i].version)
    if (!version) throw new Error('没有 ' + chosen[i].version)
    const downloaded = await downloadPackage(chosen[i].name, version, base)
    prefetched.set(chosen[i].name + '@' + version, downloaded)
  } catch (error) {
    log('  ' + chosen[i].name + ' 取不到上游版本（' + String(error.message || error).slice(0, 60) + '），改用本地改动')
    modes[i] = 'local'
  }
}
log('打包模式：' + chosen.map((p, i) => p.name + '=' + modes[i]).join('，'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-modpack-e2e-'))
const p1 = 'modpack-e2e-plugin'
const p2 = 'modpack-e2e-stub'
const p3 = 'modpack-e2e-lite'
const vendorRoot = path.join(dshHome(), 'dsh-modpack', 'vendor')
const vendorBefore = new Set(fs.existsSync(vendorRoot) ? fs.readdirSync(vendorRoot) : [])

const config = {
  ...base,
  packDir: path.join(tmp, 'packs'),
  vendorDir: path.join(tmp, 'vendor'),
  maxPackBytes: 512 * 1024 * 1024,
}



let fullPack = null
let fullInspected = null
let litePack = null

try {
  section('A. 打包（full，混合模式）+ 读包')
  await step('打包 full：随机 3 个插件', async () => {
    fullPack = await buildPack({
      selection: chosen.map((p, i) => ({
        name: p.name,
        source: 'profile',
        mode: modes[i],
        // base 模式要拿上游原版：优先用上面预取好的那份（不再走网络），没有再现场下载
        download: (version) => {
          const key = p.name + '@' + (version || p.version)
          return prefetched.get(key) || downloadPackage(p.name, version || p.version, config)
        },
      })),
      options: {
        includePayload: true,
        includeConfig: true,
        includeLocalEdits: true,
        keepLocal: false,
        confirmLicense: true,
        acknowledge: true,
        name: '沙箱全套自测包',
        description: 'sandbox full suite',
        author: 'selftest',
      },
      context: { config, profileDir: realProfile, dshVersion: base.dshVersion || '', installed: pool, pluginVersion: 'selftest' },
    })
    assert.ok(fullPack.buffer.length > 5000, '包太小')
    assert.equal(fullPack.manifest.format, 'full')
    assert.equal(fullPack.manifest.plugins.length, 3)
    assert.equal(fullPack.manifest.security.scanned, true)
    log('      ' + fullPack.fileName + ' · ' + fullPack.buffer.length + ' 字节 · 扫描 ' + JSON.stringify(fullPack.scan.counts))
    return fullPack.buffer.length + ' 字节'
  })

  await step('读包：完整性、清单、安装器、报告都在', async () => {
    fullInspected = inspectPackBuffer(fullPack.buffer, { config })
    assert.equal(fullInspected.integrity.ok, true, '完整性应通过：' + JSON.stringify(fullInspected.integrity.mismatches))
    assert.equal(fullInspected.blockingReasons.length, 0, '不该有阻断：' + fullInspected.blockingReasons.join('；'))
    const names = fullInspected.entries.map((e) => e.name)
    for (const want of ['dsh-modpack.json', 'README.txt', 'security/report.txt', 'integrity.json', 'install/install.mjs', 'install/install.cmd', 'install/install.sh']) {
      assert.ok(names.includes(want), '缺少 ' + want)
    }
    const modesInManifest = fullInspected.manifest.plugins.map((p) => p.mode)
    assert.deepEqual(modesInManifest, modes, '清单里的 mode 应与选择一致')
    assert.ok(fullInspected.scanGroups && fullInspected.scanGroups.length >= 1, '应有按来源分组的扫描结果')
    log('      条目 ' + names.length + ' 个 · 分组 ' + fullInspected.scanGroups.length + ' 组')
    return names.length + ' 条目'
  })

  section('B. 篡改载荷后必须被完整性校验抓住')
  await step('改一个载荷文件再读包', async () => {
    const target = fullInspected.entries.find((e) => e.name.startsWith('plugins/') && e.name.endsWith('.js'))
    assert.ok(target, '包里应至少有一个插件 .js 文件')
    const tampered = fullInspected.entries.map((e) => (e.name === target.name
      ? { ...e, data: Buffer.concat([e.data, Buffer.from('\n// tampered\n')]) }
      : e))
    const tamperedZip = writeZip(tampered, { mtime: new Date() })
    const inspected = inspectPackBuffer(tamperedZip, { config })
    assert.equal(inspected.integrity.ok, false, '篡改后完整性必须失败')
    assert.ok(inspected.integrity.mismatches.length > 0, '应报出不一致的文件')
    log('      抓到不一致：' + inspected.integrity.mismatches.slice(0, 2).join(', '))
    return inspected.integrity.mismatches.length + ' 个文件不一致'
  })

  section('C. 「有插件」路线：installPack 装进临时 profile（走官方 CLI）')
  await step('装进 ' + p1 + '（登记 bundle + 回填配置）', async () => {
    makeProfile(p1)
    const result = await installPack({
      manifest: fullInspected.manifest,
      entries: fullInspected.entries,
      config,
      options: { dryRun: false, keepLocal: false, applyConfig: true, enableBundles: true },
      context: { profileDir: profileDir({ profile: p1 }) },
    })
    assert.equal(result.ok, true, '安装应成功：' + JSON.stringify(result.actions))
    const installedDir = path.join(dshHome(), 'profiles', p1)
    const pkg = readJson(path.join(installedDir, 'package.json'))
    for (const plugin of fullInspected.manifest.plugins) {
      assert.ok(pkg.dependencies && pkg.dependencies[plugin.name], '依赖缺 ' + plugin.name)
    }
    const bundles = readBundles(pkg)
    for (const plugin of fullInspected.manifest.plugins) {
      assert.ok(bundles.includes(plugin.name) || !plugin.isBundle, '应在 bundle 清单里：' + plugin.name)
    }
    const patch = fs.readFileSync(path.join(installedDir, 'cordis.patch.yml'), 'utf8')
    const captured = fullInspected.manifest.plugins.filter((p) => p.configIncluded)
    for (const plugin of captured) {
      assert.ok(patch.includes(plugin.name), '配置应回填进 cordis.patch.yml：' + plugin.name)
    }
    log('      ' + result.actions.map((a) => a.plugin + ':' + a.action).join(', '))
    return result.actions.length + ' 个动作，配置 ' + captured.length + ' 条'
  })

  await step('再装一遍：本机已装的先跳过，其余照装', async () => {
    const result = await installPack({
      manifest: fullInspected.manifest,
      entries: fullInspected.entries,
      config,
      options: { dryRun: false, keepLocal: false, applyConfig: true, enableBundles: true },
      context: { profileDir: profileDir({ profile: p1 }) },
    })
    assert.equal(result.ok, true, '第二次安装应成功：' + JSON.stringify(result.actions))
    const names = fullInspected.manifest.plugins.map((p) => p.name)
    assert.equal(result.deferred.length, names.length, '本机已装的三个都应进 deferred')
    for (const item of result.deferred) {
      assert.ok(names.includes(item.name), 'deferred 里应是清单里的插件：' + item.name)
      assert.equal(typeof item.localVersion, 'string')
      assert.equal(typeof item.packVersion, 'string')
    }
    for (const action of result.actions) {
      if (action.action === 'data') continue
      assert.equal(action.action, 'deferred', '这次不该动任何插件：' + action.plugin)
    }
    const pkg = readJson(path.join(dshHome(), 'profiles', p1, 'package.json'))
    for (const name of names) assert.ok(pkg.dependencies[name], '跳过不该删掉依赖：' + name)
    return result.deferred.length + ' 个已装被跳过'
  })

  await step('替换：只把选中的那个换成包内版本', async () => {
    const firstName = fullInspected.manifest.plugins[0].name
    const result = await installPack({
      manifest: fullInspected.manifest,
      entries: fullInspected.entries,
      config,
      options: { dryRun: false, keepLocal: false, applyConfig: true, enableBundles: true, replaceExisting: true, only: [firstName] },
      context: { profileDir: profileDir({ profile: p1 }) },
    })
    assert.equal(result.ok, true, '替换应成功：' + JSON.stringify(result.actions))
    assert.equal(result.deferred.length, 0, '替换模式下不该再有 deferred')
    const replaced = result.actions.find((a) => a.plugin === firstName)
    assert.ok(replaced, '应有被替换插件的动作')
    assert.equal(replaced.action, 'install', '选中的应真的走安装')
    for (const action of result.actions) {
      if (action.plugin === firstName || action.action === 'data') continue
      assert.equal(action.action, 'skipped', '没选中的不该动：' + action.plugin)
    }
    const pkg = readJson(path.join(dshHome(), 'profiles', p1, 'package.json'))
    assert.ok(pkg.dependencies[firstName], '替换后依赖应还在：' + firstName)
    log('      替换轨迹：' + result.actions.map((a) => a.plugin + ':' + a.action).join(', '))
    return '替换 1 个，跳过 ' + (result.actions.length - 1) + ' 个'
  })

  section('D. 「无插件」路线：解压后用包内独立安装器（模拟对方只有 DSH）')
  await step('解压到临时目录', async () => {
    const extractDir = path.join(tmp, 'unpacked')
    writeEntriesTo(fullInspected.entries, extractDir)
    const manifestOnDisk = readJson(path.join(extractDir, 'dsh-modpack.json'))
    assert.equal(manifestOnDisk.plugins.length, 3)
    return extractDir
  })

  await step('跑 install/install.mjs --profile ' + p2 + ' --no-bundles', async () => {
    makeProfile(p2)
    const extractDir = path.join(tmp, 'unpacked')
    const installer = path.join(extractDir, 'install', 'install.mjs')
    const run = await runNode([installer, '--profile', p2, '--no-bundles'], { cwd: extractDir })
    assert.equal(run.code, 0, '安装器退出码 ' + run.code + '\n' + run.out)
    assert.match(run.out, /装好了|安装完成|重启/, '安装器应打印完成信息')
    // 对方只有裸 DSH 时，也要能看到这份包是谁做的、叫什么、干什么用的
    assert.match(run.out, /打包者：\s*selftest/, '安装器应打印打包者')
    assert.match(run.out, /说明：\s*\n?sandbox full suite/, '安装器应打印包说明')
    assert.match(run.out, /包含插件：\s*\d+ 个/, '安装器应打印插件数')
    const targetDir = path.join(dshHome(), 'profiles', p2)
    const pkg = readJson(path.join(targetDir, 'package.json'))
    const names = fullInspected.manifest.plugins.map((p) => p.name)
    for (const name of names) {
      assert.ok(pkg.dependencies && pkg.dependencies[name], '安装器没写依赖：' + name)
      assert.match(String(pkg.dependencies[name]), /^file:/, '完整版依赖应指向 vendor：' + name)
    }
    assert.deepEqual(readBundles(pkg), [], '--no-bundles 时不该登记 bundle')
    const nodeModules = fs.readdirSync(path.join(targetDir, 'node_modules'))
    assert.ok(names.some((name) => nodeModules.includes(name)) || nodeModules.includes('@'), 'node_modules 里应有插件')
    log('      ' + run.out.split('\n').filter(Boolean).slice(-3).join(' / '))
    return names.length + ' 个依赖指向 vendor'
  })

  await step('再跑一次安装器：已装的会告知并跳过，并提示 --replace', async () => {
    const extractDir = path.join(tmp, 'unpacked')
    const installer = path.join(extractDir, 'install', 'install.mjs')
    const again = await runNode([installer, '--profile', p2, '--no-bundles'], { cwd: extractDir })
    assert.equal(again.code, 0, '第二次安装器退出码 ' + again.code + '\n' + again.out)
    assert.match(again.out, /本机已经装了/, '安装器应告诉用户本机已装')
    assert.match(again.out, /--replace/, '应提示怎么换成包内版本')
    const skippedLines = again.out.split('\n').filter((line) => /^  - /.test(line))
    assert.ok(skippedLines.length >= 3, '应逐条列出被跳过的插件')
    log('      ' + skippedLines.slice(0, 2).join(' / '))
    return skippedLines.length + ' 条跳过提示'
  })

  await step('vendor 里落了包、解压目录删掉也不断', async () => {
    const vendorDirs = fs.readdirSync(vendorRoot).filter((n) => !vendorBefore.has(n))
    assert.ok(vendorDirs.length >= 1, '应在 ~/.dsh/dsh-modpack/vendor 下新建目录')
    fs.rmSync(path.join(tmp, 'unpacked'), { recursive: true, force: true })
    const pkg = readJson(path.join(dshHome(), 'profiles', p2, 'package.json'))
    for (const [name, spec] of Object.entries(pkg.dependencies)) {
      if (!String(spec).startsWith('file:')) continue
      const depDir = String(spec).slice(5)
      assert.ok(fs.existsSync(path.join(depDir, 'package.json')), '删除解压目录后依赖不应断：' + name)
    }
    log('      vendor 新增 ' + vendorDirs.length + ' 个目录')
    return vendorDirs.join(', ')
  })

  section('E. 轻量版：只带清单，安装时按版本取包')
  let liteTarget = null
  await step('挑一个 npm 上取得到的插件并打 lite 包', async () => {
    for (const plugin of chosen) {
      try {
        const meta = await downloadPackage(plugin.name, plugin.version, config)
        liteTarget = { plugin, meta }
        break
      } catch (error) {
        log('      ' + plugin.name + ' 取不到：' + String(error.message || error).slice(0, 80))
      }
    }
    assert.ok(liteTarget, '随机挑中的插件在 npm 上都取不到，换一次种子再跑')
    const lite = await buildPack({
      selection: [{
        name: liteTarget.plugin.name,
        source: 'profile',
        mode: 'base',
        download: (version) => downloadPackage(liteTarget.plugin.name, version || liteTarget.plugin.version, config),
      }],
      options: { includePayload: false, includeConfig: true, confirmLicense: true, acknowledge: true, name: '沙箱轻量包', author: 'selftest' },
      context: { config, profileDir: realProfile, dshVersion: base.dshVersion || '', installed: pool, pluginVersion: 'selftest' },
    })
    assert.equal(lite.manifest.format, 'lite')
    const names = readZip(lite.buffer, {}).map((e) => e.name)
    assert.equal(names.some((n) => n.startsWith('plugins/')), false, 'lite 不该带源码')
    litePack = { buffer: lite.buffer, manifest: lite.manifest, fileName: lite.fileName }
    log('      ' + lite.fileName + ' · ' + lite.buffer.length + ' 字节')
    return lite.buffer.length + ' 字节'
  })

  await step('装进 ' + p3 + '（从 npm 取包 + 补扫）', async () => {
    const lite = litePack
    assert.ok(lite, '上一步没产出轻量包')
    makeProfile(p3)
    const inspected = inspectPackBuffer(lite.buffer, { config })
    const extractRoot = path.join(tmp, 'lite-resolved')
    const result = await installPack({
      manifest: inspected.manifest,
      entries: inspected.entries,
      config,
      options: { dryRun: false, keepLocal: false, applyConfig: true, enableBundles: false },
      context: {
        profileDir: profileDir({ profile: p3 }),
        resolveSource: async (plugin) => {
          const dir = path.join(extractRoot, plugin.name)
          const downloaded = await downloadPackage(plugin.name, plugin.version, config)
          for (const entry of downloaded.entries) {
            const target = path.join(dir, entry.name.replace(/^package\//, ''))
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.writeFileSync(target, entry.data)
          }
          return dir
        },
      },
    })
    assert.equal(result.ok, true, '轻量包安装应成功：' + JSON.stringify(result.actions))
    const pkg = readJson(path.join(dshHome(), 'profiles', p3, 'package.json'))
    assert.ok(pkg.dependencies[liteTarget.plugin.name], '依赖应写入')
    log('      ' + result.actions.map((a) => a.plugin + ':' + a.action).join(', '))
    return '依赖 ' + String(pkg.dependencies[liteTarget.plugin.name])
  })
} finally {
  section('G. 市场里没装的插件也能打包（按版本从 registry 取包）')
  await step('挑一个本机没装的市场插件打 full 包', async () => {
    const installedNames = new Set(pool.map((p) => p.name))
    // 从市场目录索引里找一个本机没装的（目录索引可能没有，再退回候选名单）
    const candidates = []
    try {
      const index = readIndex(config)
      for (const item of (index && Array.isArray(index.plugins) ? index.plugins : [])) {
        if (!item || !item.name || installedNames.has(item.name)) continue
        if (!/^[a-z0-9@._-]+$/i.test(item.name)) continue
        candidates.push(item.name)
        if (candidates.length >= 12) break
      }
    } catch { /* 没索引就只靠候选名单 */ }
    candidates.push('dsh-theme-endfield', 'dsh-whale-widget', 'dsh-ops', 'dsh-plugin-memory')
    let target = null
    for (const name of candidates) {
      if (installedNames.has(name)) continue
      try {
        const { meta } = await npmMetadata(name, config)
        const version = pickVersion(meta, '')
        if (version) { target = { name, version }; break }
      } catch { /* 换下一个 */ }
    }
    assert.ok(target, '找不到本机没装且 npm 上可取到的插件')
    const pack = await buildPack({
      selection: [{
        name: target.name,
        source: 'npm',
        spec: target.version,
        download: (spec) => downloadPackage(target.name, spec || target.version, config),
      }],
      options: {
        includePayload: true,
        includeConfig: false,
        includeLocalEdits: false,
        confirmLicense: true,
        acknowledge: true,
        name: '市场未装包',
        description: 'pack a plugin that is not installed',
        author: 'selftest',
      },
      context: { config, profileDir: realProfile, dshVersion: base.dshVersion || '', installed: pool, pluginVersion: 'selftest' },
    })
    assert.equal(pack.manifest.format, 'full')
    const entry = pack.manifest.plugins[0]
    assert.equal(entry.source, 'npm', '未安装的插件应记成市场来源')
    assert.equal(entry.localEdits, false)
    assert.equal(entry.mode, 'base')
    assert.ok(entry.files > 0, '应真的取到文件')
    const entries = readZip(pack.buffer)
    assert.ok(entries.some((e) => e.name === 'plugins/' + target.name + '/package.json'), '载荷里应有该插件的 package.json')
    const inspected = inspectPackBuffer(pack.buffer, { config })
    assert.equal(inspected.integrity.ok, true, '从市场取的包完整性应通过')
    log('      ' + target.name + '@' + entry.version + ' · ' + entry.files + ' 个文件 · ' + Math.round(pack.size / 1024) + ' KB')
    return target.name + '@' + entry.version
  })

  section('F. 清理与回归')
  for (const name of [p1, p2, p3]) {
    try { fs.rmSync(path.join(dshHome(), 'profiles', name), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch (error) { log('清 profile ' + name + ' 失败：' + error.message) }
  }
  const vendorAfter = fs.existsSync(vendorRoot) ? fs.readdirSync(vendorRoot).filter((n) => !vendorBefore.has(n)) : []
  for (const dir of vendorAfter) {
    try { fs.rmSync(path.join(vendorRoot, dir), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch (error) { log('清 vendor ' + dir + ' 失败：' + error.message) }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch (error) { log('清临时目录失败：' + error.message) }
  log('清理：3 个临时 profile、vendor 新增 ' + vendorAfter.length + ' 个目录、临时目录 ' + tmp + ' 均已删除')

  const desktopAfter = {
    pkg: hashFile(path.join(realProfilePath, 'package.json')),
    patch: hashFile(path.join(realProfilePath, 'cordis.patch.yml')),
  }
  await step('desktop profile 一字未动', async () => {
    assert.equal(desktopAfter.pkg, desktopBefore.pkg, 'desktop package.json 被改了')
    assert.equal(desktopAfter.patch, desktopBefore.patch, 'desktop cordis.patch.yml 被改了')
    return 'byte-identical'
  })
}

console.log('\n' + report.join('\n'))
if (failed > 0) { console.log('\ne2e suite: ' + failed + ' 项失败'); process.exitCode = 1 } else { console.log('\ne2e suite: 全部通过（' + report.length + ' 项）') }
