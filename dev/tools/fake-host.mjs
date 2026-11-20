/**
 * 测试/自测共用的「假宿主」：把 index.js 的路由挂到一个 Map 上，直接用 req/res 调。
 * host-smoke、risk-e2e 以前各抄一份（约 40 行），现在都从这里拿，改一处就够。
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

function fakeRes() {
  const state = { code: 200, headers: {}, chunks: [] }
  return {
    state,
    set statusCode(v) { state.code = v },
    get statusCode() { return state.code },
    writeHead(code, headers) { state.code = code; Object.assign(state.headers, headers || {}) },
    end(buf) {
      if (buf) state.chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)))
      state.done = true
    },
  }
}

/**
 * @param {object} plugin index.js 的默认导出
 * @param {{jobDelay?: number, host?: string, get?: Function}} options
 */
export function mountFakeHost(plugin, options = {}) {
  const routes = new Map()
  const host = options.host || '127.0.0.1:51882'
  if (Number(options.jobDelay) > 0) process.env.DSH_MODPACK_TEST_JOB_DELAY_MS = String(options.jobDelay)
  plugin.apply({
    webServer: { register(entry) { routes.set(entry.path, entry.handler); return () => routes.delete(entry.path) } },
    get: options.get || (() => undefined),
    effect(fn) { const dispose = fn(); return () => { try { dispose && dispose() } catch {} } },
  })

  async function invoke(pathname, buffer, { method = 'GET', contentType = null, headers = {} } = {}) {
    const handler = routes.get(pathname)
    assert.ok(handler, 'route missing: ' + pathname)
    const req = Readable.from(buffer === null ? [] : [buffer])
    req.method = method
    req.headers = { host, ...(contentType ? { 'content-type': contentType } : {}), ...headers }
    const res = fakeRes()
    await handler(req, res)
    const raw = Buffer.concat(res.state.chunks)
    let data = null
    try { data = JSON.parse(raw.toString('utf8')) } catch {}
    return { code: res.state.code, headers: res.state.headers, data, raw }
  }

  const call = (pathname, { method = 'GET', body = null, headers = {} } = {}) =>
    invoke(pathname, body === null ? null : Buffer.from(JSON.stringify(body)), { method, contentType: 'application/json', headers })

  const callRaw = (pathname, buffer, { method = 'POST', contentType = 'application/octet-stream', headers = {} } = {}) =>
    invoke(pathname, buffer, { method, contentType, headers })

  return { routes, call, callRaw }
}
