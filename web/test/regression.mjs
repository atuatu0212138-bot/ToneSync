/**
 * ToneSync 回归测试（puppeteer-core 驱动本机 Chrome）。
 *
 * 运行：
 *   1) 项目根目录起服务：python3 web/serve.py   （必须用 serve.py，no-store 防缓存错配，BUG-007）
 *   2) cd web/test && npm i && node regression.mjs
 * 失败断言会以非零退出码结束。截图输出到 web/test/out/。
 *
 * 约定：docs/Bug单.md 中每个已修复 bug 在此对应一条断言（断言名与 Bug 单一致）。
 */

import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.TS_BASE || 'http://localhost:8123/web/';
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.TS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--window-size=1440,900', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGE: ' + e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const assert = (name, ok) => results.push(`${ok ? '✅' : '❌'} ${name}`);

await page.goto(BASE + '?demo=1', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__ts?.images.length === 18 && window.__ts.refs.length === 1
  && window.__ts.images.every((i) => i.stats), { timeout: 30000 });
await sleep(400);

// 分屏对比默认开启；BUG-001 图片名在图片框内；视图切换图标不遮挡图片
let st = await page.evaluate(() => {
  const nb = document.getElementById('img-name').getBoundingClientRect();
  const sg = document.getElementById('stage').getBoundingClientRect();
  return {
    split: !document.getElementById('split-bar').hidden,
    rect: window.__ts._imgRect,
    nameBox: { x: nb.x, y: nb.y },
    stage: { x: sg.x, y: sg.y },
  };
});
assert('分屏对比默认显示', st.split);
const nx = st.nameBox.x - st.stage.x, ny = st.nameBox.y - st.stage.y;
assert('图片名在图片框内', nx >= st.rect.x && ny >= st.rect.y - 2
  && nx <= st.rect.x + st.rect.w && ny <= st.rect.y + st.rect.h);   // BUG-001
assert('图片不与右上角图标重叠', st.rect.y >= 50);
await page.screenshot({ path: OUT + 'single_split.png' });

// 分屏条可拖动，且可滑到图片左右边界（0–100%，评审⑤补）
const bar = await page.evaluate(() => {
  const b = document.getElementById('split-bar').getBoundingClientRect();
  return { x: b.x, y: b.y + b.height / 2 };
});
const geo = await page.evaluate(() => {
  const r = window.__ts._imgRect, s = document.getElementById('stage').getBoundingClientRect();
  return { left: s.x + r.x, right: s.x + r.x + r.w, x34: s.x + r.x + r.w * 0.34 };
});
await page.mouse.move(bar.x, bar.y);
await page.mouse.down();
await page.mouse.move(geo.left - 80, bar.y, { steps: 4 });
let sp = await page.evaluate(() => window.__ts.split);
assert(`分屏滑杆可达左边界 (split=${sp.toFixed(0)}%)`, sp <= 1);
await page.mouse.move(geo.right + 80, bar.y, { steps: 4 });
sp = await page.evaluate(() => window.__ts.split);
assert(`分屏滑杆可达右边界 (split=${sp.toFixed(0)}%)`, sp >= 99);
await page.mouse.move(geo.x34, bar.y, { steps: 4 });
await page.mouse.up();
sp = await page.evaluate(() => window.__ts.split);
assert(`分屏条可拖动 (split=${sp.toFixed(0)}%)`, sp > 25 && sp < 45);

