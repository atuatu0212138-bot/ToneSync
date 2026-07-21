# ToneSync · 批量色调统一

> Batch color-grading in your browser — 拖入一张参考图和一批素材图，几百张图片实时统一成同一个色调，批量导出。**全程本地处理，图片不上传。**

ToneSync 是一个纯浏览器、零后端的批量调色工具。它解决一个很具体的问题：当一批图片（AI 生成资产、插画、摄影等）色调互不统一时，如何用一张理想的参考图，把它们**快速、实时、批量**地拉齐成同一个色调。

市面上的滤镜/调色工具几乎都是"单张图 + 预设库"模式；ToneSync 的差异点是 **参考图驱动 + 批量处理 + 实时预览**。

---

## 核心能力

- **参考图驱动**：拖入参考图，自动解算色彩变换（Reinhard 统计匹配，CIELAB 空间，gamma 正确的线性管线）。支持 **0–20 张多参考图**，等权合成为一个色调统一套用。
- **实时批量预览**：单图模式 + 网格墙模式双视图。换参考图/模版时，整面预览墙同时"呼吸变色"，几百张图片 <100ms 开始跟随。
- **内置模版 ×8**：暖调 / 冷调 / 青橙 / 日系 / 黑白 / 高对比 / 低饱和 / 复古，垫图卡片实时预览效果。
- **标准 .cube 互通**：导入 Resolve / PS 等标准 3D LUT，或把当前色调导出为标准 `.cube`——无自有格式，可直接进后期软件或分享。
- **收藏与历史**：把满意的色调收藏为模版；导出/下载过的色调自动进"最近"，随时复用。
- **图片下载**：原分辨率、保持原文件名与格式；单张直接下载，宫格多选批量下载（Chrome/Edge 写入所选目录，其余浏览器降级为 ZIP 打包）。
- **会话持久化**：素材 / 参考图 / 导入的 LUT / 收藏 / 界面状态自动存本地 IndexedDB，刷新或重开浏览器完整恢复。
- **隐私优先**：所有计算都在浏览器端完成，**图片不经过任何服务器**。

> 技术上，实时"批量统一"走的是**逐图 Lab 仿射匹配**（每张素材按自身统计量对齐参考统计）——这是经真实素材验证后的架构结论（见 [`m0/output/report.md`](m0/output/report.md)）。导出的 `.cube` 承载的是等效的**全局变换**，用于跨软件迁移。

---

## 运行

零构建，原生 ES Modules + WebGL2，无需打包。需要一个本地静态服务器（ES Modules / Web Worker 不能用 `file://` 直接打开）：

```bash
git clone <this-repo> ToneSync
cd ToneSync
python3 web/serve.py          # 开发服务器，禁缓存，默认 8123 端口
# 浏览器打开 http://localhost:8123/web/
```

打开后点「使用示例图体验」即可看到全流程（自带 18 张示例图 + 参考图）。也可直接访问 `http://localhost:8123/web/?demo=1` 自动载入。

> 建议用最新版 Chrome / Edge / Safari。批量下载到指定目录依赖 File System Access API（Chrome/Edge），其余浏览器自动降级为 ZIP 下载。

---

## 项目结构

```
ToneSync/
├── web/                 浏览器应用（零构建 ES Modules + WebGL2）
│   ├── index.html       布局与入口
│   ├── js/color.js      色彩数学 / Reinhard 统计 / LUT 烘焙（无 DOM 依赖，与 Python 逐位对齐）
│   ├── js/gl.js         WebGL2 渲染器（双路径 shader、纹理 / 3D LUT）
│   ├── js/app.js        状态与交互编排
│   ├── js/store.js      IndexedDB 会话持久化
│   ├── serve.py         开发服务器（no-store）
│   ├── test/            puppeteer 回归套件（82 项断言）
│   └── README.md        模块级开发文档
├── m0/                  算法验证（Python）：Reinhard 真实素材验证 + 合成策略选优
├── docs/                需求文档（PRD）、Bug 跟踪单、交互原型
└── LICENSE              GPL-3.0
```

开发细节、测试运行方式、每个版本的演进见 [`web/README.md`](web/README.md)；产品需求与设计决策见 [`docs/调色工具需求文档.md`](docs/调色工具需求文档.md)；已修复问题的回归约定见 [`docs/Bug单.md`](docs/Bug单.md)。

---

## 状态

MVP 功能已就绪（回归 82 项全通过、控制台零报错）。规划中的增强：色调分享卡片、手动调色、可疑图检测、单图豁免、示波器面板、文件夹导入。

## 许可证

[GNU General Public License v3.0](LICENSE)。你可以自由使用、修改、分发；基于本项目的衍生作品同样须以 GPL-3.0 开源。
