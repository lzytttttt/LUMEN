/**
 * forge-score.test.ts —— 计分内核与落盘记录（`src/forge/game/score.ts` / `progress.ts`）。
 *
 * 依据：`plan/v0.2.0/03` §4（连击）/ §5（等级）/ §6（成就）/ §7（落盘与体积）、`07` §3.3 的 G-01…G-07。
 * 纯函数层可重复调用；「同一动作只计一次」的幂等由 `useForgeGame` 的 `scoredRef: Set` 保证，
 * 这里用静态断言锁住那段实现，避免纯函数被误当成幂等入口。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RecipeId } from '@/schema/deck'
import { slideSchema } from '@/schema/deck'
import {
  ACHIEVEMENT_IDS,
  BASE_XP,
  COMBO_IDLE_MS,
  MAX_COMBO,
  MIN_ACHIEVEMENTS,
  achievementAllowed,
  addSeen,
  applyScore,
  comboAfterTick,
  evaluateAchievements,
  levelCost,
  levelOf,
  levelTotal,
  settle,
  unlockAchievement,
  xpOf,
  type AchievementContext,
  type AchievementId,
  type ScoreAction,
} from '@/forge/game/score'
import {
  PROGRESS_KEY,
  PROGRESS_MAX_BYTES,
  PROGRESS_VERSION,
  emptyProgress,
  migrateProgress,
  type ForgeGateEntry,
  type ForgeProgress,
} from '@/forge/game/progress'

const ACTIONS: ScoreAction[] = ['cast.complete', 'recast.ok', 'gate.pass', 'premiere.start']

/* -------------------------------- xpOf --------------------------------- */

describe('xpOf · 连击加成', () => {
  it('adds 2 XP per combo step with a hard cap at 6', () => {
    expect(xpOf('cast.complete', 1)).toBe(20)
    expect(xpOf('cast.complete', 2)).toBe(22)
    expect(xpOf('cast.complete', 3)).toBe(24)
    expect(xpOf('cast.complete', 4)).toBe(26)
    expect(xpOf('cast.complete', 5)).toBe(28)
    expect(xpOf('cast.complete', 6)).toBe(30)
    expect(xpOf('cast.complete', 7)).toBe(30)
    expect(xpOf('cast.complete', 99)).toBe(30)
  })

  it('clamps combo below 1 to the first tier', () => {
    expect(xpOf('recast.ok', 0)).toBe(8)
    expect(xpOf('recast.ok', -3)).toBe(8)
    expect(xpOf('recast.ok', 0)).toBe(xpOf('recast.ok', 1))
  })

  it('keeps every action on its own base value', () => {
    for (const action of ACTIONS) {
      expect(xpOf(action, 1)).toBe(BASE_XP[action])
      expect(xpOf(action, 6)).toBe(BASE_XP[action] + 10)
    }
    expect(BASE_XP['gate.pass']).toBe(12)
    expect(BASE_XP['premiere.start']).toBe(10)
    expect(MAX_COMBO).toBe(6)
  })
})

/* -------------------------------- settle -------------------------------- */

describe('settle · 90s 连击衰减', () => {
  it('keeps the combo inside the idle window', () => {
    const state = { count: 4, lastAt: 1_000 }
    expect(settle(1_000 + COMBO_IDLE_MS - 1, state)).toEqual({ count: 4, lastAt: 1_000 })
  })

  it('drops one step per full idle window', () => {
    expect(settle(1_000 + COMBO_IDLE_MS, { count: 4, lastAt: 1_000 })).toEqual({ count: 3, lastAt: 91_000 })
    expect(settle(1_000 + COMBO_IDLE_MS * 3 + 17, { count: 4, lastAt: 1_000 })).toEqual({
      count: 1,
      lastAt: 271_000,
    })
  })

  it('never goes below zero and ignores backwards clocks', () => {
    expect(settle(1_000 + COMBO_IDLE_MS * 9, { count: 1, lastAt: 1_000 }).count).toBe(0)
    expect(settle(5_000, { count: 2, lastAt: 10_000 })).toEqual({ count: 2, lastAt: 10_000 })
  })

  it('increments combo up to 6 starting from 0', () => {
    expect(comboAfterTick(0)).toBe(1)
    expect(comboAfterTick(1)).toBe(2)
    expect(comboAfterTick(5)).toBe(6)
    expect(comboAfterTick(6)).toBe(6)
    expect(comboAfterTick(-1)).toBe(1)
  })
})

