# 代码地图（CODE-MAP）

> 给改代码的人：**先在这里定位，再用函数名 grep**。行号会随改动漂移，只信符号名；行号列仅供大致范围参考。
>
> 生成方式：`node dev/tools/map.mjs`（本仓库用 `ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" dev/tools/map.mjs`）。加了大段代码后重跑一次即可刷新符号表。

## 0. 结构一句话

```
index.js            Host 侧：30 条路由 + 打包/安装/社区资源编排 + 任务队列
client.js           客户端：打包 / 安装·导入 / 社区资源 / 设置与记录 + 悬浮进度窗
lib/*.mjs           纯逻辑（无 Cordis 依赖，可单独 node 跑）
assets/install-stub.mjs  打进包里的独立安装器（裸 DSH 用）
test/*.mjs          单元 / 宿主集成 / 联网 / 假 React 渲染
dev/tools/*.mjs     一次性验证工具（基准、矩阵、沙箱、同步、校验、代码地图）
docs/DETAIL.md      插件详情页正文（locale 的 meta.detail 指向它）
```

## 1. 功能 → 去哪找

| 想改什么 | 先看 | 关键符号 | 常用 grep |
| --- | --- | --- | --- |
| 打包流程 / 三种策略 | `lib/pack.mjs` | `buildPack`、`strategy`、`embedded`、`tick` | `grep -n "function buildPack" lib/pack.mjs` |
| 包格式 / 清单字段 | `lib/manifest.mjs` | `buildManifest`、`normalizeManifest`、`normalizePlugin`、`buildReadme` | `grep -n "normalizePlugin" lib/manifest.mjs` |
| 安装（市场版优先 / 回退） | `lib/install.mjs` | `installPack`、`installSpec`、`preferMarketSpec`、`applyMarketGroups` | `grep -n "preferMarketSpec" lib/install.mjs` |
| 独立安装器（裸 DSH） | `assets/install-stub.mjs` | `resolveCli`、`vendorRoot`、`restoreConfigs`、`restoreGroups` | `grep -n "function vendorRoot" assets/install-stub.mjs` |
| 安全检测 / 风险分组 | `lib/scan.mjs` | `scanEntries`、`groupFindings`、`SECRET_PATTERNS` | `grep -n "function groupFindings" lib/scan.mjs` |
| 兼容性建议 | `lib/compat.mjs` | `checkCompatibility`、`canCarry` | `grep -n "canCarry" lib/compat.mjs` |
| 插件市场目录（分类/搜索） | `lib/market-catalog.mjs` | `syncCatalog`、`searchCatalog`、`catalogSummary` | `grep -n "function searchCatalog" lib/market-catalog.mjs` |
| 社区资源目录（自建仓库） | `lib/modpack-catalog.mjs` | `syncMarket`、`searchMarket`、`fetchMarketPack` | `grep -n "function searchMarket" lib/modpack-catalog.mjs` |
| 社区资源界面 | `client.js` | `MarketPanel`、`renderRow`、`requestInstall` | `grep -n "function MarketPanel" client.js` |
| 打包界面 / 策略卡片 | `client.js` | `PackPanel`、`computePlan` 的前端消费、`STRATEGY_INFO` | `grep -n "function PackPanel" client.js` |
| 安装界面 / 预览 | `client.js` | `InstallPanel`、`subscribeInstallRequest` | `grep -n "function InstallPanel" client.js` |
| 设置与记录 | `client.js` + `lib/store.mjs` | `SettingsPanel`、`DEFAULT_CONFIG`、`clampConfig`、`clearHistory` | `grep -n "function SettingsPanel" client.js` |
| 进度窗 / 任务队列 | `client.js` + `index.js` | `JobDock`、`clampDockPos`、`useJobs`；`createJob`、`pruneJobs`、`performPack` | `grep -n "function JobDock" client.js` |
| 打包策略可用性判定 | `index.js` | `computePlan`、`versionOf` | `grep -n "function computePlan" index.js` |
| 分组读写 / 重名避让 | `lib/groups.mjs` | `readMarketGroups`、`groupViews`、`applyMarketGroups` | `grep -n "applyMarketGroups" lib/groups.mjs` |
| 网络与主机白名单 | `lib/net.mjs` | `requestJson`、`requestBuffer`、`curlOnce` | `grep -n "function requestJson" lib/net.mjs` |
| 设置项默认值 | `lib/store.mjs` | `DEFAULT_CONFIG`、`clampConfig`、`loadConfig` | `grep -n "DEFAULT_CONFIG" lib/store.mjs` |

