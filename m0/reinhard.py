"""ToneSync M0 —— Reinhard 统计匹配核心算法（Lab 空间，均值 + 标准差）。

与 PRD §7 技术方案对齐：
  sRGB 解码 gamma → 线性 RGB → CIELAB → 逐通道仿射匹配 → 转回 sRGB
变换可烘焙为 33³ 3D LUT，并序列化为标准 Resolve .cube
（元数据写入 TITLE 字段与 # 注释行，见 PRD §4.1 入口④）。
"""

from __future__ import annotations

import numpy as np

# sRGB (D65) 线性 RGB → XYZ
_M_RGB2XYZ = np.array([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
])
_M_XYZ2RGB = np.linalg.inv(_M_RGB2XYZ)
_WHITE = np.array([0.95047, 1.0, 1.08883])  # D65

# 源图某通道标准差过小时（近纯色图），比例失控会把噪点放大成雪花；
# 上限是工程护栏，是否合适属于 M0 要验证的失败形态之一
STD_RATIO_CAP = 5.0


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, None)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """rgb: float (..., 3)，sRGB 编码，[0,1] → CIELAB (L 0~100)。"""
    xyz = srgb_to_linear(rgb) @ _M_RGB2XYZ.T / _WHITE
    d = 6.0 / 29.0
    f = np.where(xyz > d ** 3, np.cbrt(xyz), xyz / (3 * d * d) + 4.0 / 29.0)
    fx, fy, fz = f[..., 0], f[..., 1], f[..., 2]
    return np.stack([116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)], axis=-1)


def lab_to_srgb(lab: np.ndarray) -> np.ndarray:
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    fy = (L + 16.0) / 116.0
    fx = fy + a / 500.0
    fz = fy - b / 200.0
    f = np.stack([fx, fy, fz], axis=-1)
    d = 6.0 / 29.0
    xyz = np.where(f > d, f ** 3, 3 * d * d * (f - 4.0 / 29.0)) * _WHITE
    return np.clip(linear_to_srgb(xyz @ _M_XYZ2RGB.T), 0.0, 1.0)


def lab_stats(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """返回 (mean(3), std(3))。传入缩略图即可（对齐 Web 端 256px 缩略图策略）。"""
    lab = srgb_to_lab(rgb).reshape(-1, 3)
    return lab.mean(axis=0), lab.std(axis=0)


def transfer(rgb: np.ndarray, src_stats, ref_stats) -> np.ndarray:
    """Reinhard 匹配：out = (lab - μ_src) · (σ_ref/σ_src) + μ_ref，返回 100% 强度结果。"""
    mu_s, sd_s = src_stats
    mu_r, sd_r = ref_stats
    ratio = np.clip(sd_r / np.maximum(sd_s, 1e-6), 0.0, STD_RATIO_CAP)
    lab = srgb_to_lab(rgb)
    return lab_to_srgb((lab - mu_s) * ratio + mu_r)


def blend(orig: np.ndarray, transferred: np.ndarray, strength: float) -> np.ndarray:
    """强度语义 = 原图与目标结果的线性插值系数（与 Web 端 shader mix 一致，sRGB 空间）。"""
    return orig * (1.0 - strength) + transferred * strength


def bake_lut(src_stats, ref_stats, size: int = 33, strength: float = 1.0) -> np.ndarray:
    """把变换烘焙为 3D LUT，返回 (N,N,N,3)，索引顺序 [ri, gi, bi]。"""
    axis = np.linspace(0.0, 1.0, size)
    r, g, b = np.meshgrid(axis, axis, axis, indexing="ij")
    grid = np.stack([r, g, b], axis=-1)
    out = transfer(grid, src_stats, ref_stats)
    return blend(grid, out, strength) if strength < 1.0 else out


def apply_lut(rgb: np.ndarray, lut: np.ndarray) -> np.ndarray:
    """三线性插值套用 LUT（模拟 GPU 采样路径，用于校验烘焙保真度）。"""
    n = lut.shape[0]
    x = np.clip(rgb, 0.0, 1.0) * (n - 1)
    i0 = np.floor(x).astype(np.int64)
    i0 = np.minimum(i0, n - 2)
    f = x - i0
    r0, g0, b0 = i0[..., 0], i0[..., 1], i0[..., 2]
    r1, g1, b1 = r0 + 1, g0 + 1, b0 + 1
    fr, fg, fb = f[..., 0:1], f[..., 1:2], f[..., 2:3]  # (...,1) 对 (...,3) 广播
    c00 = lut[r0, g0, b0] * (1 - fr) + lut[r1, g0, b0] * fr
    c10 = lut[r0, g1, b0] * (1 - fr) + lut[r1, g1, b0] * fr
    c01 = lut[r0, g0, b1] * (1 - fr) + lut[r1, g0, b1] * fr
    c11 = lut[r0, g1, b1] * (1 - fr) + lut[r1, g1, b1] * fr
    c0 = c00 * (1 - fg) + c10 * fg
    c1 = c01 * (1 - fg) + c11 * fg
    return c0 * (1 - fb) + c1 * fb


def delta_e76(rgb_a: np.ndarray, rgb_b: np.ndarray) -> np.ndarray:
    """逐像素 ΔE76（Lab 欧氏距离），用于 LUT 保真度与偏移量度量。"""
    return np.linalg.norm(srgb_to_lab(rgb_a) - srgb_to_lab(rgb_b), axis=-1)


def write_cube(path, lut: np.ndarray, title: str, meta: dict | None = None) -> None:
    """序列化为标准 Resolve .cube：红通道变化最快；元数据进 TITLE + # 注释行。"""
    n = lut.shape[0]
    lines = [f'TITLE "{title}"']
    for k, v in (meta or {}).items():
        lines.append(f"# ToneSync-Meta {k}: {v}")
    lines += [f"LUT_3D_SIZE {n}", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"]
    body = lut.transpose(2, 1, 0, 3).reshape(-1, 3)  # b 外层 → g → r 最内层
    lines += [f"{v[0]:.6f} {v[1]:.6f} {v[2]:.6f}" for v in body]
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
