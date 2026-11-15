/**
 * Card renderer: turns the WeChat channel's lists into JPEG cards.
 *
 * The channel replies in plain text everywhere else; these three lists are the exception, because a
 * structure with columns (number, name, time, branch) reads badly as plain text on a phone. A card
 * is drawn as SVG and rasterised with sharp, so the same markup can be re-themed, re-paged and
 * re-scaled without touching the data layer.
 *
 * Everything here is pure: the caller passes a plain model and gets a JPEG buffer back. Reading the
 * store, formatting times and deciding which rows belong on a page is the caller's job.
 *
 * Three kinds exist, and each keeps the same skeleton so the user recognises them as one family:
 *
 *  - `workspace` — one row per workspace, its big title the instance's name.
 *  - `session`   — one row per conversation (branches indented under their parent), its big title
 *                  the workspace name.
 *  - `command`   — one row per command (name + usage), its big title "全部指令".
 *
 * @module cards
 */
import sharp from 'sharp';

/** Card width in CSS pixels. Rendered at 2x, so the image is 1500 px wide. */
export const CARD_WIDTH = 750;
const PAD = 26;
const CARD_PAD = 30;
const FONT_FAMILY = "'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Segoe UI', sans-serif";
const RENDER_DENSITY = 144;
const DEFAULT_QUALITY = 82;

/**
 * Colour schemes.
 *
 * `page` is the backdrop the card sits on; a scheme may instead name a gradient (scheme C). The
 * accent is the one colour the user sees most: the status dot, the current-session marker, command
 * names. Callers may override it (settings page) without editing this table.
 */
export const CARD_THEMES = {
  A: {
    page: '#0a0f1c',
    card: '#111a2c',
    cardBorder: '#22304d',
    fg: '#eaf0ff',
    sub: '#8ea3cb',
    faint: '#5f7398',
    accent: '#5eead4',
    divider: '#1e2a44',
  },
  B: {
    page: '#eff1f5',
    card: '#ffffff',
    cardBorder: '#e4e7ee',
    fg: '#111827',
    sub: '#6b7280',
    faint: '#9ca3af',
    accent: '#07c160',
    divider: '#eef0f4',
  },
  C: {
    page: 'gradient',
    card: 'rgba(255,255,255,0.075)',
    cardBorder: 'rgba(255,255,255,0.16)',
    fg: '#ffffff',
    sub: '#c9cbe8',
    faint: '#8f92b8',
    accent: '#a78bfa',
    divider: 'rgba(255,255,255,0.10)',
  },
  D: {
    page: '#f2ebdf',
    card: '#fffcf5',
    cardBorder: '#e7dcc9',
    fg: '#332a20',
    sub: '#7d6c57',
    faint: '#b0a18b',
    accent: '#c2703c',
    divider: '#eee4d4',
  },
  E: {
    page: '#07090a',
    card: '#0d1112',
    cardBorder: '#1d2624',
    fg: '#e7f2ec',
    sub: '#93a89d',
    faint: '#5f776c',
    accent: '#3fd07a',
    divider: '#19211f',
  },
};

/** Theme used when the caller names one this module does not know. */
export const DEFAULT_THEME = 'B';

/** @param {unknown} value - A theme key from settings. @returns {keyof CARD_THEMES} */
export function normalizeTheme(value) {
  const key = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return Object.hasOwn(CARD_THEMES, key) ? key : DEFAULT_THEME;
}

/** @param {string} value - Text going into XML. @returns {string} */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Approximate on-screen width. Font metrics are not available in this process, so CJK glyphs are
 * counted as one em, ASCII at 0.55 em and spaces at 0.3 em — enough to decide where to clip before
 * the glyphs are drawn by librsvg.
 *
 * @param {string} text
 * @param {number} size - Font size in px.
 * @returns {number} Width in px.
 */
function textWidth(text, size) {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code > 0x2e80)
      width += size; // CJK, full-width punctuation, emoji
    else if (ch === ' ')
      width += size * 0.3;
    else
      width += size * 0.55;
  }
  return width;
}

/**
 * Clip a single line to the given width, ending with an ellipsis when it does not fit.
 *
 * @param {string} text
 * @param {number} size
 * @param {number} max
 * @returns {string}
 */
function fitText(text, size, max) {
  const value = String(text ?? '');
  if (textWidth(value, size) <= max)
    return value;
  let out = '';
  for (const ch of value) {
    if (textWidth(`${out}${ch}…`, size) > max)
      break;
    out += ch;
  }
  return `${out}…`;
}