// 滚轮缩放 + 双击复位（headless 不合成 dblclick，直接派发事件验证处理逻辑）
const center = await page.evaluate(() => {
  const r = window.__ts._imgRect, s = document.getElementById('stage').getBoundingClientRect();
  return { x: s.x + r.x + r.w / 2, y: s.y + r.y + r.h / 2 };
});
await page.mouse.move(center.x, center.y);
await page.mouse.wheel({ deltaY: -400 });
await sleep(150);
let zoom = await page.evaluate(() => window.__ts.zoom);
assert(`滚轮放大 (zoom=${zoom.toFixed(2)})`, zoom > 1.5);
await page.screenshot({ path: OUT + 'zoomed.png' });
await page.evaluate(() =>
  document.getElementById('glcanvas').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
await sleep(150);
zoom = await page.evaluate(() => window.__ts.zoom);
assert('双击复位 (zoom=1)', zoom === 1);

// BUG-006：滚轮落在分屏手柄上也能缩放
const handle = await page.evaluate(() => {
  const hb = document.querySelector('.split-handle').getBoundingClientRect();
  return { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
});
await page.mouse.move(handle.x, handle.y);
await page.mouse.wheel({ deltaY: -300 });
await sleep(150);
zoom = await page.evaluate(() => window.__ts.zoom);
assert(`悬停分屏手柄滚轮可缩放 (zoom=${zoom.toFixed(2)})`, zoom > 1.2);

// BUG-005：单图内容裁剪到胶片条上沿
st = await page.evaluate(() => {
  const s = document.getElementById('stage').getBoundingClientRect();
  return window.__clip && Math.abs(window.__clip[3] - (s.height - 110)) < 2;
});
assert('单图内容裁剪到胶片条上沿', st);

await page.evaluate(() => document.getElementById('glcanvas').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
await sleep(150);

// 胶片条末尾 ＋ 格子（滚到最右后点击应触发文件选择）
await page.evaluate(() => {
  window.__plusClicked = false;
  document.getElementById('file-input').addEventListener('click', (e) => {
    window.__plusClicked = true; e.preventDefault();
  }, { once: true });
});
const stripPos = await page.evaluate(() => {
  const s = document.getElementById('stage').getBoundingClientRect();
  return { x: s.x + 400, y: s.y + s.height - 55 };
});
await page.mouse.move(stripPos.x, stripPos.y);
await page.mouse.wheel({ deltaY: 3000 });
await page.mouse.wheel({ deltaY: 3000 });
await sleep(250);
const plus = await page.evaluate(() => {
  const c = window.__rects.strip.find((r) => r.i === -1);
  const s = document.getElementById('stage').getBoundingClientRect();
  return { x: s.x + c.x + c.w / 2, y: s.y + c.y + c.h / 2 };
});
// v1.0⑤：hover ＋格子时虚线变紫（悬停后重绘读取标记）
await page.mouse.move(plus.x, plus.y);
await sleep(120);
assert('＋格子 hover 虚线变紫', await page.evaluate(() => window.__plusColor === 'purple'));   // v1.0⑤
await page.mouse.move(plus.x - 220, plus.y);   // 沿胶片条左移到缩略图（仍在 canvas，非 ＋格子）
await sleep(150);
assert('＋格子移开恢复灰色', await page.evaluate(() => window.__plusColor === 'gray'));
await page.mouse.click(plus.x, plus.y);
await sleep(120);
assert('＋格子打开文件选择', await page.evaluate(() => window.__plusClicked));
assert('＋格子为虚线边框', await page.evaluate(() => window.__plusStyle === 'dashed'));   // BUG-002
// v1.0⑤：胶片条选中态用细核心+外发光（drawSel），非旧单层实心块
assert('选中态细核心+外发光', await page.evaluate(() => window.__selStyle === 'glow'));

// 素材悬停 × 删除（评审⑩）
const cell0 = await page.evaluate(() => {
  const c = window.__rects.strip.find((r) => r.i >= 0 && r.x > 0 && r.x + r.w < 900);
  const s = document.getElementById('stage').getBoundingClientRect();
  return { x: s.x + c.x + c.w / 2, y: s.y + c.y + c.h / 2 };
});
await page.mouse.move(cell0.x, cell0.y);
await sleep(150);
assert('悬停素材显示删除按钮', await page.evaluate(() => !document.getElementById('thumb-del').hidden));
await page.click('#thumb-del');
await sleep(150);
assert('点击 × 删除素材 (18→17)', await page.evaluate(() => window.__ts.images.length === 17));
await page.mouse.move(600, 300);

// logo 返回上传界面 + 返回工作区
await page.click('#home');
await sleep(150);
st = await page.evaluate(() => ({
  empty: !document.getElementById('empty').hidden,
  back: !document.getElementById('btn-back').hidden,
  refBtn: !!document.getElementById('btn-upload-ref'),
}));
assert('logo 返回上传界面（含上传参考图按钮 + 返回链接）', st.empty && st.back && st.refBtn);
await page.screenshot({ path: OUT + 'import_view.png' });
await page.click('#btn-back');
await sleep(150);
assert('返回工作区', await page.evaluate(() => document.getElementById('empty').hidden));

// 对比开关
await page.click('#cmp-toggle');
await sleep(150);
assert('对比开关可关闭', await page.evaluate(() => document.getElementById('split-bar').hidden));
await page.click('#cmp-toggle');

// ---- v0.10：多参考图（等权合成一个色调 + 大预览 ‹› 切换）----
st = await page.evaluate(() => ({
  n: window.__ts.refs.length,
  viewShown: !document.getElementById('ref-view').hidden,
  addHidden: document.getElementById('ref-add').hidden,
  active: document.getElementById('ref-main').classList.contains('active'),
  bigSrc: !!document.getElementById('ref-big').src,
}));
assert('demo 参考图 → 大预览卡片显示且激活（原型①）', st.n === 1 && st.viewShown && st.addHidden && st.active && st.bigSrc);

// 加第 2 张 → 合成 = 平均统计（v0.10 平均观感语义），强度只有全局一档
await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#3366aa'; x.fillRect(0, 0, 64, 64);
  x.fillStyle = '#aa6633'; x.fillRect(0, 32, 64, 32);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'ref2.png', { type: 'image/png' }));
  const input = document.getElementById('ref-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
});
await sleep(500);
st = await page.evaluate(() => {
  const refs = window.__ts.refs;
  const m = window.__merged();
  const avg = (sel) => [0, 1, 2].map((c) => refs.reduce((s, r) => s + r.stats[sel][c], 0) / refs.length);
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  return {
    n: refs.length,
    meanOk: near(m.mean, avg('mean')),
    stdOk: near(m.std, avg('std')),
    viewIdx: window.__ts.refView,
    countText: document.getElementById('ref-count').textContent,   // v1.0④：标题栏单一计数 当前/总张数
    noIdx: !document.getElementById('ref-idx'),                     // v1.0④：图上叠字计数已去掉
    bigSrc: document.getElementById('ref-big').src,
    palette: [...document.querySelectorAll('#ref-palette div')].map((d) => d.style.background),
    boxH: document.getElementById('tone-box').offsetHeight,
  };
});
assert('两张合成 = 各图统计的平均（平均观感公式）', st.n === 2 && st.meanOk && st.stdOk);
assert(`标题栏单一计数=当前/总张数，图上无叠字 (${st.countText})`, st.viewIdx === 1
  && st.countText === '2 / 2' && st.noIdx);   // v1.0④
