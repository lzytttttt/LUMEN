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
| 数据在 IndexedDB，模型端点由用户自填 | `README.md` 隐私段 | 默认零环境变量；`api/llm-proxy.ts` 是**可选**的 Edge 转发，不部署也不影响静态站点 |

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
  "headers": [ /* 静态资源长缓存 + 基础安全头 + CSP */ ]
}
```

要点：

- `assets/*` → `max-age=31536000, immutable`（文件名带 content hash）。
- `player/*` → `max-age=0, must-revalidate`（文件名固定，每次部署都会重写；导出单文件 HTML 时正被 fetch）。
- `index.html` / `portal.html` → `must-revalidate`，保证新版本立刻生效。
- **没有** `/(.*)` → `/index.html` 的 catch-all：本项目无前端路由，加了只会把 404 伪装成 200。将来接入 react-router 时再加：
  `{ "source": "/((?!assets/|player/|portal/).*)", "destination": "/index.html" }`

## PWA 与离线缓存

- `public/manifest.webmanifest` + `public/icons/*` 让站点可"安装为应用"；`public/sw.js` 是手写 Service Worker，生产构建自动注册（`src/pwa/register.ts`），dev 不注册。构建会额外产出 `dist/asset-manifest.json`（Vite `build.manifest`），SW 在 install 时按它预缓存全部 chunk（含 three / CodeMirror 等动态块），所以首次在线访问后断网也能启动。
- 缓存策略：HTML 导航 **network-first**（离线回退最近缓存与内联兜底页）；同源静态资源 **stale-while-revalidate**；`/player/*`、`?print=1`、带 Range 的请求、跨域请求**一律不接管**（AI 流式响应与鉴权头不进缓存）。`cache.match` 使用 `ignoreVary`，避免 `Vary: Origin` 造成离线假阴性。
- 改了 `sw.js` 记得升 `SW_VERSION`；`activate` 只清理 `lumen-` 前缀的旧缓存，不碰同源其它应用。
- 部署验收：DevTools → Application → Manifest 无报错；Service Workers 状态 activated；断网刷新仍能进入工作台并打开已缓存演示。

## 可选：CORS 转发函数（`api/llm-proxy.ts`）

纯静态部署时它不会生效，也不会被加载。只有当你需要浏览器直连某个被 CORS 拦截的 OpenAI 兼容端点时：

1. Vercel 会自动把 `api/llm-proxy.ts` 识别为 Edge Function；
2. 在 Project → Settings → Environment Variables 配 `LUMEN_PROXY_ALLOWLIST`（逗号分隔的额外主机名；默认已含 OpenAI / DeepSeek / OpenRouter / Moonshot / SiliconFlow / 通义 / Groq / Mistral / Gemini）；
3. 需要限制来源时配 `LUMEN_PROXY_ORIGINS`（逗号分隔；不配则允许任意 Origin）；
4. 应用里把 baseURL 设为 `https://<你的域名>/api/llm-proxy`，请求头带 `x-lumen-upstream: https://api.deepseek.com/v1/chat/completions`。

安全边界：只允许 `https`、拒绝私网/回环地址与 URL 内嵌凭据、不跟随重定向、不转发 Cookie/Origin/Referer、请求体上限 8MB、无日志无落盘。**不要**把 `LUMEN_PROXY_ALLOWLIST` 设成 `*` 后公开部署——那会变成开放代理。



1. **`public/player` 是 gitignored 的构建产物**。别在 `.vercelignore` 里写 `public/`，也别把 `build` 改成 `vite build`（会跳过 `prebuild`，产物缺 `lumen-player.js`，导出 HTML 直接坏）。
2. **不要给构建环境设 `NODE_ENV=production`**。会让 pnpm 跳过 devDependencies，`tsc` 和 `@types/*` 缺席，`tsc --noEmit` 直接失败。
3. **lockfile 版本**：`pnpm-lock.yaml` 是 `lockfileVersion 9.0`，需 pnpm ≥ 9。若日志出现 unsupported lockfile version，在 `package.json` 加 `"packageManager": "pnpm@<本地 pnpm -v 的输出>"`，或把 `installCommand` 换成 `pnpm install --no-frozen-lockfile`。
4. **单文件 HTML 里的模型端点**：Vercel 是 HTTPS，浏览器会拦截 `http://` 混合内容。本地 Ollama 端点（`http://127.0.0.1:11434`）在生产页面里不可直连——要不给端点套 HTTPS 反代，要不继续用 Mock / `?channel=replay` 离线通道。
5. **CSP 已落地，改动要跟着改策略**：`vercel.json` 的 CSP 放行了 `'unsafe-inline'`（内联样式/脚本）、`data:` / `blob:`（素材与 3D 抓帧）、`frame-src 'self' data: blob:`（HTML 块 srcdoc）、`connect-src https: http: ws: wss:`（第三方模型端点 + 本地 Ollama）。收紧 `connect-src` 会直接打断模型调用；收紧 `img-src`/`frame-src` 会让 SVG/3D 画布与播放器白屏。改完先在 Preview 跑 `pnpm e2e` 再上生产。

## 验收清单

- [ ] `/` 出工作台，`/portal` 出门户，`/portal.html` 3xx 到 `/portal` 或直接 200（两者都可用）
- [ ] DevTools → Network：`assets/*` 命中 `cache-control: max-age=31536000`，`index.html` 是 `must-revalidate`
- [ ] 导出「独立 HTML」→ 本地双击可播（校验 `player/lumen-player.js` 200 且非 HTML 回退）
- [ ] `?channel=replay&speed=0` 离线回放正常（证明无隐形后端依赖）
- [ ] 刷新深链 `?strict=0` / `?portal=1` 不 404
- [ ] Preview 域名与生产域名表现一致（相对 `base` 的收益）
- [ ] Application → Manifest 无报错；Service Worker activated；`asset-manifest.json` 200；断网刷新仍能进入工作台（首次在线访问后）
- [ ] 安全头：响应含 `Content-Security-Policy`、`X-Content-Type-Options`、`Permissions-Policy`；CSP 没有阻断编辑器/3D/导出（用 `pnpm e2e` 的 export/print 用例复核）