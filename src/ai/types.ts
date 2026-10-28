/**
 * types.ts —— AI 模块的公共类型（对外 API 的一部分）。
 */
import type { Block, Deck, RecipeId } from '@/schema/deck'

export type AiLang = 'zh' | 'en'

/** 一句话 → 大纲的输入。 */
export interface ComposeInput {
  prompt: string
  lang: AiLang
  audience?: string
  length: 'short' | 'normal' | 'deep'
  include3d?: boolean
  includeSvg?: boolean
  themeId?: string
  /** 目标时长（分钟），只影响幕数与要点密度。 */
  durationMin?: number
}

/** 配方的输入内容：AI 只产出这些槽位，配方负责排版。 */
export interface RecipeVisual {
  kind: 'svg' | 'three' | 'none'
  /** 已净化的 SVG 源码。 */
  source?: string
  viewBox?: [number, number, number, number]
  /** 已通过 threeDescriptorSchema 的描述符。 */
  descriptor?: import('@/schema/deck').ThreeDescriptor
  caption?: string
}

export interface RecipeContent {
  lang: AiLang
  headline: string
  lead?: string
  points?: string[]
  visual?: RecipeVisual
  /** 封面上的小字标签。 */
  kicker?: string
  /** 页脚 / 图注。 */
  caption?: string
  notes?: string
  /** 幕序号（0 起）与总幕数，配方可用作编号。 */
  index?: number
  total?: number
}

export interface RecipeSlotSpec {
  key: 'headline' | 'lead' | 'points' | 'visual' | 'caption'
  required?: boolean
  max?: number
}

/** 微调意图（规则优先，LLM 只做增强）。 */
export type RefineIntent =
  | 'quieter'
  | 'shorter'
  | 'timeline'
  | 'process'
  | 'compare'
  | 'grid'
  | 'addSvg'
  | 'add3d'
  | 'translate'
  | 'restyle'
  | 'rewrite'
  | 'unknown'

/** 微调计划：调用方拿 diff 预览，确认后用 blockOps 应用。 */
export interface SlidePatchPlan {
  slideId: string
  intent: RefineIntent
  /** i18n key（ai.intent.*），UI 直接取词。 */
  summaryKey: string
  recipe?: RecipeId
  /** 应用后的完整块集合。 */
  nextBlocks: Block[]
  diff: {
    removed: string[]
    added: string[]
    changed: string[]
  }
  warnings: string[]
  provider: string
}

export interface GenerateSvgResult {
  source: string
  provider: string
  model?: string
}

export interface GenerateThreeResult {
  descriptor: import('@/schema/deck').ThreeDescriptor
  provider: string
  model?: string
}

export interface BuildDeckOptions {
  themeId?: string
  prompt?: string
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export interface BuildDeckResult {
  deck: Deck
  warnings: string[]
}
