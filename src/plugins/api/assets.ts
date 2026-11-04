/**
 * plugins/api/assets.ts —— `lumen.assets`（02 §5.2 / §5.3：`asset:write`）。
 *
 * 素材存 `pluginData` 的 `${pluginId}:asset:<assetId>`（不写 `assets` store，避免与用户素材混）；
 * 单素材 ≤256KB、总量 ≤512KB；SVG 存前过 `sanitizeSvgDocument`；`getUrl` 返回 `blob:` URL（仅本帧可用），
 * 卸载时全部 revoke。
 */
import { kvDel, kvEntries, kvGet, kvSet } from '@/persistence/kv'
import { sanitizeSvgDocument } from '@/render/svg/sanitize'
import { newId } from '@/schema/ids'
import type { ApiCall } from './context'
import { abiError, assertRecord, registerNamespaceApi } from './gateway'

export const ASSET_MAX_BYTES = 256 * 1024
export const ASSET_TOTAL_MAX_BYTES = 512 * 1024
const MIMES = ['image/svg+xml', 'image/png', 'image/webp'] as const
export type AssetMime = (typeof MIMES)[number]

interface StoredAsset {
  name: string
  mime: AssetMime
  dataUrl: string
  bytes: number
  createdAt: number
}

export function assetHostKey(pluginId: string, assetId: string): string {
  return `${pluginId}:asset:${assetId}`
}

function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const payload = dataUrl.slice(comma + 1)
  if (!/;base64$/i.test(dataUrl.slice(0, comma))) return payload.length
  return Math.floor((payload.replace(/=+$/, '').length * 3) / 4)
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw abiError('invalid dataUrl')
  const meta = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  const mime = /data:([^;,]+)/.exec(meta)?.[1] ?? 'application/octet-stream'
  if (/;base64$/i.test(meta)) {
    const binary = typeof atob === 'function' ? atob(payload) : Buffer.from(payload, 'base64').toString('binary')
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new Blob([bytes], { type: mime })
  }
  return new Blob([decodeURIComponent(payload)], { type: mime })
}

async function assetTotalBytes(pluginId: string): Promise<number> {
  const prefix = `${pluginId}:asset:`
  const entries = await kvEntries<StoredAsset>('pluginData')
  let total = 0
  for (const [key, value] of entries) {
    if (key.startsWith(prefix)) total += value?.bytes ?? 0
  }
  return total
}

/** 同步 + 异步两用：单个素材是否存在（deck 校验 image 块引用）。 */
export async function hasPluginAsset(pluginId: string, assetId: string): Promise<boolean> {
  const stored = await kvGet<StoredAsset>('pluginData', assetHostKey(pluginId, assetId))
  return Boolean(stored && typeof stored.dataUrl === 'string')
}

/* ------------------------------ blob URL 生命周期 ------------------------------ */

const blobUrls = new Map<string, string>()

function revokeFor(pluginId: string): void {
  for (const [key, url] of [...blobUrls.entries()]) {
    if (key.startsWith(`${pluginId}:`)) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        /* noop */
      }
      blobUrls.delete(key)
    }
  }
}

export function revokePluginAssetUrls(pluginId: string): void {
  revokeFor(pluginId)
}

/* ------------------------------ 方法 ------------------------------ */

