/**
 * tests/unit/play.test.ts —— player 模块的单测。
 *
 * 覆盖三块纯逻辑：翻页状态机（playbackCore）、转场时长归一（PlaySurface）、
 * 讲者窗同步协议与注入转义（presenter / PresenterWindow）。
 * 这些用例不渲染 React，也不依赖 WebGL。
 */
import { describe, expect, it } from 'vitest'
import { slideSchema, type Slide } from '@/schema/deck'
import {
  AUTOPLAY_MAX_MS,
  AUTOPLAY_MIN_MS,
  autoplayDelayOf,
  clampIndex,
  directionBetween,
  formatClock,
  initialPlaybackState,
  playbackReducer,
  stepIndex,
  type PlaybackAction,
  type PlaybackState,
} from '@/play/playbackCore'
import {
  REDUCED_MOTION_MS,
  TRANSITION_MAX_MS,
  TRANSITION_MIN_MS,
  planTransition,
} from '@/play/PlaySurface'
import { isSyncMessage } from '@/play/presenter'
import { escapeHtml, jsonForScript } from '@/play/PresenterWindow'

function slideOf(patch: Record<string, unknown> = {}): Slide {
  return slideSchema.parse({ id: 'slide_x', blocks: [], ...patch })
}

function run(state: PlaybackState, ...actions: PlaybackAction[]): PlaybackState {
  return actions.reduce(playbackReducer, state)
}

describe('playbackCore · 下标与方向', () => {
  it('clamps indices into range', () => {
    expect(clampIndex(5, 3)).toBe(2)
    expect(clampIndex(-2, 3)).toBe(0)
    expect(clampIndex(1.9, 3)).toBe(1)
    expect(clampIndex(2, 0)).toBe(0)
    expect(clampIndex(Number.NaN, 4)).toBe(0)
  })

  it('steps forward/backward with and without loop', () => {
    expect(stepIndex(0, 3, 1)).toBe(1)
    expect(stepIndex(2, 3, 1)).toBe(-1)
    expect(stepIndex(2, 3, 1, true)).toBe(0)
    expect(stepIndex(0, 3, -1)).toBe(-1)
    expect(stepIndex(0, 3, -1, true)).toBe(2)
    expect(stepIndex(0, 0, 1)).toBe(-1)
    expect(stepIndex(0, 1, 1)).toBe(-1)
  })

  it('derives direction from the index delta', () => {
    expect(directionBetween(1, 4)).toBe('fwd')
    expect(directionBetween(4, 1)).toBe('back')
    expect(directionBetween(2, 2)).toBe('fwd')
  })
})

describe('playbackCore · 状态机', () => {
  it('starts at the requested index with a clean slate', () => {
    const state = initialPlaybackState(5, 3)
    expect(state).toMatchObject({ total: 5, index: 3, direction: 'fwd', blackout: false, autoplay: false, elapsedMs: 0 })
  })

  it('stays stable for an empty deck', () => {
    const empty = initialPlaybackState(0, 2)
    expect(empty.index).toBe(0)
    const afterNext = playbackReducer(empty, { type: 'next' })
    const afterLast = playbackReducer(empty, { type: 'last' })
    expect(afterNext.index).toBe(0)
    expect(afterLast.index).toBe(0)
  })

  it('moves next / prev and records direction', () => {
    let state = initialPlaybackState(4, 1)
    state = playbackReducer(state, { type: 'next' })
    expect(state.index).toBe(2)
    expect(state.direction).toBe('fwd')
    state = playbackReducer(state, { type: 'prev' })
    expect(state.index).toBe(1)
    expect(state.direction).toBe('back')
  })

  it('does not move past the ends unless looping', () => {
    const last = playbackReducer(initialPlaybackState(4, 3), { type: 'next' })
    expect(last.index).toBe(3)
    const first = playbackReducer(initialPlaybackState(4, 0), { type: 'prev' })
    expect(first.index).toBe(0)

    const wrapped = playbackReducer(initialPlaybackState(4, 3), { type: 'next', loop: true })
    expect(wrapped.index).toBe(0)
    expect(wrapped.direction).toBe('fwd')

    const wrappedBack = playbackReducer(initialPlaybackState(4, 0), { type: 'prev', loop: true })
    expect(wrappedBack.index).toBe(3)
    expect(wrappedBack.direction).toBe('back')
  })

  it('supports go / first / last with clamping', () => {
    const state = initialPlaybackState(5, 3)
    expect(playbackReducer(state, { type: 'go', index: 0 }).index).toBe(0)
    expect(playbackReducer(state, { type: 'go', index: 0 }).direction).toBe('back')
    expect(playbackReducer(state, { type: 'go', index: 99 }).index).toBe(4)
    expect(playbackReducer(state, { type: 'first' }).index).toBe(0)
    expect(playbackReducer(state, { type: 'last' }).index).toBe(4)
    expect(playbackReducer(state, { type: 'last' }).direction).toBe('fwd')
  })

  it('re-clamps when the deck shrinks', () => {
    const state = initialPlaybackState(6, 5)
    const shrunk = playbackReducer(state, { type: 'syncTotal', total: 2 })
    expect(shrunk.total).toBe(2)
    expect(shrunk.index).toBe(1)
    expect(playbackReducer(shrunk, { type: 'syncTotal', total: 2 })).toBe(shrunk)
  })

  it('toggles blackout / autoplay and clamps the timer', () => {
    let state = initialPlaybackState(3, 0)
    state = run(state, { type: 'toggleBlackout' })
    expect(state.blackout).toBe(true)
    state = run(state, { type: 'setBlackout', value: false })
    expect(state.blackout).toBe(false)

    state = run(state, { type: 'toggleAutoplay' })
    expect(state.autoplay).toBe(true)
    state = run(state, { type: 'toggleAutoplay' })
    expect(state.autoplay).toBe(false)
    state = run(state, { type: 'setAutoplay', value: true })
    expect(state.autoplay).toBe(true)

    state = run(state, { type: 'setElapsed', ms: 12_345 })
    expect(state.elapsedMs).toBe(12_345)
    expect(run(state, { type: 'setElapsed', ms: -50 }).elapsedMs).toBe(0)
    expect(run(state, { type: 'resetTimer' }).elapsedMs).toBe(0)
  })
})

