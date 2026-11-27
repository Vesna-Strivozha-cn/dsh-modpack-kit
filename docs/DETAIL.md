# 整合包（dsh-modpack-kit）

> 谁说dsh不能整整合包呢？（你说这几个插件整一块不牛逼坏了）
>
> npm：https://www.npmjs.com/package/dsh-modpack-kit

类似 HMCL / PCL 的 DSH 整合包工具：把多个 DSH 插件连同各自的配置与数据打成一个 `.dshpack`，一次装好；纯净版 DSH 也能装。

## 能做什么

* **三种打包策略**：懒人包（带本体，离线可装）、轻量包（只记安装码，体积最小）、混合（按插件配置类型选择打包策略）。
* **逐插件定制**：「插件预设」或「自定义配置」，按条目回填、默认不覆盖本机文件，疑似凭据替换为 `${REDACTED}`。
* **强制检测**：打包前扫描风险与敏感信息（只留掩码），高风险停下等确认；安装前校验 sha256、兼容性与许可证。
* **和市场同源**：分类、搜索、分页、分组、版本与插件市场目录同步；没装市场也能打包与安装。
* **备份与取包**：平时可以把整合包当作插件组合的备份——迁移、备份或分享配置；取包支持文件/文件夹选择器、任意目录、已导入列表与链接，支持市场新版 AI 搜索。

想整社区资源奈何技术力不足，不定时更新咕咕咕。

## 安装码

```bash
dsh plugin --profile desktop add dsh-modpack-kit
```

不经过 npm，也可以直接从 GitHub 装：

```bash
dsh plugin --profile desktop add github:Vesna-Strivozha-cn/dsh-modpack-kit
```

重启 DSH 后左侧栏出现「整合包」；设置页与插件页里也能打开（三处各一个开关，至少留一处）。

## 打包策略

|策略|包里有什么|要联网|适合|
|-|-|-|-|
|懒人包 `full`|清单 + 插件本体 + 配置 + 数据 + 检测报告|可以不用|换机器、离线装、没装本插件的机器|
|轻量包 `lite`|清单 + 版本号|要|分享给别人、自己已有插件|
|混合 `hybrid`|能按版本装的只记版本，其余连本体|部分|体积和可装性兼顾|

打包界面就是三张卡片，按所选插件实时判定：不可选的灰显，点一下说明原因。版本号不打时候不鉴别：轻量包与混合包里「只记版本」的插件，直接记你本机（或市场目录里）那一版，打包过程不联网、不向 registry 校验；「市场版」这个身份要等安装时联网取包才确认。只有完整包（离线包）会真的下载并核对代码。

轻量包与混合包里「只记版本」的插件不写死版本号（`latest: true`）：安装时按名字从市场取最新一版，所以打包页看到的「市场最新」和装出来的是一版；只有完整包（和混合包里嵌了本体的那几个）才记具体版本。

## 功能简述

1. **选插件**：按市场分组折叠展示，组头「一键加入 / 清空本组」；未安装但市场里有的也能选。
2. **逐插件定**：来源（市场版 / 本机版）、「插件预设 / 自定义配置」。
3. **打包**：左下进度窗显示阶段与百分比，可并发打多个，也可中途终止（不留半成品）。
4. **拿到包**：完成后点「下载安装包」，或把生成的文件/链接发给别人。

## 整合包安装

* **裸 DSH**：解压后跑包内安装器，三种策略都适用。

  ```bash
  ./install.sh                                   # macOS / Linux
  node install/install.mjs --profile desktop      # Windows / 任意平台
  ```

  可选 `--dry-run`（只演练）、`--offline`（不联网）、`--no-bundles`（装好先不启用）、`--replace`（覆盖已装）。
* **在插件里导入**：可逐插件勾选，缺依赖 / 引擎不符的置顶显示，每个带配置的插件可选「包内配置 / 保持本机」，装后整体启用，装后同步市场分组。
* 已装的默认跳过，可选换成包内版本。

## 社区资源

界面不带语言切换，只提供中文。

- 体量词条：按插件总数自动判定（0-3 轻量 / 4-8 中型 / 9-12 大型 / 13+ 大宗），目录条目里存成 `tier`，客户端只用不猜。
- 水槽：构建时把包里每个插件映射到插件市场分类，跨 ≥3 类就强制 `category = 水槽`，避免「什么都有」的包被塞进单一场景。
- 条目字段：id / name / author / category / version / strategy（只收 lite）/ file / sha256 / size / createdAt / updatedAt / description{zh,en} / plugins[{name,version,description}] / downloads。
- downloads 指这个 .dshpack 安装文件本身被下载的次数；目录只存元数据、不搬文件。Git 仓库里的文件没有逐文件计数，作者不写这个字段时客户端显示「下载量未统计」，绝不用包里插件的 npm 下载量顶替；托管到 GitHub Release 并写 download_count 就会原样显示。
- 上传要求中英双语：description.zh 与 description.en 都必填，构建脚本会挡。
- 插件数只算清单里的顶层插件；壁纸引擎那类由插件自己带的组件不计入。
- 检索：目录 JSON 按文件的 mtime+size 做内存缓存，每条预算一份小写 searchText；命中查询时先做包含过滤再打分，服务端对同一组条件再缓存 20 秒。
- 分组写入：.dsh-market/state.json 里新增 groupOrigins（组名 → 创建它的包）；同名组属于别的包时依次试「名字 2」「名字 3」，安装日志会写明避让结果。

目录仓库 `Vesna-Strivozha-cn/dsh-modpack-catalog`（GitHub Actions `17 3 * * *` 一天一轮询）。

