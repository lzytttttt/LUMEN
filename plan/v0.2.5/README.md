# LUMEN v0.2.5 · 中期迭代交付包（工作流编排 + 视觉打磨）

> **这是什么**：`0.2.0 → 0.2.5` 的半周期迭代计划与实现证据。六篇文档 + 两条主线（工作流编排 / 视觉与设计预设）+ 可核对的验收门禁。
> **不包含什么**：不加后端、不加多文档工作台、不做二进制材料解析、不新增配方与主题；对外契约只做**可选字段加法**。
> **一句话结论**：v0.2.0 把表单换成了造幕台，v0.2.5 把**用户动作串成一条路**（材料 → 大纲（可改） → 生成（可纠偏） → 开演（可续接）），并把**生成过程的动效与 6 套设计预设**再磨一轮；参照 OpenMAIC 的**使用逻辑**，不照搬它的技术栈。

---

## 1. 先看这七条

| # | 结论 | 在哪 |
|---|---|---|
| 1 | **材料先于提示词**：起念屏可挂 ≤5 条文本材料（粘贴 / 网址 / `.txt .md .json .csv`），每条 ≤4000 字，进 prompt 只取前 200 字摘要 | [00](00-范围与决策.md) D-25-2、[02](02-工作流编排与契约.md) §3.1 |
| 2 | **大纲是闸门**：卡内可改标题、写「要点」，`outline.slides[i].brief` 是唯一用户 → 生成侧的单幕指令通道 | [00](00-范围与决策.md) D-25-3、[02](02-工作流编排与契约.md) §3.4 |
| 3 | **生成中可纠偏**：一句话在**下一幕边界**生效，只改未落位幕，可撤销；不取消在跑的请求 | [02](02-工作流编排与契约.md) §2 约束 4、§3.2 |
| 4 | **开演后不跳出工作流**：播放 / 继续编辑 / 再加几幕，外加本机「最近一套」可恢复 | [01](01-迭代计划.md) T-25-05、[02](02-工作流编排与契约.md) §3.3 |
| 5 | **动效不造假**：七条新效果全部由 `ForgeStageEvent` 与 `prog` 驱动，四档回落（L3/L2/L1/L0）与 `?still=1` 逐条写清 | [02](02-工作流编排与契约.md) §6.1、[03](03-视觉动效.md) |
| 6 | **预设只打磨不新增**：6 套加 `texture/glow/elevation` 三个**可选** token，派生 `surface-2/accent-soft/shadow`，走 `themeCssVars` 单一通路，编辑器所见 = 导出所得 | [02](02-工作流编排与契约.md) §6.2、[04](04-设计预设.md) |
| 7 | **文字预算不放开**：材料 / 受众 / 预设 / 纠偏入口一律 ghost 级，`data-forge-text` 计数不变；唯一放行是 `cast.steerQueued` 进 F 类 | [00](00-范围与决策.md) D-25-6、[05](05-验收与测试矩阵.md) §4 |

---

## 2. 文档索引

| 文档 | 回答什么问题 |
|---|---|
| [00 范围与决策](00-范围与决策.md) | 交付四条、不做六条、术语表、**10 条锁定决策**、界面词规则、视觉基调、四档降级、风险登记、与 v0.2.0 的逐面对照 |
| [01 迭代计划](01-迭代计划.md) | M0–M4 五个里程碑、T-25-01…09 文件级任务与人日、并行纪律、P0/P1/P2 砍法、九道 Release Gate、十天时间线、工程风险 |
| [02 工作流编排与契约](02-工作流编排与契约.md) | **唯一契约源**：五个新动作、类型签名、模块签名、props、DOM 钩子、逐条文案定稿、七条动效表、3 个新 token、文件归属表 |
| [03 视觉动效](03-视觉动效.md) | FX-1…FX-7 的关键帧、时长、缓动、四档回落、可测钩子、与 v0.2.0 的差异 |
| [04 设计预设](04-设计预设.md) | 6 套色板前后对照、对比度实测表、新 token 语义、纹理/光晕/层次的取值理由、导出一致性证明 |
| [05 验收与测试矩阵](05-验收与测试矩阵.md) | 七层门禁、可测钩子表、F/D/V 三组用例、唯一允许的测试放宽、视觉基线人判判据、CI 顺序 |

