/**
 * forge-state.test.ts —— 造幕台状态机（`src/forge/state.ts`）的纯函数验收。
 *
 * 依据：`plan/v0.2.0/02` §4.2/§4.3/§4.4、`07` §3.2 的 F-05/F-08/F-14/F-15 与 §3.7 R-07。
 * 只喂动作序列与 `ForgeStageEvent`，不碰网络、不碰 IndexedDB。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ForgeStageEvent } from '@/ai/types'
import type { ForgeSlideState, ForgeState } from '@/forge/types'
import {
  RECIPE_ORDER,
  STAGE_PROG,
  cycleRecipe,
  doneSlides,
  forgeMark,
  forgeReducer,
  initialForgeState,
  isLanded,
  tally,
  toSlideStates,
} from '@/forge/state'
import { outlineSchema, slideSchema, type Outline, type RecipeId, type Slide } from '@/schema/deck'

/* ------------------------------- fixtures ------------------------------- */

const NINE: RecipeId[] = [
  'cover',
  'statement',
  'split',
  'grid3',
  'grid4',
  'timeline',
  'compare',
  'quote',
  'closing',
]

function outlineOf(count = 9): Outline {
  const recipes =
    count === NINE.length
      ? NINE.slice()
      : Array.from({ length: count }, (_, i) => STAGE_RECIPES[i % STAGE_RECIPES.length])
  // 契约：首幕恒 cover、末幕恒 closing（02 §5.2 的首末锁）。
  recipes[0] = 'cover'
  recipes[recipes.length - 1] = 'closing'
  return outlineSchema.parse({
    title: '演示该换一种载体了',
    lang: 'zh',
    slides: recipes.map((recipe, index) => ({
      recipe,
      headline: `第 ${index + 1} 幕`,
      points: ['一', '二'],
      visual: { kind: 'none' },
    })),
  })
}

const STAGE_RECIPES: RecipeId[] = ['cover', 'statement', 'split', 'grid3', 'grid4', 'timeline', 'compare', 'quote', 'closing', 'data', 'gallery', 'process']

function dealt(count = 9): ForgeState {
  return forgeReducer(initialForgeState(), { type: 'outline', outline: outlineOf(count) })
}

function casting(count = 9): ForgeState {
  return forgeReducer(dealt(count), { type: 'cast' })
}

function slideOf(id: string): Slide {
  return slideSchema.parse({ id })
}

function event(state: ForgeState, payload: ForgeStageEvent): ForgeState {
  return forgeReducer(state, { type: 'stageEvent', event: payload })
}

const statuses = (state: ForgeState) => state.slides.map((slide) => slide.status)

/* --------------------------------- seed --------------------------------- */

describe('forgeReducer · 输入（seed）', () => {
  it('starts in seed with zero slides and no deck', () => {
    const state = initialForgeState()
    expect(state.phase).toBe('seed')
    expect(state.slides).toEqual([])
    expect(state.total).toBe(0)
    expect(state.prog).toBe(0)
    expect(state.stage).toBe('think')
    expect(state.deck).toBeNull()
    expect(forgeMark(state)).toBe('seed')
  })

  it('keeps the phase but marks busy on submit', () => {
    const state = forgeReducer(initialForgeState({ prompt: '一句话' }), { type: 'submit' })
    expect(state.phase).toBe('seed')
    expect(state.busy).toBe(true)
    expect(state.error).toBeNull()
    expect(state.prog).toBe(0.4)
    expect(state.stage).toBe('think')
    expect(forgeMark(state)).toBe('seed')
  })

  it('records prompt / options without touching the phase', () => {
    let state = forgeReducer(initialForgeState(), { type: 'prompt', value: '三分钟讲清改版' })
    state = forgeReducer(state, { type: 'option', patch: { length: 'deep', durationMin: 20 } })
    expect(state.prompt).toBe('三分钟讲清改版')
    expect(state.length).toBe('deep')
    expect(state.durationMin).toBe(20)
    expect(state.phase).toBe('seed')
  })

  it('drops back to seed and keeps the error code on fail', () => {
    const state = forgeReducer(dealt(9), { type: 'fail', code: 'network', key: 'forge.error.network' })
    expect(state.phase).toBe('seed')
    expect(state.busy).toBe(false)
    expect(state.error?.code).toBe('network')
    expect(state.error?.key).toBe('forge.error.network')
    expect(state.error?.at).toBeGreaterThan(0)
    expect(forgeReducer(state, { type: 'clearError' }).error).toBeNull()
  })
})

