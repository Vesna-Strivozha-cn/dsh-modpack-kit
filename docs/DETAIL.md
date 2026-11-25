# 整合包（dsh-modpack-kit）

把多个 DSH 插件连同配置与数据打成一个 `.dshpack`，在另一台机器上一次装好。有插件市场时按市场版本装、识别成分组；没有市场时裸 DSH 也能用包内的独立安装器装完。

> 定位语（`tagline`，默认配置里可改）：谁说dsh不能整整合包呢？（你说这几个插件整一块不牛逼坏了）

## 能做什么

- **打包**：从「本机已装」或「插件市场目录」挑插件，逐个选版本与来源；三种策略——完整包、仅下载码、混合包。
- **逐插件定制**：「插件预设」只带插件默认配置，「自定义配置」带上本机配置条目与数据快照（本机来源时连代码改动一起打）。
- **只列真正的插件**：从 profile 依赖与 `bundles` 递归，父插件带进来的组件标 `isDirect: false`，打包、安装、安装器一致跳过。
- **安装**：读包 → 校验 sha256 → 扫描 → 兼容检查 → 逐插件交给宿主 `pluginManager.installBundle`（不可用或报错退回 `dsh plugin add`）→ 登记启用 → 回填配置与数据。
- **已装先跳过**：按插件名跳过，装完列出「本机 → 包内」，由你决定是否替换为包内版本。
- **入口**：设置页、侧边栏、插件页三处各一开关，接口层拒绝三处全关。
- **读取方式**：「选择文件…」「浏览文件夹…」、手写目录、「已导入的整合包」列表（内存里最多 8 份，带打包时的名字/作者/描述）、https 链接。

## 怎么用

1. 从左侧栏、设置页或插件页进入「整合包」。
2. 勾选插件 → 选打包策略 → 打包；看完安全报告与兼容提示后下载或存档。
3. 目标机器：装本插件，或直接跑包里的 `install/` 安装器 → 选文件或填链接 → 检测 → 安装。
4. 重启 DSH 生效。

## 三种打包策略

界面这一栏叫「打包策略（必选）」，三块卡片按你勾的插件实时判定，不能选的整块灰显、点一下只弹原因。

| 策略 | 进包内容 | 安装时 | 体积 |
| --- | --- | --- | --- |
| `full` | 清单 + `plugins/` + 配置 + 数据 + 报告 + 安装器 | 先按 `名字@版本` 从市场装，失败/离线退回包内副本 | 最大 |
| `lite` | 清单 + 版本号 + 报告 | 联网按版本取包，代码进内存扫 | 最小 |
| `hybrid` | 清单 + 版本号 + 配置/数据；没有确定版本或选了「连本机改动一起打」的插件才带 `plugins/` | 包里有目录的直接装（不联网），其余按版本取 | 接近 `lite` |

判定只有一份：`index.js` 的 `computePlan(selection)`，`POST /pack/plan` 返回它，`POST /pack` 打包前再算一次，`lite` / `hybrid` 不可用直接 400。`lite` 的硬条件是有确定版本且没有插件选「自定义配置」；`hybrid` 只拦「没版本、本机又没代码」。

## 安全模型

- 检测是静态的：只读文件比对规则，不执行、不 import、不跑安装脚本。能拦明显的密钥夹带与可疑写法，但不替代杀毒软件。
- 打包前强制扫描（开关点不动，写 `scanBeforePack: false` 会被拉回）；安装前再扫一次（默认开）。
- 命中原文只在内存比对；报告与历史只留规则名、文件、行号与掩码。
- 高危先停在 `paused`，确认后从检测点续跑（不重新收集、不重复检测），清单记 `security.acknowledged`。
- `integrity.json` 记每个文件 sha256，安装前校验，缺失或对不上直接阻断（显式 force 才越过）；解压有条目数、单文件、总大小、压缩比上限，拒绝绝对路径、`..`、符号链接与加密条目。
- 只放 https 与白名单域名，逐跳校验重定向，流式限体积。

## 包格式

```
dsh-modpack.json      清单：格式、插件、选项、安全摘要
README.txt            不依赖本插件的手工安装说明
security/report.txt   检测报告（规则、位置、掩码）
integrity.json        sha256 清单
install/install.mjs   独立安装器（裸 DSH 可用）
install/install.cmd   Windows 双击入口
install/install.sh    shell 入口
plugins/<name>/**     只有带本体的策略才有
configs/<name>.json   抓到的配置条目
data/<目录名>/**      插件数据快照（小文本）
```