assert('参考图预览用原图不糊', st.bigSrc.startsWith('blob:'));   // BUG-009
assert(`色板条 5 个主色色块（原型样式）`, st.palette.length === 5 && st.palette.every((c) => c.startsWith('rgb')));
const boxH0 = st.boxH;
let eff = await page.evaluate(() => window.__eff());
assert(`强度只有全局一档 (k_eff=${eff.toFixed(2)})`, Math.abs(eff - 0.7) < 0.01);

// ‹› 切换查看 + ✕ 删除当前查看的参考图
await page.evaluate(() => document.getElementById('ref-prev').click());
await sleep(100);
st = await page.evaluate(() => ({
  idx: window.__ts.refView,
  prevOff: document.getElementById('ref-prev').classList.contains('disabled'),
}));
assert('‹ 切到第 1 张且左箭头到边禁用', st.idx === 0 && st.prevOff);
await page.evaluate(() => document.getElementById('ref-next').click());
await sleep(100);
assert('› 切到第 2 张', await page.evaluate(() => window.__ts.refView === 1));
await page.evaluate(() => document.getElementById('ref-del').click());
await sleep(200);
assert('✕ 删除当前查看的参考图 (2→1)', await page.evaluate(() => window.__ts.refs.length === 1));

// 上限 20 张
await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 8; c.height = 8;
  c.getContext('2d').fillStyle = '#7a8899';
  c.getContext('2d').fillRect(0, 0, 8, 8);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  for (let i = 0; i < 25; i++) dt.items.add(new File([blob], `r${i}.png`, { type: 'image/png' }));
  const input = document.getElementById('ref-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
});
await sleep(1600);
st = await page.evaluate(() => window.__ts.refs.length);
assert(`参考图上限 20 (n=${st})`, st === 20);

// ---- v0.10 面板合并单页 + v0.11 单一入口模块 ----
st = await page.evaluate(() => {
  const secs = [...document.querySelectorAll('.panel-body > section')];
  const idx = (q) => secs.findIndex((s) => s.querySelector(q) || s.matches(q));
  return {
    merged: !document.getElementById('page-ref') && !document.getElementById('page-cube'),
    railTone: !!document.getElementById('rail-tone'),
    railOld: !!(document.getElementById('rail-page-ref') || document.getElementById('rail-page-cube')),
    order: idx('#tone-box') < idx('#cube-tabs'),
    oneModule: !document.getElementById('cube-drop')            // 独立导入区已并入
      && !!document.querySelector('#tone-box #ref-add')          // 合并入口
      && !!document.querySelector('#tone-box #cube-chip')        // 名称条在模块内
      && !document.getElementById('ref-thumbs'),                 // 缩略图行已去掉（手写③）
  };
});
assert('面板合并为单页', st.merged);
assert('参考图与导入 .cube 合并为一个模块（名称条在模块内，无缩略图行）', st.oneModule);
assert('窄栏两页图标合并为一个调色板图标', st.railTone && !st.railOld);
assert('区块顺序：合并入口模块 → 分类页签', st.order);

// ---- v0.9：分类页签 + 垫图卡片 ----
st = await page.evaluate(() => [...document.querySelectorAll('#cube-tabs button')].map((b) => b.textContent));
assert(`四个分类页签 (${st.join('/')})`, st.join() === '常用,内置,收藏,最近');

st = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('#presets .lut-card')];
  return { n: cards.length, pad: cards.every((c) => (c.querySelector('.thumb')?.style.backgroundImage || '').includes('data:image')) };
});
assert(`常用页签 8 张垫图卡片`, st.n === 8 && st.pad);

// ---- v1.1③：卡片网格随面板宽度自适应列数（默认 3 列，稍大）----
st = await page.evaluate(() => ({
  panelW: document.getElementById('panel').offsetWidth,
  cols: getComputedStyle(document.getElementById('presets')).gridTemplateColumns.split(' ').length,
  tabH: document.getElementById('tab-common').clientHeight,
  scrolls: document.getElementById('tab-common').scrollHeight > document.getElementById('tab-common').clientHeight + 2,
}));
assert(`默认面板 ${st.panelW}px → 卡片 3 列`, st.cols === 3);
assert(`常用 8 卡 3 列共 3 行，限高滚动 (h=${st.tabH}px)`, st.scrolls && st.tabH <= 168);
const presetCardW = await page.evaluate(() => document.querySelector('#presets .lut-card').offsetWidth);

