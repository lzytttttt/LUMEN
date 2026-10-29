/**
 * assetCompress.ts —— 单文件 HTML 导出前的素材重采样（V2）。
 *
 * 背景：`standalone.ts` 的 12MB 提示 / 24MB 硬上限是按内联后的 HTML 算的，而
 * Base64 会让二进制膨胀约 33%。素材库里的图片虽然导入时已压到 1600px WebP，
 * 但 3D 抓帧、旧工程、外部导入仍可能带 1920px 以上的大图。
 *
 * 策略：
 * - 只处理位图；SVG（矢量）与 GIF（动图）跳过，避免丢可编辑性或丢帧；
 * - 最长边压到 1920px（超过 1600×900 舞台的 1.2 倍，2× 导出仍够用）；
 * - 统一编码为 `image/webp`（质量 0.82），只有体积真的变小才替换；
 * - 任何一张失败都保留原图，并在 warnings 里计数，绝不阻断导出。
 *
 * 纯函数（dataUrlByteLength / shouldCompressAsset）单独导出，便于 jsdom 下测试；
 * `compressDataUrlAssets` 在没有 createImageBitmap / Canvas 的环境里原样返回。
 */

/** 单边最大像素（超过则等比缩小）。 */
export const ASSET_MAX_EDGE = 1920
/** WebP 编码质量。 */
export const ASSET_WEBP_QUALITY = 0.82
/** 小于这个体积且未超尺寸的图片不动（避免反复有损编码）。 */
export const ASSET_COMPRESS_MIN_BYTES = 160 * 1024
/** 超过这个体积即使尺寸不大也重新编码（通常是高噪点 PNG）。 */
export const ASSET_RECOMPRESS_BYTES = 512 * 1024
/** 替换阈值：新图必须至少小 5%，否则保留原图。 */
export const ASSET_MIN_SAVING_RATIO = 0.95

export interface AssetCompressionReport {
  /** id → dataURL（含未改动的原始值）。 */
  assets: Record<string, string>
  compressed: number
  skipped: number
  /** 压缩失败（保留原图）的 assetId。 */
  failed: string[]
  beforeBytes: number
  afterBytes: number
  savedBytes: number
}

export interface CompressOptions {
  maxEdge?: number
  quality?: number
  minBytes?: number
  recompressBytes?: number
}

/** dataURL 的近似二进制字节数（base64 按 3/4 折算，去掉 padding）。 */
export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const meta = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  if (!/;base64/i.test(meta)) return payload.length
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

/** 是否值得重编码：矢量/动图一律跳过。 */
export function shouldCompressAsset(
  mime: string,
  width: number,
  height: number,
  bytes: number,
  options: CompressOptions = {},
): boolean {
  const maxEdge = options.maxEdge ?? ASSET_MAX_EDGE
  const minBytes = options.minBytes ?? ASSET_COMPRESS_MIN_BYTES
  const recompressBytes = options.recompressBytes ?? ASSET_RECOMPRESS_BYTES
  if (!mime.startsWith('image/')) return false
  if (mime === 'image/svg+xml' || mime === 'image/gif') return false
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false
  const oversized = width > maxEdge || height > maxEdge
  const heavy = bytes > recompressBytes
  if (!oversized && !heavy && bytes < minBytes) return false
  return oversized || heavy
}

function mimeOfDataUrl(dataUrl: string): string {
  const match = /^data:([^;,]+)/.exec(dataUrl)
  return match?.[1]?.toLowerCase() ?? ''
}

async function decodeBitmap(blob: Blob): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== 'function') return null
  try {
    return await createImageBitmap(blob)
  } catch {
    return null
  }
}

async function encodeWebp(bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'function') {
    try {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(bitmap, 0, 0, width, height)
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality })
      return blob.type === 'image/webp' ? blob : null
    } catch {
      return null
    }
  }
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, width, height)
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob && blob.type === 'image/webp' ? blob : null), 'image/webp', quality)
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 批量重采样。输入输出都是 `assetId → dataURL`；失败的项原样保留。
 * 不并行：一张 4K 图解码 + 编码的峰值内存已经不小，导出场景不值得为速度冒险。
 */
export async function compressDataUrlAssets(
  assets: Record<string, string>,
  options: CompressOptions = {},
): Promise<AssetCompressionReport> {
  const maxEdge = options.maxEdge ?? ASSET_MAX_EDGE
  const quality = options.quality ?? ASSET_WEBP_QUALITY
  const report: AssetCompressionReport = {
    assets: { ...assets },
    compressed: 0,
    skipped: 0,
    failed: [],
    beforeBytes: 0,
    afterBytes: 0,
    savedBytes: 0,
  }

  for (const [id, dataUrl] of Object.entries(assets)) {
    const mime = mimeOfDataUrl(dataUrl)
    const before = dataUrlByteLength(dataUrl)
    report.beforeBytes += before
    report.afterBytes += before
    if (!mime || mime === 'image/svg+xml' || mime === 'image/gif' || typeof createImageBitmap !== 'function') {
      report.skipped += 1
      continue
    }

    let bitmap: ImageBitmap | null = null
    try {
      const blob = await (await fetch(dataUrl)).blob()
      bitmap = await decodeBitmap(blob)
      if (!bitmap) {
        report.skipped += 1
        continue
      }
      if (!shouldCompressAsset(mime, bitmap.width, bitmap.height, before, options)) {
        report.skipped += 1
        continue
      }
      const ratio = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
      const targetW = Math.max(1, Math.round(bitmap.width * ratio))
      const targetH = Math.max(1, Math.round(bitmap.height * ratio))
      const encoded = await encodeWebp(bitmap, targetW, targetH, quality)
      if (!encoded || encoded.size === 0 || encoded.size >= before * ASSET_MIN_SAVING_RATIO) {
        report.skipped += 1
        continue
      }
      const next = await blobToDataUrl(encoded)
      report.assets[id] = next
      report.compressed += 1
      report.afterBytes += encoded.size - before
      report.savedBytes += before - encoded.size
    } catch (error) {
      report.failed.push(id)
      console.warn('[export] 素材压缩失败，保留原图', id, error)
    } finally {
      bitmap?.close?.()
    }
  }

  return report
}