文件名 `<包名>-<日期>-<full|lite|hybrid>.dshpack`。安装侧判断「要不要联网」只看包里有没有 `plugins/<目录>/`，不看整包 `format`，所以混合包可以一部分带本体、一部分只记版本。完整包会先把本体复制到 `~/.dsh/dsh-modpack/vendor/<包>-<hash>/` 再登记，删掉解压目录也不断。

## 配置与数据

- 配置来自 profile 的 `cordis.patch.yml`：按 `name`/`id` 取整段 `config`（含 `disabled`）存进 `configs/<name>.json`；安装时只替换这一条，其它字节原样保留，没有的追加在末尾。
- 保真：嵌套映射、数组、空容器、中文、多行字符串、布尔与数字都原样往返。
- 擦除：`redactConfig` 按归一化键名完全相等判凭据（`apiKeyEnv` 不误伤），值命中 `sk-` / `gh[pousr]_` / `xox[baprs]-` / `AKIA` 也换成 `${REDACTED}`；路径写进 `configRedacted`，安装时提示重填。
- 数据快照：只收 `~/.dsh/<目录>` 下的文本小文件（≤1 MB/个、整包 ≤8 MB），凭证类文件名跳过，文本再过一遍 `scrubText`；安装时写回，默认不覆盖已有文件（`--replace` 才覆盖）。
- 插件内安装与包内安装器两条路径规则一致。

## 与插件市场

- 目录与市场同源（`dsh-plugin-catalog` 的 `index.json`，失败退 npm tarball），分区即市场 23 类；首屏只列本机已装，搜索或点分类才查目录，服务端分页。
- 市场判定只看依赖写法：`file:` / `link:` 算本地，semver 算市场版。所以市场来源一律按 `名字@版本` 装；完整包失败或离线才退回 `file:` 副本，并明确提示「市场会显示成本地安装」。
- 分组：只读 `.dsh-market/state.json` 做折叠展示；按组打包会把组名写进清单，装到同样装了市场的机器上并进同名分组（`applyMarketGroups`，同名组并成员、其它键原样保留）。
- 没装市场：打包、装包、检测、校验、配置回填、三处入口照常，只少 Discover 界面与目录搜索。

## AI 搜索（借用插件市场的新接口）

- 市场新版本提供 `POST /dsh-market/ai-search`：body `{query}`，返回 `{result:{intro, picks:[{name, description, why, …}], model}}`；409 = `no-model`（还没配模型）。
- 打开开关后：输入一句话 → 回车或点「AI 来找」→ 拿回挑中的条目 → 自动补一次 `/catalog/lookup` 取版本 → 勾选即进打包（按市场版本装）。
- 失败分三种：旧版市场没有路由（开关不出现）、`no-model`（提示去「设置 → 模型」配一个）、模型报错（原样显示消息，关键词搜索照常可用）。
- 不在本插件里保存模型与 Key：模型调用完全由插件市场那边完成，这里只做一层界面与结果映射。市场也没有自己的 token——它走宿主 `llm` 服务 + `agentDefaultModel.currentSelection()`，扣的是你「设置 → 模型」里的那把 Key。

## 刷新按钮

标签行最右边是「刷新」，它只作用于整合包自己：重读 `/status`（插件列表、市场目录、进度窗），再把三个面板重挂一次（`gen` 变化 → 换 `key`），让它们各自重新取数。不调用其它插件的接口。失败原因显示在按钮左边，成功会在旁边写「已重新读取整合包自己的状态」。

## 插件市场侧栏入口与「解除卡顿」

- 设置里的「强制关闭插件市场在侧栏里的那一行」：写市场的 `POST /dsh-market/sidebar-entry { enabled: false }`，只改它存在 `<profile>/.dsh-market/state.json` 的 `sidebarEntry`，不改安装状态；市场用 409 拒绝「三个入口全关」时如实显示原因。开机时若开关为真，客户端会再确认一次。
- 「解除卡顿」（`dsh-unlag`）：`GET /dsh-unlag/state` 能读到 `version` 才显示按钮；按下走 `POST /dsh-unlag/reload?requestId=…`，带 `content-type: application/json` 与 `x-dsh-unlag: 1`，同源、本地 Host。按钮的 `title` 写明来源与版本。
## 安装顺序与进度窗

