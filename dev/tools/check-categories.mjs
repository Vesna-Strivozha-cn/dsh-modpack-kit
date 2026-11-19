/**
 * 只读核对：分类分布 + 「已装插件在插件市场目录里有没有同名条目」。
 * 不写任何文件，用于验证「切换市场版」入口在真实数据下是否合理。
 * 用法：ELECTRON_RUN_AS_NODE=1 "<exe>" dev/tools/check-categories.cjs
 */
import { fetchCatalog } from '../../lib/registry.mjs'
import { classifyPlugin, CATEGORIES } from '../../lib/classify.mjs'
import { listInstalled } from '../../lib/profile.mjs'
import { loadConfig, profileDir } from '../../lib/store.mjs'

const config = loadConfig()
const [raw, installedAll] = await Promise.all([fetchCatalog(config), Promise.resolve(listInstalled(profileDir(config)))])
const items = (raw || []).filter((i) => i && i.name).map((item) => ({
  name: item.name,
  title: item.title || item.name,
  description: item.description || '',
  version: item.version || '',
  category: classifyPlugin({ name: item.name, title: item.title, description: item.description, tags: item.tags, category: item.category }).id,
}))

const counts = new Map()
for (const i of items) counts.set(i.category, (counts.get(i.category) || 0) + 1)
console.log('目录条数:', items.length)
for (const c of CATEGORIES) if (counts.get(c.id)) console.log('  ' + c.label.padEnd(8) + counts.get(c.id))

const installed = installedAll.filter((p) => p.isPlugin && p.isDirect)
const byName = new Map(items.map((i) => [i.name, i]))
console.log('\n本机已装插件:', installed.length)
for (const p of installed) {
  const m = byName.get(p.name)
  const cat = classifyPlugin({ name: p.name, description: p.description || '' })
  console.log(
    '  ' + (m ? '有市场版' : '        ') + '  ' + p.name.padEnd(34) +
    (p.version || '').padEnd(10) + ' ' + cat.label + (m ? '  市场 v' + m.version + ' [' + m.category + ']' : ''),
  )
}
