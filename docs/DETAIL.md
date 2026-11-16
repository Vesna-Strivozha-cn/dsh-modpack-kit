# 整合包（dsh-modpack-kit）

把多个 DSH 插件打成一个 `.dshpack`，换台机器或少个插件时不用一个个找版本。

## 能做什么

- **打包**：从「本机已装」或「插件市场目录」挑插件，可逐个指定版本；生成完整版或轻量版。
  - 完整版：插件文件一起装进 zip。对方没装本插件，按包内 `README.txt` 手工装也能用。
  - 轻量版：只留名字、版本与来源，安装时联网按记录取包，体积小但需要网络。
- **逐插件模式**：每个插件单独选「基础配置」（上游原版代码 + 插件默认配置，不带你的改动）或「本地改动」（你本机现在的代码、配置、数据快照）。全局开关只是新勾选时的默认值，勾上之后仍可逐个改。
- **可选项**：是否带插件本体、是否带配置与数据快照、打包前是否扫描。
- **检测（打包前强制）**：打包一定会扫，没有关掉的路径——开关照常显示但点不动，点一下弹红字「你想干什么」五秒；API 里写 `scanBeforePack: false` 也会被拉回 `true`。安装前再扫一次（这一项可以关，默认开）。规则覆盖私钥、云厂商与代码托管 token、常见大模型 key、Cookie/会话字段、邮箱与手机号、内网地址、本机用户路径，以及 `curl|sh`、`powershell -enc`、`eval`/`new Function`、可疑长 base64、关闭证书校验、`postinstall` 脚本等。
- **兼容性**：与已装版本、peer 依赖、`engines.dsh`/`engines.node`、许可证允许列表比对，给出等级、原因与建议；有阻断项时默认不装。
- **安装**：读包后先校验完整性、扫描与兼容性，再逐插件走官方 `dsh plugin add` 装进 profile。和打包共用左下角那个进度窗（读包 → 校验 → 扫描 → 逐插件装 → 登记启用清单 → 回填配置，带百分比，可终止、可和别的任务并行）。
  - **已装先跳过**：按插件名判定（同名、以及同一个插件不同版本都算「已有」），先跳过、其余照装；装完列出「本机版本 → 包内版本」，由你选「直接完成（保留本机）」或「替换为包内版本（只换列出来的这几个）」。
  - **联网优先市场版**：开关默认开（设置项 `preferMarketOnInstall`）。能查到就用 `名字@版本` 从 registry 装，查不到/离线/关掉才用包内那份；每个插件的动作里写明走的是 `market` 还是 `pack`。
- **安装后同步**：包内配置按条目回填到 profile 的 `cordis.patch.yml`，只改目标插件那一条，其它字节原样保留；已装插件默认不被覆盖（「保留本地修改」）。
- **读取方式**：「选择文件…」（系统文件选择器，只列 `.dshpack`）、「浏览文件夹…」（系统目录选择器，选完自动列目录）、手写任意目录后「读这个目录」、插件自己的 `packs/` 目录，或一个 https 链接。用前三种读过的包会留在「已导入的整合包」列表里（最多 8 份，各自显示打包时的名字、作者、生成时间与描述，可切换或移除）。拖拽入口已去掉（外壳自身会接管文件拖放）。
- **独立安装器**：完整版与轻量版都带 `install/install.mjs|.cmd|.sh`，对方不装本插件、只有一个裸 DSH 也能装。它把插件复制到 `~/.dsh/dsh-modpack/vendor/<包>/` 再登记，所以删掉解压目录也不会断；默认跳过本机已装的插件并汇总提示，加 `--replace` 才换成包内版本；`--no-bundles` 装完不启用，`--dry-run` 只演练。
- **进度窗的收尾**：失败与取消的记录只留十几秒，完成的按设置 `jobKeepSeconds`（默认 60 秒，0 = 收尾即清）清掉，卡住的 running（十分钟没有新进度）先判失败再收走；只有正在跑的、停在风险点的会一直留着。「清空进程」是乐观更新（先在界面摘掉再通知服务端），单条「删除该进程」同样会收掉安装页那条结论。
- **与插件市场联动（建议先装市场，但非必须）**：目录直接读市场自己的目录包 `dsh-plugin-catalog`（CDN 的 `index.json` 优先，取不到退回 npm tarball），分区名与条目数跟市场一致；本机列表来自同一个 `node_modules`；安装走同一条 `dsh plugin add` 链路，所以两边装的插件互相可见。已装插件会从目录补齐描述与分区，并标出「市场新版 x.y.z」。
  - **装了市场**：目录、分类、搜索、「切换市场版」、市场版版本对比都在；市场的 Discover 栏与本插件的「插件页内」栏并排，互不占位。
  - **没装市场**：打包、装包、强制检测、完整性/兼容/许可证校验、配置回填、装好先不启用、三处入口**全部照常**（这些槽位由 DSH 核心声明，不依赖市场插件）。少的只有市场 Discover 界面，以及**尚未建过目录索引时**的分类胶囊、搜索、市场版对比与「切换市场版」。建一次索引（5~30 秒）即恢复。
  - **没索引又没网**：首屏仍只列已装插件；已装行的分类退回内置兜底规则，与 23 类的 id 不完全对得上，按 theme / memory 之类筛会漏几条；轻量包装不了（需按清单版本联网取包），完整版照装。
