/**
 * panels.test.ts —— 面板模块的纯逻辑单测（插入几何、虚拟滚动、图层移动、命令表、检查兜底）。
 * 不渲染 React：面板里的交互都建立在这些纯函数上，先保证它们的边界正确。
 */
import { describe, expect, it, vi } from 'vitest'
import { SAFE_X, SAFE_Y, STAGE_H, STAGE_W } from '@/schema/deck'
import { emptyDeck, makeImage, makeShape, makeSlide, makeSvg, makeText } from '@/schema/factory'
import { centeredRect, rectForAspect } from '@/editor/panels/insertGeometry'
import { inVisibleRange, moveTargetIndex, moveWithin, visibleRange } from '@/editor/panels/virtual'
import { localLint } from '@/editor/panels/localLint'
import { normalizeIssues } from '@/editor/panels/lintBridge'
import {
  buildCommands,
  fuzzyScore,
  searchCommands,
  type CommandContext,
} from '@/editor/toolbar/commandRegistry'
import type { MessageKey } from '@/i18n'

describe('insertGeometry', () => {
  it('centers inside the stage', () => {
    expect(centeredRect(720, 160)).toEqual({ x: 440, y: 370, w: 720, h: 160 })
  })

  it('clamps oversized rects to the safe area', () => {
    const rect = centeredRect(STAGE_W * 2, STAGE_H * 2)
    expect(rect.w).toBe(STAGE_W - SAFE_X * 2)
    expect(rect.h).toBe(STAGE_H - SAFE_Y * 2)
    expect(rect.x).toBe(SAFE_X)
    expect(rect.y).toBe(SAFE_Y)
  })

  it('derives height from the asset aspect ratio', () => {
    const rect = rectForAspect(720, 9 / 16)
    expect(rect.w).toBe(720)
    expect(rect.h).toBe(405)
    expect(rect.x).toBe(Math.round((STAGE_W - 720) / 2))
  })

  it('falls back to 16:9 for broken aspect ratios', () => {
    expect(rectForAspect(720, Number.NaN).h).toBe(405)
  })
})

describe('virtual window', () => {
  it('returns an empty range for an empty list', () => {
    expect(visibleRange(0, 0, 100, 600)).toEqual({ start: 0, end: -1 })
  })

  it('covers the viewport plus overscan', () => {
    expect(visibleRange(30, 0, 100, 600, 2, 10)).toEqual({ start: 0, end: 8 })
  })

  it('follows the scroll offset', () => {
    expect(visibleRange(30, 1000, 100, 600, 2, 10)).toEqual({ start: 7, end: 18 })
  })

  it('checks membership inclusively', () => {
    const range = { start: 2, end: 4 }
    expect(inVisibleRange(1, range)).toBe(false)
    expect(inVisibleRange(2, range)).toBe(true)
    expect(inVisibleRange(4, range)).toBe(true)
    expect(inVisibleRange(5, range)).toBe(false)
  })
})

