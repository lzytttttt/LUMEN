/**
 * asset-compress.test.ts —— 单文件导出前的素材重采样纯逻辑。
 *
 * jsdom 没有 createImageBitmap，所以 compressDataUrlAssets 只能验证
 * "无能力时原样返回"；真正的编码路径由浏览器导出闭环覆盖。
 */
import { describe, expect, it } from 'vitest'
import {
  ASSET_COMPRESS_MIN_BYTES,
  ASSET_MAX_EDGE,
  ASSET_RECOMPRESS_BYTES,
  compressDataUrlAssets,
  dataUrlByteLength,
  shouldCompressAsset,
} from '@/export/assetCompress'

describe('assetCompress: 体积估算', () => {
  it('按 base64 padding 折算二进制字节', () => {
    expect(dataUrlByteLength('data:image/png;base64,AAAA')).toBe(3)
    expect(dataUrlByteLength('data:image/png;base64,AAA=')).toBe(2)
    expect(dataUrlByteLength('data:image/png;base64,AA==')).toBe(1)
    expect(dataUrlByteLength('data:image/svg+xml,%3Csvg/%3E')).toBe(10)
    expect(dataUrlByteLength('not-a-data-url')).toBe(0)
  })
})

describe('assetCompress: 是否需要重编码', () => {
  it('跳过矢量图、动图与非图片', () => {
    expect(shouldCompressAsset('image/svg+xml', 4000, 4000, 9_000_000)).toBe(false)
    expect(shouldCompressAsset('image/gif', 4000, 4000, 9_000_000)).toBe(false)
    expect(shouldCompressAsset('video/mp4', 4000, 4000, 9_000_000)).toBe(false)
  })

  it('小图不动、超大图/超重图重编码', () => {
    expect(shouldCompressAsset('image/webp', 800, 600, ASSET_COMPRESS_MIN_BYTES - 1)).toBe(false)
    expect(shouldCompressAsset('image/png', ASSET_MAX_EDGE + 1, 900, 200 * 1024)).toBe(true)
    expect(shouldCompressAsset('image/webp', 1000, 1000, ASSET_RECOMPRESS_BYTES + 1)).toBe(true)
  })
})

describe('assetCompress: 无 Canvas 能力时原样返回', () => {
  it('jsdom 下不改变素材，也不报错', async () => {
    const assets = {
      a: 'data:image/png;base64,AAAA',
      b: 'data:image/svg+xml,%3Csvg/%3E',
    }
    const report = await compressDataUrlAssets(assets)
    expect(report.assets).toEqual(assets)
    expect(report.compressed).toBe(0)
    expect(report.failed).toEqual([])
    expect(report.beforeBytes).toBe(report.afterBytes)
    expect(report.savedBytes).toBe(0)
  })
})
