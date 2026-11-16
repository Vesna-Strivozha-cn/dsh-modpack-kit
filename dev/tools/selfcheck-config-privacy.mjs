import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sourceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-privacy-src-'));
process.env.DSH_HOME = sourceHome;

const { buildPack } = await import('../../lib/pack.mjs');
const { installPack, inspectPackBuffer } = await import('../../lib/install.mjs');
const { parseYaml } = await import('../../lib/yamlish.mjs');
const { readPatch } = await import('../../lib/profile.mjs');
const { readZip } = await import('../../lib/zip.mjs');

const profileDir = path.join(sourceHome, 'profiles', 'selftest');
const pluginDir = path.join(profileDir, 'node_modules', 'demo-config-plugin');
fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
  name: 'demo-config-plugin',
  version: '1.0.0',
  license: 'MIT',
  type: 'module',
  main: 'index.js',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2));
fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export default { name: "demo-config-plugin", apply() {} }\n');
fs.writeFileSync(path.join(pluginDir, 'cordis.patch.yml'), '- insert:\n    - id: demo\n      name: demo-config-plugin\n');

const SECRET_KEY = 'sk-live-AAAABBBBCCCCDDDDEEEEFFFF';
const SECRET_TOKEN = 'tok_secret_value_1234567890';
const SECRET_SESSION = 'SESSDATA=abcdef0123456789abcdef';
const secretBytes = [SECRET_KEY, SECRET_TOKEN];

const patchText = [
  '- id: keep-me',
  '  name: other-plugin',
  '  config:',
  '    mode: keep',
  '- id: demo',
  '  name: demo-config-plugin',
  '  config:',
  '    endpoint: https://example.invalid/v1',
  '    apiKey: ' + SECRET_KEY,
  '    apiKeyEnv: DEMO_KEY',
  '    maxTokens: 4096',
  '    rules:',
  '      - alpha',
  '      - beta',
  '    emptyList: []',
  '    emptyMap: {}',
  '    nested:',
  '      deeper:',
  '        token: ' + SECRET_TOKEN,
  '    multiline: "first\\nsecond"',
  '    chinese: "中文值"',
  '',
].join('\n');
fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patchText);

// 插件自己的数据目录（~/.dsh/<目录>/），里面混一把 key 和一条会话
const dataDir = path.join(sourceHome, 'demo-config-plugin');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, 'notes.md'),
  '# 笔记\n\n- 端点：https://example.invalid/v1\n- key：' + SECRET_KEY + '\n- ' + SECRET_SESSION + '\n- 普通内容：今天读了两章\n',
);

const config = {
  profile: 'selftest',
  includePayload: true,
  includeConfig: true,
  includeLocalEdits: true,
  keepLocal: false,
  scanBeforePack: true,
  scanBeforeInstall: true,
  blockHighRisk: true,
  applyPackedConfig: true,
  licenseAllow: ['MIT', 'Apache-2.0', 'PolyForm-Noncommercial-1.0.0'],
  registries: ['https://registry.npmjs.org'],
  allowHosts: ['registry.npmjs.org'],
  maxDownloadBytes: 128 * 1024 * 1024,
  maxPackBytes: 512 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
};

const built = await buildPack({
  selection: [{ name: 'demo-config-plugin', source: 'profile', mode: 'local' }],
  options: {
    includePayload: true,
    includeConfig: true,
    includeLocalEdits: true,
    name: '配置与隐私自检包',
    acknowledge: true,
  },
  context: {
    config,
    profileDir,
    dshVersion: '11.28.5',
    installed: [{
      name: 'demo-config-plugin',
      dirName: 'demo-config-plugin',
      version: '1.0.0',
      dir: pluginDir,
      realDir: pluginDir,
      pkg: { name: 'demo-config-plugin', version: '1.0.0', license: 'MIT' },
      isPlugin: true,
    }],
    pluginVersion: '0.1.5',
    parsePatch: (t) => parseYaml(t),
    patchText,
  },
});

