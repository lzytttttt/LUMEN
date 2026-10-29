# 变更日志 / Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循语义化版本。
条目只写用户可见的变化；阈值、实现细节与验收编号见 `plan/v0.2.0/` 与 `plan/v0.2.5/`（`05-验收与测试矩阵.md`、`01-迭代计划.md`）。这些文档与拆解只留在本地工作副本，不随仓库发布。

## [0.2.5] - 2026-10-29

中期迭代：把「材料 → 大纲（可改）→ 生成（可纠偏）→ 开演（可续接）」串成一条路，并把生成过程的动效与 6 套设计预设再磨一轮。对外契约只做可选字段加法，v0.2.0 的项目/草稿/回放数据原样可读。

### Added

- **材料先于提示词**：起念屏可挂最多 5 条文本材料（粘贴 / 网址 / 本地 `.txt .md .json .csv`），每条 4000 字上限，只把前 200 字摘要喂进大纲与单幕 prompt；超限给短句提示，不打断输入。
- **受众与设计预设可选**：起念屏与大纲页头都能选受众（高管 / 团队 / 客户 / 课堂）与 6 套设计预设之一，选择真正进入生成请求。
- **大纲是闸门**：卡内可改标题、写「要点」（这一幕想讲什么），要点是唯一从用户直达生成侧的单幕指令；首末锁与换卡环不变。
- **生成中可纠偏**：生成过程中写一句话，**在下一幕边界**生效，只影响未落位的幕，可撤销；不取消在跑的请求、不白花已经付过的 token。
- **开演后不跳出工作流**：播放 / 继续编辑 / 再加几幕三枚下一步；「再加几幕」会补齐完整大纲项，加完可直接再生成。
- **最近一套**：本机保留最近 5 套大纲（只存大纲，不存成品），起念屏一键恢复。
- **生成过程动效**：落位冲击波、完成栈深度分层、环形进度（替代线性条）、环境粒子随进度加速并在落位时脉冲、开演席卡片扫光与画面收束、过检火花按性能档分级（12/6/3/0 点）。
- **设计预设新 token**：`texture` / `glow` / `elevation` 三个可选字段，派生出 `surface-2` / `accent-soft` / 两级阴影共 9 个新 CSS 变量；编辑器与导出同一条变量表。

### Changed

- 6 套预设逐套打磨：`museum` 的 muted 从 4.40 修到 6.07（此前唯一不达标的对比度），其余调整 `muted` / `line` / `accent2` 与 `typeOverrides`；六套现在都有 display/h1/h2/lead 四档取向，**字号与 12 配方版式零位移**。
- 幻灯片底色多了一层极淡纹理（`terminal` 扫描线最明显、`museum` 刻意留白）、左上角 accent 光晕（仅播放时呼吸）、媒体框按层次档配备阴影；`?still=1`、`prefers-reduced-motion`、缩略图与打印一律静止。
- 速度环/进度条改为环形，`?still=1` 与锁档环境下新动画整层 `animation: none`。

### Fixed

- **加幕后再生成必崩**：`state.add` 只往卡片数组插一项、不同步大纲，导致 `syncOutline` 产出缺 `visual` 的残缺项，生成期抛非 `AiError` 并显示成「网络断了」。现在加幕会同步插入完整大纲项，另有兜底，`outlineSchema` 校验通过。
- 文案「编辑」在大纲页与开演页指向不一致，统一为「继续编辑」。
- 纠偏输入框的 `Esc` 只清当前一句，不再连带退出造幕台。
- **开演席的「回编辑器」并入「继续编辑」**：两枚做的是同一件事（关台 + 定位到这一套），并排出现只会让用户白选一次。关台的出口统一为 HUD 返回键与 `Esc`。

### Docs

- 新增 `plan/v0.2.5/`：`00` 范围与决策（10 条）、`01` 迭代计划（九道门禁）、`02` 工作流编排与契约（唯一契约源）、`03` 视觉动效（FX-1…FX-7 与四档回落）、`04` 设计预设（对比度实测）、`05` 验收与测试矩阵。
- `doc/08-设计系统.md` 增 §11：v0.2.5 的纹理 / 光晕 / 层次与 9 个新变量、accent 使用规则。
- 已知局限登进 `02` §7.1 与 `05` §4.1：要点不随卡片换序移动、纠偏不改已落位幕、材料只收文本、最近一套只存大纲。
- **仓库只发布图片**：`doc/*.md` 与整份 `plan/` 加进 `.gitignore`，只留本地工作副本；README 的文档表改成「本地保留 + 向作者索取」，仓库内仍保留 `doc/screenshots/` 的全部截图。

## [Unreleased]

### Added

