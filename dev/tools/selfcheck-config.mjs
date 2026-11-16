/**
 * 自检：自定义配置能不能原样跟着包走，敏感字段有没有被单独处理，
 * 以及「裸 DSH」用包内安装器装的时候配置是否也能落进 cordis.patch.yml。
 * 只读写临时目录；跑完自己清理。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { captureConfigs, captureData as captureDataModule } from '../../lib/pack.mjs';
import { upsertPatchItem, parseYaml, emitYaml } from '../../lib/yamlish.mjs';
import { writeZip } from '../../lib/zip.mjs';
import { sha256 } from '../../lib/manifest.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const home = path.join(os.homedir(), '.dsh');
const profile = 'modpack-selfcheck-' + Math.random().toString(36).slice(2, 8);
const profileDir = path.join(home, 'profiles', profile);
const vendorDir = path.join(home, 'dsh-modpack', 'vendor');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-modpack-selfcheck-'));

const results = [];
const ok = (name) => { results.push(['ok', name]); console.log('ok   ' + name); };
const bad = (name, why) => { results.push(['bad', name, why]); console.log('FAIL ' + name + (why ? ' :: ' + why : '')); };
const check = (name, fn) => {
  try {
    const why = fn();
    if (why) bad(name, why); else ok(name);
  } catch (error) {
    bad(name, String(error && error.message ? error.message : error));
  }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const deepConfig = {
  endpoint: 'https://api.example.invalid/v1',
  model: 'deepseek-chat',
  temperature: 0.35,
  maxTokens: 4096,
  stream: true,
  fallback: null,
  tokenizer: 'cl100k_base',
  apiKeyEnv: 'DEMO_API_KEY',
  headers: { 'X-Trace': 'on', 'X-Mode': 'beta' },
  stop: ['\n\n', '###'],
  rules: [
    { match: '^/help', reply: '看这里：第一行\n第二行', weight: 2 },
    { match: '中文·标点：全角', reply: '中文也要活着', weight: 1, tags: [] },
  ],
  prompts: { system: '你是达妮卡。\n保持简洁。', extra: {} },
  paths: { watch: 'D:/works/notes', skip: [] },
  secret: 'sk-this-should-be-redacted-000111',
  password: 'hunter2',
  nested: { deeper: { token: 'abcdef123456', flag: false } },
};
const expectedRedacted = ['secret', 'password', 'nested.deeper.token'].sort();

function fakePatchText() {
  return [
    '- id: demo',
    '  name: demo-plugin',
    '  config:',
    '    endpoint: https://legacy.invalid',
    '- id: other',
    '  name: other-plugin',
    '',
  ].join('\n');
}

check('配置抓取：嵌套对象/数组/中文/多行原样保留，只有疑似凭据被替换', () => {
  // 真实 profile 的补丁是块状 YAML，这里照同一格式造一份。
  const patch = emitYaml([{ id: 'demo', name: 'demo-plugin', config: deepConfig }]) + '\n';
  const { captured, notes } = captureConfigs(patch, [{ name: 'demo-plugin' }], parseYaml);
  const snap = captured.get('demo-plugin');
  if (!snap) return '没抓到配置';
  const cfg = snap.config;
  const want = JSON.parse(JSON.stringify(deepConfig));
  for (const key of ['secret', 'password']) want[key] = '${REDACTED}';
  want.nested.deeper.token = '${REDACTED}';
  if (!eq(cfg, want)) return '配置内容被改动：' + JSON.stringify(cfg).slice(0, 400);
  if (!eq((snap.configRedacted || []).slice().sort(), expectedRedacted)) return 'redacted 路径不对：' + JSON.stringify(snap.configRedacted);
  if (!notes.some((n) => n.includes('${REDACTED}'))) return '说明里没提醒要重填';
  if (snap.disabled !== undefined) return 'disabled 不该有值';
  return '';
});

check('配置回填：写回 patch 后仍能读回同样的结构（含数组里的多行中文）', () => {
  const patch = fakePatchText();
  const cfg = {
    endpoint: 'https://api.example.invalid/v1',
    stop: ['\n\n', '###'],
    rules: [{ match: '^/help', reply: '看这里：第一行\n第二行', weight: 2 }],
    prompts: { system: '你是达妮卡。\n保持简洁。', extra: {} },
    emptyList: [],
    emptyMap: {},
  };
  const { text, action } = upsertPatchItem(patch, { id: 'demo', name: 'demo-plugin', config: cfg });
  if (action !== 'replaced') return '没替换到原有条目：' + action;
  const items = parseYaml(text);
  const demo = items.find((item) => item && item.id === 'demo');
  if (!demo) return '读回时找不到条目';
  if (!eq(demo.config, cfg)) return '读回内容不一致：' + JSON.stringify(demo.config);
  const other = items.find((item) => item && item.id === 'other');
  if (!other || other.name !== 'other-plugin') return '别的条目被改坏了';
  return '';
});

check('配置回填：包里的条目在本机还不存在时会追加，不覆盖别的插件', () => {
  const patch = '- id: other\n  name: other-plugin\n';
  const { text, action } = upsertPatchItem(patch, { id: 'demo', name: 'demo-plugin', config: { a: 1, list: [1, 2] } });
  if (action !== 'inserted') return '应插入新条目，实际：' + action;
  const items = parseYaml(text);
  if (items.length !== 2) return '条目数不对：' + items.length;
  const demo = items.find((item) => item && item.id === 'demo');
  if (!demo || !eq(demo.config, { a: 1, list: [1, 2] })) return '新条目配置不对';
  return '';
});

check('数据快照：文本数据带得走，凭证类文件名跳过', () => {
  const dir = path.join(home, 'demo-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.md'), '# 笔记\n中文行\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ seen: 3, last: 'demo' }), 'utf8');
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{"token":"x"}', 'utf8');
  const { files, notes } = captureDataModule('demo-plugin', { maxBytes: 1024 * 1024 });
  const names = files.map((f) => f.name);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!names.some((n) => n.endsWith('notes.md'))) return '笔记没带上：' + names.join(',');
  if (!names.some((n) => n.endsWith('state.json'))) return 'state.json 没带上：' + names.join(',');
  if (names.some((n) => n.includes('credentials'))) return '凭证文件也被带上了';
  if (!notes.some((n) => n.includes('凭证'))) return '跳过凭证没有说明';
  return '';
});

check('裸 DSH 安装：包内安装器把嵌套配置写进 cordis.patch.yml', () => {
  fs.mkdirSync(path.join(profileDir), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: profile, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2), 'utf8');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: keep-me\n  name: keep-me\n', 'utf8');

  const packRoot = path.join(tmp, 'pack');
  const pluginDir = path.join(packRoot, 'plugins', 'demo-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', main: 'index.js' }, null, 2), 'utf8');
  fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export default { apply() {} }\n', 'utf8');

  const cfg = {
    endpoint: 'https://api.example.invalid/v1',
    stop: ['\n\n', '###'],
    rules: [{ match: '^/help', reply: '看这里：第一行\n第二行', weight: 2 }],
    prompts: { system: '你是达妮卡。\n保持简洁。', extra: {} },
    apiKeyEnv: 'DEMO_API_KEY',
    secret: '${REDACTED}',
    emptyList: [],
  };
  fs.mkdirSync(path.join(packRoot, 'configs'), { recursive: true });
  fs.writeFileSync(path.join(packRoot, 'configs', 'demo-plugin.json'), JSON.stringify({ id: 'demo', name: 'demo-plugin', config: cfg }, null, 2), 'utf8');

  const dataBase = 'selfcheck-data-' + Math.random().toString(36).slice(2, 8);
  fs.mkdirSync(path.join(packRoot, 'data', dataBase), { recursive: true });
  fs.writeFileSync(path.join(packRoot, 'data', dataBase, 'notes.md'), '# 自检数据\n中文行\n', 'utf8');
  fs.writeFileSync(path.join(packRoot, 'data', dataBase, 'state.json'), JSON.stringify({ seen: 7 }), 'utf8');

  for (const [from, to] of [['install-stub.mjs', 'install.mjs'], ['install-stub.cmd', 'install.cmd'], ['install-stub.sh', 'install.sh']]) {
    fs.mkdirSync(path.join(packRoot, 'install'), { recursive: true });
    fs.copyFileSync(path.join(root, 'assets', from), path.join(packRoot, 'install', to));
  }

  const manifest = {
    schema: 1,
    kind: 'dsh-modpack',
    format: 'full',
    name: '自检包',
    description: '自检用',
    author: '自检',
    createdAt: '2026-11-16T00:00:00.000Z',
    plugins: [{ name: 'demo-plugin', version: '1.0.0', source: 'profile', dirName: 'demo-plugin', files: 2, size: 120, mode: 'local', configIncluded: true, dataIncluded: true, dataDirs: [dataBase] }],
    files: [],
    security: { scanned: true, high: 0, medium: 0, low: 0 },
    options: { includePayload: true, includeConfig: true, includeLocalEdits: true, keepLocalOnInstall: false },
    install: { restartRequired: true, notes: [] },
  };
  fs.writeFileSync(path.join(packRoot, 'dsh-modpack.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(packRoot, 'README.txt'), '自检包\n', 'utf8');

  const fakeCli = path.join(tmp, 'fake-cli.mjs');
  fs.writeFileSync(fakeCli, 'process.exit(0)\n', 'utf8');

  const run = spawnSync(process.execPath, [path.join(packRoot, 'install', 'install.mjs'), '--profile', profile, '--dsh', fakeCli, '--no-bundles'], {
    encoding: 'utf8',
    timeout: 120000,
  });
  const output = (run.stdout || '') + (run.stderr || '');
  if (run.status !== 0) return '安装器退出码 ' + run.status + '：' + output.slice(-600);

  const patchText = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  const items = parseYaml(patchText);
  const demo = items.find((item) => item && item.id === 'demo');
  if (!demo) return '包里那条配置没写进去：' + patchText.slice(0, 400);
  if (!eq(demo.config, cfg)) return '写回的配置和包里的不一致：' + JSON.stringify(demo.config).slice(0, 500);
  const keep = items.find((item) => item && item.id === 'keep-me');
  if (!keep) return '原有条目被冲掉了';
  const writtenNotes = path.join(home, dataBase, 'notes.md');
  const writtenState = path.join(home, dataBase, 'state.json');
  const notesText = fs.existsSync(writtenNotes) ? fs.readFileSync(writtenNotes, 'utf8') : '';
  const stateText = fs.existsSync(writtenState) ? fs.readFileSync(writtenState, 'utf8') : '';
  fs.rmSync(path.join(home, dataBase), { recursive: true, force: true });
  if (!notesText.includes('中文行')) return '数据快照里的 notes.md 没写回';
  if (!stateText.includes('"seen":7')) return '数据快照里的 state.json 没写回';
  if (!output.includes('数据快照已写回')) return '安装器没报告数据写回';
  return '';
});

let failed = results.filter(([state]) => state === 'bad');
try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
for (const entry of fs.existsSync(vendorDir) ? fs.readdirSync(vendorDir) : []) {
  if (!entry.startsWith('selfcheck')) continue;
  try { fs.rmSync(path.join(vendorDir, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
}
console.log('');
console.log('selfcheck-config: ' + (results.length - failed.length) + '/' + results.length + ' 通过');
if (failed.length > 0) process.exitCode = 1;
