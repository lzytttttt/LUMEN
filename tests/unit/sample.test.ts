import { describe, expect, it } from 'vitest'
import { createSampleDeck } from '@/sample/sample-deck'
import { deckSchema } from '@/schema/deck'
import { parseDeck, parseDeckFile } from '@/schema/migrate'
import { STAGE_W, STAGE_H } from '@/schema/deck'

describe('sample deck', () => {
  it('parses against the schema for both languages', () => {
    for (const lang of ['zh', 'en'] as const) {
      const deck = createSampleDeck(lang)
      const result = deckSchema.safeParse(deck)
      expect(result.success, JSON.stringify(result.success ? [] : result.error.issues.slice(0, 3))).toBe(true)
      expect(deck.slides).toHaveLength(9)
      expect(deck.meta.origin).toBe('sample')
    }
  })

  it('keeps every block inside a sane bounding box', () => {
    const deck = createSampleDeck('zh')
    for (const [index, slide] of deck.slides.entries()) {
      for (const block of slide.blocks) {
        expect(block.w).toBeGreaterThan(0)
        expect(block.h).toBeGreaterThan(0)
        // 允许少量出血，但不允许整块跑到画布外
        expect(block.x, `slide ${index} x`).toBeGreaterThan(-(block.w - 40))
        expect(block.y, `slide ${index} y`).toBeGreaterThan(-(block.h - 40))
        expect(block.x).toBeLessThan(STAGE_W + 4)
        expect(block.y).toBeLessThan(STAGE_H + 4)
      }
    }
  })

  it('includes one SVG and one 3D slide (the product promise)', () => {
    const deck = createSampleDeck('en')
    const types = new Set(deck.slides.flatMap((s) => s.blocks.map((b) => b.type)))
    expect(types.has('svg')).toBe(true)
    expect(types.has('three')).toBe(true)
    expect(types.has('text')).toBe(true)
    expect(types.has('shape')).toBe(true)
  })

  it('gives every slide speaker notes and a transition', () => {
    for (const slide of createSampleDeck('zh').slides) {
      expect(slide.notes && slide.notes.length > 0).toBe(true)
      expect(slide.transition.kind).toBeTruthy()
    }
  })
})

describe('migrate', () => {
  it('rejects non-objects with readable issues', () => {
    const outcome = parseDeck('nope')
    expect(outcome.ok).toBe(false)
    expect(outcome.issues[0]).toContain('对象')
  })

  it('accepts a bare deck wrapped as a project file', () => {
    const deck = createSampleDeck('zh')
    const outcome = parseDeckFile(deck)
    expect(outcome.ok).toBe(true)
    expect(outcome.value?.deck.slides).toHaveLength(9)
  })

  it('fills defaults for a minimal legacy deck', () => {
    const deck = createSampleDeck('zh')
    const legacy = { ...deck, meta: undefined, themeId: undefined, schemaVersion: undefined }
    const outcome = parseDeck(legacy)
    expect(outcome.ok).toBe(true)
    expect(outcome.value?.themeId).toBe('noir')
    expect(outcome.value?.lang).toBe(deck.lang)
  })
})
