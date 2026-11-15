/**
 * dsh-modpack —— 最小 ZIP 读写（只用 node:zlib，不引入依赖）。
 *
 * 为什么自己写：整合包要能在「没装本插件」的 DSH 上也读得懂，格式必须是
 * 通用的（zip），但宿主没给我们打包库，多引一个依赖就多一份跑不起来的风险。
 * 这里只实现 store / deflate 两种方法，够用且可审计。
 *
 * 安全约束（解包端）：
 *   - 拒绝绝对路径、盘符、`..` 段、反斜杠路径；
 *   - 拒绝符号链接（外部属性 S_IFLNK）；
 *   - 单文件 / 总解压体积 / 压缩比三重上限，挡 zip bomb；
 *   - 不支持 ZIP64 与加密，遇到就明确报错，不猜。
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50

const LIMITS = {
  entries: 20000,
  entryBytes: 256 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  ratio: 200,
}

function dosTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

function dosToDate(time, date) {
  const year = ((date >> 9) & 0x7f) + 1980
  const month = ((date >> 5) & 0x0f) - 1
  const day = date & 0x1f
  const hours = (time >> 11) & 0x1f
  const minutes = (time >> 5) & 0x3f
  const seconds = (time & 0x1f) * 2
  return new Date(year, Math.max(0, month), Math.max(1, day), hours, minutes, seconds)
}

/** 规范化条目名：统一正斜杠、去掉前导 ./，并拒绝逃逸。 */
export function safeEntryName(raw) {
  if (typeof raw !== 'string' || raw === '') throw new Error('zip: 空条目名')
  if (raw.includes('\u0000')) throw new Error('zip: 条目名含 NUL')
  const name = raw.replace(/\\/gu, '/')
  if (name.startsWith('/') || /^[A-Za-z]:/u.test(name)) throw new Error('zip: 绝对路径条目 ' + raw)
  const parts = []
  for (const part of name.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') throw new Error('zip: 路径逃逸条目 ' + raw)
    parts.push(part)
  }
  if (parts.length === 0) throw new Error('zip: 空路径条目 ' + raw)
  return parts.join('/')
}

/**
 * 写 zip。
 * @param {{name: string, data: Buffer|string, compress?: boolean}[]} entries
 * @param {{mtime?: Date}} [options]
 * @returns {Buffer}
 */
export function writeZip(entries, options = {}) {
  const { time, date } = dosTime(options.mtime)
  const chunks = []
  const central = []
  let offset = 0
  const seen = new Set()

  for (const entry of entries) {
    const name = safeEntryName(entry.name)
    if (seen.has(name)) throw new Error('zip: 重复条目 ' + name)
    seen.add(name)
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const crc = crc32(data) >>> 0
    let method = 0
    let body = data
    if (entry.compress !== false && data.length > 128) {
      const deflated = deflateRawSync(data, { level: 9 })
      if (deflated.length < data.length) {
        method = 8
        body = deflated
      }
    }
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 名字
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(SIG_CENTRAL, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += local.length + nameBuf.length + body.length
    if (offset > LIMITS.totalBytes) throw new Error('zip: 打包体积超过上限')
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuf, eocd])
}

function findEocd(buf) {
  const start = Math.max(0, buf.length - 0x10000 - 22)
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue
    const commentLen = buf.readUInt16LE(i + 20)
    if (i + 22 + commentLen === buf.length) return i
  }
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/**
 * 读 zip，返回条目数组（含 data Buffer）。
 * 目录条目会被跳过；任何可疑输入直接抛错，不做“尽量解析”。
 * @param {Buffer} buf
 */
export function readZip(buf, options = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('zip: 内容太短，不是 zip')
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('zip: 找不到中央目录结尾（文件损坏或不是 zip）')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('zip: 暂不支持 ZIP64')
  if (cdOffset + cdSize > buf.length) throw new Error('zip: 中央目录越界')
  if (count > LIMITS.entries) throw new Error('zip: 条目过多')

  const entries = []
  let p = cdOffset
  let total = 0
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('zip: 中央目录条目损坏')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const external = buf.readUInt32LE(p + 38)
    const localOffset = buf.readUInt32LE(p + 42)
    const timeField = buf.readUInt16LE(p + 12)
    const dateField = buf.readUInt16LE(p + 14)
    const rawName = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 0x0001) throw new Error('zip: 不支持加密条目 ' + rawName)
    if (((external >>> 16) & 0o170000) === 0o120000) throw new Error('zip: 拒绝符号链接 ' + rawName)
    const name = safeEntryName(rawName)
    if (name.endsWith('/')) continue
    const entryLimit = options.maxEntryBytes ?? LIMITS.entryBytes
    if (size > entryLimit) throw new Error('zip: 条目过大 ' + name)
    total += size
    if (total > (options.maxTotalBytes ?? LIMITS.totalBytes)) throw new Error('zip: 解压总量超过上限')
    if (size > 1024 * 1024 && size / Math.max(1, compSize) > LIMITS.ratio) {
      throw new Error('zip: 压缩比异常（疑似 zip bomb）' + name)
    }
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error('zip: 本地头损坏 ' + name)
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    if (dataStart + compSize > buf.length) throw new Error('zip: 条目数据越界 ' + name)
    const raw = buf.subarray(dataStart, dataStart + compSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) {
      // 声明长度只是「声称」：真的解压时也卡死上限，避免声明 0 字节的炸弹先膨胀到 GB 再报错
      const cap = Math.max(size, Math.min(entryLimit, 4096))
      try {
        data = inflateRawSync(raw, { maxOutputLength: cap })
      } catch (error) {
        if (/maxOutputLength|buffer/i.test(String(error?.message || error))) throw new Error('zip: 解压后超过声明长度（疑似 zip bomb）' + name)
        throw error
      }
    } else throw new Error('zip: 不支持的压缩方法 ' + method + ' ' + name)
    if (typeof crc === 'number' && (crc32(data) >>> 0) !== crc) throw new Error('zip: CRC 校验失败 ' + name)
    if (data.length !== size) throw new Error('zip: 解压长度不符 ' + name)
    entries.push({ name, data, mtime: dosToDate(timeField, dateField) })
  }
  return entries
}

/** 从条目数组里读一个文本文件；没有就返回 null。 */
export function readZipText(entries, name) {
  const hit = entries.find((e) => e.name === name)
  return hit ? hit.data.toString('utf8') : null
}

export const zipLimits = LIMITS
