"""ToneSync M0 —— Reinhard 效果验证脚本。

用法：
  # 用内置合成图先跑通管线（不能代替真实生成图的效果结论）
  .venv/bin/python m0/run_m0.py --demo

  # 用真实素材验证（PRD M0：1 张参考图 + ~20 张真实生成图）
  .venv/bin/python m0/run_m0.py --ref 参考图.jpg --src 素材目录/ --out m0/output

产出（--out 目录下）：
  compare_*.jpg     每张图四联对比：原图 | 逐图匹配 70% | 逐图匹配 100% | 全局匹配 70%
  contact_sheet.jpg 总览墙（原图/调后上下对）
  tone_100.cube     全局色调 LUT（100% 原始强度）
  tone_070.cube     全局色调 LUT（烘焙默认强度 70%）
  report.md         LUT 保真度、逐图偏移量表、失败形态清单模板

"逐图匹配"= 每张图用自身统计量对齐参考图（真正的批量统一）；
"全局匹配"= 整批共用一套统计量/一个 LUT（可保存分享的"色调"，即 .cube 的语义）。
两者差异是 M0 需要带回 M1 架构设计的关键结论。
"""

from __future__ import annotations

import argparse
import datetime
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reinhard as rh

EXTS = {".jpg", ".jpeg", ".png", ".webp"}
PANEL_H = 320
FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
]


def load_font(size: int):
    for p in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def load_rgb(path: Path) -> np.ndarray:
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return np.asarray(im, dtype=np.float64) / 255.0


def to_pil(arr: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8))


def thumb_arr(arr: np.ndarray, max_side: int = 256) -> np.ndarray:
    im = to_pil(arr)
    im.thumbnail((max_side, max_side), Image.LANCZOS)
    return np.asarray(im, dtype=np.float64) / 255.0


def labeled_panel(arr: np.ndarray, text: str, font) -> Image.Image:
    im = to_pil(arr)
    im = im.resize((max(1, round(im.width * PANEL_H / im.height)), PANEL_H), Image.LANCZOS)
    bar = 30
    out = Image.new("RGB", (im.width, PANEL_H + bar), (16, 16, 19))
    out.paste(im, (0, bar))
    ImageDraw.Draw(out).text((8, 6), text, fill=(230, 230, 235), font=font)
    return out


def hstack(panels: list[Image.Image], gap: int = 4, bg=(13, 13, 15)) -> Image.Image:
    w = sum(p.width for p in panels) + gap * (len(panels) - 1)
    h = max(p.height for p in panels)
    out = Image.new("RGB", (w, h), bg)
    x = 0
    for p in panels:
        out.paste(p, (x, 0))
        x += p.width + gap
    return out


# ---------------------------------------------------------------- demo 素材

def gen_demo(root: Path) -> tuple[Path, Path]:
    """合成 1 张参考图 + 20 张色调各异的素材图，含 5 种极端形态探针。"""
    src_dir = root / "src"
    src_dir.mkdir(parents=True, exist_ok=True)

    def grad(w, h, top, bottom):
        t = np.linspace(0, 1, h)[:, None, None]
        return (1 - t) * np.array(top) + t * np.array(bottom)

    # 参考图：青橙电影感
    ref = grad(640, 420, (0.95, 0.62, 0.32), (0.08, 0.22, 0.30))
    ref = np.repeat(ref, 640, axis=1).reshape(420, 640, 3)
    yy, xx = np.mgrid[0:420, 0:640]
    ref[(xx - 480) ** 2 + (yy - 110) ** 2 < 60 ** 2] = (1.0, 0.85, 0.55)
    ref_path = root / "reference.png"
    to_pil(ref).save(ref_path)

    import colorsys
    hues = [0.05, 0.10, 0.57, 0.62, 0.44, 0.76, 0.13, 0.94, 0.53, 0.27, 0.07, 0.72, 0.35, 0.60, 0.88]
    for i, hue in enumerate(hues):
        top = colorsys.hls_to_rgb(hue, 0.62 + (i % 3) * 0.05, 0.45)
        bot = colorsys.hls_to_rgb((hue + 0.11) % 1.0, 0.30, 0.35)
        img = np.repeat(grad(640, 420, top, bot), 640, axis=1).reshape(420, 640, 3)
        c = colorsys.hls_to_rgb((hue + 0.17) % 1.0, 0.78, 0.60)
        img[(xx - (160 + (i % 4) * 90)) ** 2 + (yy - 130) ** 2 < 46 ** 2] = c
        img[320:, :] = colorsys.hls_to_rgb((hue + 0.53) % 1.0, 0.22, 0.30)
        to_pil(img).save(src_dir / f"demo_{i + 1:02d}_hue{int(hue * 360):03d}.jpg", quality=92)

    probes = {
        "demo_16_flat_gray": np.full((420, 640, 3), 0.5),                      # 近纯色：σ≈0 探针
        "demo_17_very_dark": np.repeat(grad(640, 420, (0.06, 0.05, 0.08), (0.01, 0.01, 0.02)), 640, 1).reshape(420, 640, 3),
        "demo_18_overexposed": np.repeat(grad(640, 420, (1.0, 0.98, 0.94), (0.85, 0.86, 0.90)), 640, 1).reshape(420, 640, 3),
        "demo_19_neon": np.repeat(grad(640, 420, (1.0, 0.0, 0.6), (0.0, 1.0, 0.9)), 640, 1).reshape(420, 640, 3),
        "demo_20_sepia_mono": np.repeat(grad(640, 420, (0.72, 0.62, 0.48), (0.45, 0.38, 0.28)), 640, 1).reshape(420, 640, 3),
    }
    for name, img in probes.items():
        to_pil(img).save(src_dir / f"{name}.jpg", quality=92)
    return ref_path, src_dir


