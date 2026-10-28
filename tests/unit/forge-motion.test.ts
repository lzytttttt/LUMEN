/**
 * forge-motion.test.ts —— 台面降级判定与 rAF 调度器（`src/forge/fx/`）。
 *
 * 依据：`plan/v0.2.0/00` §6.1（L0–L3 判定）、`02` §9.3、`07` §3.5 的 D-01…D-05。
 * 只验纯函数与单例调度器；DOM 观感交给 e2e。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentTier, detectTier, isStillMode, tierVar } from '@/forge/fx/tier'
import { raf, sampleFrames, tickForTest } from '@/forge/fx/raf'
import { useSettingsStore } from '@/state/settingsStore'

const ORIGIN = window.location.origin

function setSearch(search: string) {
  window.history.replaceState({}, '', `${ORIGIN}/${search}`)
}

afterEach(() => {
  raf.stop()
  try {
    setSearch('')
  } catch {
    /* 某些 jsdom 版本不允许改写 history：本条用例已在 try 内自行复原。 */
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useSettingsStore.setState({ forge: { ...useSettingsStore.getState().forge, tier: 'auto' } })
})

/* ------------------------------- detectTier ------------------------------ */

describe('detectTier · L0–L3', () => {
  beforeEach(() => {
    // jsdom 没有 canvas 实现：显式提供 getContext，避免「Not implemented」噪声。
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })
  it('forces L0 in still mode, before every other input', () => {
    expect(detectTier({ still: true })).toBe('L0')
    expect(detectTier({ still: true, locked: 'L3', webgl2: true, cores: 16, saveData: false })).toBe('L0')
    expect(detectTier({ still: true, reducedMotion: true, cores: 1 })).toBe('L0')
  })

  it('lets an explicit lock win over auto detection', () => {
    for (const locked of ['L0', 'L1', 'L2', 'L3'] as const) {
      expect(detectTier({ locked, webgl2: true, cores: 16 })).toBe(locked)
      expect(detectTier({ locked, webgl2: false, cores: 1, reducedMotion: true, saveData: true })).toBe(locked)
    }
    expect(detectTier({ locked: 'auto', webgl2: true, cores: 8 })).toBe('L3')
  })

  it('drops to L1 on reduced motion', () => {
    expect(detectTier({ reducedMotion: true, webgl2: true, cores: 16 })).toBe('L1')
  })

  it('drops to L1 on two cores or less', () => {
    expect(detectTier({ cores: 2, webgl2: true })).toBe('L1')
    expect(detectTier({ cores: 1, webgl2: true })).toBe('L1')
    expect(detectTier({ cores: 3, webgl2: true })).toBe('L2')
  })

  it('drops to L1 on a saveData connection', () => {
    expect(detectTier({ saveData: true, webgl2: true, cores: 8 })).toBe('L1')
  })

  it('picks L3 only with WebGL2 and 4+ cores', () => {
    expect(detectTier({ webgl2: true, cores: 4 })).toBe('L3')
    expect(detectTier({ webgl2: true, cores: 12 })).toBe('L3')
    expect(detectTier({ webgl2: false, cores: 12 })).toBe('L2')
  })

  it('falls back to navigator.hardwareConcurrency when cores are unknown', () => {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 4 : 4
    expect(detectTier({ webgl2: true })).toBe(cores >= 4 ? 'L3' : 'L2')
  })

  it('is a pure function: same inputs, same tier, inputs untouched', () => {
    const inputs = { webgl2: true, cores: 8, reducedMotion: false, saveData: false }
    const snapshot = { ...inputs }
    const results = Array.from({ length: 5 }, () => detectTier(inputs))
    expect(new Set(results)).toEqual(new Set(['L3']))
    expect(inputs).toEqual(snapshot)
  })

  it('never upgrades past the locked tier (只降不升)', () => {
    const evidence: Record<string, string> = {}
    for (const locked of ['L0', 'L1', 'L2', 'L3'] as const) {
      evidence[locked] = detectTier({ locked, webgl2: true, cores: 64 })
    }
    expect(evidence).toEqual({ L0: 'L0', L1: 'L1', L2: 'L2', L3: 'L3' })
  })

  it('maps tiers to CSS variables', () => {
    expect(tierVar('L0')).toBe('--forge-tier-l0')
    expect(tierVar('L3')).toBe('--forge-tier-l3')
  })
})

/* ------------------------------- still 模式 ------------------------------ */

describe('isStillMode / currentTier', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })

  it('reads ?still=1 from the URL', () => {
    setSearch('?still=1&channel=replay&speed=0')
    expect(isStillMode()).toBe(true)
    setSearch('?still=0')
    expect(isStillMode()).toBe(false)
    setSearch('')
    expect(isStillMode()).toBe(false)
  })

  it('forces L0 through currentTier when still is on', () => {
    setSearch('?still=1')
    expect(currentTier()).toBe('L0')
  })

  it('honours the locked tier from the settings store', () => {
    setSearch('')
    useSettingsStore.setState({ forge: { ...useSettingsStore.getState().forge, tier: 'L1' } })
    expect(currentTier()).toBe('L1')
    useSettingsStore.setState({ forge: { ...useSettingsStore.getState().forge, tier: 'L0' } })
    expect(currentTier()).toBe('L0')
  })

  it('falls back to a real tier when nothing is locked or frozen', () => {
    setSearch('')
    expect(['L1', 'L2', 'L3']).toContain(currentTier())
  })
})

/* ---------------------------------- rAF --------------------------------- */

describe('raf · 单例调度器', () => {
  it('starts a loop on subscribe and stops on unsubscribe', () => {
    const request = vi.fn(() => 1)
    vi.stubGlobal('requestAnimationFrame', request)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const frame = vi.fn()
    const off = raf.subscribe(frame)
    expect(raf.count).toBe(1)
    expect(request).toHaveBeenCalledTimes(1)

    tickForTest(100, 16)
    expect(frame).toHaveBeenCalledTimes(1)

    off()
    expect(raf.count).toBe(0)
    tickForTest(200, 16)
    expect(frame).toHaveBeenCalledTimes(1)
  })

  it('feeds (now, delta) to every subscriber', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const seen: number[][] = []
    const offA = raf.subscribe((now, delta) => seen.push([now, delta]))
    const offB = raf.subscribe((now, delta) => seen.push([now, delta]))
    expect(raf.count).toBe(2)

    tickForTest(1_000, 16)
    expect(seen).toEqual([
      [1_000, 16],
      [1_000, 16],
    ])

    offA()
    offB()
    expect(raf.count).toBe(0)
  })

  it('drops every callback on stop()', () => {
    const cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 7))
    vi.stubGlobal('cancelAnimationFrame', cancel)

    const frame = vi.fn()
    raf.subscribe(frame)
    raf.stop()
    expect(raf.count).toBe(0)
    expect(cancel).toHaveBeenCalledWith(7)

    tickForTest(500, 16)
    expect(frame).not.toHaveBeenCalled()
    // stop 之后仍可重新订阅。
    raf.subscribe(frame)
    expect(raf.count).toBe(1)
  })

  it('exposes sampleFrames as a throttled unsubscribe', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const samples: number[] = []
    const off = sampleFrames((interval) => samples.push(interval))
    tickForTest(10, 16)
    tickForTest(26, 18)
    expect(samples).toEqual([16, 18])
    off()
    expect(raf.count).toBe(0)
  })

  it('tolerates unsubscribing twice', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const off = raf.subscribe(() => {})
    off()
    expect(() => off()).not.toThrow()
    expect(raf.count).toBe(0)
  })
})
