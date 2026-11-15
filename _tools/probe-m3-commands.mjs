import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SessionRouter, normalizeCommandText, COMMAND_HELP, commandScreen } from '../dist/core/lib/router.js';
import { buildCommandCardModel } from '../lib/card-data.js';
import { renderCard } from '../lib/cards.js';

const out = join(process.cwd(), '..', '_tools', 'out');
mkdirSync(out, { recursive: true });

const cases = [
  ['/帮助', '/help'],
  ['/工作区', '/workspace'],
  ['/工作区聊天', '/workspace 聊天'],
  ['/工作区 聊天', '/workspace 聊天'],
  ['/工作区：聊天', '/workspace 聊天'],
  ['/切换/会话名', '/switch 会话名'],
  ['/会话', '/list'],
  ['/列表', '/list'],
  ['/新会话 测试', '/new 测试'],
  ['/停止', '/cancel'],
  ['/停止：', '/cancel'],
  ['/权限 完全', '/permission 完全'],
  ['/模式 聊天', '/mode 聊天'],
  ['/聊天记录 5', '/history 5'],
  ['/撤回', '/rewind'],
  ['/news', '/news'],
  ['/help', '/help'],
  ['普通消息', '普通消息'],
];
let bad = 0;
for (const [input, expected] of cases) {
  const actual = normalizeCommandText(input);
  const ok = actual === expected;
  if (!ok) bad += 1;
  console.log(ok ? 'ok  ' : 'FAIL', JSON.stringify(input), '->', JSON.stringify(actual), ok ? '' : `(expected ${JSON.stringify(expected)})`);
}
console.log('normalize failures:', bad);

const now = Date.now();
const rows = [
  { sessionId: 'session-11111111-1111-1111-1111-111111111111', title: '主线会话', updatedAt: now - 60_000 },
  { sessionId: 'session-22222222-2222-2222-2222-222222222222', title: 'Side: 子代理调研', updatedAt: now - 120_000, parentSession: 'session-11111111-1111-1111-1111-111111111111' },
  { sessionId: 'session-33333333-3333-3333-3333-333333333333', title: '另一个会话', updatedAt: now - 900_000 },
];
const gateway = {
  async listSessions() { return rows.map((row) => ({ ...row })); },
  async ensureSession(id) { return id ?? 'session-new'; },
  async sessionState() { return { status: 'live' }; },
  async listOwnSessions() { return []; },
  async cancel() { return undefined; },
};
const store = { async load() { return {}; }, async save() {} };
const router = new SessionRouter({
  gateway, store,
  ownWorkspace: 'C:/ws',
  ownWorkspaceLabel: '微信会话',
  onDiagnostic: (line) => console.log('diag', line),
});

async function route(text) {
  const result = await router.route({ conversationId: 'c1', accountId: 'a1', peerId: 'p1', text });
  console.log(`\n== ${text} -> kind=${result.kind} screen=${result.screen?.level ?? '(none)'}`);
  console.log((result.text ?? '').split('\n').slice(0, 8).join('\n'));
  return result;
}

const help = await route('/帮助');
if (help.screen?.level === 'commands') {
  console.log('help rows:', help.screen.rows.map((r) => `${r.command}=${r.description}`).join(' | '));
  writeFileSync(join(out, 'm3-command-B.jpg'), await renderCard('command', buildCommandCardModel(help.screen.rows, { title: help.screen.title, subtitle: help.screen.subtitle, footer: help.screen.footer }), { theme: 'B' }));
  writeFileSync(join(out, 'm3-command-A.jpg'), await renderCard('command', buildCommandCardModel(help.screen.rows, { title: help.screen.title, subtitle: help.screen.subtitle, footer: help.screen.footer }), { theme: 'A' }));
}

await route('/工作区');
const opened = await route('/工作区微信会话');
console.log('opened screen:', opened.screen?.level, opened.screen?.label, opened.screen?.total);
await route('/会话');
const switched = await route('/切换主线会话');
console.log('switch kind:', switched.kind, switched.text?.split('\n')[0]);
await route('/停止');

// M4/M5: permission, mode, rewind and history are forwarded to the host gateway.
const calls = [];
const m4Gateway = {
  ...gateway,
  async permission(sessionId, args) {
    calls.push(['permission', sessionId, args]);
    return args === '' ? 'PERMISSION-STATE' : `PERMISSION-SET ${args}`;
  },
  async mode(sessionId, args) {
    calls.push(['mode', sessionId, args]);
    return args === '' ? 'MODE-STATE' : `MODE-SET ${args}`;
  },
  async rewind(sessionId) {
    calls.push(['rewind', sessionId]);
    return 'REWOUND';
  },
  async history(sessionId, limit) {
    calls.push(['history', sessionId, limit]);
    return { count: 2, name: '聊天记录-x.md', content: '# hi' };
  },
};
const m4Store = {
  async load() {
    return { c1: { sessionId: rows[0].sessionId, title: '主线会话', lastUsedAt: now } };
  },
  async save() {},
};
const m4 = new SessionRouter({
  gateway: m4Gateway, store: m4Store,
  ownWorkspace: 'C:/ws', ownWorkspaceLabel: '微信会话',
  onDiagnostic: () => undefined,
});
async function routeM4(text) {
  const result = await m4.route({ conversationId: 'c1', accountId: 'a1', peerId: 'p1', text });
  console.log(`M4 ${text} -> ${(result.text ?? '').split('\n')[0]}`);
  return result;
}
await routeM4('/权限');
await routeM4('/权限 完全');
await routeM4('/模式');
await routeM4('/模式 聊天');
await routeM4('/撤回');
const history = await routeM4('/聊天记录 3');
console.log('history file:', history.file?.name, '| calls:', JSON.stringify(calls));

console.log('\ncommandScreen():', JSON.stringify(commandScreen()).slice(0, 200));
console.log('COMMAND_HELP len:', COMMAND_HELP.length);
