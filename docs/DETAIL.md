# 整合包（dsh-modpack-kit）

类似 HMCL / PCL 这类我的世界启动器的整合包工具：把多个 DSH 插件连同配置与数据打成一个 `.dshpack`，一次装好。支持完整包（自带插件文件，裸 DSH 也能装）与轻量包（只记名字与版本，安装时联网取包）。

## 能做什么

- **打包**：从「本机已装」或「插件市场目录」挑插件，逐个可选版本；两种形态——完整包（插件文件进包，目标机器只装 DSH 本体即可装）、轻量包（只记名字/版本，安装时从市场取包）。
- **逐插件定制**：「插件预设」只打插件默认配置；「自定义配置」带上本机配置条目与数据快照（来源是本机时连代码改动一起打）。默认插件预设，每行最左边的徽标显示来源（市场版 / 本机版）。
- **只列真正的插件**：`listInstalled` 从 profile 依赖 + `bundles` 出发递归，把父插件带进来的组件标成 `isDirect: false` 并记 `transitiveOf`；打包、安装、安装器都跳过它们，避免一个插件被当成九个。
- **安装**：读包 → 校验完整性 → 扫描 → 兼容检查 → 逐插件交给宿主 `pluginManager.installBundle`（不可用或报错时退回命令行 `dsh plugin add`）→ 登记启用清单 → 回填配置与数据。
- **已装先跳过**：按插件名判定，先跳过其余照装；装完列出「本机版本 → 包内版本」，由你选「直接完成」或「替换为包内版本」。
- **市场版身份**：市场版来源直接按 `名字@版本` 装，不先问 registry；轻量包取回代码后也按版本装，失败才退回 `file:` 副本并提示「市场会显示成本地安装」。
- **分组**：读插件市场的 `.dsh-market/state.json`，按你的分组折叠展示「已装」，组头带「一键加入 / 清空本组」；按组打包会把组名写进清单，装到同样装了市场的机器上并进同名分组。
- **分类 / 搜索 / 分页**：分类即市场 23 个分区；首屏只列本机已装、不联网，搜索或点分类才查目录，服务端分页（默认每页 20 条），底部「加载更多」。
- **三处入口**：设置页、侧边栏、插件页各一个开关，改了立刻挂上或撤下；接口层拒绝三处全关，免得没有入口关回来。
- **装完是否启用**：「安装后直接启用」默认关；关的时候依赖照写，但把 `dsh.profile.bundles` 精确撤回原样——重启也不加载。
- **读取方式**：「选择文件…」「浏览文件夹…」、手写目录、「已导入的整合包」列表（内存里最多 8 份，显示打包时的名字/作者/描述），或 https 链接。拖拽入口已去掉（外壳会接管文件拖放）。

## 怎么用

1. 从左侧栏、设置页或插件页进入「整合包」。
2. 「打包」页勾选插件（首屏是本机已装）→ 设包名与选项 → 打包；看完安全报告与兼容提示后下载或存档。
3. 换到目标机器：装本插件，或直接跑包里的 `install/` 安装器 → 选文件或填链接 → 检测 → 安装。
4. 重启 DSH 让新插件生效。

## 安全模型

- 检测是**静态**的：只读文件比对规则，不执行、不 import、不跑安装脚本。拦得住明显的密钥夹带与可疑写法，但**不替代杀毒软件**，也不证明插件安全。
- 打包前**强制**扫描：开关显示但点不动，API 写 `scanBeforePack: false` 也会被拉回 `true`。安装前再扫一次（可关，默认开）。
- 命中原文只在内存里比对；报告与历史只留规则名、文件、行号与掩码（如 `sk****（32 字符已隐藏）`）。
- 检出高危时任务停在 `paused`，确认「我知道在干什么」后从检测点续跑（不重新收集、不重复检测），清单记 `security.acknowledged`。
- `integrity.json` 记每个文件的 sha256；安装前校验，缺失或对不上直接阻断（只有显式 force 才越过）。
- 解压有上限：条目数、单文件、总大小、压缩比；拒绝绝对路径、`..`、盘符、反斜杠、符号链接与加密条目。
- 只放 https 与白名单域名，逐跳校验重定向，流式限体积。

## 包格式

```
dsh-modpack.json      清单：格式、插件、选项、安全摘要
README.txt            不依赖本插件的手工安装说明
security/report.txt   检测报告（只有类型、位置、掩码）
integrity.json        sha256 清单
install/install.mjs   独立安装器（裸 DSH 可用）
install/install.cmd   Windows 双击入口
install/install.sh    shell 入口
plugins/<name>/**     完整版才有
configs/<name>.json   抓到的配置条目
data/<目录名>/**      插件数据快照（小体积文本）
```