阅读路径：

| 你是 | 按这个顺序读 |
|---|---|
| 产品 / 评审 | [00](00-范围与决策.md) §1–§5 → [02](02-工作流编排与契约.md) §1 → [05](05-验收与测试矩阵.md) §3 |
| 前端实现 | [02](02-工作流编排与契约.md) 全篇 → [03](03-视觉动效.md) → [04](04-设计预设.md) → [05](05-验收与测试矩阵.md) §2 |
| 视觉 / 设计 | [00](00-范围与决策.md) §6 → [04](04-设计预设.md) → [03](03-视觉动效.md) → [05](05-验收与测试矩阵.md) §5 |
| 发版负责人 | [01](01-迭代计划.md) §5 → [05](05-验收与测试矩阵.md) §1/§6 |

---

## 3. 实现落点（一屏看清改了什么）

| 面 | 落点文件 | 说明 |
|---|---|---|
| 材料 | `src/forge/materials.ts`、`src/forge/stage/Materials.tsx` | 上限、估算、坏数据丢弃全是纯函数；UI 只做 chip 与三入口 |
| 纠偏 | `src/forge/steer.ts`、`src/forge/stage/SteerBar.tsx`、`src/ai/compose.ts`（`liveOutline`） | "下一幕起生效"靠每幕开始前重取大纲实现 |
| 最近一套 | `src/forge/sessions.ts` | IndexedDB `forge/reuse`，最多 5 条，只存大纲 |
| 状态 | `src/forge/types.ts`、`state.ts`、`ui.ts`、`draft.ts` | 五个新字段、九个新动作；六条 reducer 硬约束 |
| 生成侧 | `src/ai/prompts.ts`、`src/ai/types.ts`、`src/schema/deck.ts` | `brief` / `materials` 进 payload；`outlineSlideSchema.brief?` 为可选加法 |
| 生成过程视效 | `src/forge/forge.css`、`fx/ambient.ts`、`stage/{Assemble,Gate}.tsx`、`hud/Pulse.tsx` | 七条效果 + 四档回落 + still 零动画 |
| 设计预设 | `src/themes/index.ts`、`src/render/slide.css`、`src/schema/deck.ts`（`themeSchema`） | 三个新 token + 派生色纯函数 + 纹理层 |
| 界面新样式 | `src/forge/flow.css` | 与 `forge.css` 物理隔离，避免并行冲突 |

---

## 4. 怎么核（四条命令）

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
pnpm build
pnpm e2e -- forge-flow
```

判据见 [05](05-验收与测试矩阵.md) §1。四档与 `?still=1` 的视觉基线：起念 / 大纲 / 生成 / 过检 / 开演五屏各截一张，与 `plan/v0.2.0/assets/forge-0*.png` 并排看结构是否漂移。

---

## 4.1 本轮实测（跑出来的，不是估的）

| 门禁 | 命令 | 结果 |
|---|---|---|
| G1 类型 | `tsc --noEmit` | **0 错** |
| G2 单测 | `vitest run` | **21 文件 / 438 用例全绿**（基线 19 / 362，新增 76 例） |
| G3 构建 | `pnpm build` | **成功**（`✓ built in 3.05s`，含 player 预构建） |
| G4 e2e | `playwright test`（全量） | **16 passed / 1.1m**（含 v0.2.5 新增两条：主链路、「再加几幕」） |
| G5 文字预算 | 含在 G2 | `Seed.tsx` text=5、`Deal.tsx`=2、`Hud.tsx`=1、`Materials.tsx`=0、`SteerBar.tsx`=0；`<input` 计数仍为 1 |
| G6 四档回落 | 源码 + 截图 | `[data-forge-tier='L0'] *` / `[data-forge-still='1'] *` 整层 `animation:none`；L3/L2/L1 各有明确列 |
| G7 导出一致 | 含在 G2 | `themeCssVars → themeVarsCss → 独立 HTML` 同一条变量表；真导出 HTML 用 `file://` 重开核对 computed style |
| G8 体积 | 与 `HEAD`（v0.2.0）对拍 | 首屏 `main` 538.6 → **542.8 KB**、`base` 318.2 → **319.3 KB**（合计 +5.3 KB raw ≈ +1.6 KB gzip，限值 +12 KB）；`ForgeApp` 仍是懒分块（55.9 → 75.1 KB，不进首屏）；`three` 仍懒加载 |
| G9 隐私 | `git diff` 审 | `src/persistence/**` 零改动，无新增网络请求、无遥测 |