export async function handleAssets(method: string, payload: unknown, call: ApiCall): Promise<unknown> {
  const { pluginId } = call.frame
  switch (method) {
    case 'put': {
      const body = assertRecord(payload, 'payload')
      const name = typeof body.name === 'string' ? body.name.slice(0, 80) : 'asset'
      const mime = body.mime
      if (typeof mime !== 'string' || !(MIMES as readonly string[]).includes(mime)) {
        throw abiError(`asset mime must be one of ${MIMES.join(', ')}`)
      }
      const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : ''
      if (!dataUrl.startsWith('data:')) throw abiError('asset dataUrl must start with data:')
      let storedDataUrl = dataUrl
      let bytes = dataUrlBytes(dataUrl)
      if (bytes > ASSET_MAX_BYTES) {
        const error = new Error('asset exceeds 256KB') as Error & { code?: string }
        error.code = 'E-QUOTA-01'
        throw error
      }
      if (mime === 'image/svg+xml') {
        const svg = decodeURIComponent(dataUrl.slice(dataUrl.indexOf(',') + 1))
        const sanitized = sanitizeSvgDocument(svg, { maxBytes: ASSET_MAX_BYTES })
        if (!sanitized.svg) throw abiError('asset SVG failed sanitization')
        storedDataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(sanitized.svg)}`
        bytes = storedDataUrl.length
      }
      const total = await assetTotalBytes(pluginId)
      if (total + bytes > ASSET_TOTAL_MAX_BYTES) {
        const error = new Error('plugin asset quota exceeded') as Error & { code?: string }
        error.code = 'E-QUOTA-01'
        throw error
      }
      const assetId = newId('asset')
      const record: StoredAsset = { name, mime: mime as AssetMime, dataUrl: storedDataUrl, bytes, createdAt: Date.now() }
      await kvSet('pluginData', assetHostKey(pluginId, assetId), record)
      return { assetId }
    }
    case 'getUrl': {
      const body = assertRecord(payload, 'payload')
      const assetId = typeof body.assetId === 'string' ? body.assetId : ''
      if (!assetId) throw abiError('assetId is required')
      const stored = await kvGet<StoredAsset>('pluginData', assetHostKey(pluginId, assetId))
      if (!stored) throw abiError(`asset "${assetId}" does not exist`)
      const cacheKey = `${pluginId}:${assetId}`
      const existing = blobUrls.get(cacheKey)
      if (existing) return existing
      const url = URL.createObjectURL(dataUrlToBlob(stored.dataUrl))
      blobUrls.set(cacheKey, url)
      return url
    }
    case 'remove': {
      const body = assertRecord(payload, 'payload')
      const assetId = typeof body.assetId === 'string' ? body.assetId : ''
      if (!assetId) throw abiError('assetId is required')
      const cacheKey = `${pluginId}:${assetId}`
      const url = blobUrls.get(cacheKey)
      if (url) {
        try {
          URL.revokeObjectURL(url)
        } catch {
          /* noop */
        }
        blobUrls.delete(cacheKey)
      }
      await kvDel('pluginData', assetHostKey(pluginId, assetId))
      return null
    }
    case 'list': {
      const prefix = `${pluginId}:asset:`
      const entries = await kvEntries<StoredAsset>('pluginData')
      return entries
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({
          assetId: key.slice(prefix.length),
          name: value?.name ?? '',
          bytes: value?.bytes ?? 0,
          createdAt: value?.createdAt ?? 0,
        }))
    }
    default:
      throw abiError(`unknown assets method "${method}"`)
  }
}

/** 卸载清理（§3.4 第 11/12 项）：revoke URL；数据由 registry 决定是否删。 */
export async function clearPluginAssets(pluginId: string, deleteData: boolean): Promise<void> {
  revokePluginAssetUrls(pluginId)
  if (!deleteData) return
  const prefix = `${pluginId}:asset:`
  const entries = await kvEntries<StoredAsset>('pluginData')
  for (const [key] of entries) {
    if (key.startsWith(prefix)) await kvDel('pluginData', key)
  }
}

export function resetAssetsForTests(): void {
  revokeFor('')
  blobUrls.clear()
}

export function registerAssetsApi(): void {
  registerNamespaceApi('assets', {
    put: (payload, call) => handleAssets('put', payload, call),
    getUrl: (payload, call) => handleAssets('getUrl', payload, call),
    remove: (payload, call) => handleAssets('remove', payload, call),
    list: (payload, call) => handleAssets('list', payload, call),
  })
}
