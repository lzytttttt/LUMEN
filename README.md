# LUMEN 幕光

**浏览器里的 AI 原生演示工作台。** 用一句话生成大纲，逐幕成稿，画布上校正，全屏播放，最后导出一个双击就能播的单文件 HTML。

**An AI-native deck workbench in the browser.** Prompt to an outline, fill slide by slide, fix it on a real canvas, present full-screen, and ship a single self-contained HTML file that plays on double-click.

> 本仓库没有后端、没有遥测、没有外链字体：数据在 IndexedDB，模型端点由你自己填（含本地 Ollama），默认离线 Mock。

## 截图 / Screenshots

> 图片是构建产物（`harness/out/` 不入库），先跑一次 `node scripts/snapshot.mjs http://127.0.0.1:5273`。

| 编辑器 / Editor | 播放 / Play |
|---|---|
| ![editor](harness/out/ui-editor.png) | ![play](harness/out/ui-play.png) |

| AI 编排 / Composer | 工作室 / Studio |
|---|---|
| ![composer](harness/out/ui-composer.png) | ![studio](harness/out/studio-3d.png) |

逐幕截图：`harness/out/slides/slide-01.png` … `slide-09.png`（示例 9 幕）。

## 能力 / Capabilities

- **生成**：提示 → 可编辑大纲 → 逐幕成稿；12 个版式配方 × 6 套主题；单幕重写、精简、时间轴化、加 SVG / 加 3D。
- **编辑**：1600×900 画布、多选/框选、八向缩放、旋转、智能参考线 + 网格吸附、对齐分布、图层、锁定隐藏、内联改字、200 步撤销。
- **六种块**：`text` `shape` `image` `svg` `three` `html`（沙箱 iframe）。
- **播放**：全屏、5 种转场、讲者视图（备注 + 计时 + 下一幕）、总览、自动播放、翻页器。
- **导出**：单文件 HTML（`file://` 可播、`?print=1` 打 PDF）、PDF、逐幕 PNG、`.lumen.json` 工程文件。
- **质量**：溢出/对比度/字号/3D 预算/阅读时长统一 lint；AI 产物与人工产物同一把尺子。
- **双语**：UI 中/英即时切换（900 个键 × 2 语言，键必须对等）。

## 5 分钟上手 / Quick start

```powershell
# 1) 安装（本机用的是仓库外的 bundled pnpm；常规环境直接用 pnpm install）
pnpm install

# 2) 开发（先构建播放器内核，再拉 vite；端口固定 5273）
pnpm dev            # → http://127.0.0.1:5273

# 3) 单个动作
pnpm test           # vitest（jsdom）
pnpm typecheck      # tsc --noEmit
pnpm snapshot       # 截图到 harness/out/

# 4) 生产构建（tsc + vite build，prebuild 会先构建播放器内核）
pnpm build
```

**导出**：顶栏「导出」→ 独立 HTML（可选内联素材/备注、整份或当前幕）/ PDF（应用内打印）/ PNG（逐幕，默认 2×）/ 工程文件。
导出的 HTML 与播放器内核同源：`public/player/lumen-player.js` 是构建产物，换机器先 `pnpm build:player`。

## 技术栈 / Stack

| 层 | 选型 |
|---|---|
| 视图 | React 19.2 · TypeScript 5.9（strict）· Vite 7.3 |
| 状态 | zustand 5 + immer 11（补丁历史，200 步） |
| 契约 | zod 3.25（`src/schema/deck.ts` 是唯一数据契约） |
| 3D | three r186（按需动态加载，缩略图不建 WebGL） |
| 其它 | DOMPurify 3（SVG 净化）· CodeMirror 6（SVG/HTML 编辑）· 自建 IndexedDB 封装（`kv.ts`：单库 `lumen-deck` v2 / 三个 store） |
| 测试 | vitest 3（jsdom，183 用例）· Playwright 1.64（e2e 10 用例 + 截图 harness） |

## 目录 / Layout

```
src/
├─ schema/ state/ persistence/ themes/ styles/   # 契约、状态、存储、主题、令牌
├─ render/                                       # 唯一渲染器（stage/play/thumb/print/export）
├─ editor/                                       # 画布交互、幕栏、检查器、工具栏、快捷键
├─ ai/                                           # provider、prompts、12 配方、大纲/微调/意图
├─ studio/                                       # SVG / 3D 工作室与精选库
├─ play/ player/                                 # 播放器与播放器内核入口（IIFE 构建）
├─ export/                                       # 独立 HTML、打印/PDF、PNG、工程文件
├─ ui/ i18n/ sample/                             # 基元、文案、9 幕示例
tests/unit/                                       # 单测（jsdom）
scripts/                                          # dev server、播放器构建、截图 harness
doc/                                              # 设计与契约文档（00–09）
```

## 文档 / Docs

| 文档 | 内容 |
|---|---|
| [00 工程契约](doc/00-工程契约.md) | 技术事实、文件所有权、命令、回报格式 |
| [01 产品概述](doc/01-产品概述.md) | 定位、七条 AI 原生原则、四条主线 |
| [02 架构设计](doc/02-架构设计.md) | 模块图、数据流、关键决策、启动流程 |
| [03 数据模型与DSL](doc/03-数据模型与DSL.md) | Deck/Slide/Block/Theme 全字段、栅格、迁移 |
| [04 编辑器](doc/04-编辑器.md) | 画布、命中、拖拽/缩放/旋转、吸附、快捷键 |
| [05 SVG与3D渲染](doc/05-SVG与3D渲染.md) | 渲染契约、three 运行时、SVG/HTML 安全边界、lint |
| [06 AI编排](doc/06-AI编排.md) | provider 与错误码、5 套 prompt、修复环、12 配方与字阶自适应、溯源 |
| [07 播放与导出](doc/07-播放与导出.md) | 播放状态机与 5 种转场、讲者视图协议、独立 HTML 组装、PDF/PNG/工程文件 |
| [08 设计系统](doc/08-设计系统.md) | 两套令牌、6 套主题、字号阶、基元、可访问性 |
| [09 开发与验收](doc/09-开发与验收.md) | 命令、测试分层、DoD、常见问题 |

## License

待定（v0.1.0，私有仓库）。