- **分类 + 搜索 + 分页**：分类就是市场的 23 个分区。首屏只列本机已装的插件，不联网；输入关键词或点分类才去目录里搜，服务端分页（默认每页 20 条，可改），底部「加载更多」。排序照抄市场：已装优先 → 相关度（整字段 > 包含 > 其它词，包名权重最高）→ 目录原序；本机独有、目录里没有的插件也能搜到。
- **风险确认**：检出高危时不再直接拒绝，而是把任务停在 `paused` 等你确认「我知道在干什么」；确认状态写进清单 `security.acknowledged`，报告照常列出命中。市场收录与否只影响 `security.trustedOnly` 与提示措辞。
- **快捷选择**：打包页搜索框右侧有「全部加入」（本机已装全部插件，按「基础配置」）与「清除选择」。
- **切换市场版**：本机已装插件若在目录里有同名条目，行末有小字「（切换市场版）」——改用上游原版代码 + 默认配置打包；再点「（切回本机版）」回到本机快照。同名可能是撞名，所以只作为选项，默认仍打本机那份。
- **显示位置**：设置页底部三个独立开关（设置页内 / 侧边栏 / 插件页内），改了立刻挂上或撤下，不用重启；只剩一处时那个开关会变灰、点不动，接口层也会拒绝三处全关，免得再没有入口关回来。
- **装完是否启用**：安装页与设置里都有「安装后直接启用」，默认关。关的时候文件与依赖照装，但装完会把 `dsh.profile.bundles` 精确撤回原样——重启也不加载，想用再手动登记或重装时勾上。

## 怎么用

1. 从你打开的位置进「整合包」：左侧栏入口、设置页里的一栏，或插件页里单开的一栏（三处可在设置页底部各自开关）。
2. 「打包」页勾插件（首屏就是你已装的，要更多就搜或点分类）→ 设包名与选项 → 打包。先看安全报告与兼容提示，再下载或存到本机。
3. 换到目标机器：装好本插件（或按包内 README 手工装）→「安装 / 导入」→ 选文件或填链接 → 检测 → 安装。
4. 安装后重启 DSH 让新插件生效。

## 安全模型

- 检测是**静态**的：读文件、比规则，不执行、不 import、不跑安装脚本。因此它拦得住明显的密钥夹带和常见可疑写法，**不替代杀毒软件**，也不会证明一个插件安全。
- 命中原文只在内存里比对；报告与历史只记录规则名、文件、行号与掩码（如 `sk****（32 字符已隐藏）`）。报告写进包内 `security/report.txt` 时同样只有掩码。
- 高风险默认拒绝出包/安装。只有显式勾「忽略阻断」才会继续，且该决定会写进清单的 `security.approvedRisk`。
- 包内 `integrity.json` 记录除自身外每个文件的 sha256；安装前校验，缺失或对不上直接阻断（只有显式 force 才越过）。
- 解压有上限：条目数、单文件、总大小、压缩比；拒绝绝对路径、`..`、盘符、反斜杠、符号链接与加密条目。
- 只有 https 与白名单域名可下载；逐跳校验重定向，流式限体积。