文件名 `<包名>-<日期>-<full|lite|hybrid>.dshpack`。

| 策略 | 进包的内容 | 安装时 |
| --- | --- | --- |
| `full` | 清单 + `plugins/` + 配置 + 数据 + 报告 + 安装器 | 先去 `~/.dsh/dsh-modpack/vendor/<包>-<hash>/` 再登记，删了解压目录也不会断 |
| `lite` | 清单 + 版本号 + 报告（无 `plugins/`、无配置） | 按 `名字@版本` 从 npm 取包，代码直接进内存扫描，不落临时目录 |
| `hybrid` | 清单 + 版本号 + 配置/数据/补丁片段（无 `plugins/`） | 同 `lite`，装完再按条目回填配置 |

三种策略都带 `install/` 独立安装器；`lite`/`hybrid` 里没有代码，安装时必须联网。

## 配置与数据

- 配置来源是 profile 的 `cordis.patch.yml`：按 `name`/`id` 取该插件整段 `config`（含 `disabled`）存进 `configs/<name>.json`；安装时只替换这一条，其它字节原样保留，包里没有的追加在末尾。
- 保真：嵌套映射、数组、空数组/空对象、中文、多行字符串、布尔与数字都原样往返（空容器写成 `key: []` / `key: {}`）。
- 擦除：`redactConfig` 按归一化键名完全相等判凭据（`apiKeyEnv` 不误伤），值命中 `sk-` / `gh[pousr]_` / `xox[baprs]-` / `AKIA` 也换成 `${REDACTED}`；路径写进 `configRedacted`，安装时提示重填。安装时不再二次擦除。
- 数据快照：只收 `~/.dsh/<目录>` 下的文本小文件（`.json/.md/.txt/.yml/.yaml/.csv/.toml/.ini`，单文件 ≤1 MB、整包 ≤8 MB），凭证类文件名跳过；文本再经 `scrubText` 擦一遍，命中数记 `dataRedacted`。安装时写回 `~/.dsh/<目录>`，**默认不覆盖已有文件**（`--replace` 才覆盖）。
- 插件内安装与包内安装器两条路径规则一致。

## 与插件市场

- 目录：读市场自己的 `dsh-plugin-catalog`（CDN `index.json` 优先，失败退 npm tarball）；分区名与条目数跟市场一致，索引落在 `<DSH_HOME>/dsh-modpack/catalog/market.json`。
- 市场判定只看依赖写法：`file:` / `link:` 算本地，semver 算市场版。所以市场来源的插件一律 `名字@版本` 装。
- 完整包的安装优先级（方案 A）：清单里有确定版本时先按 `名字@版本` 装（`install.mjs` 的 `preferMarketSpec`），成功则 profile 依赖是 `^版本`、市场显示市场版；失败或离线才 `installSpec("file:" + dir)` 退回包内副本，依赖变 `file:`、市场显示本地安装，结果里明确提示。`options.preferMarket === false` 可整段关掉这条优先级。
- 没装市场：打包、装包、强制检测、完整性/兼容/许可证校验、配置回填、三处入口都照常，只少 Discover 界面与目录搜索（建一次索引即恢复）。
- 分组：`readMarketGroups` 只读不写；`applyMarketGroups` 在安装时做「同名组并成员、新组追加、其它键原样保留」；目标没装市场（没有 `.dsh-market`）就不写，只说明一句。

- 入口形态：设置里是一整节；侧边栏是独立页面；插件页里只是一条标签，渲染时不再重复页头，也不自己造滚动区（交给插件页滚），高度由内容决定（`Home` 的 `surface === "plugins"` 分支）。首屏读状态失败会自动退避重试三次并给一个「重试」按钮——宿主刚起来时会话还没就绪，第一次常常拿不到 401 之外的东西。

## 安装顺序与进度窗

- 打包与安装共用任务队列：`POST /pack|/install { async: true }` 立即返回 job，`GET /jobs` 轮询；`/jobs/cancel` 终止（包在内存组装，取消不落盘）、`/jobs/ack` 续跑、`/jobs/dismiss` 删记录、`/jobs/clear` 清收尾。
- 悬浮进度窗：左下角起，按住标题可拖，位置存 `localStorage`（`dsh-modpack-kit:dock-pos`）；没任务自动收起，只留「进度」按钮唤出。标题栏按钮与拖动不共享判定（`closest("button")` 直接返回）。
- 收尾：`jobKeepSeconds` 默认 0（留到重启或手动清）；正数按秒清，失败/取消取 `min(该值, 15 秒)`；心跳超 10 分钟的 running 先判失败再清走；`paused` 永不自动清。
- 完成任务可点「下载安装包」：切到打包页、回填结果并滚到下载区；结果存在客户端缓存里，切页签不丢。
- 安装预览：逐插件勾选（未勾的作为 `options.only` 的补集排除）、有问题的插件置顶（`compat.findings` 里 `level !== "info"` 的条目按插件分组显示）、每个带配置的插件可选「包内配置 / 保持本机」（`options.configChoice[name] = "pack" | "local"`）、「装后整体启用」（`enableBundles`）与「装后同步市场分组」（`options.syncGroups`，默认开）。
- 策略可用性：`POST /pack/plan` 返回三张卡片能否选与原因（缺 semver 版本的插件让 `lite`/`hybrid` 灰掉；本机没有代码的市场插件会在 `full` 的说明里提示打包时要联网取一次）。
- 体积上限：`maxPackBytes` 默认 512 MB（16~4096），单个下载 `maxDownloadBytes` 默认 256 MB；允许同时打多个包。