## 2. 路由表（`index.js`，共 30 条）

| 路由 | 行 |
| --- | --- |
| `status` | 299 |
| `settings` | 305 |
| `catalog` | 326 |
| `catalog/status` | 336 |
| `catalog/lookup` | 348 |
| `catalog/sync` | 359 |
| `catalog/search` | 370 |
| `market` | 405 |
| `market/search` | 423 |
| `market/sync` | 447 |
| `market/download` | 463 |
| `versions` | 512 |
| `pack/plan` | 814 |
| `pack` | 824 |
| `jobs/ack` | 848 |
| `jobs/dismiss` | 883 |
| `jobs/clear` | 896 |
| `jobs/cancel` | 915 |
| `jobs` | 938 |
| `download` | 945 |
| `save` | 960 |
| `packs` | 999 |
| `pack/drop` | 1015 |
| `inspect` | 1080 |
| `install` | 1265 |
| `install/replace` | 1278 |
| `history` | 1304 |
| `history/clear` | 1310 |
| `history/remove` | 1316 |
| `plugin-summary` | 1324 |

> 全部挂在 `/dsh-modpack-kit/api/` 下；路由体统一 `if (!needPost(req, res)) return` + `await readJsonBody(req)`，不要再写 `fenced()`。

## 3. 文件职责与符号

### `index.js`（1396 行）

Host 侧：所有 HTTP 路由、打包/安装/市场编排、任务队列与进度

### `client.js`（2837 行）

客户端：打包 / 安装·导入 / 社区资源 / 设置与记录 四块界面 + 悬浮进度窗

### `assets/install-stub.mjs`（438 行）

打进包里 install/install.mjs 的独立安装器（裸 DSH 也能装）

- `resolveCli` L87
- `vendorRoot` L134
- `copyTree` L146
- `readDependencies` L162
- `restoreConfigs` L252
- `stripBundles` L291
- `restoreGroups` L335
- `restoreData` L399

### `lib/classify.mjs`（106 行）

把插件名/描述映射到插件市场的 23 个分类（纯字符串匹配）

- `CATEGORIES` L12（导出常量）
- `hit` L51
- `classifyPlugin` L67（导出）
- `categoryLabel` L103（导出）

### `lib/compat.mjs`（114 行）

兼容性判定：peer 依赖、engines、license、版本差异；按打包策略给不同建议

- `versionOf` L12
- `checkCompatibility` L21（导出）

### `lib/groups.mjs`（148 行）

读插件市场的分组（.dsh-market/state.json），装完后并入/重名避让

- `marketStatePath` L16（导出）
- `stringList` L20
- `readMarketGroups` L34（导出）
- `groupViews` L62（导出）
- `hasMarket` L77（导出）
- `applyMarketGroups` L94（导出）

### `lib/http.mjs`（42 行）

读请求体、发 JSON 响应、needPost 等方法判定

- `MAX_JSON_BODY` L7（导出常量）
- `MAX_DROP_BODY` L9（导出常量）
- `sendJson` L11（导出）
- `readBody` L32（导出常量）
- `readRawBody` L34（导出常量）
- `readJsonBody` L37（导出常量）
- `asJson` L39（导出）

### `lib/install.mjs`（701 行）

读包 → 扫描 → 按策略装（市场版优先 / 包内副本回退）→ 回填配置与分组

- `inspectPackBuffer` L53（导出）
- `readPackFromUrl` L126（导出）
- `pluginPayload` L134
- `materializePayload` L143（导出）
- `packDirOf` L166
- `installPack` L179（导出）

### `lib/manifest.mjs`（226 行）

dsh-modpack.json 的构造、归一化、校验与包内 README 生成

- `SCHEMA` L9（导出常量）
- `KIND` L10（导出常量）
- `MANIFEST_NAME` L11（导出常量）
- `sha256` L13（导出常量）
- `shortHash` L14（导出常量）
- `normalizePlugin` L20
- `normalizeManifest` L85（导出）
- `buildReadme` L148（导出）

### `lib/market-catalog.mjs`（418 行）

插件市场目录（分类 + 分页搜索 + 已装优先），数据源是 npm 包 dsh-plugin-catalog

