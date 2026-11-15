import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  listAllStoredSessions,
  compareSessionsNewestFirst,
  isSameWorkspace,
} from '../dist/core/lib/session-index.js';
import {
  sessionFolders,
  folderScreen,
  renderSessionScreen,
  orderRowsWithBranches,
} from '../dist/core/lib/router.js';
import { buildWorkspaceCardModel, buildSessionCardModel } from '../lib/card-data.js';
import { renderCard } from '../lib/cards.js';

const home = 'C:/Users/凡宇/.dsh';
const ownCwd = 'C:/Users/凡宇/.dsh/dsh_wechat';
const out = join(process.cwd(), '..', '_tools', 'out');
mkdirSync(out, { recursive: true });

const groups = await listAllStoredSessions(home);
const own = [];
const all = [];
for (const [cwd, rows] of groups) {
  for (const row of rows) {
    if (isSameWorkspace(cwd, ownCwd)) own.push(row);
    else all.push({ ...row, workspace: cwd });
  }
}
const rows = [...own, ...all];
const folders = sessionFolders(rows, { ownWorkspace: ownCwd, ownLabel: '微信会话' });
const now = Date.now();

const wsScreen = folderScreen(folders, 1);
const wsModel = buildWorkspaceCardModel(wsScreen, { instanceName: '桌面实例', now });
const wsBuf = await renderCard('workspace', wsModel, { theme: 'B' });
writeFileSync(join(out, 'int-workspace-B.jpg'), wsBuf);

const ownOrdered = orderRowsWithBranches([...own].sort(compareSessionsNewestFirst));
const ownScreen = renderSessionScreen(ownOrdered, { label: '微信会话', page: 1, total: own.length }).screen;
const ownModel = buildSessionCardModel(ownScreen, { workspaceName: '微信会话', now });
const ownBuf = await renderCard('session', ownModel, { theme: 'B' });
writeFileSync(join(out, 'int-session-B.jpg'), ownBuf);

const pluginCwd = 'E:/Deepseek Harness/插件开发';
const pluginRows = [
  ...(groups.get(pluginCwd) ?? []),
  ...all.filter((row) => isSameWorkspace(row.workspace, pluginCwd)),
];
const pluginOrdered = orderRowsWithBranches([...pluginRows].sort(compareSessionsNewestFirst));
const branches = pluginOrdered.filter((row) => row.branch === true).length;
const pluginScreen = renderSessionScreen(pluginOrdered, {
  label: '插件开发',
  page: 1,
  total: pluginOrdered.length,
}).screen;
const pluginModel = buildSessionCardModel(pluginScreen, { workspaceName: '插件开发', now, branches });
const pluginBuf = await renderCard('session', pluginModel, { theme: 'B' });
writeFileSync(join(out, 'int-branch-B.jpg'), pluginBuf);

console.log('workspace rows', wsModel.rows.length, 'session rows', ownModel.rows.length, 'branch rows', pluginModel.rows.length, 'branches', pluginModel.stats.branches);
console.log('numbers', ownModel.rows.slice(0, 3).map((r) => r.no), pluginModel.rows.slice(0, 6).map((r) => `${r.no}${r.branch ? '↳' : ''}`));
