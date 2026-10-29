/**
 * types.ts —— AI 模块的公共类型（对外 API 的一部分）。
 */
import type { Block, Deck, Outline, RecipeId, Slide } from '@/schema/deck'

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
  /** v0.2.5：材料篮（只取前 5 条、每条前 200 字进 prompt；02 §3.4）。 */
  materials?: { label: string; text: string }[]
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

/* --------------------------- 造幕台阶段事件（v0.2.0） --------------------------- */

/** 管线阶段（04 §4.1 的七状态）：只用于流程脉冲，不代表数据结构。 */
export type ForgeStage = 'think' | 'plan' | 'write' | 'draw' | 'set' | 'check' | 'seal'

/**
 * `onStage` 的唯一事件联合（02 §4.3 + 04 §4.4 的并集）：
 * - `stage`：管线阶段脉冲（04）；
 * - `slide:*` / `deck:*`：造幕台单幕推进与收尾（02）。
 * 事件在对应步骤**完成的同一帧**发出，不预发、不延时（D2）。
 */
export type ForgeStageEvent =
  | { type: 'stage'; stage: ForgeStage; index?: number; done?: number; total?: number; at: number }
  | { type: 'slide:start'; index: number }
  | { type: 'slide:content'; index: number; tokens: number; text?: string }
  | { type: 'slide:visual'; index: number; kind: 'svg' | 'three' | 'none' }
  | { type: 'slide:layout'; index: number; blocks: number }
  | { type: 'slide:gate'; index: number; errors: string[]; warns: string[] }
  | { type: 'slide:landed'; index: number; slide: Slide }
  | { type: 'slide:recast'; index: number; slide: Slide; warnings: string[] }
  | { type: 'deck:done'; deck: Deck; warnings: string[] }
  | { type: 'deck:aborted' }

export interface BuildDeckOptions {
  themeId?: string
  prompt?: string
  onProgress?: (done: number, total: number) => void
  /** 公共阶段回调（纯增量：不传时行为与 v0.1.0 完全一致）。 */
  onStage?: (event: ForgeStageEvent) => void
  /** 是否在管线结束时一次性落库（默认 true）；造幕台传 false，由自己按「已完成幕」落库（D12）。 */
  persist?: boolean
  signal?: AbortSignal
  /** v0.2.5：每幕开始前重取一次大纲 —— 生成中纠偏（steering）就是靠它生效（02 §3.4）。 */
  liveOutline?: () => Outline
  /**
   * v0.2.5：材料篮，原样透传到单幕 prompt（只取前 5 条、每条前 200 字）。
   * 契约 §3.4 只写了 `SlideBuildContext.materials`，这里是它的唯一来源（纯增量，默认 undefined 行为不变）。
   */
  materials?: { label: string; text: string }[]
}

export interface BuildDeckResult {
  deck: Deck
  warnings: string[]
}
