/**
 * 社区资源目录（自建仓库 Vesna-Strivozha-cn/dsh-modpack-catalog）。
 *
 * 职责：拉 packs.json（jsDelivr / raw 两个源，取 builtAt 更新的那份）→ 落本地缓存 →
 * 归一化条目（分类/体量/插件列表/更新时间）→ 按分类、关键词、排序检索并分页 → 按 id 取包字节。
 *
 * 与 market-catalog.mjs 的区别：那个是插件市场的 npm 目录（dsh-plugin-catalog），
 * 这个是整合包社区目录（GitHub 仓库的 packs.json + packs/*.dshpack）。
 *
 * 关键符号：syncMarket / searchMarket / marketSummary / fetchMarketPack / normalizeCatalog
 * 对应路由：GET /market、POST /market/search、POST /market/sync、POST /market/download
 */
import fs from 'node:fs';
import path from 'node:path';

import { requestBuffer, requestJson } from './net.mjs';
import { pathsFor } from './store.mjs';

/**
 * 社区资源（自建目录）
 *
 * 与插件市场同一套思路，但目录是我们自己的仓库：
 *   data/packs/*.json  —— 每个整合包一份清单（PR 提交）
 *   packs.json         —— 每天由 CI 重新生成，客户端只读这一份
 *   packs/*.dshpack    —— 轻量包本体（十几 KB，直接放仓库里）
 *
 * 这里只做「读目录 / 检索 / 取包」三件事；校验、扫描、安装都复用 lib/install.mjs，
 * 免得另开一条装包路径养出第二套规则。
 */

export const MARKET_REPO = 'Vesna-Strivozha-cn/dsh-modpack-catalog';
export const MARKET_BRANCH = 'main';

export const MARKET_SOURCES = [
  'https://cdn.jsdelivr.net/gh/' + MARKET_REPO + '@' + MARKET_BRANCH + '/packs.json',
  'https://raw.githubusercontent.com/' + MARKET_REPO + '/' + MARKET_BRANCH + '/packs.json',
];

const SCHEMA = 1;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

export const CATEGORY_FALLBACK = [
  { id: 'work', label: '工作办公' },
  { id: 'perf', label: '性能优化' },
  { id: 'ui', label: '界面美化' },
  { id: 'util', label: '实用功能' },
  { id: 'dev', label: '开发调试' },
  { id: 'fun', label: '娱乐休闲' },
  { id: 'learn', label: '学习资料' },
  { id: 'sink', label: '水槽' },
  { id: 'other', label: '其它' },
];

// 体量档位：纯按插件总数算，作者不需要写，界面直接用（0-3 轻量 / 4-8 中型 / 9-12 大型 / 13+ 大宗）
export const TIER_BANDS = [
  { id: 'small', min: 0, max: 3 },
  { id: 'medium', min: 4, max: 8 },
  { id: 'large', min: 9, max: 12 },
  { id: 'huge', min: 13, max: Number.POSITIVE_INFINITY },
];

export function tierOf(count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  const band = TIER_BANDS.find((item) => n >= item.min && n <= item.max);
  return { id: band ? band.id : 'huge', count: n };
}

export function marketPaths(config) {
  const dir = path.join(pathsFor(config || {}).home, 'modpack-market');
  return { dir, file: path.join(dir, 'packs.cache.json') };
}

// 目录文件不大，但每次检索都重新解析 + 归一化一遍很浪费：按 mtime/size 记住上一次的结果
let cacheMemo = { key: '', value: null };

function readCache(config) {
  const { file } = marketPaths(config);
  let stat = null;
  try { stat = fs.statSync(file) } catch { stat = null }
  const key = stat ? file + '|' + stat.mtimeMs + '|' + stat.size : '';
  if (key && cacheMemo.key === key) return cacheMemo.value;
  let value;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.data) value = { present: false, data: null, fetchedAt: 0, sourceBase: '' };
    else value = {
      present: true,
      data: raw.data,
      fetchedAt: Number(raw.fetchedAt) || 0,
      sourceBase: String(raw.sourceBase || ''),
      source: String(raw.source || ''),
    };
  } catch {
    value = { present: false, data: null, fetchedAt: 0, sourceBase: '' };
  }
  cacheMemo = { key, value };
  return value;
}

