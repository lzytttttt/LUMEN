/**
 * forge/state.ts —— 造幕台状态机（纯函数，单测直接喂动作序列）。
 *
 * 合法转移见 02 §4.2；单幕推进由 `ForgeStageEvent` 驱动（02 §4.3）。
 * 这里不碰网络、不碰 IndexedDB；编排在 run.ts，落库在 ForgeApp 的退出语义里。
 */
import type { Outline, OutlineSlide, RecipeId } from '@/schema/deck'
import type { ForgeStage } from '@/ai/types'
import { MATERIAL_MAX, MATERIAL_TEXT_MAX } from './materials'
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

/** 大纲标题与 schema 同尺（`outlineSlideSchema.headline.max(120)`）。 */
const HEADLINE_MAX = 120
/** 「这一幕想讲什么」的硬上限（契约 §2 硬约束 3、§3.4 的 brief 通道）。 */
const BRIEF_MAX = 200

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
    materials: [],
    audience: '',
    themeId: '',
    steer: [],
    reuse: [],
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

/** 一张新卡的完整大纲项：`add` 插卡时必须同时插这一条（只有 headline/recipe 的残缺项会让生成期直接抛）。 */
function blankOutlineSlide(headline: string, recipe: RecipeId = 'statement'): OutlineSlide {
  return { recipe, headline, points: [], visual: { kind: 'none' } }
}

/** 往大纲里插入一条新幕（位置与卡片一致，`move`/`remove` 的既有语义不受影响）。 */
function insertOutlineSlide(slides: OutlineSlide[], at: number, headline: string): OutlineSlide[] {
  const next = slides.slice()
  next.splice(Math.min(Math.max(at, 1), next.length), 0, blankOutlineSlide(headline))
  return next
}

/**
 * 首末锁：第 1 幕恒 cover、末幕恒 closing（契约要求）；只允许内部卡换卡/重排。
 *
 * `?? blankOutlineSlide(...)` 是防御而不是装饰：大纲项一旦缺失，
 * `{...undefined}` 只会留下 `{recipe, headline}`，生成期 `visualOf()` 读 `slide.visual.kind` 就抛，
 * 而抛的不是 AiError，台面上会显示成「网络断了」（v0.2.5 连加三幕的真实教训）。
 */
function syncOutline(state: ForgeState): Outline | null {
  if (!state.outline) return null
  const slides: OutlineSlide[] = state.slides.map((slide) => ({
    ...(state.outline!.slides[slide.index] ?? blankOutlineSlide(slide.headline, slide.recipe)),
    recipe: slide.recipe,
    headline: slide.headline,
  }))
  return { ...state.outline, slides }
}

/**
 * 写 brief：空串等于删掉这个键。
 * 为什么删而不是存 ''：旧 Outline（v0.2.0 生成的）没有这个字段，
 * 保持「没有 brief 就没有这个键」让 draft / fixture 的 JSON 形状稳定可比。
 */
function withBrief(slide: OutlineSlide, brief: string): OutlineSlide {
  const next: OutlineSlide = { ...slide }
  if (brief.trim() === '') delete next.brief
  else next.brief = brief.slice(0, BRIEF_MAX)
  return next
}

/** 纠偏追加：用「；」接在已有 brief 后，再按 200 字截断（契约 §2 硬约束 4）。 */
function appendBrief(brief: string | undefined, note: string): string {
  const base = (brief ?? '').trim()
  return (base === '' ? note : `${base}；${note}`).slice(0, BRIEF_MAX)
}

/**
 * 撤销一条纠偏：把当初追加的那段精确摘掉。
 * 用整段匹配而不是 split('；')，是因为用户写的纠偏里本身可能带「；」。
 */
