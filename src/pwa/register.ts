/**
 * src/pwa/register.ts —— Service Worker 注册入口。
 *
 * 设计取舍：
 * - 只在生产构建注册：dev 下 Vite 的 HMR 与 `sw.js` 的缓存策略会互相打架，调试时缓存还容易骗人。
 * - `?portal=1`（入口内嵌门户）与 `?print`（打印视图）不注册：前者只是同一入口的分支，后者是
 *   一次性的打印快照，都不需要离线壳。
 * - 注册失败只 console.warn：离线能力是增强项，绝不能让它挡住首屏或让用户看到报错。
 * - 等 `load` 之后再注册，避免和首屏资源抢带宽；已经 load 完的（例如门户页动态挂载）立即注册。
 * - `updateViaCache: 'none'`：让浏览器每次导航都回源校验 sw.js，避免 CDN 把旧 SW 钉住。
 */

/** 与 `public/sw.js` 对应；用 `document.baseURI` 拼，兼容部署在子路径（vite base: './'）。 */
const SW_FILE = 'sw.js'

function scopeUrl(): string {
  return new URL('./', document.baseURI).href
}

function shouldRegister(): boolean {
  if (!import.meta.env.PROD) return false
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  if (!('serviceWorker' in navigator)) return false
  const params = new URLSearchParams(window.location.search)
  if (params.get('portal') === '1') return false
  if (params.has('print')) return false
  return true
}

function doRegister(): void {
  const url = new URL(SW_FILE, document.baseURI).href
  void navigator.serviceWorker
    .register(url, { scope: scopeUrl(), updateViaCache: 'none' })
    .catch((error) => {
      console.warn('[pwa] Service Worker 注册失败，离线能力降级', error)
    })
}

/** 幂等：重复调用只会多挂一次 load 监听，注册本身由浏览器去重。 */
export function registerServiceWorker(): void {
  if (!shouldRegister()) return
  try {
    if (document.readyState === 'complete') {
      doRegister()
      return
    }
    window.addEventListener('load', doRegister, { once: true })
  } catch (error) {
    console.warn('[pwa] Service Worker 注册流程异常', error)
  }
}