## 包格式

```
dsh-modpack.json      清单：格式、插件、选项、安全摘要、安装提示
README.txt            不依赖本插件的手工安装说明
security/report.txt   检测报告（只有类型、位置、掩码）
integrity.json        sha256 清单
install/install.mjs   独立安装器（不装本插件也能装这个包）
install/install.cmd   Windows 双击入口
install/install.sh    shell 入口
plugins/<name>/**     完整版才有
configs/<name>.json   抓到的配置条目
data/<name>/**        插件数据快照（仅小体积文本）
```

文件名：`<包名>-<日期>-<full|lite>.dshpack`。

## 打包市场里没装的插件

`buildPack` 的 `selection[]` 支持三种来源：`profile`（读本机已装目录）、`npm`（按 `spec`/`version` 从 registry 取 tarball）、`url`（保留给后续扩展）。`/pack` 路由会自己纠偏：`item.source` 写了 npm、或这个插件在本机 `installed` 里找不到，一律按 npm 源走，`spec` 缺省用 `item.version`。npm 源的条目在清单里记 `source: "npm"`、`localEdits: false`、`mode: "base"`。

客户端：搜索结果里 `installed === false` 的行，勾选时按 `source: "npm"` 入队，版本框预填该条目的版本（清空 = 取最新）。

## 用「打开文件」挑包与自定义目录（安装入口）

- `POST /pack/drop`：两种请求体都收——默认是 `.dshpack` 原始字节（`Content-Type: application/octet-stream`，上限 `MAX_DROP_BODY = 256 MB`，走 `readRawBody`）；当 `Content-Type` 含 `application/json` 时读 `{ name, data }`，`data` 是 base64（走 `readBody` + `readRawBody`，上限同上），`data` 缺失返回 400「没有收到整合包内容」。两条路都 `inspectPackBuffer` → `rememberPending` 拿 token，返回与 `/inspect` 同形（含 `scanGroups`、`compat`、`integrity`）。
- 客户端两条入口（`InstallPanel`）：「选择文件…」（隐藏 `<input type="file" accept=".dshpack">`）、「浏览文件夹…」（`ctx.get('uiWorkspace').pickDirectory()`，宿主原生目录选择器；不可用时提示手写路径）。上传统一走 `uploadPackFile`：先试原始字节，失败自动退回 base64 的 JSON 再试一次，两条路的错误一起报出来。拖拽入口已移除（外壳自带文件拖放会抢事件）。
- 「已导入的整合包」列表：`importStore`（模块级，最多 8 份）保存读过的包——`importEntry(data, fileName)` 取清单里的 `name/description/author/format/createdAt` 与插件数；卡片上「选择」调 `POST /inspect {token}` 重新取预览，过期则自动从列表移除；「移除」/「全部移除」只删列表项，不动宿主的 pending。
- 裸 DSH 侧：`assets/install-stub.mjs` 首行打印包名与格式，随后打印「打包者」「打包时间」「包含插件：N 个」「说明：」逐行原文——不装插件也能知道这份包是谁做的、干什么用的。
- `POST /packs { dir }`：列任意目录（绝对路径）里的 `.dshpack`，条目带绝对 `path`；`GET /packs` 仍读插件自己的 `packs`。`inspectInput` 支持绝对路径的 `file`，所以选中即按路径读。
- 进程清理：`/jobs/clear` 只留 `running` 与 `paused`，其余（含 4% 就因许可证被拒的失败任务、卡住的假 running）都清掉；客户端「清空进程」在有任务时常驻，批量失败会退回逐条 `/jobs/dismiss`。`pruneJobs()` 由设置 `jobKeepSeconds`（默认 60 秒，0 = 收尾即清）驱动：完成/已确认的按它清，失败/取消的取 `min(它, 15 秒)`，仍在 `running` 但心跳（`updatedAt`）超过 10 分钟的先被判成失败再一起清；`paused`（等风险决定）永不自动清。安装任务在结果写进页面后由客户端自动 `/jobs/dismiss`。客户端的「清空进程」是乐观更新：先把收尾的行从界面摘掉并 `fireClear()`，再 `POST /jobs/clear`，失败时退回逐条 `/jobs/dismiss`。

