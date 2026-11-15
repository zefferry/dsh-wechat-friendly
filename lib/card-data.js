/**
 * Card data layer: turns the router's browser screens into the plain models `cards.js` draws.
 *
 * The router already decides the hard part — which rows are on screen, in what order, and what
 * number each row printed. This module only formats those rows into the shapes a card needs
 * (relative times, `(无标题)` fallbacks, branch flags). Keeping it separate from both sides means a
 * card can never disagree with the text it replaces about numbering or page cut: both are built
 * from the same `screen` object.
 *
 * @module card-data
 */
import { relativeTime } from '../dist/core/lib/index.js';

/** Missing titles are shown the same way the text listing shows them. */
const NO_TITLE = '(无标题)';

/**
 * Format a timestamp for a card row.
 *
 * @param {number|undefined} at - Epoch milliseconds, when known.
 * @param {number} now - The instant the card is being drawn.
 * @returns {string} Relative time, or an empty string when the record has none.
 */
function whenText(at, now) {
  if (at === undefined || !Number.isFinite(at) || at <= 0)
    return '';
  return relativeTime(at, now);
}

/**
 * Build the model for the workspace card (`/工作区列表`, `/工作区`).
 *
 * @param {{level: string, folders: {label: string, count: number, newest?: number}[]}} screen
 * @param {object} options
 * @param {string} options.instanceName - Big title: the instance this channel runs in.
 * @param {number} [options.now]
 * @param {string} [options.footer]
 * @returns {object} Model for `renderCard('workspace', model)`.
 */
export function buildWorkspaceCardModel(screen, options) {
  const now = options.now ?? Date.now();
  const folders = Array.isArray(screen?.folders) ? screen.folders : [];
  return {
    instanceName: options.instanceName,
    subtitle: '点编号进入工作区 · 回复「/工作区」刷新',
    rows: folders.map((folder) => ({ name: folder.label, time: whenText(folder.newest, now) })),
    ...(options.footer === undefined ? {} : { footer: options.footer }),
  };
}

/**
 * Build the model for the session card (`/list`, `/会话`, `/工作区/{名称}`).
 *
 * The number is carried through from the router (`screen.start + index + 1`) rather than being
 * recomputed here, so the number printed on the card is exactly the number the router will resolve
 * on the user's next message.
 *
 * @param {{level: string, label: string, page: number, pages: number, start: number, currentId?: string, total: number, items: object[]}} screen
 * @param {object} options
 * @param {string} options.workspaceName - Big title: the workspace being listed.
 * @param {number} [options.now]
 * @param {number} [options.branches] - Branch count across the whole folder, when the caller knows it.
 * @param {string} [options.footer]
 * @returns {object} Model for `renderCard('session', model)`.
 */
export function buildSessionCardModel(screen, options) {
  const now = options.now ?? Date.now();
  const items = Array.isArray(screen?.items) ? screen.items : [];
  const rows = items.map((item, index) => ({
    no: screen.start + index + 1,
    name: item.title === undefined || item.title === '' ? NO_TITLE : item.title,
    time: whenText(item.updatedAt, now),
    current: item.sessionId !== undefined && item.sessionId === screen.currentId,
    branch: item.branch === true,
    ...(typeof item.snippet === 'string' && item.snippet !== '' ? { snippet: item.snippet } : {}),
  }));
  const branches = options.branches ?? rows.filter((row) => row.branch).length;
  return {
    workspaceName: options.workspaceName ?? screen.label,
    rows,
    stats: {
      sessions: screen.total ?? rows.length,
      branches,
      current: screen.currentId === undefined ? 0 : 1,
    },
    page: { index: screen.page ?? 1, pages: screen.pages ?? 1 },
    ...(options.footer === undefined ? {} : { footer: options.footer }),
  };
}

/**
 * Build the model for the command card (`/帮助`).
 *
 * @param {{command: string, description: string}[]} rows
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string} [options.subtitle]
 * @param {string} [options.footer]
 * @returns {object} Model for `renderCard('command', model)`.
 */
export function buildCommandCardModel(rows, options = {}) {
  return {
    rows: Array.isArray(rows) ? rows : [],
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.subtitle === undefined ? {} : { subtitle: options.subtitle }),
    ...(options.footer === undefined ? {} : { footer: options.footer }),
  };
}

