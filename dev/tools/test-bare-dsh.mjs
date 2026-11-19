/**
 * 纯 DSH 兼容测试：本机没有装 dsh-modpack-kit 也能把整合包装好。
 *
 * 做法：拿真实的 DSH 命令行（此刻宿主 exe + cli.js），用一个全新的 profile 名
 * （DSH 会在第一次装插件时自动初始化），只跑包内自带的 install/install.mjs，
 * 全程不碰 desktop profile、也不依赖本插件注册的任何服务。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

import { loadConfig, pathsFor } from '../../lib/store.mjs'
import { listInstalled, dshVersion, readPatch, readProfilePackage, readBundles } from '../../lib/profile.mjs'
import { buildPack } from '../../lib/pack.mjs'
import { readZip } from '../../lib/zip.mjs'
import { parseYaml } from '../../lib/yamlish.mjs'

const PROFILE = 'bare-dsh-check'
const home = path.join(os.homedir(), '.dsh')
const targetProfile = path.join(home, 'profiles', PROFILE)
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bare-'))
const results = []
const ok = (label, detail = '') => results.push({ ok: true, label, detail })
const fail = (label, detail = '') => results.push({ ok: false, label, detail })
const say = (line) => console.log(line)

const sha = (file) => (fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'missing')
const desktopPkg = path.join(home, 'profiles', 'desktop', 'package.json')
const desktopPatch = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
const desktopBefore = { pkg: sha(desktopPkg), patch: sha(desktopPatch) }

const config = loadConfig()
const profileDir = pathsFor(config).profile
const installed = listInstalled(profileDir).filter((p) => p.isPlugin && p.isDirect && p.name !== 'dsh-modpack-kit')
// 挑一个有配置的 + 两个没配置的：配置回填这条路必须走到
const patchItems = (() => { try { return parseYaml(readPatch(profileDir)) || [] } catch { return [] } })()
const configOwner = installed.find((p) => patchItems.some((item) => item && (item.name === p.name || item.id === p.name) && item.config && Object.keys(item.config).length > 0))
const picked = [configOwner, installed.find((p) => p.name === 'dsh-context'), installed.find((p) => p.name === 'dsh-plugin-memory')].filter(Boolean)
if (picked.length < 2) {
  console.error('本机可用来测试的插件不足')
  process.exit(2)
}
say('用于测试的插件：' + picked.map((p) => p.name + '@' + p.version).join('、'))

try {
  // 1) 打一个完整包（含载荷、配置、数据）
  const built = await buildPack({
    selection: picked.map((p) => ({ name: p.name, source: 'profile', spec: '', mode: 'local' })),
    options: {
      includePayload: true,
      includeConfig: true,
      includeLocalEdits: true,
      acknowledge: true,
      confirmLicense: true,
      name: '纯 DSH 兼容测试包',
      author: 'bare-check',
    },
    context: {
      config,
      profileDir,
      dshVersion: dshVersion(profileDir),
      installed,
      pluginVersion: '0.1.7',
      parsePatch: parseYaml,
      patchText: readPatch(profileDir),
    },
  })
  ok('打包（full）', built.fileName + ' · ' + built.size + ' 字节')

  // 2) 只用包内自带的东西解出来
  const entries = readZip(Buffer.from(built.buffer))
  const unpacked = path.join(tmpRoot, 'unpacked')
  for (const entry of entries) {
    const out = path.join(unpacked, entry.name)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, entry.data)
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'dsh-modpack.json'), 'utf8'))
  ok('解包（不依赖本插件）', entries.length + ' 个条目，清单 ' + manifest.plugins.length + ' 个插件')
  const withConfig = manifest.plugins.filter((p) => p.config && Object.keys(p.config).length > 0)
  withConfig.length > 0
    ? ok('清单带配置快照', withConfig.map((p) => p.name + '（' + Object.keys(p.config).length + ' 个字段）').join('、'))
    : fail('清单带配置快照', '这个包一个配置都没抓到，配置回填这条路没被覆盖')

  // 3) 只跑包内的 install/install.mjs，用真实 DSH 命令行装进全新 profile
  const installer = path.join(unpacked, 'install', 'install.mjs')
  const run = spawnSync(process.execPath, [installer, '--profile', PROFILE, '--no-bundles'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CI: '1' },
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
  })
  const output = String(run.stdout || '') + String(run.stderr || '')
  if (run.status === 0) ok('独立安装器跑通（用真实 DSH 命令行）', '退出码 0')
  else fail('独立安装器跑通（用真实 DSH 命令行）', '退出码 ' + run.status + '：' + output.split('\n').slice(-6).join(' | '))

  // 4) 新 profile 里该有的东西
  const pkgFile = path.join(targetProfile, 'package.json')
  if (fs.existsSync(pkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    const deps = pkg.dependencies || {}
    const filled = picked.every((p) => typeof deps[p.name] === 'string' && deps[p.name].length > 0)
    filled ? ok('依赖写进新 profile', picked.map((p) => p.name + '=' + deps[p.name]).join('、').slice(0, 160)) : fail('依赖写进新 profile', JSON.stringify(deps).slice(0, 240))
    const missing = picked.filter((p) => !fs.existsSync(path.join(targetProfile, 'node_modules', p.name, 'package.json')))
    missing.length === 0 ? ok('包体落在新 profile 的 node_modules') : fail('包体落在新 profile 的 node_modules', missing.map((p) => p.name).join('、'))
    const bundles = readBundles(pkg)
    const leaked = picked.filter((p) => bundles.includes(p.name))
    leaked.length === 0
      ? ok('--no-bundles：这几个插件没被登记进启用清单（装了但不加载）', '清单里只有宿主自己的：' + bundles.join('、'))
      : fail('--no-bundles：这几个插件不该被登记进启用清单', leaked.join('、'))
  } else {
    fail('新 profile 被创建', '没有 package.json')
  }

  // 5) 配置回填进新 profile 的补丁层
  const patchFile = path.join(targetProfile, 'cordis.patch.yml')
  if (fs.existsSync(patchFile)) {
    const text = fs.readFileSync(patchFile, 'utf8')
    let parsed = []
    try {
      parsed = parseYaml(text) || []
    } catch (error) {
      fail('补丁文件能被解析', String(error && error.message) + '｜原文：' + JSON.stringify(text.slice(0, 400)))
    }
    const want = manifest.plugins.filter((p) => p.config && Object.keys(p.config).length > 0)
    const bad = []
    for (const p of want) {
      const hit = parsed.find((item) => item && (item.id === p.name || item.name === p.name))
      if (!hit) { bad.push(p.name + '（缺条目）'); continue }
      const same = JSON.stringify(hit.config ?? null) === JSON.stringify(p.config)
      if (!same) bad.push(p.name + '（内容不一致）')
    }
    bad.length === 0
      ? ok('配置回填进补丁层且内容一致', want.map((p) => p.name).join('、') || '没有带配置的插件')
      : fail('配置回填进补丁层且内容一致', bad.join('、'))
  } else {
    ok('没有配置需要回填', '清单里没有带配置的插件')
  }

  // 6) 纯 DSH 自己能不能认这个 profile
  const exe = process.execPath
  const cli = path.join(path.dirname(exe), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  if (fs.existsSync(cli)) {
    const list = spawnSync(exe, ['--expose-internals', cli, 'plugin', '--profile', PROFILE, 'list', '--depth', '0'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CI: '1' },
      encoding: 'utf8',
      timeout: 120000,
    })
    const listed = String(list.stdout || '')
    const seen = picked.filter((p) => listed.includes(p.name))
    seen.length === picked.length
      ? ok('纯 DSH 命令行能列出这些插件', 'dsh plugin --profile ' + PROFILE + ' list 命中 ' + seen.length + '/' + picked.length)
      : fail('纯 DSH 命令行能列出这些插件', '只命中 ' + seen.length + '/' + picked.length + '：' + listed.split('\n').slice(0, 8).join(' | '))
  } else {
    ok('跳过 dsh list 复核', '没找到 cli.js（不在桌面版安装结构里）')
  }

  // 7) desktop 一字未动
  const after = { pkg: sha(desktopPkg), patch: sha(desktopPatch) }
  after.pkg === desktopBefore.pkg && after.patch === desktopBefore.patch
    ? ok('desktop profile 一字未动', 'byte-identical')
    : fail('desktop profile 一字未动', 'package.json 或补丁文件被改动了')
} finally {
  // 清理：新 profile、vendor 里这次落的目录、临时目录
  const vendorDir = path.join(home, 'dsh-modpack', 'vendor')
  const vendorBefore = new Set(fs.existsSync(vendorDir) ? fs.readdirSync(vendorDir) : [])
  try { fs.rmSync(targetProfile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch {}
  if (fs.existsSync(vendorDir)) {
    for (const name of fs.readdirSync(vendorDir)) {
      if (!vendorBefore.has(name)) {
        try { fs.rmSync(path.join(vendorDir, name), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) } catch {}
      }
    }
  }
  say('清理：profile ' + PROFILE + '、临时目录与本次 vendor 已删除')
}

let bad = 0
for (const r of results) {
  say((r.ok ? 'ok   ' : 'FAIL ') + r.label + (r.detail ? '  · ' + r.detail : ''))
  if (!r.ok) bad += 1
}
say('')
say(bad === 0 ? '纯 DSH 兼容测试：全部通过（' + results.length + ' 项）' : '纯 DSH 兼容测试：失败 ' + bad + ' 项（共 ' + results.length + ' 项）')
process.exit(bad === 0 ? 0 : 1)