- `CATEGORY_FALLBACK` L23（导出常量）
- `CATALOG_SOURCES` L50（导出常量）
- `PAGE_SIZE_DEFAULT` L55（导出常量）
- `catalogPaths` L60（导出）
- `categoriesOf` L68（导出）
- `normalizePlugin` L86
- `buildIndex` L122（导出）
- `readIndex` L142（导出）
- `writeIndex` L166（导出）
- `catalogSummary` L174（导出）
- `fetchSource` L203
- `syncCatalog` L218（导出）
- `relevance` L247
- `searchCatalog` L282（导出）
- `categoryMapFor` L386（导出）
- `lookupPlugins` L398（导出）

### `lib/modpack-catalog.mjs`（356 行）

社区资源目录（自建仓库 packs.json）：同步、缓存、检索、取包

- `MARKET_REPO` L31（导出常量）
- `MARKET_BRANCH` L32（导出常量）
- `MARKET_SOURCES` L34（导出常量）
- `CATEGORY_FALLBACK` L43（导出常量）
- `TIER_BANDS` L56（导出常量）
- `tierOf` L63（导出）
- `marketPaths` L69（导出）
- `readCache` L77
- `writeCache` L101
- `normalizeCatalog` L115
- `sourceBaseOf` L171
- `packFileUrl` L176（导出）
- `marketSummary` L181（导出）
- `syncMarket` L215（导出）
- `installedState` L251
- `relevance` L259
- `searchMarket` L283（导出）
- `fetchMarketPack` L336（导出）
- `findMarketPack` L349（导出）

### `lib/net.mjs`（168 行）

网络层：https 白名单、逐跳校验、体积上限、重试、curl 兜底

- `NET_DEFAULTS` L12（导出常量）
- `assertAllowedUrl` L23（导出）
- `netOptions` L39
- `parseCurlResponse` L49（导出）
- `curlOnce` L64
- `fetchOnce` L84
- `requestBuffer` L117（导出）
- `requestJson` L160（导出）

### `lib/pack.mjs`（665 行）

打包：收集插件 → 抓配置/数据 → 扫描 → 写清单与安装器 → 压 zip

- `collectFiles` L39（导出）
- `readInstalledPlugin` L81（导出）
- `REDACTED` L114（导出常量）
- `normalizeConfigKey` L116（导出）
- `redactConfig` L123（导出）
- `captureConfigs` L149（导出）
- `dataDirsFor` L195
- `scrubText` L223
- `captureData` L234（导出）
- `licenseId` L282
- `authorOf` L289
- `buildPack` L302（导出）

### `lib/profile.mjs`（332 行）

读写 profile：已装列表、bundles、cordis.patch.yml、调官方 CLI

- `readJson` L15（导出）
- `readProfilePackage` L23（导出）
- `listInstalled` L27（导出）
- `dshVersion` L139（导出）
- `readBundles` L147（导出）
- `backup` L152
- `ensureBundles` L161（导出）
- `setBundles` L183（导出）
- `patchPath` L198（导出）
- `readPatch` L202（导出）
- `writePatch` L211（导出）
- `cliPath` L220
- `cliEntry` L227
- `quoteArg` L239
- `safeArg` L245
- `normalizePluginArgs` L250
- `decodeOutput` L262
- `runDshPlugin` L276（导出）

### `lib/registry.mjs`（242 行）

从 npm 取版本清单与 tarball（三层退让 + curl 兜底）

- `fetchLimited` L17（导出常量）
- `fetchJson` L18（导出常量）
- `validatePackageName` L20（导出）
- `metadataLimit` L36（导出）
- `probeRegistry` L54（导出）
- `npmMetadata` L71（导出）
- `pickVersion` L125（导出）
- `relativeTime` L142（导出）
- `downloadPackage` L153（导出）
- `fetchCatalog` L196（导出）
- `npmSearchCatalog` L211（导出）

### `lib/scan.mjs`（347 行）

安全检测：敏感信息 + 恶意代码痕迹；按来源分组；同内容去重

- `scanFileName` L66（导出）
- `maskSecret` L75
- `maskAll` L81
- `findingOf` L86
- `looksBinary` L98（导出）
- `extOf` L104
- `lineAt` L110
- `scanFile` L122（导出）
- `groupFindings` L193（导出）
- `severityRank` L235（导出）
- `scanEntries` L244（导出）
- `renderScanReport` L311（导出）

### `lib/semver.mjs`（138 行）

极小 semver 实现（判断兼容性用）

- `parseVersion` L11（导出）
- `compareVersions` L18（导出）
- `bound` L33
- `parseComparatorSet` L38
- `testBounds` L103
- `satisfies` L119（导出）

