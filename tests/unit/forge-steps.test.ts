import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { FORGE_STEPS, stepIndex, stepState, stepStates } from '@/forge/steps'

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8')

describe('v0.3.0 · 造幕台五段流程线', () => {
  it('maps every forge mark onto the five user-visible stages', () => {
    expect(stepIndex('seed')).toBe(0)
    expect(stepIndex('deal')).toBe(1)
    expect(stepIndex('cast')).toBe(2)
    expect(stepIndex('assemble')).toBe(2)
    expect(stepIndex('gate')).toBe(3)
    expect(stepIndex('premiere')).toBe(4)
  })

  it('marks walked / current / upcoming without ever going backwards', () => {
    expect(stepStates('seed')).toEqual(['on', 'todo', 'todo', 'todo', 'todo'])
    expect(stepStates('deal')).toEqual(['done', 'on', 'todo', 'todo', 'todo'])
    expect(stepStates('assemble')).toEqual(['done', 'done', 'on', 'todo', 'todo'])
    expect(stepStates('gate')).toEqual(['done', 'done', 'done', 'on', 'todo'])
    expect(stepStates('premiere')).toEqual(['done', 'done', 'done', 'done', 'on'])
  })

  it('keeps exactly one current stage and the rest monotonic', () => {
    for (const step of FORGE_STEPS) {
      const states = stepStates(step)
      expect(states.filter((state) => state === 'on')).toHaveLength(1)
      const current = states.indexOf('on')
      expect(states.slice(0, current).every((state) => state === 'done')).toBe(true)
      expect(states.slice(current + 1).every((state) => state === 'todo')).toBe(true)
    }
  })

  it('wires the read-out into the HUD without adding a second navigation', () => {
    const hud = read('src/forge/hud/Hud.tsx')
    expect(hud).toContain('stepStates(mark)')
    expect(hud).toContain('data-forge-step')
    expect(hud).toContain('data-state')
    // 只读：流程线里没有按钮 / 点击处理。
    const stepsBlock = hud.slice(hud.indexOf('forge-hud__steps'), hud.indexOf('</ol>'))
    expect(stepsBlock).not.toContain('<button')
    expect(stepsBlock).not.toContain('onClick')
    // 既有唯一钩子保留（forge-motion 测试冻结了它）。
    expect((hud.match(/data-forge-tier-chip/g) ?? []).length).toBe(1)
  })

  it('ships all five labels in both languages with parity', () => {
    const zh = read('src/i18n/messages/forge.zh.ts')
    const en = read('src/i18n/messages/forge.en.ts')
    for (const step of FORGE_STEPS) {
      expect(zh).toContain(`${step}: `)
      expect(en).toContain(`${step}: `)
    }
  })
})
