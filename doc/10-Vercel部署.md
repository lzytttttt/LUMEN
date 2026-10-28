# 10 部署到 Vercel

> 结论：本项目是**纯静态**产物（无后端、无 SSR、无环境变量），Vercel 只需 `pnpm build` + 输出 `dist/`。
> 已随仓库落地四份配置：`vercel.json`、`.vercelignore`、`package.json` 的 `engines.node`，以及 `.gitignore` 里的 `.vercel/`（CLI 的本地链接信息含 projectId，不入库）。

## 硬事实（决定配置形态）

| 事实 | 出处 | 对部署的影响 |
|---|---|---|
| 双 HTML 入口 `index.html` / `portal.html` | `vite.config.ts` → `build.rollupOptions.input` | 静态托管两页都在，`/portal` 用 rewrite 指到 `portal.html` |
| `base: './'`（相对路径） | `vite.config.ts` | 任意域名/任意子路径/预览域名都能跑，不需要改 base |
| 播放器内核 `public/player/*` 是构建产物且被 gitignore | `scripts/build-player.mjs`、`vite.player.config.ts` | `pnpm build` 的 `prebuild` 会先生成它，**不要**把 `public/` 加进 `.vercelignore` |
| `build` = `tsc --noEmit && vite build` | `package.json` | 需要 devDependencies（typescript/@types），CI 不要跳过 devDeps |
| 无 react-router、无 pushState | `src/portal/PortalApp.tsx`、`src/export/*` | 不需要 SPA catch-all rewrite；导航靠相对链接与 query 参数 |
| 数据在 IndexedDB，模型端点由用户自填 | `README.md` 隐私段 | Vercel 侧**零环境变量**，不需要 `api/`、不需要 serverless function |

## 方案 A：Git 导入（推荐，推一次就有预览 + 生产）

1. 推到 GitHub（`main` 为生产分支）。
2. <https://vercel.com/new> → Import 该仓库。
3. Framework Preset 自动识别 **Vite**；核对三项：
   - Install Command：`pnpm install --frozen-lockfile`（仓库有 `pnpm-lock.yaml`，Vercel 自动用 pnpm）
   - Build Command：`pnpm build`
   - Output Directory：`dist`
4. Node.js Version 选 **22.x**（`engines.node` 已声明，Vite 7 要求 ≥ 20.19 / 22.12）。
5. Deploy。之后每次 push 出 Preview，合到 `main` 出 Production。

> 若导入时 Vercel 误判框架为 "Other"，在 Settings → Build & Development 手动填上面三项即可；`vercel.json` 里的同名字段优先级更高。

## 方案 B：CLI 直推（本地构建上下文，不走 Git）

```powershell
npx --yes vercel login    # 首次：浏览器授权
npx --yes vercel link     # 首次：关联/新建项目，选根目录
pnpm build                # 本地先自检一次，确保 tsc 过
npx --yes vercel          # 预览部署，输出 *.vercel.app 域名
npx --yes vercel --prod   # 生产部署
```

后两步已封成脚本，内部就是 `npx --yes vercel`，不需要全局安装：

```powershell
pnpm run deploy:preview   # = npx --yes vercel
pnpm run deploy:prod      # = npx --yes vercel --prod
```

> **必须带 `run`**。`pnpm deploy` 解析到 pnpm 内建的 workspace 部署命令
> （`pnpm --filter=<name> deploy <target directory>`，实验性），同名脚本会被它盖掉——
> 直接敲 `pnpm deploy` 得到的是内建命令的参数错误，不是这里的脚本。

CLI 走的是本地上传 → 云端构建，因此 `.vercelignore` 生效：`doc/`(2.7MB)、`plan/`(2.9MB)、`harness/`(38.7MB)、`dist/`(5.8MB)、`tests/`(0.2MB)、`test-results/`、`playwright-report/`、`*.md`、`LICENSE*`、`.git/`、`.vercel/` 都不上传，上传体积从 ~54MB 降到 ~4MB。

## 已落地的 `vercel.json`

```json
{
  "framework": "vite",
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "pnpm build",
  "outputDirectory": "dist",
  "rewrites": [{ "source": "/portal", "destination": "/portal.html" }],
  "headers": [ /* 静态资源长缓存 + 三个基础安全头 */ ]
}
```

要点：

- `assets/*` → `max-age=31536000, immutable`（文件名带 content hash）。
- `player/*` → `max-age=0, must-revalidate`（文件名固定，每次部署都会重写；导出单文件 HTML 时正被 fetch）。
- `index.html` / `portal.html` → `must-revalidate`，保证新版本立刻生效。
- **没有** `/(.*)` → `/index.html` 的 catch-all：本项目无前端路由，加了只会把 404 伪装成 200。将来接入 react-router 时再加：
  `{ "source": "/((?!assets/|player/|portal/).*)", "destination": "/index.html" }`

## 五个常见坑

1. **`public/player` 是 gitignored 的构建产物**。别在 `.vercelignore` 里写 `public/`，也别把 `build` 改成 `vite build`（会跳过 `prebuild`，产物缺 `lumen-player.js`，导出 HTML 直接坏）。
2. **不要给构建环境设 `NODE_ENV=production`**。会让 pnpm 跳过 devDependencies，`tsc` 和 `@types/*` 缺席，`tsc --noEmit` 直接失败。
3. **lockfile 版本**：`pnpm-lock.yaml` 是 `lockfileVersion 9.0`，需 pnpm ≥ 9。若日志出现 unsupported lockfile version，在 `package.json` 加 `"packageManager": "pnpm@<本地 pnpm -v 的输出>"`，或把 `installCommand` 换成 `pnpm install --no-frozen-lockfile`。
4. **单文件 HTML 里的模型端点**：Vercel 是 HTTPS，浏览器会拦截 `http://` 混合内容。本地 Ollama 端点（`http://127.0.0.1:11434`）在生产页面里不可直连——要不给端点套 HTTPS 反代，要不继续用 Mock / `?channel=replay` 离线通道。
5. **CSP 别乱加**：编辑器依赖 `data:` / `blob:` / `iframe srcdoc` / 内联样式，过紧的 `Content-Security-Policy` 会让 SVG/3D 画布与播放器白屏。要加就单独一份，先在 Preview 上跑 `pnpm e2e` 再上生产。

## 验收清单

- [ ] `/` 出工作台，`/portal` 出门户，`/portal.html` 3xx 到 `/portal` 或直接 200（两者都可用）
- [ ] DevTools → Network：`assets/*` 命中 `cache-control: max-age=31536000`，`index.html` 是 `must-revalidate`
- [ ] 导出「独立 HTML」→ 本地双击可播（校验 `player/lumen-player.js` 200 且非 HTML 回退）
- [ ] `?channel=replay&speed=0` 离线回放正常（证明无隐形后端依赖）
- [ ] 刷新深链 `?strict=0` / `?portal=1` 不 404
- [ ] Preview 域名与生产域名表现一致（相对 `base` 的收益）