/** 与 `settle` 同签名的时间基准常量（`settle` 直接接受 now）。 */
const IDLE = COMBO_IDLE_MS

/* -------------------------------- 等级曲线 ------------------------------- */

describe('levelCost / levelTotal / levelOf · 等级曲线', () => {
  it('grows 30 → 39 → 51 … and caps every step at 300', () => {
    expect(levelCost(1)).toBe(30)
    expect(levelCost(2)).toBe(39)
    expect(levelCost(3)).toBe(51)
    expect(levelCost(4)).toBe(66)
    expect(levelCost(9)).toBe(245)
    expect(levelCost(10)).toBe(300)
    expect(levelCost(40)).toBe(300)
  })

  it('sums cumulative XP for each level', () => {
    expect(levelTotal(1)).toBe(0)
    expect(levelTotal(2)).toBe(30)
    expect(levelTotal(3)).toBe(69)
    expect(levelTotal(12)).toBe(1563)
  })

  it('maps XP to the documented levels', () => {
    expect(levelOf(0)).toBe(1)
    expect(levelOf(29)).toBe(1)
    expect(levelOf(30)).toBe(2)
    expect(levelOf(68)).toBe(2)
    expect(levelOf(69)).toBe(3)
    expect(levelOf(1562)).toBe(11)
    expect(levelOf(1563)).toBe(12)
    expect(levelOf(1e9)).toBe(12)
    expect(levelOf(Number.MAX_SAFE_INTEGER)).toBe(12)
  })

  it('is monotonic and never NaN', () => {
    let previous = levelOf(0)
    for (let xp = 0; xp <= 4000; xp += 37) {
      const level = levelOf(xp)
      expect(Number.isFinite(level)).toBe(true)
      expect(level).toBeGreaterThanOrEqual(previous)
      previous = level
    }
  })
})

/* ------------------------------- applyScore ------------------------------ */

describe('applyScore · 结算与边界', () => {
  it('adds XP once per call, bumps the counter and derives the level', () => {
    const start = emptyProgress(1)
    const first = applyScore(start, 'cast.complete', 1)
    expect(first.gained).toBe(20)
    expect(first.xp).toBe(20)
    expect(first.rec.xp).toBe(20)
    expect(first.rec.level).toBe(1)
    expect(first.rec.counters.cast).toBe(1)
    expect(first.rec.bestCombo).toBe(1)

    const second = applyScore(first.rec, 'gate.pass', 2)
    expect(second.rec.xp).toBe(34)
    expect(second.rec.counters.gate).toBe(1)
    expect(second.rec.counters.cast).toBe(1)
    expect(second.rec.bestCombo).toBe(2)
    expect(second.rec.level).toBe(2)
  })

  it('does not mutate the record it was given', () => {
    const start = emptyProgress(1)
    const snapshot = JSON.parse(JSON.stringify(start)) as ForgeProgress
    applyScore(start, 'premiere.start', 4)
    expect(start).toEqual(snapshot)
  })

  it('advances each counter through its own action', () => {
    let rec = emptyProgress(1)
    for (const action of ['cast.complete', 'recast.ok', 'gate.pass', 'premiere.start'] as ScoreAction[]) {
      rec = applyScore(rec, action, 1).rec
    }
    expect(rec.counters).toEqual({ deal: 0, cast: 1, recast: 1, gate: 1, premiere: 1 })
  })

  it('caps XP at 999_999 and level at 12', () => {
    const huge: ForgeProgress = { ...emptyProgress(1), xp: 999_990, level: 11 }
    const result = applyScore(huge, 'cast.complete', 6)
    expect(result.rec.xp).toBe(999_999)
    expect(result.rec.level).toBe(12)
  })

  it('clamps bestCombo to 0–6', () => {
    const rec = applyScore(emptyProgress(1), 'cast.complete', 99)
    expect(rec.rec.bestCombo).toBe(6)
    const kept = applyScore({ ...emptyProgress(1), bestCombo: 5 }, 'cast.complete', 2)
    expect(kept.rec.bestCombo).toBe(5)
  })
})

/* ---------------------------------- 幂等 --------------------------------- */

