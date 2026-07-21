/**
 * ToneSync M1 —— 应用编排层。
 * 双视图（单图默认 / 网格墙）+ 底部胶片条 + 参考图驱动逐图匹配 + 8 内置模版 + 强度滑杆。
 * 单一 WebGL canvas 承载所有图像绘制（单图 / 墙 / 胶片条），DOM 只做 UI 覆盖层。
 *
 * 测试参数：?demo=1 自动载入示例；&mode=wall；&preset=2；&strength=40；&selftest=1
 */

import { Renderer, IDENTITY_TONE } from './gl.js';
import {
  affineParams, bakeLut, presetTransform, srgbToLab, labToSrgb, labStats,
  mergeRefStats, parseCube, serializeCube, sampleLut, PRESETS, LUT_SIZE,
} from './color.js';
import { putFile, updateFile, deleteFile, getAllFiles, setKV, getKV, clearAll } from './store.js';
import { makeZip } from './zip.js';

const $ = (id) => document.getElementById(id);
const THUMB = 256;          // 预览纹理长边（PRD §7 缩略图策略）
const FULL = 2048;          // 单图模式高清纹理长边
const TONE_FADE = 150;      // 换色调 crossfade（PRD §5.3）
const WALL_ANIM = 260;      // 网格墙入场动效
const STRIP_H = 110, CELL_W = 88, CELL_H = 64, CELL_GAP = 8;
const TOP_PAD = 54;         // 画布区顶部预留（优化④：视图切换图标不叠图）
const FIT = 0.9;            // 单图默认占比（优化③：不占满，留呼吸空间）
const ZOOM_MIN = 0.5, ZOOM_MAX = 4;
const REF_MAX = 20;         // M2：参考图上限

// ---------------------------------------------------------------- 状态

const state = {
  images: [],               // {id,name,thumbTex,fullTex,stats,w,h,aspect}
  selected: 0,
  mode: 'single',           // 'single' | 'wall'
  wallScroll: 0,
  stripScroll: 0,
  refs: [],                 // 多参考图 [{id,url,stats,pkey}]，≤REF_MAX，等权合成一个色调（v0.10）
  refView: 0,               // 大预览当前查看的参考图下标（‹› 切换）
  cubes: [],                // LUT 库 [{id,name,size,data,lutTex,origin:'builtin'|'imported',asset?,pkey?}]，imported 至多 1 个
  history: [],              // 色调历史（"最近"页签）：导出/下载时存入 [{hid,pkey,hkind,name,time,...}]
  wallSel: new Set(),       // 宫格视图多选（批量下载），存 image id
  cubeTab: 'common',        // v0.9 页签：common 常用 | builtin 内置 | fav 收藏 | recent 最近
  tone: { type: 'none' },   // {type:'none'|'ref'|'preset'|'cube'|'hist', idx?, id?, hid?}
  prevTone: { type: 'none' },
  toneChangedAt: -1e9,
  strength: 70,
  panelOpen: true,
  panelW: 300,              // v1.1③：面板宽度（可拖动，持久化）；卡片网格随宽自适应列数
  wallEnterAt: -1e9,
  importView: false,        // 优化①：logo 返回上传界面
  zoom: 1, panX: 0, panY: 0, // 优化③：单图缩放/平移
  split: 50, compareOn: true, // 优化⑤：分屏对比
  _imgRect: null,
};

let renderer, worker, presetLuts = [], dirty = true;
window.__ts = state;   // 供自动化测试读取状态
const canvas = $('glcanvas');
const stage = $('stage');

// ---------------------------------------------------------------- 色调求值

let mergedRef = null;   // 多参考图等权合并统计 {mean,std,W}（v0.10 平均观感语义）

function refreshMergedRef() {
  mergedRef = mergeRefStats(state.refs.map((r) => ({ stats: r.stats, weight: 1 })));
  invalidate();
}

const histEntry = (hid) => state.history.find((h) => h.hid === hid);

function toneDescriptor(toneState, img) {
  if (toneState.type === 'ref' && mergedRef && img.stats) {
    const { scale, offset } = affineParams(img.stats, mergedRef);
    return { mode: 1, scale, offset, lut: null };
  }
  if (toneState.type === 'preset') {
    return { mode: 2, scale: [1, 1, 1], offset: [0, 0, 0], lut: presetLuts[toneState.idx] };
  }
  if (toneState.type === 'cube') {
    const c = state.cubes.find((x) => x.id === toneState.id);
    if (c) return { mode: 2, scale: [1, 1, 1], offset: [0, 0, 0], lut: c.lutTex };
  }
  if (toneState.type === 'hist') {
    const h = histEntry(toneState.hid);
    if (!h) return IDENTITY_TONE;
    if (h.hkind === 'ref' && img.stats) {     // 历史参考图色调保持逐图匹配语义
      const { scale, offset } = affineParams(img.stats, h.stats);
      return { mode: 1, scale, offset, lut: null };
    }
    if (h.hkind === 'preset') return { mode: 2, scale: [1, 1, 1], offset: [0, 0, 0], lut: presetLuts[h.idx] };
    if (h.hkind === 'cube') {
      h.lutTex = h.lutTex || renderer.createLutTexture(h.data, h.size);
      return { mode: 2, scale: [1, 1, 1], offset: [0, 0, 0], lut: h.lutTex };
    }
  }
  return IDENTITY_TONE;
}

/** 有效强度：多参考图解析成一个色调，强度只有全局一档（v0.10）。 */
function effectiveStrength() {
  const k = state.strength / 100;
  if (state.tone.type === 'ref') return mergedRef ? k : 0;
  return k;
}

function toneName() {
  if (state.tone.type === 'ref') return state.refs.length > 1 ? `参考图合成 ×${state.refs.length}` : '参考图色调';
  if (state.tone.type === 'preset') return PRESETS[state.tone.idx].name;
  if (state.tone.type === 'cube') {
    const c = state.cubes.find((x) => x.id === state.tone.id);
    return c ? c.name : '';
  }
  if (state.tone.type === 'hist') {
    const h = histEntry(state.tone.hid);
    return h ? h.name : '';
  }
  return '';
}

function setTone(next) {
  state.prevTone = state.tone;
  state.tone = next;
  state.toneChangedAt = performance.now();
  syncPanel();
  invalidate();
}

const easeOut = (t) => 1 - (1 - t) ** 3;

// ---------------------------------------------------------------- 导入

async function decodeToCanvas(source, maxSide) {
  const bmp = await createImageBitmap(source);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

let imgSeq = 0;

/** 素材入库（持久化到 IndexedDB，BUG-008；恢复会话时 persist=false）。 */
async function addImageFromBlob(blob, name, pkey, persist) {
  const c = await decodeToCanvas(blob, THUMB);
  const img = {
    id: ++imgSeq, name, file: blob,
    pkey: persist ? putFile({ kind: 'img', name, blob }) : pkey,
    thumbTex: renderer.createImageTexture(c),
    fullTex: null, stats: null,
    aspect: c.width / c.height,
  };
  state.images.push(img);
  requestStats(img, c);
}

async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/'));
  for (const f of list) {
    try {
      await addImageFromBlob(f, f.name, null, true);
    } catch (err) {
      console.warn('解码失败，跳过：', f.name, err);
    }
  }
  if (state.images.length) enterWorkspace();
  invalidate();
}

function requestStats(img, canvasEl) {
  const px = canvasEl.getContext('2d').getImageData(0, 0, canvasEl.width, canvasEl.height);
  worker.postMessage({ id: img.id, pixels: px.data }, [px.data.buffer]);
}

async function ensureFullTex(img) {
  if (img.fullTex || !img.file || img._fullLoading) return;
  img._fullLoading = true;
  try {
    const c = await decodeToCanvas(img.file, FULL);
    img.fullTex = renderer.createImageTexture(c);
    invalidate();
  } catch { /* 保底用缩略图 */ }
}

// ---------------------------------------------------------------- 多参考图（M2）

let refSeq = 0, cubeSeq = 0, toastTimer = null;

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/** 参考图色板（原型样式）：按亮度五分位取均色，暗→亮一排色块。 */
function refPalette(data, bands = 5) {
  const px = [];
  for (let i = 0; i < data.length; i += 4)
    px.push([data[i], data[i + 1], data[i + 2], data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114]);
  px.sort((a, b) => a[3] - b[3]);
  const out = [];
  const seg = px.length / bands;
  for (let b = 0; b < bands; b++) {
    let r = 0, g = 0, bl = 0, n = 0;
    for (let i = Math.floor(b * seg); i < Math.floor((b + 1) * seg); i++) { r += px[i][0]; g += px[i][1]; bl += px[i][2]; n++; }
    out.push(`rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(bl / n)})`);
  }
  return out;
}