- **许可迁移**：源码从 `CC BY-NC 4.0` 改为 **Apache-2.0 + Commons Clause**，并提供 **FSL-1.1-MIT** 备选路径（二选一）。新增 `LICENSE`（Apache 全文 + Commons Clause 条款）、`LICENSE-FSL-1.1-MIT.md`、`LICENSING.md`（范围矩阵 / 商业授权 / 贡献规则）、`NOTICE`、`TRADEMARK.md`；`package.json` 的 `license` 改为 `SEE LICENSE IN LICENSE`。设计资产与示例文案仍按 `CC BY-NC 4.0`。
- **GitHub Actions CI**（`.github/workflows/ci.yml`）：push/PR 自动跑 `pnpm test`、`typecheck`、`build:player`、`build` 并校验产物；独立 E2E job 安装 Chrome 跑 Playwright，失败上传报告。
- **Vite 细粒度拆包**：`manualChunks` 把 three / CodeMirror / React / zod / 状态层拆为独立 chunk，`chunkSizeWarningLimit` 从 2500KB 降到 1200KB，不再用阈值掩盖大包。
- **PNG 导出可恢复**：导出前预检缺失素材并点名页码；单幕失败保留 `{ slideId, index, reason }` 清单，弹窗展示失败页与原因，支持"只重试失败页"。
- **单文件 HTML 素材重采样**：内联前把大图压到 ≤1920px WebP（质量 0.82），只有确实变小才替换；导出弹窗提供开关，warnings 汇报节省体积与失败数。
- **AI JSON 截断修复**：`closeTruncatedJson` 在 `JSON.parse` 失败后补齐未闭合字符串/对象/数组、清理悬空逗号/冒号；`parseWithRepair` 在无完整 JSON 时也会尝试修复，减少 `none` 降级模式下的坏稿。
- **可选 CORS 转发模板** `api/llm-proxy.ts`：Vercel Edge Function，默认主机白名单、无日志/无落盘、流式透传，仅供浏览器直连被 CORS 拦截时自部署。
- **本地文件自动落盘**：支持 File System Access API 的浏览器可把工程关联到本地 `.lumen.json`，自动保存时按 4s 节流镜像（含素材），设置页可关联/更换/解除；不支持时保持原行为。
- **PWA 离线安装**：新增 `manifest.webmanifest`、192/512 与 maskable 图标、手写 `sw.js`（版本化缓存、导航 network-first、静态资源 SWR、跨域与 `?print` 不接管、`cache.match` 忽略 `Vary`）与 `src/pwa/register.ts`（仅生产注册）。Vite 产出 `asset-manifest.json`，SW 在 install 时预缓存全部 chunk，首次在线访问后断网也能启动（已实测 28 个缓存项、零 console error）。
- **资产引用计数 GC**：启动空闲时汇总所有 deck 引用的 assetId，删除超过 24h 保护期的孤儿 Blob；任一 deck 解析失败则整轮跳过，避免误删。
- **CSP 纵深防御**：`vercel.json` 增加 `Content-Security-Policy`（限制脚本/连接/框架来源）；导出的单文件 HTML 增加 `default-src 'none'` 的 meta CSP，只放行内联脚本样式与 data:/blob: 图片。
- **社区协作模板**：`.github/ISSUE_TEMPLATE`（config / bug / feature）、`PULL_REQUEST_TEMPLATE.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`。
- 新增 `doc/11-许可与合规.md`；README 顶部加入造幕台五段流转动图（`doc/screenshots/forge-flow.webp`）。
- 单元测试新增：`gc.test.ts`、`asset-compress.test.ts`、`json-repair.test.ts`。
- Vercel 部署：`vercel.json`（Vite 框架、`pnpm build` → `dist/`、`/portal` → `portal.html` 重写、`assets/*` 长缓存 + `player/*` 与两个 HTML 入口 must-revalidate、基础安全头 + CSP）、`.vercelignore`、`package.json` 的 `engines.node: 22.x`。纯静态产物，部署侧零环境变量；`api/llm-proxy.ts` 为可选 Edge 函数。
- `pnpm run deploy:preview` / `pnpm run deploy:prod` 两个脚本（内部 `npx --yes vercel`，不要求全局安装）。
- `.gitignore` 补 `.vercel/`（CLI 链接信息含 projectId / orgId）、`.env*`（保留 `.env.example`）、`public/player.bak/`。

### Changed

- 部署脚本由 `deploy` 改名 `deploy:preview`：`pnpm deploy` 会解析到 pnpm 内建的 workspace 部署命令并盖掉同名脚本。
- `package.json` 增加 `engines.pnpm: ">=10"`；CI 使用 Node 22 + pnpm 11（与 lockfile v9 对齐）。
- 门户页与关于对话框的许可文案、链接同步到新许可；`LICENSING.md` 说明历史版本不追溯。
- 导出的单文件 HTML 默认压缩素材，体积护栏的 12MB/24MB 仍按压缩后的 HTML 计算。

### Fixed

- PNG 导出不再只把失败写进 `console.warn`：失败页会出现在弹窗清单里并可单独重跑。
- `closeTruncatedJson` 修复了"围栏未闭合 + JSON 截断"时 `extractJson` 直接返回 null 的问题。
- 自动保存 flush 后同步触发本地文件镜像，页面隐藏/关闭时尽量补写最后一版。

