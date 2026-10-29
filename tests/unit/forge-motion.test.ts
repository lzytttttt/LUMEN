/**
 * forge-motion.test.ts —— 台面降级判定与 rAF 调度器（`src/forge/fx/`）。
 *
 * 依据：`plan/v0.2.0/00` §6.1（L0–L3 判定）、`02` §9.3、`07` §3.5 的 D-01…D-05。
 * 只验纯函数与单例调度器；DOM 观感交给 e2e。
 *
 * v0.2.5（`plan/v0.2.5/02` §6.1 FX-1…FX-7）追加：四档回落、`?still=1` 零动画、
 * 既有 DOM 钩子不变、Pulse 环的 progress → stroke-dashoffset 纯函数。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentTier, detectTier, isStillMode, tierVar } from '@/forge/fx/tier'
import { raf, sampleFrames, tickForTest } from '@/forge/fx/raf'
import {
  AMBIENT_RIP_GAIN,
  AMBIENT_SPEED_MAX,
  AMBIENT_SPEED_MIN,
  ambientCanvasCount,
  ambientSpeed,
  deriveProg,
  startAmbient,
} from '@/forge/fx/ambient'
import { SPARK_DENSITY, sparkCount } from '@/forge/stage/Gate'
import { PULSE_PROG_MAX, PULSE_RING_CIRC, PULSE_RING_R, pulseRingOffset, pulseRingProgress } from '@/forge/hud/Pulse'
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

/* ======================== v0.2.5 · FX-1…FX-7 ========================= */

function source(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), 'utf8')
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** 取某条选择器后面的声明块（只看第一条），用于断言"这条规则里确实写了 X"。 */
function ruleBody(css: string, selectorFragment: string): string {
  const at = css.indexOf(selectorFragment)
  if (at < 0) return ''
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  return open < 0 || close < 0 ? '' : css.slice(open + 1, close)
}

/** 去掉注释再找"假计时器"——注释里可以提 setTimeout，代码里不行。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/* ------------------------------ FX-4 粒子 ------------------------------ */

describe('FX-4 · 环境粒子随 prog 加速（1.0 → 2.2）', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })

  it('maps prog 0→7 onto ×1.0→×2.2, strictly increasing', () => {
    expect(ambientSpeed(0)).toBe(AMBIENT_SPEED_MIN)
    expect(ambientSpeed(7)).toBe(AMBIENT_SPEED_MAX)
    expect(AMBIENT_SPEED_MIN).toBe(1)
    expect(AMBIENT_SPEED_MAX).toBe(2.2)

    const samples = Array.from({ length: 15 }, (_, i) => ambientSpeed(i / 2))
    for (let i = 1; i < samples.length; i += 1) expect(samples[i]).toBeGreaterThan(samples[i - 1])
    // 装台窗口内的两个真实读数：cast（prog=2）与 seal（prog=6.4）。
    expect(ambientSpeed(2)).toBeCloseTo(1.343, 3)
    expect(ambientSpeed(6.4)).toBeCloseTo(2.097, 3)
  })

  it('clamps out-of-range and non-finite prog', () => {
    expect(ambientSpeed(-4)).toBe(AMBIENT_SPEED_MIN)
    expect(ambientSpeed(99)).toBe(AMBIENT_SPEED_MAX)
    expect(ambientSpeed(Number.NaN)).toBe(AMBIENT_SPEED_MIN)
  })

  it('deriveProg is the same scalar the reducer writes (no second progress source)', () => {
    // cast：phase='casting' 时 prog=2，stage='write'。
    expect(deriveProg('write', 0, 9)).toBe(2)
    expect(deriveProg('think', 0, 0)).toBe(0)
    // 幕落位：prog = max(STAGE_PROG, 2 + 3·done/total) —— 与 state.ts 的 slide:landed 同一条公式。
    expect(deriveProg('plan', 3, 9)).toBe(3)
    expect(deriveProg('check', 1, 9)).toBe(5)
    expect(deriveProg('write', 9, 9)).toBe(5)
    expect(deriveProg('seal', 9, 9)).toBe(6)
  })

  it('never builds particles below L3, and dispose stays idempotent', () => {
    const host = document.createElement('div')
    for (const tier of ['L0', 'L1', 'L2'] as const) {
      const handle = startAmbient({ tier, host })
      expect(handle.active).toBe(false)
      expect(ambientCanvasCount(host)).toBe(0)
      expect(() => handle.setProgress(6)).not.toThrow()
      expect(() => handle.rip()).not.toThrow()
      handle.dispose()
      expect(() => handle.dispose()).not.toThrow()
      expect(ambientCanvasCount(host)).toBe(0)
    }
  })

  it('exposes rip as a one-shot impulse (decayed by rAF delta, not a timer)', () => {
    const text = stripComments(source('src/forge/fx/ambient.ts'))
    expect(AMBIENT_RIP_GAIN).toBeGreaterThan(0)
    expect(text).toContain('ripEnergy')
    expect(text).not.toMatch(/setTimeout|setInterval/)
    // 速度与 rip 都在同一个 rAF 回调里读，保证"一条时间线"。
    expect(text).toContain('raf.subscribe')
  })
})

