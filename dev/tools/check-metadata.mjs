import { npmMetadata, pickVersion, metadataLimit } from '../../lib/registry.mjs'

const config = {
  registries: ['https://registry.npmjs.org'],
  allowHosts: ['registry.npmjs.org'],
  netTimeoutSeconds: 60,
  netRetries: 1,
}

function stamp() {
  return new Date().toTimeString().slice(0, 8)
}

console.log('limit MB:', metadataLimit(config) / 1024 / 1024)
for (const [name, opts] of [
  ['billion-context', {}],
  ['billion-context', { version: '0.3.6' }],
  ['dsh-context', { version: '0.84.1' }],
]) {
  const started = Date.now()
  try {
    const { meta, registry, doc } = await npmMetadata(name, config, opts)
    const version = pickVersion(meta, opts.version || '')
    console.log(stamp(), name, JSON.stringify(opts), '→', registry, 'doc=' + doc, 'versions=' + Object.keys(meta.versions).length, 'pick=' + version, (Date.now() - started) + 'ms')
  } catch (error) {
    console.log(stamp(), name, JSON.stringify(opts), '→ FAIL', String(error.message).slice(0, 300), (Date.now() - started) + 'ms')
  }
}