/** 参考图入库（持久化，BUG-008；恢复会话时 persist=false）。 */
async function addRefFromBlob(blob, name, pkey, persist) {
  const c = await decodeToCanvas(blob, THUMB);
  const px = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  state.refs.push({
    id: ++refSeq,
    pkey: persist ? putFile({ kind: 'ref', name, blob }) : pkey,
    url: URL.createObjectURL(blob),   // 原图 objectURL 做预览，不糊（BUG-009；统计仍走 256 缩图）
    stats: labStats(px.data),
    palette: refPalette(px.data),
  });
}

async function addRefs(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/'));
  if (!list.length) return;
  const room = REF_MAX - state.refs.length;
  if (room <= 0) { toast(`参考图最多 ${REF_MAX} 张`); return; }
  if (list.length > room) toast(`参考图最多 ${REF_MAX} 张，仅加入前 ${room} 张`);
  for (const f of list.slice(0, room)) {
    try {
      await addRefFromBlob(f, f.name, null, true);
    } catch { toast(`无法读取：${f.name}`); }
  }
  state.refView = state.refs.length - 1;   // 新增后查看最新一张
  refreshMergedRef();
  setTone({ type: 'ref' });
  syncRefUi();
}

function removeRef(id) {
  const i = state.refs.findIndex((r) => r.id === id);
  if (i < 0) return;
  if (state.refs[i].pkey) deleteFile(state.refs[i].pkey);
  URL.revokeObjectURL(state.refs[i].url);
  state.refs.splice(i, 1);
  refreshMergedRef();
  if (!state.refs.length && state.tone.type === 'ref') setTone({ type: 'none' });
  syncRefUi();
}

/** 参考图大预览（v0.11 原型样式：大图 + ‹› 切换 + 下方色板条；多张合成一个色调，无逐张权重）。 */
function syncRefUi() {
  const n = state.refs.length;
  $('ref-add').hidden = n > 0;
  $('ref-view').hidden = n === 0;
  // v1.0④：单一计数器放标题栏，显示"当前查看 / 总张数"（去掉 /20 上限与图上叠字）
  $('ref-count').textContent = n ? `${state.refView + 1} / ${n}` : '';
  if (n) {
    state.refView = Math.min(n - 1, Math.max(0, state.refView));
    const r = state.refs[state.refView];
    $('ref-big').src = r.url;
    $('ref-prev').classList.toggle('disabled', state.refView === 0);
    $('ref-next').classList.toggle('disabled', state.refView === n - 1);
    const pal = $('ref-palette');   // 色板条：当前查看那张的主色（暗→亮），跟随 ‹› 切换
    pal.innerHTML = '';
    for (const c of r.palette || []) {
      const d = document.createElement('div');
      d.style.background = c;
      pal.appendChild(d);
    }
  }
  syncPanel();
}

// ---------------------------------------------------------------- .cube 导入 / 导出（M2）

const importedCube = () => state.cubes.find((c) => c.origin === 'imported');

/** 导入 .cube（v0.10：只保留一个，再导入即替换；只有导出/下载时才进"最近"历史）。 */
async function importCubeFiles(files) {
  if (!files.length) return;
  if (files.length > 1) toast('只能导入一个 LUT 文件，已取第一个');
  const f = files[0];
  try {
    const { title, size, data } = parseCube(await f.text());
    const name = title || f.name.replace(/\.cube$/i, '');
    removeImportedCube(true);   // 替换旧导入（静默）
    const cube = {
      id: ++cubeSeq,
      origin: 'imported',
      name, size, data,
      pkey: putFile({ kind: 'icube', name, data, size }),
      lutTex: renderer.createLutTexture(data, size),
    };
    state.cubes.push(cube);
    syncCubeChip();
    setTone({ type: 'cube', id: cube.id });   // 导入即生效（用户拍板⑥）
  } catch (err) {
    toast(`导入失败 ${f.name}：${err.message}`);
  }
}

function removeImportedCube(silent) {
  const c = importedCube();
  if (!c) return;
  renderer.deleteTexture(c.lutTex);
  if (c.pkey) deleteFile(c.pkey);
  state.cubes = state.cubes.filter((x) => x.id !== c.id);
  if (state.tone.type === 'cube' && state.tone.id === c.id && !silent) setTone({ type: 'none' });
  if (!silent) syncCubeChip();
}

/** 中性渐变经色调变换生成 40×24 chip 预览。fn: (r,g,b)→[r,g,b]，值域 0..1。 */
function chipUrl(fn) {
  const c = document.createElement('canvas');
  c.width = 40; c.height = 24;
  const ctx = c.getContext('2d');
  const im = ctx.createImageData(40, 24);
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 40; x++) {
      const base = [0.15 + 0.75 * (x / 39), 0.35 + 0.4 * (x / 39) - 0.12 * (y / 23), 0.55 - 0.35 * (x / 39) + 0.1 * (y / 23)]
        .map((v) => Math.min(1, Math.max(0, v)));
      const [r, g, b] = fn(...base);
      const o = (y * 40 + x) * 4;
      im.data[o] = r * 255; im.data[o + 1] = g * 255; im.data[o + 2] = b * 255; im.data[o + 3] = 255;
    }
  ctx.putImageData(im, 0, 0);
  return c.toDataURL();
}

/** 导入名称条（原型②：显示 .cube 名称，✕ 删除）。 */
function syncCubeChip() {
  const el = $('cube-chip');
  const c = importedCube();
  el.hidden = !c;
  if (c) {
    el.dataset.id = c.id;
    el.querySelector('.name').textContent = `${c.name}.cube`;
    el.querySelector('.chip').style.backgroundImage =
      `url(${chipUrl((r, g, b) => sampleLut(c.data, c.size, r, g, b))})`;
  }
  syncPanel();
}

// ---------------------------------------------------------------- 色调历史（v0.10"最近"页签）

let histSeq = 0;

/** 历史条目的预览变换函数。 */
function histFn(h) {
  if (h.hkind === 'cube') return (r, g, b) => sampleLut(h.data, h.size, r, g, b);
  if (h.hkind === 'preset') return (r, g, b) => sampleLut(presetLutData[h.idx], LUT_SIZE, r, g, b);
  // ref：把 chip 渐变当作素材，匹配到历史目标统计（与逐图匹配同一公式）
  const gradStats = { mean: [55, 5, 5], std: [18, 8, 12] };
  const { scale, offset } = affineParams(gradStats, h.stats);
  return (r, g, b) => {
    const lab = srgbToLab(r, g, b);
    return labToSrgb(lab[0] * scale[0] + offset[0], lab[1] * scale[1] + offset[1], lab[2] * scale[2] + offset[2]);
  };
}

/** 当前色调的历史签名（去重用）。 */
function toneSig() {
  const t = state.tone;
  if (t.type === 'ref' && mergedRef)
    return 'ref:' + mergedRef.mean.concat(mergedRef.std).map((v) => v.toFixed(2)).join(',');
  if (t.type === 'preset') return `preset:${t.idx}`;
  if (t.type === 'cube') {
    const c = state.cubes.find((x) => x.id === t.id);
    return c ? `cube:${c.name}:${c.size}` : null;
  }
  return null;
}

/**
 * 导出 .cube / 下载图片成功后，把当前色调存入"最近"历史（用户拍板②）。
 * 同签名条目只刷新时间挪到最前；上限 30 条；持久化到 IndexedDB。
 */
function pushHistory() {
  const t = state.tone;
  if (t.type === 'none') return;
  const now = Date.now();
  if (t.type === 'hist') {   // 历史色调再次使用：刷新时间挪到最前
    const h = histEntry(t.hid);
    if (h) { h.time = now; if (h.pkey) updateFile(h.pkey, { time: now }); renderHistory(); }
    return;
  }
  const sig = toneSig();
  if (!sig) return;
  const dup = state.history.find((h) => h.sig === sig);
  if (dup) {
    dup.time = now;
    if (dup.pkey) updateFile(dup.pkey, { time: now });
    renderHistory();
    return;
  }
  let h = null;
  if (t.type === 'ref') {
    h = { hkind: 'ref', name: toneName(), stats: { mean: mergedRef.mean, std: mergedRef.std } };
  } else if (t.type === 'preset') {
    h = { hkind: 'preset', name: PRESETS[t.idx].name, idx: t.idx };
  } else {
    const c = state.cubes.find((x) => x.id === t.id);
    if (!c) return;
    h = { hkind: 'cube', name: c.name, size: c.size, data: c.data };
  }
  h.hid = ++histSeq;
  h.time = now;
  h.sig = sig;
  h.pkey = putFile({ kind: 'hist', hkind: h.hkind, name: h.name, time: h.time, sig,
    stats: h.stats, idx: h.idx, size: h.size, data: h.data });
  state.history.push(h);
  while (state.history.length > 30) {   // 上限：淘汰最旧
    const oldest = state.history.reduce((a, b) => (a.time < b.time ? a : b));
    removeHist(oldest.hid, true);
  }
  renderHistory();
}

