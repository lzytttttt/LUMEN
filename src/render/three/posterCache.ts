/**
 * three/posterCache.ts —— 3D 块静态帧缓存（缩略图用）。
 *
 * 缩略图（mode='thumb'）绝不创建 WebGL，但完全空白的占位会让幕栏看起来很潦草。
 * 这里的做法：只要这一幕在舞台上真正渲染过，就抓一帧存成 dataURL；
 * 缩略图订阅这个缓存，拿到就直接画 `<img>`（纯本地 dataURL，不发任何外部请求）。
 */

const MAX_ENTRIES = 32
const cache = new Map<string, string>()
const listeners = new Set<() => void>()

/** 读某个块最近一帧（没有返回 null）。 */
export function getThreePoster(blockId: string): string | null {
  return cache.get(blockId) ?? null
}

/** 记一帧（LRU 上限，避免长 deck 无限增长）。 */
export function setThreePoster(blockId: string, poster: string | null): void {
  if (!poster) return
  if (cache.get(blockId) === poster) return
  cache.delete(blockId)
  cache.set(blockId, poster)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  notify()
}

export function subscribeThreePosters(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 清空（导出/切换 deck 时用）。 */
export function clearThreePosters(): void {
  if (cache.size === 0) return
  cache.clear()
  notify()
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* 单个订阅者出错不影响其余 */
    }
  }
}