> 对拍方式：`git worktree add --detach <tmp> HEAD` + `node_modules` 目录联接，两边各跑一次 `vite build` 比 `dist/assets` 体积，比完 `git worktree remove`。

---

## 5. 视觉样张（本轮实拍，`?still=1` 静态基线）

| 文件 | 说明 |
|---|---|
| [`assets/forge-25-01-seed.png`](../../../plan/v0.2.5/assets/forge-25-01-seed.png) | 起念屏：一句话 + 三张示例 + **ghost 级「材料 / 受众 / 预设」**（文字块仍是 5，主按钮在 dock） |
| [`assets/forge-25-02-materials.png`](../../../plan/v0.2.5/assets/forge-25-02-materials.png) | 材料篮展开：加料 → 粘贴 / 网址 / 文件三入口 |
| [`assets/forge-25-03-deal.png`](../../../plan/v0.2.5/assets/forge-25-03-deal.png) | 大纲：9 幕卡阵 + 页头预设色点 + 「要点」入口 |
| [`assets/forge-25-04-deal-brief.png`](../../../plan/v0.2.5/assets/forge-25-04-deal-brief.png) | 逐幕编辑：卡内改标题、写要点（焦点回收到卡片） |
| [`assets/forge-25-05-premiere.png`](../../../plan/v0.2.5/assets/forge-25-05-premiere.png) | 开演席：弧线 + **继续编辑 / 再加几幕**（「回编辑器」已并入继续编辑），accent 光晕取主题 |
| [`assets/theme-25-noir.png`](../../../plan/v0.2.5/assets/theme-25-noir.png) | 预设 `noir`：暖墨灰 + grain 0.07 + layered |
| [`assets/theme-25-terminal.png`](../../../plan/v0.2.5/assets/theme-25-terminal.png) | 预设 `terminal`：扫描线纹理 + 荧光绿 accent + flat 层次 |
| [`assets/theme-25-paper.png`](../../../plan/v0.2.5/assets/theme-25-paper.png) | 预设 `paper`：圆形点阵 + 朱砂点 + raised 阴影 |

拍法：`?onboard=0&still=1`，用 Playwright 真跑一遍「起念 → 材料 → 大纲 → 要点 → 生成 → 开演」，控制台 **0 error**。

---

## 6. 本轮明确不做的事（避免误读）

| 声明 | 事实 |
|---|---|
| 不做二进制材料解析 | PDF/Word/PPT 需 WASM 解析器，半周期放不下；只收文本 |
| 不做云端会话 / 断点续跑 | 纯前端本地工作台，"可恢复"用 IndexedDB 的 `forge/draft` 与 `forge/reuse` |
| 不开多文档工作台 | 单套闭环的续接，多文档留给 `0.3.0` |
| 不改 Deck/Outline 的必填字段 | 只加 `outline.brief?`、`theme.texture?/glow?/elevation?`；`migrate.ts` 零改动 |
| 不动播放器 / 导出 / lint 阈值 | 避免把 v0.2.0 的验收基线一起推翻 |