// ---- 优化 v1.0①：卡片 hover 微放大 + 提亮（newwow 式），无选中态紫框 ----
const cardBox = await page.evaluate(() => {
  const r = document.querySelector('#presets .lut-card').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(cardBox.x, cardBox.y);
await sleep(420);
st = await page.evaluate(() => {
  const cs = getComputedStyle(document.querySelector('#presets .lut-card'));
  return { t: cs.transform, f: cs.filter };
});
assert(`卡片 hover 微放大提亮（newwow 式）`, st.t.startsWith('matrix(1.045') && st.f.includes('brightness'));
await page.mouse.move(700, 400);
await sleep(250);

await page.evaluate(() => document.querySelector('#cube-tabs button[data-tab=builtin]').click());
await sleep(200);
st = await page.evaluate(() => ({
  vis: !document.getElementById('tab-builtin').hidden,
  n: document.querySelectorAll('#builtins .lut-card').length,
}));
assert(`内置页签 9 个下载 LUT 卡片 (n=${st.n})`, st.vis && st.n === 9);

// 内置卡片与常用同规格（同 auto-fill 列数与卡片尺寸），9 个超 2 行 → 滚动
st = await page.evaluate(() => {
  const cols = (id) => getComputedStyle(document.getElementById(id)).gridTemplateColumns.split(' ').length;
  const tb = document.getElementById('tab-builtin');
  return {
    cardW: document.querySelector('#builtins .lut-card').offsetWidth,
    cols: cols('builtins'),
    scrolls: tb.scrollHeight > tb.clientHeight + 2,
    h: tb.clientHeight,
  };
});
assert(`内置卡片与常用同规格（${st.cols} 列，宽 ${st.cardW}px）`, st.cols === 3 && st.cardW === presetCardW);
assert(`内置 9 卡超 2 行出滚动框 (h=${st.h}px)`, st.scrolls && st.h <= 168);

// v1.1③：拖动面板左缘调宽 → 自适应 4 列（丝滑，向左拖变宽）
const rz = await page.evaluate(() => { const r = document.getElementById('panel-resize').getBoundingClientRect(); return { x: r.x + 3, y: r.y + 220 }; });
await page.mouse.move(rz.x, rz.y);
await page.mouse.down();
await page.mouse.move(rz.x - 95, rz.y, { steps: 8 });
await page.mouse.up();
await sleep(200);
st = await page.evaluate(() => ({   // builtin tab 当前可见，量可见网格的列数（auto-fill 需布局才解析）
  w: window.__ts.panelW,
  cols: getComputedStyle(document.getElementById('builtins')).gridTemplateColumns.split(' ').length,
}));
assert(`拖宽面板到 ${st.w}px → 自适应 4 列`, st.w >= 384 && st.cols === 4);
// 拖回默认宽（后续用例仍按 3 列/300px 布局）
await page.evaluate(() => { document.getElementById('panel').style.width = '300px'; window.__ts.panelW = 300; });
await sleep(120);

await page.evaluate(() => document.querySelector('#builtins .lut-card').click());
await sleep(250);
st = await page.evaluate(() => {
  const t = window.__ts.tone;
  const c = window.__ts.cubes.find((x) => x.id === t.id);
  return t.type === 'cube' && !!(c && c.asset);
});
assert('点击内置 LUT 卡片激活', st);

// ---- v1.1②：收藏当前色调为模版（此刻 tone 为内置 cube，收藏后进收藏 tab）----
const favBefore = await page.evaluate(() => window.__ts.cubes.filter((c) => c.origin === 'fav').length);
await page.evaluate(() => document.getElementById('btn-fav').click());
await sleep(300);
st = await page.evaluate(() => ({
  favN: window.__ts.cubes.filter((c) => c.origin === 'fav').length,
  cards: document.querySelectorAll('#favs .fav-card').length,
  tab: window.__ts.cubeTab,
  emptyHidden: document.getElementById('fav-empty').hidden,
  favTitle: document.getElementById('btn-fav').title,
}));
assert('★ 收藏当前色调为模版（进收藏 tab 垫图卡片）', st.favN === favBefore + 1
  && st.cards === st.favN && st.tab === 'fav' && st.emptyHidden);
assert('收藏按钮 hover 文案「收藏当前色调为模版」', st.favTitle === '收藏当前色调为模版');
// 点收藏卡片激活为色调（cube 类型）
await page.evaluate(() => document.querySelector('#favs .fav-card').click());
await sleep(200);
assert('点收藏卡片激活色调', await page.evaluate(() => {
  const t = window.__ts.tone, c = window.__ts.cubes.find((x) => x.id === t.id);
  return t.type === 'cube' && !!(c && c.origin === 'fav');
}));
// 悬停 ✕ 删除收藏
const favCard = await page.evaluate(() => { const r = document.querySelector('#favs .fav-card').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.move(favCard.x, favCard.y);
await sleep(150);
await page.evaluate(() => document.querySelector('#favs .fav-card .card-del').click());
await sleep(200);
assert('悬停 ✕ 删除收藏', await page.evaluate((fb) =>
  window.__ts.cubes.filter((c) => c.origin === 'fav').length === fb
  && !document.getElementById('fav-empty').hidden, favBefore));

// v1.1①：手动调色按钮为占位（点击 toast 即将上线，不改状态）
await page.evaluate(() => document.getElementById('btn-manual').click());
await sleep(150);
assert('手动调色按钮占位（toast 即将上线）', await page.evaluate(() =>
  document.getElementById('toast').textContent.includes('手动调色')
  && document.getElementById('btn-manual').title.includes('手动调色')));

// ---- 导入 .cube（合并入口 tone-input，只保留一个，名称条模块内 ✕）----
const importCube = (title, mapper) => page.evaluate(({ title, mapper }) => {
  const fn = new Function('r', 'g', 'b', mapper);
  const lines = [`TITLE "${title}"`, 'LUT_3D_SIZE 2'];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++)
    lines.push(fn(r, g, b).join(' '));
  const dt = new DataTransfer();
  dt.items.add(new File([lines.join('\n')], `${title}.cube`, { type: 'text/plain' }));
  const input = document.getElementById('tone-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
}, { title, mapper });
await importCube('InvertR', 'return [1 - r, g, b];');
await sleep(300);
st = await page.evaluate(() => ({
  tone: window.__ts.tone.type,
  n: window.__ts.cubes.filter((c) => c.origin === 'imported').length,
  chipShown: !document.getElementById('cube-chip').hidden,
  chipName: document.querySelector('#cube-chip .name').textContent,
  chipActive: document.getElementById('cube-chip').classList.contains('active'),
  hist: window.__ts.history.length,
  boxH: document.getElementById('tone-box').offsetHeight,
}));
assert('导入 .cube 生效并显示名称条', st.tone === 'cube' && st.n === 1
  && st.chipShown && st.chipName === 'InvertR.cube' && st.chipActive);
assert('仅导入不进"最近"历史（导出/下载时才存，拍板②）', st.hist === 0);
assert(`合并模块定高不随内容变化且同原型高 (${boxH0}px → ${st.boxH}px)`, st.boxH === boxH0 && Math.abs(boxH0 - 118) <= 1);   // BUG-010

// 再导入 → 替换当前（只能导入一个 LUT）
await importCube('HalfG', 'return [r, g * 0.5, b];');
await sleep(300);
st = await page.evaluate(() => ({
  n: window.__ts.cubes.filter((c) => c.origin === 'imported').length,
  chipName: document.querySelector('#cube-chip .name').textContent,
}));
assert('再导入替换当前（仅保留一个）', st.n === 1 && st.chipName === 'HalfG.cube');

// 非法 .cube → 提示且不崩（不影响已导入的）
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['garbage data'], 'bad.cube', { type: 'text/plain' }));
  const input = document.getElementById('tone-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
});
await sleep(300);
st = await page.evaluate(() => ({
  n: window.__ts.cubes.filter((c) => c.origin === 'imported').length,
  name: document.querySelector('#cube-chip .name').textContent,
  toast: document.getElementById('toast').textContent,
}));
assert('非法 .cube 提示且不崩', st.n === 1 && st.name === 'HalfG.cube' && st.toast.includes('导入失败'));

// 导出 .cube（拦截 a.click 读取 blob 内容）→ 色调进"最近"历史（v0.10）
st = await page.evaluate(async () => {
  let captured = null;
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { captured = { href: this.href, name: this.download }; };
  document.getElementById('btn-export-cube').click();
  HTMLAnchorElement.prototype.click = orig;
  if (!captured) return { ok: false };
  const text = await (await fetch(captured.href)).text();
  return { ok: true, name: captured.name, hasSize: text.includes('LUT_3D_SIZE'), hasMeta: text.includes('ToneSync-Meta') };
});
assert(`导出 .cube (${st.name || '未触发'})`, st.ok && st.hasSize && st.hasMeta);
await sleep(200);
st = await page.evaluate(() => ({
  hist: window.__ts.history.length,
  items: document.querySelectorAll('#hist-list .hist-item').length,
  emptyGone: document.getElementById('recent-empty').hidden,
  name: document.querySelector('#hist-list .hist-item .name')?.textContent,
}));
assert(`导出后色调存入"最近"历史 (${st.name})`, st.hist === 1 && st.items === 1 && st.emptyGone && st.name === 'HalfG.cube');

// ---- v0.10：下载图片双模式（原型④）----
// 单图视图：按钮=「下载图片」，直接下载当前查看的这张（原名原格式）；同签名色调不重复进历史
st = await page.evaluate(() => new Promise((resolve) => {
  const btn = document.getElementById('btn-export-imgs');
  const info = { label: btn.textContent, disabled: btn.disabled };
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    HTMLAnchorElement.prototype.click = orig;
    resolve({ ...info, name: this.download, cur: window.__ts.images[window.__ts.selected].name });
  };
  btn.click();
  setTimeout(() => resolve({ ...info, timeout: true }), 30000);
}));
assert(`单图视图按钮为「下载图片」且下载当前图 (${st.name})`, st.label === '下载图片' && !st.disabled
  && !st.timeout && st.name === st.cur);
