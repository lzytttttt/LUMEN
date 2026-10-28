/**
 * cache.ts —— 响应缓存（`05` §8）：请求级 digest 键 + 7 天 TTL + LRU 200 条 / 4MB。
 *
 * 三条硬规则：
 * - 只存**产物文本**，不存 `system/user` 原文（用户原话不多一份副本，§10）；
 * - 失败文本、空文本、坏 JSON 不入库（避免把「永远失败」缓存下来）；
 * - `replay` 通道不缓存（fixture 本身确定，见 `replay.ts`）。
 *
 * 存储走 `persistence/kv.ts` 的 `aiCache` store（DB v3）；IndexedDB 不可用时 kv 自动降级内存模式，
 * 本模块无需感知。命中计数导出给设置页（`cacheStats()`）。
 */
import { kvDel, kvEntries, kvGet, kvSet, type StoreName } from '@/persistence/kv'
import { shortHash } from '@/schema/ids'
import type { AiFormat, AiTask, AiUsage } from './provider'

export const AI_CACHE_STORE: StoreName = 'aiCache'
/** TTL：7 天（§8.1）。 */
export const AI_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** LRU 条数上限。 */
export const AI_CACHE_MAX_ENTRIES = 200
/** LRU 体积上限（`text.length` 累加，UTF-16 code unit 足够做估算）。 */
export const AI_CACHE_MAX_BYTES = 4 * 1024 * 1024

export interface AiCacheRecord {
  /** = `requestDigestOf(...)`，10 位 base36。 */
  key: string
  task: AiTask
  text: string
  model: string
  format: AiFormat
  usage?: AiUsage
  /** `text.length`。 */
  bytes: number
  createdAt: number
  /** 最近命中时间（LRU 依据）。 */
  at: number
}

export interface DigestInput {
  system: string
  user: string
  model: string
  format: string
  temperature?: number | string
  task?: string
  /** 通道身份（`openai:<endpoint>` / `replay:<setId>`）；fixture 录制时留空。 */
  channel?: string
}

/**
 * 请求级 digest（§7.3）：**不是** `stampBlocks` 的套级 `promptDigest`，两者禁止互用。
 * 字段顺序是契约的一部分：`system ␀ user ␀ model ␀ temperature ␀ format ␀ task ␀ channel`。
 */
export function requestDigestOf(input: DigestInput): string {
  return shortHash(
    [
      input.system,
      input.user,
      input.model,
      String(input.temperature ?? ''),
      input.format,
      input.task ?? '',
      input.channel ?? '',
    ].join('\u0000'),
  )
}

/* -------------------------------- 计数 -------------------------------- */

export interface CacheStats {
  hits: number
  misses: number
  writes: number
  evictions: number
}

let stats: CacheStats = { hits: 0, misses: 0, writes: 0, evictions: 0 }

/** 命中/未命中计数（设置页展示用；只读快照）。 */
export function cacheStats(): CacheStats {
  return { ...stats }
}

export function resetCacheStats(): void {
  stats = { hits: 0, misses: 0, writes: 0, evictions: 0 }
}

/* -------------------------------- 判定 -------------------------------- */

/**
 * 能不能缓存：空文本不行；`json` 请求必须能被 `JSON.parse`（只缓存合格产物，§8.1）。
 */
export function cacheableText(text: string, json: boolean): boolean {
  if (typeof text !== 'string' || text.trim() === '') return false
  if (!json) return true
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return false
  try {
    JSON.parse(text.slice(start, end + 1))
    return true
  } catch {
    return false
  }
}

/* -------------------------------- 读 / 写 -------------------------------- */

/** 读一条；命中会顺手把 `at` 推到当前时间（LRU）。过期条目删除并算 miss。 */
export async function cacheGet(key: string, now = Date.now()): Promise<AiCacheRecord | null> {
  const record = await kvGet<AiCacheRecord>(AI_CACHE_STORE, key)
  if (!record || typeof record.text !== 'string') {
    stats.misses += 1
    return null
  }
  if (now - record.createdAt > AI_CACHE_TTL_MS) {
    stats.misses += 1
    await kvDel(AI_CACHE_STORE, key)
    return null
  }
  stats.hits += 1
  const touched: AiCacheRecord = { ...record, at: now }
  // 命中路径不 await 这次写入：目标首帧 ≤ 50ms（§8.2）。
  void kvSet(AI_CACHE_STORE, key, touched)
  return touched
}

export interface CachePutInput {
  key: string
  task: AiTask
  text: string
  model: string
  format: AiFormat
  usage?: AiUsage
  ttlMs?: number
  createdAt?: number
}

/** 写一条；写入前先淘汰（过期 → 按 `at` 升序删到满足上限，并给新记录留位置）。 */
export async function cachePut(input: CachePutInput, now = Date.now()): Promise<boolean> {
  if (input.text.trim() === '') return false
  const bytes = input.text.length
  // 单条就超预算：不写（否则会把整个缓存清空还放不下）。
  if (bytes > AI_CACHE_MAX_BYTES) return false

  await evict(now, { entries: 1, bytes })

  const record: AiCacheRecord = {
    key: input.key,
    task: input.task,
    text: input.text,
    model: input.model,
    format: input.format,
    usage: input.usage,
    bytes,
    createdAt: input.createdAt ?? now,
    at: now,
  }
  const ok = await kvSet(AI_CACHE_STORE, record.key, record)
  stats.writes += 1
  return ok
}

/**
 * 淘汰：先删过期，再按 `at` 升序删到 ≤ 200 条且 ≤ 4MB。
 * `incoming` 是「即将写入的记录」，用来给新条目预留位置（否则会稳定多出 1 条）。
 * 返回淘汰条数。
 */
export async function evict(
  now = Date.now(),
  incoming: { entries?: number; bytes?: number } = {},
): Promise<number> {
  const reserveEntries = incoming.entries ?? 0
  const reserveBytes = incoming.bytes ?? 0
  const entries = await kvEntries<AiCacheRecord>(AI_CACHE_STORE)
  if (entries.length === 0) return 0

  let removed = 0
  const alive: [string, AiCacheRecord][] = []
  let total = 0

  for (const [key, record] of entries) {
    const expired = !record || now - record.createdAt > AI_CACHE_TTL_MS
    if (expired) {
      await kvDel(AI_CACHE_STORE, key)
      removed += 1
      continue
    }
    alive.push([key, record])
    total += record.bytes ?? record.text.length
  }

  const overEntries = () => alive.length + reserveEntries > AI_CACHE_MAX_ENTRIES
  const overBytes = () => total + reserveBytes > AI_CACHE_MAX_BYTES
  if (overEntries() || overBytes()) {
    alive.sort((a, b) => a[1].at - b[1].at)
    while (alive.length > 0 && (overEntries() || overBytes())) {
      const [key, record] = alive.shift() as [string, AiCacheRecord]
      await kvDel(AI_CACHE_STORE, key)
      total -= record.bytes ?? record.text.length
      removed += 1
    }
  }

  stats.evictions += removed
  return removed
}

/** 设置页「清空缓存」。 */
export async function cacheClear(): Promise<number> {
  const entries = await kvEntries<AiCacheRecord>(AI_CACHE_STORE)
  for (const [key] of entries) await kvDel(AI_CACHE_STORE, key)
  return entries.length
}

/** 全量快照（测试与调试用；200 条可接受）。 */
export async function cacheEntries(): Promise<AiCacheRecord[]> {
  const entries = await kvEntries<AiCacheRecord>(AI_CACHE_STORE)
  return entries.map(([, record]) => record)
}
