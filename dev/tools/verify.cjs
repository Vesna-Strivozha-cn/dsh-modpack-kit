/**
 * dev 工具：校验「源码 == profile 里的副本」，并确认副本能被加载、路由齐、清单对。
 * 用法：ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" dev/tools/verify.cjs
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SRC = path.resolve(__dirname, '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'))
const PROFILE = process.env.DSH_PROFILE_DIR || 'C:/Users/ADMIN/.dsh/profiles/desktop'
const DEST = path.join(PROFILE, 'node_modules', pkg.name)
const SKIP = new Set(['node_modules', '.git', 'dev', 'test', '.gitignore', '.npmignore'])

let same = 0
const diff = []
function walk(s, d, rel) {
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const sp = path.join(s, e.name)
    const dp = path.join(d, e.name)
    const r = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) walk(sp, dp, r)
    else {
      if (!fs.existsSync(dp)) { diff.push('缺失 ' + r); continue }
      const a = crypto.createHash('sha256').update(fs.readFileSync(sp)).digest('hex')
      const b = crypto.createHash('sha256').update(fs.readFileSync(dp)).digest('hex')
      if (a === b) same++
      else diff.push('不一致 ' + r)
    }
  }
}
walk(SRC, DEST, '')

const host = require(DEST + '/index.js')
const routes = []
const fakeCtx = {
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  get: () => undefined,
  effect: (fn) => { const d = fn(); return () => { try { d && d() } catch {} } },
}
test().catch((e) => { console.error('load failed:', e); process.exitCode = 1 })

async function test() {
  const mod = host.default || host
  mod.apply(fakeCtx)
  console.log(`files: ${same + diff.length} 个运行文件，${same} 一致`)
  if (diff.length) { console.log(diff.join('\n')); process.exitCode = 1 }
  console.log(`plugin: ${mod.name} | routes: ${routes.length}`)
  const statusRoute = routes.find((r) => r.path.endsWith('/status'))
  if (statusRoute) {
    const out = await new Promise((resolve) => {
      const res = { headers: {}, writeHead(c, h) { this.code = c; Object.assign(this.headers, h) }, end(body) { resolve({ code: this.code, data: JSON.parse(body) }) } }
      statusRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:' + 51882 } }, res)
    })
    console.log(`status: 已装插件 ${out.data.installed.length}/${out.data.installedTotal} | 市场 ${JSON.stringify(out.data.market)} | profile ${out.data.profile}`)
  }
  const p = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'))
  console.log('dependency:', p.dependencies[pkg.name])
  console.log('in bundles:', (p.dsh && p.dsh.profile && p.dsh.profile.bundles || []).includes(pkg.name))
}