await sleep(300);
assert('同签名色调不重复进历史（去重）', await page.evaluate(() => window.__ts.history.length === 1));

// 历史条目点击可复用色调
await page.evaluate(() => document.querySelector('#hist-list .hist-item').click());
await sleep(200);
st = await page.evaluate(() => ({
  tone: window.__ts.tone.type,
  active: document.querySelector('#hist-list .hist-item').classList.contains('active'),
}));
assert('点击历史条目复用色调', st.tone === 'hist' && st.active);

// 优化 v1.0①：色调来源（参考图预览/名称条/垫图卡片/历史条目）均无紫框选中态
st = await page.evaluate(() => {
  const purple = 'rgb(107, 92, 231)';
  const els = [document.getElementById('ref-main'), document.getElementById('cube-chip'),
    document.querySelector('#presets .lut-card'), document.querySelector('#hist-list .hist-item')];
  return els.every((el) => {
    const cs = getComputedStyle(el);
    return cs.outlineStyle === 'none' || cs.outlineWidth === '0px' || cs.outlineColor !== purple;
  });
});
assert('色调来源无紫框选中态（v1.0①）', st);

// 换模版色调再下载 → 历史 +1
await page.evaluate(() => document.querySelector('#presets .lut-card').click());
await sleep(250);
st = await page.evaluate(() => new Promise((resolve) => {
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { HTMLAnchorElement.prototype.click = orig; resolve(true); };
  document.getElementById('btn-export-imgs').click();
  setTimeout(() => resolve(false), 30000);
}));
await sleep(300);
assert('换色调下载后历史 +1', st && await page.evaluate(() => window.__ts.history.length === 2));

