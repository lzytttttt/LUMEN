/**
 * forge/state.ts —— 造幕台状态机（纯函数，单测直接喂动作序列）。
 *
 * 合法转移见 02 §4.2；单幕推进由 `ForgeStageEvent` 驱动（02 §4.3）。
 * 这里不碰网络、不碰 IndexedDB；编排在 run.ts，落库在 ForgeApp 的退出语义里。
 */
import type { Outline, OutlineSlide, RecipeId } from '@/schema/deck'
import type { ForgeStage } from '@/ai/types'
import type {
  ForgeAction,
  ForgePhase,
  ForgeSlideState,
  ForgeState,
  SlideStatus,
} from './types'

/** 03 §2.2 的卡序（换一张按这个顺序循环）。 */
export const RECIPE_ORDER: RecipeId[] = [
  'cover',
  'statement',
  'split',
  'grid3',
  'grid4',
  'timeline',
  'compare',
  'quote',
  'data',
  'process',
  'gallery',
  'closing',
]

export const STAGE_PROG: Record<ForgeStage, number> = {
  think: 0,
  plan: 1,
  write: 2,
  draw: 3,
  set: 4,
  check: 5,
  seal: 6,
}

const LANDED: SlideStatus[] = ['landed', 'flagged', 'stuck']

export function isLanded(status: SlideStatus): boolean {
  return LANDED.includes(status)
}

export function toSlideStates(outline: Outline): ForgeSlideState[] {
  return outline.slides.map((slide, index) => ({
    index,
    recipe: slide.recipe,
    headline: slide.headline,
    status: 'queued' as SlideStatus,
    errors: [],
    warns: [],
    tokens: 0,
  }))
}

export function outlineOf(state: ForgeState): Outline | null {
  return state.outline
}

/** 退出时落库的幕（只含已完成，按幕序）。 */
export function doneSlides(state: ForgeState) {
  return state.slides
    .filter((slide) => isLanded(slide.status) && slide.slide)
    .sort((a, b) => a.index - b.index)
    .map((slide) => slide.slide!)
}

/** 真实产出统计：落位数 / 有瑕疵数 / 卡住数。 */
export function tally(state: ForgeState) {
  let landed = 0
  let flagged = 0
  let stuck = 0
  for (const slide of state.slides) {
    if (slide.status === 'landed') landed += 1
    else if (slide.status === 'flagged') {
      landed += 1
      flagged += 1
    } else if (slide.status === 'stuck') {
      landed += 1
      stuck += 1
    }
  }
  return { landed, flagged, stuck }
}

/** 对外 DOM 标记（02 §4.4）：casting 拆 cast / assemble / gate 三段。 */
export function forgeMark(state: ForgeState): 'seed' | 'deal' | 'cast' | 'assemble' | 'gate' | 'premiere' {
  if (state.phase === 'seed') return 'seed'
  if (state.phase === 'deal') return 'deal'
  if (state.phase === 'premiere') return 'premiere'
  // 过检有问题时优先显示门；否则按「是否已有落位」区分铸造与装台。
  if (state.slides.some((slide) => slide.status === 'stuck')) return 'gate'
  const active = state.active !== null ? state.slides.find((slide) => slide.index === state.active) : undefined
  if (active && (active.warns.length > 0 || active.status === 'flagged')) return 'gate'
  if (state.done > 0) return 'assemble'
  return 'cast'
}

export function initialForgeState(overrides: Partial<ForgeState> = {}): ForgeState {
  return {
    phase: 'seed',
    prompt: '',
    lang: 'zh',
    length: 'normal',
    durationMin: 10,
    includeSvg: true,
    include3d: true,
    outline: null,
    cropped3d: [],
    slides: [],
    total: 0,
    done: 0,
    stage: 'think',
    prog: 0,
    error: null,
    busy: false,
    stopped: false,
    saved: false,
    deck: null,
    active: null,
    dealAt: 0,
    premiereAt: 0,
    live: null,
    autoPremiere: true,
    ...overrides,
  }
}

function withSlide(state: ForgeState, index: number, patch: Partial<ForgeSlideState>): ForgeState {
  if (index < 0 || index >= state.slides.length) return state
  const slides = state.slides.slice()
  slides[index] = { ...slides[index], ...patch }
  return { ...state, slides }
}

function nextRecipe(current: RecipeId): RecipeId {
  const at = RECIPE_ORDER.indexOf(current)
  return RECIPE_ORDER[(at + 1) % RECIPE_ORDER.length] ?? 'statement'
}

