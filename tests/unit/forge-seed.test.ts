import { describe, expect, it } from 'vitest'
import { seedFontOf } from '@/forge/stage/Seed'

/** 输入行可用宽度（与 Seed.tsx 的 LINE_WIDTH 同尺）。 */
const LINE_WIDTH = 900

function estimatedWidth(text: string, size: number): number {
  let units = 0
  for (const char of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) units += 1
    else if (/\s/.test(char)) units += 0.32
    else units += 0.58
  }
  return units * size
}

describe('v0.3.0 · 起念屏大字自适应', () => {
  it('keeps short prompts at the 64px ceiling', () => {
    expect(seedFontOf('')).toBe(64)
    expect(seedFontOf('为什么演示要换载体')).toBe(64)
    expect(seedFontOf('Why deck as HTML')).toBeLessThanOrEqual(64)
  })

  it('fits long mixed Chinese/Latin prompts inside the 900px line', () => {
    const prompts = [
      '为什么下一季度的复盘，要从 PPT 换成 HTML 演示',
      '把季度复盘，讲成下一季度的行动（含 3 个数字）',
    ]
    for (const prompt of prompts) {
      const size = seedFontOf(prompt)
      expect(size).toBeGreaterThanOrEqual(36)
      expect(estimatedWidth(prompt, size), prompt).toBeLessThanOrEqual(LINE_WIDTH)
    }
  })

  it('clamps at 36px instead of collapsing for very long input', () => {
    const long = '把这一次季度复盘，讲成下一季度可以直接执行的三条行动，每条都带负责人、日期和验收标准'
    expect(seedFontOf(long)).toBe(36)
  })

  it('never grows when the prompt gets longer', () => {
    const base = '为什么下一季度的复盘'
    let previous = seedFontOf(base)
    for (let index = 1; index <= 12; index += 1) {
      const next = seedFontOf(`${base}，还要再补 ${index} 句说明`)
      expect(next).toBeLessThanOrEqual(previous)
      previous = next
    }
  })
})