// ---- v0.7：滑杆轨道色 / 平移权限 / BUG-003 ----
st = await page.evaluate(async () => {
  const css = await (await fetch('css/style.css')).text();
  return /slider-runnable-track\s*\{[^}]*background:\s*#55555E/i.test(css);
});
assert('滑杆轨道为统一灰色 #55555E', st);

// ① 侧边栏打开时只允许缩放：放大后拖动不应平移
const imgC = await page.evaluate(() => {
  const r = window.__ts._imgRect, s = document.getElementById('stage').getBoundingClientRect();
  return { x: s.x + Math.max(r.x, 0) + 80, y: s.y + Math.max(r.y, 40) + 80 };
});
await page.mouse.move(imgC.x, imgC.y);
await page.mouse.wheel({ deltaY: -300 });
await sleep(150);
let pan0 = await page.evaluate(() => [window.__ts.panX, window.__ts.panY]);
await page.mouse.down();
await page.mouse.move(imgC.x + 90, imgC.y + 40, { steps: 3 });
await page.mouse.up();
let pan1 = await page.evaluate(() => [window.__ts.panX, window.__ts.panY]);
assert('侧边栏打开时拖动不平移（仅缩放）', pan0[0] === pan1[0] && pan0[1] === pan1[1]);

// 关闭侧边栏 → 支持自由移动（v1.1：折叠改由窄栏图标，面板头 » 已改为手动调色占位）
await page.click('#rail-panel');
await sleep(200);
pan0 = await page.evaluate(() => [window.__ts.panX, window.__ts.panY]);
await page.mouse.move(imgC.x, imgC.y);
await page.mouse.down();
await page.mouse.move(imgC.x - 300, imgC.y - 40, { steps: 4 });
await page.mouse.up();
pan1 = await page.evaluate(() => [window.__ts.panX, window.__ts.panY]);
assert('侧边栏关闭时可自由移动', pan1[0] !== pan0[0]);

// BUG-003：图片拖出画布后，分屏线保持可视且按可视区对齐
await sleep(150);
st = await page.evaluate(() => {
  const r = window.__ts._imgRect, s = document.getElementById('stage').getBoundingClientRect();
  const bar = document.getElementById('split-bar').getBoundingClientRect();
  const vx0 = Math.max(r.x, 0), vx1 = Math.min(r.x + r.w, s.width);
  const expected = s.x + vx0 + (vx1 - vx0) * window.__ts.split / 100;
  const barX = bar.x + 1;
  return {
    diff: Math.abs(barX - expected),
    inCanvas: barX >= s.x - 1 && barX <= s.x + s.width + 1,
    offEdge: r.x < -40,
  };
});
assert(`缩放/移动后分屏线保持可视且对齐 (diff=${st.diff.toFixed(2)})`, st.diff < 1.5 && st.inCanvas && st.offEdge);

