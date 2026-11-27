/**
 * dsh-modpack —— 网络层：只信任 https、逐跳校验主机、体积上限、重试与 curl 兜底。
 *
 * 为什么单独一层：
 *  - 宿主的 fetch 在个别代理/证书环境下会直接报 "fetch failed"，而系统自带的
 *    curl 走的是系统证书库，往往还能通。这里把「先 fetch、失败退 curl」收敛成一处，
 *    调用方（registry / market-catalog）不再各写一遍。
 *  - 重定向必须逐跳校验，所以两种传输都关掉自动跟随（fetch 用 manual，curl 不用 -L）。
 */
import { execFile } from 'node:child_process'

export const NET_DEFAULTS = {
  // 20 秒对慢链路不够：实测有的 tarball 20 秒只下来十几 KB
  timeoutMs: 60000,
  retries: 1,
  curlFallback: true,
  maxRedirects: 6,
}

const CURL_PRESENT = process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin'

/** 只允许 https，且主机名必须在白名单里（含子域）。 */
export function assertAllowedUrl(url, config) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('地址无法解析：' + String(url).slice(0, 200))
  }
  if (parsed.protocol !== 'https:') throw new Error('只允许 https 地址：' + parsed.protocol)
  const host = parsed.hostname.toLowerCase()
  const allowed = Array.isArray(config?.allowHosts) && config.allowHosts.length > 0 ? config.allowHosts : ['registry.npmjs.org']
  if (!allowed.some((h) => host === h.toLowerCase() || host.endsWith('.' + h.toLowerCase()))) {
    throw new Error('主机不在允许列表：' + host + '（可在设置里添加）')
  }
  return parsed
}

function netOptions(config, options) {
  const seconds = Number(config?.netTimeoutSeconds)
  const timeoutMs = options.timeoutMs
    ?? (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : NET_DEFAULTS.timeoutMs)
  const retries = Math.max(0, Math.min(5, Number.isFinite(config?.netRetries) ? Number(config.netRetries) : NET_DEFAULTS.retries))
  const curlFallback = (config?.curlFallback ?? NET_DEFAULTS.curlFallback) !== false
  return { timeoutMs, retries, curlFallback }
}

/** 把 `curl -i` 的输出拆成状态码、头、体（头与体之间是空行）。 */
export function parseCurlResponse(buffer) {
  const text = buffer.toString('latin1')
  const split = text.indexOf('\r\n\r\n')
  const head = split >= 0 ? text.slice(0, split) : text
  const bodyStart = split >= 0 ? split + 4 : text.length
  const lines = head.split('\r\n')
  const status = Number((lines[0] || '').split(' ')[1]) || 0
  const headers = new Map()
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':')
    if (at > 0) headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim())
  }
  return { status, headers, body: Buffer.from(buffer.subarray(bodyStart)) }
}

function curlOnce(url, { timeoutMs, maxBytes, accept }) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-i', '--max-time', String(Math.max(1, Math.round(timeoutMs / 1000)))]
    if (maxBytes > 0) args.push('--max-filesize', String(maxBytes))
    if (process.platform === 'win32') args.push('--ssl-no-revoke')
    // 传输压缩：npm 的版本清单动辄十几 MB，不压缩会让慢链路直接超时
    args.push('--compressed')
    args.push('-H', 'user-agent: dsh-modpack', '-H', 'accept: ' + (accept || '*/*'), url)
    execFile('curl', args, { encoding: 'buffer', maxBuffer: Math.max(4 * 1024 * 1024, Math.min(maxBytes + 1024 * 1024, 512 * 1024 * 1024)), windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr || error.message || '').trim().slice(0, 300)
        reject(new Error('curl 失败：' + (detail || error.code || '未知错误')))
        return
      }
      // 必须拿原始字节：按 utf8 解码再 latin1 回写，中文/emoji 会被替换成 U+FFFD，JSON 直接解析失败
      resolve(parseCurlResponse(stdout))
    })
  })
}

async function fetchOnce(url, { timeoutMs, maxBytes, accept }) {
  const res = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'dsh-modpack', accept: accept || '*/*', 'accept-encoding': 'gzip, deflate, br' },
  })
  const headers = new Map()
  for (const [key, value] of res.headers) headers.set(key.toLowerCase(), value)
  if (res.status >= 300 && res.status < 400) return { status: res.status, headers, body: Buffer.alloc(0) }
  if (!res.ok) throw new Error('HTTP ' + res.status + '：' + url)
  const length = Number(headers.get('content-length') || '0')
  if (length > maxBytes) throw new Error('响应体过大（' + length + ' 字节）')
  if (!res.body) return { status: res.status, headers, body: Buffer.alloc(0) }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      try { await reader.cancel() } catch {}
      throw new Error('下载超过上限（' + maxBytes + ' 字节）')
    }
    chunks.push(Buffer.from(value))
  }
  return { status: res.status, headers, body: Buffer.concat(chunks) }
}

/**
 * 取一个 URL 的内容。
 * @returns {Promise<Buffer>}
 */
export async function requestBuffer(url, config, options = {}) {
  const maxBytes = options.maxBytes ?? config?.maxDownloadBytes ?? 128 * 1024 * 1024
  const { timeoutMs, retries, curlFallback } = netOptions(config, options)
  const maxRedirects = Number.isFinite(options.maxRedirects) ? Number(options.maxRedirects) : NET_DEFAULTS.maxRedirects
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    assertAllowedUrl(current, config)
    const patch = { timeoutMs, maxBytes, accept: options.accept }
    let response
    const errors = []
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        response = await fetchOnce(current, patch)
        break
      } catch (error) {
        errors.push(String(error?.message || error))
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
    if (!response && curlFallback && CURL_PRESENT) {
      try {
        response = await curlOnce(current, patch)
        errors.push('）curl 兜底成功')
      } catch (error) {
        errors.push(String(error?.message || error))
      }
    }
    if (!response) {
      throw new Error('取不到 ' + current + '：' + errors.filter(Boolean).join('；') + '（网络或证书问题，可在设置里调大超时/重试次数）')
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('重定向没有 location：' + current)
      current = new URL(location, current).href
      continue
    }
    if (response.body.length > maxBytes) throw new Error('响应体过大（' + response.body.length + ' 字节）')
    return response.body
  }
  throw new Error('重定向次数过多：' + url)
}

/** 取 JSON，体积默认 16 MB。 */
export async function requestJson(url, config, options = {}) {
  const buf = await requestBuffer(url, config, { ...options, maxBytes: options.maxBytes ?? 16 * 1024 * 1024, accept: options.accept ?? 'application/json' })
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new Error('返回内容不是 JSON：' + url)
  }
}