function removeHist(hid, silent) {
  const h = histEntry(hid);
  if (!h) return;
  if (h.lutTex) renderer.deleteTexture(h.lutTex);
  if (h.pkey) deleteFile(h.pkey);
  state.history = state.history.filter((x) => x.hid !== hid);
  if (state.tone.type === 'hist' && state.tone.hid === hid) setTone({ type: 'none' });
  if (!silent) renderHistory();
}

/** "最近"页签：色调历史列表（时间倒序，点击复用，✕ 删除）。 */
function renderHistory() {
  const list = $('hist-list');
  list.innerHTML = '';
  const sorted = [...state.history].sort((a, b) => b.time - a.time);
  for (const h of sorted) {
    const el = document.createElement('div');
    el.className = 'cube-item hist-item';
    el.dataset.hid = h.hid;
    const chip = document.createElement('div');
    chip.className = 'chip';
    h.chipUrl = h.chipUrl || chipUrl(histFn(h));
    chip.style.backgroundImage = `url(${h.chipUrl})`;
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = h.hkind === 'cube' ? `${h.name}.cube` : h.name;
    const time = document.createElement('div');
    time.className = 'time';
    const d = new Date(h.time);
    time.textContent = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '✕'; del.title = '删除记录';
    el.onclick = () => setTone({ type: 'hist', hid: h.hid });
    del.onclick = (e) => { e.stopPropagation(); removeHist(h.hid); };
    el.append(chip, name, time, del);
    list.appendChild(el);
  }
  $('recent-empty').hidden = sorted.length > 0;
  syncPanel();
}

/**
 * 把当前色调烘焙为 3D LUT（.cube 导出与"收藏为模版"共用；M0 结论：全局变换）。
 * k = 混合强度（导出用 effectiveStrength 所见即所得；收藏用 1 = 完整模版）。
 * 返回 { data, size, name } 或 null（失败已 toast）。
 */
function bakeTone(k) {
  const t = state.tone;
  const mix = (base) => (r, g, b) => {   // identity 与变换按 k 插值（sRGB，与 shader mix 一致）
    const o = base(r, g, b);
    return [r + (o[0] - r) * k, g + (o[1] - g) * k, b + (o[2] - b) * k];
  };
  const hist = t.type === 'hist' ? histEntry(t.hid) : null;
  if (t.type === 'hist' && !hist) return null;
  const kind = hist ? hist.hkind : t.type;
  if (kind === 'ref') {
    const target = hist ? hist.stats : mergedRef;
    if (!target) { toast('参考图统计尚未就绪'); return null; }
    const withStats = state.images.filter((im) => im.stats);
    if (!withStats.length) { toast('素材统计尚未就绪'); return null; }
    const batch = mergeRefStats(withStats.map((im) => ({ stats: im.stats, weight: 1 })));
    const { scale, offset } = affineParams(batch, target);
    const data = bakeLut(mix((r, g, b) => {
      const lab = srgbToLab(r, g, b);
      return labToSrgb(lab[0] * scale[0] + offset[0], lab[1] * scale[1] + offset[1], lab[2] * scale[2] + offset[2]);
    }), LUT_SIZE);
    return { data, size: LUT_SIZE, name: hist ? hist.name : toneName() };
  }
  if (kind === 'preset') {
    const idx = hist ? hist.idx : t.idx;
    return { data: bakeLut(mix(presetTransform(PRESETS[idx])), LUT_SIZE), size: LUT_SIZE, name: PRESETS[idx].name };
  }
  const c = hist || state.cubes.find((x) => x.id === t.id);
  if (!c) return null;
  const size = c.size, data = new Uint8Array(c.data.length);
  let p = 0;
  for (let bi = 0; bi < size; bi++)
    for (let gi = 0; gi < size; gi++)
      for (let ri = 0; ri < size; ri++) {
        const idv = [ri / (size - 1) * 255, gi / (size - 1) * 255, bi / (size - 1) * 255];
        for (let ch = 0; ch < 3; ch++) { data[p] = Math.round(idv[ch] + (c.data[p] - idv[ch]) * k); p++; }
      }
  return { data, size, name: c.name };
}

/** 导出当前色调为标准 .cube（烘焙当前强度，v0.11 去掉 100%/作者选项）。 */
function exportCube() {
  const t = state.tone;
  if (t.type === 'none') { toast('请先选择一个色调（参考图 / 模版 / .cube）'); return; }
  const k = effectiveStrength();
  const baked = bakeTone(k);
  if (!baked) return;
  const { data, size, name } = baked;
  const text = serializeCube(data, size, `ToneSync ${name}`, {
    created: new Date().toISOString().slice(0, 19),
    strength: `${Math.round(k * 100)}%`,
    algorithm: 'reinhard-lab-v0',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = `tonesync_${name}.cube`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`已导出 ${a.download}`);
  pushHistory();   // v0.10：导出成功后当前色调进"最近"历史
}

/** 启动时恢复上次会话（BUG-008）。 */
async function restoreSession() {
  try {
    const files = await getAllFiles();
    if (!files.length) return;
    for (const f of files) {
      try {
        if (f.kind === 'img') await addImageFromBlob(f.blob, f.name, f.key, false);
        else if (f.kind === 'ref') await addRefFromBlob(f.blob, f.name, f.key, false);
        else if (f.kind === 'icube') {
          state.cubes.push({
            id: ++cubeSeq, origin: 'imported', pkey: f.key, name: f.name, size: f.size, data: f.data,
            lutTex: renderer.createLutTexture(f.data, f.size),
          });
        } else if (f.kind === 'fav') {   // v1.1②：收藏的色调模版
          state.cubes.push({
            id: ++cubeSeq, origin: 'fav', favOrd: f.ord ?? ++favSeq, pkey: f.key,
            name: f.name, size: f.size, data: f.data,
            lutTex: renderer.createLutTexture(f.data, f.size),
          });
        } else if (f.kind === 'hist' || f.kind === 'cube') {
          // 'cube' 为 v0.9 之前的导入记录，作为历史条目兼容读入
          state.history.push({
            hid: ++histSeq, pkey: f.key, hkind: f.hkind || 'cube', name: f.name,
            time: f.time ?? f.ord, sig: f.sig, stats: f.stats, idx: f.idx, size: f.size, data: f.data,
          });
        }
      } catch (e) { console.warn('恢复文件失败：', f.name, e); }
    }
    refreshMergedRef();
    syncRefUi();
    syncCubeChip();
    renderHistory();
    renderFavs();
    const ui = await getKV('ui');
    if (ui) {
      state.strength = ui.strength ?? 70;
      $('strength').value = state.strength;
      $('strength-val').textContent = `${state.strength}%`;
      state.split = ui.split ?? 50;
      state.compareOn = ui.compareOn ?? true;
      $('cmp-toggle').classList.toggle('on', state.compareOn);
      state.selected = Math.min(ui.selected ?? 0, Math.max(0, state.images.length - 1));
      state.refView = Math.min(ui.refView ?? 0, Math.max(0, state.refs.length - 1));
      if (ui.panelW) setPanelWidth(ui.panelW);
      setCubeTab(ui.cubeTab || 'common');
      const t = ui.tone || {};
      if (t.type === 'preset' && t.idx != null) state.tone = { type: 'preset', idx: t.idx };
      else if (t.type === 'ref' && state.refs.length) state.tone = { type: 'ref' };
      else if ((t.type === 'cube' || t.type === 'hist') && t.cubeKey) {
        const key = String(t.cubeKey);
        if (key.startsWith('asset:')) {
          const c = state.cubes.find((x) => x.asset === key.slice(6));
          if (c) state.tone = { type: 'cube', id: c.id };
        } else if (key.startsWith('fav:')) {
          const c = state.cubes.find((x) => x.origin === 'fav' && x.pkey === key.slice(4));
          if (c) state.tone = { type: 'cube', id: c.id };
        } else if (key === 'imported') {
          const c = importedCube();
          if (c) state.tone = { type: 'cube', id: c.id };
        } else {
          const pk = key.startsWith('hist:') ? key.slice(5) : key;   // 兼容 v0.9 直接存 pkey
          const h = state.history.find((x) => x.pkey === pk);
          if (h) state.tone = { type: 'hist', hid: h.hid };
        }
      }
      state.prevTone = state.tone;   // 恢复时不播 crossfade
      if (ui.mode === 'wall') {
        state.mode = 'wall';
        canvas.classList.add('wall');
      }
    }
    syncRefUi();
    syncPanel();
    if (state.images.length) enterWorkspace();
    invalidate();
  } catch (e) { console.warn('恢复会话失败：', e); }
}

/**
 * 下载图片（v0.10 双模式，原型④）：
 * - 单图视图：下载当前查看的这张（直接下载，保持原文件名/格式）
 * - 宫格视图：下载选中（紫框多选）的素材——多于 1 张时 Chrome/Edge 走
 *   File System Access 写入所选目录，否则打包 ZIP（store）下载
 */
let exportRenderer = null, exportCanvas = null, exportingImgs = false;

function downloadList() {
  if (state.mode === 'wall') return state.images.filter((im) => state.wallSel.has(im.id));
  return state.images[state.selected] ? [state.images[state.selected]] : [];
}

async function exportImages() {
  const list = downloadList();
  if (exportingImgs || !list.length) return;
  exportingImgs = true;
  const btn = $('btn-export-imgs');
  const label = btn.textContent;
  try {
    let dir = null;
    if (list.length > 1 && typeof window.showDirectoryPicker === 'function') {
      try {
        dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (e) {
        if (e.name === 'AbortError') return;   // 用户取消选目录
      }
    }
    if (!exportRenderer) {
      exportCanvas = document.createElement('canvas');
      exportRenderer = new Renderer(exportCanvas);
    }
    const er = exportRenderer;
    const k = effectiveStrength();
    const t = state.tone;
    const hist = t.type === 'hist' ? histEntry(t.hid) : null;
    // 逐图匹配的目标统计（ref / 历史 ref），或全局 LUT
    const refTarget = t.type === 'ref' ? mergedRef : (hist && hist.hkind === 'ref' ? hist.stats : null);
    let tmpLut = null;
    if (t.type === 'preset') tmpLut = er.createLutTexture(presetLutData[t.idx], LUT_SIZE);
    else if (t.type === 'cube') {
      const c = state.cubes.find((x) => x.id === t.id);
      if (c) tmpLut = er.createLutTexture(c.data, c.size);
    } else if (hist) {
      if (hist.hkind === 'preset') tmpLut = er.createLutTexture(presetLutData[hist.idx], LUT_SIZE);
      else if (hist.hkind === 'cube') tmpLut = er.createLutTexture(hist.data, hist.size);
    }
    const zipEntries = [];
    const used = new Set();
    let single = null;
    for (let i = 0; i < list.length; i++) {
      const img = list[i];
      btn.textContent = `导出中 ${i + 1} / ${list.length}…`;
      const bmp = await createImageBitmap(img.file);
      exportCanvas.width = bmp.width;
      exportCanvas.height = bmp.height;
      er.resize(bmp.width, bmp.height, 1);
      const tex = er.createImageTexture(bmp);
      let tone = IDENTITY_TONE;
      if (refTarget && img.stats) {
        const { scale, offset } = affineParams(img.stats, refTarget);
        tone = { mode: 1, scale, offset, lut: null };
      } else if (tmpLut) {
        tone = { mode: 2, scale: [1, 1, 1], offset: [0, 0, 0], lut: tmpLut };
      }
      er.clear();
      er.drawImage(tex, { x: 0, y: 0, w: bmp.width, h: bmp.height }, { toneB: tone, lerp: 1, strength: k });
      const ext = (img.name.match(/\.(\w+)$/) || [, 'jpg'])[1].toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      const blob = await new Promise((r) => exportCanvas.toBlob(r, mime, 0.92));
      er.deleteTexture(tex);
      bmp.close();
      let name = img.name, n = 1;
      while (used.has(name)) name = img.name.replace(/(\.\w+)?$/, `_${n++}$1`);
      used.add(name);
      if (list.length === 1) single = { name, blob };
      else if (dir) {
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
      } else {
        zipEntries.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
      }
    }
    if (tmpLut) er.deleteTexture(tmpLut);
    if (single) {   // 单张：直接下载原名文件
      const a = document.createElement('a');
      a.href = URL.createObjectURL(single.blob);
      a.download = single.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 8000);
      toast(`已下载 ${single.name}`);
    } else if (!dir) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(makeZip(zipEntries));
      a.download = 'tonesync_export.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 8000);
      toast(`已导出 ${list.length} 张图片（ZIP 包）`);
    } else {
      toast(`已导出 ${list.length} 张图片到所选目录`);
    }
    pushHistory();   // v0.10：下载成功后当前色调进"最近"历史
  } catch (e) {
    console.error(e);
    toast(`下载失败：${e.message}`);
  } finally {
    exportingImgs = false;
    btn.textContent = label;
    syncPanel();
  }
}

