/**
 * dsh-modpack —— 安全检测：敏感信息与恶意代码痕迹。
 *
 * 三条硬规矩（也写进 README 给使用者看）：
 *   1. 检测在内存里完成，命中的原文**不写盘、不回传**；报告里只有规则名、
 *      文件、行号和打码片段。
 *   2. 只做静态特征匹配，不是杀毒引擎；结论是「发现可疑」而不是「保证安全」。
 *   3. 高风险默认阻断打包/安装，必须使用者显式确认才继续，确认会记进报告。
 *
 * 规则表是数据，扩展接口 `registerScanner` 可以往里加规则，不用改这个文件。
 */

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg',
  '.md', '.txt', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.py', '.html', '.css', '.xml', '.env',
  '.lock', '.gitignore', '.npmrc', '.vue', '.svelte',
])

const BINARY_EXT = new Set(['.exe', '.dll', '.scr', '.msi', '.com', '.sys', '.drv', '.so', '.dylib', '.node'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif'])
const SCRIPT_EXT = new Set(['.ps1', '.bat', '.cmd', '.vbs', '.hta', '.jar'])

const MAX_SCAN_BYTES = 2 * 1024 * 1024

/** @typedef {'high'|'medium'|'low'} Severity */

const SECRET_RULES = [
  { id: 'secret.private-key', severity: 'high', category: 'secret', label: '私钥文件内容', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/gu },
  { id: 'secret.aws-key', severity: 'high', category: 'secret', label: 'AWS 访问密钥', re: /\bAKIA[0-9A-Z]{16}\b/gu },
  { id: 'secret.github-token', severity: 'high', category: 'secret', label: 'GitHub 令牌', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/gu },
  { id: 'secret.github-pat', severity: 'high', category: 'secret', label: 'GitHub 细粒度令牌', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu },
  { id: 'secret.slack-token', severity: 'high', category: 'secret', label: 'Slack 令牌', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu },
  { id: 'secret.api-key', severity: 'high', category: 'secret', label: 'API Key（sk- 形式）', re: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  { id: 'secret.jwt', severity: 'high', category: 'secret', label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu },
  // 只认“字段 = 真实值”：代码里的属性访问（cookie.bili_jct、raw.SESSDATA）不算，避免把正常插件误判成夹带 Cookie
  { id: 'secret.bili-cookie', severity: 'high', category: 'secret', label: 'B站登录 Cookie', re: /\b(?:SESSDATA|bili_jct|DedeUserID|buvid3|buvid4|ac_time_value)\b\s*[=:]\s*(?:["'][^"'\n]{8,}["']|[A-Za-z0-9%_-]{8,})/gu },
  { id: 'secret.cookie-header', severity: 'high', category: 'secret', label: 'Cookie 请求头', re: /\bcookie\s*[:=]\s*["']?[A-Za-z0-9_%-]{6,}=[^\s"']{8,}/giu },
  { id: 'secret.generic-assign', severity: 'medium', category: 'secret', label: '疑似密钥赋值', re: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\n]{8,}["']/giu },
  { id: 'secret.private-path', severity: 'medium', category: 'privacy', label: '本机用户目录路径', re: /[A-Za-z]:\\Users\\[^\\\s"']+/gu },
  { id: 'privacy.email', severity: 'medium', category: 'privacy', label: '电子邮箱', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu },
  { id: 'privacy.cn-phone', severity: 'medium', category: 'privacy', label: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/gu },
  { id: 'privacy.cn-id', severity: 'high', category: 'privacy', label: '身份证号', re: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/gu },
  { id: 'privacy.private-ip', severity: 'low', category: 'privacy', label: '内网地址', re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/gu },
]

const MALWARE_RULES = [
  { id: 'malware.remote-pipe', severity: 'high', label: '远程脚本直接执行', re: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/gu },
  { id: 'malware.powershell-iex', severity: 'high', label: '下载后 iex 执行', re: /\b(?:Invoke-Expression|iex)\b[^\n]{0,120}(?:DownloadString|Invoke-WebRequest|iwr|curl)/giu },
  { id: 'malware.powershell-encoded', severity: 'high', label: 'PowerShell 编码命令', re: /(?:-enc(?:odedcommand)?\s+)[A-Za-z0-9+/=]{40,}/giu },
  { id: 'malware.eval', severity: 'medium', label: '动态执行代码', re: /\b(?:eval|new\s+Function)\s*\(/gu },
  { id: 'malware.child-process', severity: 'medium', label: '调用子进程', re: /\b(?:child_process|execSync|spawnSync|execFileSync|exec)\s*[(`]/gu },
  { id: 'malware.obfuscation', severity: 'medium', label: '疑似混淆（长 base64）', re: /["'][A-Za-z0-9+/]{600,}={0,2}["']/gu },
  { id: 'malware.hex-escape', severity: 'low', label: '大量十六进制转义', re: /(?:\\x[0-9a-fA-F]{2}){20,}/gu },
  { id: 'malware.disabled-tls', severity: 'medium', label: '关闭 TLS 校验', re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/gu },
  { id: 'malware.process-env-dump', severity: 'low', label: '读取全部环境变量', re: /JSON\.stringify\s*\(\s*process\.env\s*\)/gu },
]

const FILE_NAME_RULES = [
  { id: 'file.private-key', severity: 'high', category: 'secret', label: '私钥/证书文件', re: /(?:^|[\\/])(?:id_(?:rsa|ed25519|ecdsa)|[^\\/]+\.(?:pem|key|p12|pfx|jks|keystore))$/iu },
  { id: 'file.env', severity: 'high', category: 'secret', label: '.env 环境文件', re: /(?:^|[\\/])\.env(?:\.local|\.production|\.development)?$/iu },
  { id: 'file.credential', severity: 'high', category: 'secret', label: '凭证/登录态文件', re: /(?:^|[\\/])[^\\/]*(?:credential|cookie|token|session|auth)[^\\/]*\.(?:json|txt|dat)$/iu },
]

/** 名字里的命中不看内容，避免把「凭证文件」本身漏掉。 */
export function scanFileName(name) {
  const hits = []
  for (const rule of FILE_NAME_RULES) {
    rule.re.lastIndex = 0
    if (rule.re.test(name)) hits.push(findingOf(rule, name, 0, ''))
  }
  return hits
}

function maskSecret(text) {
  const s = String(text)
  if (s.length <= 4) return '****'
  return s.slice(0, 2) + '****' + `（${s.length} 字符已隐藏）`
}

function maskAll(text) {
  const s = String(text)
  return s.length > 0 ? '***' : ''
}

function findingOf(rule, file, line, masked) {
  return {
    rule: rule.id,
    severity: rule.severity,
    category: rule.category || 'malware',
    label: rule.label,
    file,
    line,
    masked,
  }
}

export function looksBinary(buf) {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true
  return false
}

function extOf(name) {
  const base = name.split('/').pop() || ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1
  return line
}

/**
 * 扫一个文件。
 * @param {string} name 相对路径
 * @param {Buffer} data
 * @returns {{findings: object[], skipped?: string}}
 */
export function scanFile(name, data) {
  const findings = scanFileName(name)
  const ext = extOf(name)
  if (BINARY_EXT.has(ext)) {
    findings.push({ rule: 'file.binary-executable', severity: 'high', category: 'malware', label: '可执行二进制', file: name, line: 0, masked: '' })
    return { findings }
  }
  if (SCRIPT_EXT.has(ext) && !data.toString('utf8', 0, 64).startsWith('#!/usr/bin/env node')) {
    findings.push({ rule: 'file.script', severity: 'low', category: 'malware', label: '脚本文件（请人工确认）', file: name, line: 0, masked: '' })
  }
  if (data.length > MAX_SCAN_BYTES) return { findings, skipped: '文件超过 2MB，仅按文件名检测' }
  if (IMAGE_EXT.has(ext)) return { findings }
  if (looksBinary(data)) {
    findings.push({ rule: 'file.binary', severity: 'medium', category: 'malware', label: '二进制内容', file: name, line: 0, masked: '' })
    return { findings }
  }
  if (!TEXT_EXT.has(ext) && ext !== '') return { findings, skipped: '非文本扩展名，仅按文件名检测' }

  const text = data.toString('utf8')
  const seen = new Set()
  for (const rule of [...SECRET_RULES, ...MALWARE_RULES]) {
    rule.re.lastIndex = 0
    let match
    let guard = 0
    while ((match = rule.re.exec(text)) !== null && guard < 50) {
      guard += 1
      const category = rule.category || 'malware'
      const masked = category === 'secret' || category === 'privacy' ? maskSecret(match[0]) : maskAll(match[0])
      const line = lineAt(text, match.index)
      // 同一行同一规则只记一次：一个文件里几十处 require('child_process') 不该刷出几十条
      const key = rule.id + ':' + line
      if (!seen.has(key)) {
        seen.add(key)
        findings.push(findingOf(rule, name, line, masked))
      }
      if (match[0].length === 0) rule.re.lastIndex += 1
    }
  }

  if (/(?:^|\/)(?:package|plugin)\.json$/u.test(name)) {
    try {
      const pkg = JSON.parse(text)
      const scripts = pkg && typeof pkg === 'object' ? pkg.scripts : null
      if (scripts && typeof scripts === 'object') {
        for (const key of Object.keys(scripts)) {
          if (/^(?:pre|post)?install$/u.test(key)) {
            findings.push({
              rule: 'json.install-script', severity: 'high', category: 'malware',
              label: '安装时执行的脚本（' + key + '）', file: name, line: 0, masked: maskAll(scripts[key]),
            })
          }
        }
      }
      const bin = pkg && pkg.bin
      if (bin && typeof bin === 'object' && Object.keys(bin).length > 0) {
        findings.push({ rule: 'json.bin', severity: 'low', category: 'malware', label: '声明了命令行入口', file: name, line: 0, masked: '' })
      }
    } catch {
      // 包清单坏掉会在后面校验里报，不在扫描里重复报
    }
  }
  return { findings }
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 }

export function severityRank(severity) {
  return SEVERITY_ORDER[severity] ?? 3
}

/**
 * 扫一批文件（内存内）。
 * @param {{name: string, data: Buffer}[]} entries
 * @param {{extraRules?: object[]}} [options]
 */
export function scanEntries(entries, options = {}) {
  const findings = []
  let scannedBytes = 0
  const skipped = []
  const rules = Array.isArray(options.extraRules) ? options.extraRules : []
  const extra = rules
    .filter((r) => r && typeof r.id === 'string' && r.re instanceof RegExp)
    .map((r) => ({ id: 'ext.' + r.id, severity: r.severity || 'medium', category: r.category || 'malware', label: r.label || r.id, re: new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g') }))

  for (const entry of entries) {
    scannedBytes += entry.data.length
    const result = scanFile(entry.name, entry.data)
    findings.push(...result.findings)
    if (result.skipped) skipped.push({ file: entry.name, reason: result.skipped })
  }
  for (const rule of extra) {
    for (const entry of entries) {
      if (looksBinary(entry.data) || entry.data.length > MAX_SCAN_BYTES) continue
      const text = entry.data.toString('utf8')
      rule.re.lastIndex = 0
      let match
      let guard = 0
      while ((match = rule.re.exec(text)) !== null && guard < 50) {
        guard += 1
        findings.push({ rule: rule.id, severity: rule.severity, category: rule.category, label: rule.label, file: entry.name, line: lineAt(text, match.index), masked: maskAll(match[0]) })
        if (match[0].length === 0) rule.re.lastIndex += 1
      }
    }
  }

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.file.localeCompare(b.file) || a.line - b.line)
  const counts = { high: 0, medium: 0, low: 0 }
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1
  return {
    findings,
    counts,
    scannedFiles: entries.length,
    scannedBytes,
    skipped,
    redacted: true,
    note: '命中原文只在内存里用于判定，未写入任何文件；报告中的片段已打码。',
  }
}

/**
 * 生成给人看的扫描报告（纯文本）。只使用已打码的片段。
 */
export function renderScanReport(title, scan, options = {}) {
  const lines = []
  lines.push('安全检测报告 —— ' + title)
  lines.push('生成时间：' + new Date().toISOString())
  lines.push('扫描文件：' + scan.scannedFiles + '，字节：' + scan.scannedBytes)
  lines.push('结果：高风险 ' + scan.counts.high + ' / 中风险 ' + scan.counts.medium + ' / 低风险 ' + scan.counts.low)
  lines.push('')
  lines.push('说明：检测在本机内存中完成，命中的原文没有落盘，也无法从本报告还原。')
  lines.push('检测是静态特征匹配，不是杀毒引擎；「未发现」不等于「保证安全」。')
  if (options.approvedRisk) {
    lines.push('')
    lines.push('⚠ 打包者/安装者在存在高风险项的情况下明确选择了继续，风险由使用者承担。')
  }
  lines.push('')
  if (scan.findings.length === 0) {
    lines.push('未发现敏感信息或恶意代码特征。')
  } else {
    const byFile = new Map()
    for (const f of scan.findings) {
      if (!byFile.has(f.file)) byFile.set(f.file, [])
      byFile.get(f.file).push(f)
    }
    for (const [file, items] of byFile) {
      lines.push('· ' + file)
      for (const f of items) {
        lines.push('    [' + f.severity + '] ' + f.label + (f.line ? ' 第 ' + f.line + ' 行' : '') + (f.masked ? '  ' + f.masked : ''))
      }
    }
  }
  if (scan.skipped && scan.skipped.length > 0) {
    lines.push('')
    lines.push('未完整扫描：')
    for (const s of scan.skipped.slice(0, 50)) lines.push('    · ' + s.file + '（' + s.reason + '）')
  }
  return lines.join('\n')
}