# ---------------------------------------------------------------- 主流程

def main() -> None:
    ap = argparse.ArgumentParser(description="ToneSync M0：Reinhard 统计匹配效果验证")
    ap.add_argument("--ref", help="参考图路径")
    ap.add_argument("--src", help="素材图目录")
    ap.add_argument("--out", default="m0/output", help="输出目录")
    ap.add_argument("--strength", type=float, default=70, help="默认强度（0–100，默认 70）")
    ap.add_argument("--lut-size", type=int, default=33)
    ap.add_argument("--max-images", type=int, default=20)
    ap.add_argument("--max-side", type=int, default=0,
                    help="处理前将长边缩到该值（0=原尺寸；目检效果用 1600 足够且省内存）")
    ap.add_argument("--author", default="", help="写入 .cube 元数据的作者昵称")
    ap.add_argument("--demo", action="store_true", help="用内置合成图跑通管线")
    args = ap.parse_args()

    out_dir = Path(args.out)
    if args.demo:
        demo_root = Path(__file__).resolve().parent / "demo_input"
        ref_path, src_dir = gen_demo(demo_root)
        if args.out == "m0/output":
            out_dir = Path(__file__).resolve().parent / "demo_output"
    elif args.ref and args.src:
        ref_path, src_dir = Path(args.ref), Path(args.src)
    else:
        ap.error("需要 --ref 与 --src，或使用 --demo")

    out_dir.mkdir(parents=True, exist_ok=True)
    k = args.strength / 100.0
    font = load_font(15)

    srcs = sorted(p for p in src_dir.iterdir() if p.suffix.lower() in EXTS)[: args.max_images]
    if not srcs:
        sys.exit(f"错误：{src_dir} 下没有 jpg/png/webp 图片")

    ref = load_rgb(ref_path)
    ref_stats = rh.lab_stats(thumb_arr(ref))
    ref_mu = ref_stats[0]

    # 全批统计量（全局匹配 / 可分享色调 = 一个 LUT 的语义）
    all_lab = np.concatenate([rh.srgb_to_lab(thumb_arr(load_rgb(p))).reshape(-1, 3) for p in srcs])
    batch_stats = (all_lab.mean(axis=0), all_lab.std(axis=0))

    lut100 = rh.bake_lut(batch_stats, ref_stats, args.lut_size, strength=1.0)
    lut_k = rh.bake_lut(batch_stats, ref_stats, args.lut_size, strength=k)
    meta = {
        "author": args.author or "unknown",
        "created": datetime.datetime.now().isoformat(timespec="seconds"),
        "algorithm": "reinhard-lab-v0",
        "reference": ref_path.name,
    }
    rh.write_cube(out_dir / "tone_100.cube", lut100, "ToneSync M0 (100%)", meta | {"strength": "100%"})
    rh.write_cube(out_dir / f"tone_{int(args.strength):03d}.cube", lut_k,
                  f"ToneSync M0 ({int(args.strength)}%)", meta | {"strength": f"{int(args.strength)}%"})

    rows, sheet_cells, de_all = [], [], []
    ref_panel = labeled_panel(ref, "参考图", font)
    for p in srcs:
        img = load_rgb(p)
        if args.max_side and max(img.shape[:2]) > args.max_side:
            img = thumb_arr(img, args.max_side)
        per_stats = rh.lab_stats(thumb_arr(img))
        per100 = rh.transfer(img, per_stats, ref_stats)      # 逐图匹配
        glob100 = rh.transfer(img, batch_stats, ref_stats)   # 全局匹配（共享统计量）
        per_k = rh.blend(img, per100, k)
        glob_k = rh.blend(img, glob100, k)

        # LUT 保真度：GPU 三线性采样路径 vs 直接计算（抽样 64px 缩略图即可）
        small = thumb_arr(img, 64)
        de = rh.delta_e76(rh.apply_lut(small, lut100), rh.transfer(small, batch_stats, ref_stats))
        de_all.append(de.ravel())

        shift = float(np.linalg.norm(per_stats[0] - ref_mu))  # 迁移前后 Lab 均值偏移（可疑图指标原型）
        rows.append((p.name, shift, float(de.mean()), float(de.max())))

        panels = [
            labeled_panel(img, f"原图 · {p.name}", font),
            labeled_panel(per_k, f"逐图匹配 {int(args.strength)}%", font),
            labeled_panel(per100, "逐图匹配 100%", font),
            labeled_panel(glob_k, f"全局匹配 {int(args.strength)}%（共享 LUT）", font),
        ]
        hstack([ref_panel] + panels).save(out_dir / f"compare_{p.stem}.jpg", quality=88)

        cell_w = 236
        pair = Image.new("RGB", (cell_w, 316), (13, 13, 15))
        for j, a in enumerate((img, per_k)):
            t = to_pil(a); t.thumbnail((cell_w, 156), Image.LANCZOS)
            pair.paste(t, ((cell_w - t.width) // 2, 2 + j * 158))
        sheet_cells.append(pair)

    # 总览墙：上=原图，下=逐图匹配后
    cols = 5
    rows_n = (len(sheet_cells) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 240 + 8, rows_n * 324 + 8), (13, 13, 15))
    for i, cell in enumerate(sheet_cells):
        sheet.paste(cell, (8 + (i % cols) * 240, 8 + (i // cols) * 324))
    sheet.save(out_dir / "contact_sheet.jpg", quality=88)

    de_cat = np.concatenate(de_all)
    suspects = [r for r in rows if r[1] > 30.0]
    lines = [
        "# ToneSync M0 验证报告", "",
        f"- 时间：{meta['created']}　参考图：`{ref_path.name}`　素材：{len(srcs)} 张",
        f"- 算法：Reinhard 统计匹配（Lab，均值+标准差，σ 比例上限 {rh.STD_RATIO_CAP}）",
        f"- 强度：{int(args.strength)}%（sRGB 空间线性插值，与 Web 端 shader mix 一致）", "",
        "## LUT 烘焙保真度（决定 Web 端能否用 33³ LUT 复现算法）", "",
        f"- {args.lut_size}³ LUT 三线性采样 vs 直接计算：平均 ΔE76 = **{de_cat.mean():.3f}**，"
        f"P99 = {np.percentile(de_cat, 99):.3f}，最大 = {de_cat.max():.3f}",
        f"- 结论参考：ΔE76 < 1 肉眼不可辨，< 2.3 为可接受（JND）", "",
        "## 逐图匹配 vs 全局匹配（M1 架构关键结论）", "",
        "- **逐图匹配**：每图用自身统计量 → 真正把互不统一的批次拉齐（对应 compare_*.jpg 第 2/3 联）",
        "- **全局匹配（共享 LUT）**：整批一套统计量 → 整体风格偏移但保留图间差异（第 4 联），"
        "这是 .cube 可保存/分享的语义",
        "- 注意：PRD §7 现写\"所有缩略图共用同一 LUT\"，只能实现全局匹配；若真实素材验证下来需要逐图匹配"
        "才能达到\"统一\"效果，M1 需改为逐图统计量（Reinhard 在 shader 里只是 6 个 uniform 的仿射，无需逐图 LUT）", "",
        "## 逐图偏移量（可疑图指标原型：与参考图的 Lab 均值距离）", "",
        "| 文件 | Lab 偏移 | LUT ΔE(均值) | LUT ΔE(最大) | 备注 |",
        "| --- | --- | --- | --- | --- |",
    ]
    for name, shift, dem, dex in sorted(rows, key=lambda r: -r[1]):
        note = "⚠️ 偏移大，重点目检" if shift > 30.0 else ""
        lines.append(f"| {name} | {shift:.1f} | {dem:.2f} | {dex:.2f} | {note} |")
    lines += [
        "", f"> 偏移 > 30 共 {len(suspects)} 张——阈值为初始拍脑袋值，请结合目检校准（对应 PRD 可疑图标记 P1/M3）。", "",
        "## 失败形态清单（目检 compare_*.jpg 后勾选，MVP 文档需诚实说明适用边界）", "",
        "- [ ] 参考图与素材内容差异过大 → 全局偏色（如把天空色染到人物上）",
        "- [ ] 低方差素材（近纯色/大面积平坦区）→ 对比度爆炸或色带（σ 比例上限是否够用）",
        "- [ ] 暗部素材 → 提亮后噪点/色带放大",
        "- [ ] 高光溢出 → 过曝区域细节丢失、色相偏移",
        "- [ ] 高饱和素材 → 匹配后饱和度溢出边缘（clip 痕迹）",
        "- [ ] 肤色 → 匹配后蜡黄/惨白（生成师素材常见人物）",
        "- [ ] 强度 70% 默认值是否普遍合适（过强/过弱各记几例）",
        "- [ ] 逐图匹配是否抹掉了应该保留的图间明暗叙事差异（日景/夜景被拉齐）", "",
        "## 使用真实素材复跑", "",
        "```bash", ".venv/bin/python m0/run_m0.py --ref 你的参考图.jpg --src 真实素材目录/ --out m0/output", "```",
    ]
    (out_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")

    print(f"完成：{len(srcs)} 张 → {out_dir}")
    print(f"LUT 保真度 ΔE76 均值 {de_cat.mean():.3f} / 最大 {de_cat.max():.3f}")
    print(f"偏移 > 30 的可疑图：{len(suspects)} 张（详见 report.md）")


if __name__ == "__main__":
    main()