// 复位并重开面板，继续后续用例
await page.evaluate(() => document.getElementById('glcanvas').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
await page.click('#rail-panel');
await sleep(200);

// BUG-007：渲染循环异常兜底——注入一次绘制异常，toast 提示且后续帧继续渲染
st = await page.evaluate(async () => {
  window.__forceDrawError = true;
  window.__ts.strength = window.__ts.strength;   // 触发重绘
  document.getElementById('strength').dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 200));
  const toastShown = !document.getElementById('toast').hidden
    && document.getElementById('toast').textContent.includes('渲染异常');
  // 再触发一次重绘，验证循环存活（__clip 会被 draw 更新）
  window.__clip = null;
  document.getElementById('strength').dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 200));
  return { toastShown, alive: Array.isArray(window.__clip) };
});
assert('渲染循环异常兜底不死亡', st.toastShown && st.alive);

// 重置为图标按钮（评审⑧）+ 图标按钮无紫色描边（评审⑥⑦）
await page.mouse.move(500, 400);
await sleep(100);
st = await page.evaluate(() => {
  const reset = document.getElementById('btn-reset');
  const rail = getComputedStyle(document.getElementById('rail-panel'));
  const vt = getComputedStyle(document.getElementById('view-toggle'));
  return {
    resetIcon: !!reset.querySelector('svg') && !reset.textContent.includes('重置'),
    railOutline: rail.outlineStyle === 'none' || rail.outlineWidth === '0px',
    vtBorder: vt.borderColor,
  };
});
assert('重置按钮为图标', st.resetIcon);
assert('面板开合激活态无紫色描边', st.railOutline);
assert(`视图切换按钮边框非紫色 (${st.vtBorder})`, st.vtBorder !== 'rgb(107, 92, 231)');

// ---- v0.10：宫格视图多选 + 批量下载（原型④）----
await page.click('#view-toggle');
await sleep(500);
assert('切入网格墙', await page.evaluate(() => window.__ts.mode === 'wall'));
st = await page.evaluate(() => ({
  label: document.getElementById('btn-export-imgs').textContent,
  disabled: document.getElementById('btn-export-imgs').disabled,
}));
assert('宫格未选中时下载按钮置灰', st.disabled);

// 宫格按钮随选中数切换（v0.11⑦）：1 张 =「下载图片」，≥2 张 =「批量下载图片（n）」
const wallCell = (i) => page.evaluate((i) => {
  const c = window.__rects.wall[i];
  const s = document.getElementById('stage').getBoundingClientRect();
  return { x: s.x + c.x + c.w / 2, y: s.y + c.y + c.h / 2 };
}, i);
const c1 = await wallCell(1);
await page.mouse.click(c1.x, c1.y);
await sleep(150);
st = await page.evaluate(() => ({
  sel: window.__ts.wallSel.size,
  label: document.getElementById('btn-export-imgs').textContent,
  disabled: document.getElementById('btn-export-imgs').disabled,
}));
assert(`宫格选中 1 张按钮为「下载图片」 (${st.label})`, st.sel === 1 && st.label === '下载图片' && !st.disabled);
for (const i of [3, 5]) {
  const c = await wallCell(i);
  await page.mouse.click(c.x, c.y);
  await sleep(120);
}
st = await page.evaluate(() => ({
  sel: window.__ts.wallSel.size,
  mode: window.__ts.mode,
  label: document.getElementById('btn-export-imgs').textContent,
}));
assert(`宫格选中 ≥2 张按钮为「批量下载图片（n）」 (${st.label})`, st.sel === 3 && st.mode === 'wall'
  && st.label === '批量下载图片（3）');

// 再点一次取消选择
await page.mouse.click(c1.x, c1.y);
await sleep(120);
assert('再次单击取消选择 (3→2)', await page.evaluate(() => window.__ts.wallSel.size === 2));

// 批量下载选中（无 FSA → ZIP 降级），ZIP 内恰好 2 个文件；同色调去重不增历史
st = await page.evaluate(() => new Promise((resolve) => {
  window.showDirectoryPicker = undefined;   // 强制走 ZIP 路径
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const href = this.href, name = this.download;
    HTMLAnchorElement.prototype.click = orig;
    fetch(href).then((r) => r.arrayBuffer()).then((buf) => {
      const b = new Uint8Array(buf);
      let files = 0;   // 统计本地文件头 PK\x03\x04
      for (let i = 0; i + 3 < b.length; i++)
        if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 3 && b[i + 3] === 4) files++;
      resolve({ name, pk: b[0] === 0x50 && b[1] === 0x4b, files, bytes: buf.byteLength });
    });
  };
  document.getElementById('btn-export-imgs').click();
  setTimeout(() => resolve({ timeout: true }), 60000);
}));
assert(`批量下载选中 2 张（ZIP 降级，${st.bytes || 0}B）`, !st.timeout && st.pk && st.files === 2 && st.bytes > 5000);
await sleep(300);
assert('批量下载同色调去重不增历史', await page.evaluate(() => window.__ts.history.length === 2));

