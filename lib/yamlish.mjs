/**
 * dsh-modpack —— 够用的 YAML 子集（只服务 profile 的 cordis.patch.yml）。
 *
 * 为什么不用 js-yaml：插件不该为了读一个补丁文件多背一个依赖；而这个文件
 * 的形状是固定的（顶层列表，元素里是 id/name/disabled/config，值是标量、
 * 嵌套映射、字符串列表和块标量）。
 *
 * 边界：支持块状映射/序列、单双引号、块标量 `|` `>`、flow 的 `[]` `{}`、
 * 注释、布尔/null/数字。不支持锚点、多文档、tag、复杂键。解析失败会抛错，
 * 调用方必须回退到「只报告、不自动改」——猜错的 YAML 比不改更危险。
 */

class YamlError extends Error {}

function stripComment(line) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle && line[i - 1] !== '\\') inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/u.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

const indentOf = (line) => line.length - line.trimStart().length

function parseDoubleQuoted(text) {
  const body = text.slice(1, -1)
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch !== '\\') { out += ch; continue }
    const next = body[i + 1]
    i += 1
    switch (next) {
      case 'n': out += '\n'; break
      case 't': out += '\t'; break
      case 'r': out += '\r'; break
      case '"': out += '"'; break
      case '\\': out += '\\'; break
      case '0': out += '\0'; break
      case 'u': {
        out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 5), 16))
        i += 4
        break
      }
      default: out += '\\' + (next ?? '')
    }
  }
  return out
}

function parseSingleQuoted(text) {
  return text.slice(1, -1).replace(/''/gu, "'")
}

/** flow 序列/映射（只用于 `[a, b]` / `{a: b}` 这种一行写完的值）。 */
function parseFlow(text) {
  let i = 0
  const ws = () => { while (i < text.length && /\s/u.test(text[i])) i += 1 }
  const scalar = () => {
    ws()
    if (text[i] === '"') {
      const start = i
      i += 1
      while (i < text.length && !(text[i] === '"' && text[i - 1] !== '\\')) i += 1
      i += 1
      return parseDoubleQuoted(text.slice(start, i))
    }
    if (text[i] === "'") {
      const start = i
      i += 1
      while (i < text.length && text[i] !== "'") i += 1
      i += 1
      return parseSingleQuoted(text.slice(start, i))
    }
    if (text[i] === '[') return list()
    if (text[i] === '{') return map()
    const start = i
    while (i < text.length && !/[,\]}:]/u.test(text[i])) i += 1
    return parseScalar(text.slice(start, i).trim())
  }
  const list = () => {
    i += 1
    const out = []
    ws()
    if (text[i] === ']') { i += 1; return out }
    for (;;) {
      out.push(scalar())
      ws()
      if (text[i] === ',') { i += 1; continue }
      if (text[i] === ']') { i += 1; break }
      throw new YamlError('flow 序列语法错误：' + text)
    }
    return out
  }
  const map = () => {
    i += 1
    const out = {}
    ws()
    if (text[i] === '}') { i += 1; return out }
    for (;;) {
      ws()
      let key
      if (text[i] === '"' || text[i] === "'") {
        // 用 JSON 写出来的 flow 映射键是带引号的，这里必须去引号，否则读回来会多出一层引号。
        key = scalar()
        ws()
        if (text[i] !== ':') throw new YamlError('flow 映射缺少冒号：' + text)
        i += 1
      } else {
        const keyStart = i
        while (i < text.length && text[i] !== ':') i += 1
        key = text.slice(keyStart, i).trim()
        i += 1
      }
      out[key] = scalar()
      ws()
      if (text[i] === ',') { i += 1; continue }
      if (text[i] === '}') { i += 1; break }
      throw new YamlError('flow 映射语法错误：' + text)
    }
    return out
  }
  const value = scalar()
  ws()
  if (i !== text.length) throw new YamlError('flow 值后有多余内容：' + text)
  return value
}

