/**
 * playerAssetBridge.ts —— 独立播放器的「素材表」桥。
 *
 * 只在 `vite.player.config.ts` 里把 `@/assets/assetStore` alias 到本文件
 * （编辑器构建不受影响，仍然走真正的 IndexedDB 资产库）。
 *
 * 为什么要这层：导出的单文件 HTML 里没有 IndexedDB 素材，图片的 dataURL 被内联在
 * `<script type="application/json" id="lumen-assets">`，由播放器写进
 * `window.__LUMEN_ASSETS__`（assetId → dataURL）。
 * 这里让 `useAssetUrl / getAssetUrl / getAssetDataUrl` **优先查表**，
 * 查不到再退回真实实现（播放器在浏览器里自己抓的 3D 帧会写回资产库）。
 *
 * 协议（导出端与播放器端必须一致）：
 *   window.__LUMEN_ASSETS__: { [assetId: string]: dataURL }
 * - assetId 本身是 data:/blob:/http(s): 时直接当 URL 用；
 * - 表里命中就是那张图，零网络请求。
 */
import { useEffect, useState } from 'react'
import * as store from '../assets/assetStore'

declare global {
  interface Window {
    /** 单文件 HTML 内联的 assetId → dataURL 映射。 */
    __LUMEN_ASSETS__?: Record<string, string>
  }
}

export type { AssetMeta } from '../assets/assetStore'
export {
  UnsupportedAssetError,
  putAsset,
  getAssetRecord,
  getAssetMeta,
  getAssetBlob,
  deleteAsset,
  blobToDataUrl,
  importImageFile,
  collectAssetDataUrls,
  putAssetFromDataUrl,
} from '../assets/assetStore'

function readTable(): Record<string, string> | null {
  const scope = globalThis as { __LUMEN_ASSETS__?: Record<string, string> }
  const table = scope.__LUMEN_ASSETS__
  return table && typeof table === 'object' ? table : null
}

/** 直接可用的 URL（data/blob/http）或内联表命中的 dataURL；没有则 null。 */
function lookupInline(assetId: string | undefined | null): string | null {
  if (!assetId) return null
  if (/^(data:|blob:|https?:)/i.test(assetId)) return assetId
  const table = readTable()
  const hit = table?.[assetId]
  return typeof hit === 'string' && hit.length > 0 ? hit : null
}

export async function getAssetUrl(id: string): Promise<string | null> {
  return lookupInline(id) ?? store.getAssetUrl(id)
}

export async function getAssetDataUrl(id: string): Promise<string | null> {
  return lookupInline(id) ?? store.getAssetDataUrl(id)
}

/** 组件取图：表里命中是同步的（首帧就有图，不会闪一下骨架）。 */
export function useAssetUrl(assetId: string | undefined | null): string | null {
  const inline = lookupInline(assetId)
  const [resolved, setResolved] = useState<string | null>(() => inline)

  useEffect(() => {
    let alive = true
    if (!assetId) {
      setResolved(null)
      return () => {
        alive = false
      }
    }
    if (inline) {
      setResolved(inline)
      return () => {
        alive = false
      }
    }
    void store.getAssetUrl(assetId).then((next) => {
      if (alive) setResolved(next)
    })
    return () => {
      alive = false
    }
    // inline 由 assetId + 内联表决定，跟着 assetId 走即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId])

  return inline ?? resolved
}

/** 播放器挂载时调用：写入内联素材表（合并，不覆盖已存在的键）。 */
export function installPlayerAssets(assets: Record<string, string> | null | undefined): void {
  if (!assets) return
  const scope = globalThis as { __LUMEN_ASSETS__?: Record<string, string> }
  scope.__LUMEN_ASSETS__ = { ...(scope.__LUMEN_ASSETS__ ?? {}), ...assets }
}
