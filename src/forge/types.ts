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

/* ------------------------------ v0.2.5 增量 ------------------------------ */

/**
 * 材料：只有文本进入模型，二进制一律不解析（00 §6 边界）。
 * `tokens` 只是估算（materials.ts 的 estimateTokens），用于给 UI 一个体量感，不参与计费。
 */
export type MaterialKind = 'paste' | 'url' | 'file'
export type MaterialStatus = 'ready' | 'parsing' | 'failed'

export interface ForgeMaterial {
  /** mat-<ts>-<rand4> */
  id: string
  kind: MaterialKind
  /** 用户内容，展示截 24 字符（D 类预算）。 */
  label: string
  /** 正文，硬上限 MATERIAL_TEXT_MAX = 4000。 */
  text: string
  tokens: number
  at: number
  status: MaterialStatus
}

/** 生成中追加的一条要求；fromIndex 是它开始生效的幕序号。 */
export interface SteerNote {
  /** st-<ts>-<rand4> */
  id: string
  /** ≤60 字，硬截。 */
  text: string
  fromIndex: number
  at: number
}

/** 「最近一套」：只存大纲级别，不存成品 Deck（体量）。 */
export interface ReuseEntry {
  id: string
  title: string
  prompt: string
  themeId: string
  count: number
  at: number
  outline: Outline
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
  /** v0.2.5：起念屏材料篮（≤MATERIAL_MAX 条，只有文本进模型）。 */
  materials: ForgeMaterial[]
  /** v0.2.5：受众（'' | 'exec' | 'team' | 'client' | 'class'），只影响 prompt 语气。 */
  audience: string
  /** v0.2.5：设计预设 id；'' 表示跟随当前 deck 的 themeId。 */
  themeId: string
  /** v0.2.5：生成中追加的要求（落到未落位幕的 brief）。 */
  steer: SteerNote[]
  /** v0.2.5：「最近一套」（ForgeApp 异步灌入，初始 []）。 */
  reuse: ReuseEntry[]
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
  | { type: 'material:add'; material: ForgeMaterial }
  | { type: 'material:patch'; id: string; patch: Partial<Pick<ForgeMaterial, 'status' | 'text' | 'tokens'>> }
  | { type: 'material:remove'; id: string }
  | { type: 'audience'; value: string }
  | { type: 'theme'; themeId: string }
  | { type: 'headline'; index: number; value: string }
  | { type: 'brief'; index: number; value: string }
  | { type: 'steer'; note: SteerNote }
  /** 撤销一条还没生效的纠偏（契约 §2 未列、flow-ui 的 SteerBar 需要，见 02 §3.2 的撤销口径）。 */
  | { type: 'steer:remove'; id: string }
  | { type: 'reuse'; entries: ReuseEntry[] }
  | { type: 'reset' }

export type { ForgeStage, ForgeStageEvent }