function dropBriefNote(brief: string | undefined, note: string): string {
  if (!brief) return ''
  if (brief === note) return ''
  if (brief.endsWith(`；${note}`)) return brief.slice(0, brief.length - note.length - 1)
  if (brief.startsWith(`${note}；`)) return brief.slice(note.length + 1)
  const middle = `；${note}；`
  if (brief.includes(middle)) return brief.replace(middle, '；')
  return brief
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
      const headline = seed?.headline ?? (state.lang === 'zh' ? '再补一幕' : 'One more slide')
      slides.splice(insertAt, 0, {
        index: insertAt,
        recipe: 'statement',
        headline,
        status: 'queued',
        errors: [],
        warns: [],
        tokens: 0,
      })
      const reindexed = slides.map((slide, index) => ({ ...slide, index }))
      // 大纲必须同步长出「完整的一幕」，否则尾部那几张卡在生成期拿不到 visual/points。
      const outline = state.outline
        ? { ...state.outline, slides: insertOutlineSlide(state.outline.slides, insertAt, headline) }
        : null
      const next = { ...state, slides: reindexed, total: reindexed.length, outline }
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
    /* ---------------------------- v0.2.5 五组动作 ---------------------------- */
    case 'material:add': {
      // 硬约束 5：上限 5，第 6 条原样弹回（UI 据 materials.length===MATERIAL_MAX 显示「材料已满」）。
      if (state.materials.length >= MATERIAL_MAX) return state
      return { ...state, materials: [...state.materials, action.material] }
    }
    case 'material:patch': {
      const at = state.materials.findIndex((material) => material.id === action.id)
      if (at < 0) return state
      const materials = state.materials.slice()
      const patch = { ...action.patch }
      if (typeof patch.text === 'string') patch.text = patch.text.slice(0, MATERIAL_TEXT_MAX)
      materials[at] = { ...materials[at], ...patch }
      return { ...state, materials }
    }
    case 'material:remove': {
      const materials = state.materials.filter((material) => material.id !== action.id)
      if (materials.length === state.materials.length) return state
      return { ...state, materials }
    }
    case 'audience':
      return state.audience === action.value ? state : { ...state, audience: action.value }
    case 'theme':
      // 硬约束 2：只在 seed / deal 可换；生成中与开演后换主题等于重排已生成的幕，一律不动。
      if (state.phase !== 'seed' && state.phase !== 'deal') return state
      return state.themeId === action.themeId ? state : { ...state, themeId: action.themeId }
    case 'headline': {
      // 硬约束 3：trim 后为空视为误触（清空输入框不算编辑），保留原标题。
      const value = action.value.trim().slice(0, HEADLINE_MAX)
      if (value === '') return state
      const next = withSlide(state, action.index, { headline: value })
      if (next === state) return state
      return { ...next, outline: syncOutline(next) }
    }
    case 'brief': {
      const outline = state.outline
      if (!outline) return state
      if (action.index < 0 || action.index >= outline.slides.length) return state
      const slides = outline.slides.slice()
      slides[action.index] = withBrief(slides[action.index], action.value)
      return { ...state, outline: { ...outline, slides } }
    }
    case 'steer': {
      const note = action.note
      const from = Math.trunc(note.fromIndex)
      // 硬约束 4：fromIndex 必须落在已有个案范围内，否则丢弃整条纠偏（不写入队列）。
      if (!Number.isFinite(from) || from < 0 || from >= state.slides.length) return state
      const steer = [...state.steer, note]
      if (!state.outline) return { ...state, steer }
      const slides = state.outline.slides.map((slide, index) => {
        if (index < from) return slide
        // 已落位（含带病落位 / 卡住）的幕不追溯改写：纠偏只影响还没生成的幕。
        if (isLanded(state.slides[index]?.status ?? 'queued')) return slide
        return withBrief(slide, appendBrief(slide.brief, note.text))
      })
      return { ...state, steer, outline: { ...state.outline, slides } }
    }
    case 'steer:remove': {
      const note = state.steer.find((item) => item.id === action.id)
      if (!note) return state
      const steer = state.steer.filter((item) => item.id !== action.id)
      if (!state.outline) return { ...state, steer }
      const from = Math.trunc(note.fromIndex)
      const slides = state.outline.slides.map((slide, index) => {
        if (!Number.isFinite(from) || index < from) return slide
        if (isLanded(state.slides[index]?.status ?? 'queued')) return slide
        return withBrief(slide, dropBriefNote(slide.brief, note.text))
      })
      return { ...state, steer, outline: { ...state.outline, slides } }
    }
    case 'reuse':
      return { ...state, reuse: action.entries }
    case 'reset':
      return initialForgeState({
        lang: state.lang,
        length: state.length,
        durationMin: state.durationMin,
        includeSvg: state.includeSvg,
        include3d: state.include3d,
        autoPremiere: state.autoPremiere,
        // 硬约束 1：材料篮 / 受众 / 预设是「用户的偏好」，重开也要还在。
        themeId: state.themeId,
        audience: state.audience,
        materials: state.materials,
      })
    default:
      return state
  }
}

export { cycleRecipe }
