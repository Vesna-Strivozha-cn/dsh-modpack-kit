/**
 * dsh-modpack —— 只读 + 受控写入 DSH profile。
 *
 * 读：profile/package.json、bundles 列表、node_modules 里已装插件、DSH 版本。
 * 写：只有三处，且每处先备份——
 *   1. package.json 的 `dsh.profile.bundles`（让 DSH 下次启动加载整合包里的插件）；
 *   2. cordis.patch.yml 里按 id 覆盖单条配置（只改那一条，其他字节不动）；
 *   3. 调用官方 CLI `dsh plugin --profile <p> add …` 装包（和插件市场同一条路径）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { writeJsonAtomic, appendLog } from './store.mjs'

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function readProfilePackage(profileDir) {
  return readJson(path.join(profileDir, 'package.json'), null)
}

export function listInstalled(profileDir) {
  const modulesDir = path.join(profileDir, 'node_modules')
  const out = []
  let dirents
  try {
    dirents = fs.readdirSync(modulesDir, { withFileTypes: true })
  } catch {
    return out
  }
  const push = (dir, namePrefix) => {
    const name = namePrefix ? namePrefix + '/' + dir : dir
    const dirPath = path.join(modulesDir, name)
    const pkg = readJson(path.join(dirPath, 'package.json'), null)
    if (!pkg || typeof pkg !== 'object') return
    let real = dirPath
    try { real = fs.realpathSync(dirPath) } catch {}
    let size = 0
    try {
      const stat = fs.statSync(real)
      size = stat.isDirectory() ? 0 : stat.size
    } catch {}
    out.push({
      name: typeof pkg.name === 'string' ? pkg.name : name,
      dirName: name,
      version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
      dir: dirPath,
      realDir: real,
      pkg,
      isBundle: Boolean(pkg.dsh && (pkg.dsh.bundle || pkg.dsh.client)),
      hasClient: Boolean(pkg.dsh && pkg.dsh.client) || Boolean(pkg.exports && (pkg.exports['./client'] || pkg.exports['./client.js'])),
      hasPatch: Boolean(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch),
      // 是不是"给 DSH 用的插件"，而不是某个插件的传递依赖
      description: typeof pkg.description === 'string' ? pkg.description.slice(0, 300) : '',
      isPlugin: Boolean(
        pkg.dsh
        || (Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin'))
        || /^(?:@[^/]+\/)?dsh[-.]/u.test(name),
      ),
      size,
    })
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
    if (dirent.name.startsWith('.')) continue
    if (dirent.name.startsWith('@')) {
      let scoped = []
      try { scoped = fs.readdirSync(path.join(modulesDir, dirent.name), { withFileTypes: true }) } catch {}
      for (const sub of scoped) {
        if (sub.isDirectory() || sub.isSymbolicLink()) push(sub.name, dirent.name)
      }
      continue
    }
    push(dirent.name, '')
  }
  out.sort((a, b) => (a.isBundle === b.isBundle ? a.name.localeCompare(b.name) : a.isBundle ? -1 : 1))
  return out
}

export function dshVersion(profileDir) {
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    const pkg = readJson(path.join(profileDir, 'node_modules', name, 'package.json'), null)
    if (pkg && typeof pkg.version === 'string') return pkg.version
  }
  return ''
}

export function readBundles(profilePkg) {
  const list = profilePkg && profilePkg.dsh && profilePkg.dsh.profile && profilePkg.dsh.profile.bundles
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
}

function backup(file) {
  if (!fs.existsSync(file)) return ''
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const target = file + '.bak-modpack-' + stamp
  fs.copyFileSync(file, target)
  return target
}

/** 把名字补进 bundles 列表；已存在就什么都不做。返回 {changed, backup, added}。 */
export function ensureBundles(profileDir, names) {
  const file = path.join(profileDir, 'package.json')
  const pkg = readProfilePackage(profileDir)
  if (!pkg) throw new Error('profile/package.json 读不到：' + file)
  if (!pkg.dsh) pkg.dsh = {}
  if (!pkg.dsh.profile) pkg.dsh.profile = {}
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = []
  const added = []
  for (const name of names) {
    if (!name || typeof name !== 'string') continue
    if (!pkg.dsh.profile.bundles.includes(name)) {
      pkg.dsh.profile.bundles.push(name)
      added.push(name)
    }
  }
  if (added.length === 0) return { changed: false, backup: '', added }
  const bak = backup(file)
  writeJsonAtomic(file, pkg)
  return { changed: true, backup: bak, added }
}

/** 把 bundles 精确恢复成给定列表（CLI 自己也会登记，装好先不启用时用它撤回）。返回是否改过。 */
export function setBundles(profileDir, names) {
  const file = path.join(profileDir, 'package.json')
  const pkg = readProfilePackage(profileDir)
  if (!pkg) throw new Error('profile/package.json 读不到：' + file)
  const want = names.filter((x) => typeof x === 'string')
  const now = readBundles(pkg)
  if (now.length === want.length && now.every((x, i) => x === want[i])) return false
  if (!pkg.dsh) pkg.dsh = {}
  if (!pkg.dsh.profile) pkg.dsh.profile = {}
  pkg.dsh.profile.bundles = want
  backup(file)
  writeJsonAtomic(file, pkg)
  return true
}

