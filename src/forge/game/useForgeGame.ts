/**
 * forge/game/useForgeGame.ts —— 游戏层与 React 的唯一接口（03 §4–§8）。
 *
 * 造幕台只 `emit`，计分 / 成就 / 落盘都在这里；未加载完成或存储降级时照常计分（铁律 1 零阻塞）。
 * 幂等键（`cast.complete#deckId`、`recast.ok#deckId#i`、`gate.pass#deckId`、`premiere.start#deckId`）
 * 放在**模块级** Set 里：造幕台重复挂载（关掉再开）不会把同一套再算一遍 XP（03 §4.3）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Deck, RecipeId } from '@/schema/deck'
import type { ForgeGameplay } from '@/state/settingsStore'
import {
  applyScore,
  achievementAllowed,
  addSeen,
  comboAfterTick,
  evaluateAchievements,
  levelOf,
  settle,
  unlockAchievement,
  unlocksForLevel,
  type AchievementContext,
  type AchievementId,
  type ScoreAction,
} from './score'
import {
  cachedProgress,
  commitProgress,
  emptyProgress,
  flushProgress,
  loadProgress,
  resetProgress,
  type ForgeProgress,
} from './progress'

export interface ForgeGameToast {
  kind: 'combo' | 'xp' | 'achievement' | 'level'
  combo?: number
  amount?: number
  achievement?: AchievementId
  level?: number
}

export interface ForgeGameApi {
  ready: boolean
  combo: number
  level: number
  xp: number
  bestCombo: number
  achievements: AchievementId[]
  seen: RecipeId[]
  unlocked: string[]
  noteDeal: () => void
  castComplete: (deck: Deck, warnings: string[]) => void
  recastOk: (index: number, before: string[], after: string[], recipes: RecipeId[]) => void
  gatePass: (summary: { error: number; warn: number; info: number }, deckId: string | null) => void
  premiere: () => void
  abort: () => void
  close: () => void
  reset: () => Promise<void>
}

/** 幂等键跨挂载保留（同一页面会话内重开造幕台不再计分）。 */
const scoredKeys = new Set<string>()

/** 单测用：清空会话内的幂等键。 */
export function resetGameSession(): void {
  scoredKeys.clear()
}

function maxCounters(a: ForgeProgress['counters'], b: ForgeProgress['counters']): ForgeProgress['counters'] {
  return {
    deal: Math.max(a.deal, b.deal),
    cast: Math.max(a.cast, b.cast),
    recast: Math.max(a.recast, b.recast),
    gate: Math.max(a.gate, b.gate),
    premiere: Math.max(a.premiere, b.premiere),
  }
}

/** 落盘记录晚到、本地已计过分时，取两者的较大值/并集（不丢已得 XP）。 */
function mergeProgress(local: ForgeProgress, loaded: ForgeProgress): ForgeProgress {
  const xp = Math.max(local.xp, loaded.xp)
  return {
    ...loaded,
    xp,
    level: levelOf(xp),
    bestCombo: Math.max(local.bestCombo, loaded.bestCombo),
    counters: maxCounters(local.counters, loaded.counters),
    seen: Array.from(new Set([...loaded.seen, ...local.seen])).slice(0, 12) as RecipeId[],
    achievements: { ...loaded.achievements, ...local.achievements },
    unlocks: Array.from(new Set([...loaded.unlocks, ...local.unlocks])).slice(0, 12),
  }
}

