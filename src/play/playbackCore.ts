/**
 * playbackCore.ts —— 播放状态机的纯逻辑。
 *
 * 这里不碰 React / DOM / 计时器：`usePlayback` 只是把 reducer + 定时器接起来，
 * 所以"翻页语义"可以用普通单测把边界全部钉死（空 deck、单幕、循环、首尾）。
 */

export type PlayDirection = 'fwd' | 'back'

export interface PlaybackState {
  /** 总幕数（0 表示没有可播内容）。 */
  total: number
  /** 当前幕下标（total=0 时为 0）。 */
  index: number
  /** 最近一次翻页方向，转场动画用它决定推入/推出的方向。 */
  direction: PlayDirection
  blackout: boolean
  autoplay: boolean
  /** 计时器读数（毫秒），由外部驱动。 */
  elapsedMs: number
}

export type PlaybackAction =
  | { type: 'syncTotal'; total: number }
  | { type: 'go'; index: number; total?: number }
  | { type: 'next'; total?: number; loop?: boolean }
  | { type: 'prev'; total?: number; loop?: boolean }
  | { type: 'first' }
  | { type: 'last'; total?: number }
  | { type: 'setBlackout'; value: boolean }
  | { type: 'toggleBlackout' }
  | { type: 'setAutoplay'; value: boolean }
  | { type: 'toggleAutoplay' }
  | { type: 'setElapsed'; ms: number }
  | { type: 'resetTimer' }

/** 自动播放的最短停留，避免 durationMs=0 时疯狂翻页。 */
export const AUTOPLAY_MIN_MS = 250
/** 自动播放的最长停留（与 schema 的 600s 上限一致）。 */
export const AUTOPLAY_MAX_MS = 600_000

/** 把任意下标夹到 [0, total-1]；total<=0 时恒为 0。 */
export function clampIndex(index: number, total: number): number {
  if (!Number.isFinite(index) || total <= 0) return 0
  return Math.max(0, Math.min(total - 1, Math.trunc(index)))
}

export function directionBetween(from: number, to: number): PlayDirection {
  return to < from ? 'back' : 'fwd'
}

export function initialPlaybackState(total: number, initialIndex = 0): PlaybackState {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0
  return {
    total: safeTotal,
    index: clampIndex(initialIndex, safeTotal),
    direction: 'fwd',
    blackout: false,
    autoplay: false,
    elapsedMs: 0,
  }
}

/** 翻页的实际落点（纯函数，返回 -1 表示无法移动）。 */
export function stepIndex(
  index: number,
  total: number,
  delta: 1 | -1,
  loop = false,
): number {
  if (total <= 0) return -1
  const current = clampIndex(index, total)
  const next = current + delta
  if (next < 0) return loop ? total - 1 : -1
  if (next > total - 1) return loop ? 0 : -1
  return next
}

/** 自动播放该幕的停留时长：幕自带 durationMs 优先，回落到全局设置。 */
export function autoplayDelayOf(durationMs: number | undefined, fallbackMs: number): number {
  const raw =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? durationMs
      : fallbackMs
  if (!Number.isFinite(raw) || raw <= 0) return 8000
  return Math.max(AUTOPLAY_MIN_MS, Math.min(AUTOPLAY_MAX_MS, Math.round(raw)))
}

/** 计时读数 → `m:ss` / `h:mm:ss`。 */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function moveTo(state: PlaybackState, target: number): PlaybackState {
  const index = clampIndex(target, state.total)
  if (index === state.index) return state
  return { ...state, index, direction: directionBetween(state.index, index) }
}

export function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case 'syncTotal': {
      const total = Number.isFinite(action.total) ? Math.max(0, Math.trunc(action.total)) : 0
      if (total === state.total) return state
      const index = clampIndex(state.index, total)
      return { ...state, total, index }
    }

    case 'go': {
      const total = action.total ?? state.total
      // total 可能随 deck 变化，先对齐再跳转。
      const synced = total === state.total ? state : { ...state, total: Math.max(0, total), index: clampIndex(state.index, total) }
      return moveTo(synced, action.index)
    }

    case 'next': {
      const total = action.total ?? state.total
      const base = total === state.total ? state : { ...state, total: Math.max(0, total), index: clampIndex(state.index, total) }
      const target = stepIndex(base.index, base.total, 1, action.loop ?? false)
      if (target < 0) return base
      // 循环回第一卷仍算"前进"，方向语义保持连续。
      if (target === 0 && base.index === base.total - 1) {
        return { ...base, index: 0, direction: 'fwd' }
      }
      return moveTo(base, target)
    }

    case 'prev': {
      const total = action.total ?? state.total
      const base = total === state.total ? state : { ...state, total: Math.max(0, total), index: clampIndex(state.index, total) }
      const target = stepIndex(base.index, base.total, -1, action.loop ?? false)
      if (target < 0) return base
      if (target === base.total - 1 && base.index === 0) {
        return { ...base, index: target, direction: 'back' }
      }
      return moveTo(base, target)
    }

    case 'first':
      return moveTo(state, 0)

    case 'last': {
      const total = action.total ?? state.total
      const base = total === state.total ? state : { ...state, total: Math.max(0, total), index: clampIndex(state.index, total) }
      return moveTo(base, base.total - 1)
    }

    case 'setBlackout':
      return state.blackout === action.value ? state : { ...state, blackout: action.value }

    case 'toggleBlackout':
      return { ...state, blackout: !state.blackout }

    case 'setAutoplay':
      return state.autoplay === action.value ? state : { ...state, autoplay: action.value }

    case 'toggleAutoplay':
      return { ...state, autoplay: !state.autoplay }

    case 'setElapsed': {
      const ms = Number.isFinite(action.ms) ? Math.max(0, Math.round(action.ms)) : 0
      return ms === state.elapsedMs ? state : { ...state, elapsedMs: ms }
    }

    case 'resetTimer':
      return state.elapsedMs === 0 ? state : { ...state, elapsedMs: 0 }

    default:
      return state
  }
}