function parseScalar(raw) {
  const text = raw.trim()
  if (text === '') return ''
  if (text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null
  if (/^(?:true|True|TRUE)$/u.test(text)) return true
  if (/^(?:false|False|FALSE)$/u.test(text)) return false
  if (/^[+-]?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/u.test(text)) return Number(text)
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return parseDoubleQuoted(text)
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return parseSingleQuoted(text)
  if (text.startsWith('[') || text.startsWith('{')) return parseFlow(text)
  return text
}

class Parser {
  constructor(text) {
    this.raw = text
    this.lines = text.split(/\r?\n/u)
    this.i = 0
  }

  skipBlank() {
    while (this.i < this.lines.length) {
      const line = stripComment(this.lines[this.i])
      if (line.trim() !== '') return
      this.i += 1
    }
  }

  /** 解析从当前行开始、缩进 >= indent 的块。 */
  parseBlock(indent) {
    this.skipBlank()
    if (this.i >= this.lines.length) return null
    const line = stripComment(this.lines[this.i])
    if (indentOf(line) < indent) return null
    if (/^\s*- /u.test(line) || /^\s*-$/u.test(line)) return this.parseSequence(indent)
    return this.parseMapping(indent)
  }

  parseSequence(indent) {
    const out = []
    for (;;) {
      this.skipBlank()
      if (this.i >= this.lines.length) break
      const rawLine = stripComment(this.lines[this.i])
      if (indentOf(rawLine) !== indent) break
      if (!/^-(\s|$)/u.test(rawLine.trimStart())) break
      const rest = rawLine.trimStart().slice(1)
      if (rest.trim() === '') {
        this.i += 1
        out.push(this.parseBlock(indent + 2))
        continue
      }
      if (/^\s+\S/u.test(rest) && /^[^\s]['"]?.*?:\s/u.test(rest.trim())) {
        // `- id: x` —— 把这一行改写成更深缩进的映射首行
        const innerIndent = indent + 2
        this.lines[this.i] = ' '.repeat(innerIndent) + rest.trimStart()
        out.push(this.parseMapping(innerIndent))
        continue
      }
      this.i += 1
      out.push(this.parseInlineValue(rest.trim(), indent))
    }
    return out
  }

  parseInlineValue(text, indent) {
    if (/^[|>][+-]?$/u.test(text) || /^[|>][+-]?\s/u.test(text)) return this.parseBlockScalar(text, indent)
    return parseScalar(text)
  }

  parseBlockScalar(header, indent) {
    const style = header[0]
    const chomp = header.slice(1).trim()
    const collected = []
    let blockIndent = -1
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]
      if (line.trim() === '') { collected.push(''); this.i += 1; continue }
      const ind = indentOf(line)
      if (ind <= indent) break
      if (blockIndent === -1) blockIndent = ind
      if (ind < blockIndent) break
      collected.push(line.slice(blockIndent))
      this.i += 1
    }
    while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
    const text = style === '|' ? collected.join('\n') : collected.join(' ').replace(/\s+/gu, ' ').trim()
    if (chomp === '-') return text
    return text + '\n'
  }

  parseMapping(indent) {
    const out = {}
    for (;;) {
      this.skipBlank()
      if (this.i >= this.lines.length) break
      const rawLine = stripComment(this.lines[this.i])
      if (indentOf(rawLine) !== indent) break
      if (/^-(\s|$)/u.test(rawLine.trimStart())) break
      const m = /^([^:]+?):(?:\s+(.*))?$/u.exec(rawLine.trim())
      if (!m) throw new YamlError('无法解析第 ' + (this.i + 1) + ' 行：' + this.lines[this.i])
      const key = parseScalar(m[1].trim())
      const rest = (m[2] ?? '').trim()
      this.i += 1
      if (rest === '') {
        const next = this.peekMeaningful()
        if (next && next.indent > indent) out[key] = this.parseBlock(next.indent)
        else if (next && next.indent === indent && /^-(\s|$)/u.test(next.text.trimStart())) out[key] = this.parseSequence(indent)
        else out[key] = null
      } else if (/^[|>][+-]?$/u.test(rest)) {
        out[key] = this.parseBlockScalar(rest, indent)
      } else {
        out[key] = parseScalar(rest)
      }
    }
    return out
  }

  peekMeaningful() {
    let j = this.i
    while (j < this.lines.length) {
      const line = stripComment(this.lines[j])
      if (line.trim() !== '') return { indent: indentOf(line), text: line, line: j }
      j += 1
    }
    return null
  }
}

/** 解析整份 YAML 文档；顶层可以是列表或映射。 */
export function parseYaml(text) {
  const parser = new Parser(String(text ?? ''))
  parser.skipBlank()
  if (parser.i >= parser.lines.length) return []
  const first = stripComment(parser.lines[parser.i])
  if (indentOf(first) !== 0) throw new YamlError('顶层缩进不为 0')
  const result = /^-(\s|$)/u.test(first.trimStart()) ? parser.parseSequence(0) : parser.parseMapping(0)
  parser.skipBlank()
  if (parser.i < parser.lines.length) throw new YamlError('第 ' + (parser.i + 1) + ' 行之后有无法解析的内容')
  return result
}

const PLAIN_SAFE = /^[A-Za-z0-9_./@+-]+$/u