/** Card backdrop. Gradient schemes use one shared definition id. */
function background(theme) {
  if (theme.page === 'gradient') {
    return `<defs><linearGradient id="page" x1="0" y1="0" x2="1" y2="1">`
      + `<stop offset="0" stop-color="#0f0c29"/><stop offset="0.55" stop-color="#24243e"/>`
      + `<stop offset="1" stop-color="#302b63"/></linearGradient></defs>`
      + `<rect x="0" y="0" width="${CARD_WIDTH}" height="100%" fill="url(#page)"/>`;
  }
  return `<rect x="0" y="0" width="${CARD_WIDTH}" height="100%" fill="${theme.page}"/>`;
}

/** Rounded card surface plus the transform for its contents. */
function cardShell(theme, inner, height) {
  const w = CARD_WIDTH - PAD * 2;
  return `<g transform="translate(${PAD}, 0)">`
    + `<rect x="0" y="0" width="${w}" height="${height}" rx="22" fill="${theme.card}" stroke="${theme.cardBorder}" stroke-width="1.2"/>`
    + `${inner}</g>`;
}

/** Status dot + channel label on the left, count or page number on the right. */
function headerRow(theme, left, right) {
  const w = CARD_WIDTH - PAD * 2;
  let out = `<circle cx="${CARD_PAD + 5}" cy="34" r="5.5" fill="${theme.accent}"/>`;
  out += `<text x="${CARD_PAD + 20}" y="41" font-family="${FONT_FAMILY}" font-size="17" fill="${theme.accent}">${escapeXml(left)}</text>`;
  if (right)
    out += `<text x="${w - CARD_PAD}" y="41" text-anchor="end" font-family="${FONT_FAMILY}" font-size="16" fill="${theme.faint}">${escapeXml(right)}</text>`;
  out += `<line x1="${CARD_PAD}" y1="60" x2="${w - CARD_PAD}" y2="60" stroke="${theme.divider}" stroke-width="1"/>`;
  return out;
}

/** Big bold title with an optional subtitle; returns where the rows start. */
function headline(theme, title, subtitle) {
  const w = CARD_WIDTH - PAD * 2;
  const innerW = w - CARD_PAD * 2;
  let out = `<text x="${CARD_PAD}" y="112" font-family="${FONT_FAMILY}" font-size="34" font-weight="bold" fill="${theme.fg}">${escapeXml(fitText(title, 34, innerW))}</text>`;
  if (subtitle)
    out += `<text x="${CARD_PAD}" y="144" font-family="${FONT_FAMILY}" font-size="17" fill="${theme.sub}">${escapeXml(fitText(subtitle, 17, innerW))}</text>`;
  return { markup: out, y: subtitle ? 170 : 144 };
}

/** Divider + hint line pinned to the bottom of the card. */
function footer(theme, height, text) {
  const w = CARD_WIDTH - PAD * 2;
  return `<line x1="${CARD_PAD}" y1="${height - 52}" x2="${w - CARD_PAD}" y2="${height - 52}" stroke="${theme.divider}" stroke-width="1"/>`
    + `<text x="${CARD_PAD}" y="${height - 28}" font-family="${FONT_FAMILY}" font-size="15" fill="${theme.faint}">${escapeXml(fitText(text, 15, w - CARD_PAD * 2))}</text>`;
}

/** One empty-state line, so a card never renders as a bare header. */
function emptyRow(theme, y, text) {
  return `<text x="${CARD_PAD}" y="${y}" font-family="${FONT_FAMILY}" font-size="19" fill="${theme.sub}">${escapeXml(text)}</text>`;
}

/**
 * Build the workspace card body.
 *
 * @param {object} model
 * @param {{name: string, time: string}[]} model.rows - Workspaces, newest first.
 * @param {string} model.instanceName - Big title: the instance this channel runs in.
 * @param {string} [model.subtitle]
 * @param {string} [model.footer]
 * @param {string} [model.emptyText]
 * @param {typeof CARD_THEMES[keyof CARD_THEMES]} theme
 * @returns {{svg: string, height: number}}
 */
