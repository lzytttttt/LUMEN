/**
 * forge/game/score.ts —— 纯函数计分内核（03 §4/§5/§6）。
 *
 * 只有 4 个白名单动作可计分；同一 deck（同一幕）幂等，重复不计。
 * 成就只记录、不发 XP（断言：解锁前后 xp / level 不变）。
 */
import type { RecipeId } from '@/schema/deck'
import type { ForgeProgress } from './progress'

export type ScoreAction = 'cast.complete' | 'recast.ok' | 'gate.pass' | 'premiere.start'

export const BASE_XP: Record<ScoreAction, number> = {
  'cast.complete': 20,
  'recast.ok': 8,
  'gate.pass': 12,
  'premiere.start': 10,
}

export const MAX_COMBO = 6
export const COMBO_IDLE_MS = 90_000

/** 先自增 combo（上限 6），再结算：单动作最多 20 + 10 = 30 XP。 */
export function xpOf(action: ScoreAction, combo: number): number {
  const level = Math.min(Math.max(combo, 1), MAX_COMBO)
  return BASE_XP[action] + 2 * (level - 1)
}

/** 连击衰减（懒结算，无定时器）。 */
export function settle(now: number, state: { count: number; lastAt: number }): { count: number; lastAt: number } {
  const steps = Math.max(0, Math.floor((now - state.lastAt) / COMBO_IDLE_MS))
  return {
    count: Math.max(0, state.count - steps),
    lastAt: state.lastAt + steps * COMBO_IDLE_MS,
  }
}

export function comboAfterTick(count: number): number {
  return Math.min(Math.max(count + 1, 1), MAX_COMBO)
}

/** 升级所需 XP（升到 n+1 级）。 */
export function levelCost(n: number): number {
  return Math.min(300, Math.ceil(30 * Math.pow(1.3, n - 1)))
}

/** 到达 n 级的累计 XP。 */
export function levelTotal(n: number): number {
  let sum = 0
  for (let k = 1; k < n; k += 1) sum += levelCost(k)
  return sum
}

export function levelOf(xp: number): number {
  let n = 1
  while (n < 12 && xp >= levelTotal(n + 1)) n += 1
  return n
}

export const ACHIEVEMENT_IDS = [
  'first_cast',
  'nine_slides',
  'clean_slide',
  'four_recipes',
  'all_recipes',
  'hour_premiere',
  'keyboard_only',
  'recast_better',
  'gate_clean',
  'late_cast',
  'three_one',
  'hand_edit',
] as const

export type AchievementId = (typeof ACHIEVEMENT_IDS)[number]

/** min 档启用的 3 条（01 §4 方案 A）。 */
export const MIN_ACHIEVEMENTS: AchievementId[] = ['first_cast', 'clean_slide', 'four_recipes']

/**
 * 12 项等级解锁（03 §5.3）：只有皮肤 / 装饰 / 快捷键别名，全部不阻塞功能。
 * id 按等级顺序，`unlocksForLevel(n)` 直接切前 n 项。
 */
export const UNLOCK_IDS = [
  'surface.ink',
  'shortcut.n',
  'card.fold',
  'deco.ticks',
  'shortcut.p',
  'surface.mist',
  'deco.lamps',
  'shortcut.u',
  'card.line',
  'surface.paper',
  'deco.margin',
  'card.foil',
] as const

export type UnlockId = (typeof UNLOCK_IDS)[number]

/** 等级 → 已解锁项（1 级 = 台面·墨；12 级 = 全部）。 */
export function unlocksForLevel(level: number): string[] {
  const n = Math.min(Math.max(Math.trunc(level), 1), UNLOCK_IDS.length)
  return UNLOCK_IDS.slice(0, n)
}

export interface AchievementContext {
  deckId: string | null
  slideCount: number
  recipes: RecipeId[]
  warnings: string[]
  threeSlides: number
  dealAt: number
  premiereAt: number
  gateClean: boolean
  recastBetter: boolean
  keyboardOnly: boolean
  handEdit: boolean
  now: number
  /** `progress.seen.length`（已收集卡，跨套累计）；缺省退回本套 distinct（03 §6 #5）。 */
  seenCount?: number
}

function hasCleanSlide(ctx: AchievementContext): boolean {
  if (ctx.slideCount < 3) return false
  for (let i = 1; i <= ctx.slideCount; i += 1) {
    if (!ctx.warnings.some((warn) => warn.startsWith(`#${i} `))) return true
  }
  return false
}

/** 判据只用成稿后的真值（03 §6 末段）。 */
export function evaluateAchievements(ctx: AchievementContext): AchievementId[] {
  const distinct = new Set(ctx.recipes).size
  const seen = Math.max(distinct, ctx.seenCount ?? 0)
  const hits: AchievementId[] = []
  if (ctx.slideCount >= 1) hits.push('first_cast')
  if (ctx.slideCount >= 9) hits.push('nine_slides')
  if (hasCleanSlide(ctx)) hits.push('clean_slide')
  if (distinct >= 4) hits.push('four_recipes')
  if (seen >= 12) hits.push('all_recipes')
  if (ctx.premiereAt > 0 && ctx.premiereAt - ctx.dealAt <= 3_600_000) hits.push('hour_premiere')
  if (ctx.keyboardOnly) hits.push('keyboard_only')
  if (ctx.recastBetter) hits.push('recast_better')
  if (ctx.gateClean) hits.push('gate_clean')
  const hour = new Date(ctx.now).getHours()
  if (hour >= 0 && hour <= 4) hits.push('late_cast')
  if (ctx.threeSlides > 0) hits.push('three_one')
  if (ctx.handEdit) hits.push('hand_edit')
  return hits
}

export function achievementAllowed(id: AchievementId, gameplay: 'min' | 'full'): boolean {
  return gameplay === 'full' || MIN_ACHIEVEMENTS.includes(id)
}

export function unlockAchievement(rec: ForgeProgress, id: AchievementId, now: number): ForgeProgress {
  if (rec.achievements[id]) return rec
  return { ...rec, achievements: { ...rec.achievements, [id]: now } }
}

/** 统一结算入口：xp 只增、level 派生、counters 自增。 */
export function applyScore(
  rec: ForgeProgress,
  action: ScoreAction,
  combo: number,
): { rec: ForgeProgress; xp: number; gained: number } {
  const gained = xpOf(action, combo)
  const xp = Math.min(rec.xp + gained, 999_999)
  const counterKey =
    action === 'cast.complete' ? 'cast' : action === 'recast.ok' ? 'recast' : action === 'gate.pass' ? 'gate' : 'premiere'
  const next: ForgeProgress = {
    ...rec,
    xp,
    level: levelOf(xp),
    counters: { ...rec.counters, [counterKey]: rec.counters[counterKey] + 1 },
    bestCombo: Math.max(rec.bestCombo, Math.min(combo, MAX_COMBO)),
  }
  return { rec: next, xp, gained }
}

export function addSeen(rec: ForgeProgress, recipes: RecipeId[]): ForgeProgress {
  const seen = Array.from(new Set([...rec.seen, ...recipes])).slice(0, 12)
  return { ...rec, seen }
}
