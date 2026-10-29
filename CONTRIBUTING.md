# 参与 LUMEN 开发

LUMEN（幕光）是浏览器里的 AI 原生演示工作台：没有后端、没有遥测、不加载外链字体，数据只在本地 IndexedDB，模型端点由使用者自己填。
本文件是给贡献者看的操作手册——环境、命令、目录、契约、提交与许可。工程事实的权威版本在
[doc/00-工程契约.md](doc/00-工程契约.md) 与 [doc/09-开发与验收.md](doc/09-开发与验收.md)，两者冲突时以文档为准，并请顺手提 PR 修正本文。

- 用法提问、方案探讨、作品展示 → [Discussions](https://github.com/lzytttttt/LUMEN/discussions)
- 缺陷 → [Bug 报告表单](https://github.com/lzytttttt/LUMEN/issues/new?template=bug_report.yml)
- 需求 → [功能需求表单](https://github.com/lzytttttt/LUMEN/issues/new?template=feature_request.yml)
- 安全漏洞 → **不要开公开 issue**，按 [SECURITY.md](SECURITY.md) 私下报告
- 协作礼仪 → [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 1. 五分钟上手

前置：**Node.js 22.x** 与 **pnpm ≥ 10**（`package.json` 的 `engines` 锁定这两个下限）。

```powershell
pnpm install        # 装依赖
pnpm dev            # 先构建播放器内核（predev），再拉起 Vite，固定端口 5273
```

打开 <http://127.0.0.1:5273>，3 秒内应看到 9 幕示例。造幕台的离线回放地址（零外网请求、零等待，调试与截图都用它）：

```text
http://127.0.0.1:5273/?channel=replay&speed=0
http://127.0.0.1:5273/?still=1&channel=replay&speed=0      # 再叠一层降级档 L0，动效全关
```

> 端口约定：**5273** 是开发 / 预览端口，`strictPort` 打开，同一时刻只允许一个实例——已经在跑就复用，不要再起第二个；**5274** 是 e2e 专用，`playwright.config.ts` 的 `webServer` 会自动拉起并可复用。

## 2. 命令

以下全部来自 `package.json` 的 `scripts`，没有额外自造脚本：

| 目的 | 命令 | 说明 |
|---|---|---|
| 安装依赖 | `pnpm install` | 生成 / 对齐 `pnpm-lock.yaml` |
| 开发服 | `pnpm dev` | `predev` 先构建播放器内核；端口 5273 |
| 类型检查 | `pnpm typecheck` | `tsc --noEmit`，验收底线是 0 error |
| 单元测试 | `pnpm test` | `vitest run`，jsdom 环境，`tests/unit/**` |
| i18n 键对等 | `pnpm lint:i18n` | 等价于 `vitest run tests/unit/i18n.test.ts` |
| 生产构建 | `pnpm build` | `prebuild` 先构建播放器内核，再 `tsc --noEmit && vite build` |
| 播放器内核 | `pnpm build:player` | 改了 `src/render/**`、`src/play/**`、`src/player/**` 之后必须重跑，否则导出的 HTML 还是旧渲染器 |
| 端到端 | `pnpm e2e` | Playwright，自动在 5274 拉起开发服；默认单 worker、Chrome + SwiftShader |
| 截图 harness | `pnpm snapshot` | 产出 `harness/out/*.png` 与 `console-errors.json`（后者必须是空数组），产物不入库 |

本机 `pnpm` 不在 PATH 时，等价写法是直接调用 `node_modules` 里的入口（本仓库的验收就是这么跑的）：

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node node_modules/@playwright/test/cli.js test
```

## 3. 目录地图

```text
src/
├─ schema/        # 数据契约（zod）与几何、工厂函数 —— 唯一契约层
├─ state/         # zustand + immer；ops.ts 是唯一写入口
├─ persistence/   # IndexedDB 封装（单库 lumen-deck）
├─ render/        # 唯一渲染器：stage / play / thumb / print / export 五种 mode
├─ lint/          # 溢出 / 对比度 / 字号 / 3D 预算 / 阅读时长
├─ editor/        # 画布交互、幕栏、检查器、工具栏、快捷键
├─ ui/            # 基元、弹窗、代码编辑器
├─ ai/            # provider 与通道（mock / openai / replay）、prompts、配方
├─ forge/         # 造幕台：状态机、五段舞台、降级档、游戏层、演出节奏
├─ studio/        # SVG / 3D 工作室与精选库
├─ play/          # 播放器、转场、讲者视图
├─ player/        # 播放器内核入口（IIFE 构建，产物在 public/player/）
├─ export/        # 独立 HTML、打印 / PDF、PNG、工程文件
├─ themes/ styles/  # 6 套主题与 CSS 令牌
├─ i18n/          # 文案（zh 为类型源，en 同键）
├─ fixtures/ai/   # replay 的离线 fixture，静态打包
├─ onboarding/ portal/ sample/  # 首启三步 / 门户 / 9 幕示例
└─ version.ts     # 版本号唯一来源
tests/unit/       # 纯逻辑单测（jsdom）
tests/e2e/        # Playwright 端到端
scripts/          # dev server、播放器构建、截图 harness、导出探针
doc/              # 设计与契约文档（00–10）
plan/             # 各版本的范围与证据
```

`public/player/` 是**构建产物**，被 `.gitignore` 排除，不要提交。

## 4. 工程契约（改代码前必读）

1. **组件不直接改 deck 对象。** 所有写操作走 `src/state/ops.ts` 的 `deckOps` / `slideOps` / `blockOps` / `historyOps`，或在 `transaction(label, fn)` 里组合。直接改 `deck` 会绕过 immer 补丁历史，撤销 / 重做当场失真。
2. **`src/schema/deck.ts` 是唯一数据契约。** 字段名与结构改动要先在 issue 里对齐，并同步 `factory.ts` 默认值、`migrate.ts` 升级分支、`sample-deck.ts` 示例。
3. **舞台固定 1600 × 900**（安全边距 120 / 96）。块几何都是设计像素，缩放只在最外层做一次 `transform: scale()`。
4. **不新增运行时依赖**，缺能力先提 issue 讨论；依赖版本以 `package.json` 为准（React 19 / Vite 7 / TypeScript 5.9 / zod 3 / zustand 5 / immer 11 / three r186 / DOMPurify 3 / CodeMirror 6）。
5. **不加载外链字体、不接入远程资源**，只用系统字体栈与 `--d-*` 令牌。
6. **净化入口唯一**：SVG 走 `src/render/svg/sanitize.ts`，HTML 块在 `sandbox="allow-scripts"` 的 iframe 里跑（无 `allow-same-origin`）。不要在别处再开一个注入点。
7. **导出的独立 HTML 与编辑器同源**：改渲染器后记得 `pnpm build:player`，否则 `file://` 打开的是旧内核。

## 5. i18n 规则

- `t('ns.key', vars)` / `useT()` 取文案，zh 是类型源，**en 必须同键同结构**；`pnpm lint:i18n` 会做全量比对，缺键即红。
- 命名空间（`src/i18n/messages/<ns>.{zh,en}.ts`）：`common`、`editor`、`ai`、`play`、`export`、`studio`、`forge`、`portal`、`onboard`。
- 插值占位符两侧必须一致（`{count}` 不可只在一边出现）。
- UI 里不硬编码中文；deck 内容（示例、AI 生成物、用户输入）不受这条约束。
- 共享文件 `src/i18n/messages/editor.{zh,en}.ts` 只做局部插入，不要整文件覆盖。

## 6. 测试要求

| 改了什么 | 至少要跑的 |
|---|---|
| 纯逻辑（几何、状态机、schema、净化、lint、配方） | `pnpm typecheck` + `pnpm test` |
| 界面文案 / i18n | `pnpm test`（含 `i18n.test.ts`）或 `pnpm lint:i18n` |
| 渲染器、播放器、导出 | `pnpm build:player` + `pnpm test` + `pnpm e2e` |
| 主链路交互（首屏、撤销、翻页、file:// 播放、打印、造幕台） | `pnpm e2e` |
| 视觉相关 | `pnpm snapshot`，确认 `harness/out/console-errors.json` 为 `[]` |

- 新增用例放在 `tests/unit/<area>.test.ts`，**新文件**即可，不要改既有测试文件的期望值来迁就实现——先确认规则本身是否要变。
- jsdom 缺的浏览器 API 统一补在 `tests/setup.ts`（目前是 `ResizeObserver`、`window.matchMedia`、`URL.createObjectURL` / `revokeObjectURL`），不要在各自用例里各拍一份 mock。
- 交付底线：`pnpm typecheck` 0 error、`pnpm test` 全绿、`pnpm build` 通过、控制台无 error。

## 7. 提交信息风格

`<type>(<scope>): <中文摘要>`，`type` 用下面这一组，`scope` 用模块目录名（`forge` / `export` / `render` / `i18n` / `deploy` / `readme` …），摘要用中文、写清结果而不是过程：

```text
feat(forge): v0.2.0 造幕台五段闭环 + 门户入口 + 首启三步
fix(export): 独立 HTML 在 file:// 下丢失打印样式
docs(readme): 新增英文版 README（README.en.md）
build(deploy): Vercel 静态部署配置，.gitignore 补漏
chore(release): v0.2.0 — 版本号与许可更新
```

| type | 用在 |
|---|---|
| `feat` | 新能力、新界面、新通道 |
| `fix` | 修缺陷（含回归） |
| `docs` | 只动文档、注释、模板 |
| `build` | 构建、依赖、部署配置 |
| `chore` | 版本号、清理、重命名等杂项 |

一条提交只做一件事；跨模块的大改拆成可独立回滚的几条。发版只改 `src/version.ts` 与 `package.json` 的版本号，二者必须一致。

## 8. 分支与 PR

1. Fork 或在本仓库开分支：`feat/<topic>`、`fix/<topic>`、`docs/<topic>`。
2. 改动控制在自己模块的写入域内；跨域需求（新 store action、新基元、新 i18n 命名空间、新依赖）先在 issue 里谈。
3. 按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md) 填写：改动摘要、关联 issue、验证命令、i18n、导出兼容、截图。
4. 推送前本地跑过 §6 的对应命令，并在 PR 描述里贴结果（哪些绿、哪些跳过、为什么）。
5. GitHub Actions 的 [CI](.github/workflows/ci.yml) 会先跑 `pnpm install --frozen-lockfile` → `pnpm test` → `pnpm typecheck` → `pnpm build:player` → `pnpm build`，再单独一个 job 跑 `pnpm e2e`（Ubuntu + 品牌 Chrome）；两组都绿才进入评审。
6. 维护者会看三件事：是否绕过了契约层、是否保持双语与导出兼容、是否带 DCO 签名。

不要提交 `dist/`、`public/player/`、`harness/out/`、`test-results/` 与任何 `.env*`（密钥只应存在于使用者浏览器里）。

## 9. 许可与贡献授权

### 当前许可

`v0.2.5` 起源码从 **CC BY-NC 4.0** 迁移到 source-available 许可；`v0.2.0` 及更早版本保持发布时的 CC BY-NC 4.0，不追溯变更。
权威导读是 [LICENSING.md](LICENSING.md)，法律文本是根目录的 [LICENSE](LICENSE) 与 [LICENSE-FSL-1.1-MIT.md](LICENSE-FSL-1.1-MIT.md)。

| 内容 | 依据 |
|---|---|
| 源码（默认路径）：**Apache-2.0 + Commons Clause** | [LICENSE](LICENSE)。保留 Apache-2.0 的全部自由（含 §3 专利授权），只加一条：不得把 LUMEN 本身或改名后的等价物作为付费产品 / 付费 SaaS / 付费模板包出售或提供收费托管 |
| 源码（备选路径）：**FSL-1.1-MIT** | [LICENSE-FSL-1.1-MIT.md](LICENSE-FSL-1.1-MIT.md)。两年内不得做与本软件竞争的商业产品，该版本发布满两年后自动转为 MIT |
| 设计资产与示例文案：**CC BY-NC 4.0** | 截图、品牌视觉、`src/sample/**`、`src/fixtures/**`、`src/ai/corpus.ts`、`src/ai/recipes.ts` 里的示例内容；代码结构仍按源码许可 |
| `LUMEN` / `幕光` 名称与 Logo | 保留商标权，见 [TRADEMARK.md](TRADEMARK.md)；Apache-2.0 §6 不授予商标许可 |
| 第三方依赖 | 各自原许可，见 [NOTICE](NOTICE) |

两条源码路径是**二选一（at your option），不是叠加**：对同一次使用选定一条并遵守它即可；项目自身发布的版本按默认路径（Apache-2.0 + Commons Clause）分发。
Commons Clause 不是 OSI 认可的开源许可，对外描述本项目请用 **source-available（源码可用）**，别写成 "open source"；也正因为 SPDX 没有对应表达式，`package.json` 的 `license` 字段写作 `SEE LICENSE IN LICENSE`。

商业授权（转售、以 LUMEN 为核心的付费托管、示例文案与截图的商业交付、品牌联名、书面保证或私有分支）请邮件 <lzytttttt@gmail.com>，标题注明 `LUMEN Commercial License`。

### inbound = outbound

本项目**没有 CLA**，采用 inbound=outbound：你在 PR 里提交贡献，即表示该贡献按仓库当前的源码许可（Apache-2.0 + Commons Clause）授权给项目与所有下游使用者，并允许维护者按 FSL-1.1-MIT 备选路径再许可——两条路径是同一份代码的两种可用方式，不额外收费，也不影响你已经获得的授权。不附加额外条款、不保留额外限制。

### DCO（Developer Certificate of Origin 1.1）

用 `-s` 提交，让每个提交自带签名行：

```powershell
git commit -s -m "docs(contributing): 补充贡献授权与 DCO 说明"
```

签名行形如：

```text
Signed-off-by: 你的名字 <you@example.com>
```

签名即声明（[DCO 1.1](https://developercertificate.org/) 要点）：

1. 该贡献全部或部分由你创作，且你有权按本项目许可提交；
2. 该贡献基于先前作品时，你已标明来源与其许可，并有权在此基础上提交；
3. 你理解本项目与贡献是公开的，贡献记录（含姓名与邮箱）会长期保留；
4. 你理解本项目按现行许可分发，以「现状」提供，未附任何担保。

署名用真实身份或长期使用的笔名均可，但邮箱要能联系到你。忘了加 `-s` 就在推送前 `git commit --amend -s`（多条提交用交互式 rebase 补）。

**不要**提交来源不明或授权不兼容的第三方代码、字体、图标与素材；确需引入请在 PR 里写明来源、版本与许可。

## 10. 行为与安全

- 参与本项目即视为同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)（Contributor Covenant 2.1 精简版）。
- 发现漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，公开 issue 里贴 PoC 会让所有使用者一起承担风险。
- 提问时请附版本、运行方式、复现步骤与 `?still=1&channel=replay&speed=0` 下的复现结果；分享诊断 JSON 前先清掉端点与私人内容。

谢谢你把时间花在这里。
