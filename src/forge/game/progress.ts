/**
 * forge/game/progress.ts —— 游戏层落盘（03 §7）。
 *
 * `forge` store 是 v0.2.0 新增（kv.ts DB_VERSION 2→3，只新增 store）。
 * 三条硬约束：
 * 1. 记录体积硬上限 6144B（`progressBytes` 走 TextEncoder，按字节而不是字符数）；
 * 2. 写入尾随节流 500ms，`visibilitychange → hidden` 与 `forge.close` 强制 flush（flush 会清定时器）；
 * 3. 迁移是白名单复制：未知字段丢弃、越界裁剪、`level` 由 `xp` 派生；`v > 1` / 解析异常时先备份到 `forge.bak` 再重建。
 */
import { getStorageMode, kvDel, kvGet, kvSet } from '@/persistence/kv'
import { recipeIdSchema, type RecipeId } from '@/schema/deck'
import { ACHIEVEMENT_IDS, levelOf } from './score'

export const PROGRESS_KEY = 'progress'
/** 前向不兼容时的原始记录备份键（03 §7.4）。 */
export const PROGRESS_BACKUP_KEY = 'bak'
export const PROGRESS_VERSION = 1 as const
export const PROGRESS_MAX_BYTES = 6144
/** 落盘尾随节流窗口（03 §7.2）。 */
export const PROGRESS_WRITE_MS = 500

const RECIPE_IDS = recipeIdSchema.options as readonly RecipeId[]
const ACHIEVEMENT_SET = new Set<string>(ACHIEVEMENT_IDS)

export interface ForgeGateEntry {
  deckId: string
  at: number
  error: number
  warn: number
  info: number
}

export interface ForgeProgress {
  v: typeof PROGRESS_VERSION
  xp: number
  level: number
  bestCombo: number
  counters: { deal: number; cast: number; recast: number; gate: number; premiere: number }
  seen: RecipeId[]
  achievements: Record<string, number>
  unlocks: string[]
  gates: ForgeGateEntry[]
  tips: string[]
  createdAt: number
  updatedAt: number
}

export function emptyProgress(now = Date.now()): ForgeProgress {
  return {
    v: PROGRESS_VERSION,
    xp: 0,
    level: 1,
    bestCombo: 0,
    counters: { deal: 0, cast: 0, recast: 0, gate: 0, premiere: 0 },
    seen: [],
    achievements: {},
    unlocks: [],
    gates: [],
    tips: [],
    createdAt: now,
    updatedAt: now,
  }
}

function num(value: unknown, fallback = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 0), max)
}

function strList(value: unknown, max: number, allow?: Set<string>): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    if (allow && !allow.has(item)) continue
    if (out.includes(item)) continue
    out.push(item)
    if (out.length >= max) break
  }
  return out
}

function achievementsOf(value: unknown, now: number): Record<string, number> {
  const out: Record<string, number> = {}
  if (!value || typeof value !== 'object') return out
  for (const [key, at] of Object.entries(value as Record<string, unknown>)) {
    if (!ACHIEVEMENT_SET.has(key)) continue
    if (out[key] !== undefined) continue
    // 越界/非数字一律回落为「本次读到时的时间」；0 保留原值（迁移不发明时间）。
    out[key] = num(at, now)
    if (Object.keys(out).length >= ACHIEVEMENT_IDS.length) break
  }
  return out
}

function gatesOf(value: unknown): ForgeGateEntry[] {
  if (!Array.isArray(value)) return []
  return (value as unknown[])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .slice(-20)
    .map((item) => ({
      deckId: typeof item.deckId === 'string' ? item.deckId.slice(0, 96) : '',
      at: num(item.at),
      error: num(item.error),
      warn: num(item.warn),
      info: num(item.info),
    }))
}