export function emitScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  const text = String(value)
  if (text === '') return '""'
  if (PLAIN_SAFE.test(text) && !/^(?:true|false|null|~|\d+)$/iu.test(text)) return text
  return JSON.stringify(text)
}

/** 把 JSON 安全值写成 YAML 行（不含结尾换行）。 */
export function emitYaml(value, indent = 0) {
  const pad = ' '.repeat(indent)
  const lines = []
  if (Array.isArray(value)) {
    if (value.length === 0) return pad + '[]'
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const nested = emitYaml(item, indent + 2).split('\n')
        lines.push(pad + '- ' + nested[0].trimStart())
        lines.push(...nested.slice(1))
      } else if (Array.isArray(item)) {
        lines.push(pad + '- ' + emitYaml(item, indent + 2).trimStart())
      } else {
        lines.push(pad + '- ' + emitScalar(item))
      }
    }
    return lines.join('\n')
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) return pad + '{}'
    for (const key of keys) {
      const v = value[key]
      if (v !== null && typeof v === 'object') {
        const isEmpty = Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0
        if (isEmpty) {
          // 空数组/空对象必须写在同一行：写成「key:」再另起一行「[]」是非法 YAML。
          lines.push(pad + emitScalar(key) + ': ' + (Array.isArray(v) ? '[]' : '{}'))
        } else {
          lines.push(pad + emitScalar(key) + ':')
          lines.push(...emitYaml(v, indent + 2).split('\n'))
        }
      } else {
        lines.push(pad + emitScalar(key) + ': ' + emitScalar(v))
      }
    }
    return lines.join('\n')
  }
  return pad + emitScalar(value)
}

/**
 * 把 patch 文件切成顶层条目，保留每条原文与行范围。
 * 注释和空行归到「它前面那条」的尾巴里，这样替换一条不会吃掉相邻注释。
 * @returns {{items: {start: number, end: number, raw: string, value: any}[], preamble: string, postamble: string, lines: string[]}}
 */
export function splitTopLevelItems(text) {
  const lines = String(text ?? '').split(/\r?\n/u)
  const starts = []
  for (let i = 0; i < lines.length; i += 1) {
    if (/^-(\s|$)/u.test(lines[i])) starts.push(i)
  }
  const preamble = starts.length === 0 ? lines.join('\n') : lines.slice(0, starts[0]).join('\n')
  const items = []
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k]
    const endExclusive = k + 1 < starts.length ? starts[k + 1] : lines.length
    // 尾部注释/空行留给下一条，避免把「下一条的说明」并进本条
    let cut = endExclusive
    while (cut > start + 1 && /^\s*(?:#.*)?$/u.test(lines[cut - 1])) cut -= 1
    const chunk = lines.slice(start, cut)
    let value = null
    try {
      value = parseYaml(chunk.join('\n'))[0]
    } catch {
      value = null
    }
    items.push({ start, end: cut, raw: chunk.join('\n'), value })
  }
  const lastEnd = items.length > 0 ? items[items.length - 1].end : lines.length
  const postamble = lines.slice(lastEnd).join('\n')
  return { items, preamble, postamble, lines }
}

/**
 * 在 patch 文本里按 id 替换一条，或追加一条。其他条目逐字节保留。
 * @param {string} text 原 patch 文本
 * @param {{id: string, name?: string, config?: any, disabled?: boolean}} value
 * @returns {{text: string, action: 'replaced'|'inserted'}}
 */
export function upsertPatchItem(text, value) {
  const { items, preamble, postamble, lines } = splitTopLevelItems(text)
  const emitted = emitYaml([{ ...value, config: value.config ?? {} }], 0)
  const index = items.findIndex((it) => it.value && it.value.id === value.id)
  if (index === -1) {
    const base = String(text ?? '')
    const trimmed = base.replace(/\s*$/u, '')
    return { text: (trimmed === '' ? '' : trimmed + '\n') + emitted + '\n', action: 'inserted' }
  }
  const target = items[index]
  const trailingNewline = String(text ?? '').endsWith('\n')
  const rebuilt = [...lines.slice(0, target.start), ...emitted.split('\n'), ...lines.slice(target.end)].join('\n')
  const out = trailingNewline && !rebuilt.endsWith('\n') ? rebuilt + '\n' : rebuilt
  return { text: out, action: 'replaced' }
}

/** 取某个 id 的条目值。 */
export function findPatchItem(text, id) {
  try {
    const list = parseYaml(text)
    if (!Array.isArray(list)) return null
    return list.find((it) => it && typeof it === 'object' && it.id === id) ?? null
  } catch {
    return null
  }
}

export { YamlError }
