# M0 —— Reinhard 效果验证（对应 PRD §9 里程碑 M0）

用 Python 原型验证"参考图驱动的 Reinhard 统计匹配"在真实生成图上的效果，
产出：真实前后对比图 + LUT 保真度数据 + 失败形态清单。算法路径与 PRD §7 一致
（sRGB gamma 解码 → 线性 RGB → Lab → 均值/标准差匹配 → 33³ LUT → 标准 .cube）。

## 运行

```bash
# 首次：项目根目录建环境（python 3.11+）
python3.11 -m venv .venv && .venv/bin/pip install numpy pillow

# 合成图冒烟（只验证管线，不能替代真实素材的效果结论）
.venv/bin/python m0/run_m0.py --demo

# 真实验证：1 张参考图 + ~20 张真实生成图
.venv/bin/python m0/run_m0.py --ref 参考图.jpg --src 素材目录/ --out m0/output
# 可选：--strength 70  --lut-size 33  --max-images 20  --author 昵称
```

## 输出（--out 目录）

| 文件 | 说明 |
| --- | --- |
| `compare_*.jpg` | 每张图五联：参考图 \| 原图 \| 逐图匹配 70% \| 逐图匹配 100% \| 全局匹配 70%（共享 LUT） |
| `contact_sheet.jpg` | 总览墙：每格上=原图、下=逐图匹配 70% |
| `tone_100.cube` / `tone_070.cube` | 全局色调 LUT（原始强度 / 烘焙默认强度），元数据在 TITLE + `#` 注释行，可直接进 Resolve/PS |
| `report.md` | LUT 保真度（ΔE76）、逐图 Lab 偏移量表（可疑图指标原型）、失败形态清单待勾选 |

## M0 要回答的三个问题

1. **效果**：Reinhard 粗调在真实生成图上是否"够用"？目检 `compare_*.jpg`，在 `report.md` 勾失败形态。
2. **架构**：逐图匹配（真统一）vs 全局匹配（单一共享 LUT，PRD §7 现方案）差距多大？
   若必须逐图匹配，M1 的 shader 应改为逐图传 6 个仿射 uniform，而非共享 LUT。
3. **保真度**：33³ LUT + 三线性插值能否无损复现算法？（demo 数据：ΔE76 均值 0.04 / 最大 0.57，远低于 2.3 JND，✅）

## 文件

- `reinhard.py` —— 核心算法模块，无 CLI 依赖，可独立复用（对应 PRD"核心算法模块独立可复用"）
- `run_m0.py` —— 批量跑图、出对比图与报告
- `demo_input/`、`demo_output/` —— `--demo` 生成的合成素材与产物，可随时删除重生成
