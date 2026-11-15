// Renders the same command card in all five themes and stitches them into one JPEG.
// Offline only: no host, no channel, no state file touched.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderCard } from '../lib/cards.js';

const THEMES = [
  ['A', '深色科技'],
  ['B', '浅色简洁'],
  ['C', '渐变玻璃'],
  ['D', '暖纸手帐'],
  ['E', '终端极客'],
];

const rows = [
  { command: '/帮助', description: '全部指令卡片' },
  { command: '/工作区列表', description: '全部工作区' },
  { command: '/会话列表', description: '当前工作区的会话' },
  { command: '/模型', description: '模型与思考等级' },
  { command: '/切换', description: '进入工作区 / 会话' },
  { command: '/新会话', description: '新建会话并确认模式' },
  { command: '/权限', description: '查看或修改权限' },
  { command: '/模式', description: '查看或修改模式' },
  { command: '/聊天记录', description: '会话统计卡片' },
  { command: '/聊天记录/50', description: '导出最近 50 条记录' },
];

const outDir = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const gap = 26;
const buffers = [];
for (const [key, name] of THEMES) {
  const jpeg = await renderCard(
    'command',
    {
      title: `主题 ${key} · ${name}`,
      subtitle: '同一份数据，五种配色',
      rows,
      footer: `主题 ${key} · 卡片示例`,
    },
    { theme: key, quality: 88 },
  );
  const meta = await sharp(jpeg).metadata();
  buffers.push({ key, jpeg, height: meta.height ?? 0 });
  console.log(`theme ${key}: ${meta.width}x${meta.height} ${jpeg.length}B`);
}

const totalHeight = buffers.reduce((sum, b) => sum + b.height + gap, gap);
const composites = [];
let y = gap;
for (const buf of buffers) {
  composites.push({ input: buf.jpeg, left: 0, top: y });
  y += buf.height + gap;
}
const out = `${outDir}themes-5.jpg`;
await sharp({ create: { width: 1500, height: totalHeight, channels: 3, background: '#3a3a3a' } })
  .composite(composites)
  .jpeg({ quality: 86, chromaSubsampling: '4:4:4' })
  .toFile(out);
console.log(`wrote ${out} (${totalHeight}px tall)`);
