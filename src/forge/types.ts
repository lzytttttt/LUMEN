/**
 * forge/types.ts —— 造幕台的对外类型契约（02 §4、03 §7、04 §4）。
 *
 * 只放类型与纯数据；状态机在 state.ts，编排在 run.ts，表现层在 stage/ 与 hud/。
 */
import type { ForgeStage, ForgeStageEvent } from '@/ai/types'
import type { Deck, Outline, RecipeId, Slide } from '@/schema/deck'
import type { MessageKey } from '@/i18n'

export type ForgePhase = 'seed' | 'deal' | 'casting' | 'premiere'

export type SlideStatus =
  | 'queued'
  | 'drafting'
  | 'art'
  | 'typesetting'
  | 'gating'
  | 'landed'
  | 'flagged'
  | 'stuck'
  | 'dropped'

export type ForgeTier = 'L0' | 'L1' | 'L2' | 'L3'

export type ForgeLength = 'short' | 'normal' | 'deep'

export interface ForgeError {
  code: string
  key: MessageKey
  at: number
}

export interface ForgeSlideState {
  index: number
  recipe: RecipeId
  headline: string
  status: SlideStatus
  slide?: Slide
  errors: string[]
  warns: string[]
  tokens: number
}

export interface ForgeLive {
  key: MessageKey
  vars?: Record<string, string | number>
}

export interface ForgeState {
  phase: ForgePhase
  prompt: string
  lang: 'zh' | 'en'
  length: ForgeLength
  durationMin: number
  includeSvg: boolean
  include3d: boolean
  outline: Outline | null
  /** 被系统裁剪掉视觉的 3D 幕序号（03 §3.4：只有系统裁剪才显示角标）。 */
  cropped3d: number[]
  slides: ForgeSlideState[]
  total: number
  done: number
  stage: ForgeStage
  /** 0–7 的连续进度量（04 §4.3），只由 stage 事件推进。 */
  prog: number
  error: ForgeError | null
  busy: boolean
  stopped: boolean
  /** 已落库（关闭时用于幂等判断，D12）。 */
  saved: boolean
  deck: Deck | null
  active: number | null
  dealAt: number
  premiereAt: number
  live: ForgeLive | null
  /** 会自动播放时给 UI 的标记（`?still=1` 时为 false）。 */
  autoPremiere: boolean
}

export type ForgeAction =
  | { type: 'prompt'; value: string }
  | { type: 'option'; patch: Partial<Pick<ForgeState, 'length' | 'durationMin' | 'includeSvg' | 'include3d' | 'lang'>> }
  | { type: 'submit' }
  | { type: 'outline'; outline: Outline; cropped3d?: number[] }
  | { type: 'fail'; code: string; key: MessageKey }
  | { type: 'swap'; index: number }
  | { type: 'remove'; index: number }
  | { type: 'add' }
  | { type: 'move'; from: number; to: number }
  | { type: 'cast' }
  | { type: 'stageEvent'; event: ForgeStageEvent }
  | { type: 'deck'; deck: Deck }
  | { type: 'stop' }
  | { type: 'recast'; index: number }
  | { type: 'recastDone'; index: number; slide: Slide; warnings: string[] }
  | { type: 'clearError' }
  | { type: 'saved' }
  | { type: 'live'; live: ForgeLive | null }
  | { type: 'reset' }

export type { ForgeStage, ForgeStageEvent }