## 安装顺序与「已装先跳过」

安装与打包共用任务队列（`GET /jobs` 里 `kind: "install"`）：`POST /install { async: true }` 立即返回 job，进度由 `installPack` 的 `onProgress` 推进（8 检查已装 → 12~80 逐插件 → 84 登记启用清单 → 92 回填配置 → 100 完成）。

判定「已装」用插件名（`installed` 列表），不比对版本。默认 `deferExisting: true`：已装的不动，记进返回值的 `deferred`（`{ name, localVersion, packVersion, sameVersion }`），动作是 `deferred`。装完用户二选一：保留本机 → 什么都不做；替换 → `POST /install/replace { token, names }`，内部用同一次读取的 `inspected` 以 `replaceExisting: true, keepLocal: false, only: names` 再跑一遍，未选中的动作记为 `skipped`。

装的时候还会先问一句市场：`context.resolveMarket(plugin)` → `npmMetadata` + `pickVersion`（先按包内版本找，找不到取 latest），命中就用 `plugin.name@version` 交给 `dsh plugin add`，动作里 `source: "market"`；关掉 `preferMarket`（设置项 `preferMarketOnInstall`，请求里也能逐次关）或查询失败，才用包内那份（`source: "pack"`，`file:` 指向 vendor 里的副本）。

包内独立安装器（`install/install.mjs`）行为对齐：读 `profile/package.json` 的 `dependencies`，同名即跳过并收集到 `skipped`，收尾打印清单与 `--replace` 提示；`--replace`（别名 `--force-existing`）时照常覆盖。

## 风险列表与打包进度

- 命中按来源分栏：每个插件一组、`configs/` 一组、`data/` 一组，整合包自身（清单、README、安装器）单独一组；整体可折叠，每组也可折叠，组头带高/中/低计数，高危组排最前。
- 打包走后台任务（`POST /pack` 带 `async: true` → `GET /jobs` 轮询）：悬浮进度窗显示概述 + 百分比 + 进度条，展开可看每个任务；`POST /jobs/cancel` 终止，包在内存里组装，取消不会写到磁盘。
- 检出高风险时任务一律停在 `paused`：`GET /jobs` 带 `risk`（高/中/低、`trustedOnly`、按插件分组的命中摘要 `risk.groups[].samples`）与 `canAck`，打包页会在选项下方按插件分别列出这些命中项。「我知道在干什么」= `POST /jobs/ack`：复用停在那一刻的中间结果（`job.checkpoint`：已收集的文件、配置快照、检测结果），从检测点继续，**不重新收集、也不重复检测**，清单记 `security.acknowledged`；确认成功的同时 `job.risk` 清空，界面上的红字警告随之消失（记录只留状态与进度）。「删除该进程」= `POST /jobs/dismiss`（只删记录，跑着的任务不给删）。
- 安装任务拿到结果后就自动 `/jobs/dismiss`（结果已在安装页），不需要手动清。
- 收尾的任务在进度窗里给「下载安装包」：点击会切到打包页、把该任务的 `data` 放回结果区并滚到下载部分；结果存在客户端模块级缓存里（`packStore`），切页签、卸载再挂载都不丢，程序退出或插件被关掉才清。进度窗的「清空进程」（`POST /jobs/clear`）清掉所有收尾记录——完成的、失败的、取消的，以及像「超过打包上限」这类中途报错卡住的失败进程都带走；`running` 与 `paused`（还在跑或等你决定）保留。界面侧如果发现宿主还是旧代码（`/jobs/clear` 404），会退回逐个 `POST /jobs/dismiss`；清空后打包页上残留的报错与失败结果也一并收掉。
- 悬浮进度窗可拖：按住标题拖动，位置存在浏览器 `localStorage`（键 `dsh-modpack-kit:dock-pos`），不经过服务端配置；没有任务时自动收起，只留一枚「进度」按钮用于唤出，任务开跑会自动冒出。标题栏里的按钮（「清空进程」「收起」）与拖动、点击展开不共享判定：`startDrag` 遇到 `event.target.closest("button")` 直接返回（否则 `setPointerCapture` 会把 `click` 抢走，按钮点不到，抬手还会顺手切换展开状态），两个按钮本身也在 `pointerdown` 上 `stopPropagation`，并带 `flexShrink: 0` 免得被标题挤扁。
- 体积上限默认 `maxPackBytes = 512MB`；单个下载另有 `maxDownloadBytes = 256MB`。
- 允许同时打多个包（每个任务独立 token、独立进度）。

