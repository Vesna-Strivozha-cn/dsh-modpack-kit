// 目录自测：拉一次市场目录，验分类、分页、已装优先与按名查询。
// 用法：ELECTRON_RUN_AS_NODE=1 "<exe>" dev/tools/check-catalog.mjs
import { loadConfig, pathsFor } from '../../lib/store.mjs'
import { catalogSummary, searchCatalog, syncCatalog, lookupPlugins, categoryMapFor } from '../../lib/market-catalog.mjs'
import { listInstalled } from '../../lib/profile.mjs'

const config = loadConfig()
let bad = 0
const check = (ok, name, extra = '') => {
  if (!ok) bad++
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : ''))
}

const started = Date.now()
const sync = await syncCatalog(config, { force: true })
check(sync.ok === true, '同步市场目录', JSON.stringify({ count: sync.count, source: sync.source, ms: sync.ms, bytes: sync.bytes }))
if (!sync.ok) { console.log(sync.error); process.exit(1) }

const summary = catalogSummary(config)
check(summary.present && summary.count > 1000, '目录摘要', 'count=' + summary.count + ' categories=' + summary.categories.length)
check(summary.categories.length >= 10, '分类不止十个', summary.categories.slice(0, 6).map((c) => c.label + c.count).join(' / '))
check(summary.categories.every((c) => c.id && c.label), '每个分类都有 id 与名字')

const installed = listInstalled(pathsFor(config).profile)
check(installed.length > 0, '本机插件可读', installed.length + ' 个包')

const page1 = searchCatalog(config, { query: '', category: 'ui', page: 1, pageSize: 20, installed })
check(page1.ok === true && page1.items.length === 20, '第一页 20 条', 'total=' + page1.total + ' pages=' + page1.pages)
const page2 = searchCatalog(config, { query: '', category: 'ui', page: 2, pageSize: 20, installed })
check(page2.ok === true && page2.items.length === 20, '第二页 20 条')
check(page2.items[0] && page1.items[0] && page2.items[0].name !== page1.items[0].name, '两页内容不重复')
check(page1.items.every((i) => i.category === 'ui'), '分类过滤生效')

const q = searchCatalog(config, { query: 'memory', page: 1, pageSize: 10, installed })
check(q.ok === true && q.total > 0, '搜索命中', 'total=' + q.total + ' 首条=' + (q.items[0] && q.items[0].name))
const qFirst = q.items.map((i) => i.name.toLowerCase().includes('memory'))
check(qFirst[0] === true, '相关度排序：名字命中的排前面', q.items[0] && q.items[0].name)

// 已装优先：找一条本机装了的、市场里也有的
const localNames = new Set(installed.map((p) => p.name))
const both = searchCatalog(config, { query: '', category: 'all', page: 1, pageSize: 100, installed })
const installedInPage = both.items.filter((i) => localNames.has(i.name))
check(installedInPage.length > 0, '已装条目出现在结果里', installedInPage.length + ' 条')
check(both.items.slice(0, installedInPage.length).every((i) => localNames.has(i.name)), '已装的排在最前面')

const look = lookupPlugins(config, installed.slice(0, 40).map((p) => p.name))
check(Object.keys(look).length > 0, '按名查市场条目', Object.keys(look).length + ' 个命中')
const map = categoryMapFor(config, installed.map((p) => p.name))
check(Object.keys(map).length > 0, '已装插件分类映射', JSON.stringify(map).slice(0, 120))

// 一条本机独有（目录里没有）也要能搜到
const localOnly = installed.find((p) => !look[p.name])
if (localOnly) {
  const r = searchCatalog(config, { query: localOnly.name, page: 1, pageSize: 20, installed })
  const hit = r.items.find((i) => i.name === localOnly.name)
  check(Boolean(hit) && hit.localOnly === true, '本机独有插件也能搜到', localOnly.name)
} else {
  console.log('skip 本机独有插件（全部都在目录里）')
}

console.log('\n耗时 ' + Math.round((Date.now() - started) / 100) / 10 + 's · ' + (bad === 0 ? '全部通过' : bad + ' 项失败'))
process.exit(bad === 0 ? 0 : 1)