/* ------------------------------ FX-6 火花 ------------------------------ */

describe('FX-6 · 过检火花密度分级', () => {
  it('gives 12 / 6 / 3 / 0 sparks for L3 / L2 / L1 / L0', () => {
    expect(SPARK_DENSITY).toEqual({ L3: 12, L2: 6, L1: 3, L0: 0 })
    expect(sparkCount('L3')).toBe(12)
    expect(sparkCount('L2')).toBe(6)
    expect(sparkCount('L1')).toBe(3)
    expect(sparkCount('L0')).toBe(0)
  })

  it('drives the ray list from sparkCount instead of a hard-coded 8', () => {
    const gate = source('src/forge/stage/Gate.tsx')
    expect(gate).toContain('sparkCount(tier)')
    expect(gate).not.toContain('RAYS_L3')
    expect(gate).not.toContain('RAYS_L1')
    // 束数进 DOM 只有一处读数，e2e 可以直接数。
    expect(countOf(gate, 'data-forge-sparks')).toBe(1)
  })

  it('keeps both severity hooks (error / warn) untouched', () => {
    const gate = source('src/forge/stage/Gate.tsx')
    expect(countOf(gate, 'data-severity="error"')).toBe(1)
    expect(countOf(gate, 'data-severity="warn"')).toBe(1)
  })
})

/* ------------------------------ FX-3 环 ------------------------------ */

describe('FX-3 · Pulse 环形进度（prog → stroke-dashoffset）', () => {
  it('maps prog 0–7 onto a 0–1 ring fraction', () => {
    expect(PULSE_PROG_MAX).toBe(7)
    expect(pulseRingProgress(0)).toBe(0)
    expect(pulseRingProgress(3.5)).toBe(0.5)
    expect(pulseRingProgress(7)).toBe(1)
    expect(pulseRingProgress(-2)).toBe(0)
    expect(pulseRingProgress(12)).toBe(1)
    expect(pulseRingProgress(Number.NaN)).toBe(0)
  })

  it('turns the fraction into stroke-dashoffset (empty ring = full circumference)', () => {
    expect(pulseRingOffset(0)).toBeCloseTo(PULSE_RING_CIRC, 3)
    expect(pulseRingOffset(7)).toBe(0)
    expect(pulseRingOffset(3.5)).toBeCloseTo(PULSE_RING_CIRC / 2, 3)
    expect(pulseRingOffset(2, 100)).toBeCloseTo(100 * (1 - 2 / 7), 3)
    // 单调递减：prog 越大，缺口越小（环越满）。
    const samples = Array.from({ length: 15 }, (_, i) => pulseRingOffset(i / 2))
    for (let i = 1; i < samples.length; i += 1) expect(samples[i]).toBeLessThan(samples[i - 1])
    expect(PULSE_RING_CIRC).toBeCloseTo(2 * Math.PI * PULSE_RING_R, 6)
  })

  it('keeps the PulseProps contract frozen at 5 keys', () => {
    const ui = source('src/forge/ui.ts')
    const body = ui.slice(ui.indexOf('export interface PulseProps'), ui.indexOf('}', ui.indexOf('export interface PulseProps')))
    const keys = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[a-zA-Z]+\??:/.test(line))
      .map((line) => line.split(':')[0].replace('?', ''))
    expect(keys).toEqual(['prog', 'stage', 'bad', 'tier', 'label'])
  })

  it('renders the ring only where the table allows it (ring L3/L2, linear L1/L0)', () => {
    const css = source('src/forge/forge.css')
    const pulse = source('src/forge/hud/Pulse.tsx')
    expect(pulse).toContain('strokeDashoffset=')
    expect(pulse).toContain('data-forge-pulse-ring')
    expect(pulse).toContain('data-forge-pulse-linear')
    expect(css).toContain(".forge[data-forge-tier='L3'] .forge-pulse__ring")
    expect(css).toContain(".forge[data-forge-tier='L1'] .forge-pulse__linear")
    expect(css).toContain(".forge[data-forge-tier='L0'] .forge-pulse__linear")
    // bad 转警示色：环与线性条各一条。
    expect(countOf(css, ".forge-pulse[data-bad='1'] .forge-pulse__ring-arc")).toBe(1)
    expect(countOf(css, ".forge-pulse[data-bad='1'] .forge-pulse__linear > i")).toBe(1)
  })
})