function workspaceCard(model, theme) {
  const w = CARD_WIDTH - PAD * 2;
  const rows = Array.isArray(model.rows) ? model.rows : [];
  let inner = headerRow(theme, 'DeepSeek Harness微信端 · 工作区', `共 ${rows.length} 个`);
  const title = headline(theme, model.instanceName ?? 'DSH 实例', model.subtitle ?? '点编号进入工作区 · 回复「/工作区」刷新');
  inner += title.markup;
  let y = title.y + 8;
  inner += `<line x1="${CARD_PAD}" y1="${y}" x2="${w - CARD_PAD}" y2="${y}" stroke="${theme.divider}" stroke-width="1"/>`;
  y += 34;
  const nameX = CARD_PAD + 40;
  const timeRight = w - CARD_PAD;
  if (rows.length === 0)
    inner += emptyRow(theme, y, model.emptyText ?? '还没有工作区');
  for (const [index, row] of rows.entries()) {
    inner += `<text x="${CARD_PAD}" y="${y}" font-family="${FONT_FAMILY}" font-size="18" fill="${theme.faint}">${index + 1}</text>`;
    inner += `<text x="${nameX}" y="${y}" font-family="${FONT_FAMILY}" font-size="21" fill="${theme.fg}">${escapeXml(fitText(row.name, 21, timeRight - nameX - 130))}</text>`;
    inner += `<text x="${timeRight}" y="${y}" text-anchor="end" font-family="${FONT_FAMILY}" font-size="16" fill="${theme.faint}">${escapeXml(row.time ?? '')}</text>`;
    y += 42;
  }
  const height = y + 34;
  inner += footer(theme, height, model.footer ?? '回复编号进入 · 分支会话也可按编号切换');
  return { svg: cardShell(theme, inner, height), height };
}

/**
 * One conversation row, indented and arrow-marked when it is a branch.
 *
 * The branch marker is a horizontal stroke feeding an upward arrow: the width of the stroke is what
 * separates a branch from its parent at a glance, without inventing a second numbering scheme.
 *
 * @param {typeof CARD_THEMES[keyof CARD_THEMES]} theme
 * @param {number} y - Baseline.
 * @param {object} row
 * @param {string|number} row.no - Shared, continuous number across parents and branches.
 * @param {string} row.name
 * @param {string} row.time
 * @param {boolean} [row.current]
 * @param {boolean} [row.branch]
 * @param {string} [row.snippet] - One line of the newest message, drawn under the title.
 * @returns {string}
 */