/** 白名单复制 + 越界裁剪；未知字段丢弃（03 §7.4）。 */
export function migrateProgress(raw: unknown): ForgeProgress {
  const now = Date.now()
  if (!raw || typeof raw !== 'object') return emptyProgress(now)
  const input = raw as Record<string, unknown>
  if (input.v !== PROGRESS_VERSION) return emptyProgress(now)
  const countersRaw = (input.counters ?? {}) as Record<string, unknown>
  const xp = num(input.xp, 0, 999_999)
  return trimProgress({
    v: PROGRESS_VERSION,
    xp,
    // `level` 是派生缓存：不信任落盘值（xp = 1e9 也只能到 12，且不会 NaN）。
    level: levelOf(xp),
    bestCombo: Math.min(num(input.bestCombo), 6),
    counters: {
      deal: num(countersRaw.deal),
      cast: num(countersRaw.cast),
      recast: num(countersRaw.recast),
      gate: num(countersRaw.gate),
      premiere: num(countersRaw.premiere),
    },
    seen: strList(input.seen, 12, new Set<string>(RECIPE_IDS)) as RecipeId[],
    achievements: achievementsOf(input.achievements, now),
    // 解锁项只是字符串 id（03 §5.3 的 12 项由等级派生），迁移只做去重与裁剪，不做白名单。
    unlocks: strList(input.unlocks, 12),
    gates: gatesOf(input.gates),
    tips: strList(input.tips, 24),
    createdAt: num(input.createdAt, now),
    updatedAt: num(input.updatedAt, now),
  })
}

/** 该记录是否需要先备份再重建（v>1 / 类型不符 / 解析异常）。 */
export function needsBackup(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false
  if (typeof raw !== 'object') return true
  return (raw as Record<string, unknown>).v !== PROGRESS_VERSION
}

/** 记录体积（字节）。断言：`progressBytes(rec) ≤ 6144`。 */
export function progressBytes(rec: ForgeProgress): number {
  const json = JSON.stringify(rec)
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).length
  return json.length
}

/** 超限时按 FIFO 丢 `gates` → `tips`，最后再兜底清空可选集合；固定字段永不动。 */
export function trimProgress(rec: ForgeProgress): ForgeProgress {
  if (progressBytes(rec) <= PROGRESS_MAX_BYTES) return rec
  let next: ForgeProgress = rec
  while (next.gates.length > 0 && progressBytes(next) > PROGRESS_MAX_BYTES) {
    next = { ...next, gates: next.gates.slice(1) }
  }
  while (next.tips.length > 0 && progressBytes(next) > PROGRESS_MAX_BYTES) {
    next = { ...next, tips: next.tips.slice(1) }
  }
  if (progressBytes(next) > PROGRESS_MAX_BYTES) {
    next = { ...next, gates: [], tips: [], unlocks: next.unlocks.slice(0, 12), seen: next.seen.slice(0, 12) }
  }
  return next
}

let cache: ForgeProgress | null = null
let pending: ForgeProgress | null = null
let timer: number | null = null

export function cachedProgress(): ForgeProgress {
  return cache ?? emptyProgress()
}

/** 读一次进度；`v>1` 或类型不符时先写 `forge.bak` 再重建（界面静默自愈）。 */
export async function loadProgress(): Promise<ForgeProgress> {
  if (cache) return cache
  let raw: unknown
  try {
    raw = await kvGet<unknown>('forge', PROGRESS_KEY)
  } catch {
    cache = emptyProgress()
    return cache
  }
  cache = migrateProgress(raw)
  if (needsBackup(raw)) {
    try {
      await kvSet('forge', PROGRESS_BACKUP_KEY, raw)
    } catch {
      /* 备份失败不影响重建 */
    }
  }
  return cache
}

function schedule(): void {
  if (typeof window === 'undefined') return
  if (timer !== null) return
  timer = window.setTimeout(() => {
    timer = null
    void flushProgress()
  }, PROGRESS_WRITE_MS)
}

/** 更新内存记录并节流落盘；返回裁剪后的最新记录。 */
export function commitProgress(rec: ForgeProgress): ForgeProgress {
  const next = trimProgress({ ...rec, updatedAt: Date.now() })
  cache = next
  pending = next
  schedule()
  return next
}

/** 立刻落盘（hidden / 关闭造幕台 / 清空），并清掉尾随定时器。 */
export async function flushProgress(): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  const value = pending
  pending = null
  if (!value) return
  try {
    await kvSet('forge', PROGRESS_KEY, trimProgress(value))
  } catch {
    /* 内存模式：忽略，界面照常（03 §1 铁律 1） */
  }
}

export async function resetProgress(): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  cache = emptyProgress()
  pending = null
  try {
    await kvDel('forge', PROGRESS_KEY)
  } catch {
    /* ignore */
  }
}

export function storageDegraded(): boolean {
  return getStorageMode() === 'memory'
}