// ---------------------------------------------------------------- 布局与绘制

function stageSize() {
  const r = stage.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

function currentToneLerp(now) {
  return easeOut(Math.min(1, (now - state.toneChangedAt) / TONE_FADE));
}

function drawParams(img, now) {
  return {
    toneA: toneDescriptor(state.prevTone, img),
    toneB: toneDescriptor(state.tone, img),
    lerp: currentToneLerp(now),
    strength: effectiveStrength(),
  };
}

function fitRect(aspect, box) {
  const s = Math.min(box.w / aspect, box.h);
  const w = s * aspect, h = s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** cover 裁切的 uv 窗口 */
function coverUv(aspect, cellAspect) {
  if (aspect > cellAspect) { const w = cellAspect / aspect; return { x: (1 - w) / 2, y: 0, w, h: 1 }; }
  const h = aspect / cellAspect;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

let stripRects = [], wallRects = [];

function stripLayout(viewW, viewH) {
  stripRects = [];
  const y = viewH - STRIP_H + (STRIP_H - CELL_H) / 2;
  let x = 22 - state.stripScroll;
  for (let i = 0; i < state.images.length; i++) {
    stripRects.push({ x, y, w: CELL_W, h: CELL_H, i });
    x += CELL_W + CELL_GAP;
  }
  stripRects.push({ x, y, w: CELL_H, h: CELL_H, i: -1 });   // 优化②：添加素材 ＋ 格子
  x += CELL_H + CELL_GAP;
  window.__rects = { strip: stripRects, wall: wallRects };  // 供自动化测试
  return { totalW: x + state.stripScroll, y };
}

function stripTotalW() {
  return 22 * 2 + state.images.length * (CELL_W + CELL_GAP) + CELL_H;
}

function wallLayout(viewW, viewH) {
  wallRects = [];
  const pad = 22, padTop = TOP_PAD, gap = 10, targetW = 172;
  const cols = Math.max(2, Math.floor((viewW - pad * 2 + gap) / (targetW + gap)));
  const cw = (viewW - pad * 2 - gap * (cols - 1)) / cols;
  const ch = cw * 2 / 3;
  for (let i = 0; i < state.images.length; i++) {
    const col = i % cols, row = Math.floor(i / cols);
    wallRects.push({ x: pad + col * (cw + gap), y: padTop + row * (ch + gap) - state.wallScroll, w: cw, h: ch, i });
  }
  return { rows: Math.ceil(state.images.length / cols), ch, gap, pad, padTop };
}

function wallContentH(viewH) {
  const { rows, ch, gap, pad, padTop } = wallLayout(stageSize().w, viewH);
  return padTop + pad + rows * (ch + gap) - gap;
}

function draw(now) {
  const { w, h } = stageSize();
  if (w !== renderer.viewW || h !== renderer.viewH) renderer.resize(w, h, devicePixelRatio || 1);
  renderer.clear();
  if (!state.images.length) return;

  const lerpActive = now - state.toneChangedAt < TONE_FADE;
  const wallT = easeOut(Math.min(1, (now - state.wallEnterAt) / WALL_ANIM));

  if (state.mode === 'single') {
    const img = state.images[state.selected];
    const box = { x: 24, y: TOP_PAD, w: w - 48, h: h - STRIP_H - TOP_PAD - 8 };
    let rect = fitRect(img.aspect, box);
    // 优化③：默认留白 + 缩放/平移（以矩形中心为基准）
    const cx = rect.x + rect.w / 2 + state.panX, cy = rect.y + rect.h / 2 + state.panY;
    const zw = rect.w * FIT * state.zoom, zh = rect.h * FIT * state.zoom;
    rect = { x: cx - zw / 2, y: cy - zh / 2, w: zw, h: zh };
    state._imgRect = rect;
    // BUG-003：分屏按图片"可视部分"定位，缩放/移动后分割线始终留在画布内可操作
    const vx0 = Math.max(rect.x, 0), vx1 = Math.min(rect.x + rect.w, w);
    state._vis = vx1 > vx0 + 2 ? { x0: vx0, x1: vx1 } : null;
    const params = drawParams(img, now);
    // BUG-005：单图内容裁剪到胶片条上沿以内，放大后不侵入胶片条区（与分屏线下沿一致）
    renderer.setClip(0, 0, w, h - STRIP_H);
    window.__clip = [0, 0, w, h - STRIP_H];   // 回归 case 标记
    renderer.drawImage(img.fullTex || img.thumbTex, rect, params);
    // 分屏对比——左侧再画一遍原图（strength=0），按可视区 split 裁切
    if (compareActive() && state._vis) {
      const bx = state._vis.x0 + (state._vis.x1 - state._vis.x0) * (state.split / 100);
      const u = Math.min(1, Math.max(0, (bx - rect.x) / rect.w));
      state._splitX = bx;
      renderer.drawImage(img.fullTex || img.thumbTex,
        { x: rect.x, y: rect.y, w: rect.w * u, h: rect.h },
        { ...params, strength: 0, uvRect: { x: 0, y: 0, w: u, h: 1 } });
    }
    renderer.clearClip();
    ensureFullTex(img);

    // 底部胶片条
    stripLayout(w, h);
    for (const r of stripRects) {
      if (r.x + r.w < 0 || r.x > w) continue;
      if (r.i === -1) {   // 添加素材 ＋ 格子（虚线边框，BUG-002；v1.0⑤：hover 变紫，同参考图上传框）
        const hovered = state._plusHover;
        const line = hovered ? [0.42, 0.36, 0.9, 1] : [0.24, 0.24, 0.28, 1];
        const plus = hovered ? [0.55, 0.5, 0.95, 1] : [0.42, 0.42, 0.47, 1];
        drawDashedRect(r, line);
        renderer.drawRect({ x: r.x + r.w / 2 - 7, y: r.y + r.h / 2 - 1, w: 14, h: 2 }, plus);
        renderer.drawRect({ x: r.x + r.w / 2 - 1, y: r.y + r.h / 2 - 7, w: 2, h: 14 }, plus);
        window.__plusStyle = 'dashed';   // 回归 case 标记（BUG-002）
        window.__plusColor = hovered ? 'purple' : 'gray';   // 回归 case 标记（v1.0⑤）
        continue;
      }
      const im = state.images[r.i];
      if (r.i === state.selected) drawSel(r);
      renderer.drawImage(im.thumbTex, r, {
        ...drawParams(im, now),
        alpha: r.i === state.selected ? 1 : 0.72,
        uvRect: coverUv(im.aspect, CELL_W / CELL_H),
      });
    }
  } else {
    // 网格墙：入场动效 = 从胶片条位置飞入网格位（PRD §5.2）
    wallLayout(w, h);
    stripLayout(w, h + 0);
    for (const r of wallRects) {
      if (r.y + r.h < 0 || r.y > h) continue;
      const im = state.images[r.i];
      let rect = r;
      if (wallT < 1) {
        const from = stripRects[r.i]
          ? { ...stripRects[r.i], y: h - STRIP_H + (STRIP_H - CELL_H) / 2 }
          : { x: w / 2, y: h + 40, w: CELL_W, h: CELL_H };
        rect = {
          x: from.x + (r.x - from.x) * wallT, y: from.y + (r.y - from.y) * wallT,
          w: from.w + (r.w - from.w) * wallT, h: from.h + (r.h - from.h) * wallT,
        };
      }
      // v0.10 宫格多选：选中的素材紫框（细核心+外发光，v1.0⑤）
      if (state.wallSel.has(im.id) && wallT >= 1) drawSel(rect);
      renderer.drawImage(im.thumbTex, rect, {
        ...drawParams(im, now),
        alpha: state.wallSel.size && !state.wallSel.has(im.id) ? 0.55 : 1,
        uvRect: coverUv(im.aspect, r.w / r.h),
      });
    }
  }

  if (lerpActive || wallT < 1) invalidate();
}

function invalidate() { dirty = true; saveUi(); }

/** 界面状态持久化（BUG-008）：任何可视变化后 300ms 防抖落盘。 */
let uiTimer = null;
let uiReady = false;   // 恢复完成前禁止落盘，避免默认值覆盖存档（竞态）
function saveUi() {
  if (!uiReady) return;
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    const t = state.tone;
    let cubeKey;
    if (t.type === 'cube') {
      const c = state.cubes.find((x) => x.id === t.id);
      cubeKey = c ? (c.asset ? `asset:${c.asset}` : c.origin === 'fav' ? `fav:${c.pkey}` : 'imported') : undefined;
    } else if (t.type === 'hist') {
      const h = histEntry(t.hid);
      cubeKey = h && h.pkey ? `hist:${h.pkey}` : undefined;
    }
    setKV('ui', {
      strength: state.strength, split: state.split, compareOn: state.compareOn,
      mode: state.mode, cubeTab: state.cubeTab, panelW: state.panelW,
      selected: state.selected, refView: state.refView,
      tone: { type: t.type, idx: t.idx, cubeKey },
    });
  }, 300);
}

function compareActive() {
  return state.mode === 'single' && state.compareOn && state.tone.type !== 'none' && state.images.length > 0;
}

/**
 * 素材选中态：细核心紫线 + 向外淡出的紫色辉光（v1.0⑤，胶片条当前张 / 宫格多选共用）。
 * 同心半透明矩形叠加：贴着缩略图约 1.2px 近实心，向外 6px 渐隐——比旧的 2px 实心块更细、更高级。
 */
const SEL_PURPLE = [0.46, 0.40, 0.96];
function drawSel(r) {
  const ring = (m, a) => renderer.drawRect(
    { x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 }, [...SEL_PURPLE, a]);
  ring(6, 0.09); ring(4, 0.15); ring(2.5, 0.30); ring(1.2, 0.95);
  window.__selStyle = 'glow';   // 回归 case 标记（v1.0⑤：细核心+外发光，非旧的单层实心块）
}

/** 虚线矩形边框（短段矩形拼接，BUG-002） */
function drawDashedRect(r, color, dash = 5, gap = 4, t = 1) {
  for (let x = r.x; x < r.x + r.w; x += dash + gap) {
    const w = Math.min(dash, r.x + r.w - x);
    renderer.drawRect({ x, y: r.y, w, h: t }, color);
    renderer.drawRect({ x, y: r.y + r.h - t, w, h: t }, color);
  }
  for (let y = r.y; y < r.y + r.h; y += dash + gap) {
    const h = Math.min(dash, r.y + r.h - y);
    renderer.drawRect({ x: r.x, y, w: t, h }, color);
    renderer.drawRect({ x: r.x + r.w - t, y, w: t, h }, color);
  }
}

function frame(now) {
  if (dirty) {
    dirty = false;
    try {
      if (window.__forceDrawError) { window.__forceDrawError = false; throw new Error('测试注入'); }
      draw(now);
      syncOverlays();
    } catch (err) {
      // 单帧异常不杀死渲染循环（BUG-007：曾因缓存新旧模块错配抛错导致画布永久空白）
      console.error('渲染异常：', err);
      if (!state._drawErrToasted) {
        state._drawErrToasted = true;
        toast(`渲染异常：${err.message} —— 刷新页面即可恢复，工作区已自动保存`);
      }
    }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- UI 同步

function enterWorkspace() {
  state.importView = false;
  $('empty').hidden = true;
  stage.hidden = false;
  $('panel').hidden = !state.panelOpen;
  $('rail').hidden = false;
  invalidate();
}

/** 优化①：点击 logo 返回批量上传素材/参考图界面 */
function showImport() {
  state.importView = true;
  $('empty').hidden = false;
  stage.hidden = true;
  $('panel').hidden = true;
  $('rail').hidden = true;
  $('btn-back').hidden = !state.images.length;
  $('btn-clear').hidden = !(state.images.length || state.refs.length || importedCube() || state.history.length);
}

function syncOverlays() {
  const single = state.mode === 'single';
  $('nav-prev').classList.toggle('disabled', !single || state.selected === 0);
  $('nav-next').classList.toggle('disabled', !single || state.selected >= state.images.length - 1);
  $('counter').textContent = state.images.length
    ? (single ? `${state.selected + 1} / ${state.images.length}` : `${state.images.length} 张`) : '';
  $('ico-wall').hidden = !single;
  $('ico-single').hidden = single;

  // bug1：图片名称贴在图片矩形内左上角（跟随缩放/平移，出画布则收边）
  const name = $('img-name');
  const r = state._imgRect;
  if (single && r && state.images[state.selected]) {
    const { w, h } = stageSize();
    name.textContent = state.images[state.selected].name;
    name.style.left = `${Math.min(Math.max(r.x + 8, 8), w - 60)}px`;
    name.style.top = `${Math.min(Math.max(r.y + 6, TOP_PAD - 44), h - STRIP_H - 24)}px`;
    name.hidden = false;
  } else name.hidden = true;

  // 分屏对比条与标签跟随图片可视区（BUG-003）
  const on = compareActive() && r && state._vis;
  $('split-bar').hidden = !on;
  $('cmp-l').hidden = !on;
  $('cmp-r').hidden = !on;
  if (on) {
    const sx = state._splitX;
    const bar = $('split-bar');
    bar.style.left = `${sx}px`;
    bar.style.top = `${Math.max(r.y, 0)}px`;
    bar.style.height = `${Math.min(r.y + r.h, stageSize().h - STRIP_H) - Math.max(r.y, 0)}px`;
    const by = Math.min(r.y + r.h, stageSize().h - STRIP_H) - 28;
    $('cmp-l').style.left = `${Math.max(r.x, 0) + 8}px`;
    $('cmp-l').style.top = `${by}px`;
    $('cmp-r').textContent = `调色后 · ${toneName()}`;
    $('cmp-r').style.top = `${by}px`;
    const rr = $('cmp-r');
    rr.style.left = '';
    rr.style.right = `${Math.max(stageSize().w - (r.x + r.w), 0) + 8}px`;
  }
}

function syncPanel() {
  const t = state.tone;
  document.querySelectorAll('.lut-card.preset').forEach((el, i) =>
    el.classList.toggle('active', t.type === 'preset' && t.idx === i));
  $('ref-main').classList.toggle('active', t.type === 'ref');
  document.querySelectorAll('#cube-chip, .builtin-card, .fav-card').forEach((el) =>
    el.classList.toggle('active', t.type === 'cube' && +el.dataset.id === t.id));
  document.querySelectorAll('.hist-item').forEach((el) =>
    el.classList.toggle('active', t.type === 'hist' && +el.dataset.hid === t.hid));
  $('strength-sec').classList.toggle('dim', t.type === 'none');
  $('cmp-sec').classList.toggle('dim', t.type === 'none');
  $('btn-export-cube').disabled = t.type === 'none';
  // 下载按钮：单图=下载当前；宫格按选中数切换（v0.11⑦）：0=置灰，1=「下载图片」直下，≥2=「批量下载图片（n）」
  const dbtn = $('btn-export-imgs');
  if (!exportingImgs) {
    if (state.mode === 'wall') {
      const n = state.wallSel.size;
      dbtn.textContent = n >= 2 ? `批量下载图片（${n}）` : '下载图片';
      dbtn.disabled = n === 0;
    } else {
      dbtn.textContent = '下载图片';
      dbtn.disabled = !state.images.length;
    }
  }
}

/** 评审⑩：删除素材 */
function removeImage(i) {
  const [img] = state.images.splice(i, 1);
  if (!img) return;
  if (img.pkey) deleteFile(img.pkey);
  renderer.deleteTexture(img.thumbTex);
  renderer.deleteTexture(img.fullTex);
  state.wallSel.delete(img.id);
  syncPanel();
  $('thumb-del').hidden = true;
  if (!state.images.length) {
    state.selected = 0;
    showImport();
    return;
  }
  if (state.selected >= state.images.length) state.selected = state.images.length - 1;
  else if (i < state.selected) state.selected--;
  invalidate();
}

function select(i) {
  state.selected = Math.min(state.images.length - 1, Math.max(0, i));
  state.zoom = 1; state.panX = 0; state.panY = 0;   // 切图复位缩放
  // 胶片条跟随居中
  const { w } = stageSize();
  const target = 22 + state.selected * (CELL_W + CELL_GAP) + CELL_W / 2 - w / 2;
  state.stripScroll = Math.max(0, Math.min(Math.max(0, stripTotalW() - w), target));
  invalidate();
}

const PANEL_MIN = 296, PANEL_MAX = 460;   // v1.1③：宽度区间（296≈3 列，>384≈4 列）
function setPanelWidth(w) {
  state.panelW = Math.round(Math.max(PANEL_MIN, Math.min(PANEL_MAX, w)));
  $('panel').style.width = `${state.panelW}px`;
  invalidate();   // stage 宽变化 → ResizeObserver 触发重绘
}

function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  if (mode === 'wall') state.wallEnterAt = performance.now();
  canvas.classList.toggle('wall', mode === 'wall');
  syncPanel();   // v0.10：下载按钮随视图切换 下载图片 / 批量下载图片
  invalidate();
}

// ---------------------------------------------------------------- 事件

function bindEvents() {
  $('btn-upload').onclick = () => $('file-input').click();
  $('rail-add').onclick = () => $('file-input').click();
  $('file-input').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };

  $('btn-demo').onclick = loadDemo;
  $('home').onclick = showImport;
  $('btn-back').onclick = enterWorkspace;
  $('btn-clear').onclick = async () => { await clearAll(); location.reload(); };
  $('btn-upload-ref').onclick = () => $('ref-input').click();

  // 合并入口（v0.11）：一个模块同时接受参考图与 .cube（图片=参考图，.cube=LUT）
  const importToneFiles = async (files) => {
    const all = [...files];
    const cubes = all.filter((f) => /\.cube$/i.test(f.name));
    const imgs = all.filter((f) => f.type.startsWith('image/'));
    if (cubes.length) await importCubeFiles(cubes);
    if (imgs.length) {
      await addRefs(imgs);
      if (state.importView && state.images.length) enterWorkspace();
    }
  };
  $('ref-add').onclick = () => $('tone-input').click();
  $('tone-input').onchange = async (e) => { await importToneFiles(e.target.files); e.target.value = ''; };
  $('ref-input').onchange = async (e) => {   // 空状态"上传参考图"入口仍走纯图片选择
    if (e.target.files.length) {
      await addRefs(e.target.files);
      if (state.importView && state.images.length) enterWorkspace();
    }
    e.target.value = '';
  };
  // 参考图大预览：点击应用色调；‹› 切换查看；＋ 追加参考图/.cube；✕ 删除当前查看的这张
  $('ref-main').onclick = () => { if (state.refs.length) setTone({ type: 'ref' }); };
  $('ref-prev').onclick = (e) => { e.stopPropagation(); state.refView--; syncRefUi(); };
  $('ref-next').onclick = (e) => { e.stopPropagation(); state.refView++; syncRefUi(); };
  $('ref-append').onclick = (e) => { e.stopPropagation(); $('tone-input').click(); };
  $('ref-del').onclick = (e) => {
    e.stopPropagation();
    const r = state.refs[state.refView];
    if (r) removeRef(r.id);
  };

  // 导入 .cube 名称条（模块内，v0.11）
  $('cube-chip').onclick = () => {
    const c = importedCube();
    if (c) setTone({ type: 'cube', id: c.id });
  };
  $('cube-chip').querySelector('.del').onclick = (e) => { e.stopPropagation(); removeImportedCube(false); };
  $('btn-export-cube').onclick = exportCube;
  $('btn-export-imgs').onclick = exportImages;
  document.querySelectorAll('#cube-tabs button').forEach((b) => {
    b.onclick = () => setCubeTab(b.dataset.tab);
  });
  $('rail-tone').onclick = () => { if (!state.panelOpen) togglePanel(); };   // v0.10 合并单页图标

  $('strength').oninput = (e) => {
    state.strength = +e.target.value;
    $('strength-val').textContent = `${state.strength}%`;
    invalidate();
  };
  $('btn-reset').onclick = () => {
    state.strength = 70;
    $('strength').value = 70;
    $('strength-val').textContent = '70%';
    setTone({ type: 'none' });
  };

  const togglePanel = () => {
    state.panelOpen = !state.panelOpen;
    $('panel').hidden = !state.panelOpen;
    $('rail-panel').classList.toggle('on', state.panelOpen);
    invalidate();
  };
  $('rail-panel').onclick = togglePanel;
  $('rail-panel').classList.add('on');
  $('btn-fav').onclick = favoriteTone;                                    // v1.1②：收藏当前色调为模版
  $('btn-manual').onclick = () => toast('手动调色即将上线');               // v1.1①：占位（功能后续）

  // v1.1③：拖动面板左缘调宽（卡片网格 auto-fill 自适应列数），松手落盘
  const rz = $('panel-resize');
  rz.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.style.cursor = 'col-resize';   // 拖动时保持 col-resize 光标（只显示图标，无紫色条）
    const startX = e.clientX, startW = state.panelW;
    const move = (ev) => setPanelWidth(startW + (startX - ev.clientX));   // 向左拖 = 变宽
    const up = () => {
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      saveUi();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  $('view-toggle').onclick = () => setMode(state.mode === 'single' ? 'wall' : 'single');
  $('nav-prev').onclick = () => select(state.selected - 1);
  $('nav-next').onclick = () => select(state.selected + 1);

  // 画布点击：胶片条（含 ＋ 添加素材）/ 墙上格子
  // v0.10：宫格单击 = 多选切换（批量下载，紫框）；双击 = 打开单图
  canvas.addEventListener('click', (e) => {
    if (state._panMoved) { state._panMoved = false; return; }
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const hits = state.mode === 'single' ? stripRects : wallRects;
    for (const c of hits) {
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) {
        if (c.i === -1) { $('file-input').click(); return; }   // 优化②
        if (state.mode === 'wall') {
          const im = state.images[c.i];
          if (state.wallSel.has(im.id)) state.wallSel.delete(im.id);
          else state.wallSel.add(im.id);
          syncPanel();
          invalidate();
        } else select(c.i);
        return;
      }
    }
  });
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    canvas.classList.toggle('strip-hover',
      state.mode === 'wall' || (state.mode === 'single' && y > r.height - STRIP_H));
    // 评审⑩：悬停素材格子时在其右上角显示删除按钮
    const hits = state.mode === 'single' ? stripRects : wallRects;
    const del = $('thumb-del');
    const cell = hits.find((c) => c.i >= 0 && x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
    if (cell) {
      state._delIdx = cell.i;
      del.style.left = `${cell.x + cell.w - 24}px`;
      del.style.top = `${cell.y + 4}px`;
      del.hidden = false;
    } else if (e.target === canvas) del.hidden = true;
    // v1.0⑤：悬停"＋添加素材"格子时其虚线变紫
    const plus = stripRects.find((c) => c.i === -1);
    const onPlus = state.mode === 'single' && plus && x >= plus.x && x <= plus.x + plus.w && y >= plus.y && y <= plus.y + plus.h;
    if (!!state._plusHover !== onPlus) { state._plusHover = onPlus; invalidate(); }
  });
  $('thumb-del').onclick = (e) => {
    e.stopPropagation();
    removeImage(state._delIdx);
  };
  $('thumb-del').onmouseleave = (e) => {
    if (e.relatedTarget !== canvas) $('thumb-del').hidden = true;
  };

  // 单图拖拽平移：侧边栏打开时只允许缩放，关闭时支持缩放和自由移动（2026-07-18 评审①）
  canvas.addEventListener('mousedown', (e) => {
    if (state.mode !== 'single' || state.panelOpen) return;
    const r = canvas.getBoundingClientRect();
    if (e.clientY - r.top > r.height - STRIP_H) return;   // 胶片条区不平移
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, px = state.panX, py = state.panY;
    const move = (ev) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) state._panMoved = true;
      state.panX = px + ev.clientX - sx;
      state.panY = py + ev.clientY - sy;
      invalidate();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      // 若拖拽在画布外松手不会触发 click，兜底清理标志，避免吞掉下一次画布点击
      setTimeout(() => { state._panMoved = false; }, 0);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  canvas.addEventListener('dblclick', (e) => {
    if (state.mode === 'wall') {   // v0.10：双击宫格素材打开单图（单击留给多选）
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const cell = wallRects.find((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
      if (cell) { select(cell.i); setMode('single'); }
      return;
    }
    state.zoom = 1; state.panX = 0; state.panY = 0;
    invalidate();
  });

  // 滚轮：单图图片区=缩放（以鼠标为中心）；胶片条区=横滚；墙=纵滚
  // 挂在 stage 容器上，避免分屏手柄/边缘导航等覆盖层挡住滚轮（BUG-006）
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { w, h } = stageSize();
    const rb = canvas.getBoundingClientRect();
    const my = e.clientY - rb.top, mx = e.clientX - rb.left;
    if (state.mode === 'single') {
      if (my > h - STRIP_H) {   // 胶片条：横滚
        state.stripScroll = Math.max(0, Math.min(Math.max(0, stripTotalW() - w),
          state.stripScroll + e.deltaY + e.deltaX));
      } else {                  // 图片区：缩放（优化③）
        const z0 = state.zoom;
        const z1 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z0 * Math.exp(-e.deltaY * 0.0022)));
        if (z1 !== z0 && state._imgRect) {
          const r = state._imgRect;
          const cx = r.x + r.w / 2, cy = r.y + r.h / 2;   // 当前中心
          const k = z1 / z0;
          state.panX += (cx - mx) * (k - 1);
          state.panY += (cy - my) * (k - 1);
          state.zoom = z1;
        }
      }
    } else {
      state.wallScroll = Math.max(0, Math.min(Math.max(0, wallContentH(h) - h),
        state.wallScroll + e.deltaY));
    }
    invalidate();
  }, { passive: false });

  // 优化⑤：分屏对比拖动 + 开关
  $('split-bar').addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const move = (ev) => {
      const v = state._vis;
      if (!v) return;
      const rb = canvas.getBoundingClientRect();
      // 按可视区计算，可滑到可视边界（BUG-003 修正后语义）
      state.split = Math.min(100, Math.max(0, (ev.clientX - rb.left - v.x0) / (v.x1 - v.x0) * 100));
      invalidate();
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  $('cmp-toggle').onclick = () => {
    state.compareOn = !state.compareOn;
    $('cmp-toggle').classList.toggle('on', state.compareOn);
    invalidate();
  };
  $('cmp-toggle').classList.toggle('on', state.compareOn);

  // 键盘左右切换
  window.addEventListener('keydown', (e) => {
    if (state.mode !== 'single' || !state.images.length) return;
    if (e.key === 'ArrowLeft') select(state.selected - 1);
    if (e.key === 'ArrowRight') select(state.selected + 1);
  });

  // 全屏拖放（拖到参考图区 = 参考图，其余 = 素材）
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) $('dropzone').hidden = false; });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth === 0) $('dropzone').hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').hidden = true;
    const all = [...e.dataTransfer.files];
    const cubeFiles = all.filter((f) => /\.cube$/i.test(f.name));
    if (cubeFiles.length) importCubeFiles(cubeFiles);       // .cube 拖到任意位置均可导入
    const imgs = all.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    const onRef = e.target.closest && e.target.closest('#ref-sec');
    if (onRef) addRefs(imgs);                               // 拖到参考图区 = 参考图
    else addFiles(imgs);
  });

  new ResizeObserver(invalidate).observe(stage);
}