## 已知限制

- 只打包已发布的 npm 包或本机已装目录，不处理 git 仓库直装。
- 配置抓取依赖 `cordis.patch.yml` 的 YAML 子集解析；遇到不支持的写法会整体放弃抓取并提示，而不是猜。
- peer 依赖只做「缺失/冲突」提示；带 `optional` 标记的 peer 不影响结论。
- 安装后的实际加载效果需要重启 DSH 才能确认；页面只报告「需要重启」。
- 扫描规则是启发式的，会漏、也会误报；误报可先看报告再决定是否忽略。
- 目录条目是市场发布的 npm 侧子集（约 5600 条，都是能用 `npm` 装到的），站点上那些只能从 GitHub 装的不在其中；首次同步 5~30 秒看网络，之后 24 小时内不再重复取（可手动「更新目录」）。

## 扩展接口

- `lib/scan.mjs`：`scanEntries(entries, { extraRules })` 接受额外规则；规则形状见同文件 `SECRET_RULES`/`MALWARE_RULES`。
- `lib/zip.mjs` / `lib/tar.mjs`：独立读写器，可单独用于其它打包场景。
- 清单 `extensions` 字段：打包时可写入自定义数据，安装端原样保留，供二次开发读取。
- 目录：`lib/market-catalog.mjs` 管同步与索引。条目来源换成别的地址，改 `CATALOG_SOURCES`；索引落在 `<DSH_HOME>/dsh-modpack/catalog/market.json`；`catalogRefreshHours`（1~168）控制多久重取一次，`catalogPageSize`（5~100）控制每页条数。新增分区不需要改代码——名字与条目数都从目录的 `metadata.categories` 读，`CATEGORY_FALLBACK` 只是首次同步前的内置表。
- 白名单域名有版本号：新增默认域名时把 `lib/store.mjs` 的 `HOSTS_VERSION` 加一，老 `settings.json` 会并一次新域名，之后尊重用户自己的增删。
- 显示位置：`client.js` 的 `PLACEMENT_MOUNTS` 定义每组开关挂哪些槽位，加第四个位置就往里加一组并在 `SettingsPanel` 加一个开关，`Set` 里其余逻辑不用动。
- 选择项的 `mode`（`'base'` / `'local'`）会落到清单每个插件的 `mode` 字段；老包没有该字段时按 `localEdits` 兜底。想加第三种策略（比如「只带代码不带配置」），在 `lib/pack.mjs` 的 `wantLocal` 与配置快照那段加分支即可。
- 设置项 `extraScanRules`：直接写在 `<DSH_HOME>/dsh-modpack/settings.json` 里，打包与安装都会合并进扫描器（页面不暴露，留给二次开发）。
- Host 侧全部能力在 `/dsh-modpack-kit/api/*` 下，页面只是消费者；要换 UI 不必动后端。
- 分类：`lib/classify.mjs` 的 `CATEGORIES` 加一条、往 `RULES` 塞关键词即可；客户端 `CATEGORY_LABELS` 同步加名字（id 必须一致），未知 id 显示「其它」。
- `dev/tools/check-categories.mjs` 只读打印目录分类分布与「已装插件在市场里有无同名条目」，改词表后用它看效果。

## 合规

- 再分发别人的插件前，确认其许可证允许，或拿到作者授权。包里会记 license 与来源；缺失或不在允许列表时需要显式确认。
- 不要把包含他人账号凭证、Cookie、私钥的包上传到公开位置。检测会拦明显的，但最终责任在打包的人。
- 遵守你所在地区的法律与各平台条款（例如代码托管平台的用户协议、软件许可证）。本插件不提供绕过任何限制的能力。
