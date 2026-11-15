/**
 * dsh-modpack —— 极小 semver（够判兼容性，不做完整实现）。
 *
 * 支持：`1.2.3`、`^`、`~`、`>= <= > <`、`*`/`x`、逗号或空格分隔的与、`||` 分隔的或。
 * 不支持：hyphen range、预发布标签的优先级细节。判断插件 peer 兼容够用，
 * 遇到看不懂的范围一律返回 `unknown`，不假装通过。
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u

export function parseVersion(input) {
  if (input === null || input === undefined) return null
  const m = VERSION_RE.exec(String(input).trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' }
}

export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === '') return 1
  if (pb.pre === '') return -1
  return pa.pre < pb.pre ? -1 : 1
}

const isWild = (part) => part === undefined || part === '' || part === '*' || part === 'x' || part === 'X'

function bound(major, minor, patch, pre, op) {
  return { major, minor, patch, pre: pre || '', op }
}

/** 把一个比较符句子（如 `^1.2.3`、`>=1.0.0 <2.0.0`）展开成下界/上界。 */
function parseComparatorSet(text) {
  const parts = String(text).trim().split(/\s+/u).filter(Boolean)
  if (parts.length === 0) return { any: true }
  const bounds = []
  for (const part of parts) {
    const m = /^(\^|~|>=|<=|>|<|=)?\s*(.*)$/u.exec(part)
    const op = m[1] || ''
    const rest = m[2]
    if (rest === '' || rest === '*' || rest === 'x') {
      if (op === '' || op === '=' || op === '>=') continue
      if (op === '<' || op === '<=') return { impossible: true }
      continue
    }
    const nums = rest.split('.').map((s) => s.trim())
    const majorRaw = nums[0]
    const minorRaw = nums[1]
    const patchRaw = nums[2]
    if (isWild(majorRaw)) {
      if (op === '' || op === '=' || op === '>=' || op === '^' || op === '~') continue
      if (op === '<' || op === '<=') return { impossible: true }
      continue
    }
    if (!/^\d+$/u.test(majorRaw)) return null
    const major = Number(majorRaw)
    const minorWild = isWild(minorRaw)
    const patchWild = isWild((patchRaw || '').split('-')[0])
    const minor = minorWild ? 0 : Number(minorRaw)
    const patchPart = (patchRaw || '0').split('-')
    const patch = patchWild ? 0 : Number(patchPart[0])
    const pre = patchPart.slice(1).join('-')
    if (Number.isNaN(minor) || Number.isNaN(patch)) return null

    if (op === '^') {
      bounds.push(bound(major, minor, patch, pre, '>='))
      if (major > 0) bounds.push(bound(major + 1, 0, 0, '', '<'))
      else if (minorWild) bounds.push(bound(1, 0, 0, '', '<'))
      else if (patchWild) bounds.push(bound(0, minor + 1, 0, '', '<'))
      // ^0.0.3 只允许 0.0.3 本身（npm 语义：上界 0.0.4），^0.x 上界 0.(x+1).0
      else if (minor === 0) bounds.push(bound(0, 0, patch + 1, '', '<'))
      else bounds.push(bound(0, minor + 1, 0, '', '<'))
      continue
    }
    if (op === '~') {
      bounds.push(bound(major, minor, patch, pre, '>='))
      bounds.push(minorWild ? bound(major + 1, 0, 0, '', '<') : bound(major, minor + 1, 0, '', '<'))
      continue
    }
    if (op === '>' || op === '>=' || op === '<' || op === '<=') {
      bounds.push(bound(major, minor, patch, pre, op))
      continue
    }
    // 裸版本 / `=`：x.y.z 精确；x.y 视为 ~x.y；x 视为 ^x
    if (minorWild) {
      bounds.push(bound(major, 0, 0, '', '>='))
      bounds.push(bound(major + 1, 0, 0, '', '<'))
    } else if (patchWild) {
      bounds.push(bound(major, minor, 0, '', '>='))
      bounds.push(bound(major, minor + 1, 0, '', '<'))
    } else {
      bounds.push(bound(major, minor, patch, pre, '='))
    }
  }
  return { bounds }
}

function testBounds(version, bounds) {
  for (const b of bounds) {
    const cmp = compareVersions(version, `${b.major}.${b.minor}.${b.patch}${b.pre ? '-' + b.pre : ''}`)
    if (cmp === null) return null
    if (b.op === '=' && cmp !== 0) return false
    if (b.op === '>' && cmp <= 0) return false
    if (b.op === '>=' && cmp < 0) return false
    if (b.op === '<' && cmp >= 0) return false
    if (b.op === '<=' && cmp > 0) return false
  }
  return true
}

/**
 * @returns {boolean|null} null = 范围看不懂 / 版本非法，不要当成通过。
 */
export function satisfies(version, range) {
  if (!parseVersion(version)) return null
  if (range === undefined || range === null) return true
  const text = String(range).trim()
  if (text === '' || text === '*' || text === 'x') return true
  const sets = text.split('||')
  let sawUnknown = false
  for (const set of sets) {
    const parsed = parseComparatorSet(set)
    if (!parsed) { sawUnknown = true; continue }
    if (parsed.impossible) continue
    if (parsed.any) return true
    const ok = testBounds(version, parsed.bounds)
    if (ok === true) return true
    if (ok === null) sawUnknown = true
  }
  return sawUnknown ? null : false
}

/** 从依赖表里挑一个字符串范围。 */
export function rangeOf(range) {
  if (typeof range === 'string') return range
  if (range && typeof range === 'object' && typeof range.version === 'string') return range.version
  return '*'
}
