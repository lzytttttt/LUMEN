/**
 * public/sw.js —— LUMEN 手写 Service Worker（无构建期清单，纯运行时策略）。
 *
 * 设计取舍（为什么不上 Workbox、不在 install 里预缓存 hash 资源）：
 * 1. 不新增依赖：vite 产物名带 hash，而本仓库没有注入构建清单的插件，所以 install 只预缓存
 *    「壳」——两个 HTML 入口、manifest、图标；带 hash 的 JS/CSS 交给同源 SWR 在首次访问时补齐。
 *    壳里的 HTML 走 network-first，能拿到最新的 hash 引用，旧 hash 资源自然失宠并被新版本顶掉。
 * 2. 跨域请求一律不接管：AI 请求指向 OpenAI 兼容网关（流式响应、鉴权头、用户正文），缓存它们既
 *    无意义，又会把私密内容留在磁盘上；fetch 里 origin 不同直接 return，交给浏览器原生行为。
 * 3. `/player/` 是独立播放器内核（`file://` 单文件场景也在用），不参与应用 shell 缓存。
 * 4. `?print=1` 打印视图要的是「这一刻」的数据快照，命中缓存只会打出旧页面，直接跳过。
 * 5. 导航 network-first（离线回退最近一次缓存 + 内联兜底页），静态资源
 *    stale-while-revalidate：弱网下首屏先出旧字节，后台再对齐新版本，不做白屏等待。
 * 6. 缓存名带版本号；activate 只清理本应用前缀（`lumen-`）下的旧缓存，不碰同源其它应用。
 */

const SW_VERSION = 'v1'
const CACHE_PREFIX = 'lumen'
const SHELL_CACHE = `${CACHE_PREFIX}-shell-${SW_VERSION}`
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${SW_VERSION}`
const KEEP_CACHES = new Set([SHELL_CACHE, RUNTIME_CACHE])

/** 应用壳：这些文件在构建产物里名字固定（无 hash），可以安全预缓存。 */
const SHELL_ASSETS = [
  './',
  './index.html',
  './portal.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
]

/** 可走 stale-while-revalidate 的同源静态资源后缀。 */
const STATIC_EXT = /\.(?:js|mjs|css|map|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|json|webmanifest)$/i

/** 导航离线兜底页：不依赖任何外部资源，避免「离线 → 浏览器错误页 → 用户以为数据丢了」。 */
const OFFLINE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#0a0b0e" />
    <title>LUMEN · 离线</title>
    <style>
      :root { color-scheme: dark; }
      html, body { margin: 0; height: 100%; }
      body {
        display: grid; place-items: center; gap: 14px;
        background: radial-gradient(120% 90% at 50% 0%, #171a21 0%, #0a0b0e 55%, #07080b 100%);
        color: #e8eaef;
        font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
        text-align: center; padding: 32px;
      }
      h1 { margin: 0; font-size: 18px; letter-spacing: .02em; font-weight: 600; }
      p { margin: 0; max-width: 38em; color: #a4aab8; font-size: 13px; line-height: 1.7; }
      button {
        margin-top: 6px; padding: 8px 16px; border-radius: 8px; cursor: pointer;
        border: 1px solid rgba(200, 161, 90, .42); background: rgba(200, 161, 90, .14); color: #e8eaef;
        font: inherit; font-size: 13px;
      }
    </style>
  </head>
  <body>
    <h1>LUMEN · 此刻离线</h1>
    <p>网络断了，本地草稿与已缓存的演示仍可打开。<br />恢复网络后刷新即可继续编辑与播放。</p>
    <p>You are offline. Cached decks still open; refresh once the network returns.</p>
    <button type="button" onclick="location.reload()">重试 / Retry</button>
  </body>
</html>`

/* -------------------------------- install -------------------------------- */

/**
 * 解析 HTML 入口里的 hashed 资源并预缓存。
 * 只缓存同源的 `./assets/*`：这是 Vite 产物里唯一的 hash 资源目录；
 * 外链、data:、manifest 由 shell 列表或运行时策略负责。
 */
async function precacheEntryAssets(cache, docUrl) {
  try {
    const response = await fetch(new Request(docUrl, { cache: 'reload' }))
    if (!response.ok) return 0
    const html = await response.text()
    const urls = new Set()
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = match[1]
      if (/^\.?\/assets\//.test(url)) urls.add(url)
    }
    const results = await Promise.allSettled([...urls].map((url) => cache.add(url)))
    return results.filter((result) => result.status === 'fulfilled').length
  } catch {
    // 预缓存是增强项：失败就让运行时 SWR 在真正访问时补齐。
    return 0
  }
}

/**
 * 用 Vite 的 build manifest 把**全部** chunk（含 three 这类动态 chunk）收进 shell。
 * 单靠 HTML 里的 modulepreload 只能覆盖首屏 chunk，3D 幕第一次离线下会缺 three。
 */
