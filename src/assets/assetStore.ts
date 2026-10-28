/**
 * assetStore.ts —— 图片等二进制资产（IndexedDB Blob，不进 deck 与撤销历史）。
 * deck 只存 assetId；导出/播放时按需转 dataURL。
 */
import { useEffect, useState } from 'react'
import { newId } from '@/schema/ids'
import { kvDel, kvGet, kvSet } from '@/persistence/kv'

export interface AssetMeta {
  id: string
  mime: string
  w: number
  h: number
  bytes: number
  createdAt: number
}

interface AssetRecord extends AssetMeta {
  blob: Blob
}

const MAX_DIM = 1600
const urlCache = new Map<string, string>()

export class UnsupportedAssetError extends Error {
  readonly reason: 'svg' | 'video' | 'type' | 'size'
  constructor(reason: 'svg' | 'video' | 'type' | 'size', message: string) {
    super(message)
    this.reason = reason
    this.name = 'UnsupportedAssetError'
  }
}

export async function putAsset(blob: Blob, meta: { mime?: string; w: number; h: number }): Promise<AssetMeta> {
  const id = newId('asset')
  const record: AssetRecord = {
    id,
    mime: meta.mime ?? blob.type ?? 'application/octet-stream',
    w: meta.w,
    h: meta.h,
    bytes: blob.size,
    createdAt: Date.now(),
    blob,
  }
  await kvSet('assets', id, record)
  return stripBlob(record)
}

function stripBlob(record: AssetRecord): AssetMeta {
  const { blob: _blob, ...meta } = record
  return meta
}

export async function getAssetRecord(id: string): Promise<AssetRecord | null> {
  const record = await kvGet<AssetRecord>('assets', id)
  return record ?? null
}

export async function getAssetMeta(id: string): Promise<AssetMeta | null> {
  const record = await getAssetRecord(id)
  return record ? stripBlob(record) : null
}

export async function getAssetUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id)
  if (cached) return cached
  const record = await getAssetRecord(id)
  if (!record) return null
  const url = URL.createObjectURL(record.blob)
  urlCache.set(id, url)
  return url
}

export async function getAssetBlob(id: string): Promise<Blob | null> {
  const record = await getAssetRecord(id)
  return record?.blob ?? null
}

export async function deleteAsset(id: string): Promise<void> {
  const cached = urlCache.get(id)
  if (cached) {
    URL.revokeObjectURL(cached)
    urlCache.delete(id)
  }
  await kvDel('assets', id)
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

export async function getAssetDataUrl(id: string): Promise<string | null> {
  const blob = await getAssetBlob(id)
  if (!blob) return null
  return blobToDataUrl(blob)
}

/** 把用户选的文件压到 ≤1600px WebP，落库并返回元信息。 */
export async function importImageFile(file: File): Promise<AssetMeta> {
  if (file.type === 'image/svg+xml') {
    throw new UnsupportedAssetError('svg', 'SVG 文件请通过「SVG 插图」插入，会保留矢量可编辑性')
  }
  if (!file.type.startsWith('image/')) {
    throw new UnsupportedAssetError('type', '只支持图片文件')
  }
  if (file.size > 24 * 1024 * 1024) {
    throw new UnsupportedAssetError('size', '图片超过 24MB')
  }

  const bitmap = await createImageBitmapQuiet(file)
  let width = bitmap?.width ?? 0
  let height = bitmap?.height ?? 0
  const scale = width > 0 ? Math.min(1, MAX_DIM / Math.max(width, height)) : 1
  const targetW = Math.max(1, Math.round(width * scale))
  const targetH = Math.max(1, Math.round(height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = targetW || 800
  canvas.height = targetH || 450
  const ctx = canvas.getContext('2d')
  if (!ctx || !bitmap) {
    return putAsset(file, { mime: file.type, w: width || 800, h: height || 450 })
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82))
  const blob = encoded ?? file
  bitmap.close?.()
  return putAsset(blob, {
    mime: blob.type || 'image/webp',
    w: targetW || canvas.width,
    h: targetH || canvas.height,
  })
}

async function createImageBitmapQuiet(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file)
  } catch {
    return null
  }
}

/** 组件里取图 URL（带缓存；卸载时保留缓存以便快速回切）。 */
export function useAssetUrl(assetId: string | undefined | null): string | null {
  const [url, setUrl] = useState<string | null>(() => (assetId ? (urlCache.get(assetId) ?? null) : null))
  useEffect(() => {
    let alive = true
    if (!assetId) {
      setUrl(null)
      return () => {
        alive = false
      }
    }
    void getAssetUrl(assetId).then((next) => {
      if (alive) setUrl(next)
    })
    return () => {
      alive = false
    }
  }, [assetId])
  return url
}

/** 导出/快照：把 deck 里引用到的资产批量转 dataURL。 */
export async function collectAssetDataUrls(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    Array.from(new Set(ids)).map(async (id) => {
      const dataUrl = await getAssetDataUrl(id)
      if (dataUrl) out[id] = dataUrl
    }),
  )
  return out
}

export async function putAssetFromDataUrl(id: string, dataUrl: string): Promise<void> {
  const blob = await (await fetch(dataUrl)).blob()
  const size = await imageSizeOfBlob(blob)
  await kvSet('assets', id, {
    id,
    mime: blob.type || 'image/png',
    w: size.w,
    h: size.h,
    bytes: blob.size,
    createdAt: Date.now(),
    blob,
  } satisfies AssetRecord)
}

async function imageSizeOfBlob(blob: Blob): Promise<{ w: number; h: number }> {
  const bitmap = await createImageBitmapQuiet(blob instanceof File ? blob : new File([blob], 'asset'))
  if (!bitmap) return { w: 800, h: 450 }
  const size = { w: bitmap.width, h: bitmap.height }
  bitmap.close?.()
  return size
}