/* --------------------- FX-1 / FX-2 / FX-5 / FX-7 · 回落 --------------- */

describe('v0.2.5 · 四档回落与 still 零动画', () => {
  it('kills every animation at L0 and in still mode', () => {
    const css = source('src/forge/forge.css')
    const block = css.slice(css.indexOf(".forge[data-forge-tier='L0'] *,"), css.indexOf('}', css.indexOf(".forge[data-forge-tier='L0'] *,")))
    expect(block).toContain(".forge[data-forge-still='1'] *::after")
    expect(block).toContain('animation: none !important')
    expect(block).toContain('transition: none !important')
  })

  it('hides the two one-shot effects at L0 / still', () => {
    const css = source('src/forge/forge.css')
    for (const selector of [
      ".forge[data-forge-tier='L0'] .forge-stage__shock",
      ".forge[data-forge-tier='L0'] .forge-premiere__card::after",
      ".forge[data-forge-still='1'] .forge-stage__shock",
      ".forge[data-forge-still='1'] .forge-premiere__card::after",
    ]) {
      expect(ruleBody(css, selector), selector).toContain('display: none')
    }
  })

  it('gives FX-1 a 520ms shock on L3/L2, a 120ms fade on L1 and nothing at L0', () => {
    const css = source('src/forge/forge.css')
    expect(css).toContain('--fx-ring: 520ms')
    expect(css).toContain('--fx-ring-fade: 120ms')
    expect(ruleBody(css, '.forge-stage__shock {')).toContain('animation: forge-shock var(--fx-ring)')
    expect(ruleBody(css, ".forge[data-forge-tier='L1'] .forge-stage__shock {")).toContain(
      'forge-shock-fade var(--fx-ring-fade)',
    )
    // L3 才有外环；L1 没有。
    expect(ruleBody(css, ".forge[data-forge-tier='L1'] .forge-stage__shock::before")).toContain('display: none')
    // L3 有模糊与柔光，L2 同形态但两者都关（04 §1.3 的"模糊只在高档"）。
    expect(ruleBody(css, ".forge[data-forge-tier='L3'] .forge-stage__shock {")).toContain('blur(0.6px)')
    expect(ruleBody(css, ".forge[data-forge-tier='L2'] .forge-stage__shock {")).toContain('filter: none')
  })

  it('gives FX-2 depth a Z step only on L3, dimming only on L2, nothing on L1/L0', () => {
    const css = source('src/forge/forge.css')
    expect(css).toContain('--fx-depth-z: 18px')
    expect(ruleBody(css, ".forge[data-forge-tier='L3'] .forge-assemble__thumb {")).toContain(
      'translateZ(calc(var(--forge-depth, 0) * var(--fx-depth-z) * -1))',
    )
    expect(ruleBody(css, ".forge[data-forge-tier='L2'] .forge-assemble__thumb {")).not.toContain('translateZ')
    const none = css.slice(
      css.indexOf(".forge[data-forge-tier='L2'] .forge-assemble__thumb,\n.forge[data-forge-tier='L1']"),
    )
    expect(none.slice(0, none.indexOf('}'))).toContain('transform: none')
    // 纵深只在 L3 建；L1/L0 也不该有 transform。
    expect(countOf(css, 'translateZ(calc(var(--forge-depth')).toBe(1)
  })

  it('gives FX-5 a 40ms stagger and no sweep on L1 / L0 / still', () => {
    const css = source('src/forge/forge.css')
    expect(css).toContain('--fx-card-stagger: 40ms')
    expect(css).toContain('animation-delay: calc(var(--i, 0) * var(--fx-card-stagger))')
    expect(ruleBody(css, '.forge-premiere__card::after {')).toContain('forge-card-sweep')
    // `--i` 由结构位置给出（纯 CSS，不新增节点）。
    expect(countOf(css, '.forge-premiere__card:nth-child(')).toBe(20)
    for (const selector of [
      ".forge[data-forge-tier='L1'] .forge-premiere__card::after",
      ".forge[data-forge-tier='L0'] .forge-premiere__card::after",
      ".forge[data-forge-still='1'] .forge-premiere__card::after",
    ]) {
      expect(ruleBody(css, selector), selector).toContain('display: none')
    }
  })

  it('gives FX-7 a 620ms arc close on L3 and a 320ms opacity close on L2/L1', () => {
    const css = source('src/forge/forge.css')
    expect(css).toContain('--fx-close: 620ms')
    expect(ruleBody(css, "[data-forge-tier='L3'] .forge-premiere__arc,")).toContain(
      'forge-arc-close var(--fx-close)',
    )
    expect(css).toContain(".forge[data-forge='premiere'][data-forge-tier='L2'] .forge-premiere__arc")
    expect(css).toContain(".forge[data-forge='premiere'][data-forge-tier='L1'] .forge-premiere__arc")
    expect(countOf(css, 'forge-premiere-fade var(--fx-t3)')).toBe(1)
  })

  it('folds the reduced-motion media query down to the L1 column', () => {
    const css = source('src/forge/forge.css')
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('forge-shock-fade !important')
    expect(reduced).toContain('.forge-premiere__card::after')
    expect(reduced).toContain('forge-premiere-fade !important')
    expect(reduced).toContain('transform: none !important')
  })
})

