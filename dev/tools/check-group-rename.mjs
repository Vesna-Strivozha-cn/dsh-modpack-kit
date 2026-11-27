import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPack } from '../../lib/pack.mjs'
import { inspectPackBuffer, installPack } from '../../lib/install.mjs'
import { DEFAULT_CONFIG } from '../../lib/store.mjs'

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'gcheck-' + tag + '-'))
const home = tmp('home')
process.env.DSH_HOME = home
const target = path.join(home, 'profiles', 'desktop')
fs.mkdirSync(path.join(target, '.dsh-market'), { recursive: true })
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'desktop', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2))
fs.writeFileSync(path.join(target, '.dsh-market', 'state.json'), JSON.stringify({ groups: {}, groupOrder: [] }, null, 2))

const mkPlugin = (name, version, group) => {
  const dir = path.join(target, 'node_modules', name)
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, license: 'MIT', exports: { './client': './client.js' } }, null, 2))
  fs.writeFileSync(path.join(dir, 'client.js'), 'export function apply() {}\n')
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export const ok = true\n')
  return { name, version, license: 'MIT', isPlugin: true, isDirect: true, dirName: name, pkg: { name, version, license: 'MIT' }, group }
}

const config = { ...DEFAULT_CONFIG, maxPackBytes: 64 * 1024 * 1024 }
const runCli = async () => ({ code: 0, output: 'fake cli' })

async function makePack(tag, plugin) {
  const pack = await buildPack({
    selection: [{ name: plugin.name, source: 'profile', mode: 'base', group: plugin.group }],
    options: { strategy: 'lite', confirmLicense: true },
    context: { config, installed: [plugin], profileDir: target },
  })
  return pack.buffer || pack
}

const a = mkPlugin('demo-a', '1.2.3', '日常')
const b = mkPlugin('demo-b', '1.2.3', '日常')
const packA = await makePack('a', a)
const packB = await makePack('b', b)
const ia = inspectPackBuffer(packA, { config })
const ib = inspectPackBuffer(packB, { config })
const ra = await installPack({ manifest: ia.manifest, entries: ia.entries, config, options: { dryRun: false, keepLocal: false, applyConfig: false, enableBundles: false }, context: { profileDir: target, runCli } })
const rb = await installPack({ manifest: ib.manifest, entries: ib.entries, config, options: { dryRun: false, keepLocal: false, applyConfig: false, enableBundles: false }, context: { profileDir: target, runCli } })
const state = JSON.parse(fs.readFileSync(path.join(target, '.dsh-market', 'state.json'), 'utf8'))
console.log(JSON.stringify({ firstOk: ra.ok, secondOk: rb.ok, groups: state.groups, origins: state.groupOrigins, order: state.groupOrder, secondLines: rb.lines.slice(-3) }, null, 2))
