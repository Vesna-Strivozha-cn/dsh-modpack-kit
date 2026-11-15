/**
 * dsh-modpack —— 最小 tgz 读取（npm 包用）。
 *
 * 只做一件事：把 `.tgz` 里的普通文件取出来。目录条目、pax 扩展头按规范跳过
 * 或解析名字；符号链接、硬链接、设备节点一律拒绝——整合包里不需要它们，
 * 而它们正是「解包时写到包外」最常见的载体。
 */
import { gunzipSync } from 'node:zlib'
import { safeEntryName } from './zip.mjs'

const BLOCK = 512
const LIMITS = { entries: 20000, entryBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 }

function readString(buf, start, len) {
  const slice = buf.subarray(start, start + len)
  const zero = slice.indexOf(0)
  return slice.toString('utf8', 0, zero === -1 ? slice.length : zero)
}

function readOctal(buf, start, len) {
  const text = readString(buf, start, len).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function parsePax(data) {
  const out = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const len = Number.parseInt(data.toString('utf8', offset, space), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const record = data.toString('utf8', space + 1, offset + len - 1)
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    offset += len
  }
  return out
}

/**
 * 解 gzip tar。
 * @param {Buffer} gz
 * @returns {{name: string, data: Buffer, mode: number, mtime: Date}[]}
 */
export function readTarball(gz, options = {}) {
  let buf
  try {
    buf = gunzipSync(gz, { maxOutputLength: options.maxBytes ?? LIMITS.totalBytes })
  } catch (error) {
    throw new Error('tgz: 解压失败（' + String(error?.message || error) + '）')
  }
  const entries = []
  let total = 0
  let offset = 0
  let pendingName = null
  let pendingPax = {}
  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK)
    if (header.every((b) => b === 0)) break
    let name = readString(header, 0, 100)
    const size = readOctal(header, 124, 12)
    const mode = readOctal(header, 100, 8)
    const mtimeSec = readOctal(header, 136, 12)
    const type = String.fromCharCode(header[156] || 0x30)
    const prefix = readString(header, 345, 155)
    if (prefix) name = prefix + '/' + name
    const bodyStart = offset + BLOCK
    if (entries.length >= (options.maxEntries ?? LIMITS.entries)) throw new Error('tgz: 条目数超过上限（疑似构造包）')
    if (size > (options.maxEntryBytes ?? LIMITS.entryBytes)) throw new Error('tgz: 条目过大 ' + name)
    if (bodyStart + size > buf.length) throw new Error('tgz: 条目数据越界 ' + name)
    const body = buf.subarray(bodyStart, bodyStart + size)
    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK

    if (type === 'x') { pendingPax = parsePax(body); continue }
    if (type === 'g') continue
    if (type === 'L') { pendingName = readString(body, 0, body.length).replace(/\0.*$/s, ''); continue }
    if (type === 'K') continue

    if (pendingPax.path) name = pendingPax.path
    if (pendingName) { name = pendingName; pendingName = null }
    const mtime = mtimeSec > 0 ? new Date(mtimeSec * 1000) : new Date(0)
    pendingPax = {}

    if (type === '5') continue
    if (type === '2' || type === '1') throw new Error('tgz: 拒绝链接条目 ' + name)
    if (type !== '0' && type !== '\0') throw new Error('tgz: 不支持的条目类型 ' + type + ' ' + name)
    total += size
    if (total > (options.maxTotalBytes ?? LIMITS.totalBytes)) throw new Error('tgz: 解压总量超过上限')
    entries.push({ name: safeEntryName(name), data: Buffer.from(body), mode, mtime })
  }
  return entries
}

/** 去掉 npm 包统一的一层前缀（通常是 `package/`）。 */
export function stripPackagePrefix(entries) {
  if (entries.length === 0) return entries
  const firstSegments = new Set(entries.map((e) => e.name.split('/')[0]))
  if (firstSegments.size !== 1) return entries
  const [prefix] = firstSegments
  if (!prefix || entries.some((e) => !e.name.startsWith(prefix + '/'))) return entries
  return entries.map((e) => ({ ...e, name: e.name.slice(prefix.length + 1) })).filter((e) => e.name !== '')
}

export const tarLimits = LIMITS