describe('幂等 · 由 useForgeGame 的 Set 保证', () => {
  it('the pure layer keeps adding on every call (so callers must guard)', () => {
    let rec = emptyProgress(1)
    for (let i = 0; i < 5; i += 1) rec = applyScore(rec, 'recast.ok', 1).rec
    expect(rec.xp).toBe(40)
    expect(rec.counters.recast).toBe(5)
  })

  it('useForgeGame guards each scored action with a Set', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/forge/game/useForgeGame.ts'), 'utf8')
    expect(source).toContain('scoredRef = useRef(new Set<string>())')
    expect(source).toContain('if (scoredRef.current.has(scoredKey)) return false')
    expect(source).toContain('scoredRef.current.add(scoredKey)')
    expect(source).toContain('scoredRef.current.clear()')
    // 同一 deck 的重铸按幕号区分：连点同一幕只计一次（G-02）。
    expect(source).toContain('`recast.ok#${id}#${index}`')
    expect(source).toContain('`cast.complete#${id}`')
    expect(source).toContain('`gate.pass#${id ?? \'forge\'}`')
  })
})

/* ---------------------------------- 成就 --------------------------------- */

const BASE_CTX: AchievementContext = {
  deckId: 'deck-1',
  slideCount: 0,
  recipes: [],
  warnings: [],
  threeSlides: 0,
  dealAt: 1_000,
  premiereAt: 0,
  gateClean: false,
  recastBetter: false,
  keyboardOnly: false,
  handEdit: false,
  now: new Date(2026, 0, 1, 12, 0, 0).getTime(),
}

function ctx(patch: Partial<AchievementContext>): AchievementContext {
  return { ...BASE_CTX, ...patch }
}

const NINE_RECIPES: RecipeId[] = ['cover', 'statement', 'split', 'grid3', 'grid4', 'timeline', 'compare', 'quote', 'closing']
const TWELVE_RECIPES: RecipeId[] = [...NINE_RECIPES, 'data', 'process', 'gallery']

describe('evaluateAchievements · 12 条判据', () => {
  it('returns nothing on an empty deck', () => {
    expect(evaluateAchievements(ctx({}))).toEqual([])
  })

  it('unlocks first_cast and nine_slides from the real slide count', () => {
    expect(evaluateAchievements(ctx({ slideCount: 1 }))).toEqual(['first_cast'])
    expect(evaluateAchievements(ctx({ slideCount: 8 }))).toEqual(['first_cast', 'clean_slide'])
    expect(evaluateAchievements(ctx({ slideCount: 9 }))).toEqual(['first_cast', 'nine_slides', 'clean_slide'])
  })

  it('counts a clean slide only when at least one of 3+ slides has no warning', () => {
    expect(
      evaluateAchievements(ctx({ slideCount: 3, warnings: ['#1 warn contrast', '#2 warn fontSize'] })),
    ).toEqual(['first_cast', 'clean_slide'])
    expect(
      evaluateAchievements(ctx({ slideCount: 3, warnings: ['#1 warn contrast', '#2 warn fontSize', '#3 warn a11y'] })),
    ).toEqual(['first_cast'])
    expect(evaluateAchievements(ctx({ slideCount: 2, warnings: ['#1 warn contrast'] }))).toEqual(['first_cast'])
  })

  it('requires 4 distinct recipes, not 4 slides', () => {
    expect(evaluateAchievements(ctx({ slideCount: 4, recipes: ['cover', 'cover', 'cover', 'closing'] }))).toEqual([
      'first_cast',
      'clean_slide',
    ])
    expect(
      evaluateAchievements(ctx({ slideCount: 4, recipes: ['cover', 'statement', 'split', 'closing'] })),
    ).toContain('four_recipes')
  })

  it('unlocks all_recipes at 12 distinct recipes', () => {
    const hits = evaluateAchievements(ctx({ slideCount: 12, recipes: TWELVE_RECIPES }))
    expect(hits).toContain('four_recipes')
    expect(hits).toContain('all_recipes')
    expect(evaluateAchievements(ctx({ slideCount: 11, recipes: TWELVE_RECIPES.slice(0, 11) }))).not.toContain(
      'all_recipes',
    )
  })

  it('unlocks hour_premiere only within one hour of the deal', () => {
    expect(evaluateAchievements(ctx({ deckId: 'd', dealAt: 1_000, premiereAt: 3_600_000 }))).toContain('hour_premiere')
    expect(evaluateAchievements(ctx({ deckId: 'd', dealAt: 1_000, premiereAt: 3_601_001 }))).not.toContain(
      'hour_premiere',
    )
    expect(evaluateAchievements(ctx({ premiereAt: 0 }))).not.toContain('hour_premiere')
  })

  it('unlocks the behavioural flags', () => {
    expect(evaluateAchievements(ctx({ keyboardOnly: true }))).toEqual(['keyboard_only'])
    expect(evaluateAchievements(ctx({ recastBetter: true }))).toEqual(['recast_better'])
    expect(evaluateAchievements(ctx({ gateClean: true }))).toEqual(['gate_clean'])
    expect(evaluateAchievements(ctx({ threeSlides: 1 }))).toEqual(['three_one'])
    expect(evaluateAchievements(ctx({ handEdit: true }))).toEqual(['hand_edit'])
  })

  it('unlocks late_cast between 00:00 and 04:59 local time', () => {
    expect(evaluateAchievements(ctx({ now: new Date(2026, 0, 1, 0, 0, 0).getTime() }))).toEqual(['late_cast'])
    expect(evaluateAchievements(ctx({ now: new Date(2026, 0, 1, 4, 59, 0).getTime() }))).toEqual(['late_cast'])
    expect(evaluateAchievements(ctx({ now: new Date(2026, 0, 1, 5, 0, 0).getTime() }))).toEqual([])
  })

  it('reports all twelve in a single perfect run', () => {
    const hits = evaluateAchievements(
      ctx({
        slideCount: 12,
        recipes: TWELVE_RECIPES,
        warnings: [],
        threeSlides: 2,
        dealAt: 1_000,
        premiereAt: 1_001,
        gateClean: true,
        recastBetter: true,
        keyboardOnly: true,
        handEdit: true,
        now: new Date(2026, 0, 1, 3, 0, 0).getTime(),
      }),
    )
    expect(hits.sort()).toEqual([...ACHIEVEMENT_IDS].sort())
    expect(ACHIEVEMENT_IDS).toHaveLength(12)
  })

  it('gates achievements by the min / full gameplay switch', () => {
    expect(MIN_ACHIEVEMENTS).toEqual(['first_cast', 'clean_slide', 'four_recipes'])
    for (const id of ACHIEVEMENT_IDS) {
      expect(achievementAllowed(id, 'full')).toBe(true)
    }
    expect(achievementAllowed('first_cast', 'min')).toBe(true)
    expect(achievementAllowed('nine_slides', 'min')).toBe(false)
    expect(achievementAllowed('hand_edit', 'min')).toBe(false)
  })

  it('unlocks an achievement only once and keeps xp untouched', () => {
    const rec = emptyProgress(1)
    const once = unlockAchievement(rec, 'first_cast', 5_000)
    expect(once.achievements.first_cast).toBe(5_000)
    expect(once.xp).toBe(rec.xp)
    expect(once.level).toBe(rec.level)
    expect(unlockAchievement(once, 'first_cast', 9_000)).toBe(once)
  })
})

