/**
 * HTTP 小工具：JSON 响应、请求体读取（文本 / 原始字节）。
 *
 * 只被 index.js 的各个路由使用；抽出来是为了让路由文件不再堆着读流的样板代码。
 */

export const MAX_JSON_BODY = 1024 * 1024
// 直接拖进来的整合包走原始字节（不塞 base64），上限与单次下载一致
export const MAX_DROP_BODY = 256 * 1024 * 1024

export function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const collect = (req, limit, tooBig) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > limit) {
      reject(Object.assign(new Error(tooBig), { statusCode: 413 }))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => resolve(Buffer.concat(chunks)))
  req.on('error', reject)
})

export const readBody = (req, limit = MAX_JSON_BODY) => collect(req, limit, '请求体过大').then((buf) => buf.toString('utf8'))

export const readRawBody = (req, limit = MAX_DROP_BODY) => collect(req, limit, '整合包太大：上限 ' + Math.round(limit / 1024 / 1024) + ' MB')

// 大部分路由只要一个对象：读不到、不是 JSON、是 null 都给同一份缺省值，免得每处都写 asJson(await readBody(req), {}) || {}
export const readJsonBody = async (req, fallback = {}, limit = MAX_JSON_BODY) => asJson(await readBody(req, limit), fallback)

export function asJson(text, fallback) {
  try { return JSON.parse(text) } catch { return fallback }
}