describe('moveWithin', () => {
  const list = ['a', 'b', 'c', 'd']

  it('converts an insertion slot to a target index', () => {
    expect(moveTargetIndex(0, 3)).toBe(2)
    expect(moveTargetIndex(2, 0)).toBe(0)
    expect(moveTargetIndex(1, 1)).toBe(1)
  })

  it('moves forward without dropping an element', () => {
    expect(moveWithin(list, 0, 3)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves backward', () => {
    expect(moveWithin(list, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('does not mutate the source array', () => {
    const copy = [...list]
    moveWithin(list, 0, 2)
    expect(list).toEqual(copy)
  })
})

describe('localLint', () => {
  it('reports an empty slide', () => {
    const deck = emptyDeck('Lint')
    deck.slides = [makeSlide({})]
    expect(localLint(deck).some((issue) => issue.code === 'emptySlide')).toBe(true)
  })

  it('reports out-of-stage blocks and missing alt text', () => {
    const escapee = makeShape({ kind: 'rect', x: -600, y: 40, w: 200, h: 120 })
    const image = makeImage({ assetId: 'asset-1', x: 200, y: 200, w: 400, h: 240 })
    const deck = emptyDeck('Lint')
    deck.slides = [makeSlide({ blocks: [escapee, image] })]
    const codes = localLint(deck).map((issue) => issue.code)
    expect(codes).toContain('offstage')
    expect(codes).toContain('missingAlt')
  })

  it('flags SVG with scripts and empty text blocks', () => {
    const svg = makeSvg({ source: '<svg><script>alert(1)</script></svg>', x: 200, y: 200, w: 400, h: 300 })
    const text = makeText({ text: '   ', x: 200, y: 600, w: 400, h: 120 })
    const deck = emptyDeck('Lint')
    deck.slides = [makeSlide({ blocks: [svg, text] })]
    const codes = localLint(deck).map((issue) => issue.code)
    expect(codes).toContain('svgUnsafe')
    expect(codes).toContain('emptyText')
  })
})

describe('normalizeIssues', () => {
  it('accepts an array', () => {
    const issues = normalizeIssues([{ code: 'overflow', severity: 'error', slideId: 's1' }])
    expect(issues).toEqual([{ code: 'overflow', severity: 'error', slideId: 's1', blockId: undefined, message: undefined }])
  })

  it('accepts an { issues } wrapper and defaults unknown severities', () => {
    const issues = normalizeIssues({ issues: [{ code: 42 }, null] })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ code: 'unknown', severity: 'warn' })
  })

  it('ignores junk', () => {
    expect(normalizeIssues(undefined)).toEqual([])
    expect(normalizeIssues('nope')).toEqual([])
  })
})

describe('command registry', () => {
  const ctx = createContext()
  const commands = buildCommands(ctx)

  it('ships at least fifteen commands with unique ids', () => {
    expect(commands.length).toBeGreaterThanOrEqual(15)
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length)
  })

  it('routes commands through the injected context', () => {
    const byId = (id: string) => commands.find((command) => command.id === id)
    byId('slide.new')?.run()
    byId('view.play')?.run()
    byId('deck.export')?.run()
    expect(ctx.addSlide).toHaveBeenCalledTimes(1)
    expect(ctx.setMode).toHaveBeenCalledWith('play')
    expect(ctx.openDialog).toHaveBeenCalledWith('export')
  })

  it('warns instead of deleting blocks when nothing is selected', () => {
    const emptyCtx = createContext({ selectedIds: [] })
    const deleteCommand = buildCommands(emptyCtx).find((command) => command.id === 'block.delete')
    deleteCommand?.run()
    expect(emptyCtx.deleteBlocks).not.toHaveBeenCalled()
    expect(emptyCtx.notify).toHaveBeenCalledTimes(1)
  })

  it('refuses to delete the last slide', () => {
    const single = createContext({ deck: emptyDeck('One') })
    const command = buildCommands(single).find((item) => item.id === 'slide.delete')
    command?.run()
    expect(single.deleteSlide).not.toHaveBeenCalled()
    expect(single.notify).toHaveBeenCalledTimes(1)
  })
})

describe('fuzzy search', () => {
  it('scores prefix matches higher than scattered subsequences', () => {
    expect(fuzzyScore('New slide', 'slide')).toBeGreaterThan(fuzzyScore('Select every slide', 'sld'))
    expect(fuzzyScore('anything', 'zzz')).toBe(0)
    expect(fuzzyScore('anything', '')).toBe(1)
  })

  it('matches localized titles and command ids', () => {
    const commands = buildCommands(createContext())
    const resolve = (command: { titleKey: MessageKey }) => titles[command.titleKey] ?? command.titleKey
    expect(searchCommands(commands, 'slide', resolve).length).toBeGreaterThan(0)
    const byId = searchCommands(commands, 'view.grid', resolve)
    expect(byId[0]?.command.id).toBe('view.grid')
    expect(searchCommands(commands, 'zzzzz', resolve)).toHaveLength(0)
  })

  it('returns everything for an empty query', () => {
    const commands = buildCommands(createContext())
    expect(searchCommands(commands, '   ', (command) => command.titleKey)).toHaveLength(commands.length)
  })
})

const titles: Partial<Record<MessageKey, string>> = {
  'editor.command.newSlide': 'New slide',
  'editor.command.duplicateSlide': 'Duplicate current slide',
  'editor.command.deleteSlide': 'Delete current slide',
  'editor.command.play': 'Present',
  'editor.command.export': 'Export…',
  'editor.command.settings': 'Open settings',
  'editor.palette.toggleGrid': 'Toggle grid',
  'editor.palette.selectAll': 'Select every element on this slide',
}

function createContext(overrides: Partial<CommandContext> = {}): CommandContext {
  const deck = overrides.deck ?? emptyDeck('Test deck')
  return {
    t: ((key: MessageKey) => titles[key] ?? String(key)) as CommandContext['t'],
    deck,
    slide: deck.slides[0] ?? null,
    selectedIds: ['block-1'],
    lang: 'en',
    openDialog: vi.fn(),
    addSlide: vi.fn(),
    duplicateSlide: vi.fn(),
    deleteSlide: vi.fn(),
    selectSlide: vi.fn(),
    duplicateBlocks: vi.fn(),
    deleteBlocks: vi.fn(),
    selectAllBlocks: vi.fn(),
    reorderBlocks: vi.fn(),
    insertText: vi.fn(),
    insertSvg: vi.fn(),
    insertThree: vi.fn(),
    setMode: vi.fn(),
    setRightMode: vi.fn(),
    setInspectorTab: vi.fn(),
    toggleGrid: vi.fn(),
    setLang: vi.fn(),
    cycleTheme: vi.fn(),
    rewrite: vi.fn(),
    notify: vi.fn(),
    ...overrides,
  }
}