### Docs

- 新增英文版 README（`README.en.md`），与中文版逐节对齐（11 个二级标题、43 行表格、32 个相对链接一一对应）；两版顶部互加语言切换。
- 新增 `doc/10-Vercel部署.md`：硬事实、Git 导入与 CLI 两条路径、缓存头、五个坑、上线验收清单；`doc/README.md` 索引与「十篇齐了」的表述同步为 00–10。
- `doc/10` 补充 CSP、可选 Edge 代理与 PWA 缓存说明；`doc/09` 补充 CI 与新增验证命令；`doc/README.md` 索引扩到 00–11。

## [0.2.0] - 2026-10-28

造幕台版本：整屏一键成幕，把「一句话 → 大纲 → 成稿 → 检查 → 播放」收进同一个台面。

### Added

- 造幕台（Forge）：输入 / 大纲 / 生成 / 检查 / 播放五段闭环；关闭即回画布，已完成的幕立刻在册，一次撤销回到造幕前。
- 独立门户 `portal.html`（`?portal=1` 同源）：瀑布式长页，含产品理念（四个真实顾虑）、五步用法、五种真实界面窗口、六项能力、偏好设置与最终召唤、作者与许可；作者头像取自 GitHub（@lzytttttt），联系方式 `lzytttttt@gmail.com`；设置抽屉（生成通道 / 接口预设 / 画面档位 / 音效 / 减少动效 / 语言）进入工作台即生效。
- 首启三步：打开台面 → 生成一套 → 播放；右下角小卡，真实动作点亮，不遮罩、不拦操作、可跳过。
- 四个造幕台入口：顶栏、命令面板、空幕 CTA、幕栏「+」长按 400ms（短按仍是新建空白幕）。
- 演出节奏：按 `plan/v0.2.0/mock/forge.html` 的时间线排队落位（输入 640ms、每幕 560ms、最后一幕到开演席 560ms、重铸 760ms），快模型也不会一屏跳完；`?still=1` / `?speed=0` 为 0 等待。
- 游戏化：连击、熟练度、成就，全部本地计算、零阻塞、不解锁任何功能（简档只开 3 条成就）。
- 过检（Gate）：`lintDeck` 的 error 变成看得见的卡点，warn 变成星标；error 触发一次兜底重排，仍不过则标「卡住」。
- 通道：真端点流式（SSE）、`replay` 离线回放、退避重试、响应缓存、预设档（DeepSeek / OpenAI / Ollama / 自建网关）。
- 降级档 L0–L3：WebGL → Canvas2D → CSS → 静态，判定一次不翻转，可在设置里锁档；`?still=1` 强制 L0。
- 设置页新增造幕台段：档位、玩法、音效、自动播放、流式开关、重置进度、导出诊断 JSON（`lumen-diagnostics.json`，用户手动导出，无遥测）。

### Changed

- 默认生成入口从右栏表单改为造幕台（顶栏「✦ 生成」与命令面板都能进）；旧面板保留为「精确模式」，功能不删。
- 项目许可改为 **CC BY-NC 4.0**（署名 · 非商业性使用 4.0 国际），完整法律文本见 `LICENSE-CC-BY-NC-4.0.txt`；作者 无极Ayaya，项目地址与联系方式见 README 与门户页。
- `ComposerPanel` 的进度、取消、报错文案收敛到与造幕台同一套短句。
- IndexedDB 版本从 2 升到 3：新增 `forge`（进度/草稿）与 `aiCache`（响应缓存）两个 store，既有三个 store 不动。

### Fixed

- 流式增量在响应缺少 `usage` 字段时不再空指针。
- 错误统一收敛成短句 + 一个动词按钮，不再直出英文原文或堆栈。
- L3 台面的环境粒子在退出装台时释放 rAF 订阅与 three 资源（`fx/ambient.ts` 的 `dispose()`）。

### Performance

- three 仍是懒分块：首屏不请求，进入装台才拉。
- 单幕落位 220–420ms，掉帧 ≤ 2；单条长任务 ≤ 50ms。
- 造幕台文案按类别卡字数（阶段词 ≤ 4 字、按钮 ≤ 3 字、主按钮 ≤ 4 字），屏幕文字块 ≤ 6 组。

### Accessibility

- 造幕台全键盘可走完五段：`Tab` 焦点陷阱、`Enter` 提交、`←/→` 选卡、`Esc` 退出并把焦点还给触发按钮。
- 只有一个 `aria-live="polite"` 区域且节流 ≥ 1.5s；逐幕进度只改 `aria-valuenow`，不刷屏。
- `prefers-reduced-motion` 与省电模式降到 L1/L0，状态始终有文本可读。

### Docs

- 新增 `plan/v0.2.0/00–09`（范围、迭代、界面、游戏化、动效、LLM、端到端、验收、发布、文案）。
- README 换成造幕台视角；`doc/05`–`doc/09` 补「v0.2.0 已实现 / 未实现」。