describe('v0.2.5 · DOM 钩子与文字预算不变', () => {
  it('keeps slot / severity / tier-chip hooks exactly as frozen', () => {
    const assemble = source('src/forge/stage/Assemble.tsx')
    expect(countOf(assemble, 'data-forge-slot')).toBe(4)
    expect(countOf(assemble, 'data-slot-filled')).toBe(4)
    // 文字块不增：仍是「+N」与 ghost 标题两处。
    expect(countOf(assemble, 'data-forge-text')).toBe(2)

    const hud = source('src/forge/hud/Hud.tsx')
    expect(countOf(hud, 'data-forge-tier-chip')).toBe(1)
  })

  it('drives FX-1 from `done` (slide:landed) and writes FX-2 depth as a CSS read-out', () => {
    const assemble = source('src/forge/stage/Assemble.tsx')
    expect(assemble).toContain('data-forge-shock={done}')
    expect(assemble).toContain('key={`shock-${done}-${active')
    expect(assemble).toContain("['--forge-depth' as string]: depth")
    expect(assemble).toContain('data-forge-depth={done}')
    // FX-4 的两条读数：速度随 prog、落位 rip 只认 done 自增。
    expect(assemble).toContain('ambientHandle.current?.setProgress(prog)')
    expect(assemble).toContain('if (done > prevDone.current) ambientHandle.current?.rip()')
  })

  it('adds no timers to any fx path (no fake progress)', () => {
    for (const file of [
      'src/forge/stage/Assemble.tsx',
      'src/forge/stage/Gate.tsx',
      'src/forge/hud/Pulse.tsx',
      'src/forge/fx/ambient.ts',
    ]) {
      const text = stripComments(source(file))
      expect(text, file).not.toMatch(/\bsetTimeout\b|\bsetInterval\b/)
    }
  })
})