/* --------------------------------- deal --------------------------------- */

describe('forgeReducer · 大纲（deal）', () => {
  it('moves seed → deal with one state per outline slide', () => {
    const state = dealt(9)
    expect(state.phase).toBe('deal')
    expect(state.total).toBe(9)
    expect(state.done).toBe(0)
    expect(state.slides).toHaveLength(9)
    expect(statuses(state)).toEqual(Array(9).fill('queued'))
    expect(state.stage).toBe('plan')
    expect(state.prog).toBe(1.6)
    expect(state.busy).toBe(false)
    expect(state.dealAt).toBeGreaterThan(0)
    expect(state.live?.key).toBe('forge.live.stage')
    expect(forgeMark(state)).toBe('deal')
  })

  it('freezes the first and the last card on swap', () => {
    const state = dealt(9)
    expect(forgeReducer(state, { type: 'swap', index: 0 })).toBe(state)
    expect(forgeReducer(state, { type: 'swap', index: 8 })).toBe(state)
    expect(forgeReducer(state, { type: 'swap', index: 99 })).toBe(state)
  })

  it('cycles an inner card to the next recipe and syncs the outline', () => {
    const state = dealt(9)
    const before = state.slides[1].recipe
    const next = forgeReducer(state, { type: 'swap', index: 1 })
    expect(next.slides[1].recipe).toBe('split')
    expect(next.slides[1].recipe).not.toBe(before)
    expect(next.outline?.slides[1].recipe).toBe('split')
    // 其余卡不受影响。
    expect(next.slides[0].recipe).toBe(state.slides[0].recipe)
    expect(next.slides[8].recipe).toBe(state.slides[8].recipe)
  })

  it('returns to the starting recipe after a full ring', () => {
    let state = dealt(9)
    const before = state.slides[2].recipe
    for (let i = 0; i < RECIPE_ORDER.length; i += 1) state = forgeReducer(state, { type: 'swap', index: 2 })
    expect(state.slides[2].recipe).toBe(before)
    expect(cycleRecipe(before, 1)).toBe(RECIPE_ORDER[(RECIPE_ORDER.indexOf(before) + 1) % RECIPE_ORDER.length])
    expect(cycleRecipe('cover', -1)).toBe('closing')
  })

  it('refuses to delete below three slides', () => {
    const three = dealt(3)
    expect(forgeReducer(three, { type: 'remove', index: 1 })).toBe(three)
  })

  it('refuses to delete the first or the last card, but deletes an inner one', () => {
    const state = dealt(9)
    expect(forgeReducer(state, { type: 'remove', index: 0 })).toBe(state)
    expect(forgeReducer(state, { type: 'remove', index: 8 })).toBe(state)
    const next = forgeReducer(state, { type: 'remove', index: 3 })
    expect(next.slides).toHaveLength(8)
    expect(next.total).toBe(8)
    expect(next.slides.map((slide) => slide.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(next.slides[0].recipe).toBe('cover')
    expect(next.slides[7].recipe).toBe('closing')
    expect(next.outline?.slides).toHaveLength(8)
  })

  it('adds a slide right before the closing card', () => {
    const state = dealt(9)
    const next = forgeReducer(state, { type: 'add' })
    expect(next.slides).toHaveLength(10)
    expect(next.total).toBe(10)
    expect(next.slides[8].recipe).toBe('statement')
    expect(next.slides[9].recipe).toBe('closing')
    expect(next.slides.map((slide) => slide.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(next.outline?.slides).toHaveLength(10)
  })

  it('adds before the closing card even on a two-slide outline', () => {
    const next = forgeReducer(dealt(2), { type: 'add' })
    expect(next.slides).toHaveLength(3)
    expect(next.slides[1].recipe).toBe('statement')
    expect(next.slides[2].recipe).toBe('closing')
  })

  it('reorders inner cards and reindexes them, locked ends stay put', () => {
    const state = dealt(9)
    expect(forgeReducer(state, { type: 'move', from: 0, to: 2 })).toBe(state)
    expect(forgeReducer(state, { type: 'move', from: 2, to: 0 })).toBe(state)
    expect(forgeReducer(state, { type: 'move', from: 2, to: 8 })).toBe(state)
    expect(forgeReducer(state, { type: 'move', from: 2, to: 2 })).toBe(state)

    const next = forgeReducer(state, { type: 'move', from: 1, to: 3 })
    expect(next.slides.map((slide) => slide.recipe)).toEqual([
      'cover',
      'split',
      'grid3',
      'statement',
      'grid4',
      'timeline',
      'compare',
      'quote',
      'closing',
    ])
    expect(next.slides.map((slide) => slide.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(next.outline?.slides[3].recipe).toBe('statement')
  })
})

/* -------------------------------- casting -------------------------------- */

describe('forgeReducer · 生成（casting）', () => {
  it('moves deal → casting and resets every slide', () => {
    const state = forgeReducer(dealt(9), { type: 'cast' })
    expect(state.phase).toBe('casting')
    expect(state.busy).toBe(true)
    expect(state.stopped).toBe(false)
    expect(state.done).toBe(0)
    expect(state.prog).toBe(2)
    expect(state.stage).toBe('write')
    expect(state.deck).toBeNull()
    expect(statuses(state)).toEqual(Array(9).fill('queued'))
    expect(state.slides.every((slide) => slide.slide === undefined)).toBe(true)
  })

  it('maps slide events to statuses in pipeline order', () => {
    let state = casting()
    state = event(state, { type: 'slide:start', index: 2 })
    expect(state.slides[2].status).toBe('drafting')

    state = event(state, { type: 'slide:content', index: 2, tokens: 128 })
    expect(state.slides[2].status).toBe('art')
    expect(state.slides[2].tokens).toBe(128)

    state = event(state, { type: 'slide:visual', index: 2, kind: 'svg' })
    expect(state.slides[2].status).toBe('typesetting')

    state = event(state, { type: 'slide:layout', index: 2, blocks: 5 })
    expect(state.slides[2].status).toBe('gating')

    state = event(state, { type: 'slide:gate', index: 2, errors: [], warns: [] })
    expect(state.slides[2].status).toBe('gating')
    expect(state.slides[2].warns).toEqual([])

    state = event(state, { type: 'stage', stage: 'check', index: 2, at: 1 })
    expect(state.stage).toBe('check')
    // 对外标记看的是真实产出（done / stuck / warns），不是内部 stage。
    expect(forgeMark(state)).toBe('cast')

    state = event(state, { type: 'slide:landed', index: 2, slide: slideOf('slide-2') })
    expect(state.slides[2].status).toBe('landed')
    expect(state.slides[2].slide?.id).toBe('slide-2')
    expect(state.done).toBe(1)
    expect(state.active).toBe(2)
    expect(state.stage).toBe('check')
    expect(forgeMark(state)).toBe('assemble')
    expect(state.prog).toBeGreaterThan(2)
  })

  it('keeps progress monotonic across stage pulses', () => {
    let state = casting()
    state = event(state, { type: 'stage', stage: 'draw', at: 1 })
    expect(state.stage).toBe('draw')
    expect(state.prog).toBe(STAGE_PROG.draw)
    state = event(state, { type: 'stage', stage: 'plan', at: 2 })
    expect(state.stage).toBe('plan')
    // prog 只增不减：plan(1) < draw(3) 时保留 3。
    expect(state.prog).toBe(STAGE_PROG.draw)
    expect(forgeMark(state)).toBe('cast')
  })

  it('marks an erroring slide as stuck and a warning slide as flagged', () => {
    let state = casting()
    state = event(state, { type: 'slide:start', index: 1 })
    state = event(state, { type: 'slide:gate', index: 1, errors: ['outOfBounds'], warns: [] })
    state = event(state, { type: 'slide:landed', index: 1, slide: slideOf('bad') })
    expect(state.slides[1].status).toBe('stuck')

    state = event(state, { type: 'slide:start', index: 3 })
    state = event(state, { type: 'slide:gate', index: 3, errors: [], warns: ['contrast'] })
    state = event(state, { type: 'slide:landed', index: 3, slide: slideOf('warn') })
    expect(state.slides[3].status).toBe('flagged')

    // error 优先于 warn。
    state = event(state, { type: 'slide:start', index: 4 })
    state = event(state, { type: 'slide:gate', index: 4, errors: ['emptyBlock'], warns: ['contrast'] })
    state = event(state, { type: 'slide:landed', index: 4, slide: slideOf('both') })
    expect(state.slides[4].status).toBe('stuck')
    expect(state.done).toBe(3)
  })

  it('recasts one slide without touching the others', () => {
    let state = casting(3)
    state = event(state, { type: 'slide:gate', index: 1, errors: ['emptyBlock'], warns: [] })
    state = event(state, { type: 'slide:landed', index: 1, slide: slideOf('slide-1') })
    const before = state.slides.map((slide) => slide.slide?.id ?? null)

    state = forgeReducer(state, { type: 'recast', index: 1 })
    expect(state.slides[1].status).toBe('drafting')
    expect(state.slides[1].errors).toEqual([])

    state = forgeReducer(state, {
      type: 'recastDone',
      index: 1,
      slide: slideOf('slide-1-fixed'),
      warnings: ['#2 warn contrast', '#2 recast done'],
    })
    expect(state.slides[1].status).toBe('flagged')
    expect(state.slides[1].warns).toEqual(['contrast'])
    expect(state.slides[1].slide?.id).toBe('slide-1-fixed')
    expect(state.stage).toBe('set')
    expect(state.slides[0].slide?.id ?? null).toBe(before[0])
    expect(state.slides[2].slide?.id ?? null).toBe(before[2])
  })

  it('marks a recast that still fails the gate as flagged, never as a clean landing', () => {
    const state = forgeReducer(casting(3), {
      type: 'recastDone',
      index: 1,
      slide: slideOf('again'),
      warnings: ['#2 lint still outOfBounds'],
    })
    // 重铸仍不过检 → 允许带病落位，但必须留下痕迹（02 §5.4、03 §8.8）。
    expect(state.slides[1].status).toBe('flagged')
    expect(state.slides[1].warns).toEqual(['outOfBounds'])
  })

  it('drops unfinished slides on abort but keeps the landed ones', () => {
    let state = casting(3)
    state = event(state, { type: 'slide:gate', index: 0, errors: [], warns: [] })
    state = event(state, { type: 'slide:landed', index: 0, slide: slideOf('a') })
    state = event(state, { type: 'slide:start', index: 1 })
    state = event(state, { type: 'deck:aborted' })

    expect(state.phase).toBe('deal')
    expect(state.stopped).toBe(true)
    expect(state.busy).toBe(false)
    expect(statuses(state)).toEqual(['landed', 'dropped', 'dropped'])
    expect(doneSlides(state)).toHaveLength(1)
    expect(forgeMark(state)).toBe('deal')
  })

  it('drops unfinished slides on an explicit stop too', () => {
    let state = casting(3)
    state = event(state, { type: 'slide:gate', index: 2, errors: [], warns: [] })
    state = event(state, { type: 'slide:landed', index: 2, slide: slideOf('last') })
    state = forgeReducer(state, { type: 'stop' })
    expect(statuses(state)).toEqual(['dropped', 'dropped', 'landed'])
    expect(state.stopped).toBe(true)
    expect(doneSlides(state).map((slide) => slide.id)).toEqual(['last'])
  })

  it('finishes in premiere with a deck and a sealed stage', () => {
    const deck = {
      schemaVersion: 1 as const,
      id: 'deck-1',
      title: '演示该换一种载体了',
      lang: 'zh' as const,
      aspect: '16:9' as const,
      themeId: 'noir',
      slides: [slideOf('a'), slideOf('b')],
      meta: { createdAt: 1, updatedAt: 1, origin: 'ai' as const },
    }
    const state = forgeReducer(casting(2), { type: 'deck', deck })
    expect(state.phase).toBe('premiere')
    expect(state.busy).toBe(false)
    expect(state.deck?.id).toBe('deck-1')
    expect(state.done).toBe(2)
    expect(state.prog).toBe(6.4)
    expect(state.stage).toBe('seal')
    expect(state.premiereAt).toBeGreaterThan(0)
    expect(forgeMark(state)).toBe('premiere')
  })
})

/* --------------------------------- 派生量 -------------------------------- */

describe('forgeMark / doneSlides / tally', () => {
  it('maps every phase and casting sub-state to the public mark', () => {
    const base = initialForgeState({ phase: 'casting' })
    const slideState = (index: number, patch: Partial<ForgeSlideState> = {}): ForgeSlideState => ({
      index,
      recipe: 'statement',
      headline: `第 ${index + 1} 幕`,
      status: 'landed',
      errors: [],
      warns: [],
      tokens: 0,
      ...patch,
    })

    // 铸造拆三段看真实产出：无落位 = cast；有落位 = assemble；有 stuck / 活动幕有 warn = gate。
    expect(forgeMark(base)).toBe('cast')
    expect(forgeMark({ ...base, done: 1 })).toBe('assemble')
    expect(forgeMark({ ...base, done: 2, slides: [slideState(0, { status: 'stuck', errors: ['emptyBlock'] })] })).toBe(
      'gate',
    )
    expect(forgeMark({ ...base, active: 0, slides: [slideState(0, { warns: ['contrast'] })] })).toBe('gate')
    expect(forgeMark({ ...base, phase: 'seed' })).toBe('seed')
    expect(forgeMark({ ...base, phase: 'deal' })).toBe('deal')
    expect(forgeMark({ ...base, phase: 'premiere' })).toBe('premiere')
  })

  it('exports only landed slides, ordered by slide index', () => {
    let state = casting(3)
    state = event(state, { type: 'slide:gate', index: 2, errors: [], warns: [] })
    state = event(state, { type: 'slide:landed', index: 2, slide: slideOf('c') })
    state = event(state, { type: 'slide:gate', index: 0, errors: [], warns: [] })
    state = event(state, { type: 'slide:landed', index: 0, slide: slideOf('a') })
    expect(doneSlides(state).map((slide) => slide.id)).toEqual(['a', 'c'])
    expect(doneSlides(casting(3))).toEqual([])
  })

  it('counts landed / flagged / stuck separately', () => {
    let state = casting(4)
    state = event(state, { type: 'slide:gate', index: 0, errors: [], warns: [] })
    state = event(state, { type: 'slide:landed', index: 0, slide: slideOf('a') })
    state = event(state, { type: 'slide:gate', index: 1, errors: [], warns: ['contrast'] })
    state = event(state, { type: 'slide:landed', index: 1, slide: slideOf('b') })
    state = event(state, { type: 'slide:gate', index: 2, errors: ['emptyBlock'], warns: [] })
    state = event(state, { type: 'slide:landed', index: 2, slide: slideOf('c') })
    expect(tally(state)).toEqual({ landed: 3, flagged: 1, stuck: 1 })
  })

  it('classifies slide statuses and builds outline states', () => {
    expect(isLanded('landed')).toBe(true)
    expect(isLanded('flagged')).toBe(true)
    expect(isLanded('stuck')).toBe(true)
    expect(isLanded('queued')).toBe(false)
    expect(isLanded('drafting')).toBe(false)
    expect(isLanded('dropped')).toBe(false)
    const slides = toSlideStates(outlineOf(3))
    expect(slides.map((slide) => slide.status)).toEqual(['queued', 'queued', 'queued'])
    expect(slides[1].headline).toBe('第 2 幕')
    expect(slides[1].recipe).toBe(outlineOf(3).slides[1].recipe)
    expect(slides.every((slide) => slide.tokens === 0 && slide.errors.length === 0)).toBe(true)
  })

  it('ignores events that point outside the card array', () => {
    const state = casting(3)
    expect(event(state, { type: 'slide:start', index: 9 })).toBe(state)
    expect(event(state, { type: 'slide:content', index: -1, tokens: 3 })).toBe(state)
    const outOfRange = forgeReducer(state, { type: 'recastDone', index: 9, slide: slideOf('x'), warnings: [] })
    expect(outOfRange.slides).toEqual(state.slides)
  })

  it('resets to seed while keeping the user options', () => {
    const before = forgeReducer(dealt(9), { type: 'option', patch: { lang: 'en', length: 'short', include3d: false } })
    const after = forgeReducer(before, { type: 'reset' })
    expect(after.phase).toBe('seed')
    expect(after.outline).toBeNull()
    expect(after.slides).toEqual([])
    expect(after.lang).toBe('en')
    expect(after.length).toBe('short')
    expect(after.include3d).toBe(false)
  })

  it('does not freeze the reducer on an unknown action', () => {
    const state = dealt(9)
    const unknown = { type: 'nope' } as unknown as Parameters<typeof forgeReducer>[1]
    expect(forgeReducer(state, unknown)).toBe(state)
  })

  it('stamps deal / premiere clocks with real time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T04:00:00Z'))
    try {
      const state = dealt(2)
      expect(state.dealAt).toBe(Date.now())
    } finally {
      vi.useRealTimers()
    }
  })
})