export function useForgeGame(opts: {
  gameplay: ForgeGameplay
  deckId: string | null
  onToast?: (toast: ForgeGameToast) => void
}): ForgeGameApi {
  const { gameplay, deckId, onToast } = opts
  const [ready, setReady] = useState(false)
  const [progress, setProgress] = useState<ForgeProgress>(() => cachedProgress())
  const progressRef = useRef<ForgeProgress>(cachedProgress())
  /**
   * 幂等键集合。模块级 `scoredKeys` 负责"关掉造幕台再打开"仍不重复计分；
   * 这个 ref 是当前挂载的读写入口（单测按字符串锁住这三个调用，别改名字）。
   */
  const scoredRef = useRef(new Set<string>())
  const comboRef = useRef({ count: 0, lastAt: 0 })
  const [combo, setCombo] = useState(0)
  const flags = useRef({
    dealAt: 0,
    premiereAt: 0,
    gateClean: false,
    recastBetter: false,
    keyboardOnly: false,
    handEdit: false,
    warnings: [] as string[],
    recipes: [] as RecipeId[],
    slideCount: 0,
    threeSlides: 0,
    deckId: null as string | null,
  })
  const toast = useRef(onToast)
  toast.current = onToast

  useEffect(() => {
    let alive = true
    // 挂载时把会话内已计过分的键灌进 ref（重开造幕台不重复计分）。
    for (const key of scoredKeys) scoredRef.current.add(key)
    void loadProgress().then((rec) => {
      if (!alive) return
      const local = progressRef.current
      const merged =
        local.xp > 0 || Object.keys(local.achievements).length > 0 ? mergeProgress(local, rec) : rec
      progressRef.current = merged
      setProgress({ ...merged })
      setReady(true)
      if (merged !== rec) commitProgress(merged)
    })
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flushProgress()
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onHidden)
      void flushProgress()
    }
  }, [])

  const commit = useCallback((rec: ForgeProgress) => {
    progressRef.current = rec
    setProgress({ ...rec })
    commitProgress(rec)
  }, [])

  const syncCombo = useCallback((next: number) => {
    comboRef.current.count = next
    setCombo(next)
  }, [])

  const tick = useCallback(
    (scoredKey: string, action: ScoreAction): boolean => {
      if (scoredRef.current.has(scoredKey)) return false
      scoredRef.current.add(scoredKey)
      scoredKeys.add(scoredKey)
      const now = Date.now()
      const settled = settle(now, comboRef.current)
      const nextCombo = comboAfterTick(settled.count)
      comboRef.current = { count: nextCombo, lastAt: now }
      syncCombo(nextCombo)
      const beforeLevel = levelOf(progressRef.current.xp)
      const result = applyScore(progressRef.current, action, nextCombo)
      // `unlocks` 是等级派生的视觉项；min 档保持空数组（03 §9 未决 2）。
      const rec: ForgeProgress =
        gameplay === 'full' ? { ...result.rec, unlocks: unlocksForLevel(result.rec.level) } : result.rec
      commit(rec)
      toast.current?.({ kind: 'combo', combo: nextCombo, amount: result.gained })
      toast.current?.({ kind: 'xp', amount: result.gained })
      if (rec.level > beforeLevel) toast.current?.({ kind: 'level', level: rec.level })
      return true
    },
    [commit, gameplay, syncCombo],
  )

  const unlock = useCallback(
    (ids: AchievementId[], rec: ForgeProgress): ForgeProgress => {
      let next = rec
      for (const id of ids) {
        if (!achievementAllowed(id, gameplay)) continue
        if (next.achievements[id]) continue
        // 成就只记录、不发 XP（03 §6 硬断言）。
        next = unlockAchievement(next, id, Date.now())
        toast.current?.({ kind: 'achievement', achievement: id })
      }
      return next
    },
    [gameplay],
  )

  const contextOf = useCallback((): AchievementContext => {
    const f = flags.current
    return {
      deckId: f.deckId,
      slideCount: f.slideCount,
      recipes: f.recipes,
      warnings: f.warnings,
      threeSlides: f.threeSlides,
      dealAt: f.dealAt,
      premiereAt: f.premiereAt,
      gateClean: f.gateClean,
      recastBetter: f.recastBetter,
      keyboardOnly: f.keyboardOnly,
      handEdit: f.handEdit,
      now: Date.now(),
      seenCount: progressRef.current.seen.length,
    }
  }, [])

  const evaluateNow = useCallback(() => {
    const ids = evaluateAchievements(contextOf())
    const next = unlock(ids, progressRef.current)
    if (next !== progressRef.current) commit(next)
  }, [commit, contextOf, unlock])

  const noteDeal = useCallback(() => {
    flags.current.dealAt = Date.now()
    const rec: ForgeProgress = {
      ...progressRef.current,
      counters: { ...progressRef.current.counters, deal: progressRef.current.counters.deal + 1 },
    }
    commit(rec)
  }, [commit])

  const castComplete = useCallback(
    (deck: Deck, warnings: string[]) => {
      const id = deck.id
      flags.current.deckId = id
      flags.current.warnings = warnings
      flags.current.recipes = deck.slides.map((slide) => slide.recipe ?? 'statement')
      flags.current.slideCount = deck.slides.length
      flags.current.threeSlides = deck.slides.filter((slide) =>
        slide.blocks.some((block) => block.type === 'three'),
      ).length
      // 只有 AI 成稿进入白名单（03 §4.1）；重复的一套按 deckId 幂等。
      if (deck.meta.origin !== 'ai') return
      if (!tick(`cast.complete#${id}`, 'cast.complete')) return
      const withSeen = addSeen(progressRef.current, flags.current.recipes)
      commit(withSeen)
      evaluateNow()
    },
    [commit, evaluateNow, tick],
  )

  const recastOk = useCallback(
    (index: number, before: string[], after: string[], recipes: RecipeId[]) => {
      const id = flags.current.deckId ?? deckId ?? 'forge'
      const flaggedBefore = before.filter((warn) => warn.startsWith(`#${index + 1} `)).length
      const flaggedAfter = after.filter((warn) => warn.startsWith(`#${index + 1} `)).length
      flags.current.recastBetter = flaggedAfter < flaggedBefore
      flags.current.recipes = recipes
      if (!tick(`recast.ok#${id}#${index}`, 'recast.ok')) return
      const withSeen = addSeen(progressRef.current, recipes)
      commit(withSeen)
      evaluateNow()
    },
    [commit, deckId, evaluateNow, tick],
  )

  const gatePass = useCallback(
    (summary: { error: number; warn: number; info: number }, id: string | null) => {
      const clean = summary.error === 0 && summary.warn === 0
      flags.current.gateClean = clean
      const rec: ForgeProgress = {
        ...progressRef.current,
        counters: { ...progressRef.current.counters, gate: progressRef.current.counters.gate + 1 },
        gates: [
          ...progressRef.current.gates,
          { deckId: id ?? 'forge', at: Date.now(), error: summary.error, warn: summary.warn, info: summary.info },
        ].slice(-20),
      }
      commit(rec)
      if (clean) tick(`gate.pass#${id ?? 'forge'}`, 'gate.pass')
      evaluateNow()
    },
    [commit, evaluateNow, tick],
  )

  const premiere = useCallback(() => {
    flags.current.premiereAt = Date.now()
    tick(`premiere.start#${flags.current.deckId ?? deckId ?? 'forge'}`, 'premiere.start')
    evaluateNow()
  }, [deckId, evaluateNow, tick])

  const abort = useCallback(() => {
    comboRef.current.count = 0
    setCombo(0)
    void flushProgress()
  }, [])

  const close = useCallback(() => {
    comboRef.current.count = 0
    setCombo(0)
    void flushProgress()
  }, [])

  const reset = useCallback(async () => {
    await resetProgress()
    scoredRef.current.clear()
    scoredKeys.clear()
    progressRef.current = emptyProgress()
    comboRef.current = { count: 0, lastAt: 0 }
    syncCombo(0)
    setProgress(emptyProgress())
  }, [syncCombo])

  return {
    ready,
    combo,
    level: progress.level,
    xp: progress.xp,
    bestCombo: progress.bestCombo,
    achievements: Object.keys(progress.achievements) as AchievementId[],
    seen: progress.seen,
    unlocked: progress.unlocks,
    noteDeal,
    castComplete,
    recastOk,
    gatePass,
    premiere,
    abort,
    close,
    reset,
  }
}
