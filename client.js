/**
 * dsh-modpack-kit —— 客户端半边：左侧栏「整合包」。
 *
 * 改之前先看 docs/CODE-MAP.md（功能 → 符号 → grep 示例）。
 *
 * 四个页签：打包（挑插件、策略三选一、检测报告）、安装 / 导入（链接/本机包、预览、落地）、
 * 社区资源（浏览别人传的整合包，下载后交回安装页）、设置与记录（显示位置、市场、目录、历史）。
 * 数据全部来自 /dsh-modpack-kit/api/*（同源 fetch），与 host 端共用同一份状态；这里不碰文件，也不直接发网络请求（市场 AI 搜索除外，它转发给插件市场）。
 *
 * 制作通告：本文件在 DeepSeek Harness（DSH）会话中由 AI 助手与作者 Vesna-Strivozha-cn 协作产出。
 */
window.__ModuleLoader__.load({
  id: "dsh-modpack-kit",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const React = require("react")
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

    const API = "/dsh-modpack-kit/api"

    const box = { border: "0.5px solid var(--dsw-alias-border-l2)", borderRadius: "8px", padding: "12px 14px" }
    const hint = { color: "var(--dsw-alias-label-tertiary)", fontSize: "11.5px", lineHeight: "17px" }
    const label = { fontSize: "13px", lineHeight: "19px" }
    const strong = { fontSize: "13px", fontWeight: 600, lineHeight: "20px" }
    const btn = { height: "28px", padding: "0 12px", fontSize: "12.5px", borderRadius: "6px", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-primary)" }
    const btnPrimary = { ...btn, background: "var(--dsw-alias-fill-primary, #3b6cf6)", borderColor: "transparent", color: "#fff" }
    const input = { height: "26px", padding: "0 8px", fontSize: "12.5px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-primary)", boxSizing: "border-box" }
    const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "11.5px", lineHeight: "17px" }
    const row = { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }
    const chip = { fontSize: "11px", padding: "1px 6px", borderRadius: "999px", border: "0.5px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)" }
    const chipBtn = { ...chip, cursor: "pointer", background: "transparent", fontFamily: "inherit" }
    const chipOn = { ...chipBtn, color: "var(--dsw-alias-label-primary)", borderColor: "var(--dsw-alias-fill-primary, #3b6cf6)" }

    const LEVEL_COLOR = { high: "#ff6b6b", error: "#ff6b6b", medium: "#ffb020", warn: "#ffb020", low: "#8a8f98", info: "#8a8f98" }
    const FORMAT_TEXT = { full: "完整版（含插件本体）", lite: "轻量版（联网取包）", hybrid: "混合包（联网取包 + 配置）" }
    // 三种打包策略的介绍：服务端 /pack/plan 会给可用性与不可用原因，这里只做兜底展示
    // ===== [区块] 打包策略与常量：STRATEGY_INFO =====
    const STRATEGY_INFO = [
      { id: "full", title: "完整包（懒人包）", online: false, note: "插件本体一起装进包，不联网也能装。有网时按市场版本装，装完依赖是 ^版本，插件市场认成市场版；离线才退回包内副本（显示本地安装）。可以带自定义配置与数据。" },
      { id: "lite", title: "轻量包（轻量包）", online: true, note: "只记 名字@版本，体积最小。安装时必须联网从市场取包，不带自定义配置与数据，插件市场按版本认成市场版。" },
      { id: "hybrid", title: "混合包（轻量为主 + 必要的完整）", online: true, note: "能按版本装的就只记 名字@版本（安装时联网取包）；没有确定版本、或者要带走本机改动的插件，连本体一起打进来（这部分安装时不用联网）。配置/数据/补丁片段照样带。" },
    ]
    // 分类以插件市场为准：id 与市场目录一致，中文名由 host 从市场目录里带回来。
    const CATEGORY_LABELS = { all: "全部", other: "其它" }
    const categoryOf = (entry) => (entry && entry.category) || "other"

    // 三处显示位（设置内 / 侧边栏 / 插件内页签）：各自独立开关，点一下立刻重挂载，不用重启。
    const PLACEMENT_KEYS = ["settings", "sidebar", "pluginsTab"]
    const placement = { value: { settings: true, sidebar: true, pluginsTab: false }, subs: new Set() }
    function normalizePlacement(raw) {
      const next = { settings: true, sidebar: true, pluginsTab: false }
      if (raw && typeof raw === "object") for (const key of PLACEMENT_KEYS) if (typeof raw[key] === "boolean") next[key] = raw[key]
      // 三处全关就等于把插件藏起来了，host 也拦；这里再兜一层
      if (!next.settings && !next.sidebar && !next.pluginsTab) next.sidebar = true
      return next
    }
    function setPlacement(raw) {
      const next = normalizePlacement(raw)
      const same = PLACEMENT_KEYS.every((key) => placement.value[key] === next[key])
      placement.value = next
      if (same) return
      for (const fn of [...placement.subs]) { try { fn(next) } catch (e) { /* 一个订阅出错不该拖垮别的 */ } }
    }
    function subscribePlacement(fn) {
      placement.subs.add(fn)
      return () => placement.subs.delete(fn)
    }

    // 「社区资源」这一栏开不开：设置里一关，标签要立刻消失，不能等重新拉状态。
    // host 端的 /status 才是权威值，界面上先乐观一次，下次拉状态再对齐。
    const marketVis = { value: true, subs: new Set() }
    function readMarketVisible() { return marketVis.value !== false }
    function setMarketVisible(on) {
      const next = on !== false
      const same = marketVis.value === next
      marketVis.value = next
      if (same) return
      for (const fn of [...marketVis.subs]) { try { fn(next) } catch (e) { /* 一个订阅出错不该拖垮别的 */ } }
    }
    function subscribeMarketVisible(fn) {
      marketVis.subs.add(fn)
      return () => marketVis.subs.delete(fn)
    }

    // 社区资源这一层切页签时会整个卸载：搜索框里的字、分类、页码、已经读到的列表、
    // 打开着的整合包详情，都要留着——回来不该重搜一遍。存在模块里，退出程序前都在。
    // 详情页里每个插件的介绍取自插件市场目录（dsh-plugin-catalog），按名字缓存一份，
    // 同一个插件反复打开详情不必再问一遍。
    const pluginDescCache = new Map()
    function hasPluginDesc(name) {
      return pluginDescCache.has(name)
    }
    function cachedPluginDesc(name) {
      const hit = pluginDescCache.get(name)
      return hit && hit.description ? hit.description : ""
    }
    const marketUi = { value: { kind: "modpack", pack: null, plugin: null } }
    function readMarketUi() {
      return marketUi.value || { kind: "modpack", pack: null, plugin: null }
    }
    function saveMarketUi(slice, next) {
      const cur = readMarketUi()
      marketUi.value = { ...cur, [slice]: { ...(cur[slice] || {}), ...next } }
    }
    function saveMarketKind(kind) {
      marketUi.value = { ...readMarketUi(), kind: kind === "plugin" ? "plugin" : "modpack" }
    }

    // 最近一次确认过的配置：设置页来回切时会重新挂载，只读 props.status 会退回旧值
    // （比如关掉「社区资源」再切回来，开关又亮着）。这里存一份，挂载时并上去。
    const liveCfg = { value: null }
    function mergeLiveConfig(next) {
      if (!next || typeof next !== "object") return
      liveCfg.value = { ...(liveCfg.value || {}), ...next }
    }

    // 打包结果（含下载按钮）放在模块里：切页签、关掉面板都不丢，留到退出程序为止。
    const packStore = { value: null, subs: new Set() }
    function readPackValue() {
      return packStore.value
    }
    function setPackValue(value) {
      const same = (packStore.value || null) === (value || null)
      packStore.value = value || null
      if (same) return
      for (const fn of [...packStore.subs]) { try { fn(packStore.value) } catch (e) { /* 一个订阅出错不该拖垮别的 */ } }
    }
    // 打包页草稿：只活在内存里（页面刷新 / DSH 重启即重置），切页签、换入口不丢
    const packDraft = { value: { selected: null, options: null }, subs: new Set() }
    function readPackDraft() {
      return packDraft.value
    }
    function setPackDraft(patch) {
      packDraft.value = { ...packDraft.value, ...patch }
      for (const fn of [...packDraft.subs]) { try { fn(packDraft.value) } catch (e) { /* 一个订阅出错不该拖垮别的 */ } }
    }

    function subscribePack(fn) {
      packStore.subs.add(fn)
      return () => packStore.subs.delete(fn)
    }

    // 插件市场的 AI 搜索：市场新版本用 POST /dsh-market/ai-search，让「你在 DSH 里配的模型」从目录里挑插件。
    // 我们不重复实现模型调用：旧版市场（或没装）没有这条路由，界面自动退回纯关键词搜索。
    const AI_SEARCH_KEY = "dsh-modpack-kit:ai-search"
    function readAiSearchPref() {
      try { return window.localStorage.getItem(AI_SEARCH_KEY) === "1" } catch (e) { return false }
    }
    function writeAiSearchPref(on) {
      try { window.localStorage.setItem(AI_SEARCH_KEY, on ? "1" : "0") } catch (e) { /* 存不了不影响本场 */ }
    }
    let aiProbe = null
    function marketAiSearchReady() {
      if (!aiProbe) {
        aiProbe = fetch("/dsh-market/ai-search", { method: "GET", credentials: "same-origin" })
          .then((res) => res.status === 405 || res.status === 200)
          .catch(() => false)
      }
      return aiProbe
    }
    async function callMarketAiSearch(query) {
      const res = await fetch("/dsh-market/ai-search", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      })
      let body = null
      try { body = await res.json() } catch (e) { body = null }
      if (!res.ok || !body || !body.result) {
        const error = new Error((body && body.error) || ("AI 搜索没有返回结果（HTTP " + res.status + "）"))
        error.code = (body && body.code) || (res.status === 409 ? "no-model" : "model-failed")
        throw error
      }
      return body.result
    }

    // 已导入的整合包：可以同时留好几份，各自显示名字 / 作者 / 描述，切页签也还在
    const importStore = { value: [], subs: new Set() }
    function readImports() {
      return importStore.value.slice()
    }
    function setImports(next) {
      importStore.value = Array.isArray(next) ? next.slice(0, 8) : []
      for (const fn of [...importStore.subs]) { try { fn(readImports()) } catch (e) { /* 订阅出错不影响别的 */ } }
    }
    function subscribeImports(fn) {
      importStore.subs.add(fn)
      return () => importStore.subs.delete(fn)
    }
    function importEntry(data, fileName) {
      const manifest = (data && data.manifest) || {}
      return {
        token: data.token,
        fileName: fileName || "",
        name: manifest.name || "(未命名整合包)",
        description: manifest.description || "",
        author: manifest.author || "",
        format: manifest.format || "",
        createdAt: manifest.createdAt || "",
        plugins: Array.isArray(manifest.plugins) ? manifest.plugins.length : 0,
        importedAt: new Date().toISOString(),
      }
    }
    function addImport(entry) {
      if (!entry || !entry.token) return
      const rest = importStore.value.filter((item) => item.token !== entry.token)
      setImports([entry, ...rest])
    }
    function removeImport(token) {
      setImports(importStore.value.filter((item) => item.token !== token))
    }

    // 点了「清空进程」：打包页上的旧报错、旧的失败结果也一起收掉，别留着当幽灵
    const clearSignal = { subs: new Set() }
    function fireClear() {
      for (const fn of [...clearSignal.subs]) { try { fn() } catch (e) { /* 一个订阅出错不该拖垮别的 */ } }
    }
    function subscribeClear(fn) {
      clearSignal.subs.add(fn)
      return () => clearSignal.subs.delete(fn)
    }

    async function api(pathname, body) {
      const init = body === undefined ? { headers: { Accept: "application/json" }, credentials: "same-origin" } : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      }
      let res
      try {
        res = await fetch(API + pathname, init)
      } catch (e) {
        throw new Error("连不上 DSH 本体：" + (e && e.message ? e.message : e))
      }
      let data = null
      try { data = await res.json() } catch {
        // 宿主还跑着旧代码时，新接口会返回 404/405 且不是 JSON：把话说清楚，别只丢一句技术错误
        if (res.status === 404 || res.status === 405) {
          throw new Error("这个接口在当前运行的 DSH 里还没加载（HTTP " + res.status + "）：重启一次 DSH 后生效")
        }
        throw new Error("服务端返回了非 JSON（HTTP " + res.status + "）")
      }
      if (!res.ok) {
        // 统一在这里抛：上层只要 try/catch 就能把「为什么失败」显示出来，而不是静默卡住
        const message = (data && (data.error || data.message)) || ("HTTP " + res.status)
        const error = new Error(message)
        error.status = res.status
        error.data = data
        throw error
      }
      return data
    }

    // 插件市场的侧栏入口（/dsh-market/sidebar-entry）：本条开关就是替市场把 enabled 关掉。
    // 市场那一行是它自己的偏好，存在 profile 的 .dsh-market/state.json 里；我们只写这一个键。
    const MARKET_SIDEBAR_ROUTE = "/dsh-market/sidebar-entry"
    async function readMarketSidebar() {
      try {
        const res = await fetch(MARKET_SIDEBAR_ROUTE, { headers: { Accept: "application/json" }, credentials: "same-origin" })
        if (!res.ok) return null
        const data = await res.json()
        return data && typeof data.enabled === "boolean" ? data : null
      } catch (e) { return null }
    }
    async function writeMarketSidebar(enabled) {
      const res = await fetch(MARKET_SIDEBAR_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ enabled: enabled === true }),
      })
      let data = null
      try { data = await res.json() } catch (e) { data = null }
      if (!res.ok) {
        const error = new Error((data && (data.error || data.message)) || ("插件市场拒绝了这次修改（HTTP " + res.status + "）"))
        error.status = res.status
        throw error
      }
      return data
    }

    // 开机把市场的侧栏入口关一次：插件加载时拉 /status 顺带执行，不必等用户点开某一栏。
    let marketSidebarForced = false
    async function enforceMarketSidebarOff() {
      if (marketSidebarForced) return
      const current = await readMarketSidebar()
      if (!current) return
      if (current.enabled !== true) { marketSidebarForced = true; return }
      try { await writeMarketSidebar(false); marketSidebarForced = true } catch (e) { marketSidebarForced = true }
    }

    // 解除卡顿插件（dsh-unlag）：装了才有按钮。只读它的 /state；按一次要带它要的头。
    const UNLAG_STATE_ROUTE = "/dsh-unlag/state"
    async function detectUnlag() {
      try {
        const res = await fetch(UNLAG_STATE_ROUTE, { headers: { Accept: "application/json" }, credentials: "same-origin" })
        if (!res.ok) return null
        const data = await res.json()
        return data && typeof data.version === "string" ? data : null
      } catch (e) { return null }
    }
    async function pressUnlag() {
      const requestId = "modpack-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
      const res = await fetch("/dsh-unlag/reload?requestId=" + encodeURIComponent(requestId), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dsh-unlag": "1" },
        credentials: "same-origin",
        body: JSON.stringify({}),
      })
      let data = null
      try { data = await res.json() } catch (e) { data = null }
      if (!res.ok) {
        const error = new Error((data && (data.status || data.message || data.error)) || ("解除卡顿拒绝了这次请求（HTTP " + res.status + "）"))
        error.status = res.status
        throw error
      }
      return data
    }

    // 宿主有没有原生的目录选择器：有就能点「浏览文件夹…」，没有就退回手填
    let pickDirectoryHost = null

    const arrayBufferToBase64 = (buffer) => {
      const view = new Uint8Array(buffer)
      const chunk = 0x8000
      let text = ""
      for (let i = 0; i < view.length; i += chunk) {
        text += String.fromCharCode.apply(null, view.subarray(i, i + chunk))
      }
      return btoa(text)
    }

    // 把 .dshpack 交给宿主读：先按原始字节 POST，环境不允许时退回 base64 JSON
    async function uploadPackFile(file) {
      if (!file) throw new Error("没有拿到文件")
      if (file.size && file.size > 250 * 1024 * 1024) throw new Error("文件太大（超过 250 MB）")
      let firstError = ""
      try {
        const res = await fetch(API + "/pack/drop", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        })
        const text = await res.text()
        let data = null
        try { data = JSON.parse(text) } catch {}
        if (res.ok && data && data.ok) return data
        firstError = (data && data.error) || ("HTTP " + res.status + (text ? "：" + text.slice(0, 120) : ""))
      } catch (e) {
        firstError = (e && e.message) || String(e)
      }
      // 退回 base64：有些环境不许 POST 二进制，JSON 一定通
      let buffer
      try { buffer = await file.arrayBuffer() } catch (e) { throw new Error("读文件失败：" + ((e && e.message) || e)) }
      let data
      try {
        data = await api("/pack/drop", { name: file.name || "dropped.dshpack", data: arrayBufferToBase64(buffer) })
      } catch (e) {
        throw new Error(((e && e.message) || String(e)) + "（原始字节也没通：" + firstError + "）")
      }
      if (!data || !data.ok) throw new Error((data && data.error) || ("读取失败：" + firstError))
      return data
    }

    const bytes = (n) => {
      const v = Number(n) || 0
      if (v < 1024) return v + " B"
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB"
      return (v / 1024 / 1024).toFixed(2) + " MB"
    }
    const when = (iso) => {
      if (!iso) return "—"
      try { return new Date(iso).toLocaleString() } catch { return String(iso) }
    }

    function Switch(props) {
      return h("label", { title: props.title || undefined, style: { display: "inline-flex", gap: "6px", alignItems: "center", fontSize: "12.5px", cursor: props.disabled ? "not-allowed" : "pointer", opacity: props.disabled ? 0.45 : 1 } },
        h("input", { type: "checkbox", checked: !!props.checked, disabled: !!props.disabled, onChange: (e) => props.onChange(e.target.checked) }),
        props.label)
    }

    // 一句话闪 5 秒：用于「点了也不给关」的开关。
    function useNag(ms = 5000) {
      const [text, setText] = useState("")
      const timer = useRef(null)
      const fire = useCallback((msg) => {
        setText(msg)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setText(""), ms)
      }, [ms])
      useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
      return [text, fire]
    }

    function NagText(props) {
      if (!props.text) return null
      return h("div", { style: { color: "#ff6b6b", fontSize: "12px", lineHeight: "18px" } }, props.text)
    }

    // 强制项：开关照常显示（让人知道这项存在），但点不动——点一次弹红字。
    function ForcedSwitch(props) {
      return h("label", {
        style: { display: "inline-flex", gap: "6px", alignItems: "center", fontSize: "12.5px", cursor: "not-allowed", opacity: 0.6 },
        title: "强制性检查，不能关",
        onClick: (e) => { e.preventDefault(); props.onNag() },
      },
        h("input", { type: "checkbox", checked: true, readOnly: true, disabled: true, style: { cursor: "not-allowed" } }),
        props.label)
    }

    function Tag(props) {
      return h("span", { style: { ...chip, color: props.color || chip.color, borderColor: props.color || "var(--dsw-alias-border-l2)" } }, props.children)
    }

    function Notice(props) {
      return h("div", { style: { ...box, borderColor: props.tone === "warn" ? "#ffb020" : props.tone === "bad" ? "#ff6b6b" : "var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-l2, transparent)", fontSize: "12px", lineHeight: "18px" } }, props.children)
    }

    const ORIGIN_LABEL = { local: "本机", market: "市场", config: "配置", data: "数据", pack: "整合包" }

    // 一整块可以折叠的区域：标题行常驻，点标题或「展开/收起」都行。
    // 默认收起，只有真有问题（高危 / 阻断）才默认摊开。
    // ===== [区块] 通用折叠容器：FoldBox =====
    function FoldBox(props) {
      const [open, setOpen] = useState(props.defaultOpen === true)
      const summary = Array.isArray(props.summary) ? props.summary : [props.summary]
      // 标题行上的操作（比如「清空」）：点它不该顺带把整块展开/收起
      const actions = Array.isArray(props.actions) ? props.actions.filter(Boolean) : []
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", border: "0.5px solid var(--dsw-alias-border-l2)", borderRadius: "8px", padding: "8px 10px" } },
        h("div", { style: { ...row, cursor: "pointer" }, onClick: () => setOpen((prev) => !prev) },
          h("div", { style: strong }, props.title),
          ...summary.filter(Boolean),
          actions.length
            ? h("span", { style: { display: "flex", gap: "6px", alignItems: "center", marginLeft: "auto" }, onClick: (event) => event.stopPropagation() }, ...actions,
              h("span", { style: { ...chipBtn, marginLeft: "6px" } }, open ? "收起" : "展开"))
            : h("span", { style: { ...chipBtn, marginLeft: "auto" } }, open ? "收起" : (props.hint || "展开"))),
        open ? props.children : (props.collapsedNote ? h("div", { style: hint }, props.collapsedNote) : null))
    }

    // ===== [区块] 安全检测报告（可折叠）：ScanReport =====
    function ScanReport(props) {
      const scan = props.scan
      const counts = (scan && scan.counts) || { high: 0, medium: 0, low: 0 }
      const findings = scan && Array.isArray(scan.findings) ? scan.findings : []
      const [openGroup, setOpenGroup] = useState({})
      if (!scan) return null
      const groups = Array.isArray(props.groups) && props.groups.length
        ? props.groups
        : (findings.length ? [{ key: "all", label: "全部命中", origin: "", counts, findings }] : [])
      const toggleGroup = (key) => setOpenGroup((prev) => ({ ...prev, [key]: !prev[key] }))
      return h(FoldBox, {
        title: "安全检测",
        defaultOpen: counts.high > 0,
        summary: [
          h(Tag, { color: counts.high ? "#ff6b6b" : counts.medium ? "#ffb020" : "#2bb673" }, "高 " + counts.high + " · 中 " + counts.medium + " · 低 " + counts.low),
          h("span", { style: hint }, "扫了 " + (scan.scannedFiles || 0) + " 个文件"),
        ],
        hint: findings.length ? "展开（" + findings.length + " 条）" : "没有命中",
        collapsedNote: findings.length ? "共 " + findings.length + " 条命中，点标题展开看位置与掩码。" : "",
      },
        findings.length === 0
          ? h("div", { style: hint }, "没有命中敏感信息或可疑代码规则。")
          : h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
            groups.map((group) => {
              const expanded = openGroup[group.key] === true
              return h("div", { key: group.key, style: { border: "0.5px solid var(--dsw-alias-border-l2)", borderRadius: "6px", overflow: "hidden" } },
                h("div", {
                  style: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 9px", cursor: "pointer", background: "var(--dsw-alias-bg-l2, transparent)" },
                  onClick: () => toggleGroup(group.key),
                },
                  h("span", { style: { ...label, fontSize: "12.5px" } }, group.label),
                  group.origin ? h(Tag, null, ORIGIN_LABEL[group.origin] || group.origin) : null,
                  h("span", { style: hint }, "高 " + group.counts.high + " · 中 " + group.counts.medium + " · 低 " + group.counts.low),
                  h("span", { style: { ...hint, marginLeft: "auto" } }, expanded ? "收起" : "展开")),
                expanded
                  ? h("div", { style: { display: "flex", flexDirection: "column", gap: "3px", padding: "0 9px 8px", maxHeight: "220px", overflow: "auto" } },
                    group.findings.map((f, i) => h("div", { key: i, style: { ...mono, color: LEVEL_COLOR[f.severity] || "inherit" } },
                      "[" + String(f.severity || "").toUpperCase() + "] " + (f.label || f.rule) + " · " + f.file + (f.line ? ":" + f.line : "") + " · " + (f.masked || ""))))
                  : null)
            })),
        h("div", { style: hint }, props.footNote || "命中内容只在内存里比对，报告只保留类型、位置与掩码，原文不落盘。"))
    }

    // ===== [区块] 兼容性列表（可折叠）：CompatList =====
    function CompatList(props) {
      const compat = props.compat
      if (!compat) return null
      const findings = compat.findings || []
      return h(FoldBox, {
        title: "兼容性",
        defaultOpen: compat.blocking === true || findings.some((f) => f.level === "error"),
        summary: h("span", { style: hint }, findings.length ? (compat.summary || "") : "没有发现问题"),
        hint: findings.length ? "展开（" + findings.length + " 条）" : "没有发现",
        collapsedNote: findings.length ? "有 " + findings.length + " 条问题或提醒，点标题展开看建议。" : "",
      },
        findings.length === 0
          ? h("div", { style: hint }, "兼容性：没有发现问题。")
          : findings.map((f, i) => h("div", { key: i, style: { borderLeft: "2px solid " + (LEVEL_COLOR[f.level] || "transparent"), paddingLeft: "8px" } },
            h("div", { style: { ...label, color: LEVEL_COLOR[f.level] || "inherit" } }, (f.plugin ? f.plugin + "：" : "") + f.message),
            f.suggestion ? h("div", { style: hint }, "建议：" + f.suggestion) : null)))
    }

    const JOB_KIND_LABEL = { pack: "打包", install: "安装" }
    const JOB_STATUS_TEXT = { running: "进行中", paused: "等决定", acked: "已确认", done: "完成", failed: "失败", cancelled: "已取消" }

    function useJobs(intervalMs) {
      const [jobs, setJobs] = useState([])
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const res = await fetch(API + "/jobs")
            if (!res.ok) return
            const data = await res.json()
            if (alive && data && Array.isArray(data.jobs)) setJobs(data.jobs)
          } catch { /* 轮询失败不该打断界面，下一次再试 */ }
        }
        load()
        const timer = setInterval(load, intervalMs || 900)
        return () => { alive = false; clearInterval(timer) }
      }, [intervalMs])
      return jobs
    }

    function ProgressBar(props) {
      const pct = Math.max(0, Math.min(100, Math.round(props.pct || 0)))
      return h("div", { style: { height: "6px", borderRadius: "99px", background: "rgba(127,163,245,.18)", overflow: "hidden" } },
        h("div", { style: { width: pct + "%", height: "100%", borderRadius: "99px", transition: "width .25s ease", background: props.tone || "linear-gradient(90deg,#7FA3F5,#4C7DF0)" } }))
    }

    // 进度窗：可以拖，拖过的位置记在浏览器本地；没有任务时自动收起，只留一枚唤出按钮。
    const DOCK_POS_KEY = "dsh-modpack-kit:dock-pos"
    // localStorage 里只存相对坐标（fx/fy，0~1），换窗口大小时按比例还原一次；
    // 界面上的位置一律用像素，并且不存任何「算出来的高度 / 要不要向上长」这类状态。
    function readDockPos() {
      try {
        const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DOCK_POS_KEY) : null
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object") return null
        if (Number.isFinite(Number(parsed.fx)) && Number.isFinite(Number(parsed.fy))) {
          return { fx: Math.max(0, Math.min(1, Number(parsed.fx))), fy: Math.max(0, Math.min(1, Number(parsed.fy))) }
        }
        // 老版本存的是像素：按当前视口折算成相对坐标，迁移一次就够了
        if (Number.isFinite(Number(parsed.x)) && Number.isFinite(Number(parsed.y))) {
          const vp = viewportSize()
          return { fx: Math.max(0, Math.min(1, Number(parsed.x) / vp.width)), fy: Math.max(0, Math.min(1, Number(parsed.y) / vp.height)) }
        }
        return null
      } catch { return null }
    }
    function writeDockPos(pos) {
      try {
        if (typeof localStorage === "undefined" || !pos) return
        const vp = viewportSize()
        localStorage.setItem(DOCK_POS_KEY, JSON.stringify({
          fx: Math.max(0, Math.min(1, Number(pos.x) / vp.width)),
          fy: Math.max(0, Math.min(1, Number(pos.y) / vp.height)),
        }))
      } catch { /* 存不了就算了，不影响本场使用 */ }
    }
    // 召回：把存在浏览器里的位置清掉，回到默认的右下角
    function clearDockPos() {
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(DOCK_POS_KEY)
      } catch { /* 清不掉也没关系，下一次拖动会覆盖 */ }
    }
    // DSH 顶栏 / 标签行大约占这么高：窗口别停在那上面，否则会盖住界面的按钮
    const DOCK_TOP_INSET = 56
    const DOCK_MARGIN = 12            // 离视口边缘至少留这么宽
    const DOCK_MIN_LEFT = 4
    const DOCK_W = 300               // 收起、展开同一个宽度，简单可预期
    const DOCK_OPEN_MAX_H = 420      // 展开时最高这么多，再多就在窗里滚动
    const DOCK_HEAD_H = 44           // 标题行的占位高度：夹边只按它算，展开多高由可用空间决定
    const clampNum = (value, min, max) => Math.max(min, Math.min(value, max))
    // 和布局有关的只有这一件事：把像素位置夹回可见区。
    // 没有「自动判定向上/向下」、也没有自动算高度——拖到哪就是哪，超出才夹回来，默认落右下角。
    function clampDockPos(pos, viewport, size) {
      const vw = Math.max(1, Number(viewport && viewport.width) || 0)
      const vh = Math.max(1, Number(viewport && viewport.height) || 0)
      const w = Math.max(1, Number(size && size.w) || DOCK_W)
      const h = Math.max(1, Number(size && size.h) || 44)
      const x = pos && Number.isFinite(Number(pos.x)) ? Number(pos.x) : vw - w - DOCK_MARGIN
      const y = pos && Number.isFinite(Number(pos.y)) ? Number(pos.y) : vh - h - DOCK_MARGIN
      return {
        x: Math.round(clampNum(x, DOCK_MIN_LEFT, Math.max(DOCK_MIN_LEFT, vw - w - DOCK_MIN_LEFT))),
        y: Math.round(clampNum(y, DOCK_TOP_INSET, Math.max(DOCK_TOP_INSET, vh - h - DOCK_MIN_LEFT))),
      }
    }
    // 存下来的相对坐标 -> 像素（窗口大小变了就按比例落回去）
    function dockFromFractions(saved, viewport) {
      if (!saved) return null
      const vw = Math.max(1, Number(viewport && viewport.width) || 0)
      const vh = Math.max(1, Number(viewport && viewport.height) || 0)
      return { x: clampNum(Number(saved.fx) || 0, 0, 1) * vw, y: clampNum(Number(saved.fy) || 0, 0, 1) * vh }
    }
    // 召回：标签行那个显眼按钮通过它把进度窗叫回默认位置
    const dockReset = { subs: new Set() }
    function requestDockReset() {
      for (const fn of Array.from(dockReset.subs)) { try { fn() } catch { /* 某个订阅坏了不该影响别的 */ } }
    }
    function subscribeDockReset(fn) {
      dockReset.subs.add(fn)
      return () => { dockReset.subs.delete(fn) }
    }
    function viewportSize() {
      const width = typeof window !== "undefined" && Number(window.innerWidth) ? Number(window.innerWidth) : 1280
      const height = typeof window !== "undefined" && Number(window.innerHeight) ? Number(window.innerHeight) : 800
      return { width, height }
    }

    // ===== [区块] 悬浮进度窗（拖动 / 召回 / 终止）：JobDock =====
    function JobDock(props) {
      const given = Array.isArray(props.jobs) ? props.jobs : []
      // 「清空进程」之后，就算服务端还残留一条，也在界面上立刻拿掉
      const [cleared, setCleared] = useState([])
      const jobs = given.filter((job) => !cleared.includes(job.id))
      useEffect(() => {
        setCleared((prev) => (prev.length === 0 ? prev : prev.filter((id) => given.some((job) => job.id === id))))
      }, [given])
      const [pos, setPos] = useState(() => dockFromFractions(readDockPos(), viewportSize()))
      const [pinned, setPinned] = useState(false)     // 手动唤出：没有任务时也显示
      const [hidden, setHidden] = useState(false)     // 手动收起：连进行中的也先藏起来
      const [open, setOpen] = useState(false)
      const [dockMsg, setDockMsg] = useState("")
      const dragRef = useRef(null)
      const boxRef = useRef(null)
      const headerRef = useRef(null)
      const pillRef = useRef(null)
      // 窗口大小变了要重算贴边位置，所以留一个 tick 触发重渲染
      const [, setViewportTick] = useState(0)
      // 标签行的「召回」把窗口叫回右下角默认位置
      useEffect(() => subscribeDockReset(() => {
        // 召回是「兜底入口」：任何一步出错都不能把整个面板带崩，所以逐条 try 住
        try { clearDockPos() } catch { /* 清不掉照样能显示 */ }
        setPos(null)
        setOpen(false)
        setHidden(false)
        setPinned(true)
      }), [])
      const running = jobs.filter((job) => job.status === "running")
      const visible = !hidden && (pinned || running.length > 0)

      // 有任务开跑就自己冒出来（之前手动收起的也一并放出来）
      useEffect(() => {
        if (running.length > 0) { setHidden(false) }
      }, [running.length])

      useEffect(() => {
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined
        const onResize = () => setViewportTick((n) => n + 1)
        window.addEventListener("resize", onResize)
        return () => { window.removeEventListener("resize", onResize) }
      }, [])
      // 最小化的胶囊自己也是一个按钮，所以这一路要放行：不然 pointer 事件会被当成「按在按钮上」直接丢掉。
      const startDrag = (event, element, allowOnButton) => {
        if (!event || typeof event.clientX !== "number") return
        // 按在按钮上就别当拖动：否则指针捕获会把 click 抢走，按钮点不到，
        // 而且抬手时还会顺带把窗口展开/收起（就是「判定重叠」那个毛病）
        if (!allowOnButton && event.target && typeof event.target.closest === "function" && event.target.closest("button")) return
        const el = element || boxRef.current
        const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 }
        dragRef.current = {
          dx: event.clientX - rect.left,
          dy: event.clientY - rect.top,
          width: rect.width,
          height: rect.height,
          startX: rect.left,
          startY: rect.top,
          moved: false,
          last: null,
        }
        if (event.currentTarget && event.currentTarget.setPointerCapture && event.pointerId !== undefined) {
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 某些环境不支持捕获，照样能拖 */ }
        }
      }
      const moveDrag = (event) => {
        const drag = dragRef.current
        if (!drag || !event || typeof event.clientX !== "number") return
        const vp = viewportSize()
        // 就用指针位移 + 起手时的窗口尺寸，别在拖动过程中再引用任何会被自己改掉的布局值
        const size = { w: drag.width || DOCK_W, h: DOCK_HEAD_H }
        const next = clampDockPos({ x: event.clientX - drag.dx, y: event.clientY - drag.dy }, vp, size)
        if (Math.abs(next.x - drag.startX) > 3 || Math.abs(next.y - drag.startY) > 3) drag.moved = true
        drag.last = next
        setPos(next)
      }
      const endDrag = () => {
        const drag = dragRef.current
        if (!drag) return
        dragRef.current = null
        if (drag.moved) {
          if (drag.last) writeDockPos(drag.last)
          return
        }
        // 没拖动就是点了一下标题：展开 / 收起。
        // 不预算任何尺寸与位置：点一下只是开/关，位置永远由 pos + clampDockPos 决定，不会跳。
        setOpen(!open)
      }
      // 胶囊抬手：拖过就记住位置，没拖就是「打开」
      const endPillDrag = () => {
        const drag = dragRef.current
        if (!drag) return
        dragRef.current = null
        if (drag.moved) {
          if (drag.last) writeDockPos(drag.last)
          return
        }
        setPinned(true)
        setHidden(false)
      }

      if (!visible) {
        const vp = viewportSize()
        const pillW = 132
        const pillH = 42
        // 胶囊也用相对坐标现算：换窗口大小它跟着走
        const pillAt = clampDockPos(pos, vp, { w: pillW, h: pillH })
        const pillPos = { left: pillAt.x + "px", top: pillAt.y + "px" }
        const summonStyle = {
          position: "fixed",
          zIndex: 70,
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "7px 11px",
          borderRadius: "999px",
          border: "0.5px solid var(--dsw-alias-border-l2)",
          background: "var(--dsw-alias-surface-1, rgba(24,26,31,.97))",
          color: "var(--dsw-alias-label-primary)",
          boxShadow: "0 6px 18px rgba(0,0,0,.28)",
          cursor: pos ? "grab" : "pointer",
          fontSize: "12px",
          touchAction: "none",
          userSelect: "none",
          ...pillPos,
        }
        const badge = running.length || jobs.length
        return h("button", {
          ref: pillRef,
          style: summonStyle,
          title: pos ? "打开整合包进度窗（按住可以拖到别处）" : "打开整合包进度窗（按住可以拖到别处）",
          onPointerDown: (event) => startDrag(event, pillRef.current, true),
          onPointerMove: moveDrag,
          onPointerUp: endPillDrag,
          onPointerCancel: endPillDrag,
        },
          h("span", { style: { width: "7px", height: "7px", borderRadius: "99px", background: running.length ? "#4C7DF0" : "rgba(127,163,245,.5)" } }),
          "进度",
          badge ? h("span", { style: { ...hint, marginLeft: "0", fontVariantNumeric: "tabular-nums" } }, String(badge)) : null)
      }

      const current = running[0] || jobs[0] || null
      const headText = current
        ? (running.length ? (current.note || "处理中") : (JOB_STATUS_TEXT[current.status] || "打包记录"))
        : "还没有任务"
      const headPct = current ? Math.round(current.status === "done" ? 100 : (current.pct || 0)) : 0
      const stop = async (id) => {
        try { await api("/jobs/cancel", { id }) } catch { /* 已经结束就忽略 */ }
      }
      const ack = async (id) => {
        try { await api("/jobs/ack", { id }) } catch (error) { setDockMsg((error && error.message) || "确认失败") }
      }
      const dismiss = async (id) => {
        try {
          await api("/jobs/dismiss", { id })
          // 删掉一条也算收尾：安装页那条「完成 · 100%」的结论一起收掉
          setCleared((prev) => (prev.includes(id) ? prev : [...prev, id]))
          fireClear()
        } catch (error) { setDockMsg((error && error.message) || "删除失败") }
      }
      const clearDone = async () => {
        // 只看「收尾」的：正在跑的和停在风险点等你决定的，一律留着、照常显示
        const targets = given.filter((job) => job.status !== "running" && job.status !== "paused")
        if (targets.length === 0) {
          setDockMsg("没有可清空的进程（正在跑的和停在风险点的会留着）")
          return
        }
        // 先摘行：服务端慢一点也能立刻看到效果，不用等下一轮轮询
        setCleared((prev) => [...new Set([...prev, ...targets.map((job) => job.id)])])
        fireClear()
        setDockMsg("已清 " + targets.length + " 条")
        try {
          await api("/jobs/clear", {})
          return
        } catch (ignored) { /* 老宿主没有这条路由：退回逐条删 */ }
        let bad = 0
        for (const job of targets) {
          try { await api("/jobs/dismiss", { id: job.id }) } catch (error) { bad += 1 }
        }
        if (bad) setDockMsg("有 " + bad + " 条没删掉（可能还在跑），其余已清")
      }
      // 只要有一条不是「在跑」或「停在风险点」，就给清空入口（状态再怪也算收尾）
      const finished = jobs.filter((job) => job.status !== "running" && job.status !== "paused")

      // 一帧算完全部布局：位置、宽度、高度、向上还是向下，全部来自当前视口 + 量出来的尺寸。
      // 夹边永远只按「标题行 + 固定宽度」算，所以展开不会把窗口顶上去（高度自己缩，位置不动）
      const vp = viewportSize()
      const placed = clampDockPos(pos, vp, { w: DOCK_W, h: DOCK_HEAD_H })
      const dockPos = { left: placed.x + "px", top: placed.y + "px" }
      const openMaxH = Math.max(160, Math.min(DOCK_OPEN_MAX_H, vp.height - placed.y - DOCK_MARGIN))
      return h("div", {
        ref: boxRef,
        style: {
          position: "fixed",
          zIndex: 70,
          ...dockPos,
          width: DOCK_W + "px",
          maxHeight: open ? openMaxH + "px" : "none",
          overflow: "auto",
          boxSizing: "border-box",
          padding: "10px 12px",
          borderRadius: "10px",
          border: "0.5px solid var(--dsw-alias-border-l2)",
          background: "var(--dsw-alias-surface-1, rgba(24,26,31,.97))",
          boxShadow: "0 10px 30px rgba(0,0,0,.35)",
          display: "flex",
          flexDirection: "column",
          gap: "7px",
        },
      },
        h("div", {
          ref: headerRef,
          style: { display: "flex", alignItems: "center", gap: "8px", cursor: "grab", userSelect: "none", touchAction: "none" },
          title: "按住可以拖动；点一下展开或收起",
          onPointerDown: startDrag,
          onPointerMove: moveDrag,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
        },
          h("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, #b6bac3)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, headText),
          h("span", { style: { marginLeft: "auto", fontSize: "12px", fontVariantNumeric: "tabular-nums" } }, headPct + "%"),
          running.length > 1 ? h("span", { style: { ...hint, marginLeft: "0" } }, "+" + (running.length - 1)) : null,
          jobs.length > 0
            ? h("button", {
              type: "button",
              style: { ...chipBtn, marginLeft: "2px", padding: "2px 8px", lineHeight: "18px", flexShrink: 0 },
              title: "清掉所有收尾与失败的进程（跑着的和停在风险点的留着）",
              onPointerDown: (event) => { if (event && event.stopPropagation) event.stopPropagation() },
              onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); clearDone() },
            }, "清空进程")
            : null,
          h("button", {
            type: "button",
            style: { ...chipBtn, marginLeft: "2px", padding: "2px 8px", lineHeight: "18px", flexShrink: 0 },
            title: "收起（有任务时还会再冒出来）",
            onPointerDown: (event) => { if (event && event.stopPropagation) event.stopPropagation() },
            onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); setHidden(true); setPinned(false) },
          }, "收起")),
        current ? h(ProgressBar, { pct: headPct, tone: current.status === "failed" ? "#ff6b6b" : current.status === "cancelled" ? "#8b8f99" : undefined }) : null,
        open
          ? (jobs.length === 0
            ? h("div", { style: hint }, "还没有打包或安装任务。开始一个就会出现在这里。")
            : h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "2px" } },
              jobs.map((job) => h("div", { key: job.id, style: { display: "flex", flexDirection: "column", gap: "4px", paddingTop: "7px", borderTop: "0.5px solid var(--dsw-alias-border-l2)" } },
                h("div", { style: row },
                  h("span", { style: { ...label, fontSize: "12.5px" } }, job.label || JOB_KIND_LABEL[job.kind] || "任务"),
                  h("span", { style: { ...hint, marginLeft: "auto" } }, (JOB_STATUS_TEXT[job.status] || job.status) + " · " + Math.round(job.pct || 0) + "%")),
                h("div", { style: hint }, job.note || ""),
                job.risk && job.status === "paused"
                  ? h("div", { style: { ...hint, color: "#ff9b9b", display: "flex", flexDirection: "column", gap: "2px" } },
                    h("div", null, "检测到风险：高 " + (job.risk.high || 0) + " · 中 " + (job.risk.medium || 0) + " · 低 " + (job.risk.low || 0)),
                    h("div", { style: { fontSize: "10.5px" } }, job.risk.message || ""),
                    job.risk.groups && job.risk.groups.length
                      ? h("div", { style: { fontSize: "10.5px" } },
                        job.risk.groups.map((g) => (g.label || "") + "（高 " + ((g.counts && g.counts.high) || 0) + " / 中 " + ((g.counts && g.counts.medium) || 0) + "）").join("　"))
                      : null)
                  : null,
                h(ProgressBar, { pct: job.pct, tone: job.status === "failed" || job.status === "paused" ? "#ff6b6b" : job.status === "cancelled" ? "#8b8f99" : undefined }),
                h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } },
                  job.status === "running" ? h("button", { style: { ...chipBtn }, onClick: () => stop(job.id) }, "终止") : null,
                  job.status === "done" && job.kind === "pack" && job.data && job.data.token
                    ? h("button", {
                      style: { ...chipBtn, color: "#4C7DF0", borderColor: "#4C7DF0" },
                      title: "跳到打包页的下载部分",
                      onClick: () => { if (typeof props.onOpenResult === "function") props.onOpenResult(job) },
                    }, "下载安装包")
                    : null,
                  job.canAck
                    ? h("button", { style: { ...chipBtn, color: "#ff6b6b", borderColor: "#ff6b6b" }, title: "忽略风险，在同一个任务里接着跑完", onClick: () => ack(job.id) }, "我知道在干什么")
                    : null,
                  job.status !== "running" && job.status !== "paused"
                    ? h("button", { style: { ...chipBtn, color: "var(--dsw-alias-label-tertiary, #8b8f99)" }, title: "从列表里删掉这条记录", onClick: () => dismiss(job.id) }, "删除该进程")
                    : null,
                  job.error && job.status !== "paused" ? h("span", { style: { ...hint, color: "#ff6b6b" } }, job.error) : null)))))
          : h("div", { style: { ...hint, fontSize: "10.5px" } },
            (running.length ? running.length + " 个任务进行中 · " : "") + "按住标题能拖动，点标题展开看详情、也能中途终止"),
        dockMsg
          ? h("div", { style: { ...hint, fontSize: "10.5px", color: "#ff6b6b", display: "flex", gap: "6px", alignItems: "center" } },
            dockMsg,
            h("button", { style: { ...chipBtn, marginLeft: "auto" }, onClick: () => setDockMsg("") }, "知道了"))
          : null)
    }

    // —— 打包 ——
    // ===== [区块] 页签一：打包：PackPanel =====
    // 分类胶囊行：打包页与「社区资源 → 插件」共用，省得两套样式各写一遍。
    function CategoryChips(props) {
      const chips = props.chips || []
      if (chips.length === 0) return null
      return h("div", { style: { ...row, rowGap: "4px", maxHeight: "78px", overflow: "auto" } },
        chips.map((c) => h("button", {
          key: "chip-" + c.id,
          type: "button",
          style: props.value === c.id ? chipOn : chipBtn,
          onClick: () => props.onChange(c.id),
          title: "只看「" + c.label + "」" + (c.count ? "，市场内 " + c.count + " 个" : ""),
        }, c.label + (c.count ? " " + c.count : ""))))
    }

    function PackPanel(props) {
      const status = props.status
      const jobs = Array.isArray(props.jobs) ? props.jobs : []
      const pageSize = (status && status.config && status.config.catalogPageSize) || 20
      const [installed, setInstalled] = useState((status && status.installed) || [])
      const [marketInfo, setMarketInfo] = useState({})   // name -> 市场同名条目（标题/版本/分类）
      const [catalog, setCatalog] = useState((status && status.catalog) || { present: false, categories: [] })
      const [loading, setLoading] = useState(!(status && status.installed))
      const draft = readPackDraft()
      const [selected, setSelected] = useState(() => (draft.selected ? JSON.parse(JSON.stringify(draft.selected)) : {})) // name -> {source, spec, choice}
      const [query, setQuery] = useState("")
      const [category, setCategory] = useState("all")
      const [search, setSearch] = useState({ items: [], total: 0, page: 0, hasMore: false, error: "" })
      const [searching, setSearching] = useState(false)
      const [aiOn, setAiOn] = useState(readAiSearchPref)
      const [aiReady, setAiReady] = useState(null)
      const [aiBusy, setAiBusy] = useState(false)
      const [aiRun, setAiRun] = useState(null)
      const [syncing, setSyncing] = useState("")
      const [options, setOptions] = useState(() => (draft.options ? { ...draft.options } : {
        strategy: "full",
        includeConfig: true,
        scanBeforePack: true,
        confirmLicense: false,
        name: "DSH 整合包",
        description: "",
        author: "",
      }))
      // 三种策略的可选性随所选插件变化（比如只在本机、没有 semver 版本的插件选不了轻量包）
      const [plan, setPlan] = useState(null)
      const [planError, setPlanError] = useState("")
      useEffect(() => {
        const names = Object.keys(selected)
        setPlanError("")
        if (names.length === 0) { setPlan(null); return undefined }
        let alive = true
        api("/pack/plan", { selection: names.map((name) => selected[name]) })
          .then((data) => {
            if (!alive) return
            if (data && data.ok && Array.isArray(data.strategies)) setPlan(data.strategies)
            else { setPlan(null); setPlanError((data && data.error) || "服务端没给出判定") }
          })
          .catch((error) => {
            if (!alive) return
            setPlan(null)
            setPlanError((error && error.message) || String(error))
          })
        return () => { alive = false }
      }, [selected])
      const planEntries = Array.isArray(plan) ? plan : []
      const strategyLabel = (id) => {
        const found = (planEntries.length ? planEntries : STRATEGY_INFO).find((entry) => entry.id === id)
        return found ? found.title : id
      }
      // 先选了一个策略、之后又勾了让它不可用的插件：这里提示并挡住打包，而不是悄悄替你换
      const currentBlocked = (() => {
        if (!planEntries.length) return null
        const found = planEntries.find((entry) => entry.id === options.strategy)
        return found && found.ok === false ? found : null
      })()
      // 草稿只活在内存里：切页签不丢，刷新/重启 DSH 回到默认
      useEffect(() => { setPackDraft({ selected }) }, [selected])
      useEffect(() => { setPackDraft({ options }) }, [options])
      const [busy, setBusy] = useState("")
      // 结果由 Home 保管（模块级缓存），切页签回来仍然在
      const result = props.result === undefined ? null : props.result
      const setResult = typeof props.setResult === "function" ? props.setResult : () => {}
      const [started, setStarted] = useState("")
      const [seenJobs, setSeenJobs] = useState({})
      const [mountAt] = useState(() => Date.now())
      const [error, setError] = useState("")
      const [packNag, firePackNag] = useNag()
      const resultRef = useRef(null)

      const active = query.trim() !== "" || category !== "all"

      // 首屏只读「已装 + 目录摘要 + 每条的相机市场信息」，不整份下发目录
      useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const st = status && status.installed ? status : await api("/status")
            if (!alive) return
            const list = (st && st.installed) || []
            setInstalled(list)
            setCatalog((st && st.catalog) || { present: false, categories: [] })
            if (st && st.placements) setPlacement(st.placements)
            if (list.length) {
              const look = await api("/catalog/lookup", { names: list.map((p) => p.name) })
              if (alive && look && look.ok) setMarketInfo(look.items || {})
            }
          } catch (e) {
            if (alive) setError(e.message || String(e))
          } finally {
            if (alive) setLoading(false)
          }
        })()
        return () => { alive = false }
      }, [])

      // 搜索/选分类才查市场目录；服务端分页，一次一页，输入停 220ms 再发
      useEffect(() => {
        if (!active) { setSearch({ items: [], total: 0, page: 0, hasMore: false, error: "" }); return }
        let alive = true
        const timer = setTimeout(async () => {
          setSearching(true)
          try {
            const data = await api("/catalog/search", { query, category, page: 1, pageSize })
            if (!alive) return
            setSearch({
              items: data.items || [],
              total: data.total || 0,
              page: data.page || 1,
              hasMore: !!data.hasMore,
              error: data.error || "",
            })
          } catch (e) {
            if (alive) setSearch({ items: [], total: 0, page: 0, hasMore: false, error: e.message || String(e) })
          } finally {
            if (alive) setSearching(false)
          }
        }, 220)
        return () => { alive = false; clearTimeout(timer) }
      }, [query, category, active, pageSize])

      // AI 搜索：开着才探一次路由（旧版插件市场没有这条，就不显示开关）
      useEffect(() => {
        let alive = true
        marketAiSearchReady().then((ok) => { if (alive) setAiReady(ok) })
        return () => { alive = false }
      }, [])

      // 只在按回车或点「AI 来找」时调用：花的是主人自己的 token
      const runAi = async () => {
        const text = query.trim()
        if (!text || aiBusy) return
        setAiBusy(true)
        setAiRun(null)
        try {
          const result = await callMarketAiSearch(text)
          const picks = (Array.isArray(result.picks) ? result.picks : []).filter((item) => item && item.name)
          setAiRun({ query: text, intro: result.intro || "", model: result.model || "", picks, error: "", code: "" })
          if (picks.length) {
            try {
              const look = await api("/catalog/lookup", { names: picks.map((item) => item.name) })
              if (look && look.ok) setMarketInfo((prev) => ({ ...prev, ...(look.items || {}) }))
            } catch (e) { /* 版本信息补不上不影响结果 */ }
          }
        } catch (e) {
          setAiRun({ query: text, intro: "", model: "", picks: [], error: e.message || String(e), code: e.code || "" })
        } finally {
          setAiBusy(false)
        }
      }
      const toggleAi = () => {
        const next = !aiOn
        setAiOn(next)
        writeAiSearchPref(next)
        if (!next) setAiRun(null)
      }

      const loadMore = async () => {
        if (searching || !search.hasMore) return
        setSearching(true)
        try {
          const data = await api("/catalog/search", { query, category, page: (search.page || 1) + 1, pageSize })
          setSearch((prev) => ({
            ...prev,
            items: prev.items.concat(data.items || []),
            page: data.page || prev.page,
            hasMore: !!data.hasMore,
            total: data.total || prev.total,
          }))
        } catch (e) {
          setSearch((prev) => ({ ...prev, error: e.message || String(e) }))
        } finally {
          setSearching(false)
        }
      }

      const buildCatalog = async () => {
        setSyncing("正在从插件市场取目录（5~30 秒，看网络）…")
        try {
          const data = await api("/catalog/sync", { force: true })
          if (data && data.ok) {
            setCatalog((data.catalog) || { present: true })
            setSyncing("目录就绪：" + (data.count || 0) + " 条" + (data.skipped ? "（本来就有）" : ""))
          } else {
            setSyncing((data && data.error) || "目录没取到，稍后再试")
          }
        } catch (e) {
          setSyncing(String((e && e.message) || e))
        }
      }

      const localRows = useMemo(() => installed.map((p) => {
        const m = marketInfo[p.name] || {}
        return {
          name: p.name,
          version: p.version,
          title: m.title || p.name,
          description: m.description || p.description || "",
          category: m.category || p.category || "other",
          marketVersion: m.version || "",
          hasMarket: Boolean(m.version),
          source: "profile",
        }
      }), [installed, marketInfo])

      const rows = active ? search.items : localRows
      const chips = useMemo(() => {
        const list = (catalog && Array.isArray(catalog.categories)) ? catalog.categories : []
        return [{ id: "all", label: "全部", count: (catalog && catalog.count) || 0 }].concat(list.map((c) => ({ id: c.id, label: c.label, count: c.count || 0 })))
      }, [catalog])
      const labelOf = (id) => {
        const hit = chips.find((c) => c.id === id)
        return (hit && hit.label) || CATEGORY_LABELS[id] || id
      }

      const picked = Object.keys(selected)
      // 市场里没装的插件也能打包：走 npm 源（安装时由市场按版本取包）
      // 本机已装、但市场里有同名条目的，默认也走市场版：避免把本地开发版打进包、装到别人机器上
      const entrySource = (entry) => (entry.installed === false || entry.hasMarket ? "npm" : "profile")
      const entrySpec = (entry) => (entry.hasMarket ? entry.marketVersion || entry.version || "" : entry.version || "")
      const toggle = (entry) => {
        setSelected((prev) => {
          const next = { ...prev }
          if (next[entry.name]) delete next[entry.name]
          else next[entry.name] = {
            name: entry.name,
            source: entrySource(entry),
            spec: entrySpec(entry),
            choice: "preset",
          }
          return next
        })
      }
      const setSpec = (name, spec) => setSelected((prev) => ({ ...prev, [name]: { ...prev[name], spec } }))
      const setChoice = (name, choice) => setSelected((prev) => ({ ...prev, [name]: { ...prev[name], choice } }))
      // 同名市场版：装出来是上游原版代码 + 插件默认配置
      const switchMarket = (entry, toMarket) => setSelected((prev) => {
        if (!prev[entry.name]) return prev
        return {
          ...prev,
          [entry.name]: toMarket
            ? { name: entry.name, source: "npm", spec: entry.marketVersion || "", choice: "preset" }
            : { name: entry.name, source: "profile", spec: entry.version || "", choice: "preset" },
        }
      })

      const addAllLocal = () => setSelected((prev) => {
        const next = { ...prev }
        for (const entry of localRows) {
          if (!next[entry.name]) next[entry.name] = { name: entry.name, source: entrySource(entry), spec: entrySpec(entry), choice: "preset", group: section.name }
        }
        return next
      })
      const clearSelected = () => setSelected({})

      const groupInfo = (props.status && Array.isArray(props.status.groups)) ? props.status.groups : []
      const [folded, setFolded] = useState({})
      const sections = useMemo(() => {
        if (groupInfo.length === 0) return []
        const byName = new Map(localRows.map((entry) => [entry.name, entry]))
        const used = new Set()
        const out = []
        for (const group of groupInfo) {
          const entries = (group.members || []).map((name) => byName.get(name)).filter(Boolean)
          for (const entry of entries) used.add(entry.name)
          if (entries.length === 0) continue
          out.push({ key: "group:" + group.name, name: group.name, entries, missing: group.missing || [] })
        }
        const rest = localRows.filter((entry) => !used.has(entry.name))
        if (rest.length > 0) out.push({ key: "group:__rest", name: "未分组", entries: rest, missing: [] })
        return out
      }, [localRows, groupInfo])
      const addGroup = (section) => setSelected((prev) => {
        const next = { ...prev }
        for (const entry of section.entries) {
          if (!next[entry.name]) next[entry.name] = { name: entry.name, source: entrySource(entry), spec: entrySpec(entry), choice: "preset" }
        }
        return next
      })
      const removeGroup = (section) => setSelected((prev) => {
        const next = { ...prev }
        for (const entry of section.entries) delete next[entry.name]
        return next
      })
      const renderOne = (entry) => {
              const on = Boolean(selected[entry.name])
              const chosenSource = on ? selected[entry.name].source : (entry.installed === false ? "npm" : "profile")
              const sourceText = on ? (chosenSource === "npm" ? "市场版" : "本机版") : (entry.installed === false ? "市场未装" : "已装")
              const sourceStyle = on
                ? { ...chip, minWidth: "58px", textAlign: "center", fontWeight: 600, color: "var(--dsw-alias-label-primary)", borderColor: "var(--dsw-alias-border-l2)" }
                : { ...chip, minWidth: "58px", textAlign: "center", color: "var(--dsw-alias-label-tertiary)" }
              return h("div", { key: entry.name, style: { display: "flex", gap: "8px", alignItems: "center", padding: "5px 2px", borderTop: "0.5px solid var(--dsw-alias-border-l2)", flexWrap: "wrap" } },
                h("span", {
                  style: sourceStyle,
                  title: on
                    ? (chosenSource === "npm" ? "当前选的是插件市场版：按上游版本取包，装出来和从市场装一样" : "当前选的是本机版：代码、配置条目与数据快照都取本机这份")
                    : "还没勾选；勾上后默认按" + (entry.installed === false ? "市场版" : (entry.hasMarket ? "市场版" : "本机版")) + "打包",
                }, sourceText),
                h("input", { type: "checkbox", checked: on, onChange: () => toggle(entry) }),
                h("div", { style: { flex: "1 1 220px", minWidth: "180px" } },
                  h("div", { style: label }, entry.title || entry.name, " ", h("span", { style: hint }, "@" + (entry.version || "?"))),
                  h("div", { style: hint }, (entry.description || "").slice(0, 110))),
                h("span", { style: { ...chip, color: "var(--dsw-alias-label-tertiary)" } }, labelOf(categoryOf(entry))),
                entry.updateAvailable ? h(Tag, { color: "#2bb673" }, "市场版 " + (entry.marketVersion || entry.version) + " 更新") : null,
                on ? h("span", { style: { ...chip, color: "var(--dsw-alias-label-secondary)", fontWeight: 600 } },
                  "版本 " + (selected[entry.name].source === "npm"
                    ? (entry.marketVersion || (selected[entry.name].spec || "").replace(/^[^@]+@/u, "") || entry.version || "最新")
                    : (entry.version || "本机"))) : null,
                on ? h("div", { style: { display: "flex", gap: "4px" } },
                  h("button", { style: selected[entry.name].choice !== "custom" ? chipOn : chipBtn, onClick: () => setChoice(entry.name, "preset"), title: "只打插件默认配置：不带本机的配置与数据快照（代码按所选来源）" }, "插件预设"),
                  h("button", { style: selected[entry.name].choice === "custom" ? chipOn : chipBtn, onClick: () => setChoice(entry.name, "custom"), title: "带上本机这份插件的配置与数据快照；本机来源的连代码改动一起打" }, "自定义配置")) : null,
                entry.hasMarket && entry.source === "profile" && on ? h("button", {
                  style: { ...chipBtn, border: "none", fontSize: "10.5px", color: "var(--dsw-alias-label-tertiary)" },
                  onClick: () => switchMarket(entry, selected[entry.name].source !== "npm"),
                  title: "改用插件市场发的同名版本（上游原版代码 + 默认配置），装出来和从市场装一样",
                }, selected[entry.name].source === "npm" ? "改为本机版" : "改为市场版") : null)}

      const renderList = () => {
        if (active || sections.length === 0) return rows.map(renderOne)
        const out = []
        for (const section of sections) {
          const onCount = section.entries.filter((entry) => Boolean(selected[entry.name])).length
          const isFolded = folded[section.name] === true
          out.push(h("div", {
            key: section.key,
            style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", padding: "7px 2px", borderTop: "0.5px solid var(--dsw-alias-border-l2)" },
          },
          h("button", {
            style: { ...chipBtn, border: "none", padding: "0 4px", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
            onClick: () => setFolded((prev) => ({ ...prev, [section.name]: !isFolded })),
            title: isFolded ? "展开「" + section.name + "」" : "收起「" + section.name + "」",
          }, isFolded ? "▸" : "▾"),
          h("div", { style: { flex: "1 1 200px", minWidth: "160px" } },
            h("div", { style: label }, section.name, " ", h("span", { style: hint }, section.entries.length + " 个" + (onCount > 0 ? " · 已选 " + onCount : ""))),
            section.missing.length > 0 ? h("div", { style: hint }, "有 " + section.missing.length + " 个成员已不在本机") : null),
          h("button", { style: btn, onClick: () => addGroup(section), title: "把这一组的插件都加入选择（默认插件预设，可逐个改）" }, "一键加入"),
          onCount > 0 ? h("button", { style: btn, onClick: () => removeGroup(section) }, "清空本组") : null))
          if (!isFolded) for (const entry of section.entries) out.push(renderOne(entry))
        }
        return out
      }

      const [jobMsg, setJobMsg] = useState("")
      const pausedJobs = (props.jobs || []).filter((job) => job.kind === "pack" && job.status === "paused" && job.risk)

      const ackJob = async (id) => {
        setJobMsg("")
        try {
          const data = await api("/jobs/ack", { id })
          if (!data || !data.ok) setJobMsg((data && data.error) || "确认失败")
        } catch (e) { setJobMsg(String((e && e.message) || e)) }
      }
      // 停在风险点的任务：按插件分栏列出命中项，确认/删除都在这里做
      const pausedRiskNodes = []
      if (pausedJobs.length > 0) {
        pausedRiskNodes.push(h("div", { key: "title", style: { ...strong, color: "#ff6b6b" } }, `打包停在风险点（${pausedJobs.length} 个任务）`))
        pausedRiskNodes.push(h("div", { key: "hint", style: hint }, "下面是每个插件自己的命中项。确认后原任务从这个检测点接着跑完，不再重复检测。"))
        for (const job of pausedJobs) {
          const groupNodes = (job.risk.groups || []).map((group, index) => {
            const sampleNodes = (group.samples || []).map((sample, i) => h("div", {
              key: i,
              style: { color: LEVEL_COLOR[sample.severity] || "inherit" },
            }, "· " + (sample.label || "") + "　" + (sample.file || "") + (sample.line ? ":" + sample.line : "")))
            return h("div", {
              key: index,
              style: { ...box, padding: "8px 10px", background: "transparent", display: "flex", flexDirection: "column", gap: "4px" },
            },
            h("div", { style: row },
              h(Tag, null, group.plugin || group.label),
              h("span", { style: hint }, ORIGIN_LABEL[group.origin] || group.origin || ""),
              h("span", { style: hint }, "高 " + ((group.counts && group.counts.high) || 0) + " · 中 " + ((group.counts && group.counts.medium) || 0) + " · 低 " + ((group.counts && group.counts.low) || 0))),
            sampleNodes.length > 0
              ? h("div", { style: { ...mono, display: "flex", flexDirection: "column", gap: "2px" } }, sampleNodes)
              : h("div", { style: hint }, "命中详情写进了包内 security/report.txt。"))
          })
          pausedRiskNodes.push(h("div", { key: job.id, style: { display: "flex", flexDirection: "column", gap: "6px" } },
            h("div", { style: { ...row, justifyContent: "space-between" } },
              h("div", { style: strong }, job.label || "打包任务"),
              h("div", { style: row },
                h("button", { style: { ...btn, borderColor: "#ff6b6b", color: "#ff6b6b" }, onClick: () => ackJob(job.id) }, "我知道在干什么"),
                h("button", { style: btn, onClick: () => dismissJob(job.id) }, "删除该进程"))),
            groupNodes))
        }
        pausedRiskNodes.push(h("div", { key: "msg", style: hint }, jobMsg))
      }

      const dismissJob = async (id) => {
        setJobMsg("")
        try {
          const data = await api("/jobs/dismiss", { id })
          if (!data || !data.ok) setJobMsg((data && data.error) || "删除失败")
        } catch (e) { setJobMsg(String((e && e.message) || e)) }
      }

      const doPack = async (ack) => {
        setError(""); setStarted(""); setBusy("start")
        try {
          const data = await api("/pack", {
            async: true,
            selection: picked.map((name) => selected[name]),
            options: {
              strategy: options.strategy,
              includeConfig: options.includeConfig,
              acknowledge: ack === true,
              force: false,
              confirmLicense: options.confirmLicense,
              name: options.name,
              description: options.description,
              author: options.author,
            },
          })
          if (!data) { setError("没有响应"); return }
          if (!data.ok) { setError(data.error || "打包请求被拒绝"); return }
          setStarted((data.job && data.job.label) || "打包任务")
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally { setBusy("") }
      }

      // 后台任务完成后，把结果搬回这一页（可以同时打好几个包）
      useEffect(() => {
        const finished = (props.jobs || []).filter((job) => job.kind === "pack" && job.status !== "running" && job.data && Date.parse(job.startedAt) >= mountAt)
        const fresh = finished.filter((job) => !seenJobs[job.id])
        if (fresh.length === 0) return
        const nextSeen = { ...seenJobs }
        for (const job of fresh) nextSeen[job.id] = true
        setSeenJobs(nextSeen)
        const payload = fresh[fresh.length - 1].data
        if (payload && payload.ok) setResult(payload)
        else if (payload && payload.refused) setResult({ refused: true, needsAck: payload.needsAck === true, trustedOnly: payload.trustedOnly === true, error: payload.error, scan: payload.scan, scanGroups: payload.scanGroups })
        else if (payload && payload.cancelled) { setResult(null); setError(payload.error || "已取消") }
        else { setResult(null); setError((payload && payload.error) || "打包失败，详情见左下角") }
      }, [props.jobs])

      // 从进度窗点「下载安装包」跳过来：滚到结果那一块
      useEffect(() => {
        if (!props.focus) return
        const el = resultRef.current
        if (el && typeof el.scrollIntoView === "function") {
          try { el.scrollIntoView({ block: "start", behavior: "smooth" }) } catch { /* 老浏览器不支持行为参数，忽略 */ }
        }
      }, [props.focus])

      // 「清空进程」之后，打包页上的旧报错与失败结果也一起收掉
      useEffect(() => subscribeClear(() => {
        setError("")
        const current = props.result
        if (current && (current.refused || current.error)) setResult(null)
      }), [props.result])

      const downloadPack = async () => {
        if (!result || !result.token) return
        setBusy("download")
        try {
          const res = await fetch(API + "/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: result.token, fileName: result.fileName }) })
          if (!res.ok) { setError("下载失败（" + res.status + "）"); return }
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const a = document.createElement("a")
          a.href = url
          a.download = result.fileName || "pack.dshpack"
          document.body.appendChild(a)
          a.click()
          setTimeout(() => { try { a.remove(); URL.revokeObjectURL(url) } catch {} }, 4000)
        } catch (e) {
          setError("下载失败：" + (e && e.message ? e.message : e))
        } finally { setBusy("") }
      }

      const savePack = async () => {
        if (!result || !result.token) return
        setBusy("save")
        try {
          const data = await api("/save", { token: result.token, fileName: result.fileName })
          if (data && data.ok) setResult({ ...result, savedPath: data.path })
          else setError((data && data.error) || "保存失败")
        } catch (e) {
          setError(e.message || String(e))
        } finally { setBusy("") }
      }

      const strategyNotice = currentBlocked
        ? h(Notice, { tone: "warn" },
          h("b", null, "当前选的「" + strategyLabel(options.strategy) + "」现在不适用："),
          currentBlocked.reason || "",
          h("div", { style: { ...row, marginTop: "6px" } },
            ...planEntries
              .filter((entry) => entry.ok !== false && entry.id !== options.strategy)
              .map((entry) => h("button", {
                key: entry.id,
                type: "button",
                style: chipBtn,
                onClick: () => setOptions({ ...options, strategy: entry.id }),
              }, "换成" + entry.title)),
          ))
        : null
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
        h(Notice, null,
          h("b", null, "打包：将所选插件封装为一个 .dshpack 文件"),
          "　三种策略：完整包自带插件本体、不联网也能装；轻量包只记版本、体积最小；混合包带版本与配置片段、体积接近轻量包。完整包与混合包在安装前均不允许修改 profile 内容。",
          status && status.market && status.market.installed
            ? h("div", { style: { ...hint, marginTop: "6px" } }, "已检测到插件市场 v" + status.market.version + "：本插件与其共用目录源与安装链路，但不依赖该插件，移除后打包与安装功能不受影响。")
            : h("div", { style: { ...hint, marginTop: "6px" } }, "未检测到插件市场，功能不受影响：打包、安装与检测均在本地完成。建议先安装 dshmarket 以获得分类、搜索与「切换市场版」入口；未安装时，首次使用请点击「建立目录索引」。"),
          h("div", { style: hint }, "目录中存在同名插件时，该条目末尾提供「（切换市场版）」入口：可将打包源切换为上架市场的上游原版，安装结果与从市场安装一致。")),
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "10px" } },
          h("div", { style: row },
            h("div", { style: strong }, "选择插件"),
            h("input", {
              style: { ...input, flex: "1 1 200px" },
              placeholder: aiOn && aiReady ? "用一句话描述你要的插件（回车让 AI 在目录里挑）" : "搜索插件名 / 描述（在插件市场目录里搜）",
              value: query,
              onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter" && aiOn && aiReady) { e.preventDefault(); runAi() } },
            }),
            aiReady === true ? h("button", { style: aiOn ? chipOn : btn, onClick: toggleAi, title: "只调用插件市场提供的 AI 搜索接口：真正花的是你在「设置 → 模型」里配的那把 Key——请求由市场发出、扣你的额度，本插件既不读也不存 Key，只发这一次请求" }, aiOn ? "AI 搜索：开" : "AI 搜索：关") : null,
            aiOn && aiReady ? h("button", { style: btn, disabled: aiBusy || query.trim() === "", onClick: runAi }, aiBusy ? "AI 正在挑…" : "AI 来找") : null,
            aiOn && aiReady ? h("div", { style: { ...hint, width: "100%" } }, "AI 搜索的 token 消耗记在插件市场那边：它拿你在「设置 → 模型」里配的模型去问，本插件只把问题转过去、把结果拿回来，不读也不存你的 Key。") : null,
            active ? h("button", { style: btn, onClick: () => { setQuery(""); setCategory("all") } }, "回到已装") : null,
            h("button", { style: btn, onClick: addAllLocal, title: "把本机已装的全部插件加入选择（默认插件预设，可逐个改成自定义配置）" }, "全部加入"),
            h("button", { style: btn, disabled: picked.length === 0, onClick: clearSelected, title: "清空当前选择" }, "清除选择"),
            h("span", { style: hint }, loading ? "读取中…" : active
              ? ("已选 " + picked.length + " · 匹配 " + search.total + " 条" + (searching ? " · 搜索中…" : "") + (search.total > rows.length ? " · 已加载 " + rows.length : ""))
              : ("已选 " + picked.length + " 个 · 本机已装 " + localRows.length + " 个"))),
          !catalog.present
            ? h("div", { style: row },
              h("span", { style: hint }, "还没有插件市场目录——分类和搜索要靠它。"),
              h("button", { style: btn, disabled: !!syncing, onClick: buildCatalog }, syncing || "建立目录索引（5~30 秒）"))
            : null,
          catalog.present && syncing ? h("div", { style: hint }, syncing) : null,
          catalog.present ? h(CategoryChips, { chips, value: category, onChange: setCategory }) : null,
          aiReady === false ? h("div", { style: hint }, "当前装的插件市场没有 AI 搜索（旧版本或未安装）：这里只做关键词搜索。装新版 dshmarket 后开关会自动出现。") : null,
          aiRun ? h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "6px", borderColor: aiRun.error ? "#ff6b6b" : "var(--dsw-alias-border-l2)" } },
            h("div", { style: row },
              h("div", { style: strong }, aiRun.error ? "AI 搜索没成功" : "AI 挑的插件"),
              h("span", { style: hint }, aiRun.model ? "模型：" + aiRun.model : ""),
              h("button", { style: btn, onClick: () => setAiRun(null) }, "收起")),
            aiRun.error ? h("div", { style: { ...hint, color: "#ff6b6b" } }, aiRun.error + (aiRun.code === "no-model" ? "　先在「设置 → 模型」里配一个模型再试。" : "")) : null,
            aiRun.intro ? h("div", { style: hint }, aiRun.intro) : null,
            aiRun.picks.length === 0 && !aiRun.error ? h("div", { style: hint }, "这次没挑出合适的插件，换个说法再试。") : null,
            aiRun.picks.map((item) => {
              const meta = marketInfo[item.name] || {}
              const on = Boolean(selected[item.name])
              const entry = { name: item.name, installed: false, hasMarket: true, marketVersion: meta.version || "", version: meta.version || "" }
              return h("div", { key: item.name, style: { display: "flex", gap: "8px", alignItems: "flex-start", padding: "6px 2px", borderTop: "0.5px solid var(--dsw-alias-border-l2)" } },
                h("input", { type: "checkbox", checked: on, onChange: () => toggle(entry), style: { marginTop: "3px" } }),
                h("div", { style: { flex: "1 1 auto", minWidth: 0 } },
                  h("div", { style: { ...strong, fontSize: "12.5px" } }, item.name + (meta.version ? " · v" + meta.version : "")),
                  h("div", { style: hint }, item.description || ""),
                  item.why ? h("div", { style: { ...hint, color: "var(--dsw-alias-label-tertiary, #8b8f99)" } }, "为什么：" + item.why) : null))
            })) : null,
          search.error ? h("div", { style: { ...hint, color: "#ffb020" } }, search.error) : null,
          h("div", { style: { display: "flex", flexDirection: "column", gap: "3px", maxHeight: "320px", overflow: "auto" } },
            rows.length === 0
              ? h("div", { style: hint }, loading ? "读取中…" : active ? (searching ? "搜索中…" : "无匹配条目") : "本机尚未安装插件")
              : renderList()),
          active && search.hasMore ? h("div", { style: row },
            h("button", { style: btn, disabled: searching, onClick: loadMore }, searching ? "加载中…" : ("加载更多（还有 " + Math.max(0, search.total - rows.length) + " 条）"))) : null,
          h("div", { style: hint }, active
            ? "排序：已装的排前面，其余按插件市场的相关度与目录顺序。分类和词条都来自插件市场目录。"
            : "首屏只列本机已装。插件自带的内部组件（随父包一起装的那种）不单独列出" + (props.status && props.status.installedHidden ? "（本次隐藏 " + props.status.installedHidden + " 个）" : "") + "。每行最前面标出当前来源：市场版按上游版本取包，本机版取本机这份。勾选时默认「插件预设」——只打插件默认配置；要带上本机的配置条目与数据快照就改成「自定义配置」（本机版还会连代码改动一起打）。本机已装且市场里有同名条目的，默认按市场版勾选；要打本机这份就点行末「改为本机版」。搜索或点分类才去插件市场目录里查，服务端分页、一次一页。搜索结果里没装的插件也能直接勾选——打包时按版本从插件市场取包，装的时候同样从市场下载。")
        ),
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "8px" } },
          h("div", { style: strong }, "打包策略（必选）"),
          h("div", { style: hint }, "三选一，可不可选按你勾的插件实时判定：灰掉的那张整块变灰，点一下会弹出原因。安全检测在服务端强制进行，不提供关闭；版本号不能手改，只显示所选来源的版本。"),
          h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
            (planEntries.length ? planEntries : STRATEGY_INFO.map((item) => ({ ...item, ok: true }))).map((item) => {
              const disabled = item.ok === false
              const chosen = options.strategy === item.id
              const muted = disabled ? "var(--dsw-alias-label-tertiary, #8b8f99)" : "var(--dsw-alias-label-secondary)"
              return h("div", {
                key: item.id,
                role: "button",
                tabIndex: 0,
                "aria-disabled": disabled ? "true" : "false",
                style: {
                  flex: "1 1 210px", minWidth: "190px", padding: "9px 10px", borderRadius: "8px",
                  cursor: disabled ? "not-allowed" : "pointer",
                  border: "1px solid " + (chosen && !disabled ? "#4C7DF0" : "var(--dsw-alias-border-l2)"),
                  borderStyle: disabled ? "dashed" : "solid",
                  background: chosen && !disabled ? "rgba(76,125,240,0.08)" : "transparent",
                  opacity: disabled ? 0.7 : 1,
                },
                onClick: () => {
                  if (disabled) { firePackNag(item.reason || "这个策略现在不能选"); return }
                  setOptions({ ...options, strategy: item.id })
                },
                onKeyDown: (event) => {
                  if (event.key !== "Enter" && event.key !== " ") return
                  event.preventDefault()
                  if (disabled) { firePackNag(item.reason || "这个策略现在不能选"); return }
                  setOptions({ ...options, strategy: item.id })
                },
                title: disabled ? (item.reason || "") : (item.online ? "安装时需要联网" : "不联网也能装"),
              },
                h("div", { style: { display: "flex", gap: "6px", alignItems: "baseline", color: disabled ? muted : "var(--dsw-alias-label-primary)" } },
                  h("span", { style: { fontWeight: 600 } }, item.title),
                  h("span", { style: { fontSize: "11px", color: muted } }, item.online ? "需联网" : "不联网"),
                  disabled ? h("span", { style: { ...chip, marginLeft: "auto", color: muted, cursor: "pointer" } }, "不可选") : null),
                h("div", { style: { marginTop: "4px", lineHeight: 1.45, fontSize: "12px", color: muted } },
                  disabled ? (item.reason || "这个策略现在不能选") : (item.note || "")))
            })),
          strategyNotice,
          planEntries.length === 0 && picked.length > 0 ? h("div", { style: hint }, "正在判定…") : null,
          planError ? h("div", { style: hint }, "策略判定失败（打包时会再判一次）：" + planError) : null,
          h(NagText, { text: packNag }),
          h("div", { style: { ...row, rowGap: "6px" } },
            h("input", { style: { ...input, flex: "1 1 200px" }, placeholder: "整合包名", value: options.name, onChange: (e) => setOptions({ ...options, name: e.target.value }) }),
            h("input", { style: { ...input, flex: "1 1 160px" }, placeholder: "作者（可空）", value: options.author, onChange: (e) => setOptions({ ...options, author: e.target.value }) })),
          h("input", { style: { ...input, width: "100%" }, placeholder: "一句话描述（可空）", value: options.description, onChange: (e) => setOptions({ ...options, description: e.target.value }) }),
          h(Switch, { checked: options.confirmLicense, label: "我确认所选插件的许可证允许再分发，或已获得作者授权", onChange: (v) => setOptions({ ...options, confirmLicense: v }) }),
          h("div", { style: row },
            h("button", { style: btnPrimary, disabled: picked.length === 0 || busy === "start" || Boolean(currentBlocked), onClick: doPack }, busy === "start" ? "提交中…" : (currentBlocked ? "先换个可用的策略" : `打包 ${picked.length} 个插件`)),
            started ? h("span", { style: hint }, "已开始：" + started + "（进度在悬浮窗，可以接着选别的再打一个）") : null,
            status ? h("span", { style: hint }, "DSH " + (status.dshVersion || "?") + " · profile " + status.profile) : null)),
        pausedRiskNodes.length ? h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "10px", borderColor: "#d9534f" } }, pausedRiskNodes) : null,
        error ? h(Notice, { tone: "bad" }, error) : null,
        result ? h("div", { ref: resultRef, style: { ...box, display: "flex", flexDirection: "column", gap: "10px" } },
          result.refused || result.error
            ? h(Notice, { tone: "warn" },
              h("b", null, "已停止："), result.error || "未通过检查",
              result.needsAck ? h("div", { style: { ...row, marginTop: "8px" } },
                h("button", {
                  style: { ...btn, borderColor: "#ff6b6b", color: "#ff6b6b" },
                  disabled: busy === "start",
                  onClick: () => doPack(true),
                }, busy === "start" ? "提交中…" : "我已知晓其中风险，继续打包")) : null)
            : h("div", { style: row },
              h("div", { style: strong }, result.fileName),
              h(Tag, { color: "#2bb673" }, bytes(result.size)),
              h(Tag, null, FORMAT_TEXT[result.manifest && result.manifest.format] || ""),
              h("span", { style: hint }, "包内插件 " + ((result.manifest && result.manifest.plugins) || []).length + " 个")),
          result.scan ? h(ScanReport, { scan: result.scan, groups: result.scanGroups, footNote: "报告已写进包内 security/report.txt（只含类型与掩码）。" }) : null,
          result.manifest && result.manifest.plugins && result.manifest.plugins.length
            ? h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
              result.manifest.plugins.map((p) => h("div", { key: p.name, style: mono },
                "· " + p.name + (p.latest ? "@市场最新" : "@" + p.version) + "　" + (p.size ? bytes(p.size) : "") + ((p.mode === "local" || p.localEdits) ? "　[本地改动]" : "　[基础配置]") + (p.configIncluded ? "　[含配置]" : ""))))
            : null,
          result.compat ? h(CompatList, { compat: result.compat }) : null,
          result.notes && result.notes.length ? h("div", { style: { ...hint, maxHeight: "110px", overflow: "auto" } }, result.notes.map((n, i) => h("div", { key: i }, "· " + n))) : null,
          result.refused || result.error ? null : h("div", { style: row },
            h("button", { style: btnPrimary, disabled: busy !== "", onClick: downloadPack }, busy === "download" ? "准备下载…" : "下载 .dshpack"),
            h("button", { style: btn, disabled: busy !== "", onClick: savePack }, busy === "save" ? "保存中…" : "保存到本机 packs/"),
            result.savedPath ? h("span", { style: hint }, "已存：" + result.savedPath) : null),
          result.refused || result.error ? null : h("div", { style: hint }, "下载后可在「安装 / 导入」页签读回，或将该文件转交他人。"))
          : null)
    }

    // —— 安装 / 导入 ——
    // ===== [区块] 页签二：安装 / 导入：InstallPanel =====
    function InstallPanel(props) {
      const [source, setSource] = useState({ kind: "url", url: "", file: "" })
      const [packs, setPacks] = useState([])
      const [dirInput, setDirInput] = useState((props.status && props.status.paths && props.status.paths.packs) || "")
      const [dirInfo, setDirInfo] = useState({ dir: (props.status && props.status.paths && props.status.paths.packs) || "", error: "" })
      const [preview, setPreview] = useState(null)
      const [busy, setBusy] = useState("")
      const [error, setError] = useState("")
      const [done, setDone] = useState(null)
      const [options, setOptions] = useState({ keepLocal: true, applyConfig: true, force: false, dryRun: false, preferMarket: !!((props.status && props.status.config && props.status.config.preferMarketOnInstall !== false)), enableBundles: !!((props.status && props.status.config && props.status.config.enableOnInstall) === true) })
      // 安装也走任务队列：进度直接显示在左下角那个窗里，这里留一份给页面内看
      const [progress, setProgress] = useState(null)
      const [deferred, setDeferred] = useState([])
      // 预览里逐个插件勾选要不要装、以及每个插件「包内配置 / 保持本机」
      const [pickedNames, setPickedNames] = useState({})
      const [configChoice, setConfigChoice] = useState({})
      const [askReplace, setAskReplace] = useState(false)
      const [imports, setImportsState] = useState(readImports())

      // 已导入的几份包各自留在列表里：切页签、开关进度窗都不丢
      useEffect(() => subscribeImports((next) => setImportsState(next)), [])

      // 进度窗里点了「清空进程」：安装页上那条「完成 / 失败」的结论也一起收掉，别留着当幽灵
      useEffect(() => subscribeClear(() => {
        setProgress(null)
        setDone(null)
        setDeferred([])
        setAskReplace(false)
        setError("")
      }), [])

      // 从「社区资源」点「下载并安装」过来：包已经在后端取回、校验并换成 token，
      // 这里接住直接读一遍预览，后面的勾选、扫描、兼容提示走的是同一条安装流程。
      useEffect(() => subscribeInstallRequest((payload) => {
        if (!payload || !payload.token) return
        installRequest.value = null
        setSource({ kind: "token", token: payload.token, url: "", file: "" })
        setError("")
        setDone(null)
        setDeferred([])
        setAskReplace(false)
        setBusy("import")
        api("/inspect", { token: payload.token })
          .then((data) => {
            if (data && data.ok) setPreview(data)
            else { setPreview(null); setError((data && data.error) || "读取失败") }
          })
          .catch((e) => { setPreview(null); setError((e && e.message) || String(e)) })
          .finally(() => setBusy(""))
      }), [])

      const fileRef = useRef(null)

      // 用「打开文件」的方式挑一个 .dshpack：字节直接读，不要求你写路径
      const pickFile = async (file) => {
        if (!file) return
        if (!/\.dshpack$/i.test(file.name || "")) { setError("只认 .dshpack 整合包"); return }
        setBusy("upload"); setError(""); setDone(null); setDeferred([]); setAskReplace(false)
        try {
          const data = await uploadPackFile(file)
          setSource({ kind: "token", token: data.token, url: "", file: "" })
          setPreview(data)
          addImport(importEntry(data, file.name))
        } catch (e) {
          setError((e && e.message) || String(e))
        } finally { setBusy("") }
      }

      // 从「已导入的整合包」里挑一份：重新读一遍拿预览（token 过期就提示并去掉这条）
      const pickImport = async (item) => {
        if (!item || !item.token) return
        setBusy("import"); setError(""); setDone(null); setDeferred([]); setAskReplace(false)
        try {
          const data = await api("/inspect", { token: item.token })
          if (!data || data.ok !== true) throw new Error((data && data.error) || "这份导入的包已经过期了，重新导入一次")
          setSource({ kind: "token", token: item.token, url: "", file: "" })
          setPreview(data)
        } catch (e) {
          const message = (e && e.message) || String(e)
          setError(message)
          if (/过期|找不到|expired/iu.test(message)) removeImport(item.token)
        } finally { setBusy("") }
      }

      // 原生目录选择器：拿到绝对路径就填进去并列出该目录的 .dshpack
      const browseFolder = async () => {
        if (typeof pickDirectoryHost !== "function") {
          setDirInfo({ ...dirInfo, error: "这个环境没有系统目录选择器，直接在上面填路径也能用" })
          return
        }
        setBusy("dir")
        try {
          const picked = await pickDirectoryHost()
          if (picked) {
            setDirInput(picked)
            await reloadPacks(picked)
          }
        } catch (e) {
          setDirInfo({ ...dirInfo, error: "打不开目录选择器：" + ((e && e.message) || e) })
        } finally { setBusy("") }
      }

      // 列目录：不传目录就看插件自己的 packs，传了就看你指定的目录
      const reloadPacks = useCallback(async (dir) => {
        const want = typeof dir === "string" ? dir.trim() : ""
        try {
          const data = want ? await api("/packs", { dir: want }) : await api("/packs")
          if (data && data.items) setPacks(data.items)
          setDirInfo({ dir: (data && data.dir) || want, error: (data && data.error) || "" })
        } catch (e) {
          setDirInfo({ dir: want, error: (e && e.message) || String(e) })
        }
      }, [])
      useEffect(() => { reloadPacks() }, [reloadPacks])

      // 拖进来的包：外面读好了，这里接住直接当预览

      const bodyFor = () => {
        if (source.kind === "url") return { url: source.url.trim() }
        if (source.kind === "token") return { token: source.token }
        return { file: source.file }
      }

      const inspect = async () => {
        setBusy("inspect"); setError(""); setPreview(null); setDone(null)
        try {
          const data = await api("/inspect", { ...bodyFor(), force: options.force })
          if (data && data.ok) setPreview(data)
          else { setPreview(null); setError((data && data.error) || "读取失败") }
        } catch (e) {
          setPreview(null); setError(e.message || String(e))
        } finally { setBusy("") }
      }

      // 等一个任务跑完（安装同样在后台跑，进度窗里能看到）
      const waitJob = async (jobId) => {
        const started = Date.now()
        while (Date.now() - started < 15 * 60 * 1000) {
          const data = await api("/jobs")
          const job = data && data.jobs ? data.jobs.find((item) => item.id === jobId) : null
          if (!job) throw new Error("任务不见了（可能已过期），再试一次")
          setProgress({ pct: job.pct, note: job.note, status: job.status })
          if (job.status !== "running") return job
          await new Promise((resolve) => setTimeout(resolve, 700))
        }
        throw new Error("等了 15 分钟还没结束，去左下角看看是不是卡住了")
      }

      const install = async () => {
        setBusy("install"); setError(""); setDone(null); setDeferred([]); setAskReplace(false); setProgress(null)
        try {
          const allNames = (preview && preview.manifest && preview.manifest.plugins ? preview.manifest.plugins : []).map((p) => p.name)
          const keepNames = allNames.filter((name) => pickedNames[name] !== false)
          const only = keepNames.length === allNames.length || keepNames.length === 0 ? undefined : keepNames
          const installOptions = { ...options, ...(only ? { only } : {}), configChoice, syncGroups: options.syncGroups !== false, ...(options.offline === true ? { offline: true } : {}) }
          const data = await api("/install", { ...bodyFor(), ...installOptions, async: true })
          if (!data || data.ok !== true || !data.job) {
            // 老宿主不认 async：退回同步调用
            const plain = await api("/install", { ...bodyFor(), ...installOptions })
            if (!plain.ok) {
              setDone({ ok: false, error: plain.error, refused: plain.refused, scan: plain.scan, report: plain.report })
              return
            }
            setDone(plain)
            setDeferred(Array.isArray(plain.deferred) ? plain.deferred : [])
            setAskReplace(Array.isArray(plain.deferred) && plain.deferred.length > 0)
            return
          }
          const job = await waitJob(data.job.id)
          const payload = job.data || {}
          // 结果已经拿到页面上了，这条任务就从进度窗里摘掉：不用你再去点一次清空
          try { await api("/jobs/dismiss", { id: job.id }) } catch (ignored) { /* 老宿主没有这条路由就留着 */ }
          if (job.status === "cancelled") { setDone({ ok: false, error: "已取消（没有改动 profile）" }); return }
          if (!payload.ok) {
            setDone({ ok: false, error: payload.error || job.error || "安装失败", refused: Boolean(payload.refused), scan: payload.scan, report: payload.report })
            return
          }
          setDone(payload)
          setDeferred(Array.isArray(payload.deferred) ? payload.deferred : [])
          setAskReplace(Array.isArray(payload.deferred) && payload.deferred.length > 0)
        } catch (e) {
          setDone({ ok: false, error: e.message || String(e), scan: (e.data && e.data.scan) || null, report: (e.data && e.data.report) || "", refused: Boolean(e.data && e.data.refused) })
        } finally { setBusy(""); setProgress(null) }
      }

      // 把刚才跳过的换成包内版本
      const replaceDeferred = async (names) => {
        if (!done || !done.token) { setError("这次安装的上下文过期了，重新读一遍包"); return }
        setBusy("replace"); setError("")
        try {
          const data = await api("/install/replace", { token: done.token, names, async: true })
          if (!data || data.ok !== true || !data.job) {
            const plain = await api("/install/replace", { token: done.token, names })
            if (!plain.ok) { setError(plain.error || "替换失败"); return }
            setDone(plain); setDeferred(Array.isArray(plain.deferred) ? plain.deferred : []); setAskReplace(false)
            return
          }
          const job = await waitJob(data.job.id)
          const payload = job.data || {}
          try { await api("/jobs/dismiss", { id: job.id }) } catch (ignored) { /* 同上 */ }
          if (!payload.ok) { setError(payload.error || job.error || "替换失败"); return }
          setDone(payload); setDeferred([]); setAskReplace(false)
        } catch (e) {
          setError(e.message || String(e))
        } finally { setBusy(""); setProgress(null) }
      }

      const previewFindings = preview && preview.compat && Array.isArray(preview.compat.findings) ? preview.compat.findings : []
      const previewProblems = previewFindings.filter((f) => f.level !== "info")
      const previewRows = preview && preview.manifest && Array.isArray(preview.manifest.plugins)
        ? preview.manifest.plugins.map((plugin) => ({ plugin, problems: previewProblems.filter((f) => f.plugin === plugin.name) }))
          .sort((a, b) => (b.problems.length > 0 ? 1 : 0) - (a.problems.length > 0 ? 1 : 0))
        : []
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
        h(Notice, null,
          h("b", null, "先看清楚，再装"),
          "　读取阶段解压、校验完整性、扫一遍风险，全部在内存里完成；只有你点「安装」才会碰 profile。安装走官方 ",
          h("code", { style: mono }, "dsh plugin add"), "，不手改 node_modules。"),
        imports.length > 0
          ? h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "8px" } },
            h("div", { style: row },
              h("div", { style: strong }, "已导入的整合包"),
              h("span", { style: hint }, imports.length + " 份 · 可以同时留着，各自显示打包时的名字、作者与描述"),
              h("button", { style: { ...chipBtn, marginLeft: "auto" }, onClick: () => setImports([]) }, "全部移除")),
            h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", maxHeight: "260px", overflow: "auto" } },
              imports.map((item) => h("div", {
                key: item.token,
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "3px",
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: "0.5px solid " + (source.kind === "token" && source.token === item.token ? "#4C7DF0" : "var(--dsw-alias-border-l2)"),
                },
              },
                h("div", { style: row },
                  h("span", { style: { ...label, fontSize: "13px" } }, item.name),
                  h(Tag, null, FORMAT_TEXT[item.format] || item.format || "整合包"),
                  h("span", { style: hint }, item.plugins + " 个插件"),
                  h("button", {
                    style: { ...chipBtn, marginLeft: "auto" },
                    disabled: busy !== "",
                    onClick: () => pickImport(item),
                  }, source.kind === "token" && source.token === item.token ? "当前选中" : "选择"),
                  h("button", {
                    style: { ...chipBtn, color: "var(--dsw-alias-label-tertiary, #8b8f99)" },
                    onClick: () => {
                      removeImport(item.token)
                      if (source.kind === "token" && source.token === item.token) {
                        setSource({ kind: "url", url: "", file: "" })
                        setPreview(null)
                      }
                    },
                  }, "移除")),
                h("div", { style: { ...hint, fontSize: "10.5px" } },
                  "作者：" + (item.author || "未填写") + "　·　生成于 " + (item.createdAt ? when(item.createdAt) : "未知")),
                item.description ? h("div", { style: { ...hint, fontSize: "11.5px", color: "var(--dsw-alias-label-secondary, #b6bac3)" } }, item.description) : null,
                item.fileName ? h("div", { style: { ...hint, fontSize: "10px" } }, item.fileName) : null))))
          : null,
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "10px" } },
          h("div", { style: row },
            h("button", { style: source.kind === "url" ? btnPrimary : btn, onClick: () => setSource({ ...source, kind: "url" }) }, "从链接读取"),
            h("button", { style: source.kind === "file" ? btnPrimary : btn, onClick: () => setSource({ ...source, kind: "file" }) }, "从本机文件读取"),
            h("input", {
              type: "file",
              accept: ".dshpack",
              ref: fileRef,
              style: { display: "none" },
              onChange: (e) => {
                const picked = e && e.target && e.target.files ? e.target.files[0] : null
                if (picked) pickFile(picked)
                if (e && e.target) e.target.value = ""
              },
            }),
            h("button", { style: btn, disabled: busy !== "", onClick: () => { if (fileRef.current) fileRef.current.click() } }, busy === "upload" ? "读取中…" : "选择文件…"),
            source.kind === "token"
              ? h("button", { style: btnPrimary, onClick: () => { if (imports.length === 0) setSource({ ...source, kind: "url" }) } }, "已导入的整合包")
              : null),
          source.kind === "url"
            ? h("input", { style: { ...input, width: "100%" }, placeholder: "https://…/xxx.dshpack", value: source.url, onChange: (e) => setSource({ ...source, url: e.target.value }) })
            : h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
              h("div", { style: row },
                h("input", {
                  style: { ...input, flex: "1 1 320px" },
                  placeholder: "整合包所在的目录（默认是插件自己的 packs）",
                  value: dirInput,
                  onChange: (e) => setDirInput(e.target.value),
                  onKeyDown: (e) => { if (e.key === "Enter") reloadPacks(dirInput) },
                }),
                h("button", { style: btn, disabled: busy !== "", onClick: browseFolder }, busy === "dir" ? "选择中…" : "浏览文件夹…"),
                h("button", { style: btn, onClick: () => reloadPacks(dirInput) }, "读这个目录"),
                h("button", { style: btn, onClick: () => reloadPacks() }, "回到默认")),
              dirInfo.error ? h("div", { style: { ...hint, color: "#ff6b6b" } }, dirInfo.error) : null,
              h("div", { style: { display: "flex", flexDirection: "column", gap: "3px", maxHeight: "170px", overflow: "auto" } },
                packs.length === 0 ? h("div", { style: hint }, "这个目录里没有 .dshpack。先去打包页生成一个，或者把文件拖到界面上。") : null,
                packs.map((p) => h("label", { key: p.path || p.name, style: { ...row, gap: "6px", cursor: "pointer" } },
                  h("input", { type: "radio", name: "packfile", checked: source.file === (p.path || p.name), onChange: () => setSource({ ...source, file: p.path || p.name }) }),
                  h("span", { style: label }, p.name),
                  h("span", { style: hint }, bytes(p.size) + " · " + when(p.mtime))))),
              dirInfo.dir ? h("div", { style: { ...hint, fontSize: "10.5px" } }, "当前目录：" + dirInfo.dir) : null),
          h("div", { style: row },
            h(Switch, { checked: options.keepLocal, label: "保留本地已有修改（不覆盖已装插件）", onChange: (v) => setOptions({ ...options, keepLocal: v }) }),
            h(Switch, { checked: options.applyConfig, label: "安装后回填包内配置", onChange: (v) => setOptions({ ...options, applyConfig: v }) }),
            h(Switch, { checked: options.preferMarket, label: "联网时优先用插件市场的版本（市场查不到就用包内的）", onChange: (v) => setOptions({ ...options, preferMarket: v }) }),
            h(Switch, { checked: options.enableBundles, label: "安装后整体启用（全部登记 bundle，重启后加载）", onChange: (v) => setOptions({ ...options, enableBundles: v }) }),
            h(Switch, { checked: options.syncGroups !== false, label: "安装后同步插件市场分组（包内组名并进同名组）", onChange: (v) => setOptions({ ...options, syncGroups: v }) }),
            h(Switch, { checked: options.offline === true, label: "离线安装（不联网，直接用包里自带的）", onChange: (v) => setOptions({ ...options, offline: v ? true : undefined }) }),
            h(Switch, { checked: options.force, label: "忽略阻断（我知道自己在干什么）", onChange: (v) => setOptions({ ...options, force: v }) })),
          h("div", { style: row },
            h("button", { style: btnPrimary, disabled: busy !== "" || (source.kind === "url" ? !source.url.trim() : !source.file), onClick: inspect }, busy === "inspect" ? "检测中…" : "检测这个包"),
            source.kind === "file" && source.file ? h("span", { style: hint }, "选中：" + source.file) : null,
            source.kind === "token" ? h("span", { style: hint }, "这份是导入到列表里的包，已经读过一遍；点上面的「选择」可以换另一份") : null)),
        progress
          ? h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "8px" } },
            h("div", { style: row },
              h("div", { style: strong }, "正在安装"),
              h("span", { style: hint }, (progress.note || "") + "　" + Math.round(progress.pct || 0) + "%")),
            h(ProgressBar, { pct: progress.pct }))
          : null,
        error ? h(Notice, { tone: "bad" }, error) : null,
        preview ? h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "10px" } },
          h("div", { style: row },
            h("div", { style: strong }, preview.manifest.name),
            h(Tag, null, FORMAT_TEXT[preview.manifest.format] || preview.manifest.format),
            h(Tag, { color: preview.integrity && preview.integrity.ok ? "#2bb673" : "#ffb020" }, preview.integrity && preview.integrity.present ? (preview.integrity.ok ? "完整性通过" : "完整性有出入") : "无完整性清单"),
            h("span", { style: hint }, "生成于 " + when(preview.manifest.createdAt) + (preview.manifest.author ? " · " + preview.manifest.author : ""))),
          preview.manifest.description ? h("div", { style: label }, preview.manifest.description) : null,
          preview.blockingReasons && preview.blockingReasons.length
            ? h(Notice, { tone: "bad" }, h("b", null, "阻断：" ), preview.blockingReasons.join("；"), "　（真要装，勾上面的「忽略阻断」）")
            : null,
          h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", maxHeight: "280px", overflow: "auto" } },
            previewProblems.length ? h("div", { style: { ...hint, color: "#ffb020" } }, "有 " + previewProblems.length + " 条问题/提醒，相关插件已排在最前面") : null,
            previewRows.map((row) => {
              const p = row.plugin
              const checked = pickedNames[p.name] !== false
              return h("div", { key: p.name, style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", padding: "4px 0", borderTop: "0.5px solid var(--dsw-alias-border-l2)" } },
                h("input", { type: "checkbox", checked, onChange: () => setPickedNames((prev) => ({ ...prev, [p.name]: !checked })) }),
                h("div", { style: { flex: "1 1 220px", minWidth: "170px" } },
                  h("div", { style: label }, p.name, " ", h("span", { style: hint }, p.latest ? "@市场最新（装的时候按名字取）" : "@" + (p.version || "?"))),
                  h("div", { style: hint }, [p.localEdits ? "含本机修改" : "", p.configIncluded ? "有配置" : "", p.dataIncluded ? "有数据快照" : ""].filter(Boolean).join(" · ")),
                  row.problems.length ? h("div", { style: { ...hint, color: row.problems.some((f) => f.level === "error") ? "#ff6b6b" : "#ffb020" } },
                    row.problems.slice(0, 3).map((f) => "· " + f.message).join("；") + (row.problems.length > 3 ? "（还有 " + (row.problems.length - 3) + " 条）" : "")) : null),
                p.configIncluded ? h("div", { style: { display: "flex", gap: "4px" } },
                  h("button", { style: (configChoice[p.name] || "pack") === "pack" ? chipOn : chipBtn, onClick: () => setConfigChoice((prev) => ({ ...prev, [p.name]: "pack" })), title: "用包里的配置条目覆盖/补上" }, "包内配置"),
                  h("button", { style: configChoice[p.name] === "local" ? chipOn : chipBtn, onClick: () => setConfigChoice((prev) => ({ ...prev, [p.name]: "local" })), title: "保留本机这份配置，不用包里的" }, "保持本机")) : null)
            })),
          h(ScanReport, { scan: preview.scan, groups: preview.scanGroups }),
          h(CompatList, { compat: preview.compat }),
          preview.notes && preview.notes.length ? h("div", { style: hint }, preview.notes.map((n, i) => h("div", { key: i }, "· " + n))) : null,
          h("div", { style: row },
            h(Switch, { checked: options.dryRun, label: "只演练不落地", onChange: (v) => setOptions({ ...options, dryRun: v }) }),
            h("button", { style: btnPrimary, disabled: busy !== "", onClick: install }, busy === "install" ? "安装中…" : (options.dryRun ? "演练一次" : "安装这个整合包"))))
          : null,
        askReplace && deferred.length > 0
          ? h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "8px" } },
            h("div", { style: { ...label, color: "#ffb020" } }, "以下 " + deferred.length + " 个插件本机已经装了，这次先跳过没动它们："),
            deferred.map((d) => h("div", { key: d.name, style: mono },
              "· " + d.name + "　本机 " + (d.localVersion || "未知") + " → 包内 " + (d.packVersion || "未知") + (d.sameVersion ? "（版本相同）" : ""))),
            h("div", { style: hint }, "要保留本机版本就直接完成；要换成包内版本点下面这个（会覆盖本机那份）。"),
            h("div", { style: row },
              h("button", { style: btn, disabled: busy !== "", onClick: () => { setAskReplace(false) } }, "直接完成（保留本机版本）"),
              h("button", { style: btnPrimary, disabled: busy !== "", onClick: () => replaceDeferred(deferred.map((d) => d.name)) }, `重新装一下这 ${deferred.length} 个（用包内版本）`)))
          : null,
        done ? h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "8px" } },
          h("div", { style: row },
            h("div", { style: strong }, done.ok ? "安装完成" : "没有装成"),
            done.needsRestart ? h(Tag, { color: "#ffb020" }, "需要重启 DSH 生效") : null),
          done.error ? h("div", { style: { ...label, color: "#ff6b6b" } }, done.error) : null,
          (done.actions || []).map((a, i) => h("div", { key: i, style: { ...mono, color: a.ok ? "inherit" : "#ff6b6b" } },
            (a.ok ? "✓ " : "✗ ") + a.plugin + " · " + a.action + " · " + a.message)),
          (done.lines || []).length ? h("details", null, h("summary", { style: hint }, "命令输出（" + done.lines.length + " 行）"),
            h("pre", { style: { ...mono, maxHeight: "200px", overflow: "auto", whiteSpace: "pre-wrap" } }, done.lines.join("\n"))) : null,
          done.scan ? h(ScanReport, { scan: done.scan, groups: done.scanGroups }) : null)
          : null)
    }

    // —— 设置与记录 ——
    const REPO_URL = "https://github.com/Vesna-Strivozha-cn/dsh-modpack-kit"

    // 页脚：仓库地址 + 求星。放在页面与设置最底下，不抢功能的位置。
    function RepoFooter(props) {
      return h("div", {
        style: {
          marginTop: "6px",
          paddingTop: "12px",
          borderTop: "1px solid var(--dsw-alias-border-l2)",
          display: "flex",
          alignItems: "baseline",
          gap: "8px",
          flexWrap: "wrap",
          fontSize: "12px",
          color: "var(--dsw-alias-label-tertiary)",
        },
      },
        h("span", null, "项目地址："),
        h("a", {
          href: REPO_URL,
          target: "_blank",
          rel: "noreferrer",
          style: { color: "var(--dsw-alias-label-primary)", textDecoration: "underline", textUnderlineOffset: "2px" },
        }, "github.com/Vesna-Strivozha-cn/dsh-modpack-kit"),
        h("span", null, "如果这个插件省了时间，顺手点个 Star，能让更多人找到它。"))
    }

    // ===== [区块] 页签四：设置与记录：SettingsPanel =====
    function SettingsPanel(props) {
      const [cfg, setCfg] = useState(() => ({ ...((props.status && props.status.config) || {}), ...(liveCfg.value || {}) }))
      const [saved, setSaved] = useState("")
      const [busy, setBusy] = useState(false)
      const [scanNag, fireScanNag] = useNag()
      // 记录用本地状态：删一条不用整页重读，删完立刻看到结果
      const [history, setHistory] = useState((((props.status || {}).history) || []).slice())
      const [historyMsg, setHistoryMsg] = useState("")
      const [marketSidebarMsg, setMarketSidebarMsg] = useState("")
      const dropHistory = async (item, all) => {
        setHistoryMsg("")
        try {
          const data = all
            ? await api("/history/clear", {})
            : await api("/history/remove", { at: item && item.at })
          if (data && data.ok) {
            setHistory(Array.isArray(data.items) ? data.items.slice(-12).reverse() : [])
            setHistoryMsg(all ? "已清空最近记录" : "已删掉这一条")
          } else {
            setHistoryMsg((data && data.error) || "没删成")
          }
        } catch (e) {
          setHistoryMsg((e && e.message) || String(e))
        }
      }

      const patch = async (p) => {
        setBusy(true); setSaved("")
        try {
          const data = await api("/settings", { patch: p })
          if (data && data.ok) {
            setCfg(data.config)
            mergeLiveConfig(data.config)
            // 「社区资源」这一栏的开关键在这里：一关，标签立刻消失，不用等重新拉状态
            if (Object.prototype.hasOwnProperty.call(p, "showModpackMarket")) setMarketVisible(data.config.showModpackMarket !== false)
            setSaved("已保存")
          }
          else setSaved((data && data.error) || "保存失败")
        } catch (e) {
          setSaved(e.message || String(e))
        } finally { setBusy(false) }
      }
      const setField = (key, value) => setCfg((prev) => ({ ...(prev || {}), [key]: value }))
      // 打开就替市场把侧栏入口关掉；关掉就还回去。市场没装就只提示，不报错。
      const toggleMarketSidebar = async (on) => {
        setMarketSidebarMsg("")
        setField("forceHideMarketSidebar", on)
        await patch({ forceHideMarketSidebar: on })
        const current = await readMarketSidebar()
        if (!current) { setMarketSidebarMsg("没装插件市场（dshmarket），或者在旧版本上没有这个入口。"); return }
        try {
          await writeMarketSidebar(!on)
          setMarketSidebarMsg(on ? "已关掉：市场侧栏那一行现在不显示。" : "已恢复：市场侧栏那一行按它的设置显示。")
        } catch (e) {
          setMarketSidebarMsg((e && e.message) || String(e))
        }
      }
      // 体积上限按 MB 输：先把输入框里的原始文本存着，点「保存数值」才换算成字节，
      // 这样不会每敲一个数字就四舍五入一次（以前会越打越多，最后存成 25 GB 这种值）。
      const [limitDraft, setLimitDraft] = useState(String(Math.round(((props.status && props.status.config && props.status.config.maxPackBytes) || 256 * 1048576) / 1048576)))
      useEffect(() => {
        if (!cfg) return
        setLimitDraft(String(Math.round((cfg.maxPackBytes || 0) / 1048576)))
      }, [cfg && cfg.maxPackBytes])
      // 显示位：先本地生效（不用等接口回来），再落盘
      const placementOn = {
        showInSettings: !!cfg && cfg.showInSettings !== false,
        showInSidebar: !!cfg && cfg.showInSidebar !== false,
        showInPluginsTab: !!cfg && cfg.showInPluginsTab === true,
      }
      const placementCount = (placementOn.showInSettings ? 1 : 0) + (placementOn.showInSidebar ? 1 : 0) + (placementOn.showInPluginsTab ? 1 : 0)
      // 只剩一处开着时，这一处锁死：点了只会提示，不能让三处全关
      const placementLocked = (key) => placementCount <= 1 && placementOn[key] === true
      const savePlacement = async (key, value) => {
        const next = { ...(cfg || {}), [key]: value }
        const want = {
          settings: next.showInSettings !== false,
          sidebar: next.showInSidebar !== false,
          pluginsTab: next.showInPluginsTab === true,
        }
        if (!want.settings && !want.sidebar && !want.pluginsTab) { setSaved("三处至少留一处，最后剩的那个不能关"); return }
        setCfg(next)
        setPlacement(want)
        setBusy(true)
        try {
          const data = await api("/settings", { patch: { [key]: value } })
          if (data && data.ok) { setCfg(data.config); setSaved("已保存") } else setSaved((data && data.error) || "保存失败")
        } catch (e) {
          setSaved(e.message || String(e))
        } finally { setBusy(false) }
      }
      if (!cfg) return h("div", { style: hint }, "设置读取中…")

      const textList = (key) => (Array.isArray(cfg[key]) ? cfg[key].join("\n") : "")

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "10px" } },
          h("div", { style: strong }, "扫描与安装策略"),
          h("div", { style: row },
            h(ForcedSwitch, { label: "打包前扫描（强制）", onNag: () => fireScanNag("你想干什么") }),
            h(Switch, { checked: cfg.scanBeforeInstall !== false, label: "安装前扫描", onChange: (v) => { setField("scanBeforeInstall", v); patch({ scanBeforeInstall: v }) } }),
            h(Switch, { checked: cfg.blockHighRisk !== false, label: "高风险直接拒绝", onChange: (v) => { setField("blockHighRisk", v); patch({ blockHighRisk: v }) } }),
            h(Switch, { checked: cfg.applyPackedConfig !== false, label: "默认回填配置", onChange: (v) => { setField("applyPackedConfig", v); patch({ applyPackedConfig: v }) } }),
            h(Switch, { checked: cfg.enableOnInstall === true, label: "装完直接启用（默认关）", onChange: (v) => { setField("enableOnInstall", v); patch({ enableOnInstall: v }) } })),
          h(NagText, { text: scanNag }),
          h("div", { style: hint }, "扫描只看代码与文本，不执行任何东西；命中原文不会落盘，也不进日志。"),
          h("div", { style: row },
            h("span", { style: label }, "体积上限（MB）"),
            h("input", {
              style: { ...input, width: "90px" },
              type: "number",
              min: "16",
              max: "4096",
              value: limitDraft,
              onChange: (e) => setLimitDraft(e.target.value),
              onBlur: () => { if (!String(limitDraft).trim()) setLimitDraft(String(Math.round((cfg.maxPackBytes || 0) / 1048576))) },
            }),
            h("button", {
              style: btn,
              disabled: busy,
              onClick: () => {
                const mb = Math.round(Number(limitDraft))
                if (!Number.isFinite(mb) || mb <= 0) { setSaved("请填一个 MB 数字（默认 256）"); return }
                const bytes = Math.min(4096, Math.max(16, mb)) * 1048576
                if (bytes !== mb * 1048576) setSaved("已按范围收到 16~4096 MB")
                setField("maxPackBytes", bytes)
                patch({ maxPackBytes: bytes, maxDownloadBytes: cfg.maxDownloadBytes, maxFileBytes: cfg.maxFileBytes, maxMetadataBytes: cfg.maxMetadataBytes, netTimeoutSeconds: cfg.netTimeoutSeconds, netRetries: cfg.netRetries, curlFallback: cfg.curlFallback !== false, licenseAllow: cfg.licenseAllow, registries: cfg.registries, allowHosts: cfg.allowHosts })
              },
            }, "保存数值"),
            h("span", { style: hint }, "默认 256 MB，可填 16~4096"),
            saved ? h("span", { style: hint }, saved) : null)),
          h("div", { style: row },
            h("span", { style: label }, "网络超时（秒）"),
            h("input", { style: { ...input, width: "70px" }, type: "number", min: "5", max: "120", value: String(cfg.netTimeoutSeconds || 20), onChange: (e) => setField("netTimeoutSeconds", Number(e.target.value)) }),
            h("span", { style: label }, "重试"),
            h("input", { style: { ...input, width: "56px" }, type: "number", min: "0", max: "5", value: String(cfg.netRetries || 0), onChange: (e) => setField("netRetries", Number(e.target.value)) }),
            h("span", { style: label }, "版本清单上限（MB）"),
            h("input", { style: { ...input, width: "70px" }, type: "number", min: "4", max: "512", value: String(cfg.maxMetadataBytes || 64), onChange: (e) => setField("maxMetadataBytes", Number(e.target.value)) }),
            h(Switch, {
              checked: cfg.curlFallback !== false,
              label: "fetch 失败时用系统 curl 兜底",
              onChange: (v) => { setField("curlFallback", v); patch({ curlFallback: v }) },
            })),
          h("div", { style: hint }, "registry 报 fetch failed / 超时，多半是代理或证书链：调大超时、加一次重试，或让 curl 兜底（走系统证书库）。提示「下载超过上限」时是版本清单太大（billion-context 这类包的清单十几 MB）：把「版本清单上限」调大，或改用确定的版本号（插件会直接取单版本清单，体积最小）。保存后立即生效。"),
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "8px" } },
          h("div", { style: strong }, "信任清单"),
          h("div", { style: hint }, "允许的许可证（一行一个，例如 MIT）："),
          h("textarea", { style: { ...input, height: "62px", padding: "6px 8px", width: "100%", resize: "vertical" }, value: textList("licenseAllow"), onChange: (e) => setField("licenseAllow", e.target.value.split("\n")) }),
          h("div", { style: hint }, "允许的下载域名（一行一个，只走 https）："),
          h("textarea", { style: { ...input, height: "62px", padding: "6px 8px", width: "100%", resize: "vertical" }, value: textList("allowHosts"), onChange: (e) => setField("allowHosts", e.target.value.split("\n")) }),
          h("div", { style: hint }, "npm 源（按顺序回退）："),
          h("textarea", { style: { ...input, height: "62px", padding: "6px 8px", width: "100%", resize: "vertical" }, value: textList("registries"), onChange: (e) => setField("registries", e.target.value.split("\n")) }),
          h("div", { style: row },
            h("button", { style: btn, disabled: busy, onClick: () => patch({ licenseAllow: cfg.licenseAllow.filter(Boolean), allowHosts: cfg.allowHosts.filter(Boolean), registries: cfg.registries.filter(Boolean) }) }, "保存清单"))),
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "8px" } },
          h("div", { style: strong }, "位置"),
          h("div", { style: mono }, "profile：" + ((props.status && props.status.paths && props.status.paths.profile) || "?")),
          h("div", { style: mono }, "整合包：" + ((props.status && props.status.paths && props.status.paths.packs) || "?")),
          h("div", { style: mono }, "缓存与暂存：" + ((props.status && props.status.paths && props.status.paths.vendor) || "?")),
          h("div", { style: mono }, "卸载临时文件：删掉 vendor 目录即可，装好的插件不受影响。")),
        h(FoldBox, {
          title: "最近记录",
          defaultOpen: false,
          summary: h("span", { style: hint }, history.length ? "共 " + history.length + " 条" : "还没有记录"),
          actions: history.length
            ? [h("button", {
              type: "button",
              style: chipBtn,
              title: "清空全部最近记录（只删记录，不动插件与包）",
              onClick: () => dropHistory(null, true),
            }, "清空最近记录")]
            : [],
          hint: "展开（" + history.length + " 条）",
          collapsedNote: history.length ? "打包与安装的历史都记在这里，点开可以逐条删除。" : "",
        },
          history.length === 0
            ? h("div", { style: hint }, "还没有记录。")
            : h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
              history.map((item, i) => h("div", { key: String(item.at || i) + i, style: { ...mono, display: "flex", gap: "8px", alignItems: "baseline", borderTop: "0.5px solid var(--dsw-alias-border-l2)", paddingTop: "4px" } },
                h("span", { style: { flex: "1 1 auto" } },
                  "[" + (item.kind || "?") + "] " + (item.name || item.pack || "") + " · " + when(item.at) + (item.size ? " · " + bytes(item.size) : "") + (item.ok === false ? " · 失败" : "")),
                h("button", {
                  type: "button",
                  style: { ...chipBtn, flexShrink: 0 },
                  title: "删掉这一条（只删记录，不动插件与包）",
                  onClick: () => dropHistory(item, false),
                }, "删除"))),
              h("div", { style: row },
                h("button", { type: "button", style: btn, onClick: () => dropHistory(null, true) }, "清空记录"),
                historyMsg ? h("span", { style: hint }, historyMsg) : null))),
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "8px" } },
          h("div", { style: strong }, "显示位置"),
          h("div", { style: hint }, "三处互相独立，一点就生效，不用重启。关掉只是不挂载入口，功能与接口都还在。至少留一处：只剩一个时，那个开关会变灰、点不动。"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
            h(Switch, { checked: cfg.showInSettings !== false, disabled: placementLocked("showInSettings"), label: "在设置里显示（插件设置页内一栏「整合包」）" + (placementLocked("showInSettings") ? "（最后剩这一个，不能关）" : ""), onChange: (v) => savePlacement("showInSettings", v) }),
            h(Switch, { checked: cfg.showInSidebar !== false, disabled: placementLocked("showInSidebar"), label: "在侧边栏显示（左侧栏「整合包」入口）" + (placementLocked("showInSidebar") ? "（最后剩这一个，不能关）" : ""), onChange: (v) => savePlacement("showInSidebar", v) }),
            h(Switch, { checked: cfg.showInPluginsTab === true, disabled: placementLocked("showInPluginsTab"), label: "在插件页内显示（与插件市场同一位置，单开一栏「整合包」）" + (placementLocked("showInPluginsTab") ? "（最后剩这一个，不能关）" : ""), onChange: (v) => savePlacement("showInPluginsTab", v) })),
          h("div", { style: { ...hint, borderTop: "0.5px solid var(--dsw-alias-border-l2)", paddingTop: "8px", marginTop: "2px" } }, "插件市场自己那一行（与上面整合包的入口无关）："),
          h(Switch, {
            checked: cfg.forceHideMarketSidebar === true,
            label: "强制关闭侧栏里的插件市场显示",
            title: "每次开机强制显示还关不掉很烦吧",
            onChange: (v) => toggleMarketSidebar(v),
          }),
          h("div", { style: hint }, "只关市场自己的，不动整合包：改的是它存在 .dsh-market/state.json 里的 sidebarEntry，不动它的安装，也不动整合包的入口。"),
          marketSidebarMsg ? h("div", { style: hint }, marketSidebarMsg) : null,
          saved ? h("span", { style: hint }, saved) : null),
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "8px" } },
          h("div", { style: strong }, "社区资源（附属功能）"),
          h(Switch, {
            checked: cfg.showModpackMarket !== false,
            label: "显示「社区资源」这一栏",
            title: "插件自带、默认开启；关掉只是不显示这一栏",
            onChange: (v) => patch({ showModpackMarket: v }),
          }),
          h("div", { style: hint }, "关掉只是不显示这一栏，已经下载与安装的整合包不受影响。目录来自自建仓库 " + (((props.status || {}).modpackMarket || {}).repo || "Vesna-Strivozha-cn/dsh-modpack-catalog") + "，CI 每天重建一次。"),
          h("div", { style: row },
            h("span", { style: label }, "自动更新（小时）"),
            h("input", { style: { ...input, width: "78px" }, type: "number", min: "1", max: "168", value: cfg.modpackRefreshHours || 24, onChange: (e) => setField("modpackRefreshHours", Number(e.target.value)) }),
            h("button", { style: btn, disabled: busy, onClick: () => patch({ modpackRefreshHours: cfg.modpackRefreshHours }) }, "保存")),
          h("div", { style: hint }, "搜索、分类、详情与下载码都在「社区资源」那一栏里；上传方式与规则点那一栏右上角。")),
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "8px" } },
          h("div", { style: strong }, "插件目录（分类 · 搜索 · 分页）"),
          h("div", { style: hint }, (() => {
            const c = props.status && props.status.catalog
            if (!c || !c.present) return "本地还没有目录索引；要按分类找插件、要搜索时，先在这里或打包页建一次。"
            return "本地索引：" + c.count + " 条 · 来源 " + (c.sourceLabel || c.source || "?") + " · 建于 " + when(c.builtAt) + (c.stale ? "（偏旧了，建议更新）" : "")
          })()),
          h("div", { style: row },
            h("span", { style: label }, "每页条数"),
            h("input", { style: { ...input, width: "78px" }, type: "number", min: "5", max: "100", value: cfg.catalogPageSize || 20, onChange: (e) => setField("catalogPageSize", Number(e.target.value)) }),
            h("span", { style: label }, "自动更新（小时）"),
            h("input", { style: { ...input, width: "78px" }, type: "number", min: "1", max: "168", value: cfg.catalogRefreshHours || 24, onChange: (e) => setField("catalogRefreshHours", Number(e.target.value)) }),
            h("button", { style: btn, disabled: busy, onClick: () => patch({ catalogPageSize: cfg.catalogPageSize, catalogRefreshHours: cfg.catalogRefreshHours }) }, "保存目录设置")),
          h("div", { style: hint }, "目录就是插件市场自己发布的那份 dsh-plugin-catalog：CDN 优先，失败退回 npm 包。分类与词条都照它来，本插件不另造一套。"),
          h(RepoFooter, null))
      )
    }

    // —— 社区资源 ——
    // 「从市场下载」到「安装页」之间只有一次交接：市场负责下载、校验、把 token 递过去，
    // 识别 / 扫描 / 兼容 / 许可证 / 安装这些仍然由安装页那条老路做，不另起一套。
    const installRequest = { value: null, subs: new Set() }
    const requestInstall = (payload) => {
      installRequest.value = payload || null
      for (const fn of [...installRequest.subs]) {
        try { fn(installRequest.value) } catch (e) { }
      }
    }
    const subscribeInstallRequest = (fn) => {
      installRequest.subs.add(fn)
      if (installRequest.value) {
        try { fn(installRequest.value) } catch (e) { }
      }
      return () => { installRequest.subs.delete(fn) }
    }

    const MARKET_SORTS = [["new", "最新"], ["downloads", "下载量"], ["size", "体积"], ["name", "名称"]]
    const MARKET_RULES = [
      "只收轻量包（strategy: lite）：只记插件名与版本、不带插件本体，十几 KB；装的人联网按版本取包。",
      "第 1 步：在本插件「打包」页选「轻量包」、勾插件、打包并下载成 <名字>-<日期>-lite.dshpack。",
      "第 2 步：算 sha256（Windows：certutil -hashfile 名字.dshpack SHA256；macOS/Linux：shasum -a 256 名字.dshpack），再记下字节数（≤ 64 MB）。",
      "第 3 步：fork github.com/Vesna-Strivozha-cn/dsh-modpack-catalog，切一个分支，把包放进 packs/，再写一份 data/packs/<id>.json（只写 id、类型、文件名、sha256、日期）。",
      "第 4 步：本地跑 node scripts/build.mjs，看到「packs.json: N 个整合包」才算过；报「构建失败」按提示改（多半是 sha256/size 对不上或分类写错）。",
      "第 5 步：提交、push、开 PR；CI 会重跑构建，合并后每天 03:17 UTC 自动重建目录，也可以在 Actions 里手动 Run workflow 立刻扫一轮。",
      "条目里不要写介绍、名称、作者、插件清单：目录直接显示包内 dsh-modpack.json（也就是打包那一刻填的内容），写了两边会不一致，构建会挡下。",
      "包内插件可以不写死版本：清单里写 { \"name\": \"dsh-context\", \"latest\": true }，安装时按名字取市场最新版（插件市场认市场版）；写 version 就必须是 x.y.z。",
      "分类按使用场景：工作办公、性能优化、界面美化、实用功能、开发调试、娱乐休闲、学习资料、水槽（插件横跨三类以上会自动归这里）、其它。",
      "只提交你自己打的包，或者你有权再分发的插件组合；作者没写许可证的组合请先问作者。",
    ]

    // ===== [区块] 页签三：社区资源：MarketPanel =====
    // 两层：外层管左侧「插件 / 整合包」两个大类，里层各自是独立的浏览面板。
    // 整合包这层就是原来的整包浏览（列表 / 详情 / 上传规则）。
    function MarketPanel(props) {
      const [kind, setKind] = useState(() => (readMarketUi().kind === "plugin" ? "plugin" : "modpack"))
      useEffect(() => { saveMarketKind(kind) }, [kind])
      const market = (props.status && props.status.market) || null
      const installed = Boolean(market && market.installed)
      const railBtn = (id, text, note) => h("button", {
        type: "button",
        key: "rail-" + id,
        onClick: () => setKind(id),
        style: {
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: "2px",
          width: "100%",
          padding: "9px 10px",
          borderRadius: "8px",
          border: kind === id ? "1px solid #4C7DF0" : "1px solid transparent",
          background: kind === id ? "rgba(76, 125, 240, 0.12)" : "transparent",
          color: "inherit",
          cursor: "pointer",
          textAlign: "left",
          fontSize: "13px",
          fontWeight: kind === id ? 600 : 400,
        },
      },
        h("span", null, text),
        note ? h("span", { style: { ...hint, fontSize: "11px", lineHeight: "15px" } }, note) : null)
      const rail = h("div", {
        style: {
          width: "152px",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          borderRight: "0.5px solid var(--dsw-alias-border-l2)",
          paddingRight: "10px",
          position: "sticky",
          top: 0,
        },
      },
        h("span", { style: { ...hint, padding: "0 2px 4px" } }, "大类"),
        railBtn("modpack", "整合包", "打包好的插件组合"),
        railBtn("plugin", "插件", installed ? "接入插件市场" : "需要插件市场"))
      return h("div", { style: { display: "flex", gap: "14px", alignItems: "flex-start" } },
        rail,
        h("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "10px" } },
          kind === "plugin" ? h(PluginBrowser, { status: props.status }) : h(ModpackBrowser, props)))
    }

    // 「插件」这一类不自己造目录：直接用插件市场的目录与检索（dsh-plugin-catalog），
    // 没装市场就没有这一层可看——所以先提示去装市场，而不是给一个空列表。
    function PluginBrowser(props) {
      const market = (props.status && props.status.market) || null
      const installed = Boolean(market && market.installed)
      const pluginSnap = readMarketUi().plugin || {}
      const [query, setQuery] = useState(typeof pluginSnap.query === "string" ? pluginSnap.query : "")
      const [category, setCategory] = useState(typeof pluginSnap.category === "string" ? pluginSnap.category : "all")
      const [sort, setSort] = useState(typeof pluginSnap.sort === "string" ? pluginSnap.sort : "market")
      const [items, setItems] = useState(Array.isArray(pluginSnap.items) ? pluginSnap.items : [])
      const [total, setTotal] = useState(Number(pluginSnap.total) || 0)
      const [page, setPage] = useState(Number(pluginSnap.page) || 1)
      const [hasMore, setHasMore] = useState(pluginSnap.hasMore === true)
      const [chips, setChips] = useState(Array.isArray(pluginSnap.chips) && pluginSnap.chips.length ? pluginSnap.chips : [{ id: "all", label: "全部", count: 0 }])
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState("")
      // 第一屏如果有上次留下的列表，就别再打一次请求（会闪一下、还把页码冲回 1）
      const restoredPlugins = useRef(Array.isArray(pluginSnap.items) && pluginSnap.items.length > 0)
      const applyItems = (data, append) => {
        const next = Array.isArray(data.items) ? data.items : []
        setItems(append ? (prev) => prev.concat(next) : next)
        setTotal(Number(data.total) || 0)
        setHasMore(Boolean(data.hasMore))
        if (Array.isArray(data.categories)) {
          setChips([{ id: "all", label: "全部", count: (data.summary && data.summary.count) || Number(data.total) || 0 }]
            .concat(data.categories.map((c) => ({ id: c.label, label: c.label, count: c.count || 0 }))))
        }
      }
      // 分类直接沿用插件市场目录的口径：服务端按 label 过滤，前端只拿一页
      // 退出程序前一直留着：搜索框文字、分类、排序、页码与已读到的列表
      useEffect(() => {
        saveMarketUi("plugin", { query, category, sort, items, total, page, hasMore, chips })
      }, [query, category, sort, items, total, page, hasMore, chips])
      useEffect(() => {
        if (!installed) return undefined
        if (restoredPlugins.current) { restoredPlugins.current = false; return undefined }
        let alive = true
        const timer = setTimeout(() => {
          setLoading(true)
          api("/catalog/search", { query, category, sort, page: 1, pageSize: 20 })
            .then((data) => {
              if (!alive) return
              applyItems(data, false)
              setPage(1)
              setError(data && data.ok === false ? (data.error || "") : "")
            })
            .catch((e) => { if (alive) setError((e && e.message) || String(e)) })
            .finally(() => { if (alive) setLoading(false) })
        }, 220)
        return () => { alive = false; clearTimeout(timer) }
      }, [installed, query, category, sort])
      const loadMore = async () => {
        if (!hasMore || loading) return
        setLoading(true)
        try {
          const data = await api("/catalog/search", { query, category, sort, page: page + 1, pageSize: 20 })
          if (data && data.ok) { applyItems(data, true); setPage(page + 1) }
        } catch (e) {
          setError((e && e.message) || String(e))
        } finally {
          setLoading(false)
        }
      }
      if (!installed) {
        return h("div", { style: { border: "1px dashed var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "8px" } },
          h("span", { style: strong }, "请先安装插件市场"),
          h("span", { style: hint }, "「插件」这一类直接读插件市场（dshmarket）的目录与检索，功能基于插件市场；没装就没有这一层可看。"),
          h("span", { style: hint }, "装好插件市场后回到这里，左边这一项会变成「接入插件市场」，列表也就有了。"))
      }
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
        h("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" } },
          h("div", { style: { ...row, justifyContent: "space-between" } },
            h("span", { style: { ...strong, fontSize: "13px" } }, "搜索插件"),
            h("span", { style: hint }, "跟打包页同一套：分类、搜索、已装优先；目录与检索都来自插件市场（dsh-plugin-catalog）")),
          h("div", { style: { display: "grid", gridTemplateColumns: "minmax(160px, 1fr) 160px 120px", gap: "8px", alignItems: "center" } },
            h("input", {
              type: "search",
              value: query,
              placeholder: "插件名 / 作者 / 描述（例如 记忆、壁纸、侧边栏）",
              onChange: (event) => setQuery(event.target.value),
              style: { height: "30px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit", fontSize: "12.5px", padding: "0 8px" },
            }),
            h("select", {
              value: sort,
              onChange: (event) => setSort(event.target.value),
              style: { height: "30px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit", fontSize: "12.5px" },
            }, [["market", "按相关度"], ["new", "最新发布"], ["name", "按名字"]].map(([value, text]) => h("option", { key: value, value }, text))),
            h("span", { style: { ...hint, textAlign: "right" } }, loading ? "搜索中…" : "共 " + total + " 个")),
          h(CategoryChips, { chips, value: category, onChange: setCategory })),
        error ? h("div", { style: { ...hint, color: "#ff6b6b", lineHeight: "19px" } }, String(error)) : null,
        loading && items.length === 0 ? h("div", { style: { ...hint, padding: "14px 2px" } }, "正在读取插件目录…") : null,
        !loading && items.length === 0 && !error
          ? h("div", { style: { border: "1px dashed var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "6px" } },
            h("span", { style: strong }, query ? "没有匹配的插件" : "插件目录还是空的"),
            h("span", { style: hint }, query ? "换个说法试试：插件名、作者名、描述里的词都能搜。" : "插件市场还没建过目录索引：去插件市场里刷一次，或等它自己更新。"))
          : null,
        h("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", overflow: "hidden" } },
          items.map((item) => h("div", {
            key: "plug-" + item.name,
            style: { display: "flex", flexDirection: "column", gap: "3px", padding: "9px 12px", borderBottom: "0.5px solid var(--dsw-alias-border-l2)" },
          },
            h("div", { style: row },
              h("span", { style: { fontSize: "13px", fontWeight: 600 } }, item.title || item.name),
              h(Tag, null, item.categoryLabel || item.category || "其它"),
              item.installed ? h("span", { style: { ...hint, color: "#2bb673" } }, "本机已装" + (item.updateAvailable ? "（市场版 " + item.version + " 更新）" : "")) : null,
              h("span", { style: { ...hint, marginLeft: "auto" } }, item.version ? "v" + item.version : "")),
            h("span", { style: hint }, item.description || "作者没写说明。"),
            h("span", { style: { ...hint, fontSize: "11.5px" } }, item.name)))),
        hasMore ? h("div", { style: row },
          h("button", { type: "button", style: btn, disabled: loading, onClick: loadMore }, loading ? "读取中…" : "加载更多")) : null,
        h("div", { style: hint }, "装 / 更新 / 卸载插件仍在插件市场里做：这一层只按它的目录浏览与检索，不重复实现一套安装。"))
    }

    // ===== [区块] 页签三：社区资源：整合包浏览（列表 / 详情 / 上传规则） =====
    function ModpackBrowser(props) {
      const packSnap = readMarketUi().pack || {}
      const [view, setView] = useState(packSnap.view === "detail" || packSnap.view === "rules" ? packSnap.view : "list")
      const [summary, setSummary] = useState(packSnap.summary || null)
      const [items, setItems] = useState(Array.isArray(packSnap.items) ? packSnap.items : [])
      const [total, setTotal] = useState(Number(packSnap.total) || 0)
      const [page, setPage] = useState(Number(packSnap.page) || 1)
      const [hasMore, setHasMore] = useState(packSnap.hasMore === true)
      const [query, setQuery] = useState(typeof packSnap.query === "string" ? packSnap.query : "")
      const [category, setCategory] = useState(typeof packSnap.category === "string" ? packSnap.category : "all")
      const [sort, setSort] = useState(typeof packSnap.sort === "string" ? packSnap.sort : "new")
      const [loading, setLoading] = useState(!(packSnap.dataReady === true))
      const [searching, setSearching] = useState(false)
      const [syncing, setSyncing] = useState(false)
      const [error, setError] = useState("")
      const [msg, setMsg] = useState("")
      const [detail, setDetail] = useState(packSnap.detail || null)
      const [descOpen, setDescOpen] = useState(packSnap.descOpen !== false)
      const [descTick, setDescTick] = useState(0)
      const [downloading, setDownloading] = useState(false)
      const [reloadKey, setReloadKey] = useState(0)
      const [searchTick, setSearchTick] = useState(0)
      const mounted = useRef(true)
      useEffect(() => () => { mounted.current = false }, [])
      // 退出程序前一直留着：搜索框文字、分类、排序、页码、读到的列表、打开着的详情/规则页
      useEffect(() => {
        saveMarketUi("pack", { view, summary, items, total, page, hasMore, query, category, sort, detail, dataReady: true })
      }, [view, summary, items, total, page, hasMore, query, category, sort, detail])

      // 打开详情时补齐插件介绍：包里写了就用包里的，没写就问插件市场的目录
      useEffect(() => {
        if (view !== "detail" || !detail) return undefined
        const plugins = Array.isArray(detail.plugins) ? detail.plugins : []
        const missing = plugins
          .filter((plugin) => plugin && plugin.name && !(plugin.description && String(plugin.description).trim()) && !hasPluginDesc(plugin.name))
          .map((plugin) => plugin.name)
        if (missing.length === 0) return undefined
        let alive = true
        api("/catalog/lookup", { names: missing.slice(0, 200) })
          .then((data) => {
            if (!alive) return
            const items = (data && data.items) || {}
            let hit = 0
            for (const name of missing) {
              const item = items[name]
              // 市场里没有的也记一笔空值：下次打开这份详情不再重复问
              pluginDescCache.set(name, item && item.description ? item : { description: "" })
              if (item && item.description) hit += 1
            }
            if (hit > 0) setDescTick((n) => n + 1)
          })
          .catch(() => {})
        return () => { alive = false }
      }, [view, detail])

      const pluginDescOf = (plugin) => {
        if (plugin.description && String(plugin.description).trim()) return String(plugin.description)
        const cached = cachedPluginDesc(plugin.name)
        if (cached) return cached
        return "插件市场里没有它的介绍。"
      }

      const applyData = (data) => {
        if (!data) return
        if (data.summary) setSummary(data.summary)
        setItems(Array.isArray(data.items) ? data.items : [])
        setTotal(Number(data.total) || 0)
        setHasMore(Boolean(data.hasMore))
      }

      const restoredPack = useRef(packSnap.dataReady === true)
      useEffect(() => {
        if (restoredPack.current) { restoredPack.current = false; return undefined }
        let alive = true
        setLoading(true)
        api("/market").then((data) => {
          if (!alive) return
          applyData(data)
          setError("")
        }).catch((e) => { if (alive) setError((e && e.message) || String(e)) }).finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
      }, [reloadKey])

      const retry = () => { setError(""); setMsg(""); setLoading(true); setReloadKey((n) => n + 1) }

      // 搜索 / 分类 / 排序都走服务端分页：客户端只拿一页，目录再大也不卡
      const skipFirstSearch = useRef(packSnap.dataReady === true)
      useEffect(() => {
        if (loading) return undefined
        // 回来时上次的列表还在，没必要为同一组条件再查一遍
        if (skipFirstSearch.current) { skipFirstSearch.current = false; return undefined }
        let alive = true
        const timer = setTimeout(() => {
          setSearching(true)
          api("/market/search", { query, category, sort, page: 1, pageSize: 20 })
            .then((data) => { if (alive) { applyData(data); setError(data && data.ok === false ? (data.error || "") : "") } })
            .catch((e) => { if (alive) setError((e && e.message) || String(e)) })
            .finally(() => { if (alive) setSearching(false) })
        }, 240)
        return () => { alive = false; clearTimeout(timer) }
      }, [query, category, sort, searchTick])

      const loadMore = async () => {
        if (!hasMore || searching) return
        setSearching(true)
        try {
          const data = await api("/market/search", { query, category, sort, page: page + 1, pageSize: 20 })
          if (data && data.ok) {
            setItems((prev) => prev.concat(data.items))
            setPage(page + 1)
            setHasMore(Boolean(data.hasMore))
          }
        } catch (e) {
          setError((e && e.message) || String(e))
        } finally {
          setSearching(false)
        }
      }

      const syncNow = async () => {
        setSyncing(true); setError(""); setMsg("")
        try {
          const data = await api("/market/sync", { force: true })
          if (data && data.ok) { applyData(data); setMsg("目录已更新") } else { setError((data && data.error) || "更新失败") }
        } catch (e) {
          setError((e && e.message) || String(e))
        } finally {
          setSyncing(false)
        }
      }

      const download = async (pack) => {
        setDownloading(true); setError(""); setMsg("")
        try {
          const data = await api("/market/download", { id: pack.id })
          if (!data || data.ok !== true) { setError((data && data.error) || "下载失败"); return }
          requestInstall({ token: data.token, fileName: data.fileName, packName: pack.name })
          setMsg("已下载并读取：" + pack.name + "，正在转到安装页")
          if (typeof props.onGoInstall === "function") props.onGoInstall()
        } catch (e) {
          setError((e && e.message) || String(e))
        } finally {
          setDownloading(false)
        }
      }

      // 分类英文名（目录里只存中文 label，英文界面在这里映射）
      const catLabel = (name) => name
      const CATEGORY_TINT = { 工作办公: "#4C7DF0", 性能优化: "#2bb673", 界面美化: "#a855f7", 实用功能: "#0ea5e9", 开发调试: "#f59e0b", 娱乐休闲: "#ec4899", 学习资料: "#14b8a6", 水槽: "#7c3aed", 其它: "#64748b" }
      const initialsOf = (name) => String(name || "?").replace(/\s+/gu, "").slice(0, 2) || "?"
      // 体量词条：不靠作者写，按插件总数自动算（0-3 轻量 / 4-8 中型 / 9-12 大型 / 13+ 大宗）
      const TIER_LABELS = { small: "轻量", medium: "中型", large: "大型", huge: "大宗" }
      const TIER_COLORS = { small: "#2bb673", medium: "#0ea5e9", large: "#f59e0b", huge: "#ec4899" }
      const tierInfo = (pack) => {
        const count = Array.isArray(pack.plugins) ? pack.plugins.length : 0
        const id = pack.tier || (count >= 13 ? "huge" : count >= 9 ? "large" : count >= 4 ? "medium" : "small")
        return { id, color: TIER_COLORS[id] || "#64748b", text: TIER_LABELS[id] || "轻量" }
      }
      const tierTag = (pack) => {
        const info = tierInfo(pack)
        return h("span", { key: "tier-" + pack.id, style: { ...hint, color: info.color, border: "0.5px solid " + info.color, borderRadius: "99px", padding: "0 6px", lineHeight: "16px" } }, info.text)
      }
      const categories = (summary && summary.categories) || []
      const chips = [{ id: "all", label: "全部", count: (summary && summary.count) || 0 }].concat(
        categories.map((c) => ({ id: c.label, label: catLabel(c.label), count: c.count || 0 })),
      )
      const present = Boolean(summary && summary.present)
      const sizeText = (bytes) => (bytes >= 1024 * 1024 ? Math.round((bytes / 1024 / 1024) * 10) / 10 + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB")
      const compact = (value) => {
        const n = Number(value) || 0
        return n >= 10000 ? (n / 10000).toFixed(1) + " 万" : String(n)
      }
      // 目录里没有图片资源，就用名字前两个字做一块底色方块，跟 PCL 那种「占位图标」一个意思
      const descOf = (pack) => {
        const d = (pack && pack.description) || {}
        const text = d.zh || d.en
        return text || "作者没写说明。"
      }
      const renderRow = (pack) => {
        const tint = CATEGORY_TINT[pack.category] || "#64748b"
        const plugins = pack.plugins || []
        const meta = []
        meta.push(plugins.length + " 个插件")
        meta.push(sizeText(pack.size))
        meta.push(pack.downloads === null || pack.downloads === undefined ? "下载量未统计" : "下载 " + compact(pack.downloads))
        if (pack.updatedAt) meta.push("更新 " + String(pack.updatedAt).slice(0, 10))
        else if (pack.createdAt) meta.push("创建 " + String(pack.createdAt).slice(0, 10))
        if (pack.author) meta.push("作者 " + pack.author)
        return h("div", {
          key: "pack-" + pack.id,
          onClick: () => { setDetail(pack); setView("detail"); setError(""); setMsg("") },
          style: { display: "flex", gap: "10px", padding: "10px 12px", borderTop: "0.5px solid var(--dsw-alias-border-l2)", cursor: "pointer", alignItems: "flex-start" },
        },
          h("div", {
            style: {
              width: "42px", height: "42px", flexShrink: 0, borderRadius: "8px",
              background: tint, color: "#fff", fontSize: "13px", fontWeight: 600,
              display: "flex", alignItems: "center", justifyContent: "center", letterSpacing: "0.5px",
            },
          }, initialsOf(pack.name)),
          h("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" } },
            h("div", { style: row },
              h("span", { style: { fontWeight: 600, fontSize: "13.5px" } }, pack.name),
              h(Tag, null, catLabel(pack.category || "其它")),
              tierTag(pack),
              h(Tag, null, "v" + pack.version),
              pack.installed && pack.installed.all ? h("span", { style: { ...hint, color: "#2bb673" } }, "已装") : null,
              pack.installed && pack.installed.some && !pack.installed.all ? h("span", { style: hint }, "部分已装") : null),
            h("span", { style: { ...hint, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", lineHeight: "18px" } }, descOf(pack)),
            h("div", { style: { ...row, gap: "14px" } }, meta.map((line, index) => h("span", { key: "meta-" + pack.id + "-" + index, style: hint }, line)))))
      }
      const resetFilters = () => { setQuery(""); setCategory("all"); setSort("new"); setPage(1); setSearchTick((n) => n + 1) }

      const head = h("div", { style: { ...row, justifyContent: "space-between" } },
        h("div", { style: row },
          h("span", { style: { ...strong, fontSize: "14px" } }, "社区资源"),
          present ? h(Tag, null, total + " 个") : null,
          present ? h("span", { style: hint }, "目录来自 " + (summary.repo || "dsh-modpack-catalog") + (summary.builtAt ? " · 构建于 " + String(summary.builtAt).slice(0, 10) : "")) : null),
        h("div", { style: row },
          h("button", { type: "button", style: chipBtn, onClick: () => { setView("rules"); setDetail(null) } }, "上传方式与规则"),
          h("button", { type: "button", style: chipBtn, disabled: syncing, onClick: syncNow }, syncing ? "更新中…" : "更新目录")))

      if (view === "rules") {
        return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
          h("div", { style: row },
            h("button", { type: "button", style: chipBtn, onClick: () => setView("list") }, "← 返回市场"),
            h("span", { style: { ...strong, fontSize: "14px" } }, "上传方式与规则")),
          h("div", { style: { ...hint, lineHeight: "20px" } }, "第一阶段只收轻量包；审核与出问题下架都靠 PR 与 issue，和插件市场一样。"),
          h("ol", { style: { margin: 0, paddingLeft: "18px", display: "flex", flexDirection: "column", gap: "8px" } },
            MARKET_RULES.map((line, index) => h("li", { key: "rule-" + index, style: { fontSize: "12.5px", lineHeight: "19px" } }, line))),
          h("div", { style: { border: "1px dashed var(--dsw-alias-border-l2)", borderRadius: "8px", padding: "10px", display: "flex", flexDirection: "column", gap: "4px" } },
            h("span", { style: strong }, "清单长这样"),
            h("code", { style: { fontSize: "11.5px", whiteSpace: "pre-wrap", lineHeight: "17px" } },
              '{\n  "id": "bili-trio",\n  "category": "实用功能",\n  "file": "bili-trio-lite.dshpack",\n  "sha256": "…64 位…",\n  "createdAt": "2026-11-27",\n  "updatedAt": "2026-11-27",\n  "homepage": ""\n}\n\n// 名称、作者、介绍、插件清单不写在这里：\n// 全部取包里的 dsh-modpack.json（打包时填的）')),
          h("div", { style: hint }, "仓库：github.com/" + (summary && summary.repo ? summary.repo : "Vesna-Strivozha-cn/dsh-modpack-catalog") + " · 照着上面 1~5 步走：包进 packs/、清单进 data/packs/、本地 build 过了再提 PR；合并后每天 03:17 UTC 重建，也可以在 Actions 手动 Run workflow。"))
      }

      if (view === "detail" && detail) {
        const pack = detail
        const plugins = pack.plugins || []
        const downloadCode = [pack.url || "", "sha256: " + (pack.sha256 || ""), "size: " + pack.size + " 字节"].join("\n")
        return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
          h("div", { style: row },
            h("button", { type: "button", style: chipBtn, onClick: () => { setView("list"); setDetail(null) } }, "← 返回列表"),
            h("span", { style: { ...strong, fontSize: "15px" } }, pack.name),
            h(Tag, null, catLabel(pack.category || "其它")),
            tierTag(pack),
            h("span", { style: hint }, "v" + pack.version + " · 作者 " + (pack.author || "?") + " · " + sizeText(pack.size) + " · " + plugins.length + " 个插件")),
          h("div", { style: { ...hint, lineHeight: "20px" } },
            pack.downloads === null || pack.downloads === undefined
              ? "下载量：暂无统计（安装文件放在 Git 仓库里，没有逐文件计数；放进 GitHub Release 资源才拿得到真实下载数）"
              : "下载 " + Number(pack.downloads) + " 次（这个安装文件本身的下载量，不是里面插件的）"
            + " · 创建 " + (pack.createdAt ? String(pack.createdAt).slice(0, 10) : "未记录")
            + " · 上次更新 " + (pack.updatedAt ? String(pack.updatedAt).slice(0, 10) : (pack.createdAt ? String(pack.createdAt).slice(0, 10) : "未记录"))),
          h("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" } },
            h("span", { style: strong }, "这个整合包是做什么的"),
            h("div", { style: { fontSize: "12.5px", lineHeight: "20px" } }, descOf(pack)),
            pack.installed && pack.installed.all
              ? h("div", { style: { ...hint, color: "#2bb673" } }, "这台机器上已经装齐了它包含的插件，可以只下载留存或再装一遍。")
              : pack.installed && pack.installed.some
                ? h("div", { style: hint }, "本机已装 " + pack.installed.count + " / " + plugins.length + " 个，安装时会先跳过已装的那些。")
                : null),
          h("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "12px", display: "flex", flexDirection: "column", gap: "6px" } },
            h("div", { style: { ...row, justifyContent: "space-between" } },
              h("span", { style: strong }, "包含的插件（这些插件会干什么）"),
              plugins.length === 0 ? null : h("button", {
                type: "button",
                style: chipBtn,
                title: descOpen ? "只留插件名与版本" : "显示每个插件在插件市场里的介绍",
                onClick: () => setDescOpen(!descOpen),
              }, descOpen ? "收起介绍" : "显示介绍")),
            plugins.length === 0
              ? h("span", { style: hint }, "清单里没有插件记录。")
              : plugins.map((plugin) => h("div", { key: "p-" + plugin.name, style: { display: "flex", flexDirection: "column", gap: "2px", borderTop: "0.5px solid var(--dsw-alias-border-l2)", paddingTop: "6px" } },
                h("div", { style: row },
                  h("span", { style: { fontSize: "12.5px", fontWeight: 600 } }, plugin.name),
                  h(Tag, null, plugin.version ? "@" + plugin.version : "@市场最新")),
                descOpen ? h("span", { style: hint }, pluginDescOf(plugin)) : null)),
            h("span", { style: hint }, "安装时按上面的版本从插件市场取包；取不到就明确报错，不会拿别的东西顶替。"),
            h("span", { style: hint }, "这里只数清单里的顶层插件；像壁纸引擎那样由插件自己带的一组组件不算在里面，装好后由那个插件自己管理。")),
          h("div", { style: { border: "1px dashed var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "12px", display: "flex", flexDirection: "column", gap: "6px" } },
            h("span", { style: strong }, "下载码"),
            h("code", { style: { fontSize: "11.5px", whiteSpace: "pre-wrap", lineHeight: "17px", wordBreak: "break-all" } }, downloadCode),
            h("span", { style: hint }, "下载码就是包的直链 + sha256：谁拿到都能自己下载核对，不依赖这个界面。")),
          error ? h("div", { style: { ...hint, color: "#ff6b6b" } }, error) : null,
          msg ? h("div", { style: hint }, msg) : null,
          h("div", { style: row },
            h("button", { type: "button", style: btnPrimary, disabled: downloading, onClick: () => download(pack) }, downloading ? "下载中…" : "下载并安装"),
            h("span", { style: hint }, "下载后在内存里校验 sha256、跑一遍安全检测，再转到安装页读取；半成品不会留在磁盘上。")))
      }

      const searchCard = h("div", {
        style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "12px", display: "flex", flexDirection: "column", gap: "10px" },
      },
        h("div", { style: { ...row, justifyContent: "space-between" } },
          h("span", { style: { ...strong, fontSize: "13px" } }, "搜索整合包"),
          h("span", { style: hint }, "目录里现在有 " + ((summary && summary.count) || 0) + " 个" + (summary && summary.builtAt ? " · 构建于 " + String(summary.builtAt).slice(0, 10) : ""))),
        h("div", { style: { display: "grid", gridTemplateColumns: "56px minmax(160px, 1fr) 56px 150px 56px 130px", gap: "8px 10px", alignItems: "center" } },
          h("span", { style: hint }, "名称"),
          h("input", {
            type: "search",
            value: query,
            placeholder: "整合包名 / 作者 / 插件名（例如 B站、壁纸、记忆）",
            onChange: (event) => { setQuery(event.target.value); setPage(1) },
            style: { height: "30px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit", padding: "0 8px", fontSize: "12.5px" },
          }),
          h("span", { style: hint }, "类型"),
          h("select", {
            value: category,
            onChange: (event) => { setCategory(event.target.value); setPage(1) },
            style: { height: "30px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit", fontSize: "12.5px" },
          }, chips.map((chip) => h("option", { key: "sel-" + chip.id, value: chip.id }, chip.label + "（" + (chip.count || 0) + "）"))),
          h("span", { style: hint }, "排序"),
          h("select", {
            value: sort,
            onChange: (event) => { setSort(event.target.value); setPage(1) },
            style: { height: "30px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit", fontSize: "12.5px" },
          }, MARKET_SORTS.map(([value, text]) => h("option", { key: value, value }, text)))),
        h("div", { style: row },
          h("button", { type: "button", style: { ...btn, minWidth: "96px" }, disabled: searching, onClick: () => setSearchTick((n) => n + 1) }, searching ? "搜索中…" : "搜索"),
          h("button", { type: "button", style: { ...btn, minWidth: "96px" }, onClick: resetFilters }, "重置条件"),
          h("button", { type: "button", style: { ...btn, minWidth: "128px" }, onClick: () => { if (typeof props.onGoInstall === "function") props.onGoInstall() } }, "安装已有整合包"),
          h("span", { style: { ...hint, marginLeft: "auto" } }, "共 " + total + " 个")))

      const emptyCard = h("div", { style: { border: "1px dashed var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "16px", display: "flex", flexDirection: "column", gap: "8px" } },
        h("span", { style: strong }, query ? "没有匹配的整合包" : present ? "这个类型下还没有整合包" : "还没有整合包目录"),
        h("span", { style: hint }, query
          ? "换个说法试试：整合包名、作者名、插件名都能搜。"
          : present
            ? "目录是通的，只是这一类还没有人提交；换个类型看看，或去「上传方式与规则」自己提交一个。"
            : "第一次用要先从目录仓库拉一次清单（只有几百 KB）。"),
        h("div", { style: row },
          query ? h("button", { type: "button", style: btn, onClick: resetFilters }, "清空条件") : null,
          h("button", { type: "button", style: { ...btn, minWidth: "96px" }, disabled: syncing || loading, onClick: syncNow }, syncing ? "更新中…" : "更新目录"),
          h("button", { type: "button", style: btn, disabled: loading, onClick: retry }, "重试"),
          h("button", { type: "button", style: chipBtn, onClick: () => { setView("rules"); setDetail(null) } }, "上传方式与规则")),
        /重启|HTTP 40[45]|连不上/u.test(String(error || ""))
          ? h("span", { style: { ...hint, lineHeight: "19px" } }, "网络正常但接口报 404/405 的话，是宿主还跑着旧代码：把 DSH 完全退出再打开，这一栏就会生效。")
          : null)

      const listBox = items.length > 0
        ? h("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", overflow: "hidden" } }, items.map(renderRow))
        : null

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
        head,
        searchCard,
        loading && items.length === 0 ? h("div", { style: { ...hint, padding: "14px 2px" } }, "正在读取整合包目录…") : null,
        error ? h("div", { style: { ...hint, color: "#ff6b6b", lineHeight: "19px" } }, String(error)) : null,
        msg ? h("div", { style: hint }, msg) : null,
        listBox,
        !loading && items.length === 0 ? emptyCard : null,
        hasMore ? h("button", { type: "button", style: btn, disabled: searching, onClick: loadMore }, searching ? "加载中…" : "加载更多") : null)
    }

    // ===== [区块] 外壳：页签、刷新、彩蛋、进度窗挂载：Home =====
    function Home(props) {
      const [tab, setTab] = useState("pack")
      const jobs = useJobs()
      const status = props.status
      const surface = (props && props.surface) || "sidebar"
      // 插件页里的那一栏外面已经有一层页头与标签：嵌进去不能再摆一遍大标题，
      // 否则同一屏里会出现两个名字、两套边距，看着像画坏了。
      const embedded = surface === "plugins"
      const [packResult, setPackResult] = useState(() => readPackValue())
      const [focus, setFocus] = useState(0)
      const [unlag, setUnlag] = useState(null)
      const [unlagMsg, setUnlagMsg] = useState("")
      // 解除卡顿是别人家的插件：有就出按钮，没有就什么都不显示。
      useEffect(() => {
        let alive = true
        detectUnlag().then((data) => { if (alive) setUnlag(data) })
        return () => { alive = false }
      }, [])
      const pressUnlagNow = async () => {
        setUnlagMsg("正在让解除卡顿整理…")
        try {
          const data = await pressUnlag()
          const status = data && (data.status || data.verdict)
          setUnlagMsg(status ? ("解除卡顿：" + status) : "已请求，稍等一下看结果")
        } catch (e) {
          setUnlagMsg((e && e.message) || String(e))
        }
      }
      // 开机把市场的侧栏入口按设置再关一次：市场自己每次启动都会把它打开。
      const forceHideMarket = !!(status && status.config && status.config.forceHideMarketSidebar === true)
      useEffect(() => {
        if (!forceHideMarket) return
        let alive = true
        readMarketSidebar().then((data) => {
          if (!alive || !data || data.enabled !== true) return
          writeMarketSidebar(false).catch(() => {})
        })
        return () => { alive = false }
      }, [forceHideMarket])
      useEffect(() => subscribePack((value) => { setPackResult(value) }), [])
      // 「社区资源」这一栏开不开：用模块级状态，设置里一关标签立刻消失，切回设置也不会又亮着
      const [marketOn, setMarketOn] = useState(() => readMarketVisible())
      useEffect(() => subscribeMarketVisible((on) => { setMarketOn(on) }), [])
      const savePackResult = (value) => {
        setPackValue(value)
        setPackResult(value)
      }
      // 进度窗里点「下载安装包」→ 切到打包页、把那次的结果放进去、滚到下载那一块
      const openResult = (job) => {
        const payload = job && job.data ? job.data : null
        if (!payload) return
        savePackResult(payload)
        setTab("pack")
        setFocus((n) => n + 1)
      }
      const [refreshing, setRefreshing] = useState(false)
      const [refreshedAt, setRefreshedAt] = useState(0)
      const [refreshMsg, setRefreshMsg] = useState("")
      const [refreshNote, setRefreshNote] = useState("")
      // 刷新只管整合包自己：重读本插件看到的状态，再把三个面板重挂一次让它们各自重新取数。
      // 不碰别的插件，也不调「解除卡顿」——那个插件有自己的按钮，各管各的。
      const doRefresh = async () => {
        if (refreshing) return
        setRefreshing(true)
        setRefreshMsg("")
        setRefreshNote("")
        try {
          if (typeof props.onRefresh === "function") await props.onRefresh()
          setRefreshNote("已重新读取整合包自己的状态")
          setRefreshedAt(Date.now())
        } catch (e) {
          setRefreshMsg("刷新失败：" + String((e && e.message) || e))
        } finally {
          setRefreshing(false)
        }
      }
      const gen = props.gen || 0
      const refreshBtn = h("button", {
        type: "button",
        style: chipBtn,
        disabled: refreshing,
        title: "只刷新整合包自己：重新读一遍插件列表、市场目录与进度窗，再把三个面板重挂一次；不调用别的插件",
        onClick: doRefresh,
      }, refreshing ? "刷新中…" : (refreshMsg ? "刷新失败" : refreshedAt ? "刷新 ✓" : "刷新"))
      // 拖到角上挡住界面时用这个：位置清掉、回到右下角默认位，并且强制显示
      const recallBtn = h("button", {
        type: "button",
        style: { ...chipBtn, background: "#4C7DF0", borderColor: "#4C7DF0", color: "#fff", fontWeight: 600 },
        title: "把进度窗叫回右下角的默认位置（拖到角落挡住了界面就用这个）",
        onClick: () => { requestDockReset() },
      }, "召回进度窗")
      const [eggMsg, setEggMsg] = useState("")
      const eggClicks = useRef([])
      const eggTimer = useRef(0)
      useEffect(() => () => { if (eggTimer.current) clearTimeout(eggTimer.current) }, [])
      const spotEgg = () => {
        const now = Date.now()
        eggClicks.current = eggClicks.current.concat(now).filter((at) => now - at < 1500)
        if (eggClicks.current.length < 5) return
        eggClicks.current = []
        setEggMsg("不不不，我资源无疑是贫乏的")
        if (eggTimer.current) clearTimeout(eggTimer.current)
        eggTimer.current = setTimeout(() => { eggTimer.current = 0; setEggMsg("") }, 1000)
      }
      const eggNode = eggMsg
        ? h("div", {
          style: {
            position: "fixed",
            left: "50%",
            bottom: "88px",
            transform: "translateX(-50%)",
            background: "rgba(18, 20, 26, 0.92)",
            color: "#fff",
            padding: "9px 16px",
            borderRadius: "10px",
            fontSize: "13px",
            letterSpacing: "0.02em",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.28)",
            pointerEvents: "none",
            zIndex: 80,
          },
        }, eggMsg)
        : null
      const tabs = [
        ["pack", "打包"],
        ["install", "安装 / 导入"],
        ...(marketOn ? [["market", "社区资源"]] : []),
        ["settings", "设置与记录"],
      ]
      const tabBtn = (key, text) => h("button", {
        key,
        onClick: () => { setTab(key); if (key === "market") spotEgg() },
        style: {
          ...btn,
          fontSize: embedded ? "12px" : btn.fontSize,
          padding: embedded ? "3px 9px" : btn.padding,
          borderColor: tab === key ? "transparent" : "var(--dsw-alias-border-l2)",
          background: tab === key ? "var(--dsw-alias-fill-primary, #3b6cf6)" : "transparent",
          color: tab === key ? "#fff" : "var(--dsw-alias-label-primary)",
        },
      }, text)

      const panels = [
        tab === "pack" ? h(PackPanel, { key: "pack-" + gen, status, jobs, result: packResult, setResult: savePackResult, focus }) : null,
        tab === "install" ? h(InstallPanel, { key: "install-" + gen, status }) : null,
        tab === "market" ? h(MarketPanel, { key: "market-" + gen, status, onGoInstall: () => setTab("install") }) : null,
        tab === "settings" ? h(SettingsPanel, { key: "settings-" + gen, status }) : null,
      ]
      // 这段是打包/安装的安全说明，社区资源里不该出现（那里是逛目录，不是打包）
      const footNote = tab === "market" ? null : h("div", { style: hint }, "说明：整合包只打包你选择的插件与必要配置。打包与安装安全检测在内存中进行，命中原文不落盘；请遵守插件作者许可证与你所在地区的法律法规。")
      const unlagNode = unlag
        ? h("div", { style: row },
          h("button", {
            type: "button",
            style: chipBtn,
            title: "来自插件市场的 dsh-unlag@" + (unlag.version || "?") + "（不是本插件的功能：装了才有）",
            onClick: pressUnlagNow,
          }, "解除卡顿"),
          unlagMsg ? h("span", { style: hint }, unlagMsg) : null)
        : null
      useEffect(() => {
        if (!refreshedAt) return undefined
        const timer = setTimeout(() => { setRefreshedAt(0); setRefreshNote("") }, 2400)
        return () => clearTimeout(timer)
      }, [refreshedAt])
      const envLine = h("span", { style: { ...hint, marginLeft: "auto" } },
        status ? ("DSH " + (status.dshVersion || "?") + " · 已装 " + ((status.installed || []).length) + " 个 · v" + (status.pluginVersion || "?")) : "读取环境…")

      // 嵌在插件页标签里：不重复页头，也不自己再造一层滚动区——外层插件页本来就会滚，
      // 里面再套一个固定高度的滚轮，遇到外层高度是 auto 时会被压成一条缝。
      if (embedded) {
        return h("div", {
          style: {
            display: "flex",
            flexDirection: "column",
            color: "var(--dsw-alias-label-primary)",
            padding: "10px 2px 24px",
            position: "relative",
          },
        },
          h("div", { style: { maxWidth: "1020px", margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: "10px" } },
            h("div", { style: row }, tabs.map(([key, text]) => tabBtn(key, text)), envLine, refreshNote ? h("span", { style: hint }, refreshNote) : null, refreshMsg ? h("span", { style: { ...hint, color: "#ff6b6b" } }, refreshMsg) : null, recallBtn, refreshBtn),
          eggNode,
          unlagNode,
            panels,
            footNote,
            h(RepoFooter, null)),
          h(JobDock, { jobs, onOpenResult: openResult })
        )
      }

      return h("div", {
        style: { height: "100%", overflow: "auto", boxSizing: "border-box", padding: "22px 26px 44px", color: "var(--dsw-alias-label-primary)", position: "relative" },
      },
        h("div", { style: { maxWidth: "1020px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "14px" } },
          h("div", { style: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" } },
            h("h2", { style: { margin: 0, fontSize: "20px", fontWeight: 600 } }, "整合包"),
            h("span", { style: hint }, ((status && status.config && status.config.tagline) || "谁说 dsh 不能整整合包呢？（你说这几个插件整一块不牛逼坏了）"))),
          h("div", { style: row }, tabs.map(([key, text]) => tabBtn(key, text)), envLine, refreshNote ? h("span", { style: hint }, refreshNote) : null, refreshMsg ? h("span", { style: { ...hint, color: "#ff6b6b" } }, refreshMsg) : null, recallBtn, refreshBtn),
          eggNode,
          panels,
          footNote,
          h(RepoFooter, null)),
        h(JobDock, { jobs, onOpenResult: openResult })
      )
    }

    function Icon(props) {
      const size = (props && props.size) || 16
      return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { d: "M2.2 5.2 8 2.3l5.8 2.9v5.6L8 13.7l-5.8-2.9z" }),
        h("path", { d: "M2.2 5.2 8 8.1l5.8-2.9M8 8.1v5.6" }))
    }

    /** 用一个小组件包住面板，进入时拉一次状态，之后交给子面板。 */
    // ===== [区块] 页面入口：读 status、按显示位决定挂哪里：Page =====
    function Page(props) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState("")
      const [tries, setTries] = useState(0)
      const [gen, setGen] = useState(0)
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])
      // 宿主刚起来、会话还在建的时候，第一次可能拿不到状态（401/网络没就绪）。
      // 自己退避重试几次，别让用户看到一块红字或者一块空白。
      const load = useCallback(async (left) => {
        try {
          const data = await api("/status")
          if (!alive.current) return
          if (data && data.ok) {
            setStatus(data)
            setError("")
            if (data.config) { mergeLiveConfig(data.config); setMarketVisible(data.config.showModpackMarket !== false) }
            if (data.placements) setPlacement(data.placements)
            setTries(0)
            return
          }
          setError((data && data.error) || "读取状态失败")
        } catch (e) {
          if (!alive.current) return
          if (left > 0) {
            setTimeout(() => { load(left - 1) }, 500 * (4 - left))
            setTries(left)
            return
          }
          setError(String((e && e.message) || e))
        }
      }, [])
      useEffect(() => { load(3) }, [load])
      if (error) {
        return h("div", { style: { padding: "20px 24px", color: "#ff6b6b", fontSize: "13px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
          h("span", null, "整合包没起来：" + error),
          h("button", { type: "button", style: btn, onClick: () => { setError(""); setTries(0); load(3) } }, "重试"))
      }
      if (!status) {
        return h("div", { style: { padding: "20px 24px", color: "var(--dsw-alias-label-tertiary, #8b909b)", fontSize: "13px" } },
          tries > 0 ? "整合包：还在连 DSH 本体…（自动重试 " + tries + " 次）" : "整合包：读取环境…")
      }
      // 手动刷新：先重读 status，再把下面几个面板整体重挂一次（gen+1）。
      // 只重读 status 是不够的：面板里的插件清单、市场信息、目录分页都是挂载时拉一次，
      // 不重挂就不会重新取，看起来就像「按了没反应」。
      return h(Home, {
        status,
        surface: (props && props.surface) || "sidebar",
        gen,
        onRefresh: async () => {
          await load(3)
          setGen((n) => n + 1)
        },
      })
    }

    const inject = ["slots"]

    // 三处显示位各自注册什么。开关一翻就整组挂上 / 整组撤掉，不动别的插件。
    const PLACEMENT_MOUNTS = {
      settings: () => [
        { slot: "settings.section", spec: { name: "settings.section", id: "dsh-modpack-kit", order: 45, label: () => "整合包" }, Comp: () => h(Page, { surface: "settings" }) },
        { slot: "settings.plugins.tab", spec: { name: "settings.plugins.tab", id: "dsh-modpack-kit", order: 70, label: () => "整合包" }, Comp: () => h(Page, { surface: "plugins" }) },
      ],
      pluginsTab: () => [
        { slot: "plugins.tab", spec: { name: "plugins.tab", id: "dsh-modpack-kit", order: 1, label: () => "整合包" }, Comp: () => h(Page, { surface: "plugins" }) },
      ],
      sidebar: () => [
        { slot: "sidebar.panellist", spec: { name: "sidebar.panellist", id: "dsh-modpack-kit", order: 60, label: () => "整合包" }, Comp: Icon },
        { slot: "main", spec: { name: "main", key: "dsh-modpack-kit" }, Comp: () => h(Page, { surface: "sidebar" }) },
      ],
    }

    function apply(ctx) {
      const mounted = new Map()
      const mount = (group, item) => {
        const key = group + ":" + item.slot
        if (mounted.has(key)) return
        try {
          const off = ctx.slots.inject(item.slot, () => ctx.slots.register(item.spec, item.Comp))
          mounted.set(key, typeof off === "function" ? off : () => {})
        } catch (e) {
          // 某个宿主版本没有这个槽位时跳过，别的显示位照常
        }
      }
      const unmount = (key) => {
        const off = mounted.get(key)
        if (!off) return
        mounted.delete(key)
        try { off() } catch {}
      }
      const sync = (value) => {
        const want = normalizePlacement(value)
        for (const group of Object.keys(PLACEMENT_MOUNTS)) {
          const items = PLACEMENT_MOUNTS[group]()
          if (want[group]) for (const item of items) mount(group, item)
          else for (const item of items) unmount(group + ":" + item.slot)
        }
      }
      try {
        const workspace = ctx.get('uiWorkspace')
        if (workspace && typeof workspace.pickDirectory === "function") {
          pickDirectoryHost = () => workspace.pickDirectory()
        }
      } catch {}

      // 启动那一刻：/status 还没回来、插件页的槽位也还没被声明，插件页那条标签常常错过第一次机会。
      // 自己拉一次状态拿到开关，并在前十几秒补看几次——晚声明的槽位也能补挂上。
      const refreshPlacement = async (left) => {
        try {
          const data = await api("/status")
          if (data && data.ok && data.placements) setPlacement(data.placements)
          if (data && data.ok && data.config) { mergeLiveConfig(data.config); setMarketVisible(data.config.showModpackMarket !== false) }
          if (data && data.config && data.config.forceHideMarketSidebar === true) enforceMarketSidebarOff()
        } catch (e) {
          if (left > 0) setTimeout(() => { refreshPlacement(left - 1) }, 700 * (3 - left))
        }
      }

      ctx.effect(() => {
        const unsubscribe = subscribePlacement(sync)
        sync(placement.value)
        refreshPlacement(3)
        const timers = [900, 2600, 6000, 11000].map((ms) => setTimeout(() => sync(placement.value), ms))
        return () => {
          unsubscribe()
          for (const timer of timers) clearTimeout(timer)
          for (const key of [...mounted.keys()]) unmount(key)
        }
      }, "dsh-modpack-kit: 三处显示位")
    }

    exports.apply = apply
    exports.MarketPanel = MarketPanel
    // 自测用：社区资源那层「切页签也保留」的状态存在模块里，测试要能塞一份进去看恢复得对不对
    exports.__marketUi = marketUi
    exports.PluginBrowser = PluginBrowser
    exports.ModpackBrowser = ModpackBrowser
    exports.inject = inject
    exports.Page = Page
    exports.Home = Home
    exports.Icon = Icon

    return module.exports
  },
})
