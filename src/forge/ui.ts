/**
 * forge/ui.ts —— 造幕台各组件的 props 契约（ForgeApp 与 stage/、hud/ 的唯一接缝）。
 * 表现层只读这里的数据；任何跨组件改动的第一站也是这里。
 */
import type { Deck, Outline, RecipeId } from '@/schema/deck'
import type { Lang } from '@/i18n'
import type {
  ForgeError,
  ForgeLength,
  ForgePhase,
  ForgeSlideState,
  ForgeStage,
  ForgeTier,
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
  onPrompt: (value: string) => void
  onOption: (patch: Partial<Pick<SeedProps, 'length' | 'durationMin' | 'includeSvg' | 'include3d'>>) => void
  onLang: () => void
  onSubmit: () => void
  onResume: () => void
  onClear: () => void
  onErrorAction: () => void
  onErrorDismiss: () => void
}

export interface DealProps {
  outline: Outline | null
  slides: ForgeSlideState[]
  /** 系统裁剪的 3D 幕序号（只有这类才显示「3D 限 2」角标）。 */
  cropped3d?: number[]
  tier: ForgeTier
  onSwap: (index: number) => void
  onRemove: (index: number) => void
  onAdd: () => void
  onMove: (from: number, to: number) => void
  onCast: () => void
  onBack: () => void
  onFocusCard?: (index: number) => void
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
  onPlay: () => void
  onBack: () => void
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
