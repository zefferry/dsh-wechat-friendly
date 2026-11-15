import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SessionRouter } from '../dist/core/lib/router.js';
import { buildSessionCardModel, buildWorkspaceCardModel } from '../lib/card-data.js';
import { renderCard } from '../lib/cards.js';

const out = join(process.cwd(), '..', '_tools', 'out');
mkdirSync(out, { recursive: true });

const now = Date.now();
const rows = [
  { sessionId: 'session-11111111-1111-1111-1111-111111111111', title: '主线会话', updatedAt: now - 60_000 },
  { sessionId: 'session-22222222-2222-2222-2222-222222222222', title: 'Side: 子代理调研', updatedAt: now - 120_000, parentSession: 'session-11111111-1111-1111-1111-111111111111', origin: 'subagent', delegationDepth: 1 },
  { sessionId: 'session-33333333-3333-3333-3333-333333333333', title: '另一个会话', updatedAt: now - 900_000 },
  { sessionId: 'session-44444444-4444-4444-4444-444444444444', title: '其它工作区会话', updatedAt: now - 1_800_000, workspace: 'D:/other-workspace' },
];
const gateway = {
  async listSessions() {
    return rows.map((row) => ({ ...row }));
  },
  async ensureSession() {},
  async sessionState() { return { status: 'live' }; },
};
const store = {
  async load() { return {}; },
  async save() {},
};
const router = new SessionRouter({
  gateway,
  store,
  ownWorkspace: 'C:/ws',
  ownWorkspaceLabel: '微信会话',
  onDiagnostic: (line) => console.log('diag', line),
});

const foldered = await router.route({ conversationId: 'c1', accountId: 'a1', peerId: 'p1', text: '/list all' });
console.log('folders screen:', foldered.kind, foldered.screen?.level, foldered.screen?.folders?.map((f) => `${f.label}:${f.count}`));
if (foldered.screen) {
  const model = buildWorkspaceCardModel(foldered.screen, { instanceName: '桌面实例', now });
  writeFileSync(join(out, 'route-workspace.jpg'), await renderCard('workspace', model, { theme: 'B' }));
}

const listed = await router.route({ conversationId: 'c1', accountId: 'a1', peerId: 'p1', text: '/list' });
console.log('sessions screen:', listed.kind, listed.screen?.level, 'total', listed.screen?.total, 'items', listed.screen?.items?.length);
console.log('rows:', listed.numbered.sessions.map((s, i) => `${i + 1}.${s.title}`));
const ordered = listed.screen.items.map((item) => ({ ...item, no: listed.screen.start + listed.screen.items.indexOf(item) + 1 }));
console.log('order+flag:', ordered.map((item) => `${item.no}${item.branch ? '↳' : ''}${item.title}`));
if (listed.screen) {
  const model = buildSessionCardModel(listed.screen, { workspaceName: '微信会话', now });
  writeFileSync(join(out, 'route-session.jpg'), await renderCard('session', model, { theme: 'B' }));
}
console.log('text head:\n' + listed.text.split('\n').slice(0, 6).join('\n'));