* 数据：`packs.json`（`schema: 1`、`builtAt`、`count`、`categories[{id,label,count}]`、`packs[]`）。jsDelivr `gh/<repo>@main/packs.json` 与 raw.githubusercontent 两个源都取一遍，按 `builtAt` 用更新的那份（jsDelivr 对 gh 的缓存可能落后一整天）；本地缓存在 `<home>/dsh-modpack/modpack-market/packs.cache.json`（连 `sourceBase` 一起存），TTL 按 `modpackRefreshHours`（默认 24 小时）。
* 条目：`id`、`name`、`author`、`category`、`version`、`strategy`（当前只收 `lite`）、`file`、`sha256`、`size`、`createdAt`、`description{zh,en}`、`plugins[{name,version,description}]`、`downloads`。
* 插件端路由：`GET /api/market`（摘要 + 首页 + 已装标记）、`POST /api/market/search`、`POST /api/market/sync`、`POST /api/market/download`。下载只认目录里的 id，取回字节后先对体积与 `sha256`，再 `inspectPackBuffer`、`rememberPending`，返回的 `token` 交安装页读取——与手动导入走同一条。
* 客户端：`MarketPanel`（列表 / 详情 / 规则三视图），下载后 `requestInstall()` 一次交接给 `InstallPanel`，后者照旧 `POST /api/inspect`；进度仍在左下角悬浮窗。
* 开关：`showModpackMarket`（默认 true）、`modpackRefreshHours`（1~168）。



## 与插件市场的兼容

||装了插件市场|没装|
|-|-|-|
|目录、分类、搜索、分页、分组|✅ 同一份数据|❌ 只列本机已装|
|市场版识别（装完显示「市场版」）|✅ 按 `名字@版本` 装|❌ 显示「本地安装」|
|AI 搜索（一句话让模型挑插件）|✅ 用市场自己的接口与模型|❌ 只做关键词搜索|
|打包与安装本身|✅|✅|

AI 搜索花的 token 记在插件市场那边（它用你在「设置 → 模型」里配的 Key），本插件只转请求，不读也不存 Key。建议装插件市场（`dshmarket`），但不是必须。

设置里还有两个与市场相关的小开关：「强制关闭侧栏里的插件市场显示」（只写市场自己的 `sidebar-entry`，不动整合包的三处入口）；本机装了「解除卡顿」（`dsh-unlag`）时页面会多一个按钮，点它调的是那个插件的刷新接口，悬浮写明来源。

## 安全与隐私

* 打包前**强制**扫描风险与敏感信息，只留掩码，扫描内容不落盘；命中高危先停在「等决定」，确认后从检测点续跑，不重复扫。
* 配置与数据快照里，键名或值像凭据的会替换成 `${REDACTED}`，命中路径写进包内说明；导入方需要自己重填。
* 安装前校验 sha256 完整性、依赖与引擎版本、许可证；缺 `integrity.json` 直接拦下。
* 包里的插件是第三方代码：只装你信任来源的包。

## 常见问题

* **registry 连不上 / 「下载超过上限」**：设置里把「版本清单上限」调大（默认 64 MB），或直接填确定的版本号；装包时勾「离线安装」也会跳过联网路径。
* **只记安装码的包在本机装不回来**：市场没有本插件上传无法正常依靠联网安装，请更换懒人包或混合包。
* **进度窗丢失/忘了在哪**：页面标签行右边有「召回进度窗」点击。
* **想先装上但是不启用插件**：打包/安装时关掉「装后整体启用」，或在安装器加 `--no-bundles`。

## 代码地图

`docs/CODE-MAP.md` 是给改代码的人的索引：功能 → 文件 → 符号 → grep 示例，路由表自动生成。`dev/tools/map.mjs` 重跑即可刷新。

## 实现要点（给改代码的人）

* 宿主侧：`index.js` 只做路由与任务队列，打包/安装的纯逻辑在 `lib/`（`pack` / `install` / `scan` / `manifest` / `market-catalog` / `registry` / `net` / `groups` / `zip` / `tar` / `semver` / `store` / `http`），前端全部在单文件 `client.js`。
* 安装优先走宿主 `pluginManager.installBundle`（失败自动退回命令行，日志里 `via=manager|cli`）；懒人包先按 `名字@版本` 装，拿到「市场版」身份，失败才退回包内 `file:` 副本并明确提示会显示成本地。
* 风险扫描按「文件内容 sha1」去重，命中只留掩码；zip 解压有输出上限（防 zip bomb），清单缺 `integrity.json` 直接阻断。
* 分组只读写 `<profile>/.dsh-market/state.json`：打包时把 `group` 写进清单，安装时同组合并成员、新组追加，没装市场只说一句不建目录。
* 装包含独立安装器 `assets/install-stub.mjs`：完整版先把插件复制到 `~/.dsh/dsh-modpack/vendor/<名字>-<hash>` 再 `file:` 安装（解压目录删了也不会断），已装默认跳过。
* 改完源码要 `node dev/tools/sync.cjs`（profile 里是硬链接拷贝，不是软链）再 `node dev/tools/verify.cjs`。

## 已知限制

* 只记安装码的包必须联网，且市场里得有那个版本；市场没收录的插件只能打懒人包或混合包。
* `file:` / `link:` 依赖在插件市场里一律显示「本地安装」，这是市场的判定方式，不是本插件能改的。
* 包内插件是第三方代码，扫描只能降低风险，不能保证安全。

## 合规

* 不提供绕过授权、破解或规避平台规则的任何能力；打包与安装都在本机 DSH 内完成，不上传配置与数据。
* 许可证：PolyForm Noncommercial 1.0.0，仅限非商业用途；商用请另行联系作者。

项目地址：[https://github.com/Vesna-Strivozha-cn/dsh-modpack-kit](https://github.com/Vesna-Strivozha-cn/dsh-modpack-kit) —— 如果它省了时间，欢迎点个 Star。