const report = [];
const check = (name, ok, extra = '') => {
  report.push((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  · ' + extra : ''));
};

const packBuffer = Buffer.from(built.buffer);
const entries = readZip(packBuffer);
const configEntry = entries.find((e) => e.name === 'configs/demo-config-plugin.json');
const dataEntry = entries.find((e) => e.name === 'data/demo-config-plugin/notes.md');

check('包内有配置快照', Boolean(configEntry), configEntry ? configEntry.data.length + ' 字节' : '');
check('包内有数据快照', Boolean(dataEntry), dataEntry ? dataEntry.data.length + ' 字节' : '');
check('包格式为完整包且带载荷', built.manifest.format === 'full' && entries.some((e) => e.name === 'plugins/demo-config-plugin/package.json'));

const snap = JSON.parse(configEntry.data.toString('utf8'));
const cfg = snap.config || {};
check('配置保真：endpoint', cfg.endpoint === 'https://example.invalid/v1');
check('配置保真：apiKeyEnv 不误伤', cfg.apiKeyEnv === 'DEMO_KEY');
check('配置保真：maxTokens', cfg.maxTokens === 4096);
check('配置保真：数组', Array.isArray(cfg.rules) && cfg.rules.join(',') === 'alpha,beta');
check('配置保真：空数组', Array.isArray(cfg.emptyList) && cfg.emptyList.length === 0);
check('配置保真：空对象', cfg.emptyMap && typeof cfg.emptyMap === 'object' && Object.keys(cfg.emptyMap).length === 0);
check('配置保真：中文', cfg.chinese === '中文值');
check('配置保真：多行', cfg.multiline === 'first\nsecond');
check('配置擦除：apiKey', cfg.apiKey === '${REDACTED}', String(cfg.apiKey));
check('配置擦除：嵌套 token', cfg.nested && cfg.nested.deeper && cfg.nested.deeper.token === '${REDACTED}');
check('配置快照记录擦除路径', Array.isArray(snap.configRedacted) && snap.configRedacted.length === 2, JSON.stringify(snap.configRedacted || []));

const notesText = dataEntry.data.toString('utf8');
check('数据擦除：明文 key 被替换', !notesText.includes(SECRET_KEY) && notesText.includes('${REDACTED}'));
check('数据擦除：会话字段被替换', !notesText.includes('abcdef0123456789abcdef'));
check('数据保真：普通内容留着', notesText.includes('今天读了两章') && notesText.includes('https://example.invalid/v1'));
check('清单记录数据擦除条数', built.manifest.plugins[0].dataRedacted >= 2, String(built.manifest.plugins[0].dataRedacted));

const hits = secretBytes.filter((s) => packBuffer.includes(Buffer.from(s, 'utf8')));
check('整个包体不含密钥原文', hits.length === 0, hits.join(',') || '干净');
check('检测报告不含密钥原文', secretBytes.every((s) => !built.report.includes(s)));

// 装到另一个 home，验证配置回填与数据写回
const targetHome = fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-privacy-dst-'));
process.env.DSH_HOME = targetHome;
const targetProfile = path.join(targetHome, 'profiles', 'target');
fs.mkdirSync(path.join(targetProfile, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(targetProfile, 'package.json'), JSON.stringify({ name: 'target', version: '1.0.0', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2));
fs.writeFileSync(path.join(targetProfile, 'cordis.patch.yml'), '- id: keep-me\n  name: other-plugin\n  config:\n    mode: keep\n');

const inspected = inspectPackBuffer(packBuffer, { config, force: true, scanBeforeInstall: true });
check('读包完整性通过', inspected.integrity.ok === true);

const installed = await installPack({
  manifest: inspected.manifest,
  entries: inspected.entries,
  config,
  options: { force: true, applyConfig: true, keepLocal: false, enableBundles: false, dryRun: false },
  context: {
    profileDir: targetProfile,
    resolveSource: null,
    runCli: async () => ({ code: 0, output: 'fake cli ok' }),
  },
});

check('安装完成', installed.ok === true, (installed.actions || []).map((a) => a.action + ':' + (a.ok ? 'ok' : 'bad')).join(' | '));

const afterText = readPatch(targetProfile);
const items = parseYaml(afterText);
const demo = items.find((i) => i.name === 'demo-config-plugin');
const keep = items.find((i) => i.id === 'keep-me');
check('配置条目已回填', Boolean(demo));
check('回填后仍是占位符', demo && demo.config && demo.config.apiKey === '${REDACTED}', demo ? String(demo.config.apiKey) : '');
check(
  '回填后自定义值保真',
  demo && demo.config && demo.config.endpoint === 'https://example.invalid/v1'
    && demo.config.maxTokens === 4096 && demo.config.chinese === '中文值' && demo.config.multiline === 'first\nsecond',
);
check('回填后空容器合法', demo && demo.config && Array.isArray(demo.config.emptyList) && Object.keys(demo.config.emptyMap || {}).length === 0);
check('其它条目未被改动', keep && keep.config && keep.config.mode === 'keep');
check('装完后补丁文件不含密钥原文', secretBytes.every((s) => !afterText.includes(s)));

const targetNotes = path.join(targetHome, 'demo-config-plugin', 'notes.md');
check('数据快照写回目标 home', fs.existsSync(targetNotes));
if (fs.existsSync(targetNotes)) {
  const back = fs.readFileSync(targetNotes, 'utf8');
  check('写回的数据也已擦除', !back.includes(SECRET_KEY) && !back.includes('abcdef0123456789abcdef'));
  check('写回的数据保留普通内容', back.includes('今天读了两章'));
}
check('安装结果提示了需重填', (installed.lines || []).some((line) => line.includes('REDACTED')));

console.log(report.join('\n'));
const failed = report.filter((line) => line.startsWith('FAIL'));
console.log('\n结果：' + (report.length - failed.length) + '/' + report.length + ' 通过');

for (const dir of [sourceHome, targetHome]) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
process.exit(failed.length === 0 ? 0 : 1);
