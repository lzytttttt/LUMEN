/**
 * export.test.ts —— 导出管线里"纯逻辑"部分的回归测试。
 *
 * 只测能在 jsdom 里稳定复现的部分（转义、骨架、打印路由、3D 换图、体积护栏）；
 * 真实渲染/下载/打印由 `scripts/_probe-export.mjs` 的浏览器闭环覆盖。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { createSampleDeck } from '@/sample/sample-deck'
import { makeThree } from '@/schema/factory'
import type { Deck, Slide } from '@/schema/deck'
import {
  STANDALONE_ABORT_BYTES,
  STANDALONE_WARN_BYTES,
  byteLength,
  checkStandaloneSize,
  composeStandaloneHtml,
  escapeJsonForScript,
  escapeScriptText,
  escapeStyleText,
  formatBytes,
  prepareStandaloneDeck,
  standaloneFileName,
} from '@/export/standalone'
import {
  buildPrintUrl,
  finishPrint,
  isPrintRequested,
  requestPrint,
  resetPrintRoute,
  subscribePrintRequest,
  takePrintJob,
  waitForPrintDone,
} from '@/export/printRoute'
import {
  CAPTURE_ID_PREFIX,
  POSTER_ASSET_PREFIX,
  swapSlideThreeBlocks,
  threeBlocksOf,
  threeToImageBlock,
  toCaptureSlide,
} from '@/export/threeFrames'

function sampleDeck(): Deck {
  return createSampleDeck('zh')
}

function slideWithThree(): { deck: Deck; slide: Slide; blockId: string } {
  const deck = sampleDeck()
  for (const slide of deck.slides) {
    const blocks = threeBlocksOf(slide)
    if (blocks.length > 0) return { deck, slide, blockId: blocks[0].id }
  }
  // 示例 deck 一定有 3D 幕（封面）；真没有就现场造一个，测试不依赖示例的具体写法。
  const block = makeThree({ x: 900, y: 110, w: 580, h: 680 })
  const slide: Slide = { ...deck.slides[0], blocks: [...deck.slides[0].blocks, block] }
  const patched: Deck = { ...deck, slides: [slide, ...deck.slides.slice(1)] }
  return { deck: patched, slide, blockId: block.id }
}

describe('standalone: 内联转义', () => {
  it('escapes </script> and unicode line separators in JSON', () => {
    const json = escapeJsonForScript({ text: '</script><script>alert(1)</script>', sep: '\u2028\u2029', amp: 'a&b' })
    expect(json).not.toContain('</script>')
    expect(json).not.toContain('<script>')
    expect(json).toContain('\\u003c')
    expect(json).toContain('\\u2028')
    expect(json).toContain('\\u2029')
    // 转义之后仍能被 JSON.parse 还原成原文
    expect(JSON.parse(json)).toEqual({
      text: '</script><script>alert(1)</script>',
      sep: '\u2028\u2029',
      amp: 'a&b',
    })
  })

  it('breaks </script and </style inside inline bodies', () => {
    expect(escapeScriptText('const a = "</script>"')).toBe('const a = "<\\/script>"')
    expect(escapeStyleText('.x{content:"</style>"}')).toBe('.x{content:"<\\/style>"}')
  })
})

describe('standalone: HTML 骨架', () => {
  const deck = sampleDeck()
  const html = composeStandaloneHtml({
    title: 'LUMEN 测试',
    deck,
    assets: { asset_a: 'data:image/png;base64,AAA' },
    playerJs: 'window.LumenPlayer={mount:function(){}};',
    playerCss: '.lumen-slide{background:#000}',
    themeCss: ':root{--d-bg:#0c0c0f}',
  })

  it('starts with a doctype and carries charset/viewport/title', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta charset="utf-8" />')
    expect(html).toContain('name="viewport"')
    expect(html).toContain('<title>LUMEN 测试</title>')
  })

  it('inlines player, theme and print css and never links out', () => {
    expect(html).toContain('id="lumen-player-css"')
    expect(html).toContain('id="lumen-theme"')
    expect(html).toContain('id="lumen-print-css"')
    expect(html).toContain('@page')
    expect(html).toContain('print-color-adjust')
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
    expect(html).not.toMatch(/@import/i)
  })

  it('embeds deck + assets as JSON payloads and mounts the player', () => {
    expect(html).toContain('id="lumen-deck"')
    expect(html).toContain('type="application/json"')
    expect(html).toContain('id="lumen-assets"')
    expect(html).toContain('LumenPlayer')
    expect(html).toContain('api.mount(')
    expect(html).toContain(`data-lumen-slides="${deck.slides.length}"`)

    const raw = html.split('id="lumen-deck">')[1].split('</script>')[0]
    const parsed = JSON.parse(raw) as Deck
    expect(parsed.slides.length).toBe(deck.slides.length)
    expect(parsed.title).toBe(deck.title)
  })

  it('mentions ?print=1 handling in the boot script', () => {
    expect(html).toContain('print=1')
    expect(html).toContain('#print')
  })

  it('carries a deny-by-default CSP and the source license notice', () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('Apache-2.0 + Commons Clause')
    expect(html).toContain('CC BY-NC 4.0')
  })

  it('keeps a hostile title from closing the inline script', () => {
    const hostile = composeStandaloneHtml({
      title: '</script><img src=x onerror=alert(1)>',
      deck,
      assets: {},
      playerJs: 'x',
      playerCss: 'y',
      themeCss: ':root{}',
    })
    expect(hostile).not.toContain('</script><img')
    expect(hostile).toContain('&lt;/script&gt;')
  })
})

describe('standalone: deck 副本与文件名', () => {
  it('strips speaker notes unless includeNotes is set', () => {
    const deck = sampleDeck()
    const stripped = prepareStandaloneDeck(deck)
    expect(stripped.slides.every((slide) => slide.notes === undefined)).toBe(true)
    // 原 deck 不能被改
    expect(deck.slides.some((slide) => slide.notes !== undefined)).toBe(true)

    const kept = prepareStandaloneDeck(deck, { includeNotes: true })
    expect(kept.slides.some((slide) => slide.notes !== undefined)).toBe(true)
  })

  it('builds a slugged file name and honours the override', () => {
    const deck = sampleDeck()
    expect(standaloneFileName(deck)).toBe(`${slugOf(deck.title)}.html`)
    expect(standaloneFileName(deck, { fileName: 'My Deck.html' })).toBe('my-deck.html')
  })
})

function slugOf(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'deck'
  )
}

describe('体积护栏与格式化', () => {
  it('formats bytes for humans', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('counts utf-8 bytes and keeps the guard thresholds sane', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('幕光')).toBe(6)
    expect(STANDALONE_WARN_BYTES).toBeLessThan(STANDALONE_ABORT_BYTES)
    expect(STANDALONE_ABORT_BYTES).toBe(24 * 1024 * 1024)
  })

  it('warns past 12MB and throws past 24MB', () => {
    expect(checkStandaloneSize(1024)).toEqual([])
    const warned = checkStandaloneSize(STANDALONE_WARN_BYTES + 1)
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('MB')
    expect(() => checkStandaloneSize(STANDALONE_ABORT_BYTES + 1)).toThrowError(/24\.0 MB/)
  })
})

describe('打印路由', () => {
  it('detects ?print=1 and #print', () => {
    expect(isPrintRequested('http://x/deck?print=1')).toBe(true)
    expect(isPrintRequested('/deck?print=1&x=2')).toBe(true)
    expect(isPrintRequested('#print')).toBe(true)
    expect(isPrintRequested('/deck')).toBe(false)
    expect(isPrintRequested('?print=0')).toBe(false)
  })

  it('builds a print url without dropping the path', () => {
    expect(buildPrintUrl('http://x/app/index.html?a=1#hash')).toBe('http://x/app/index.html?a=1&print=1')
  })

  it('queues requests, notifies listeners and resolves waiters', async () => {
    resetPrintRoute()
    let notified = 0
    const off = subscribePrintRequest(() => {
      notified += 1
    })
    const deck = sampleDeck()
    const done = waitForPrintDone(1000)
    requestPrint({ deck })
    expect(notified).toBe(1)
    const job = takePrintJob()
    expect(job?.deck?.title).toBe(deck.title)
    expect(takePrintJob()).toBeNull()
    finishPrint()
    await expect(done).resolves.toBeUndefined()
    off()
    resetPrintRoute()
  })
})

describe('3D 抓帧的 deck 改写', () => {
  it('prefixes block ids for capture so stage runtimes are not clobbered', () => {
    const { slide, blockId } = slideWithThree()
    const { slide: captureSlide, keyById } = toCaptureSlide(slide)
    expect(keyById[blockId]).toBe(`${CAPTURE_ID_PREFIX}${blockId}`)
    const captured = captureSlide.blocks.find((block) => block.id === keyById[blockId])
    expect(captured?.type).toBe('three')
    // 原 slide 不动
    expect(slide.blocks.some((block) => block.id === blockId)).toBe(true)
  })

  it('swaps a three block into an image block with the same geometry', () => {
    const { slide, blockId } = slideWithThree()
    const source = slide.blocks.find((block) => block.id === blockId)
    if (!source || source.type !== 'three') throw new Error('fixture is not a three block')

    const assetId = `${POSTER_ASSET_PREFIX}${blockId}`
    const swapped = swapSlideThreeBlocks(slide, { [blockId]: assetId }, 12)
    const next = swapped.blocks.find((block) => block.id === blockId)
    expect(next?.type).toBe('image')
    if (next?.type !== 'image') return
    expect(next.assetId).toBe(assetId)
    expect(next.radius).toBe(12)
    expect([next.x, next.y, next.w, next.h, next.z, next.rotation]).toEqual([
      source.x,
      source.y,
      source.w,
      source.h,
      source.z,
      source.rotation,
    ])
    // 未给帧的块保持 three，交给渲染层降级
    const untouched = swapSlideThreeBlocks(slide, {}, 12)
    expect(untouched.blocks.find((block) => block.id === blockId)?.type).toBe('three')
  })

  it('keeps rotation/opacity when building the poster image block', () => {
    const { slide, blockId } = slideWithThree()
    const source = slide.blocks.find((block) => block.id === blockId)
    if (!source || source.type !== 'three') throw new Error('fixture is not a three block')
    const rotated = { ...source, rotation: 12, opacity: 0.8, z: 9 }
    const block = threeToImageBlock(rotated, 'asset_x', 6)
    expect(block.rotation).toBe(12)
    expect(block.opacity).toBe(0.8)
    expect(block.z).toBe(9)
    expect(block.fit).toBe('cover')
  })
})

beforeEach(() => {
  resetPrintRoute()
})