// 双击宫格素材 → 打开单图（headless 不合成 dblclick，直接派发验证处理逻辑）
await page.evaluate(() => {
  const c = window.__rects.wall[7];
  const cv = document.getElementById('glcanvas').getBoundingClientRect();
  document.getElementById('glcanvas').dispatchEvent(new MouseEvent('dblclick', {
    clientX: cv.left + c.x + c.w / 2, clientY: cv.top + c.y + c.h / 2, bubbles: true,
  }));
});
await sleep(300);
st = await page.evaluate(() => ({ mode: window.__ts.mode, sel: window.__ts.selected }));
assert(`双击宫格素材打开单图 (sel=${st.sel})`, st.mode === 'single' && st.sel === 7);

// ---- BUG-008：会话持久化 ----
// 设一个可辨识的强度 + 收藏一个模版 + 拖过的面板宽，等防抖落盘后重载普通地址，应完整恢复
await page.evaluate(() => {
  document.getElementById('ref-main').click();    // 确保有活动色调（参考图）供收藏
  const s = document.getElementById('strength');
  s.value = 42; s.dispatchEvent(new Event('input'));
  document.getElementById('btn-fav').click();     // v1.1②：收藏一个（当前 tone）
  document.getElementById('panel').style.width = '336px';   // v1.1③：改宽
  window.__ts.panelW = 336;
  document.getElementById('strength').dispatchEvent(new Event('input'));   // 触发 saveUi 落盘 panelW
});
await sleep(700);
const before = await page.evaluate(() => ({
  imgs: window.__ts.images.length, refs: window.__ts.refs.length, cubes: window.__ts.cubes.length,
  favs: window.__ts.cubes.filter((c) => c.origin === 'fav').length,
  hist: window.__ts.history.length,
}));
await page.goto(BASE, { waitUntil: 'networkidle0' });   // 无 demo 参数的普通地址
await page.waitForFunction((n) => window.__ts && window.__ts.images.length === n
  && window.__ts.images.every((i) => i.stats), { timeout: 30000 }, before.imgs);
await sleep(500);
st = await page.evaluate(() => ({
  imgs: window.__ts.images.length, refs: window.__ts.refs.length, cubes: window.__ts.cubes.length,
  favs: window.__ts.cubes.filter((c) => c.origin === 'fav').length,
  favCards: document.querySelectorAll('#favs .fav-card').length,
  panelW: window.__ts.panelW,
  hist: window.__ts.history.length,
  chip: !document.getElementById('cube-chip').hidden
    && document.querySelector('#cube-chip .name').textContent === 'HalfG.cube',
  histItems: document.querySelectorAll('#hist-list .hist-item').length,
  strength: window.__ts.strength, ws: document.getElementById('empty').hidden,
}));
assert(`刷新后会话恢复 (imgs=${st.imgs} refs=${st.refs} cubes=${st.cubes} strength=${st.strength}%)`,
  st.imgs === before.imgs && st.refs === before.refs && st.cubes === before.cubes
  && st.strength === 42 && st.ws);
assert(`刷新后导入名称条与色调历史恢复 (hist=${st.hist})`, st.chip && st.hist === before.hist
  && st.histItems === before.hist);
assert(`刷新后收藏模版与面板宽度恢复 (favs=${st.favs}, ${st.panelW}px)`,
  st.favs === before.favs && st.favs >= 1 && st.favCards === st.favs && st.panelW === 336);

// 清空工作区（含持久化）→ 重载后仍为空
await page.click('#home');
await sleep(150);
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0' }),
  page.click('#btn-clear'),
]);
await sleep(500);
st = await page.evaluate(() => ({
  empty: !document.getElementById('empty').hidden,
  n: window.__ts ? window.__ts.images.length : -1,
}));
assert('清空工作区（含持久化）', st.empty && st.n === 0);

// 优化 v1.0②：空态虚线框不常亮紫（无脉冲动画，仅 hover 变紫）
st = await page.evaluate(() => {
  const cs = getComputedStyle(document.getElementById('ref-add'));
  return { border: cs.borderColor, anim: cs.animationName };
});
assert(`空态虚线框不常亮紫 (${st.border})`, st.border !== 'rgb(107, 92, 231)'
  && (st.anim === 'none' || st.anim === ''));

console.log(results.join('\n'));
const realErrors = errors.filter((e) => !e.includes('测试注入'));   // BUG-007 用例的注入异常是预期的
console.log('console errors:', realErrors.length ? realErrors : 'none');
await browser.close();

const failed = results.filter((r) => r.startsWith('❌'));
if (failed.length || realErrors.length) {
  console.error(`\n${failed.length} 项断言失败，${realErrors.length} 条控制台错误`);
  process.exit(1);
}
console.log(`\n全部 ${results.length} 项通过`);