/* -------------------------------- 记录与体积 ------------------------------ */

describe('migrateProgress · 白名单与边界', () => {
  it('exposes the documented store contract', () => {
    expect(PROGRESS_VERSION).toBe(1)
    expect(PROGRESS_KEY).toBe('progress')
    expect(PROGRESS_MAX_BYTES).toBe(6144)
    const empty = emptyProgress(42)
    expect(empty).toMatchObject({
      v: 1,
      xp: 0,
      level: 1,
      bestCombo: 0,
      seen: [],
      achievements: {},
      unlocks: [],
      gates: [],
      tips: [],
      createdAt: 42,
      updatedAt: 42,
    })
  })

  it('rebuilds an empty record from null / primitives / wrong version', () => {
    for (const raw of [null, undefined, 0, 'x', [], { v: 2, xp: 5000 }]) {
      const rec = migrateProgress(raw)
      expect(rec.v).toBe(1)
      expect(rec.xp).toBe(0)
      expect(rec.level).toBe(1)
      expect(rec.counters).toEqual({ deal: 0, cast: 0, recast: 0, gate: 0, premiere: 0 })
    }
  })

  it('clamps xp / level / bestCombo into their legal ranges', () => {
    const rec = migrateProgress({
      v: 1,
      xp: 1e9,
      level: 999,
      bestCombo: 9999,
      counters: { deal: -3, cast: 2.9, recast: 'x', gate: 0, premiere: 1 },
    })
    expect(rec.xp).toBe(999_999)
    expect(rec.level).toBe(12)
    expect(rec.bestCombo).toBe(6)
    expect(rec.counters.deal).toBe(0)
    expect(rec.counters.cast).toBe(2)
    expect(rec.counters.recast).toBe(0)
  })

  it('keeps only the last 20 gate entries, normalising the rest', () => {
    const gates: unknown[] = Array.from({ length: 25 }, (_, i) => ({
      deckId: `d-${i}`,
      at: i,
      error: 0,
      warn: 1,
      info: 2,
    }))
    const rec = migrateProgress({ v: 1, gates })
    expect(rec.gates).toHaveLength(20)
    expect(rec.gates[0].deckId).toBe('d-5')
    expect(rec.gates[19].deckId).toBe('d-24')

    const dirty = migrateProgress({
      v: 1,
      gates: [null, 'x', { deckId: 7, at: -1, error: 'bad', warn: 2, info: 3 }, { deckId: 'ok' }],
    })
    expect(dirty.gates).toEqual([
      { deckId: '', at: 0, error: 0, warn: 2, info: 3 },
      { deckId: 'ok', at: 0, error: 0, warn: 0, info: 0 },
    ])
  })

  it('dedupes seen / unlocks / tips and caps their length', () => {
    const rec = migrateProgress({
      v: 1,
      seen: [...TWELVE_RECIPES, 'cover', 3, null],
      unlocks: Array.from({ length: 20 }, (_, i) => `skin-${i % 14}`),
      tips: Array.from({ length: 40 }, (_, i) => `tip-${i}`),
    })
    expect(rec.seen).toHaveLength(12)
    expect(rec.seen[0]).toBe('cover')
    expect(rec.unlocks).toHaveLength(12)
    expect(rec.tips).toHaveLength(24)
  })

  it('drops unknown fields and normalises achievement timestamps', () => {
    const raw = {
      v: 1,
      xp: 120,
      level: 2,
      bestCombo: 3,
      counters: { deal: 1, cast: 2, recast: 0, gate: 1, premiere: 1 },
      achievements: { first_cast: 111, nine_slides: 'bad', hand_edit: -5 },
      seen: ['cover'],
      unlocks: [],
      gates: [],
      tips: [],
      createdAt: 1,
      updatedAt: 2,
      hacked: 'drop me',
      __proto__: { polluted: true },
    }
    const rec = migrateProgress(raw)
    expect(rec).not.toHaveProperty('hacked')
    expect((rec as unknown as Record<string, unknown>).polluted).toBeUndefined()
    expect(rec.achievements.first_cast).toBe(111)
    expect(Number.isFinite(rec.achievements.nine_slides)).toBe(true)
    expect(rec.achievements.hand_edit).toBe(0)
    expect(rec.createdAt).toBe(1)
    expect(rec.updatedAt).toBe(2)
  })

  it('stays under the 6144-byte hard cap even when fully populated', () => {
    const gates: ForgeGateEntry[] = Array.from({ length: 20 }, (_, i) => ({
      deckId: `deck-${'x'.repeat(24)}-${i}`,
      at: Date.now(),
      error: i,
      warn: i,
      info: i,
    }))
    const achievements: Record<string, number> = {}
    for (const id of ACHIEVEMENT_IDS) achievements[id] = Date.now()
    const rec = migrateProgress({
      v: 1,
      xp: 999_999,
      level: 12,
      bestCombo: 6,
      counters: { deal: 9999, cast: 9999, recast: 9999, gate: 9999, premiere: 9999 },
      seen: TWELVE_RECIPES,
      achievements,
      unlocks: Array.from({ length: 12 }, (_, i) => `skin-${i}`),
      gates,
      tips: Array.from({ length: 24 }, (_, i) => `tip-${i}`),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    expect(Buffer.byteLength(JSON.stringify(rec), 'utf8')).toBeLessThanOrEqual(PROGRESS_MAX_BYTES)
  })
})

describe('addSeen · 见过的配方', () => {
  it('dedupes and caps at 12 recipes', () => {
    const rec = addSeen(emptyProgress(1), ['cover', 'statement', 'cover'])
    expect(rec.seen).toEqual(['cover', 'statement'])
    const many = addSeen(emptyProgress(1), TWELVE_RECIPES)
    expect(many.seen).toHaveLength(12)
    expect(addSeen(rec, ['split']).seen).toEqual(['cover', 'statement', 'split'])
  })
})

/* ------------------------------ 附件断言（借用） ----------------------------- */

describe('成就与 deck 的耦合面', () => {
  it('counts three-blocks from real slides (decision D4 的输入口径)', () => {
    const slide = slideSchema.parse({
      id: 's1',
      blocks: [{ type: 'three', id: 'b1', x: 0, y: 0, w: 100, h: 100, descriptor: {} }],
    })
    expect(slide.blocks.some((block) => block.type === 'three')).toBe(true)
  })
})
