/**
 * ToneSync 色彩数学核心模块（独立可复用，无 DOM 依赖）。
 * 语义与 m0/reinhard.py 逐行对齐：
 *   sRGB 解码 gamma → 线性 RGB → CIELAB → Reinhard 逐通道仿射 → 回 sRGB
 * 强度 = 原图与目标结果在 sRGB 空间的线性插值系数。
 */

export const STD_RATIO_CAP = 5.0;
export const LUT_SIZE = 33;

// sRGB(D65) 线性 RGB ↔ XYZ
const M_RGB2XYZ = [
  0.4124564, 0.3575761, 0.1804375,
  0.2126729, 0.7151522, 0.0721750,
  0.0193339, 0.1191920, 0.9503041,
];
const M_XYZ2RGB = [
  3.2404542, -1.5371385, -0.4985314,
  -0.9692660, 1.8760108, 0.0415560,
  0.0556434, -0.2040259, 1.0572252,
];
const WHITE = [0.95047, 1.0, 1.08883];

export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(v) {
  if (v <= 0) return 0;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

const D = 6 / 29;

/** [r,g,b] sRGB 0..1 → [L,a,b]（L 0..100） */
export function srgbToLab(r, g, b) {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const f = [];
  for (let i = 0; i < 3; i++) {
    const t = (M_RGB2XYZ[i * 3] * lr + M_RGB2XYZ[i * 3 + 1] * lg + M_RGB2XYZ[i * 3 + 2] * lb) / WHITE[i];
    f[i] = t > D * D * D ? Math.cbrt(t) : t / (3 * D * D) + 4 / 29;
  }
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

/** [L,a,b] → [r,g,b] sRGB 0..1（已 clip） */
export function labToSrgb(L, a, b) {
  const fy = (L + 16) / 116;
  const f = [fy + a / 500, fy, fy - b / 200];
  const xyz = f.map((v, i) => (v > D ? v * v * v : 3 * D * D * (v - 4 / 29)) * WHITE[i]);
  const out = [];
  for (let i = 0; i < 3; i++) {
    const lin = M_XYZ2RGB[i * 3] * xyz[0] + M_XYZ2RGB[i * 3 + 1] * xyz[1] + M_XYZ2RGB[i * 3 + 2] * xyz[2];
    out[i] = Math.min(1, Math.max(0, linearToSrgb(lin)));
  }
  return out;
}

/** ImageData 像素 → Lab 均值/标准差（对齐 m0 lab_stats，thumbnail 上调用） */
export function labStats(data) {
  const n = data.length / 4;
  let sum = [0, 0, 0], sq = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    const lab = srgbToLab(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
    for (let c = 0; c < 3; c++) { sum[c] += lab[c]; sq[c] += lab[c] * lab[c]; }
  }
  const mean = sum.map((s) => s / n);
  const std = sq.map((s, c) => Math.sqrt(Math.max(0, s / n - mean[c] * mean[c])));
  return { mean, std };
}

/**
 * Reinhard 逐图仿射参数：lab' = lab * scale + offset。
 * 即 shader 的 6 个 uniform（M1 架构，PRD §7 双路径之逐图匹配）。
 */
export function affineParams(srcStats, refStats) {
  const scale = [], offset = [];
  for (let c = 0; c < 3; c++) {
    const r = Math.min(STD_RATIO_CAP, Math.max(0, refStats.std[c] / Math.max(srcStats.std[c], 1e-6)));
    scale[c] = r;
    offset[c] = refStats.mean[c] - srcStats.mean[c] * r;
  }
  return { scale, offset };
}

/**
 * 多参考图合并统计（v0.10"平均观感"语义）：μ、σ 各取参考图统计的加权平均。
 * 旧版 pooled（拼图语义）会把参考图之间的明暗/色相差异错误地转成目标对比度膨胀，
 * 参考组差异大时高光溢出、饱和度爆表（2026-07-20 真实图对比选优，见 m0/output/report.md 附录）；
 * 平均观感在参考图相似时与 pooled 几乎一致，差异大时给出"平均色调"，不爆对比。
 * items: [{ stats: {mean, std}, weight }]，weight 0..1（等权传 1 即可）。
 * 返回 { mean, std, W }；W = Σweight（全 0 / 无有效项返回 null）。
 */
export function mergeRefStats(items) {
  let W = 0;
  const mu = [0, 0, 0], sd = [0, 0, 0];
  for (const { stats, weight } of items) {
    if (!stats || !(weight > 0)) continue;
    W += weight;
    for (let c = 0; c < 3; c++) {
      mu[c] += weight * stats.mean[c];
      sd[c] += weight * stats.std[c];
    }
  }
  if (W <= 0) return null;
  return { mean: mu.map((v) => v / W), std: sd.map((v) => v / W), W };
}

/** 解析标准 .cube（3D LUT，r 变化最快）。非法内容抛错。 */
export function parseCube(text) {
  let size = 0, title = '';
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('TITLE')) { title = (line.match(/"(.*)"/) || [, ''])[1]; continue; }
    if (line.startsWith('LUT_1D_SIZE')) throw new Error('仅支持 3D LUT（LUT_3D_SIZE）');
    if (line.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (line.startsWith('DOMAIN_')) continue;
    const p = line.split(/\s+/);
    if (p.length === 3 && !Number.isNaN(+p[0])) vals.push(+p[0], +p[1], +p[2]);
  }
  if (!size || size < 2 || size > 128) throw new Error('缺少或非法 LUT_3D_SIZE');
  if (vals.length !== size ** 3 * 3) throw new Error(`数据点数量不符：期望 ${size ** 3}，实际 ${vals.length / 3}`);
  const data = new Uint8Array(vals.length);
  for (let i = 0; i < vals.length; i++) data[i] = Math.round(Math.min(1, Math.max(0, vals[i])) * 255);
  return { title, size, data };
}

/** 序列化为标准 .cube（与 m0/reinhard.py write_cube 同格式：TITLE + # ToneSync-Meta 注释行）。 */
export function serializeCube(data, size, title, meta = {}) {
  const lines = [`TITLE "${title}"`];
  for (const [k, v] of Object.entries(meta)) lines.push(`# ToneSync-Meta ${k}: ${v}`);
  lines.push(`LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0');
  for (let i = 0; i < data.length; i += 3)
    lines.push(`${(data[i] / 255).toFixed(6)} ${(data[i + 1] / 255).toFixed(6)} ${(data[i + 2] / 255).toFixed(6)}`);
  return lines.join('\n') + '\n';
}

/** 三线性采样 LUT（chip 预览 / CPU 侧校验用；与 GPU 采样同语义）。 */
export function sampleLut(data, size, r, g, b) {
  const n = size - 1;
  const pos = [r * n, g * n, b * n].map((v) => Math.min(Math.max(v, 0), n));
  const i0 = pos.map((v) => Math.min(Math.floor(v), n - 1));
  const f = pos.map((v, i) => v - i0[i]);
  const at = (ri, gi, bi) => {
    const o = ((bi * size + gi) * size + ri) * 3;
    return [data[o] / 255, data[o + 1] / 255, data[o + 2] / 255];
  };
  const out = [];
  for (let c = 0; c < 3; c++) {
    const c00 = at(i0[0], i0[1], i0[2])[c] * (1 - f[0]) + at(i0[0] + 1, i0[1], i0[2])[c] * f[0];
    const c10 = at(i0[0], i0[1] + 1, i0[2])[c] * (1 - f[0]) + at(i0[0] + 1, i0[1] + 1, i0[2])[c] * f[0];
    const c01 = at(i0[0], i0[1], i0[2] + 1)[c] * (1 - f[0]) + at(i0[0] + 1, i0[1], i0[2] + 1)[c] * f[0];
    const c11 = at(i0[0], i0[1] + 1, i0[2] + 1)[c] * (1 - f[0]) + at(i0[0] + 1, i0[1] + 1, i0[2] + 1)[c] * f[0];
    out[c] = (c00 * (1 - f[1]) + c10 * f[1]) * (1 - f[2]) + (c01 * (1 - f[1]) + c11 * f[1]) * f[2];
  }
  return out;
}

/** 把任意 rgb→rgb 变换烘焙为 N³ LUT（Uint8Array RGB，r 变化最快，对齐 .cube 序）。 */
export function bakeLut(transform, size = LUT_SIZE) {
  const data = new Uint8Array(size * size * size * 3);
  let p = 0;
  for (let bi = 0; bi < size; bi++)
    for (let gi = 0; gi < size; gi++)
      for (let ri = 0; ri < size; ri++) {
        const [r, g, b] = transform(ri / (size - 1), gi / (size - 1), bi / (size - 1));
        data[p++] = Math.round(r * 255);
        data[p++] = Math.round(g * 255);
        data[p++] = Math.round(b * 255);
      }
  return data;
}

// ---------------------------------------------------------------- 内置模版
// 每个模版 = Lab 空间的一个确定性变换，构建期（应用启动时）烘焙为 33³ LUT，
// 走 LUT 纹理路径（PRD §7）。强度语义与参考图一致：identity 与模版结果的插值。

function chroma(lab, k) { lab[1] *= k; lab[2] *= k; return lab; }

export const PRESETS = [
  { name: '暖调', fn: (lab) => { lab[1] += 4; lab[2] += 14; return lab; } },
  { name: '冷调', fn: (lab) => { lab[1] -= 2; lab[2] -= 14; return lab; } },
  { name: '青橙', fn: (lab) => {
      const d = (lab[0] - 50) / 50;               // 高光偏橙、阴影偏青
      lab[1] += d * 10; lab[2] += d * 24; return chroma(lab, 1.06);
    } },
  { name: '日系', fn: (lab) => { lab[0] = lab[0] * 0.92 + 8; lab[2] += 5; return chroma(lab, 0.85); } },
  { name: '黑白', fn: (lab) => chroma(lab, 0) },
  { name: '高对比', fn: (lab) => { lab[0] = 50 + (lab[0] - 50) * 1.25; return chroma(lab, 1.05); } },
  { name: '低饱和', fn: (lab) => chroma(lab, 0.55) },
  { name: '复古', fn: (lab) => { lab[0] = lab[0] * 0.9 + 9; lab[1] += 5; lab[2] += 10; return chroma(lab, 0.8); } },
];

export function presetTransform(preset) {
  return (r, g, b) => {
    const lab = preset.fn(srgbToLab(r, g, b));
    return labToSrgb(lab[0], lab[1], lab[2]);
  };
}
