// 沙箱自测：三种打包策略在「装的时候插件市场认不认」——
// 分别走「本插件安装」和「裸 DSH 用包内安装器」，联网 / 断网两路都试。
// 判据按插件市场自己的规则：profile 依赖写成 semver（^x.y.z）= 市场版；写成 file:/link: = 本地安装。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { buildPack } from '../../lib/pack.mjs'
import { inspectPackBuffer, installPack } from '../../lib/install.mjs'
import { loadConfig, pathsFor } from '../../lib/store.mjs'
import { listInstalled } from '../../lib/profile.mjs'
import { npmMetadata, downloadPackage } from '../../lib/registry.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const mkTemp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'recog-' + tag + '-'))
const config = loadConfig()
const realProfile = pathsFor(config).profile
const installed = listInstalled(realProfile)
const homeDsh = path.join(os.homedir(), '.dsh', 'profiles')

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/
// 挑两个本机已装、版本是干净 semver 的插件（lite/hybrid 会按 名字@版本 去市场取）
const preferred = ['dsh-context', 'dsh-ops', 'dsh-better-sidebar', 'dsh-whale-widget']
const pool = installed.filter((p) => p.isDirect && p.isPlugin && p.version && SEMVER.test(String(p.version)) && String(p.version) !== '0.0.0')
const picks = preferred.map((n) => pool.find((p) => p.name === n)).filter(Boolean).slice(0, 2)
if (picks.length < 2) picks.push(...pool.filter((p) => !picks.includes(p)).slice(0, 2 - picks.length))
if (picks.length < 2) {
  console.error('本机找不到两个可直接按版本装的插件')
  process.exit(1)
}
console.log('用这两个插件打包：' + picks.map((p) => p.name + '@' + p.version).join(' + '))

const selection = picks.map((p) => ({ name: p.name, source: 'profile', mode: 'base', configMode: 'preset' }))
const runCli = null // 用真实命令行
// 与 index.js 给安装器的那套 context 对齐：轻量包要能自己从市场取包
const resolveMarket = async (plugin) => {
  const meta = await npmMetadata(plugin.name, config, { version: plugin.version || '' })
  const tags = (meta.meta && meta.meta['dist-tags']) || {}
  const version = plugin.version && plugin.version !== '0.0.0' ? String(plugin.version) : String(tags.latest || '')
  if (!version) return null
  return { spec: plugin.name + '@' + version, version }
}
const resolveSourceEntries = async (plugin) => (await downloadPackage(plugin.name, plugin.version && plugin.version !== '0.0.0' ? plugin.version : '', config)).entries

function makeProfile(tag) {
  const dir = path.join(homeDsh, 'modpack-recog-' + tag)
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'modpack-recog-' + tag, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2))
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '[]\n')
  return dir
}

function depsOf(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return pkg.dependencies || {}
  } catch {
    return {}
  }
}

function recognition(deps) {
  const entries = Object.entries(deps)
  if (entries.length === 0) return { verdict: '没装上', detail: '' }
  const market = entries.filter(([, spec]) => !/^(?:file|link):/iu.test(String(spec)))
  const local = entries.filter(([, spec]) => /^(?:file|link):/iu.test(String(spec)))
  const verdict = local.length === 0 ? '市场版' : market.length === 0 ? '本地安装' : '混合'
  return { verdict, detail: entries.map(([name, spec]) => name + '=' + spec).join(', ') }
}

async function buildOne(strategy) {
  const pack = await buildPack({ selection, options: { strategy, confirmLicense: true, acknowledge: true }, context: { config, profileDir: realProfile, installed } })
  const inspected = inspectPackBuffer(pack.buffer, { config })
  return { pack, inspected }
}

async function installOurPlugin(strategy, opts) {
  const tag = strategy + (opts.offline ? '-off' : '-net') + '-plugin'
  const dir = makeProfile(tag)
  const { inspected } = await buildOne(strategy)
  const result = await installPack({
    manifest: inspected.manifest,
    entries: inspected.entries,
    config,
    options: { dryRun: false, keepLocal: false, applyConfig: false, enableBundles: false, ...opts },
    context: { profileDir: dir, runCli, resolveMarket, resolveSourceEntries },
  })
  const deps = depsOf(dir)
  const rec = recognition(deps)
  const info = { tag, strategy, via: '本插件', offline: Boolean(opts.offline), ok: result.ok, verdict: rec.verdict, deps: rec.detail, lines: result.lines.slice(-2) }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  return info
}

async function installBare(strategy, opts) {
  const tag = strategy + (opts.offline ? '-off' : '-net') + '-bare'
  const dir = makeProfile(tag)
  const { pack } = await buildOne(strategy)
  const stage = mkTemp('stage-' + tag)
  // 把包解开，模拟「纯净版 DSH 只拿到一个 .dshpack 文件」
  const zip = await import('../../lib/zip.mjs')
  for (const entry of zip.readZip(pack.buffer)) {
    const target = path.join(stage, entry.name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.data)
  }
  const args = [path.join(stage, 'install', 'install.mjs'), '--profile', 'modpack-recog-' + tag, '--no-bundles']
  if (opts.offline) args.push('--offline')
  const child = spawnSync(process.execPath, ['--expose-internals', ...args], {
    cwd: stage,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600000,
  })
  const deps = depsOf(dir)
  const rec = recognition(deps)
  const info = { tag, strategy, via: '裸 DSH 安装器', offline: Boolean(opts.offline), ok: child.status === 0 && rec.verdict !== '没装上', verdict: rec.verdict, deps: rec.detail, exit: child.status, tail: String(child.stdout || '').trim().split('\n').slice(-2).join(' | '), err: String(child.stderr || '').trim().split('\n').slice(-1)[0] || '' }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  fs.rmSync(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  return info
}

const rows = []
for (const strategy of ['full', 'lite', 'hybrid']) {
  rows.push(await installOurPlugin(strategy, {}))
  rows.push(await installOurPlugin(strategy, { offline: true }))
}
// 裸 DSH：完整包（懒人包）联网 / 断网各一次
rows.push(await installBare('full', {}))
rows.push(await installBare('full', { offline: true }))
// 轻量包给裸 DSH 只能联网
rows.push(await installBare('lite', {}))

console.log('\n策略 | 安装方式 | 网络 | 结果 | 市场判定 | 依赖')
for (const r of rows) {
  console.log([r.strategy, r.via, r.offline ? '断网' : '联网', r.ok ? '成功' : '失败', r.verdict, (r.deps || r.err || '').slice(0, 120)].join(' | '))
}
console.log('\nJSON ' + JSON.stringify(rows))

// 清理：万一还有残留 profile 也一并删掉
for (const name of fs.readdirSync(homeDsh)) {
  if (name.startsWith('modpack-recog-')) fs.rmSync(path.join(homeDsh, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
