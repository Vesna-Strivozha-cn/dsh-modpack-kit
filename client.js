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

    const ORIGIN_LABEL = { local: "本机", market: "市场", config: "配置", data: "数据", pack: "整合包" }

    function ScanReport(props) {
      const scan = props.scan
      const counts = (scan && scan.counts) || { high: 0, medium: 0, low: 0 }
      const findings = scan && Array.isArray(scan.findings) ? scan.findings : []
      const [open, setOpen] = useState(counts.high > 0)
      const [openGroup, setOpenGroup] = useState({})
      if (!scan) return null
      const groups = Array.isArray(props.groups) && props.groups.length
        ? props.groups
        : (findings.length ? [{ key: "all", label: "全部命中", origin: "", counts, findings }] : [])
      const toggleGroup = (key) => setOpenGroup((prev) => ({ ...prev, [key]: !prev[key] }))
      const toggleOpen = () => setOpen((prev) => !prev)
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        h("div", { style: row },
          h("div", { style: strong }, "安全检测"),
          h(Tag, { color: counts.high ? "#ff6b6b" : counts.medium ? "#ffb020" : "#2bb673" },
            "高 " + counts.high + " · 中 " + counts.medium + " · 低 " + counts.low),
          h("span", { style: hint }, "扫描 " + (scan.scannedFiles || 0) + " 个文件 / " + bytes(scan.scannedBytes || 0) + (scan.note ? " · " + scan.note : "")),
          findings.length
            ? h("button", { style: { ...chipBtn, marginLeft: "auto" }, onClick: toggleOpen },
              open ? "收起风险列表（" + findings.length + " 条）" : "展开风险列表（" + findings.length + " 条）")
            : null),
        findings.length === 0 ? h("div", { style: hint }, "没有命中敏感信息或可疑代码规则。") : null,
        open && findings.length
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
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
            }))
          : null,
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
    function readDockPos() {
      try {
        const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DOCK_POS_KEY) : null
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object") return null
        if (!Number.isFinite(Number(parsed.x)) || !Number.isFinite(Number(parsed.y))) return null
        return { x: Math.max(0, Math.round(Number(parsed.x))), y: Math.max(0, Math.round(Number(parsed.y))) }
      } catch { return null }
    }
    function writeDockPos(pos) {
      try { if (typeof localStorage !== "undefined" && pos) localStorage.setItem(DOCK_POS_KEY, JSON.stringify(pos)) } catch { /* 存不了就算了，不影响本场使用 */ }
    }
    function viewportSize() {
      const width = typeof window !== "undefined" && Number(window.innerWidth) ? Number(window.innerWidth) : 1280
      const height = typeof window !== "undefined" && Number(window.innerHeight) ? Number(window.innerHeight) : 800
      return { width, height }
    }

    function JobDock(props) {
      const given = Array.isArray(props.jobs) ? props.jobs : []
      // 「清空进程」之后，就算服务端还残留一条，也在界面上立刻拿掉
      const [cleared, setCleared] = useState([])
      const jobs = given.filter((job) => !cleared.includes(job.id))
      useEffect(() => {
        setCleared((prev) => (prev.length === 0 ? prev : prev.filter((id) => given.some((job) => job.id === id))))
      }, [given])
      const [pos, setPos] = useState(readDockPos())
      const [pinned, setPinned] = useState(false)     // 手动唤出：没有任务时也显示
      const [hidden, setHidden] = useState(false)     // 手动收起：连进行中的也先藏起来
      const [open, setOpen] = useState(false)
      const [dockMsg, setDockMsg] = useState("")
      const dragRef = useRef(null)
      const boxRef = useRef(null)
      const running = jobs.filter((job) => job.status === "running")
      const visible = !hidden && (pinned || running.length > 0)

      // 有任务开跑就自己冒出来（之前手动收起的也一并放出来）
      useEffect(() => {
        if (running.length > 0) { setHidden(false) }
      }, [running.length])

      const startDrag = (event) => {
        if (!event || typeof event.clientX !== "number") return
        // 按在按钮上就别当拖动：否则指针捕获会把 click 抢走，按钮点不到，
        // 而且抬手时还会顺带把窗口展开/收起（就是「判定重叠」那个毛病）
        if (event.target && typeof event.target.closest === "function" && event.target.closest("button")) return
        const el = boxRef.current
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
        const { width, height } = viewportSize()
        const left = Math.min(Math.max(4, event.clientX - drag.dx), Math.max(4, width - drag.width - 4))
        const top = Math.min(Math.max(4, event.clientY - drag.dy), Math.max(4, height - drag.height - 4))
        if (Math.abs(left - drag.startX) > 3 || Math.abs(top - drag.startY) > 3) drag.moved = true
        drag.last = { x: Math.round(left), y: Math.round(top) }
        setPos(drag.last)
      }
      const endDrag = () => {
        const drag = dragRef.current
        if (!drag) return
        dragRef.current = null
        if (drag.moved) {
          if (drag.last) writeDockPos(drag.last)
          return
        }
        // 没拖动就是点了一下标题：展开 / 收起
        setOpen((prev) => !prev)
      }

      if (!visible) {
        const anchor = pos || null
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
          cursor: "pointer",
          fontSize: "12px",
          ...(anchor ? { left: anchor.x + "px", top: anchor.y + "px" } : { right: "16px", bottom: "16px" }),
        }
        const badge = running.length || jobs.length
        return h("button", { style: summonStyle, title: "打开整合包进度窗", onClick: () => { setPinned(true); setHidden(false) } },
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

      return h("div", {
        ref: boxRef,
        style: {
          position: "fixed",
          zIndex: 70,
          ...(pos ? { left: pos.x + "px", top: pos.y + "px" } : { right: "16px", bottom: "16px" }),
          width: open ? "380px" : "288px",
          maxHeight: open ? "58vh" : "none",
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
      const [syncing, setSyncing] = useState("")
      const [options, setOptions] = useState(() => (draft.options ? { ...draft.options } : {
        includePayload: true,
        includeConfig: true,
        scanBeforePack: true,
        confirmLicense: false,
        name: "DSH 整合包",
        description: "",
        author: "",
      }))
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
                on ? h("input", {
                  style: { ...input, width: "120px" },
                  placeholder: selected[entry.name].source === "npm" ? "版本，空=最新（从市场取包）" : "版本，空=本机版本",
                  value: selected[entry.name].spec || "",
                  onChange: (e) => setSpec(entry.name, e.target.value),
                }) : null,
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
        pausedRiskNodes.push(h("div", { key: "title", style: { ...strong, color: "#ff6b6b" } }, "打包停在风险点（" + pausedJobs.length + " 个任务）"))
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
              includePayload: options.includePayload,
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
              : renderList()),
          active && search.hasMore ? h("div", { style: row },
            h("button", { style: btn, disabled: searching, onClick: loadMore }, searching ? "加载中…" : ("加载更多（还有 " + Math.max(0, search.total - rows.length) + " 条）"))) : null,
          h("div", { style: hint }, active
            ? "排序：已装的排前面，其余按插件市场的相关度与目录顺序。分类和词条都来自插件市场目录。"
            : "首屏只列本机已装。插件自带的内部组件（随父包一起装的那种）不单独列出" + (props.status && props.status.installedHidden ? "（本次隐藏 " + props.status.installedHidden + " 个）" : "") + "。每行最前面标出当前来源：市场版按上游版本取包，本机版取本机这份。勾选时默认「插件预设」——只打插件默认配置；要带上本机的配置条目与数据快照就改成「自定义配置」（本机版还会连代码改动一起打）。本机已装且市场里有同名条目的，默认按市场版勾选；要打本机这份就点行末「改为本机版」。搜索或点分类才去插件市场目录里查，服务端分页、一次一页。搜索结果里没装的插件也能直接勾选——打包时按版本从插件市场取包，装的时候同样从市场下载。")
        ),
        h("div", { style: { ...box, display: "flex", flexDirection: "column", gap: "8px" } },
          h("div", { style: strong }, "包选项"),
          h("div", { style: { ...row, rowGap: "6px" } },
            h(Switch, { checked: options.includePayload, label: "包含插件本体（关=轻量版）", onChange: (v) => setOptions({ ...options, includePayload: v }) }),
            h(ForcedSwitch, { label: "打包前安全检测（强制）", onNag: () => firePackNag("你想干什么") })),
          h(NagText, { text: packNag }),
          h("div", { style: { ...row, rowGap: "6px" } },
            h("input", { style: { ...input, flex: "1 1 200px" }, placeholder: "整合包名", value: options.name, onChange: (e) => setOptions({ ...options, name: e.target.value }) }),
            h("input", { style: { ...input, flex: "1 1 160px" }, placeholder: "作者（可空）", value: options.author, onChange: (e) => setOptions({ ...options, author: e.target.value }) })),
          h("input", { style: { ...input, width: "100%" }, placeholder: "一句话描述（可空）", value: options.description, onChange: (e) => setOptions({ ...options, description: e.target.value }) }),
          h(Switch, { checked: options.confirmLicense, label: "我确认所选插件的许可证允许再分发，或已获得作者授权", onChange: (v) => setOptions({ ...options, confirmLicense: v }) }),
          h("div", { style: row },
            h("button", { style: btnPrimary, disabled: picked.length === 0 || busy === "start", onClick: doPack }, busy === "start" ? "提交中…" : ("打包 " + picked.length + " 个插件")),
            started ? h("span", { style: hint }, "已开始：" + started + "（进度在左下角，可以接着选别的再打一个）") : null,
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
          const data = await api("/install", { ...bodyFor(), ...options, async: true })
          if (!data || data.ok !== true || !data.job) {
            // 老宿主不认 async：退回同步调用
            const plain = await api("/install", { ...bodyFor(), ...options })
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
            h(Switch, { checked: options.enableBundles, label: "安装后直接启用（登记 bundle，重启后加载；默认关）", onChange: (v) => setOptions({ ...options, enableBundles: v }) }),
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
          h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
            preview.manifest.plugins.map((p) => h("div", { key: p.name, style: mono },
              "· " + p.name + "@" + p.version + (p.localEdits ? "　[含本机修改]" : "") + (p.configIncluded ? "　[有配置]" : "") + (p.dataIncluded ? "　[有数据快照]" : "")))),
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
              h("button", { style: btnPrimary, disabled: busy !== "", onClick: () => replaceDeferred(deferred.map((d) => d.name)) }, "替换为包内版本（" + deferred.length + " 个）")))
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
                patch({ maxPackBytes: bytes, maxDownloadBytes: cfg.maxDownloadBytes, maxFileBytes: cfg.maxFileBytes, netTimeoutSeconds: cfg.netTimeoutSeconds, netRetries: cfg.netRetries, curlFallback: cfg.curlFallback !== false, licenseAllow: cfg.licenseAllow, registries: cfg.registries, allowHosts: cfg.allowHosts })
              },
            }, "保存数值"),
            h("span", { style: hint }, "默认 256 MB，可填 16~4096"),
            saved ? h("span", { style: hint }, saved) : null)),
          h("div", { style: row },
            h("span", { style: label }, "网络超时（秒）"),
            h("input", { style: { ...input, width: "70px" }, type: "number", min: "5", max: "120", value: String(cfg.netTimeoutSeconds || 20), onChange: (e) => setField("netTimeoutSeconds", Number(e.target.value)) }),
            h("span", { style: label }, "重试"),
            h("input", { style: { ...input, width: "56px" }, type: "number", min: "0", max: "5", value: String(cfg.netRetries || 0), onChange: (e) => setField("netRetries", Number(e.target.value)) }),
            h(Switch, {
              checked: cfg.curlFallback !== false,
              label: "fetch 失败时用系统 curl 兜底",
              onChange: (v) => { setField("curlFallback", v); patch({ curlFallback: v }) },
            })),
          h("div", { style: hint }, "registry 报 fetch failed / 超时，多半是代理或证书链：调大超时、加一次重试，或让 curl 兜底（走系统证书库）。保存后立即生效。"),
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
          h("div", { style: hint }, "目录就是插件市场自己发布的那份 dsh-plugin-catalog：CDN 优先，失败退回 npm 包。分类与词条都照它来，本插件不另造一套。"),
          h(RepoFooter, null))
      )
    }

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
      useEffect(() => subscribePack((value) => { setPackResult(value) }), [])
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
          fontSize: embedded ? "12px" : btn.fontSize,
          padding: embedded ? "3px 9px" : btn.padding,
          borderColor: tab === key ? "transparent" : "var(--dsw-alias-border-l2)",
          background: tab === key ? "var(--dsw-alias-fill-primary, #3b6cf6)" : "transparent",
          color: tab === key ? "#fff" : "var(--dsw-alias-label-primary)",
        },
      }, text)

      const panels = [
        tab === "pack" ? h(PackPanel, { status, jobs, result: packResult, setResult: savePackResult, focus }) : null,
        tab === "install" ? h(InstallPanel, { status }) : null,
        tab === "settings" ? h(SettingsPanel, { status }) : null,
      ]
      const footNote = h("div", { style: hint }, "说明：整合包只打包你选择的插件与必要配置。打包与安装安全检测在内存中进行，命中原文不落盘；请遵守插件作者许可证与你所在地区的法律法规。")
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
            h("div", { style: row }, tabs.map(([key, text]) => tabBtn(key, text)), envLine),
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
            h("span", { style: hint }, "把多个插件打成一个 .dshpack：完整版自带本体，轻量版联网取包")),
          h("div", { style: row }, tabs.map(([key, text]) => tabBtn(key, text)), envLine),
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
    function Page(props) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState("")
      const [tries, setTries] = useState(0)
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
    exports.inject = inject
    exports.Page = Page
    exports.Home = Home
    exports.Icon = Icon

    return module.exports
  },
})