// ---------------------------------------------------------------- 模版 UI 与示例图

let presetLutData = [];   // 烘焙数据（导出与垫图卡片共用）
let baseImg = null;       // 垫图 ImageData（v0.9，shot_moavmn8h 缩图）

function buildPresets() {
  PRESETS.forEach((p, i) => {
    presetLutData[i] = bakeLut(presetTransform(p), LUT_SIZE);
    presetLuts[i] = renderer.createLutTexture(presetLutData[i], LUT_SIZE);
  });
}

/** 加载垫图（失败则卡片降级为渐变底）。 */
async function loadBase() {
  try {
    const blob = await (await fetch('assets/base.jpg')).blob();
    const bmp = await createImageBitmap(blob);
    const w = 256, h = Math.round(256 * bmp.height / bmp.width);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    baseImg = ctx.getImageData(0, 0, w, h);
    bmp.close();
  } catch (e) { console.warn('垫图加载失败：', e); }
}

/** 垫图经 LUT 三线性采样生成卡片缩略图（newwow 样式，v0.9）。 */
function cardThumbUrl(lutData, size) {
  if (!baseImg) return null;
  const { width: w, height: h } = baseImg;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const im = ctx.createImageData(w, h);
  const s = baseImg.data, d = im.data;
  for (let i = 0; i < s.length; i += 4) {
    const [r, g, b] = sampleLut(lutData, size, s[i] / 255, s[i + 1] / 255, s[i + 2] / 255);
    d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255; d[i + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  return c.toDataURL('image/jpeg', 0.85);
}

function lutCardEl(name, lutData, size, extraClass, onPick, onDelete) {
  const el = document.createElement('div');
  el.className = `lut-card ${extraClass}`;
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const url = cardThumbUrl(lutData, size);
  if (url) thumb.style.backgroundImage = `url(${url})`;
  else thumb.style.background = 'linear-gradient(135deg,#3A3A44,#1E1E26)';
  const label = document.createElement('div');
  label.className = 'cname';
  label.textContent = name;
  el.append(thumb, label);
  el.onclick = onPick;
  if (onDelete) {   // 收藏卡片悬停显示 ✕（用户创建，可删除；静默不改变休止态外观）
    const del = document.createElement('button');
    del.className = 'card-del'; del.textContent = '✕'; del.title = '删除收藏';
    del.onclick = (e) => { e.stopPropagation(); onDelete(); };
    el.appendChild(del);
  }
  return el;
}

// ---------------------------------------------------------------- 收藏为模版（v1.1）

let favSeq = 0;

/** 收藏当前色调为模版：烘焙 100% 完整色调（含手动调色时烘焙其结果）→ 收藏 tab 垫图卡片，持久化。 */
function favoriteTone() {
  if (state.tone.type === 'none') { toast('请先选择一个色调再收藏'); return; }
  const baked = bakeTone(1);   // 收藏 = 完整模版（100%），与内置模版一致，强度滑杆再叠加
  if (!baked) return;
  const cube = {
    id: ++cubeSeq, origin: 'fav', favOrd: ++favSeq,
    name: baked.name || '自定义色调', size: baked.size, data: baked.data,
    pkey: putFile({ kind: 'fav', name: baked.name, data: baked.data, size: baked.size, ord: ++favSeq }),
    lutTex: renderer.createLutTexture(baked.data, baked.size),
  };
  state.cubes.push(cube);
  renderFavs();
  setCubeTab('fav');
  toast(`已收藏「${cube.name}」为模版`);
}

function removeFav(id) {
  const c = state.cubes.find((x) => x.id === id);
  if (!c) return;
  renderer.deleteTexture(c.lutTex);
  if (c.pkey) deleteFile(c.pkey);
  state.cubes = state.cubes.filter((x) => x.id !== id);
  if (state.tone.type === 'cube' && state.tone.id === id) setTone({ type: 'none' });
  renderFavs();
}

function renderFavs() {
  const grid = $('favs');
  grid.innerHTML = '';
  const favs = state.cubes.filter((x) => x.origin === 'fav').sort((a, b) => (a.favOrd || 0) - (b.favOrd || 0));
  for (const c of favs) {
    const el = lutCardEl(c.name, c.data, c.size, 'fav-card',
      () => setTone({ type: 'cube', id: c.id }), () => removeFav(c.id));
    el.dataset.id = c.id;
    grid.appendChild(el);
  }
  $('fav-empty').hidden = favs.length > 0;
  syncPanel();
}

function renderPresetCards() {
  const grid = $('presets');
  grid.innerHTML = '';
  PRESETS.forEach((p, i) => {
    grid.appendChild(lutCardEl(p.name, presetLutData[i], LUT_SIZE, 'preset',
      () => setTone({ type: 'preset', idx: i })));
  });
  syncPanel();
}

/** 内置 LUT（用户下载的 .cube 打包进产品，v0.9"内置"页签）。 */
async function loadBuiltins() {
  try {
    const list = await (await fetch('assets/luts/index.json')).json();
    for (const { file, name } of list) {
      try {
        const text = await (await fetch(`assets/luts/${file}`)).text();
        const { size, data } = parseCube(text);
        state.cubes.push({
          id: ++cubeSeq, origin: 'builtin', asset: file, name, size, data,
          lutTex: renderer.createLutTexture(data, size),
        });
      } catch (e) { console.warn('内置 LUT 加载失败：', file, e); }
    }
  } catch (e) { console.warn('内置 LUT 清单加载失败：', e); }
  const grid = $('builtins');
  grid.innerHTML = '';
  for (const c of state.cubes.filter((x) => x.origin === 'builtin')) {
    const el = lutCardEl(c.name, c.data, c.size, 'builtin-card',
      () => setTone({ type: 'cube', id: c.id }));
    el.dataset.id = c.id;
    grid.appendChild(el);
  }
  $('builtin-loading').hidden = true;
  syncPanel();
}

/** .cube 页分类页签：常用（自制模版）/内置（打包 LUT）/收藏（占位）/最近（导入历史）。 */
function setCubeTab(t) {
  if (!['common', 'builtin', 'fav', 'recent'].includes(t)) t = 'common';
  state.cubeTab = t;
  document.querySelectorAll('#cube-tabs button').forEach((b) =>
    b.classList.toggle('on', b.dataset.tab === t));
  for (const id of ['common', 'builtin', 'fav', 'recent'])
    $(`tab-${id}`).hidden = id !== t;
  saveUi();
}

async function loadDemo() {
  const hues = [18, 36, 205, 222, 158, 275, 48, 338, 190, 96, 26, 258, 130, 300, 70, 240, 350, 165];
  const files = hues.map((hue, i) => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 420;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 420);
    g.addColorStop(0, `hsl(${hue},45%,${58 + (i % 3) * 6}%)`);
    g.addColorStop(1, `hsl(${(hue + 40) % 360},35%,30%)`);
    x.fillStyle = g; x.fillRect(0, 0, 640, 420);
    x.fillStyle = `hsl(${(hue + 60) % 360},60%,78%)`;
    x.beginPath(); x.arc(160 + (i % 4) * 90, 130, 46, 0, Math.PI * 2); x.fill();
    x.fillStyle = `hsl(${(hue + 190) % 360},30%,22%)`; x.fillRect(0, 320, 640, 100);
    return new Promise((res) => c.toBlob((b) => {
      const f = new File([b], `示例_${String(i + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' });
      res(f);
    }, 'image/jpeg', 0.9));
  });
  await addFiles(await Promise.all(files));
  // 示例参考图：青橙暮色，直接展示招牌时刻
  const rc = document.createElement('canvas');
  rc.width = 640; rc.height = 420;
  const rx = rc.getContext('2d');
  const rg = rx.createLinearGradient(0, 0, 0, 420);
  rg.addColorStop(0, '#f2a35c'); rg.addColorStop(0.55, '#b96b4a'); rg.addColorStop(1, '#14383f');
  rx.fillStyle = rg; rx.fillRect(0, 0, 640, 420);
  const blob = await new Promise((r) => rc.toBlob(r, 'image/png'));
  await addRefs([new File([blob], '示例参考图.png', { type: 'image/png' })]);
}

// ---------------------------------------------------------------- 自检（?selftest=1）

function selfTest() {
  const near = (a, b, tol) => Math.abs(a - b) < tol;
  const lab = srgbToLab(0.2, 0.4, 0.6);
  const expectLab = [42.0081, -0.1517, -32.846];      // m0/reinhard.py 参考值
  const rt = labToSrgb(...lab);
  const results = [
    ['srgbToLab vs Python', lab.every((v, i) => near(v, expectLab[i], 0.01))],
    ['Lab 往返', [0.2, 0.4, 0.6].every((v, i) => near(rt[i], v, 1e-4))],
    ['affine 恒等', (() => {
      const s = { mean: [50, 0, 0], std: [20, 10, 10] };
      const { scale, offset } = affineParams(s, s);
      return scale.every((v) => near(v, 1, 1e-9)) && offset.every((v) => near(v, 0, 1e-9));
    })()],
    ['WebGL2', !!renderer],
  ];
  const div = document.createElement('div');
  div.id = 'selftest';
  div.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99;background:#1A1A1E;border:1px solid #2A2A30;border-radius:8px;padding:10px 14px;font-size:12px;line-height:1.8';
  div.innerHTML = results.map(([n, ok]) => `${ok ? '✅' : '❌'} ${n}`).join('<br>');
  document.body.appendChild(div);
}

// ---------------------------------------------------------------- 启动

function initDebug() {
  const div = document.createElement('div');
  div.id = 'debug';
  div.style.cssText = 'position:fixed;left:12px;top:60px;z-index:99;background:#1A1A1E;color:#EDEDF0;border-radius:8px;padding:8px 12px;font-size:11px;line-height:1.7;max-width:480px;white-space:pre-wrap';
  document.body.appendChild(div);
  const errs = [];
  const log = () => {
    div.textContent = `mode=${state.mode} imgs=${state.images.length} refs=${state.refs.length} cubes=${state.cubes.length} tone=${state.tone.type} strength=${state.strength}`
      + (errs.length ? '\nERR: ' + errs.join(' | ') : '');
  };
  window.addEventListener('error', (e) => { errs.push(e.message); log(); });
  window.addEventListener('unhandledrejection', (e) => { errs.push(String(e.reason)); log(); });
  setInterval(log, 100);
  log();
}

async function boot() {
  renderer = new Renderer(canvas);
  worker = new Worker('./js/stats-worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const img = state.images.find((m) => m.id === e.data.id);
    if (img) { img.stats = e.data.stats; invalidate(); }
  };
  buildPresets();
  bindEvents();
  window.__eff = effectiveStrength;   // 供自动化测试读取有效强度
  window.__merged = () => mergedRef;  // 供自动化测试校验合成统计（v0.10 平均观感）
  await loadBase();                   // v0.9 垫图
  renderPresetCards();                // 常用页签：8 个自制模版垫图卡片
  await loadBuiltins();               // 内置页签：打包的下载 LUT
  await restoreSession();             // BUG-008：恢复上次会话
  uiReady = true;                     // 恢复完成后才允许界面状态落盘
  requestAnimationFrame(frame);

  const q = new URLSearchParams(location.search);
  if (q.get('debug')) initDebug();
  if (q.get('selftest')) selfTest();
  if (q.get('demo')) {
    await loadDemo();
    if (q.get('preset') !== null && q.get('preset') !== undefined && q.get('preset') !== '')
      setTone({ type: 'preset', idx: +q.get('preset') });
    if (q.get('strength')) {
      state.strength = +q.get('strength');
      $('strength').value = state.strength;
      $('strength-val').textContent = `${state.strength}%`;
    }
    if (q.get('mode') === 'wall') setMode('wall');
  }
}

boot().catch((err) => {
  document.body.innerHTML = `<div style="display:flex;height:100vh;align-items:center;justify-content:center;color:#9A9AA4;font-size:14px">
    需要 WebGL2 支持——请使用最新版 Chrome / Edge / Safari 打开（${err.message}）</div>`;
});
