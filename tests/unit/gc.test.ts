/**
 * gc.test.ts —— 资产引用计数与垃圾回收的边界。
 *
 * runAssetGc 依赖 kv / 资产库，用 vi.mock 换成内存桩；
 * 纯函数（diffAssetIds / isAssetStale）单独覆盖，保证"删谁不删谁"可回归。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSampleDeck } from '@/sample/sample-deck'
import type { Deck } from '@/schema/deck'

const mocks = vi.hoisted(() => ({
  kvEntries: vi.fn(),
  deleteAsset: vi.fn(),
  collectAssetIds: vi.fn(),
}))

vi.mock('@/persistence/kv', () => ({ kvEntries: mocks.kvEntries }))
vi.mock('@/assets/assetStore', () => ({ deleteAsset: mocks.deleteAsset }))
vi.mock('@/export/projectFile', () => ({ collectAssetIds: mocks.collectAssetIds }))

import { ASSET_GC_GRACE_MS, diffAssetIds, isAssetStale, runAssetGc } from '@/assets/gc'

function deck(): Deck {
  return createSampleDeck('zh')
}

describe('gc: 纯函数', () => {
  it('只删既未引用也不在保护名单里的 id', () => {
    const referenced = new Set(['a', 'b'])
    const protect = new Set(['b', 'c'])
    expect(diffAssetIds(referenced, ['a', 'b', 'c', 'd', 'e'], protect)).toEqual(['d', 'e'])
  })

  it('保护期按 createdAt 判断，缺失/非法时间视为可清理', () => {
    const now = 10_000_000
    expect(isAssetStale(now - ASSET_GC_GRACE_MS - 1, now, ASSET_GC_GRACE_MS)).toBe(true)
    expect(isAssetStale(now - 1000, now, ASSET_GC_GRACE_MS)).toBe(false)
    expect(isAssetStale(undefined, now, ASSET_GC_GRACE_MS)).toBe(true)
    expect(isAssetStale(0, now, ASSET_GC_GRACE_MS)).toBe(true)
    expect(isAssetStale(Number.NaN, now, ASSET_GC_GRACE_MS)).toBe(true)
  })
})

describe('gc: runAssetGc', () => {
  beforeEach(() => {
    mocks.kvEntries.mockReset()
    mocks.deleteAsset.mockReset().mockResolvedValue(undefined)
    mocks.collectAssetIds.mockReset().mockReturnValue(['used'])
  })

  it('保留被引用资产、删除孤儿、尊重保护期', async () => {
    const now = 1_700_000_000_000
    mocks.kvEntries.mockImplementation(async (name: string) => {
      if (name === 'decks') return [['deck-1', deck()]]
      return [
        ['used', { createdAt: now - ASSET_GC_GRACE_MS * 2 }],
        ['orphan', { createdAt: now - ASSET_GC_GRACE_MS * 2 }],
        ['fresh', { createdAt: now - 1000 }],
        ['legacy', { createdAt: undefined }],
      ]
    })

    const result = await runAssetGc({ now })
    expect(result).toEqual({ scanned: 4, deleted: 2, skipped: false })
    expect(mocks.deleteAsset.mock.calls.map(([id]) => id).sort()).toEqual(['legacy', 'orphan'])
  })

  it('有任何 deck 解析失败时整轮跳过（不能猜它引用了什么）', async () => {
    mocks.kvEntries.mockImplementation(async (name: string) => {
      if (name === 'decks') return [['broken', { title: 42 }]]
      return [['orphan', { createdAt: 0 }]]
    })
    const result = await runAssetGc({ now: Date.now() })
    expect(result).toEqual({ scanned: 0, deleted: 0, skipped: true, reason: 'unreadable-deck' })
    expect(mocks.deleteAsset).not.toHaveBeenCalled()
  })

  it('存储读取失败时安静跳过', async () => {
    mocks.kvEntries.mockRejectedValue(new Error('idb down'))
    const result = await runAssetGc()
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('storage-error')
    expect(mocks.deleteAsset).not.toHaveBeenCalled()
  })
})
