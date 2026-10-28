/**
 * usePlayback.ts —— 索引 / 方向 / 黑屏 / 计时 / 自动播放的状态机。
 *
 * 纯逻辑全部放在 playbackCore.ts，这里只负责：
 * - 把 deck 总幕数同步进 reducer（deck 增删幕后下标自动收敛）；
 * - 驱动计时器（200ms 一次，只在播放器挂载期间跑）；
 * - 自动播放的停留计时（幕的 durationMs 由调用方折算成 autoplayMs 传入）。
 */
import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  autoplayDelayOf,
  initialPlaybackState,
  playbackReducer,
  type PlayDirection,
} from './playbackCore'

export interface UsePlaybackOptions {
  total: number
  initialIndex?: number
  /** 该幕的停留时长（幕 durationMs ?? settings.autoPlayMs）。 */
  autoplayMs?: number
  loop?: boolean
  /**
   * 可选扩展：按幕计算停留时长。给了它就用它（Player 用它读 `slide.durationMs`），
   * 否则退回 `autoplayMs`。用 ref 读取，避免每帧重建定时器。
   */
  durationOf?: (index: number) => number
}

export interface UsePlaybackApi {
  index: number
  direction: PlayDirection
  total: number
  go: (index: number) => void
  next: () => void
  prev: () => void
  first: () => void
  last: () => void
  blackout: boolean
  toggleBlackout: () => void
  autoplay: boolean
  toggleAutoplay: (value?: boolean) => void
  elapsedMs: number
  resetTimer: () => void
}

const TIMER_TICK_MS = 200

export function usePlayback(opts: UsePlaybackOptions): UsePlaybackApi {
  const { total, initialIndex = 0, autoplayMs, loop = false, durationOf } = opts
  const [state, dispatch] = useReducer(
    playbackReducer,
    { total, initialIndex },
    (init) => initialPlaybackState(init.total, init.initialIndex),
  )

  // 计时起点：resetTimer 时重置；用 Date.now 而不是累加，避免定时器漂移。
  const startedAtRef = useRef<number>(Date.now())

  // 停留时长随时可变（换幕、设置变化），用 ref 读，避免无谓地重建定时器。
  const autoplayRef = useRef({ autoplayMs, durationOf })
  autoplayRef.current = { autoplayMs, durationOf }

  useEffect(() => {
    dispatch({ type: 'syncTotal', total })
  }, [total])

  useEffect(() => {
    const id = window.setInterval(() => {
      dispatch({ type: 'setElapsed', ms: Date.now() - startedAtRef.current })
    }, TIMER_TICK_MS)
    return () => window.clearInterval(id)
  }, [])

  const go = useCallback(
    (index: number) => {
      dispatch({ type: 'go', index, total })
    },
    [total],
  )
  const next = useCallback(() => {
    dispatch({ type: 'next', total, loop })
  }, [total, loop])
  const prev = useCallback(() => {
    dispatch({ type: 'prev', total, loop })
  }, [total, loop])
  const first = useCallback(() => {
    dispatch({ type: 'first' })
  }, [])
  const last = useCallback(() => {
    dispatch({ type: 'last', total })
  }, [total])
  const toggleBlackout = useCallback(() => {
    dispatch({ type: 'toggleBlackout' })
  }, [])
  const toggleAutoplay = useCallback((value?: boolean) => {
    if (typeof value === 'boolean') dispatch({ type: 'setAutoplay', value })
    else dispatch({ type: 'toggleAutoplay' })
  }, [])
  const resetTimer = useCallback(() => {
    startedAtRef.current = Date.now()
    dispatch({ type: 'resetTimer' })
  }, [])

  // 自动播放：黑屏时暂停；到最后一幕且没开循环就自动收尾，避免"开着却不动"的困惑。
  useEffect(() => {
    if (!state.autoplay) return
    if (state.blackout) return
    if (state.total <= 1) return
    const atEnd = state.index >= state.total - 1
    if (atEnd && !loop) {
      dispatch({ type: 'setAutoplay', value: false })
      return
    }
    const { autoplayMs: fallback, durationOf: resolve } = autoplayRef.current
    const delay = autoplayDelayOf(resolve?.(state.index), fallback ?? 8000)
    const id = window.setTimeout(() => {
      dispatch({ type: 'next', total: state.total, loop })
    }, delay)
    return () => window.clearTimeout(id)
  }, [state.autoplay, state.blackout, state.index, state.total, loop])

  return {
    index: state.index,
    direction: state.direction,
    total: state.total,
    go,
    next,
    prev,
    first,
    last,
    blackout: state.blackout,
    toggleBlackout,
    autoplay: state.autoplay,
    toggleAutoplay,
    elapsedMs: state.elapsedMs,
    resetTimer,
  }
}
