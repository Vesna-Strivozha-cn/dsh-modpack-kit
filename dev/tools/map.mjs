import fs from 'node:fs'

const root = 'D:/桌面/danika/dsh-dev/整合包'
const libFiles = fs.readdirSync(root + '/lib').filter((f) => f.endsWith('.mjs')).sort()
const files = ['index.js', 'client.js', 'assets/install-stub.mjs', ...libFiles.map((f) => 'lib/' + f)]

const PURPOSE = {
  'index.js': 'Host 侧：所有 HTTP 路由、打包/安装/市场编排、任务队列与进度',
  'client.js': '客户端：打包 / 安装·导入 / 社区资源 / 设置与记录 四块界面 + 悬浮进度窗',
  'assets/install-stub.mjs': '打进包里 install/install.mjs 的独立安装器（裸 DSH 也能装）',
  'lib/classify.mjs': '把插件名/描述映射到插件市场的 23 个分类（纯字符串匹配）',
  'lib/compat.mjs': '兼容性判定：peer 依赖、engines、license、版本差异；按打包策略给不同建议',
  'lib/groups.mjs': '读插件市场的分组（.dsh-market/state.json），装完后并入/重名避让',
  'lib/http.mjs': '读请求体、发 JSON 响应、needPost 等方法判定',
  'lib/install.mjs': '读包 → 扫描 → 按策略装（市场版优先 / 包内副本回退）→ 回填配置与分组',
  'lib/manifest.mjs': 'dsh-modpack.json 的构造、归一化、校验与包内 README 生成',
  'lib/market-catalog.mjs': '插件市场目录（分类 + 分页搜索 + 已装优先），数据源是 npm 包 dsh-plugin-catalog',
  'lib/modpack-catalog.mjs': '社区资源目录（自建仓库 packs.json）：同步、缓存、检索、取包',
  'lib/net.mjs': '网络层：https 白名单、逐跳校验、体积上限、重试、curl 兜底',
  'lib/pack.mjs': '打包：收集插件 → 抓配置/数据 → 扫描 → 写清单与安装器 → 压 zip',
  'lib/profile.mjs': '读写 profile：已装列表、bundles、cordis.patch.yml、调官方 CLI',
  'lib/registry.mjs': '从 npm 取版本清单与 tarball（三层退让 + curl 兜底）',
  'lib/scan.mjs': '安全检测：敏感信息 + 恶意代码痕迹；按来源分组；同内容去重',
  'lib/semver.mjs': '极小 semver 实现（判断兼容性用）',
  'lib/store.mjs': '本地状态：settings.json / history.json / 目录路径 / 默认配置与 clamp',
  'lib/tar.mjs': '读 .tgz（npm 包）',
  'lib/yamlish.mjs': 'YAML 子集：只服务 cordis.patch.yml 的读写',
  'lib/zip.mjs': '最小 ZIP 读写（node:zlib，无依赖）',
}

const collect = (rel) => {
  const src = fs.readFileSync(root + '/' + rel, 'utf8')
  const lines = src.split('\n')
  const rows = []
  lines.forEach((line, i) => {
    let m
    if ((m = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line))) rows.push(`\`${m[1]}\` L${i + 1}（导出）`)
    else if ((m = /^export\s+const\s+([A-Za-z0-9_$]+)/.exec(line))) rows.push(`\`${m[1]}\` L${i + 1}（导出常量）`)
    else if ((m = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line))) rows.push(`\`${m[1]}\` L${i + 1}`)
  })
  return { lines: lines.length, rows }
}

const routes = []
fs.readFileSync(root + '/index.js', 'utf8').split('\n').forEach((line, i) => {
  const m = /^\s{2,4}route\('([^']+)',\s*(?:async\s*)?\(req,\s*res\)/.exec(line)
  if (m) routes.push({ path: m[1], line: i + 1 })
})