function sessionRow(theme, y, row) {
  const w = CARD_WIDTH - PAD * 2;
  let out = '';
  let x = CARD_PAD;
  if (row.current)
    out += `<rect x="${CARD_PAD - 10}" y="${y - 22}" width="4" height="30" rx="2" fill="${theme.accent}"/>`;
  out += `<text x="${CARD_PAD}" y="${y}" font-family="${FONT_FAMILY}" font-size="18" fill="${theme.faint}">${escapeXml(row.no ?? '')}</text>`;
  x = CARD_PAD + 38;
  if (row.branch) {
    const ax = x + 14;
    const ay = y + 6;
    out += `<path d="M ${x - 14} ${ay} H ${ax}" fill="none" stroke="${theme.faint}" stroke-width="1.8" stroke-linecap="round"/>`;
    out += `<path d="M ${ax} ${ay} V ${y - 16}" fill="none" stroke="${theme.faint}" stroke-width="1.8" stroke-linecap="round"/>`;
    out += `<path d="M ${ax - 5} ${y - 9} L ${ax} ${y - 17} L ${ax + 5} ${y - 9}" fill="none" stroke="${theme.faint}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
    x += 30;
  }
  const nameSize = row.branch ? 19 : 21;
  out += `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${nameSize}" fill="${theme.fg}">${escapeXml(fitText(row.name, nameSize, w - CARD_PAD - x - 132))}</text>`;
  if (typeof row.snippet === 'string' && row.snippet !== '') {
    const snippetSize = 15;
    out += `<text x="${x}" y="${y + 20}" font-family="${FONT_FAMILY}" font-size="${snippetSize}" fill="${theme.sub}">${escapeXml(fitText(row.snippet, snippetSize, w - CARD_PAD - x - 8))}</text>`;
  }
  if (row.current)
    out += `<circle cx="${w - CARD_PAD - 92}" cy="${y - 7}" r="4" fill="${theme.accent}"/>`;
  out += `<text x="${w - CARD_PAD}" y="${y}" text-anchor="end" font-family="${FONT_FAMILY}" font-size="16" fill="${theme.faint}">${escapeXml(row.time ?? '')}</text>`;
  return out;
}

/**
 * Build the session card body.
 *
 * @param {object} model
 * @param {string} model.workspaceName - Big title.
 * @param {{no: string|number, name: string, time: string, current?: boolean, branch?: boolean}[]} model.rows
 * @param {{sessions: number, branches: number, current: number}} [model.stats]
 * @param {{index: number, pages: number}} [model.page]
 * @param {string} [model.subtitle]
 * @param {string} [model.footer]
 * @param {string} [model.emptyText]
 * @param {typeof CARD_THEMES[keyof CARD_THEMES]} theme
 * @returns {{svg: string, height: number}}
 */
function sessionCard(model, theme) {
  const w = CARD_WIDTH - PAD * 2;
  const rows = Array.isArray(model.rows) ? model.rows : [];
  const page = model.page ?? { index: 1, pages: 1 };
  let inner = headerRow(theme, 'DeepSeek Harness微信端 · 会话', `${page.index} / ${page.pages} 页`);
  const stats = model.stats;
  const subtitle = model.subtitle ?? (stats
    ? `会话 ${stats.sessions} · 分支 ${stats.branches} · 当前 ${stats.current}`
    : '回复编号切换 · 「/切换 会话名」精确切换');
  const title = headline(theme, model.workspaceName ?? '工作区', subtitle);
  inner += title.markup;
  let y = title.y + 8;
  inner += `<line x1="${CARD_PAD}" y1="${y}" x2="${w - CARD_PAD}" y2="${y}" stroke="${theme.divider}" stroke-width="1"/>`;
  y += 34;
  if (rows.length === 0)
    inner += emptyRow(theme, y, model.emptyText ?? '这个工作区还没有会话');
  for (const row of rows) {
    inner += sessionRow(theme, y, row);
    y += typeof row.snippet === 'string' && row.snippet !== '' ? 58 : row.branch ? 38 : 42;
  }
  const height = y + 34;
  inner += footer(theme, height, model.footer ?? '回复编号切换 · 分支行带折箭头标记');
  return { svg: cardShell(theme, inner, height), height };
}

/**
 * Build the command card body.
 *
 * @param {object} model
 * @param {{command: string, description: string}[]} model.rows
 * @param {string} [model.title]
 * @param {string} [model.subtitle]
 * @param {string} [model.footer]
 * @param {typeof CARD_THEMES[keyof CARD_THEMES]} theme
 * @returns {{svg: string, height: number}}
 */
function commandCard(model, theme) {
  const w = CARD_WIDTH - PAD * 2;
  const rows = Array.isArray(model.rows) ? model.rows : [];
  let inner = headerRow(theme, 'DeepSeek Harness微信端 · 指令', `共 ${rows.length} 条`);
  const title = headline(theme, model.title ?? '全部指令', model.subtitle ?? '回复「/帮助」随时呼出');
  inner += title.markup;
  let y = title.y + 8;
  inner += `<line x1="${CARD_PAD}" y1="${y}" x2="${w - CARD_PAD}" y2="${y}" stroke="${theme.divider}" stroke-width="1"/>`;
  y += 30;
  const descX = CARD_PAD + 196;
  for (const row of rows) {
    inner += `<text x="${CARD_PAD}" y="${y}" font-family="${FONT_FAMILY}" font-size="17" fill="${theme.accent}">${escapeXml(fitText(row.command, 17, 190))}</text>`;
    inner += `<text x="${descX}" y="${y}" font-family="${FONT_FAMILY}" font-size="18" fill="${theme.fg}">${escapeXml(fitText(row.description ?? '', 18, w - CARD_PAD * 2 - 196))}</text>`;
    y += 33;
  }
  const height = y + 26;
  inner += footer(theme, height, model.footer ?? '全部命令名可在设置页「指令映射」里改');
  return { svg: cardShell(theme, inner, height), height };
}

/**
 * One key/value row of an info card.
 *
 * A row carries a short label on the left and one line of value on the right; `note` adds a second,
 * smaller line under the value for the parts that would otherwise be truncated (a model's reasoning
 * levels, the reason a preset is recommended). Values are shrunk before they are cut: a card that
 * says `deepseek-v4 · 深度思考` in full is worth more than one whose font never changes.
 *
 * @param {typeof CARD_THEMES[keyof CARD_THEMES]} theme
 * @param {number} y - Baseline.
 * @param {object} row
 * @param {string} [row.label]
 * @param {string} row.value
 * @param {string} [row.note]
 * @param {boolean} [row.accent] - Paint the value in the theme accent (the active model, the current preset).
 * @returns {string}
 */
function infoRow(theme, y, row) {
  const w = CARD_WIDTH - PAD * 2;
  const labelW = 150;
  const hasLabel = typeof row.label === 'string' && row.label !== '';
  const vx = hasLabel ? CARD_PAD + labelW : CARD_PAD;
  const maxW = w - PAD - (vx - PAD);
  const value = String(row.value ?? '');
  let size = 19;
  while (size > 14 && textWidth(value, size) > maxW)
    size -= 1;
  let out = '';
  if (hasLabel)
    out += `<text x="${CARD_PAD}" y="${y}" font-family="${FONT_FAMILY}" font-size="18" fill="${theme.sub}">${escapeXml(row.label)}</text>`;
  out += `<text x="${vx}" y="${y}" font-family="${FONT_FAMILY}" font-size="${size}" fill="${row.accent === true ? theme.accent : theme.fg}">${escapeXml(value)}</text>`;
  if (typeof row.note === 'string' && row.note !== '')
    out += `<text x="${vx}" y="${y + 24}" font-family="${FONT_FAMILY}" font-size="15" fill="${theme.faint}">${escapeXml(fitText(row.note, 15, maxW))}</text>`;
  return out;
}

/**
 * Build the info card body: a titled list of label/value rows.
 *
 * This is the shape for every answer that is a handful of facts rather than a listing — the current
 * model, the permission presets, the mode presets, the bound conversation, the chat statistics. It is
 * deliberately not a table: inside a phone message, a two-column key/value block reads in one glance,
 * while a grid needs horizontal scanning.
 *
 * @param {object} model
 * @param {string} [model.header] - Small header label, defaults to 'DeepSeek Harness微信端 · 信息'.
 * @param {string} [model.badge] - Right-aligned header text.
 * @param {string} model.title - Big title.
 * @param {string} [model.subtitle]
 * @param {{label?: string, value: string, note?: string, accent?: boolean}[]} model.rows
 * @param {string} [model.footer]
 * @param {string} [model.emptyText]
 * @param {typeof CARD_THEMES[keyof CARD_THEMES]} theme
 * @returns {{svg: string, height: number}}
 */
function infoCard(model, theme) {
  const w = CARD_WIDTH - PAD * 2;
  const rows = Array.isArray(model.rows) ? model.rows : [];
  let inner = headerRow(theme, model.header ?? 'DeepSeek Harness微信端 · 信息', model.badge ?? '');
  const title = headline(theme, model.title ?? '信息', model.subtitle);
  inner += title.markup;
  let y = title.y + 8;
  inner += `<line x1="${CARD_PAD}" y1="${y}" x2="${w - CARD_PAD}" y2="${y}" stroke="${theme.divider}" stroke-width="1"/>`;
  y += 32;
  if (rows.length === 0)
    inner += emptyRow(theme, y, model.emptyText ?? '暂时没有可以显示的信息');
  for (const row of rows) {
    inner += infoRow(theme, y, row);
    y += row.note === undefined || row.note === '' ? 40 : 62;
  }
  const height = y + 26;
  inner += footer(theme, height, model.footer ?? '');
  return { svg: cardShell(theme, inner, height), height };
}

const CARD_BUILDERS = {
  workspace: workspaceCard,
  session: sessionCard,
  command: commandCard,
  info: infoCard,
};

/**
 * Render one card to a JPEG buffer.
 *
 * @param {'workspace'|'session'|'command'} kind
 * @param {object} model - Shape documented on the matching builder.
 * @param {object} [options]
 * @param {string} [options.theme] - Theme key; unknown keys fall back to the default.
 * @param {string} [options.accent] - Accent colour override from settings.
 * @param {number} [options.quality] - JPEG quality, 1-100.
 * @returns {Promise<Buffer>} JPEG bytes, 1500 px wide.
 */
export async function renderCard(kind, model, options = {}) {
  const build = CARD_BUILDERS[kind];
  if (build === undefined)
    throw new Error(`unknown card kind: ${String(kind)}`);
  const base = CARD_THEMES[normalizeTheme(options.theme)];
  const theme = typeof options.accent === 'string' && options.accent.trim() !== ''
    ? { ...base, accent: options.accent.trim() }
    : base;
  const card = build(model, theme);
  const height = card.height;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}">`
    + `${background(theme)}${card.svg}</svg>`;
  const quality = Number.isFinite(options.quality) ? Math.min(100, Math.max(1, options.quality)) : DEFAULT_QUALITY;
  return sharp(Buffer.from(svg), { density: RENDER_DENSITY })
    .jpeg({ quality, chromaSubsampling: '4:4:4' })
    .toBuffer();
}
