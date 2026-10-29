/**
 * forge/ui.ts —— 造幕台各组件的 props 契约（ForgeApp 与 stage/、hud/ 的唯一接缝）。
 * 表现层只读这里的数据；任何跨组件改动的第一站也是这里。
 *
 * v0.2.5 的增量字段按 02 §3.5 原样必填：flow-ui 的 stage 组件与 ForgeApp 一起接线，
 * 少传一个就在编译期红，别让「材料篮静默不渲染」这种缺口活到 e2e。
 */
import type { Deck, Outline, RecipeId } from '@/schema/deck'
import type { Lang } from '@/i18n'
import type {
  ForgeError,
  ForgeLength,
  ForgeMaterial,
  ForgePhase,
  ForgeSlideState,
  ForgeStage,
  ForgeTier,
  MaterialKind,
  ReuseEntry,
  SteerNote,
} from './types'

export interface SeedProps {
  prompt: string
  lang: Lang
  length: ForgeLength
  durationMin: number
  includeSvg: boolean
  include3d: boolean
  offline: boolean
  busy: boolean
  hasDraft: boolean
  error: ForgeError | null
  /** v0.2.5：材料篮（只读；增删走下面的回调）。 */
  materials: ForgeMaterial[]
  /** v0.2.5：'' | 'exec' | 'team' | 'client' | 'class'。 */
  audience: string
  /** v0.2.5：'' 表示跟随当前 deck 的 themeId。 */
  themeId: string
  /** v0.2.5：「最近一套」。 */
  reuse: ReuseEntry[]
  onPrompt: (value: string) => void
  onOption: (patch: Partial<Pick<SeedProps, 'length' | 'durationMin' | 'includeSvg' | 'include3d'>>) => void
  onLang: () => void
  onSubmit: () => void
  onResume: () => void
  onClear: () => void
  onErrorAction: () => void
  onErrorDismiss: () => void
  /** v0.2.5：起念屏的「加料」只负责收集原文，截断与 tokens 由 makeMaterial 统一处理。 */
  onMaterialAdd: (input: { kind: MaterialKind; label: string; text: string }) => void
  onMaterialRemove: (id: string) => void
  onAudience: (value: string) => void
  onTheme: (themeId: string) => void
  onReuse: (entry: ReuseEntry) => void
}

export interface DealProps {
  outline: Outline | null
  slides: ForgeSlideState[]
  /** 系统裁剪的 3D 幕序号（只有这类才显示「3D 限 2」角标）。 */
  cropped3d?: number[]
  tier: ForgeTier
  /** v0.2.5：大纲卡阵页头的预设选择（只在 deal 生效，reducer 已兜底）。 */
  themeId: string
  onSwap: (index: number) => void
  onRemove: (index: number) => void
  onAdd: () => void
  onMove: (from: number, to: number) => void
  onCast: () => void
  onBack: () => void
  onFocusCard?: (index: number) => void
  onTheme: (themeId: string) => void
  /** v0.2.5：内联改标题（空串由 reducer 忽略）；brief 走「这一幕想讲什么」。 */
  onHeadline: (index: number, value: string) => void
  onBrief: (index: number, value: string) => void
}

/** v0.2.5 新增：生成页底部的纠偏条（0 个 data-forge-text，文案全走 i18n）。 */
export interface SteerBarProps {
  done: number
  total: number
  notes: SteerNote[]
  busy: boolean
  onSteer: (text: string) => void
  onUndo: (id: string) => void
}

export interface AssembleProps {
  tier: ForgeTier
  phase: ForgePhase
  slides: ForgeSlideState[]
  deck: Deck | null
  total: number
  done: number
  active: number | null
  stage: ForgeStage
  stopped: boolean
  onRecast: (index: number) => void
  onStop: () => void
  onResume: () => void
  onPlay: () => void
}

export interface GateProps {
  slides: ForgeSlideState[]
  active: number | null
  tier: ForgeTier
  onRecast: (index: number) => void
}

export interface PremiereProps {
  deck: Deck | null
  slides: ForgeSlideState[]
  tier: ForgeTier
  accent: string
  /**
   * v0.2.5：开演席三枚下一步（播放是原有的 onPlay）。
   * `onBack` 已并入 `onEdit`——两者都是「关台 + 回到这一套」，留两枚等于让用户白选一次；
   * 关台的出口是 HUD 返回键与 Esc。
   */
  onEdit: () => void
  onMore: () => void
  onPlay: () => void
  onAgain: () => void
}

export interface HudProps {
  mark: 'seed' | 'deal' | 'cast' | 'assemble' | 'gate' | 'premiere'
  title: string
  done: number
  total: number
  combo: number
  level: number
  tier: ForgeTier
  busy: boolean
  canClose: boolean
  onClose: () => void
  onLang: () => void
  lang: Lang
}

export interface PulseProps {
  prog: number
  stage: ForgeStage
  bad: boolean
  tier: ForgeTier
  label: string | null
}

export interface FxToastItem {
  id: string
  kind: 'combo' | 'xp' | 'achievement' | 'level' | 'error'
  text: string
  tone?: 'accent' | 'warn' | 'danger'
}

export interface FxToastProps {
  items: FxToastItem[]
}

export interface CardFaceProps {
  index: number
  total: number
  recipe: RecipeId
  headline: string
  status: ForgeSlideState['status']
  warn: boolean
  error: boolean
  locked: 'first' | 'last' | null
  duplicate: number
  compact: boolean
  badge?: 'more3d' | null
  selected?: boolean
  onOpen?: () => void
  onRemove?: () => void
  onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void
  labelledBy?: string
}