### `lib/store.mjs`（243 行）

本地状态：settings.json / history.json / 目录路径 / 默认配置与 clamp

- `dshHome` L13（导出）
- `pluginHome` L17（导出）
- `profileName` L21（导出）
- `profileDir` L27（导出）
- `HOSTS_VERSION` L31（导出常量）
- `NET_VERSION` L33（导出常量）
- `DEFAULT_CONFIG` L35（导出常量）
- `pathsFor` L96（导出）
- `clampConfig` L109（导出）
- `loadConfig` L152（导出）
- `writeJsonAtomic` L175（导出）
- `saveConfig` L182（导出）
- `readHistory` L188（导出）
- `appendHistory` L197（导出）
- `clearHistory` L205（导出）
- `removeHistory` L211（导出）
- `appendLog` L218（导出）
- `slugify` L228（导出）
- `ensureDir` L239（导出）

### `lib/tar.mjs`（108 行）

读 .tgz（npm 包）

- `readString` L14
- `readOctal` L20
- `parsePax` L27
- `readTarball` L48（导出）
- `stripPackagePrefix` L98（导出）
- `tarLimits` L107（导出常量）

### `lib/yamlish.mjs`（408 行）

YAML 子集：只服务 cordis.patch.yml 的读写

- `stripComment` L15
- `parseDoubleQuoted` L29
- `parseSingleQuoted` L55
- `parseFlow` L60
- `parseScalar` L133
- `parseYaml` L263（导出）
- `emitScalar` L277（导出）
- `emitYaml` L288（导出）
- `splitTopLevelItems` L334（导出）
- `upsertPatchItem` L368（导出）
- `findPatchItem` L397（导出）

### `lib/zip.mjs`（255 行）

最小 ZIP 读写（node:zlib，无依赖）

- `dosTime` L28
- `dosToDate` L37
- `safeEntryName` L48（导出）
- `alreadyCompressed` L74（导出）
- `writeZip` L87（导出）
- `findEocd` L164
- `readZip` L182（导出）
- `readZipText` L249（导出）
- `zipLimits` L254（导出常量）

## 4. 常见改动的连锁清单

- **加一个设置项**：`lib/store.mjs` 的 `DEFAULT_CONFIG` + `clampConfig` → `client.js` 的 `SettingsPanel`（控件 + `patch({...})`）→ README「能做什么 / 与插件市场」→ `docs/DETAIL.md` → `test/run.mjs` 断言默认值。
- **加一条路由**：`index.js` 里 `route("/dsh-modpack-kit/api/…")` → 客户端 `api("/…")` → `dev/tools/verify.cjs` 的路由数 → `test/host-smoke.mjs` 补一条 HTTP 用例。旧宿主没有该路由时会回 404/405，`client.js` 的 `api()` 会提示「重启 DSH」。
- **加一个社区资源字段**：`_market/modpack-catalog/scripts/build.mjs`（校验 + 输出）→ `lib/modpack-catalog.mjs` 的 `normalizeCatalog` → `client.js` 的 `renderRow` / 详情块 → `_market/modpack-catalog/README.md` 的条目格式表。
- **加一种打包策略或改策略判定**：`lib/pack.mjs`（`strategy` / `embedded`）→ `lib/manifest.mjs`（`format` 归一化）→ `index.js` 的 `computePlan` 与 `/pack/plan` → `client.js` 的 `STRATEGY_INFO` 与卡片 → `lib/install.mjs`（按 `embedded` 决定走市场版还是包内副本）→ 测试。
- **改界面文案**：`client.js` 里的中文字面量；`locale/zh.json`、`locale/en.json` 的 `meta.title/description`；`README.md`；`docs/DETAIL.md`；注意测试里有硬断言（例如旧名「整合包市场」不许出现）。
- **改完固定收尾**：`test/run.mjs`、`DSH_MODPACK_OFFLINE=1 test/host-smoke.mjs`、`dev/tools/sync.cjs`、`dev/tools/verify.cjs`、`dev/tools/map.mjs`（刷新本文件）。

## 5. 检索示例

```bash
# 找某个函数在哪
grep -n "function MarketPanel" client.js
# 找某个路由
grep -n "/api/market" index.js
# 找某个设置键
grep -rn "showModpackMarket" --include=*.mjs --include=*.js .
# 找某段文案出现在哪些地方（改文案前必做）
grep -rn "进度在悬浮窗" --include=*.js --include=*.mjs --include=*.md .
```
