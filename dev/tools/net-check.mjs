import { loadConfig } from '../../lib/store.mjs'
import { npmMetadata, fetchJson } from '../../lib/registry.mjs'
import { requestBuffer, parseCurlResponse } from '../../lib/net.mjs'

const config = loadConfig()
console.log('config net:', config.netTimeoutSeconds, config.netRetries, config.curlFallback)

let t = Date.now()
const { meta, registry } = await npmMetadata('dsh-modpack-kit', config)
console.log('npmMetadata ok:', registry, meta['dist-tags'] && meta['dist-tags'].latest, Date.now() - t, 'ms')

// 强制 fetch 全失败，验证 curl 兜底
const realFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('模拟 fetch failed') }
try {
  t = Date.now()
  const buf = await requestBuffer('https://registry.npmjs.org/dsh-modpack-kit/latest', config, { maxBytes: 4 * 1024 * 1024 })
  const pkg = JSON.parse(buf.toString('utf8'))
  console.log('curl fallback ok:', pkg.name, pkg.version, Date.now() - t, 'ms')
  const parsed = parseCurlResponse(Buffer.from('HTTP/1.1 302 Found\r\nlocation: https://x/y\r\n\r\n'))
  console.log('parseCurlResponse:', parsed.status, parsed.headers.get('location'))
} finally {
  globalThis.fetch = realFetch
}