describe('playbackCore · 自动播放与计时格式', () => {
  it('prefers the slide duration and clamps it', () => {
    expect(autoplayDelayOf(undefined, 8000)).toBe(8000)
    expect(autoplayDelayOf(0, 5000)).toBe(5000)
    expect(autoplayDelayOf(1200, 8000)).toBe(1200)
    expect(autoplayDelayOf(10, 8000)).toBe(AUTOPLAY_MIN_MS)
    expect(autoplayDelayOf(999_999, 8000)).toBe(AUTOPLAY_MAX_MS)
    expect(autoplayDelayOf(undefined, 0)).toBe(8000)
  })

  it('formats the clock', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(9_000)).toBe('0:09')
    expect(formatClock(65_000)).toBe('1:05')
    expect(formatClock(59_999)).toBe('0:59')
    expect(formatClock(3_600_000)).toBe('1:00:00')
    expect(formatClock(-1)).toBe('0:00')
    expect(formatClock(Number.NaN)).toBe('0:00')
  })
})

describe('PlaySurface · 转场规划', () => {
  it('reads the slide transition', () => {
    const slide = slideOf({ transition: { kind: 'push', ms: 420 } })
    expect(planTransition(slide, false)).toEqual({ kind: 'push', ms: 420 })
  })

  it('normalizes duration into 200–800ms and treats 0 as instant', () => {
    const long = slideOf({ transition: { kind: 'flip3d', ms: 2000 } })
    expect(planTransition(long, false)).toEqual({ kind: 'flip3d', ms: TRANSITION_MAX_MS })
    const short = slideOf({ transition: { kind: 'fade', ms: 60 } })
    expect(planTransition(short, false).ms).toBe(TRANSITION_MIN_MS)
    const off = slideOf({ transition: { kind: 'wipe', ms: 0 } })
    expect(planTransition(off, false).ms).toBe(0)
    const none = slideOf({ transition: { kind: 'none', ms: 500 } })
    expect(planTransition(none, false).ms).toBe(0)
  })

  it('falls back to a plain fade when reduced motion is on', () => {
    const slide = slideOf({ transition: { kind: 'flip3d', ms: 800 } })
    expect(planTransition(slide, true)).toEqual({ kind: 'fade', ms: REDUCED_MOTION_MS })
    expect(planTransition(undefined, false)).toEqual({ kind: 'fade', ms: 420 })
  })
})

describe('presenter · 同步协议与注入安全', () => {
  it('recognizes only protocol messages', () => {
    expect(isSyncMessage({ type: 'state' })).toBe(true)
    expect(isSyncMessage({ type: 'deck' })).toBe(true)
    expect(isSyncMessage({ type: 'command', action: 'next' })).toBe(true)
    expect(isSyncMessage({ type: 'hello' })).toBe(true)
    expect(isSyncMessage({ type: 'nope' })).toBe(false)
    expect(isSyncMessage(null)).toBe(false)
    expect(isSyncMessage('state')).toBe(false)
  })

  it('cannot break out of an inline script with deck text', () => {
    const payload = { notes: '</script><img src=x onerror=alert(1)>' }
    const json = jsonForScript(payload)
    expect(json).not.toContain('</script>')
    expect(json).toContain('\\u003c/script>')
  })

  it('escapes html for the static skeleton', () => {
    expect(escapeHtml('<b>"x"&</b>')).toBe('&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;')
  })
})
