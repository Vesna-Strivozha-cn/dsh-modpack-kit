/**
 * 分类：插件市场有分区，本插件照同一套分类给「本机已装」和「市场目录」打标签，
 * 让两边在同一张列表里能按类筛。纯字符串匹配，无网络、无副作用。
 *
 * 想加分类：往 CATEGORIES 加一条，再把关键词塞进 RULES；客户端 client.js 顶部的
 * CATEGORY_LABELS 只用来显示名字，两边 id 必须一致。
 *
 * 匹配规则（2026-11-15 修）：英文词按词边界匹配，避免 'ai' 命中 'detail'、'ui' 命中
 * 'build' 这类误判；中文词直接子串匹配。市场数据里带了 category/分区字段时优先采信。
 */

export const CATEGORIES = [
  { id: 'ui', label: '界面与外观' },
  { id: 'tool', label: '效率与工具' },
  { id: 'ai', label: 'AI 与模型' },
  { id: 'dev', label: '开发与调试' },
  { id: 'media', label: '媒体与内容' },
  { id: 'net', label: '网络与数据' },
  { id: 'pack', label: '打包与分发' },
  { id: 'other', label: '其它' },
]

const RULES = [
  { id: 'pack', words: ['modpack', 'installer', '插件市场', 'plugin market', 'marketplace', 'catalog', '整合包', '打包', '安装器'] },
  { id: 'ui', words: ['ui', 'theme', 'themes', 'skin', 'wallpaper', 'icon', 'sidebar', 'panel', 'layout', 'font', 'mascot', 'widget', '界面', '外观', '主题', '图标', '侧栏', '面板', '字体', '配色', '壁纸', '桌宠', '桌面', '挂件', 'locale', 'i18n', '语言'] },
  { id: 'ai', words: ['llm', 'model', 'gpt', 'claude', 'prompt', 'embedding', 'agent skills', 'skill deck', '技能', '技能包', '模型', '智能体', '推理', '记忆', '上下文'] },
  { id: 'dev', words: ['dev', 'debug', 'log', 'logs', 'lint', 'test', 'tests', 'code', 'git', 'trace', 'profiler', 'sandbox', '调试', '开发', '日志', '测试', '代码', '编译', '性能', '检查'] },
  { id: 'media', words: ['image', 'images', 'video', 'music', 'audio', 'media', 'bili', 'bilibili', 'subtitle', 'danmaku', 'screenshot', '图片', '视频', '音乐', '音频', '媒体', '字幕', '弹幕', '截图', 'B站'] },
  { id: 'net', words: ['http', 'api', 'proxy', 'sync', 'storage', 'database', 'webhook', 'sse', 'socket', 'websocket', 'mcp', 'network', '网络', '代理', '同步', '存储', '数据库', '连接'] },
  { id: 'tool', words: ['tool', 'tools', 'command', 'search', 'todo', 'note', 'notes', 'schedule', 'clipboard', 'calculator', 'shortcut', '工具', '效率', '快捷', '命令', '搜索', '待办', '笔记', '日程', '剪贴板', '计算'] },
]

const ALIASES = {
  ui: 'ui', theme: 'ui', themes: 'ui', appearance: 'ui', style: 'ui', wallpaper: 'ui',
  tool: 'tool', tools: 'tool', utility: 'tool', utilities: 'tool', productivity: 'tool', efficiency: 'tool',
  ai: 'ai', ai_agent: 'ai', model: 'ai', models: 'ai', llm: 'ai', agent: 'ai', memory: 'ai', context: 'ai',
  dev: 'dev', developer: 'dev', development: 'dev', debug: 'dev', devtools: 'dev', testing: 'dev',
  media: 'media', content: 'media', image: 'media', images: 'media', video: 'media', audio: 'media',
  net: 'net', network: 'net', networking: 'net', data: 'net', sync: 'net', storage: 'net', api: 'net',
  pack: 'pack', bundle: 'pack', bundles: 'pack', modpack: 'pack', market: 'pack', install: 'pack', distribution: 'pack',
  other: 'other', misc: 'other',
}

// 同分时的偏好：越具体的主题越优先，避免 'agent' 这类泛词把什么都吃成 AI
const TIE_PRIORITY = { media: 7, dev: 6, ui: 5, net: 4, tool: 3, ai: 2, pack: 1, other: 0 }

const ASCII_WORD = /^[\x20-\x7e]+$/
const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 英文按词边界（允许复数 s/es），中文按子串 */
function hit(hay, word) {
  const w = String(word || '').toLowerCase()
  if (!w) return false
  if (!ASCII_WORD.test(w)) return hay.includes(w)
  const pattern = w.length <= 2
    ? `(^|[^a-z0-9])${escapeRe(w)}([^a-z0-9]|$)`
    : `(^|[^a-z0-9])${escapeRe(w)}(s|es)?([^a-z0-9]|$)`
  return new RegExp(pattern, 'i').test(hay)
}

const asList = (value) => (Array.isArray(value) ? value.map((x) => String(x).toLowerCase()) : [])

/**
 * @param {{name?: string, title?: string, description?: string, tags?: string[], category?: string}} meta
 * @returns {{id: string, label: string, reason: string}}
 */
export function classifyPlugin(meta) {
  const name = String(meta?.name || '').toLowerCase()
  const title = String(meta?.title || '').toLowerCase()
  const rest = [String(meta?.description || '').toLowerCase(), ...asList(meta?.tags), String(meta?.category || '').toLowerCase()].join(' ')

  let best = null
  for (const rule of RULES) {
    // 每个字段只计一次，避免 'tool' 与 'tools' 同时命中把分数翻倍
    let score = 0
    const hits = []
    for (const [field, weight] of [[name, 5], [title, 3], [rest, 1]]) {
      const matched = rule.words.filter((word) => hit(field, word))
      if (!matched.length) continue
      matched.sort((a, b) => b.length - a.length)
      hits.push(...matched)
      score += weight
    }
    const better = !best
      || score > best.score
      || (score === best.score && hits.length > best.hits.length)
      || (score === best.score && hits.length === best.hits.length && (TIE_PRIORITY[rule.id] || 0) > (TIE_PRIORITY[best.id] || 0))
    if (score > 0 && better) best = { id: rule.id, score, hits }
  }

  // 市场数据里明确给了分区：优先采信，但仍要求上面没有更硬的证据（名字命中）
  const byAlias = ALIASES[String(meta?.category || '').toLowerCase().trim()]
  if (byAlias && (!best || best.score < 5)) {
    const label = (CATEGORIES.find((c) => c.id === byAlias) || { label: '其它' }).label
    return { id: byAlias, label, reason: '市场分区：' + meta.category }
  }

  if (!best) return { id: 'other', label: '其它', reason: '没有命中分类关键词' }
  const label = (CATEGORIES.find((c) => c.id === best.id) || { label: '其它' }).label
  return { id: best.id, label, reason: '命中：' + best.hits.slice(0, 3).join('、') }
}

export function categoryLabel(id) {
  return (CATEGORIES.find((c) => c.id === id) || { label: '其它' }).label
}