async function precacheManifestAssets(cache) {
  try {
    const response = await fetch(new Request('./asset-manifest.json', { cache: 'reload' }))
    if (!response.ok) return 0
    const manifest = await response.json()
    const urls = new Set()
    for (const entry of Object.values(manifest)) {
      if (!entry || typeof entry !== 'object') continue
      for (const key of ['file', 'css']) {
        if (typeof entry[key] === 'string') urls.add(`./${entry[key].replace(/^\.?\//, '')}`)
      }
      for (const value of entry.assets ?? []) {
        if (typeof value === 'string') urls.add(`./${value.replace(/^\.?\//, '')}`)
      }
    }
    const files = [...urls].filter((url) => /\.(?:js|css)$/i.test(url))
    const results = await Promise.allSettled(files.map((url) => cache.add(url)))
    return results.filter((result) => result.status === 'fulfilled').length
  } catch {
    return 0
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // 逐个 add：任何一个壳文件 404（例如自定义部署裁掉了 portal.html）都不该让 SW 装不上，
      // 缺的交给运行时 SWR 在真正访问时补齐。
      const results = await Promise.allSettled(
        SHELL_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
      )
      const failed = results.filter((result) => result.status === 'rejected').length
      // 再把两个 HTML 入口引用的 hashed JS/CSS 一起收进 shell：
      // 这样"第一次访问后断网"也能直接启动，而不是要等一次由 SW 接管的二次加载。
      const assetCounts = await Promise.allSettled(
        ['./index.html', './portal.html'].map((doc) => precacheEntryAssets(cache, doc)),
      )
      const manifestAssets = await precacheManifestAssets(cache)
      const assets =
        manifestAssets +
        assetCounts.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value : 0), 0)
      console.info(
        `[sw] 预缓存 ${SHELL_ASSETS.length - failed}/${SHELL_ASSETS.length} 个壳资源、${assets} 个入口资源`,
      )
      await self.skipWaiting()
    })(),
  )
})

/* -------------------------------- activate ------------------------------- */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          // 只清理本应用自己的旧版本缓存；同源下别的应用/别的工具的缓存不归我们管。
          .filter((name) => name.startsWith(`${CACHE_PREFIX}-`) && !KEEP_CACHES.has(name))
          .map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

/* --------------------------------- fetch --------------------------------- */

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }

  // 跨域（AI 网关、字体、外链图）一律不拦：既不缓存，也不改写，直接交给网络。
  if (url.origin !== self.location.origin) return
  // 打印视图要「此刻」的数据，命中缓存只会打出旧页面。
  if (url.searchParams.has('print')) return
  // 分段请求（音视频）缓存下来没有意义，且容易把 206 存成损坏数据。
  if (request.headers.has('range')) return
  // 独立播放器内核（public/player/*）不参与应用 shell。
  if (url.pathname.includes('/player/')) return

  if (request.mode === 'navigate') {
    event.respondWith(navigateNetworkFirst(event))
    return
  }

  if (isStaticAsset(url)) event.respondWith(staleWhileRevalidate(event))
})

/* -------------------------------- 策略实现 -------------------------------- */

function isStaticAsset(url) {
  // 带查询串的同源请求多半是参数化接口，不做静态缓存。
  if (url.search) return false
  return STATIC_EXT.test(url.pathname) || url.pathname.includes('/assets/')
}

/** HTML 导航：先网络（顺便刷新壳缓存），失败才回缓存，最后给内联兜底页。 */
async function navigateNetworkFirst(event) {
  const request = event.request
  try {
    const response = await fetch(request)
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE)
      await cache.put(request, response.clone())
    }
    return response
  } catch {
    const cache = await caches.open(SHELL_CACHE)
    const cached =
      (await cache.match(request, { ignoreSearch: true, ignoreVary: true })) ||
      (await cache.match('./index.html', { ignoreVary: true })) ||
      (await cache.match('./', { ignoreVary: true }))
    if (cached) return cached
    return new Response(OFFLINE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }
}

/** 同源静态资源：先回缓存，后台对齐新版本（弱网不白屏，新版本下一跳生效）。 */
async function staleWhileRevalidate(event) {
  const request = event.request
  const cache = await caches.open(RUNTIME_CACHE)
  // install 阶段把入口引用的 hashed JS/CSS 预缓存进了 shell；首访离线时也要能命中。
  // ignoreVary：静态托管常带 `Vary: Origin`，模块脚本请求未必带 Origin，严格匹配会假阴性。
  const shell = await caches.open(SHELL_CACHE)
  const cached =
    (await cache.match(request, { ignoreVary: true })) ||
    (await shell.match(request, { ignoreVary: true }))

  const network = fetch(request).then(async (response) => {
    if (response && response.ok && response.type === 'basic') {
      await cache.put(request, response.clone())
    }
    return response
  })

  if (cached) {
    // 后台更新不能拖住响应；失败就算了，旧字节仍可用。
    event.waitUntil(network.catch(() => undefined))
    return cached
  }

  try {
    return await network
  } catch {
    // 未缓存且离线：交给浏览器默认的错误页语义，别伪造 200。
    return new Response('', { status: 504, statusText: 'offline' })
  }
}
