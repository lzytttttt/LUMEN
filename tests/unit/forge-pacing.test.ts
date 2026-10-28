import { describe, expect, it } from 'vitest'
import { NO_PACING, resolvePacing } from '@/forge/pacing'

/**
 * 演出节奏（mock 时间线的可测部分）。
 * 只看"该等多久"，不测浏览器定时器；ForgeApp 的队列由 e2e 的时序断言覆盖。
 */
describe('forge pacing', () => {
  it('still=1 与 replay&speed=0 不等待（截图 / e2e）', () => {
    expect(resolvePacing({ still: true, channel: 'mock', speed: 1 })).toEqual(NO_PACING)
    expect(resolvePacing({ still: false, channel: 'replay', speed: 0 })).toEqual(NO_PACING)
  })

  it('mock 档对齐 plan mock 的时间线：640 / 560 / 560 / 760', () => {
    const pacing = resolvePacing({ channel: 'mock' })
    expect(pacing.seedThinkMs).toBe(640)
    expect(pacing.slideMs).toBe(560)
    expect(pacing.gateHoldMs).toBe(560)
    expect(pacing.recastMs).toBe(760)
    expect(pacing.premiereHoldMs).toBeGreaterThanOrEqual(2000)
  })

  it('回放走录制节奏，只留短兜底；真端点比 mock 快一档', () => {
    const replay = resolvePacing({ channel: 'replay', speed: 1 })
    const openai = resolvePacing({ channel: 'openai' })
    expect(replay.slideMs).toBeLessThan(560)
    expect(replay.seedThinkMs).toBeLessThan(640)
    expect(openai.slideMs).toBeGreaterThan(0)
    expect(openai.slideMs).toBeLessThan(560)
  })

  it('九幕总时长落在 mock 的 5–6 秒区间（不含开演席）', () => {
    const pacing = resolvePacing({ channel: 'mock' })
    const total = 9 * pacing.slideMs + pacing.gateHoldMs
    expect(total).toBeGreaterThan(5000)
    expect(total).toBeLessThan(6200)
  })
})