function cycleRecipe(current: RecipeId, direction: -1 | 1): RecipeId {
  const at = RECIPE_ORDER.indexOf(current)
  const size = RECIPE_ORDER.length
  return RECIPE_ORDER[(at + direction + size) % size] ?? 'statement'
}

/** 首末锁：第 1 幕恒 cover、末幕恒 closing（契约要求）；只允许内部卡换卡/重排。 */
function syncOutline(state: ForgeState): Outline | null {
  if (!state.outline) return null
  const slides: OutlineSlide[] = state.slides.map((slide) => ({
    ...state.outline!.slides[slide.index],
    recipe: slide.recipe,
    headline: slide.headline,
  }))
  return { ...state.outline, slides }
}

export function forgeReducer(state: ForgeState, action: ForgeAction): ForgeState {
  switch (action.type) {
    case 'prompt':
      return { ...state, prompt: action.value }
    case 'option':
      return { ...state, ...action.patch }
    case 'submit':
      return { ...state, busy: true, error: null, phase: 'seed', prog: 0.4, stage: 'think' }
    case 'outline': {
      const slides = toSlideStates(action.outline)
      return {
        ...state,
        phase: 'deal',
        outline: action.outline,
        cropped3d: action.cropped3d ?? [],
        slides,
        total: slides.length,
        done: 0,
        busy: false,
        error: null,
        prog: 1.6,
        stage: 'plan',
        dealAt: Date.now(),
        live: { key: 'forge.live.stage', vars: { stage: 'deal' } },
      }
    }
    case 'fail':
      return { ...state, busy: false, error: { code: action.code, key: action.key, at: Date.now() }, phase: 'seed' }
    case 'swap': {
      const slide = state.slides[action.index]
      if (!slide) return state
      // 首末锁：只允许切到同类项（首→cover、末→closing），其余位置按环序循环（02 §5.2、03 §3.2）。
      let target: RecipeId
      if (action.index === 0) {
        if (slide.recipe === 'cover') return state
        target = 'cover'
      } else if (action.index === state.slides.length - 1) {
        if (slide.recipe === 'closing') return state
        target = 'closing'
      } else {
        target = nextRecipe(slide.recipe)
      }
      const next = withSlide(state, action.index, { recipe: target })
      return { ...next, outline: syncOutline(next) }
    }
    case 'move': {
      const { from } = action
      const to = action.to
      if (from <= 0 || to <= 0) return state
      if (from >= state.slides.length - 1 || to >= state.slides.length - 1) return state
      if (from === to) return state
      const slides = state.slides.slice()
      const [item] = slides.splice(from, 1)
      slides.splice(to, 0, item)
      const reindexed = slides.map((slide, index) => ({ ...slide, index }))
      const next = { ...state, slides: reindexed }
      return { ...next, outline: syncOutline(next) }
    }
    case 'remove': {
      if (state.slides.length <= 3) return state
      if (action.index === 0 || action.index === state.slides.length - 1) return state
      const slides = state.slides
        .filter((_, index) => index !== action.index)
        .map((slide, index) => ({ ...slide, index }))
      const next = { ...state, slides, total: slides.length }
      return { ...next, outline: syncOutline(next) }
    }
    case 'add': {
      const insertAt = Math.max(1, state.slides.length - 1)
      const slides = state.slides.slice()
      const seed = state.outline?.slides[insertAt - 1]
      slides.splice(insertAt, 0, {
        index: insertAt,
        recipe: 'statement',
        headline: seed?.headline ?? (state.lang === 'zh' ? '再补一幕' : 'One more slide'),
        status: 'queued',
        errors: [],
        warns: [],
        tokens: 0,
      })
      const reindexed = slides.map((slide, index) => ({ ...slide, index }))
      const next = { ...state, slides: reindexed, total: reindexed.length }
      return { ...next, outline: syncOutline(next) }
    }
    case 'cast':
      return {
        ...state,
        phase: 'casting',
        busy: true,
        stopped: false,
        error: null,
        done: 0,
        prog: 2,
        stage: 'write',
        saved: false,
        deck: null,
        slides: state.slides.map((slide) => ({
          ...slide,
          status: 'queued',
          slide: undefined,
          errors: [],
          warns: [],
          tokens: 0,
        })),
      }
    case 'stageEvent': {
      const event = action.event
      if (event.type === 'stage') {
        const prog = Math.max(state.prog, STAGE_PROG[event.stage])
        return { ...state, stage: event.stage, prog, busy: event.stage !== 'seal' ? state.busy : state.busy }
      }
      if (event.type === 'slide:start') {
        return withSlide(state, event.index, { status: 'drafting', errors: [], warns: [] })
      }
      if (event.type === 'slide:content') {
        return withSlide(state, event.index, { status: 'art', tokens: event.tokens })
      }
      if (event.type === 'slide:visual') {
        return withSlide(state, event.index, { status: 'typesetting' })
      }
      if (event.type === 'slide:layout') {
        return withSlide(state, event.index, { status: 'gating' })
      }
      if (event.type === 'slide:gate') {
        return withSlide(state, event.index, { errors: event.errors, warns: event.warns })
      }
      if (event.type === 'slide:landed') {
        const current = state.slides[event.index]
        const status: SlideStatus = current && current.errors.length > 0 ? 'stuck' : current && current.warns.length > 0 ? 'flagged' : 'landed'
        const slides = state.slides.slice()
        if (slides[event.index]) {
          slides[event.index] = { ...slides[event.index], status, slide: event.slide }
        }
        const done = slides.filter((slide) => isLanded(slide.status)).length
        const total = state.total || slides.length
        const prog = Math.max(state.prog, 2 + (3 * done) / Math.max(total, 1))
        return { ...state, slides, done, prog, active: event.index, stage: 'check' }
      }
      if (event.type === 'slide:recast') {
        const slides = state.slides.slice()
        const current = slides[event.index]
        if (current) {
          slides[event.index] = {
            ...current,
            slide: event.slide,
            errors: current.errors,
            warns: [],
            status: 'landed',
          }
        }
        return { ...state, slides }
      }
      if (event.type === 'deck:aborted') {
        return {
          ...state,
          busy: false,
          stopped: true,
          phase: 'deal',
          slides: state.slides.map((slide) =>
            isLanded(slide.status) ? slide : { ...slide, status: 'dropped' as SlideStatus },
          ),
        }
      }
      return state
    }
    case 'deck': {
      const total = state.total || action.deck.slides.length
      const stuck = state.slides.some((slide) => slide.status === 'stuck')
      // 过检 error：留在门里等「重试」，不把带病的一套直接推进开演席（02 §5.4）。
      if (stuck) {
        return {
          ...state,
          deck: action.deck,
          busy: false,
          done: total,
          total,
          stage: 'check',
          saved: false,
        }
      }
      return {
        ...state,
        deck: action.deck,
        busy: false,
        phase: 'premiere',
        done: total,
        total,
        prog: 6.4,
        stage: 'seal',
        premiereAt: Date.now(),
        saved: false,
      }
    }
    case 'stop':
      return {
        ...state,
        stopped: true,
        busy: false,
        phase: 'deal',
        slides: state.slides.map((slide) =>
          isLanded(slide.status) ? slide : { ...slide, status: 'dropped' as SlideStatus },
        ),
      }
    case 'recast':
      return withSlide(state, action.index, { status: 'drafting', errors: [] })
    case 'recastDone': {
      if (!state.slides[action.index]) return state
      const stillLine = action.warnings.find((warn) => warn.includes(`#${action.index + 1} lint still`))
      const stillCodes = stillLine ? stillLine.replace(/^.*lint still /, '').split('+').filter(Boolean) : []
      const warns = [
        ...action.warnings.filter((warn) => warn.includes('warn ')).map((warn) => warn.replace(/^.*warn /, '')),
        ...stillCodes,
      ]
      const next = withSlide(state, action.index, {
        // 重试仍不过检：允许带病落位（02 §5.4），但必须留下痕迹，不能伪装成干净落位。
        status: stillCodes.length > 0 || warns.length > 0 ? 'flagged' : 'landed',
        slide: action.slide,
        errors: [],
        warns: Array.from(new Set(warns)),
      })
      const stuck = next.slides.some((slide) => slide.status === 'stuck')
      if (next.deck && !stuck) {
        // 重试成功（或带病落位）→ 门重新变金，进开演席。
        return { ...next, phase: 'premiere', stage: 'seal', prog: 6.4, premiereAt: Date.now(), saved: false }
      }
      return { ...next, stage: 'set' }
    }
    case 'clearError':
      return { ...state, error: null }
    case 'saved':
      return { ...state, saved: true }
    case 'live':
      return { ...state, live: action.live }
    case 'reset':
      return initialForgeState({
        lang: state.lang,
        length: state.length,
        durationMin: state.durationMin,
        includeSvg: state.includeSvg,
        include3d: state.include3d,
        autoPremiere: state.autoPremiere,
      })
    default:
      return state
  }
}

export { cycleRecipe }