function writeCache(config, payload) {
  const { dir, file } = marketPaths(config);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 只做形状校验：目录是我们自己的，但缓存文件可能被手改坏，读之前先挡一道。 */
function normalizeCatalog(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('目录格式不对（不是对象）');
  if (Number(raw.schema) !== SCHEMA) throw new Error('目录版本不认识：' + raw.schema);
  const packs = Array.isArray(raw.packs) ? raw.packs : [];
  const list = [];
  for (const pack of packs) {
    if (!pack || typeof pack !== 'object') continue;
    const id = String(pack.id || '');
    if (!id) continue;
    const plugins = Array.isArray(pack.plugins)
      ? pack.plugins
          .filter((plugin) => plugin && plugin.name)
          .map((plugin) => ({ name: String(plugin.name), version: String(plugin.version || ''), description: String(plugin.description || '') }))
      : [];
    list.push({
      id,
      name: String(pack.name || id),
      author: String(pack.author || ''),
      category: String(pack.category || '其它'),
      version: String(pack.version || '1.0.0'),
      strategy: String(pack.strategy || 'lite'),
      file: String(pack.file || ''),
      sha256: String(pack.sha256 || ''),
      size: Number(pack.size) || 0,
      createdAt: String(pack.createdAt || ''),
      description: {
        zh: String((pack.description && pack.description.zh) || ''),
        en: String((pack.description && pack.description.en) || ''),
      },
      plugins,
      homepage: String(pack.homepage || ''),
      // 下载量只认「这个包文件本身被下载了多少次」，不拿包内插件的 npm 下载量凑数：
      // 目录里没有计数渠道时就是 0（作者的下载量可以自己在清单里写）
      downloads: Number.isFinite(Number(pack.downloads)) && pack.downloads !== null && pack.downloads !== '' ? Number(pack.downloads) : null,
      updatedAt: String(pack.updatedAt || ''),
    });
    const last = list[list.length - 1];
    last.tier = tierOf(last.plugins.length).id;
    last.pluginCount = last.plugins.length;
    // 预先把检索要用的小写文本拼好：目录几千条时，省下的是每次按键都要重拼一遍的开销
    last.searchText = [last.name, last.author, last.category, last.tier, last.description.zh, last.description.en]
      .concat(last.plugins.map((plugin) => plugin.name + ' ' + plugin.description))
      .join(' ')
      .toLowerCase();
  }
  const categories = Array.isArray(raw.categories) && raw.categories.length > 0
    ? raw.categories.map((item) => ({
        id: String(item.id || ''),
        label: String(item.label || item.id || ''),
        count: Number(item.count) || 0,
      }))
    : CATEGORY_FALLBACK.map((item) => ({ ...item, count: list.filter((pack) => pack.category === item.label).length }));
  return { schema: SCHEMA, builtAt: String(raw.builtAt || ''), count: list.length, categories, packs: list };
}

/** 把目录里的「包地址」拼出来：来源决定前缀（jsDelivr 快，raw 兜底）。 */
function sourceBaseOf(sourceUrl) {
  const clean = String(sourceUrl || '').replace(/\/packs\.json$/u, '');
  return clean;
}

export function packFileUrl(pack, sourceBase) {
  const base = String(sourceBase || MARKET_SOURCES[0].replace(/\/packs\.json$/u, ''));
  return base + '/packs/' + encodeURIComponent(pack.file || '');
}

export function marketSummary(config) {
  const cache = readCache(config);
  const now = Date.now();
  const hours = Math.max(1, Math.min(168, Number(config && config.modpackRefreshHours) || 24));
  const ttl = hours * 60 * 60 * 1000;
  if (!cache.present || !cache.data) {
    return {
      present: false,
      stale: true,
      count: 0,
      builtAt: '',
      fetchedAt: 0,
      categories: CATEGORY_FALLBACK.map((item) => ({ ...item, count: 0 })),
      ttlHours: hours,
      repo: MARKET_REPO,
    };
  }
  return {
    present: true,
    stale: now - cache.fetchedAt > ttl,
    count: Number(cache.data.count) || 0,
    builtAt: String(cache.data.builtAt || ''),
    fetchedAt: cache.fetchedAt,
    categories: Array.isArray(cache.data.categories) ? cache.data.categories : [],
    ttlHours: hours,
    repo: MARKET_REPO,
    ageMs: now - cache.fetchedAt,
  };
}

/**
 * 拉一次目录。逐源回退；成功就写缓存（缓存里带 sourceBase，后面取包按同一个源走）。
 * 失败不动旧缓存——旧的目录总比没有强。
 */
export async function syncMarket(config, options = {}) {
  const force = options.force === true;
  const summary = marketSummary(config);
  const maxAge = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : CACHE_TTL_MS;
  if (!force && summary.present && !summary.stale && Date.now() - summary.fetchedAt < maxAge) {
    return { ok: true, skipped: true, summary };
  }
  const errors = [];
  const started = Date.now();
  // 逐源取一遍，谁更新用谁：jsDelivr 对 gh 的缓存可能落后一整天，
  // 如果只因为「它先回 200」就用它，会拿到已经删掉的包。两个源都很小，取两次不心疼。
  let best = null;
  for (const url of MARKET_SOURCES) {
    try {
      const raw = await requestJson(url, config, { maxBytes: MAX_CATALOG_BYTES, timeoutMs: 15000, retries: 1 });
      const data = normalizeCatalog(raw);
      const builtAt = Date.parse(data.builtAt || '') || 0;
      if (!best || builtAt > best.builtAt) {
        best = { url, data, sourceBase: sourceBaseOf(url), builtAt };
      }
    } catch (error) {
      errors.push(url + '：' + String((error && error.message) || error));
    }
  }
  if (best) {
    writeCache(config, {
      fetchedAt: Date.now(),
      source: best.url,
      sourceBase: best.sourceBase,
      data: { schema: best.data.schema, builtAt: best.data.builtAt, count: best.data.count, categories: best.data.categories, packs: best.data.packs },
    });
    return { ok: true, skipped: false, source: best.url, ms: Date.now() - started, count: best.data.count, summary: marketSummary(config) };
  }
  return { ok: false, error: '整合包目录都取不到：' + errors.join('；'), summary };
}

function installedState(pack, installedNames) {
  const plugins = Array.isArray(pack.plugins) ? pack.plugins : [];
  if (plugins.length === 0) return { all: false, some: false, count: 0 };
  let hit = 0;
  for (const plugin of plugins) if (installedNames.has(plugin.name)) hit += 1;
  return { all: hit === plugins.length, some: hit > 0, count: hit };
}

function relevance(pack, needle, tokens) {
  const own = String(pack.name || '').toLowerCase();
  const author = String(pack.author || '').toLowerCase();
  const zh = String((pack.description && pack.description.zh) || '').toLowerCase();
  const en = String((pack.description && pack.description.en) || '').toLowerCase();
  const pluginText = (pack.plugins || []).map((plugin) => (plugin.name + ' ' + (plugin.description || '')).toLowerCase()).join(' ');
  let score = 0;
  const hit = (text, weight) => {
    if (!text) return 0;
    if (text === needle) return weight * 3;
    if (text.includes(needle)) return weight * 2;
    let partial = 0;
    for (const token of tokens) if (token && text.includes(token)) partial += 1;
    return partial > 0 ? weight + Math.min(partial, 4) : 0;
  };
  score += hit(own, 40);
  score += hit(author, 20);
  score += hit(pluginText, 16);
  score += hit(zh, 10);
  score += hit(en, 8);
  return score;
}

/** 搜索与分页都在服务端做：客户端只拿一页，目录再大也不会卡界面。 */
export function searchMarket(config, options = {}) {
  const cache = readCache(config);
  if (!cache.present || !cache.data) return { ok: false, error: '还没有整合包目录：先点一次「更新目录」', present: false };
  const installedNames = new Set(Array.isArray(options.installed) ? options.installed.map((name) => String(name)) : []);
  const query = String(options.query || '').trim().toLowerCase();
  const category = String(options.category || 'all');
  const pageSize = Math.max(1, Math.min(60, Number(options.pageSize) || 20));
  const page = Math.max(1, Number(options.page) || 1);
  const tokens = query.split(/[\s,，、+]+/u).filter(Boolean);

  let list = cache.data.packs.map((pack) => ({ ...pack, installed: installedState(pack, installedNames) }));
  if (category !== 'all') list = list.filter((pack) => pack.category === category);
  if (query) {
    // 先用预拼好的小写文本做一次便宜的全词过滤，再算分数：
    // 目录五千条时，这一步能省掉绝大多数不相关的打分
    const narrowed = list.filter((pack) => !pack.searchText || tokens.every((token) => pack.searchText.includes(token)))
    list = (narrowed.length > 0 ? narrowed : list)
      .map((pack) => ({ pack, score: relevance(pack, query, tokens) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((row) => row.pack);
  } else {
    const sort = String(options.sort || 'new');
    list.sort((a, b) => {
      if (a.installed.all !== b.installed.all) return a.installed.all ? -1 : 1;
      if (sort === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN');
      if (sort === 'size') return a.size - b.size;
      if (sort === 'downloads') return b.downloads - a.downloads;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  }

  const total = list.length;
  const start = (page - 1) * pageSize;
  const items = list.slice(start, start + pageSize).map((pack) => ({
    ...pack,
    url: packFileUrl(pack, cache.sourceBase),
  }));
  return {
    ok: true,
    present: true,
    query,
    category,
    page,
    pageSize,
    total,
    hasMore: start + items.length < total,
    items,
    summary: marketSummary(config),
  };
}

/** 取一个整合包的字节。只允许目录里登记过的文件、只走 https 白名单。 */
export async function fetchMarketPack(config, pack) {
  const cache = readCache(config);
  const base = cache.sourceBase || sourceBaseOf(MARKET_SOURCES[0]);
  const url = packFileUrl(pack, base);
  const maxBytes = Math.min(Number((config && config.maxDownloadBytes) || 128 * 1024 * 1024), 128 * 1024 * 1024);
  const buffer = await requestBuffer(url, config, {
    maxBytes,
    accept: 'application/octet-stream, application/zip, */*',
    timeoutMs: 60000,
  });
  return { buffer, url };
}

export function findMarketPack(config, id) {
  const cache = readCache(config);
  if (!cache.present || !cache.data) return { ok: false, error: '还没有整合包目录' };
  const pack = cache.data.packs.find((item) => item.id === String(id || ''));
  if (!pack) return { ok: false, error: '目录里没有这个整合包：' + String(id || '') };
  return { ok: true, pack, sourceBase: cache.sourceBase };
}