export function patchPath(profileDir) {
  return path.join(profileDir, 'cordis.patch.yml')
}

export function readPatch(profileDir) {
  try {
    return fs.readFileSync(patchPath(profileDir), 'utf8')
  } catch {
    return ''
  }
}

/** 原子写补丁文件，返回备份路径。 */
export function writePatch(profileDir, text) {
  const file = patchPath(profileDir)
  const bak = backup(file)
  const tmp = file + '.' + Date.now() + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
  return bak
}

function cliPath() {
  if (process.env.DSH_CLI) return process.env.DSH_CLI
  const root = path.dirname(process.execPath)
  return path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
}

/** 宿主自带的 CLI 入口（app.asar 里的 cli.js）；有它就不用走 .cmd，省掉 cmd 的引号与编码问题。 */
function cliEntry() {
  const roots = []
  if (process.resourcesPath) roots.push(process.resourcesPath)
  try { roots.push(path.join(path.dirname(process.execPath), 'resources')) } catch {}
  for (const root of roots) {
    if (!root) continue
    const js = path.join(root, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    try { if (fs.existsSync(js)) return js } catch {}
  }
  return ''
}

function quoteArg(arg) {
  if (/[&|<>^%!"\r\n\u0000-\u001f]/u.test(arg)) throw new Error('安装参数含不允许的字符：' + arg)
  return /\s/u.test(arg) ? '"' + arg + '"' : arg
}

/** argv 直传时只挡控制字符与双引号；中文用户名、`Program Files (x86)` 这类路径照常放行。 */
function safeArg(arg) {
  return typeof arg === 'string' && arg.length > 0 && arg.length < 4096 && !/[\u0000-\u001f"]/u.test(arg)
}

/** 允许调用方连 `plugin --profile x` 一起传（install.mjs 就是那么传的），这里统一剥成纯 pnpm 参数。 */
function normalizePluginArgs(args) {
  const list = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === 'plugin') continue
    if (arg === '--profile') { i += 1; continue }
    list.push(arg)
  }
  return list
}

/** Windows 下的 CLI 输出是 GBK，直接按 UTF-8 解会把中文变乱码；乱码率过高时换 GBK 再解。 */
function decodeOutput(buffer) {
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(buffer)
    return gbk.includes('\uFFFD') ? utf8 : gbk
  } catch { return utf8 }
}

/**
 * 调官方 CLI（内部就是 pnpm），和插件市场安装走同一条路。
 * 优先直接起 exe + cli.js：参数不经 cmd，引号与中文编码都不会被吞；找不到才退回 .cmd。
 * @returns {Promise<{code: number, output: string}>}
 */
export function runDshPlugin(profile, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(profile)) { reject(new Error('profile 名不合法')); return }
    for (const arg of args) if (!safeArg(arg)) { reject(new Error('参数含不允许的字符：' + arg)); return }
    const pluginArgs = normalizePluginArgs(args)
    const entry = cliEntry()
    const env = { ...process.env, CI: '1' }
    let child
    if (entry) {
      env.ELECTRON_RUN_AS_NODE = '1'
      child = spawn(process.execPath, ['--expose-internals', entry, 'plugin', '--profile', profile, ...pluginArgs], {
        cwd: options.cwd,
        windowsHide: true,
        env,
      })
    } else {
      const cli = cliPath()
      if (!fs.existsSync(cli)) { reject(new Error('找不到 DSH CLI：' + cli)); return }
      const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
      // cmd 回退：整串用一对引号包住，/s 只会剥掉最外层那一对，里面的 "cli" 才守得住
      const command = '""' + cli + '" plugin --profile ' + profile + ' ' + pluginArgs.map(quoteArg).join(' ') + '"'
      child = spawn(comspec, ['/d', '/s', '/c', command], {
        cwd: options.cwd,
        windowsHide: true,
        env,
        windowsVerbatimArguments: true,
      })
    }
    let buffer = Buffer.alloc(0)
    let output = ''
    const append = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 400000) buffer = buffer.subarray(buffer.length - 400000)
      output = decodeOutput(buffer)
      if (output.length > 200000) output = output.slice(-200000)
      if (options.onLine) {
        for (const line of output.split(/\r?\n/u).slice(-4)) options.onLine(line)
      }
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      reject(new Error('安装超时（' + Math.round((options.timeoutMs ?? 300000) / 1000) + ' 秒）：' + output.slice(-2000)))
    }, options.timeoutMs ?? 300000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      appendLog('cli ' + args.join(' ') + ' -> ' + code + ' :: ' + output.slice(-400).replace(/\n/gu, ' | '))
      resolve({ code: code ?? -1, output })
    })
  })
}
