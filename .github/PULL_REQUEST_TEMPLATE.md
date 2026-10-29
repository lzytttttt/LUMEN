<!--
PR 标题沿用仓库提交信息风格：<type>(<scope>): <中文摘要>
例如：feat(forge): 大纲段支持按幕重排后回写配方
     fix(export): 独立 HTML 在 file:// 下丢失打印样式
详见 CONTRIBUTING.md「提交信息风格」。
-->

## 改了什么

<!-- 一段话讲清动机与做法；只列结论，细节放代码里。 -->

## 关联 issue

<!-- 例如 Closes #123 / Refs #456；没有就写「无」。 -->

## 改动类型

- [ ] feat — 新能力
- [ ] fix — 修缺陷
- [ ] docs — 只改文档
- [ ] build — 构建、依赖、部署配置
- [ ] chore — 杂项（版本号、清理、重命名）
- [ ] refactor / perf / test — 重构、性能、测试（可与上面的 type 组合）

## 验证命令

<!-- 在仓库根逐条跑过再勾；命令以 package.json 为准。 -->

- [ ] `pnpm typecheck` — 0 error
- [ ] `pnpm test` — 单测全绿（`tests/unit/**`）
- [ ] `pnpm lint:i18n` — zh / en 键对等（改了文案必须跑）
- [ ] `pnpm build` — 生产构建通过，`dist/` 正常产出
- [ ] `pnpm e2e` — Playwright 全绿（自动在 5274 拉起 dev server；本机没装 Chrome 时说明跳过了）
- [ ] `pnpm build:player` — 改了 `src/render/**`、`src/play/**` 或 `src/player/**` 时重跑播放器内核
- [ ] CI 绿 — `.github/workflows/ci.yml` 的 `verify`（test / typecheck / build）与 `e2e` 两个 job 都通过

手工确认（勾上表示真的点过）：

- [ ] 首屏 3 秒内出 9 幕示例，控制台无 error
- [ ] 造幕台五段可走完（`?still=1&channel=replay&speed=0` 下零等待复现）
- [ ] 刷新后内容仍在（IndexedDB 持久化未被破坏）

## 工程契约

- [ ] 没有绕过 `src/state/ops.ts` 直接改 deck 对象；新增写操作走 `deckOps` / `slideOps` / `blockOps` / `historyOps`
- [ ] 没有改 `src/schema/deck.ts` 的字段名或结构（确需改动已在 issue 里与维护者对齐，并同步 `factory.ts`、`migrate.ts`、示例 deck）
- [ ] 没有新增运行时依赖（新增即说明必要性）
- [ ] 舞台仍是 1600 × 900 设计像素，缩放只在最外层做一次 `transform: scale()`
- [ ] 没有引入外链字体或远程资源
- [ ] 改动落在自己模块的写入域内；共享文件（`src/i18n/messages/editor.{zh,en}.ts`）只用局部插入

## i18n

- [ ] 新增或修改的 UI 文案在 zh 与 en 两侧同时补齐，键名与插值占位符一一对应
- [ ] UI 里没有硬编码中文（deck 内容、示例与 AI 生成物除外）
- [ ] 涉及造幕台文案预算时，`tests/unit/forge-copy.test.ts` 仍然绿

## 导出与兼容

- [ ] 导出的单文件 HTML 在 `file://` 下仍可播：首屏渲染、方向键翻页、零外部请求
- [ ] `?print=1` 的打印页数等于幕数
- [ ] `.lumen.json` 可导出再导入，素材随文件走
- [ ] 导出体积没有异常膨胀（素材内联超过 12MB 会提示，超过 24MB 直接中止产出）
- [ ] 未提交 `public/player/` 构建产物（它被 `.gitignore` 排除）

## 截图 / 录屏

<!-- 有界面变化就贴；造幕台五态用 ?still=1 拍。改动前后各一张更好。 -->

## 许可与 DCO

- [ ] 我确认自己有权提交这些代码，并同意按仓库当前许可（Apache-2.0 + Commons Clause）以 inbound=outbound 方式授权给本项目，同时允许按 FSL-1.1-MIT 备选路径再许可（见 [LICENSING.md](../LICENSING.md)）
- [ ] 每个提交都带 `Signed-off-by`（`git commit -s`），即 Developer Certificate of Origin 1.1
- [ ] 没有引入来源不明或授权不兼容的第三方代码、字体、图标与素材（示例文案与截图不在源码许可内，新增时已注明）