const md = []
md.push('# 代码地图（CODE-MAP）')
md.push('')
md.push('> 给改代码的人：**先在这里定位，再用函数名 grep**。行号会随改动漂移，只信符号名；行号列仅供大致范围参考。')
md.push('>')
md.push('> 生成方式：`node dev/tools/map.mjs`（本仓库用 `ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" dev/tools/map.mjs`）。加了大段代码后重跑一次即可刷新符号表。')
md.push('')
md.push('## 0. 结构一句话')
md.push('')
md.push('```')
md.push('index.js            Host 侧：30 条路由 + 打包/安装/社区资源编排 + 任务队列')
md.push('client.js           客户端：打包 / 安装·导入 / 社区资源 / 设置与记录 + 悬浮进度窗')
md.push('lib/*.mjs           纯逻辑（无 Cordis 依赖，可单独 node 跑）')
md.push('assets/install-stub.mjs  打进包里的独立安装器（裸 DSH 用）')
md.push('test/*.mjs          单元 / 宿主集成 / 联网 / 假 React 渲染')
md.push('dev/tools/*.mjs     一次性验证工具（基准、矩阵、沙箱、同步、校验、代码地图）')
md.push('docs/DETAIL.md      插件详情页正文（locale 的 meta.detail 指向它）')
md.push('```')
md.push('')
md.push('## 1. 功能 → 去哪找')
md.push('')
md.push('| 想改什么 | 先看 | 关键符号 | 常用 grep |')
md.push('| --- | --- | --- | --- |')
md.push('| 打包流程 / 三种策略 | `lib/pack.mjs` | `buildPack`、`strategy`、`embedded`、`tick` | `grep -n "function buildPack" lib/pack.mjs` |')
md.push('| 包格式 / 清单字段 | `lib/manifest.mjs` | `buildManifest`、`normalizeManifest`、`normalizePlugin`、`buildReadme` | `grep -n "normalizePlugin" lib/manifest.mjs` |')
md.push('| 安装（市场版优先 / 回退） | `lib/install.mjs` | `installPack`、`installSpec`、`preferMarketSpec`、`applyMarketGroups` | `grep -n "preferMarketSpec" lib/install.mjs` |')
md.push('| 独立安装器（裸 DSH） | `assets/install-stub.mjs` | `resolveCli`、`vendorRoot`、`restoreConfigs`、`restoreGroups` | `grep -n "function vendorRoot" assets/install-stub.mjs` |')
md.push('| 安全检测 / 风险分组 | `lib/scan.mjs` | `scanEntries`、`groupFindings`、`SECRET_PATTERNS` | `grep -n "function groupFindings" lib/scan.mjs` |')
md.push('| 兼容性建议 | `lib/compat.mjs` | `checkCompatibility`、`canCarry` | `grep -n "canCarry" lib/compat.mjs` |')
md.push('| 插件市场目录（分类/搜索） | `lib/market-catalog.mjs` | `syncCatalog`、`searchCatalog`、`catalogSummary` | `grep -n "function searchCatalog" lib/market-catalog.mjs` |')
md.push('| 社区资源目录（自建仓库） | `lib/modpack-catalog.mjs` | `syncMarket`、`searchMarket`、`fetchMarketPack` | `grep -n "function searchMarket" lib/modpack-catalog.mjs` |')
md.push('| 社区资源界面 | `client.js` | `MarketPanel`、`renderRow`、`requestInstall` | `grep -n "function MarketPanel" client.js` |')
md.push('| 打包界面 / 策略卡片 | `client.js` | `PackPanel`、`computePlan` 的前端消费、`STRATEGY_INFO` | `grep -n "function PackPanel" client.js` |')
md.push('| 安装界面 / 预览 | `client.js` | `InstallPanel`、`subscribeInstallRequest` | `grep -n "function InstallPanel" client.js` |')
md.push('| 设置与记录 | `client.js` + `lib/store.mjs` | `SettingsPanel`、`DEFAULT_CONFIG`、`clampConfig`、`clearHistory` | `grep -n "function SettingsPanel" client.js` |')
md.push('| 进度窗 / 任务队列 | `client.js` + `index.js` | `JobDock`、`clampDockPos`、`useJobs`；`createJob`、`pruneJobs`、`performPack` | `grep -n "function JobDock" client.js` |')
md.push('| 打包策略可用性判定 | `index.js` | `computePlan`、`versionOf` | `grep -n "function computePlan" index.js` |')
md.push('| 分组读写 / 重名避让 | `lib/groups.mjs` | `readMarketGroups`、`groupViews`、`applyMarketGroups` | `grep -n "applyMarketGroups" lib/groups.mjs` |')
md.push('| 网络与主机白名单 | `lib/net.mjs` | `requestJson`、`requestBuffer`、`curlOnce` | `grep -n "function requestJson" lib/net.mjs` |')
md.push('| 设置项默认值 | `lib/store.mjs` | `DEFAULT_CONFIG`、`clampConfig`、`loadConfig` | `grep -n "DEFAULT_CONFIG" lib/store.mjs` |')
md.push('')
md.push('## 2. 路由表（`index.js`，共 ' + routes.length + ' 条）')
md.push('')
md.push('| 路由 | 行 |')
md.push('| --- | --- |')
for (const r of routes) md.push(`| \`${r.path.replace('/dsh-modpack-kit/api/', '')}\` | ${r.line} |`)
md.push('')
md.push('> 全部挂在 `/dsh-modpack-kit/api/` 下；路由体统一 `if (!needPost(req, res)) return` + `await readJsonBody(req)`，不要再写 `fenced()`。')
md.push('')
md.push('## 3. 文件职责与符号')
md.push('')
for (const rel of files) {
  const { lines, rows } = collect(rel)
  md.push(`### \`${rel}\`（${lines} 行）`)
  md.push('')
  md.push(PURPOSE[rel] || '')
  md.push('')
  if (rows.length) {
    md.push(rows.map((r) => '- ' + r).join('\n'))
    md.push('')
  }
}
md.push('## 4. 常见改动的连锁清单')
md.push('')
md.push('- **加一个设置项**：`lib/store.mjs` 的 `DEFAULT_CONFIG` + `clampConfig` → `client.js` 的 `SettingsPanel`（控件 + `patch({...})`）→ README「能做什么 / 与插件市场」→ `docs/DETAIL.md` → `test/run.mjs` 断言默认值。')
md.push('- **加一条路由**：`index.js` 里 `route("/dsh-modpack-kit/api/…")` → 客户端 `api("/…")` → `dev/tools/verify.cjs` 的路由数 → `test/host-smoke.mjs` 补一条 HTTP 用例。旧宿主没有该路由时会回 404/405，`client.js` 的 `api()` 会提示「重启 DSH」。')
md.push('- **加一个社区资源字段**：`_market/modpack-catalog/scripts/build.mjs`（校验 + 输出）→ `lib/modpack-catalog.mjs` 的 `normalizeCatalog` → `client.js` 的 `renderRow` / 详情块 → `_market/modpack-catalog/README.md` 的条目格式表。')
md.push('- **加一种打包策略或改策略判定**：`lib/pack.mjs`（`strategy` / `embedded`）→ `lib/manifest.mjs`（`format` 归一化）→ `index.js` 的 `computePlan` 与 `/pack/plan` → `client.js` 的 `STRATEGY_INFO` 与卡片 → `lib/install.mjs`（按 `embedded` 决定走市场版还是包内副本）→ 测试。')
md.push('- **改界面文案**：`client.js` 里的中文字面量；`locale/zh.json`、`locale/en.json` 的 `meta.title/description`；`README.md`；`docs/DETAIL.md`；注意测试里有硬断言（例如旧名「整合包市场」不许出现）。')
md.push('- **改完固定收尾**：`test/run.mjs`、`DSH_MODPACK_OFFLINE=1 test/host-smoke.mjs`、`dev/tools/sync.cjs`、`dev/tools/verify.cjs`、`dev/tools/map.mjs`（刷新本文件）。')
md.push('')
md.push('## 5. 检索示例')
md.push('')
md.push('```bash')
md.push('# 找某个函数在哪')
md.push('grep -n "function MarketPanel" client.js')
md.push('# 找某个路由')
md.push('grep -n "/api/market" index.js')
md.push('# 找某个设置键')
md.push('grep -rn "showModpackMarket" --include=*.mjs --include=*.js .')
md.push('# 找某段文案出现在哪些地方（改文案前必做）')
md.push('grep -rn "进度在悬浮窗" --include=*.js --include=*.mjs --include=*.md .')
md.push('```')
md.push('')

fs.writeFileSync(root + '/docs/CODE-MAP.md', md.join('\n'), 'utf8')
console.log('wrote docs/CODE-MAP.md, routes=' + routes.length + ', files=' + files.length)
