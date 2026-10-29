/**
 * gc.ts —— 资产引用计数与垃圾回收。
 *
 * 为什么需要：素材以 Blob 存在 IndexedDB 的 `assets` 表，deck 只存 `assetId`。
 * 删幕、删块、换图之后旧 Blob 没有任何引用，却会一直占配额；浏览器配额回收
 * 时又可能把正在用的资产一起清掉。所以在启动后空闲时做一次"只删孤儿"的清理：
 *
 * - 引用源 = 所有已保存 deck（`decks` 表）+ 当前编辑中的 deck；
 * - 只要有任何一份 deck 解析失败，整轮 GC 直接跳过（无法证明某资产没被引用）；
 * - 新资产有保护期（默认 24h）：刚导入、还没来得及写进 deck 的图不会被误删；
 * - 全部失败都吞掉，只 console.info 汇总，绝不阻塞启动。
 */
import { deckSchema, type Deck } from '@/schema/deck'
import { deleteAsset } from '@/assets/assetStore'
import { kvEntries } from '@/persistence/kv'
import { useDeckStore } from '@/state/deckStore'
import { collectAssetIds } from '@/export/projectFile'

/** 默认保护期：24 小时。 */
export const ASSET_GC_GRACE_MS = 24 * 60 * 60 * 1000
/** 空闲调度上限：浏览器一直忙也要在 4s 后兜底跑一次。 */
export const ASSET_GC_DELAY_MS = 4000

export interface AssetGcResult {
  scanned: number
  deleted: number
  skipped: boolean
  reason?: 'unreadable-deck' | 'storage-error'
}

/** 纯函数：stored 里既没被引用、也不在保护名单中的 id 就是可删候选。 */
export function diffAssetIds(
  referenced: ReadonlySet<string>,
  stored: readonly string[],
  protect: ReadonlySet<string> = new Set(),
): string[] {
  return stored.filter((id) => !referenced.has(id) && !protect.has(id))
}

/** 纯函数：资产是否已过保护期（缺 createdAt 视为很旧，可删）。 */
export function isAssetStale(createdAt: number | undefined, now: number, graceMs: number): boolean {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) return true
  return now - createdAt >= graceMs
}

interface StoredAsset {
  id?: string
  createdAt?: number
}

/**
 * 跑一轮 GC。默认只删「没有任何 deck 引用 + 已过保护期」的资产。
 * 调用方不需要 await 它的结果（bootstrap 走空闲调度）。
 */
export async function runAssetGc(options: { graceMs?: number; now?: number } = {}): Promise<AssetGcResult> {
  const graceMs = options.graceMs ?? ASSET_GC_GRACE_MS
  const now = options.now ?? Date.now()
  const referenced = new Set<string>()
  let scanned = 0

  try {
    const storedDecks = await kvEntries<unknown>('decks')
    for (const [, raw] of storedDecks) {
      const parsed = deckSchema.safeParse(raw)
      if (!parsed.success) {
        // 解析失败就没法证明它的资产没被引用：宁可不删，也不能删用户正在用的图。
        return { scanned: 0, deleted: 0, skipped: true, reason: 'unreadable-deck' }
      }
      for (const id of collectAssetIds(parsed.data)) referenced.add(id)
    }
  } catch (error) {
    console.info('[assets] GC 读取 deck 失败，跳过本轮', error)
    return { scanned: 0, deleted: 0, skipped: true, reason: 'storage-error' }
  }

  const current: Deck | null = useDeckStore.getState().deck
  if (current) {
    for (const id of collectAssetIds(current)) referenced.add(id)
  }

  let stored: Array<[string, StoredAsset | undefined]>
  try {
    stored = await kvEntries<StoredAsset>('assets')
  } catch (error) {
    console.info('[assets] GC 读取资产失败，跳过本轮', error)
    return { scanned: 0, deleted: 0, skipped: true, reason: 'storage-error' }
  }

  scanned = stored.length
  const stale: string[] = []
  for (const [id, record] of stored) {
    if (referenced.has(id)) continue
    if (!isAssetStale(record?.createdAt, now, graceMs)) continue
    stale.push(id)
  }

  let deleted = 0
  for (const id of stale) {
    try {
      await deleteAsset(id)
      deleted += 1
    } catch (error) {
      console.warn('[assets] GC 删除失败', id, error)
    }
  }
  if (deleted > 0) console.info(`[assets] GC 清理 ${deleted} 个未引用资产（扫描 ${scanned} 个）`)
  return { scanned, deleted, skipped: false }
}

/** 启动后空闲调度一次；返回取消函数（测试/热更新用）。 */
export function scheduleAssetGc(options: { graceMs?: number; delayMs?: number } = {}): () => void {
  const delayMs = options.delayMs ?? ASSET_GC_DELAY_MS
  let cancelled = false
  const run = () => {
    if (cancelled) return
    void runAssetGc({ graceMs: options.graceMs }).catch((error) => {
      console.info('[assets] GC 未完成', error)
    })
  }

  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback
  if (typeof idle === 'function') {
    const handle = idle(run, { timeout: delayMs })
    return () => {
      cancelled = true
      ;(globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback?.(handle)
    }
  }

  const timer = setTimeout(run, delayMs)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}