/**
 * Format an absolute instant as `YYYY-MM-DD HH:mm`, for facts a relative time would blur.
 *
 * @param {number|undefined} at - Epoch milliseconds.
 * @returns {string} Local wall-clock time, or an empty string when unknown.
 */
function stampText(at) {
  if (at === undefined || !Number.isFinite(at) || at <= 0)
    return '';
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Build an info card model from already-normalized rows.
 *
 * Callers keep ownership of the facts; this only fills the shared header/footer defaults so every
 * info answer looks like it came from the same channel.
 *
 * @param {object} model
 * @param {string} model.header - Small header label, e.g. '微信通道 · 模型'.
 * @param {string} [model.badge]
 * @param {string} model.title
 * @param {string} [model.subtitle]
 * @param {{label?: string, value: string, note?: string, accent?: boolean}[]} model.rows
 * @param {string} [model.footer]
 * @param {string} [model.emptyText]
 * @returns {object} Model for `renderCard('info', model)`.
 */
export function buildInfoCardModel(model) {
  return {
    header: model.header,
    ...(model.badge === undefined ? {} : { badge: model.badge }),
    title: model.title,
    ...(model.subtitle === undefined ? {} : { subtitle: model.subtitle }),
    rows: Array.isArray(model.rows) ? model.rows : [],
    ...(model.footer === undefined ? {} : { footer: model.footer }),
    ...(model.emptyText === undefined ? {} : { emptyText: model.emptyText }),
  };
}

/**
 * Build the `当前` card: which conversation the chat is bound to, and how it is configured.
 *
 * @param {object} info
 * @param {string} info.workspaceName
 * @param {string} info.sessionName
 * @param {string} [info.shortId]
 * @param {string} [info.modelName]
 * @param {string} [info.levelName]
 * @param {string} [info.permissionLabel]
 * @param {string} [info.modeName]
 * @param {number} [info.updatedAt]
 * @param {number} [info.now]
 * @returns {object} Model for `renderCard('info', model)`.
 */
export function buildCurrentCardModel(info) {
  const model = info.modelName === undefined || info.modelName === ''
    ? undefined
    : `${info.modelName}${info.levelName === undefined || info.levelName === '' ? '' : ` · ${info.levelName}`}`;
  return buildInfoCardModel({
    header: '微信通道 · 当前',
    badge: info.shortId ?? '',
    title: info.sessionName === undefined || info.sessionName === '' ? NO_TITLE : info.sessionName,
    subtitle: `工作区：${info.workspaceName ?? ''}${info.updatedAt === undefined ? '' : ` · ${whenText(info.updatedAt, info.now ?? Date.now())}`}`,
    rows: [
      ...(model === undefined ? [] : [{ label: '模型', value: model }]),
      { label: '权限', value: info.permissionLabel ?? '未知' },
      { label: '模式', value: info.modeName ?? '未知' },
    ],
    footer: '回复「/会话列表」看别的会话 · 回复「/模型」换模型',
  });
}

/**
 * Build the `模型` card: the model in use, then every selectable model with its reasoning levels.
 *
 * @param {object} listing - The same shape the router's text listing renders.
 * @param {object} [listing.current] - `{ name, levelName }` of the bound session.
 * @param {{providerName: string, name: string, model: string, levels: {id: string, name: string}[], defaultLevel?: string}[]} listing.models
 * @param {{provider: string, model: string, message: string}[]} [listing.failures]
 * @param {number} [listing.no]
 * @returns {object} Model for `renderCard('info', model)`.
 */
export function buildModelCardModel(listing) {
  const current = listing.current;
  const rows = (listing.models ?? []).map((model, index) => {
    const levels = (model.levels ?? []).map((level) => level.name).join(' · ');
    const active = current !== undefined && current.model === model.model && current.provider === model.provider;
    return {
      label: `${index + 1}`,
      value: `${model.name ?? model.model}${active ? '  ← 当前' : ''}`,
      note: levels === '' ? `${model.providerName} · ${model.model}` : `推理等级：${levels}`,
      accent: active,
    };
  });
  for (const failure of listing.failures ?? [])
    rows.push({ label: '!', value: `${failure.provider}/${failure.model}：${failure.message}` });
  return buildInfoCardModel({
    header: '微信通道 · 模型',
    badge: `共 ${(listing.models ?? []).length} 个`,
    title: '模型与思考等级',
    subtitle: current === undefined
      ? '回复「/模型 编号」切换当前会话的模型'
      : `当前：${current.name}${current.levelName === undefined ? '' : ` · ${current.levelName}`}`,
    rows,
    emptyText: '没有可用的模型',
    footer: '回复「/模型 编号」切换模型 · 回复「/模型 编号-等级」同时切换等级',
  });
}

/**
 * Build the `权限` card: the preset in effect, then every preset that can be chosen.
 *
 * @param {object} info
 * @param {string} info.sessionName
 * @param {{id: string, label: string, description?: string}} info.current
 * @param {{id: string, label: string, description?: string}[]} info.available
 * @returns {object} Model for `renderCard('info', model)`.
 */
export function buildPermissionCardModel(info) {
  return buildInfoCardModel({
    header: '微信通道 · 权限',
    badge: info.sessionName ?? '',
    title: '会话权限',
    subtitle: info.current === undefined ? undefined : `当前：${info.current.label}`,
    rows: (info.available ?? []).map((preset) => ({
      label: preset.id,
      value: preset.label,
      note: preset.description,
      accent: info.current !== undefined && info.current.id === preset.id,
    })),
    footer: '回复「/权限 名称」修改 · 放宽权限只影响之后的操作',
  });
}

/**
 * Build the `模式` card: the agent preset in effect, then every preset that can be chosen.
 *
 * @param {object} info
 * @param {string} info.sessionName
 * @param {{id: string, name: string, description?: string}} info.current
 * @param {{id: string, name: string, description?: string}[]} info.available
 * @returns {object} Model for `renderCard('info', model)`.
 */
export function buildModeCardModel(info) {
  return buildInfoCardModel({
    header: '微信通道 · 模式',
    badge: info.sessionName ?? '',
    title: '会话模式',
    subtitle: info.current === undefined ? undefined : `当前：${info.current.name}`,
    rows: (info.available ?? []).map((preset) => ({
      label: preset.id,
      value: preset.name,
      note: preset.description,
      accent: info.current !== undefined && info.current.id === preset.id,
    })),
    footer: '回复「/模式 名称」修改 · 模式只能在还没开始聊天的会话里换',
  });
}

/**
 * Build the `聊天记录` card: how much this conversation holds and how much it has cost.
 *
 * @param {object} stats
 * @param {string} stats.sessionName
 * @param {number} [stats.turns] - User turns plus assistant replies, which is what `/聊天记录 N` counts.
 * @param {number} [stats.tokens] - Billed tokens, summed from the session's usage projection.
 * @param {number} [stats.contextPercent] - 0-100, projected prompt size over the context window.
 * @param {number} [stats.contextTokens]
 * @param {number} [stats.contextWindow]
 * @param {number} [stats.firstAt]
 * @param {number} [stats.lastAt]
 * @returns {object} Model for `renderCard('info', model)`.
 */
export function buildHistoryCardModel(stats) {
  const percent = stats.contextPercent;
  return buildInfoCardModel({
    header: '微信通道 · 聊天记录',
    badge: stats.sessionName ?? '',
    title: '会话统计',
    subtitle: stats.turns === undefined ? undefined : `共 ${stats.turns} 条聊天`,
    rows: [
      { label: '总聊天次数', value: stats.turns === undefined ? '—' : `${stats.turns} 条` },
      {
        label: '上下文比例',
        value: percent === undefined ? '—' : `${Math.round(percent)}%`,
        note: stats.contextTokens === undefined || stats.contextWindow === undefined
          ? undefined
          : `${stats.contextTokens} / ${stats.contextWindow} token`,
      },
      { label: '计费 token', value: stats.tokens === undefined ? '—' : stats.tokens.toLocaleString('en-US') },
      { label: '第一次聊天', value: stampText(stats.firstAt) || '—' },
      { label: '最后一次', value: stampText(stats.lastAt) || '—' },
    ],
    footer: '回复「/聊天记录 50」导出最近 50 条 · 条数＝用户一条＋回复一条',
  });
}
