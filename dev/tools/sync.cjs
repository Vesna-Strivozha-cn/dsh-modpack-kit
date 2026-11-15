/**
 * dev 工具：把源码同步进 desktop profile 的 node_modules 副本。
 * profile 里 file: 依赖是硬链接拷贝（链接数 2），直接 cp 会 EBUSY，必须先 unlink。
 * 用法：ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" dev/tools/sync.cjs
 */
const fs = require('fs')
const path = require('path')

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'))
const SRC = path.resolve(__dirname, '..', '..')
const PROFILE = process.env.DSH_PROFILE_DIR || 'C:/Users/ADMIN/.dsh/profiles/desktop'
const DEST = path.join(PROFILE, 'node_modules', pkg.name)
const SKIP = new Set(['node_modules', '.git', 'dev', 'test'])

function copyTree(s, d) {
  const st = fs.statSync(s)
  if (st.isDirectory()) {
    fs.mkdirSync(d, { recursive: true })
    for (const e of fs.readdirSync(s)) {
      if (SKIP.has(e)) continue
      copyTree(path.join(s, e), path.join(d, e))
    }
  } else {
    fs.mkdirSync(path.dirname(d), { recursive: true })
    const buf = fs.readFileSync(s)
    try { fs.unlinkSync(d) } catch {}
    fs.writeFileSync(d, buf)
  }
}

if (!fs.existsSync(DEST)) throw new Error('副本不存在，请先 dsh plugin add：' + DEST)
copyTree(SRC, DEST)
console.log('synced', SRC, '->', DEST)