- 打包与安装共用任务队列：`POST /pack|/install { async: true }` 立即返回 job，`GET /jobs` 轮询；`/jobs/cancel` 终止（包在内存组装，取消不落盘）、`/jobs/ack` 续跑、`/jobs/dismiss` 删记录、`/jobs/clear` 清收尾。
- 悬浮进度窗可拖动（位置存 `localStorage`），没任务时收起只留「进度」胶囊；**胶囊本身也可拖动**（位移 >3px 算拖，否则算点开），位置只有一个来源 `pos`（`{x,y}` 左上角），渲染前经纯函数 `dockPlacement(viewport, size, pos)` 夹进视口（`size` 由 `offsetWidth/offsetHeight` 量出，不猜常数）；布局由纯函数 `dockFrame(viewport, pos, boxSize, headerH, open)` 一次算完：`pos` 是相对坐标 `{fx,fy}`（存 localStorage 的也是它，老像素值读入时按视口折算），宽高用 `offsetWidth/offsetHeight` 量（收起 `sizeClosed`、展开 `sizeOpen` 分开量），展开高度 = 当前可用空间夹到 `[DOCK_MIN_OPEN_H=200, DOCK_MAX_OPEN_H=560]`，宽度 = `min(380, vw-24)`；下面不够就 `upward: true`（`column-reverse`，标题压在底部、屏幕上不动）；每帧都按当前视口重算，所以缩放窗口不会错位；窗口缩放时重算；顶部预留 `DOCK_TOP_INSET = 56`，不让窗口停到 DSH 标签行上；标签行「召回进度窗」通过 `requestDockReset()`/`subscribeDockReset()` 清掉 `localStorage` 位置并回到右下角；收尾记录按 `jobKeepSeconds`（默认 0）与心跳（running 超 10 分钟判失败）处理。
- 安装预览：逐插件勾选、有问题的置顶（缺依赖 / 引擎版本不符）、每个带配置的插件可选「包内配置 / 保持本机」、「装后整体启用」、「装后同步市场分组」。
- 离线安装：勾「离线安装」或探不到 registry 时，只装带本体的插件；只记版本的会逐条说明「联网后再试」。

## 网络层（`lib/net.mjs`）

- `requestBuffer`：逐跳校验重定向（最多 6 跳），白名单版本 `HOSTS_VERSION` 控制老配置合并；超时 `netTimeoutSeconds`（默认 60），失败可退系统 `curl`（不带 `-L`，重定向仍由我们校验）。
- `npmMetadata`：版本清单按「精简 → 完整 → 单版本」三层退让，上限 `maxMetadataBytes`（默认 64 MB，夹 4~512）；超限提示调大上限或指定版本号。
- 传输压缩：fetch 带 `accept-encoding`，curl 兜底带 `--compressed`。

## 扩展接口

- 路由：Host 能力全在 `/dsh-modpack-kit/api/*`，界面只是消费者。
- 安装：`context.installBundle` 优先，缺省或抛错退回 `context.runCli`。
- 扫描 / 擦除：`scanEntries(entries, { extraRules })`、`redactConfig(value)`；设置项 `extraScanRules` 直接写 `settings.json` 即并入。
- 清单：`extensions` 字段留给二次开发；`schema` 高于支持版本时报「请先升级」。
- 目录：`CATALOG_SOURCES`、`catalogRefreshHours`、`catalogPageSize` 可调，分区读 `metadata.categories`。
- 显示位与分组：`PLACEMENT_MOUNTS` 加位置；`lib/groups.mjs` 的 `readMarketGroups` / `groupViews` / `hasMarket` / `applyMarketGroups`。

## 已知限制

- 只处理 npm 上发布的包与本机已装目录，不处理 git 直装。
- 配置抓取走 YAML 子集解析，遇到不支持的写法整体放弃并提示，不猜。
- peer 依赖只报「缺失/冲突」，`optional` 不影响结论；扫描是启发式的，会漏也会误报。
- 装完需重启 DSH 才能确认效果。

## 合规

- 再分发别人的插件前确认许可证允许或已获授权；包里记 license 与来源，缺失或不在允许列表需显式确认。
- 不要把带他人凭证、Cookie、私钥的包传到公开位置；检测拦明显的，责任在打包的人。
- 遵守所在地区法律与平台条款；本插件不提供绕过任何限制的能力。
