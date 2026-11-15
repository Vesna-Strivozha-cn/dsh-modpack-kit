/**
 * dsh-modpack —— 客户端半边：左侧栏「整合包」。
 *
 * 三页：打包（挑插件、选版本、看检测报告）、安装（链接/本机包、预览、落地）、
 * 设置与记录（扫描策略、白名单、历史）。数据全部来自 /dsh-modpack/api/*（同源 fetch），
 * 与 host 半端共用同一份状态；这里不碰文件，也不做网络请求。
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
    const FORMAT_TEXT = { full: "完整版（含插件本体）", lite: "轻量版（联网取包）" }
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

    async function api(pathname, body) {
      const init = body === undefined ? { headers: { Accept: "application/json" } } : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      return h("label", { style: { display: "inline-flex", gap: "6px", alignItems: "center", fontSize: "12.5px", cursor: props.disabled ? "not-allowed" : "pointer", opacity: props.disabled ? 0.45 : 1 } },
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

    function ScanReport(props) {
      const scan = props.scan
      if (!scan) return null
      const findings = Array.isArray(scan.findings) ? scan.findings : []
      const counts = scan.counts || { high: 0, medium: 0, low: 0 }
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        h("div", { style: row },
          h("div", { style: strong }, "安全检测"),
          h(Tag, { color: counts.high ? "#ff6b6b" : counts.medium ? "#ffb020" : "#2bb673" },
            "高 " + counts.high + " · 中 " + counts.medium + " · 低 " + counts.low),
          h("span", { style: hint }, "扫描 " + (scan.scannedFiles || 0) + " 个文件 / " + bytes(scan.scannedBytes || 0) + (scan.note ? " · " + scan.note : ""))),
        findings.length
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", maxHeight: "190px", overflow: "auto" } },
            findings.slice(0, 120).map((f, i) => h("div", { key: i, style: { ...mono, color: LEVEL_COLOR[f.severity] || "inherit" } },
              "[" + String(f.severity || "").toUpperCase() + "] " + (f.label || f.rule) + " · " + f.file + (f.line ? ":" + f.line : "") + " · " + (f.masked || ""))))
          : h("div", { style: hint }, "没有命中敏感信息或可疑代码规则。"),
        h("div", { style: hint }, props.footNote || "命中内容只在内存里比对，报告只保留类型、位置与掩码，原文不落盘。"))
    }

    function CompatList(props) {
      const compat = props.compat
      if (!compat) return null
      const findings = compat.findings || []
      if (findings.length === 0) return h("div", { style: hint }, "兼容性：没有发现问题。")
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "5px" } },
        h("div", { style: row }, h("div", { style: strong }, "兼容性"), h("span", { style: hint }, compat.summary || ""),
          compat.blocking ? h(Tag, { color: "#ff6b6b" }, "有阻断项") : null),
        findings.map((f, i) => h("div", { key: i, style: { borderLeft: "2px solid " + (LEVEL_COLOR[f.level] || "transparent"), paddingLeft: "8px" } },
          h("div", { style: { ...label, color: LEVEL_COLOR[f.level] || "inherit" } }, (f.plugin ? f.plugin + "：" : "") + f.message),
          f.suggestion ? h("div", { style: hint }, "建议：" + f.suggestion) : null)))
    }

    // —— 打包 ——
    function PackPanel(props) {
      const status = props.status
      const pageSize = (status && status.config && status.config.catalogPageSize) || 20
      const [installed, setInstalled] = useState((status && status.installed) || [])
      const [marketInfo, setMarketInfo] = useState({})   // name -> 市场同名条目（标题/版本/分类）
      const [catalog, setCatalog] = useState((status && status.catalog) || { present: false, categories: [] })
      const [loading, setLoading] = useState(!(status && status.installed))
      const [selected, setSelected] = useState({})     // name -> {source, spec, mode}
      const [query, setQuery] = useState("")
      const [category, setCategory] = useState("all")
      const [search, setSearch] = useState({ items: [], total: 0, page: 0, hasMore: false, error: "" })
      const [searching, setSearching] = useState(false)
      const [syncing, setSyncing] = useState("")
      const [options, setOptions] = useState({
        includePayload: true,
        includeConfig: true,
        scanBeforePack: true,
        confirmLicense: false,
        name: "DSH 整合包",
        description: "",
        author: "",
      })
      const [busy, setBusy] = useState("")
      const [result, setResult] = useState(null)
      const [error, setError] = useState("")
      const [packNag, firePackNag] = useNag()

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
      const toggle = (entry) => {
        setSelected((prev) => {
          const next = { ...prev }
          if (next[entry.name]) delete next[entry.name]
          else next[entry.name] = {
            name: entry.name,
            source: entry.source,
            spec: entry.version || "",
            mode: "base",
          }
          return next
        })
      }
      const setSpec = (name, spec) => setSelected((prev) => ({ ...prev, [name]: { ...prev[name], spec } }))
      const setMode = (name, mode) => setSelected((prev) => ({ ...prev, [name]: { ...prev[name], mode } }))
      // 同名市场版：装出来是上游原版代码 + 插件默认配置
      const switchMarket = (entry, toMarket) => setSelected((prev) => {
        if (!prev[entry.name]) return prev
        return {
          ...prev,
          [entry.name]: toMarket
            ? { name: entry.name, source: "npm", spec: entry.marketVersion || "", mode: "base" }
            : { name: entry.name, source: "profile", spec: entry.version || "", mode: "base" },
        }
      })

      const addAllLocal = () => setSelected((prev) => {
        const next = { ...prev }
        for (const entry of localRows) {
          if (!next[entry.name]) next[entry.name] = { name: entry.name, source: "profile", spec: entry.version || "", mode: "base" }
        }
        return next
      })
      const clearSelected = () => setSelected({})

      const doPack = async (ack) => {
        setBusy("pack"); setError(""); setResult(null)
        try {
          const data = await api("/pack", {
            selection: picked.map((name) => selected[name]),
            options: {
              includePayload: options.includePayload,
              includeConfig: options.includeConfig,
              acknowledge: ack === true,
              force: false,
              scanBeforePack: options.scanBeforePack,
              confirmLicense: options.confirmLicense,
              name: options.name,
              description: options.description,
              author: options.author,
            },
          })
          if (!data) { setError("没有响应"); return }
          if (!data.ok) {
            setResult({ refused: data.refused, needsAck: data.needsAck === true, trustedOnly: data.trustedOnly === true, error: data.error, scan: data.scan })
            return
          }
          setResult(data)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally { setBusy("") }
      }

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

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
        h(Notice, null,
          h("b", null, "打包：将所选插件封装为一个 .dshpack 文件"),
          "　完整版包含插件本体的全部文件；轻量版仅记录插件名称与版本，安装时按版本从插件市场下载。两种包在安装前均不修改 profile 内容。",
          status && status.market && status.market.installed
            ? h("div", { style: { ...hint, marginTop: "6px" } }, "已检测到插件市场 v" + status.market.version + "：本插件与其共用目录源与安装链路，但不依赖该插件，移除后打包与安装功能不受影响。")
            : h("div", { style: { ...hint, marginTop: "6px" } }, "未检测到插件市场，功能不受影响：打包、安装与检测均在本地完成。建议先安装 dshmarket 以获得分类、搜索与「切换市场版」入口；未安装时，首次使用请点击「建立目录索引」。"),
          h("div", { style: hint }, "目录中存在同名插件时，该条目末尾提供「（切换市场版）」入口：可将打包源切换为上架市场的上游原版，安装结果与从市场安装一致。")),
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "10px" } },
          h("div", { style: row },
            h("div", { style: strong }, "选择插件"),
            h("input", { style: { ...input, flex: "1 1 200px" }, placeholder: "搜索插件名 / 描述（在插件市场目录里搜）", value: query, onChange: (e) => setQuery(e.target.value) }),
            active ? h("button", { style: btn, onClick: () => { setQuery(""); setCategory("all") } }, "回到已装") : null,
            h("button", { style: btn, onClick: addAllLocal, title: "把本机已装的全部插件加入选择（默认按基础配置打包，可逐个改）" }, "全部加入"),
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
          catalog.present ? h("div", { style: { ...row, rowGap: "4px", maxHeight: "78px", overflow: "auto" } },
            chips.map((c) => h("button", {
              key: c.id,
              style: category === c.id ? chipOn : chipBtn,
              onClick: () => setCategory(c.id),
              title: "只看「" + c.label + "」" + (c.count ? "，市场内 " + c.count + " 个" : ""),
            }, c.label + (c.count ? " " + c.count : "")))) : null,
          search.error ? h("div", { style: { ...hint, color: "#ffb020" } }, search.error) : null,
          h("div", { style: { display: "flex", flexDirection: "column", gap: "3px", maxHeight: "320px", overflow: "auto" } },
            rows.length === 0
              ? h("div", { style: hint }, loading ? "读取中…" : active ? (searching ? "搜索中…" : "无匹配条目") : "本机尚未安装插件")
              : rows.map((entry) => {
              const on = Boolean(selected[entry.name])
              return h("div", { key: entry.name, style: { display: "flex", gap: "8px", alignItems: "center", padding: "5px 2px", borderTop: "0.5px solid var(--dsw-alias-border-l2)", flexWrap: "wrap" } },
                h("input", { type: "checkbox", checked: on, onChange: () => toggle(entry) }),
                h("div", { style: { flex: "1 1 220px", minWidth: "180px" } },
                  h("div", { style: label }, entry.title || entry.name, " ", h("span", { style: hint }, "@" + (entry.version || "?"))),
                  h("div", { style: hint }, (entry.description || "").slice(0, 110))),
                h("span", { style: chip }, entry.installed === false ? "市场" : "本机"),
                h("span", { style: { ...chip, color: "var(--dsw-alias-label-tertiary)" } }, labelOf(categoryOf(entry))),
                entry.updateAvailable ? h(Tag, { color: "#2bb673" }, "市场版 " + (entry.marketVersion || entry.version) + " 更新") : null,
                on ? h("input", {
                  style: { ...input, width: "120px" },
                  placeholder: selected[entry.name].source === "npm" ? "版本，空=最新" : "版本，空=原版",
                  value: selected[entry.name].spec || "",
                  onChange: (e) => setSpec(entry.name, e.target.value),
                }) : null,
                on && entry.source === "profile" && selected[entry.name].source === "profile" ? h("div", { style: { display: "flex", gap: "4px" } },
                  h("button", { style: selected[entry.name].mode === "base" ? chipOn : chipBtn, onClick: () => setMode(entry.name, "base"), title: "上游原版代码 + 插件默认配置，不带你的修改" }, "基础配置"),
                  h("button", { style: selected[entry.name].mode === "local" ? chipOn : chipBtn, onClick: () => setMode(entry.name, "local"), title: "打你本机现在的代码、配置与数据快照" }, "本地改动")) : null,
                entry.hasMarket && entry.source === "profile" && on ? h("button", {
                  style: { ...chipBtn, border: "none", fontSize: "10.5px", color: "var(--dsw-alias-label-tertiary)" },
                  onClick: () => switchMarket(entry, selected[entry.name].source !== "npm"),
                  title: "改用插件市场发的同名版本（上游原版代码 + 默认配置），装出来和从市场装一样",
                }, selected[entry.name].source === "npm" ? "（切回本机版）" : "（切换市场版）") : null)
            })),
          active && search.hasMore ? h("div", { style: row },
            h("button", { style: btn, disabled: searching, onClick: loadMore }, searching ? "加载中…" : ("加载更多（还有 " + Math.max(0, search.total - rows.length) + " 条）"))) : null,
          h("div", { style: hint }, active
            ? "排序：已装的排前面，其余按插件市场的相关度与目录顺序。分类和词条都来自插件市场目录。"
            : "首屏只列本机已装。搜索或点分类才会去插件市场目录里查，服务端分页、一次一页。")
        ),
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "8px" } },
          h("div", { style: strong }, "包选项"),
          h("div", { style: { ...row, rowGap: "6px" } },
            h(Switch, { checked: options.includePayload, label: "包含插件本体（关=轻量版）", onChange: (v) => setOptions({ ...options, includePayload: v }) }),
            h(Switch, { checked: options.includeConfig, label: "包含配置与数据快照", onChange: (v) => setOptions({ ...options, includeConfig: v }) }),
            h(ForcedSwitch, { label: "打包前安全检测（强制）", onNag: () => firePackNag("你想干什么") })),
          h(NagText, { text: packNag }),
          h("div", { style: { ...row, rowGap: "6px" } },
            h("input", { style: { ...input, flex: "1 1 200px" }, placeholder: "整合包名", value: options.name, onChange: (e) => setOptions({ ...options, name: e.target.value }) }),
            h("input", { style: { ...input, flex: "1 1 160px" }, placeholder: "作者（可空）", value: options.author, onChange: (e) => setOptions({ ...options, author: e.target.value }) })),
          h("input", { style: { ...input, width: "100%" }, placeholder: "一句话描述（可空）", value: options.description, onChange: (e) => setOptions({ ...options, description: e.target.value }) }),
          h(Switch, { checked: options.confirmLicense, label: "我确认所选插件的许可证允许再分发，或已获得作者授权", onChange: (v) => setOptions({ ...options, confirmLicense: v }) }),
          h("div", { style: row },
            h("button", { style: btnPrimary, disabled: picked.length === 0 || busy === "pack", onClick: doPack }, busy === "pack" ? "打包中…" : ("打包 " + picked.length + " 个插件")),
            status ? h("span", { style: hint }, "DSH " + (status.dshVersion || "?") + " · profile " + status.profile) : null)),
        error ? h(Notice, { tone: "bad" }, error) : null,
        result ? h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "10px" } },
          result.refused || result.error
            ? h(Notice, { tone: "warn" },
              h("b", null, "已停止："), result.error || "未通过检查",
              result.needsAck ? h("div", { style: { ...row, marginTop: "8px" } },
                h("button", {
                  style: { ...btn, borderColor: "#ff6b6b", color: "#ff6b6b" },
                  disabled: busy === "pack",
                  onClick: () => doPack(true),
                }, busy === "pack" ? "处理中…" : "我已知晓其中风险，继续打包")) : null)
            : h("div", { style: row },
              h("div", { style: strong }, result.fileName),
              h(Tag, { color: "#2bb673" }, bytes(result.size)),
              h(Tag, null, FORMAT_TEXT[result.manifest && result.manifest.format] || ""),
              h("span", { style: hint }, "包内插件 " + ((result.manifest && result.manifest.plugins) || []).length + " 个")),
          result.scan ? h(ScanReport, { scan: result.scan, footNote: "报告已写进包内 security/report.txt（只含类型与掩码）。" }) : null,
          result.manifest && result.manifest.plugins && result.manifest.plugins.length
            ? h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
              result.manifest.plugins.map((p) => h("div", { key: p.name, style: mono },
                "· " + p.name + "@" + p.version + "　" + (p.size ? bytes(p.size) : "") + ((p.mode === "local" || p.localEdits) ? "　[本地改动]" : "　[基础配置]") + (p.configIncluded ? "　[含配置]" : ""))))
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
    function InstallPanel(props) {
      const [source, setSource] = useState({ kind: "url", url: "", file: "" })
      const [packs, setPacks] = useState([])
      const [preview, setPreview] = useState(null)
      const [busy, setBusy] = useState("")
      const [error, setError] = useState("")
      const [done, setDone] = useState(null)
      const [options, setOptions] = useState({ keepLocal: true, applyConfig: true, force: false, dryRun: false, enableBundles: !!((props.status && props.status.config && props.status.config.enableOnInstall) === true) })

      const reloadPacks = useCallback(async () => {
        try {
          const data = await api("/packs")
          if (data && data.ok) setPacks(data.items || [])
        } catch { /* 列目录失败不打扰用户，真要装可以用链接 */ }
      }, [])
      useEffect(() => { reloadPacks() }, [reloadPacks])

      const bodyFor = () => {
        if (source.kind === "url") return { url: source.url.trim() }
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

      const install = async () => {
        setBusy("install"); setError(""); setDone(null)
        try {
          const data = await api("/install", { ...bodyFor(), ...options })
          if (!data.ok) {
            setDone({ ok: false, error: data.error, refused: data.refused, scan: data.scan, report: data.report })
            return
          }
          setDone(data)
        } catch (e) {
          setDone({ ok: false, error: e.message || String(e), scan: (e.data && e.data.scan) || null, report: (e.data && e.data.report) || "", refused: Boolean(e.data && e.data.refused) })
        } finally { setBusy("") }
      }

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
        h(Notice, null,
          h("b", null, "先看清楚，再装"),
          "　读取阶段解压、校验完整性、扫一遍风险，全部在内存里完成；只有你点「安装」才会碰 profile。安装走官方 ",
          h("code", { style: mono }, "dsh plugin add"), "，不手改 node_modules。"),
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "10px" } },
          h("div", { style: row },
            h("button", { style: source.kind === "url" ? btnPrimary : btn, onClick: () => setSource({ ...source, kind: "url" }) }, "从链接读取"),
            h("button", { style: source.kind === "file" ? btnPrimary : btn, onClick: () => setSource({ ...source, kind: "file" }) }, "从本机 packs/ 读取")),
          source.kind === "url"
            ? h("input", { style: { ...input, width: "100%" }, placeholder: "https://…/xxx.dshpack", value: source.url, onChange: (e) => setSource({ ...source, url: e.target.value }) })
            : h("div", { style: row },
              h("div", { style: { display: "flex", flexDirection: "column", gap: "3px", flex: "1 1 260px", maxHeight: "170px", overflow: "auto" } },
                packs.length === 0 ? h("div", { style: hint }, "packs 目录还是空的。先去打包页生成一个，或把 .dshpack 放进 " + ((props.status && props.status.paths && props.status.paths.packs) || "packs")) : null,
                packs.map((p) => h("label", { key: p.name, style: { ...row, gap: "6px", cursor: "pointer" } },
                  h("input", { type: "radio", name: "packfile", checked: source.file === p.name, onChange: () => setSource({ ...source, file: p.name }) }),
                  h("span", { style: label }, p.name),
                  h("span", { style: hint }, bytes(p.size) + " · " + when(p.mtime))))),
              h("button", { style: btn, onClick: reloadPacks }, "刷新")),
          h("div", { style: row },
            h(Switch, { checked: options.keepLocal, label: "保留本地已有修改（不覆盖已装插件）", onChange: (v) => setOptions({ ...options, keepLocal: v }) }),
            h(Switch, { checked: options.applyConfig, label: "安装后回填包内配置", onChange: (v) => setOptions({ ...options, applyConfig: v }) }),
            h(Switch, { checked: options.enableBundles, label: "安装后直接启用（登记 bundle，重启后加载；默认关）", onChange: (v) => setOptions({ ...options, enableBundles: v }) }),
            h(Switch, { checked: options.force, label: "忽略阻断（我知道自己在干什么）", onChange: (v) => setOptions({ ...options, force: v }) })),
          h("div", { style: row },
            h("button", { style: btnPrimary, disabled: busy !== "" || (source.kind === "url" ? !source.url.trim() : !source.file), onClick: inspect }, busy === "inspect" ? "检测中…" : "检测这个包"),
            source.kind === "file" && source.file ? h("span", { style: hint }, "选中：" + source.file) : null)),
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
          h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
            preview.manifest.plugins.map((p) => h("div", { key: p.name, style: mono },
              "· " + p.name + "@" + p.version + (p.localEdits ? "　[含本机修改]" : "") + (p.configIncluded ? "　[有配置]" : "") + (p.dataIncluded ? "　[有数据快照]" : "")))),
          h(ScanReport, { scan: preview.scan }),
          h(CompatList, { compat: preview.compat }),
          preview.notes && preview.notes.length ? h("div", { style: hint }, preview.notes.map((n, i) => h("div", { key: i }, "· " + n))) : null,
          h("div", { style: row },
            h(Switch, { checked: options.dryRun, label: "只演练不落地", onChange: (v) => setOptions({ ...options, dryRun: v }) }),
            h("button", { style: btnPrimary, disabled: busy !== "", onClick: install }, busy === "install" ? "安装中…" : (options.dryRun ? "演练一次" : "安装这个整合包"))))
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
          done.scan ? h(ScanReport, { scan: done.scan }) : null)
          : null)
    }

    // —— 设置与记录 ——
    function SettingsPanel(props) {
      const [cfg, setCfg] = useState(props.status ? props.status.config : null)
      const [saved, setSaved] = useState("")
      const [busy, setBusy] = useState(false)
      const [scanNag, fireScanNag] = useNag()
      const history = (props.status && props.status.history) || []

      const patch = async (p) => {
        setBusy(true); setSaved("")
        try {
          const data = await api("/settings", { patch: p })
          if (data && data.ok) { setCfg(data.config); setSaved("已保存") }
          else setSaved((data && data.error) || "保存失败")
        } catch (e) {
          setSaved(e.message || String(e))
        } finally { setBusy(false) }
      }
      const setField = (key, value) => setCfg((prev) => ({ ...(prev || {}), [key]: value }))
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
            h("input", { style: { ...input, width: "90px" }, type: "number", min: "1", value: Math.round((cfg.maxPackBytes || 0) / 1048576), onChange: (e) => setField("maxPackBytes", Number(e.target.value) * 1048576) }),
            h("button", { style: btn, disabled: busy, onClick: () => patch({ maxPackBytes: cfg.maxPackBytes, maxDownloadBytes: cfg.maxDownloadBytes, maxFileBytes: cfg.maxFileBytes, licenseAllow: cfg.licenseAllow, registries: cfg.registries, allowHosts: cfg.allowHosts }) }, "保存数值"),
            saved ? h("span", { style: hint }, saved) : null)),
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
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "6px" } },
          h("div", { style: strong }, "最近记录"),
          history.length === 0 ? h("div", { style: hint }, "还没有记录。") : history.map((item, i) => h("div", { key: i, style: { ...mono, borderTop: "0.5px solid var(--dsw-alias-border-l2)", paddingTop: "4px" } },
            "[" + (item.kind || "?") + "] " + (item.name || item.pack || "") + " · " + when(item.at) + (item.size ? " · " + bytes(item.size) : "") + (item.ok === false ? " · 失败" : "")))),
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "8px" } },
          h("div", { style: strong }, "显示位置"),
          h("div", { style: hint }, "三处互相独立，一点就生效，不用重启。关掉只是不挂载入口，功能与接口都还在。至少留一处：只剩一个时，那个开关会变灰、点不动。"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
            h(Switch, { checked: cfg.showInSettings !== false, disabled: placementLocked("showInSettings"), label: "在设置里显示（插件设置页内一栏「整合包」）" + (placementLocked("showInSettings") ? "（最后剩这一个，不能关）" : ""), onChange: (v) => savePlacement("showInSettings", v) }),
            h(Switch, { checked: cfg.showInSidebar !== false, disabled: placementLocked("showInSidebar"), label: "在侧边栏显示（左侧栏「整合包」入口）" + (placementLocked("showInSidebar") ? "（最后剩这一个，不能关）" : ""), onChange: (v) => savePlacement("showInSidebar", v) }),
            h(Switch, { checked: cfg.showInPluginsTab === true, disabled: placementLocked("showInPluginsTab"), label: "在插件页内显示（与插件市场同一位置，单开一栏「整合包」）" + (placementLocked("showInPluginsTab") ? "（最后剩这一个，不能关）" : ""), onChange: (v) => savePlacement("showInPluginsTab", v) })),
          saved ? h("span", { style: hint }, saved) : null),
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
          h("div", { style: hint }, "目录就是插件市场自己发布的那份 dsh-plugin-catalog：CDN 优先，失败退回 npm 包。分类与词条都照它来，本插件不另造一套。"))
      )
    }

    function Home(props) {
      const [tab, setTab] = useState("pack")
      const status = props.status
      const tabs = [
        ["pack", "打包"],
        ["install", "安装 / 导入"],
        ["settings", "设置与记录"],
      ]
      const tabBtn = (key, text) => h("button", {
        key,
        onClick: () => setTab(key),
        style: {
          ...btn,
          borderColor: tab === key ? "transparent" : "var(--dsw-alias-border-l2)",
          background: tab === key ? "var(--dsw-alias-fill-primary, #3b6cf6)" : "transparent",
          color: tab === key ? "#fff" : "var(--dsw-alias-label-primary)",
        },
      }, text)

      return h("div", { style: { height: "100%", overflow: "auto", boxSizing: "border-box", padding: "22px 26px 44px", color: "var(--dsw-alias-label-primary)" } },
        h("div", { style: { maxWidth: "1020px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "14px" } },
          h("div", { style: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" } },
            h("h2", { style: { margin: 0, fontSize: "20px", fontWeight: 600 } }, "整合包"),
            h("span", { style: hint }, "把多个插件打成一个 .dshpack：完整版自带本体，轻量版联网取包")),
          h("div", { style: row }, tabs.map(([key, text]) => tabBtn(key, text)),
            h("span", { style: { ...hint, marginLeft: "auto" } },
              status ? ("DSH " + (status.dshVersion || "?") + " · 已装 " + ((status.installed || []).length) + " 个 · v" + (status.pluginVersion || "?")) : "读取环境…")),
          tab === "pack" ? h(PackPanel, { status }) : null,
          tab === "install" ? h(InstallPanel, { status }) : null,
          tab === "settings" ? h(SettingsPanel, { status }) : null,
          h("div", { style: hint }, "说明：整合包只打包你选择的插件与必要配置。打包与安装安全检测在内存中进行，命中原文不落盘；请遵守插件作者许可证与你所在地区的法律法规。"))
      )
    }

    function Icon(props) {
      const size = (props && props.size) || 16
      return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { d: "M2.2 5.2 8 2.3l5.8 2.9v5.6L8 13.7l-5.8-2.9z" }),
        h("path", { d: "M2.2 5.2 8 8.1l5.8-2.9M8 8.1v5.6" }))
    }

    /** 用一个小组件包住面板，进入时拉一次状态，之后交给子面板。 */
    function Page(props) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState("")
      const reload = useCallback(async () => {
        try {
          const data = await api("/status")
          if (data && data.ok) {
            setStatus(data)
            setError("")
            if (data.placements) setPlacement(data.placements)
          } else setError((data && data.error) || "读取状态失败")
        } catch (e) { setError(String((e && e.message) || e)) }
      }, [])
      useEffect(() => { reload() }, [reload])
      if (error) return h("div", { style: { padding: "24px", color: "#ff6b6b", fontSize: "13px" } }, "整合包没起来：" + error)
      if (!status) return h("div", { style: { padding: "24px", color: "var(--dsw-alias-label-tertiary)", fontSize: "13px" } }, "整合包：读取环境…")
      return h(Home, { status, surface: (props && props.surface) || "sidebar" })
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
      ctx.effect(() => {
        const unsubscribe = subscribePlacement(sync)
        sync(placement.value)
        return () => { unsubscribe(); for (const key of [...mounted.keys()]) unmount(key) }
      }, "dsh-modpack-kit: 三处显示位")
    }

    exports.apply = apply
    exports.inject = inject
    exports.Page = Page
    exports.Home = Home
    exports.Icon = Icon

    return module.exports
  },
})
