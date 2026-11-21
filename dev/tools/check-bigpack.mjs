import { downloadPackage } from '../../lib/registry.mjs'
import { scanEntries } from '../../lib/scan.mjs'

const config = {
  registries: ['https://registry.npmjs.org'],
  allowHosts: ['registry.npmjs.org'],
  netTimeoutSeconds: 120,
  netRetries: 1,
  maxDownloadBytes: 256 * 1024 * 1024,
  maxMetadataBytes: 64,
}

const started = Date.now()
const pkg = await downloadPackage('billion-context', '0.1.216', config)
const dl = Date.now() - started
const scan = scanEntries(pkg.entries, {})
const total = pkg.entries.reduce((sum, e) => sum + e.data.length, 0)
console.log(JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  registry: pkg.registry,
  files: pkg.entries.length,
  unpackedMB: Math.round(total / 1024 / 1024),
  downloadMs: dl,
  scanMs: Date.now() - started - dl,
  scan: scan.counts,
}, null, 2))