## 网络层（`lib/net.mjs`）

- `assertAllowedUrl`：只放 https，主机名须在白名单（含子域），白名单版本号 `HOSTS_VERSION` 控制老配置合并。
- `requestBuffer`：逐跳手动跟随重定向（最多 6 跳），每跳重新校验；超时 `netTimeoutSeconds`（默认 60）、`netRetries`；fetch 全失败且 `curlFallback` 为真时用系统 `curl -i`（不带 `-L`，重定向仍由我们校验），`--max-filesize` 与响应上限双保险。
- `npmMetadata`：版本清单按「精简（`application/vnd.npm.install-v1+json`）→ 完整 → 单版本（`/名字/版本`）」三层退让；体积上限 `metadataLimit(config)` 读 `maxMetadataBytes`（默认 64 MB，夹 4~512）。超限时错误会说明两条出路：调大上限，或给确定版本号。
- 传输压缩：fetch 带 `accept-encoding: gzip, deflate, br`，curl 兜底带 `--compressed`；`requestJson` 不再覆盖调用方传入的 `accept`。
- 轻量包安装：`context.resolveSourceEntries` 把 tarball 解出的条目直接交给 `scanEntries`（内存里扫、不落临时目录），再按 `名字@版本` 交给宿主安装；宿主没提供这条能力时才退回「解到临时目录再扫」。

## 扩展接口

- 路由：Host 能力全在 `/dsh-modpack-kit/api/*`，界面只是消费者，换 UI 不用动后端。
- 安装：`installPack` 的 `context.installBundle` 优先（宿主 `pluginManager.installBundle(spec, { enabled, expected })`，pnpm、激活、回滚都归宿主），缺省或抛错退回 `context.runCli`。
- 扫描：`scanEntries(entries, { extraRules })`；规则形状见 `SECRET_RULES` / `MALWARE_RULES`；同内容文件按 sha1 复用结论，文件名单独重算。
- 擦除：`redactConfig(value)` + `SECRET_KEY_SET` / `SECRET_VALUE_PATTERN`；设置项 `extraScanRules` 直接写 `settings.json`，打包与安装都并入扫描器（页面不暴露）。
- 压缩：`PRECOMPRESSED_EXT` 里的扩展名直接存储，>2 MiB 用 deflate 6 级，其余 9 级。
- 清单：`extensions` 字段留给二次开发，安装端原样保留；`schema` 高于支持版本时报「请先升级 dsh-modpack-kit」。
- 目录：`CATALOG_SOURCES` 换地址；`catalogRefreshHours`（1~168）与 `catalogPageSize`（5~100）可调；新增分区不用改代码，读 `metadata.categories`，`CATEGORY_FALLBACK` 只是首次同步前的兜底。
- 显示位：`client.js` 的 `PLACEMENT_MOUNTS` 每组开关对应一组槽位，加第四个位置就往里加一组并在设置页加开关。
- 分组：`lib/groups.mjs` 的 `readMarketGroups` / `groupViews` / `hasMarket` / `applyMarketGroups`；`status` 下发 `groups`、`ungrouped`、`groupSource`。

## 已知限制

- 只打 npm 上发布的包或本机已装目录，不处理 git 仓库直装。
- 配置抓取走 YAML 子集解析，遇到不支持的写法整体放弃并提示，不猜。
- peer 依赖只报「缺失/冲突」；`optional` 的 peer 不影响结论。
- 扫描是启发式的，会漏也会误报；安装效果需重启 DSH 才能确认。
- 目录是市场 npm 侧的条目（约 5600 条），只能从 GitHub 装的不在其中；索引 24 小时内不重复取。

## 合规

- 再分发别人的插件前确认许可证允许或已获授权；包里记 license 与来源，缺失或不在允许列表需显式确认。
- 不要把带他人凭证、Cookie、私钥的包传到公开位置；检测拦明显的，责任在打包的人。
- 遵守所在地区法律与平台条款；本插件不提供绕过任何限制的能力。
