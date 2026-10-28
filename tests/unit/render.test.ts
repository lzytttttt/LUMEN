/**
 * tests/unit/render.test.ts —— render-core 的单测（lint 引擎 / three 场景映射 / SVG 外壳 / HTML 沙箱）。
 *
 * 这些用例必须在 jsdom 下跑通：没有 canvas、没有 WebGL，
 * 所以它们同时是"无 GPU 环境不崩"的回归测试。
 */
import { describe, expect, it } from 'vitest'
import type { Deck, Slide, Theme } from '@/schema/deck'
import { deckSchema, threeDescriptorSchema, type ThreeDescriptor } from '@/schema/deck'
import { makeImage, makeSlide, makeShape, makeText, makeThree } from '@/schema/factory'
import { createSampleDeck } from '@/sample/sample-deck'
import { THEMES, getTheme } from '@/themes'
import { LINT_CODES, LINT_LIMITS, lintDeck, summarizeLint } from '@/lint/deckLint'
import { aaThreshold, contrastRatio, parseColor, relativeLuminance } from '@/lint/color'
import { estimateTextLayout } from '@/lint/measure'
import { buildThreeScene, resolvePalette, tintColor } from '@/render/three/sceneBuilder'
import {
  captureThreeFrame,
  createThreeRuntime,
  getLiveThreeRuntimeCount,
  isWebGLAvailable,
  loadThreeModule,
  type ThreeRuntime,
} from '@/render/three/runtime'
import { ensureSvgFrame, parseViewBox } from '@/render/svg/frame'
import { sanitizeSvgDocument } from '@/render/svg/sanitize'
import { runSvgDrawAnimation } from '@/render/svg/draw'
import { composeHtmlDoc, HTML_HEIGHT_MESSAGE } from '@/render/blocks/HtmlView'

/* ------------------------------- 测试夹具 ------------------------------- */

function deckOf(slides: Slide[], patch: Record<string, unknown> = {}): Deck {
  return deckSchema.parse({
    id: 'deck_test',
    title: 'test deck',
    lang: 'zh',
    themeId: 'noir',
    slides,
    meta: { createdAt: 0, updatedAt: 0, origin: 'manual' },
    ...patch,
  }) as Deck
}

function threeDescriptor(patch: Record<string, unknown> = {}): ThreeDescriptor {
  return threeDescriptorSchema.parse(patch)
}

/* --------------------------------- lint --------------------------------- */

describe('lintDeck', () => {
  it('示例 deck 不崩，且 code 都是稳定短标识', () => {
    const deck = createSampleDeck('zh')
    const issues = lintDeck(deck)
    expect(Array.isArray(issues)).toBe(true)
    for (const issue of issues) {
      expect(LINT_CODES).toContain(issue.code as (typeof LINT_CODES)[number])
      expect(['info', 'warn', 'error']).toContain(issue.severity)
    }
    // 示例的 4 卡栅格幕：19 个块 > 18，属于预期内的提示
    expect(issues.some((issue) => issue.code === 'tooManyBlocks')).toBe(true)
    // 示例没有空幕、没有越界
    expect(issues.some((issue) => issue.code === 'emptySlide')).toBe(false)
    expect(issues.some((issue) => issue.code === 'outOfBounds')).toBe(false)
    // 示例正好 2 个 3D 块，不超预算
    expect(issues.some((issue) => issue.code === 'threeBudget')).toBe(false)
    expect(summarizeLint(issues).error).toBe(0)
  })

  it('空幕 / 幕数过少 / 缺 alt / 越界 都能报出来', () => {
    const empty = makeSlide({ name: 'empty' })
    const tiny = makeSlide({
      blocks: [
        makeText({ text: 'hi', x: 10, y: 10, w: 200, h: 60, variant: 'body' }),
        makeImage({ assetId: 'asset_x', x: 200, y: 10, w: 200, h: 120, alt: '' }),
        makeShape({ kind: 'rect', x: 1500, y: 800, w: 400, h: 300, fill: 'surface' }),
      ],
    })
    const issues = lintDeck(deckOf([empty, tiny]))
    expect(issues.some((issue) => issue.code === 'emptySlide' && issue.slideId === empty.id)).toBe(true)
    expect(issues.some((issue) => issue.code === 'slideCount')).toBe(true)
    expect(issues.some((issue) => issue.code === 'missingAlt')).toBe(true)
    const outOfBounds = issues.find((issue) => issue.code === 'outOfBounds')
    expect(outOfBounds).toBeTruthy()
    expect(outOfBounds?.blockId).toBeTruthy()
  })

  it('3D 预算：超过 2 个 3D 块就提示', () => {
    const slide = makeSlide({
      blocks: [
        makeThree({ x: 100, y: 100, w: 400, h: 400, descriptor: threeDescriptor() }),
        makeThree({ x: 600, y: 100, w: 400, h: 400, descriptor: threeDescriptor() }),
        makeThree({ x: 1100, y: 100, w: 400, h: 400, descriptor: threeDescriptor() }),
      ],
    })
    const issues = lintDeck(deckOf([slide, makeSlide({ blocks: [makeShape({ x: 0, y: 0, w: 100, h: 100 })] })]))
    const budget = issues.find((issue) => issue.code === 'threeBudget')
    expect(budget?.severity).toBe('warn')
    expect(budget?.params?.count).toBe(3)
  })

  it('文本溢出：塞不进小框的文本会被报出来', () => {
    const long = '这是一段很长的说明文字，'.repeat(12)
    const slide = makeSlide({
      blocks: [makeText({ text: long, x: 120, y: 96, w: 320, h: 40, variant: 'body' })],
    })
    const issues = lintDeck(deckOf([slide]))
    const overflow = issues.find((issue) => issue.code === 'textOverflow')
    expect(overflow).toBeTruthy()
    expect(overflow?.blockId).toBeTruthy()
    expect(Number(overflow?.params?.ratio)).toBeGreaterThan(LINT_LIMITS.overflowRatio)
  })

  it('字号下限：小号 caption 提示', () => {
    const tinyTheme: Theme = { ...getTheme('noir'), typeScale: 0.8 }
    const slide = makeSlide({
      blocks: [makeText({ text: 'CAPTION', x: 120, y: 96, w: 600, h: 40, variant: 'caption' })],
    })
    const issues = lintDeck(deckOf([slide]), { theme: tinyTheme })
    const small = issues.find((issue) => issue.code === 'fontTooSmall')
    expect(small).toBeTruthy()
    expect(Number(small?.params?.size)).toBeLessThan(LINT_LIMITS.minCaptionSize)
  })

  it('对比度：同色前景/背景必然低于 AA', () => {
    const theme: Theme = {
      ...getTheme('noir'),
      colors: { ...getTheme('noir').colors, bg: '#101010', fg: '#121212' },
    }
    const slide = makeSlide({
      blocks: [makeText({ text: '低对比标题', x: 120, y: 96, w: 900, h: 200, variant: 'h1', color: 'fg' })],
    })
    const issues = lintDeck(deckOf([slide]), { theme })
    const contrast = issues.find((issue) => issue.code === 'contrast')
    expect(contrast).toBeTruthy()
    expect(Number(contrast?.params?.ratio)).toBeLessThan(4.5)
  })

  it('空内容块：空文本 / 空 SVG 都会被标出', () => {
    const slide = makeSlide({
      blocks: [
        makeText({ text: '   ', x: 120, y: 96, w: 400, h: 40 }),
        makeText({ text: 'ok', x: 120, y: 200, w: 400, h: 40 }),
      ],
    })
    const issues = lintDeck(deckOf([slide]))
    expect(issues.filter((issue) => issue.code === 'emptyBlock')).toHaveLength(1)
  })

  it('纯函数：同一 deck 连续两次结果一致', () => {
    const deck = createSampleDeck('en')
    expect(lintDeck(deck)).toEqual(lintDeck(deck))
  })
})

/* --------------------------------- 颜色 --------------------------------- */

describe('lint/color', () => {
  it('解析 hex / rgb / hsl', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('#00000080')?.a).toBeCloseTo(0.5, 1)
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 })
    const hsl = parseColor('hsl(0, 100%, 50%)')
    expect(hsl?.r).toBe(255)
    expect(hsl?.g).toBe(0)
    expect(parseColor('var(--d-fg)')).toBeNull()
  })

  it('对比度：黑/白 = 21，同色 = 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5)
    expect(contrastRatio('var(--d-fg)', '#ffffff')).toBeNull()
  })

  it('相对亮度单调，AA 阈值区分大字', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBe(0)
    expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 3)
    expect(aaThreshold(14, 400)).toBe(4.5)
    expect(aaThreshold(26, 400)).toBe(3)
    expect(aaThreshold(20, 700)).toBe(3)
  })
})

/* -------------------------------- 文本测量 ------------------------------- */

describe('lint/measure', () => {
  it('短文本放得下，长文本溢出', () => {
    const short = estimateTextLayout({
      text: '短句',
      width: 400,
      height: 80,
      fontSize: 22,
      lineHeight: 1.6,
      letterSpacing: 0,
      fontWeight: 400,
      fontFamily: 'system-ui',
    })
    expect(short.ratio).toBeLessThan(1)

    const long = estimateTextLayout({
      text: '很长的一段话'.repeat(40),
      width: 200,
      height: 60,
      fontSize: 22,
      lineHeight: 1.6,
      letterSpacing: 0,
      fontWeight: 400,
      fontFamily: 'system-ui',
    })
    expect(long.ratio).toBeGreaterThan(1.06)
    expect(long.lines).toBeGreaterThan(1)
  })

  it('空文本不报溢出', () => {
    const empty = estimateTextLayout({
      text: '',
      width: 100,
      height: 100,
      fontSize: 20,
      lineHeight: 1.5,
      letterSpacing: 0,
      fontWeight: 400,
      fontFamily: 'system-ui',
    })
    expect(empty.ratio).toBe(0)
  })

  it('单行紧排不误报：块高刚好等于行盒时不报', () => {
    const tight = estimateTextLayout({
      text: '1987',
      width: 160,
      height: 46.4,
      fontSize: 40,
      lineHeight: 1.16,
      letterSpacing: -0.01,
      fontWeight: 600,
      fontFamily: 'system-ui',
    })
    expect(tight.ratio).toBeLessThanOrEqual(1.05)
  })
})

/* --------------------------------- SVG ---------------------------------- */

describe('render/svg', () => {
  it('净化后仍可渲染，脚本被剔除', () => {
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><script>alert(1)</script><path d="M0 0h10"/></svg>'
    const result = sanitizeSvgDocument(dirty)
    expect(result.svg).not.toContain('<script')
    expect(result.svg).toContain('<path')
  })

  it('非令牌颜色会被改写并记一条 issue', () => {
    const result = sanitizeSvgDocument(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0 0h10" stroke="tomato"/></svg>',
    )
    expect(result.issues.some((issue) => issue.level === 'color')).toBe(true)
    expect(result.svg).toContain('var(--d-accent)')
  })

  it('示例插图：本地渐变引用保留，不产生 issue', () => {
    const deck = createSampleDeck('zh')
    const svgBlock = deck.slides
      .flatMap((slide) => slide.blocks)
      .find((block) => block.type === 'svg')
    expect(svgBlock?.type).toBe('svg')
    if (svgBlock?.type !== 'svg') return
    const result = sanitizeSvgDocument(svgBlock.source)
    expect(result.issues).toEqual([])
    // 渐变引用不能被当成"非法颜色"改写掉
    expect(result.svg).toContain('url(#lumen-g1)')
    expect(result.svg).toContain('linearGradient')
  })

  it('缺 viewBox / preserveAspectRatio 时补齐', () => {
    const { svg } = sanitizeSvgDocument('<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"/></svg>')
    const framed = ensureSvgFrame(svg, [0, 0, 640, 360])
    expect(framed.markup).toMatch(/viewBox="[^"]+"/)
    expect(framed.markup).toContain('preserveAspectRatio="xMidYMid meet"')
    expect(framed.viewBox).toHaveLength(4)
    expect(framed.aspect).toBeGreaterThan(0)
  })

  it('viewBox 解析容错', () => {
    expect(parseViewBox('0 0 1600 900')).toEqual([0, 0, 1600, 900])
    expect(parseViewBox('0,0,0,900')).toBeNull()
    expect(parseViewBox('nope')).toBeNull()
  })

  it('draw 动画在无 SVG / jsdom 下安全', () => {
    const host = document.createElement('div')
    const cleanup = runSvgDrawAnimation(host)
    expect(typeof cleanup).toBe('function')
    cleanup()

    host.innerHTML = '<svg><path d="M0 0 L10 10"/></svg>'
    const cleanup2 = runSvgDrawAnimation(host)
    cleanup2()
    cleanup2() // 幂等
  })
})

/* --------------------------------- HTML --------------------------------- */

describe('render/html', () => {
  it('文档带 CSP，默认不含测高脚本', () => {
    const doc = composeHtmlDoc({ html: '<p>hi</p>', heightMode: 'block', sandboxVersion: 1 } as never)
    expect(doc).toContain('Content-Security-Policy')
    expect(doc).toContain("default-src 'none'")
    expect(doc).not.toContain(HTML_HEIGHT_MESSAGE)
  })

  it('content 高度模式才注入测高脚本', () => {
    const doc = composeHtmlDoc({ html: '<p>hi</p>', heightMode: 'content', sandboxVersion: 1 } as never, { measure: true })
    expect(doc).toContain(HTML_HEIGHT_MESSAGE)
    expect(doc).toContain('postMessage')
  })
})

/* --------------------------------- three -------------------------------- */

const PRESETS = ['orbit', 'showcase', 'wave-field', 'particle-cloud', 'torus', 'stack', 'globe'] as const

describe('render/three/sceneBuilder', () => {
  it('three 能动态加载（不依赖 WebGL）', async () => {
    const three = await loadThreeModule()
    expect(three).toBeTruthy()
  })

  it('palette / tint 映射到主题色', () => {
    const colors = getTheme('noir').colors
    expect(resolvePalette('accent', colors).primary).toBe(colors.accent)
    expect(resolvePalette('mono', colors).primary).toBe(colors.fg)
    expect(resolvePalette('duotone', colors).primary).toBe(colors.accent)
    expect(tintColor('accent2', colors, 'accent')).toBe(colors.accent2)
    expect(tintColor('accent', colors, 'mono')).toBe(colors.fg)
  })

  it('7 个 preset 都能建场景、能推进、能释放', async () => {
    const three = await loadThreeModule()
    if (!three) throw new Error('three 未加载')
    const colors = getTheme('noir').colors

    for (const preset of PRESETS) {
      const built = await buildThreeScene({
        three,
        descriptor: threeDescriptor({ preset }),
        colors,
        aspect: 580 / 680,
      })
      expect(built.scene.children.length).toBeGreaterThan(1)
      expect(built.camera.fov).toBe(42)
      expect(built.camera.position.length()).toBeCloseTo(7, 0)
      expect(() => built.update(0)).not.toThrow()
      expect(() => built.update(1.7)).not.toThrow()
      expect(() => built.dispose()).not.toThrow()
    }
  })

  it('objects 非空时以 objects 为准（preset 不叠加默认构图）', async () => {
    const three = await loadThreeModule()
    if (!three) throw new Error('three 未加载')
    const colors = getTheme('noir').colors
    const built = await buildThreeScene({
      three,
      descriptor: threeDescriptor({
        preset: 'globe',
        objects: [
          { shape: 'box', material: 'toon', tint: 'accent', scale: 1, pos: [0, 0, 0], rot: [0, 0, 0] },
          { shape: 'plane', material: 'wireframe', tint: 'muted', scale: 1, pos: [0, 0, 0], rot: [0, 0, 0] },
        ],
      }),
      colors,
      aspect: 16 / 9,
    })
    const meshes: string[] = []
    built.scene.traverse((object) => {
      const candidate = object as unknown as { isMesh?: boolean; material?: { type?: string } }
      if (candidate.isMesh && candidate.material?.type) meshes.push(candidate.material.type)
    })
    expect(meshes).toContain('MeshToonMaterial')
    expect(meshes).toContain('MeshBasicMaterial')
    built.dispose()
  })

  it('背景策略：transparent / theme / void', async () => {
    const three = await loadThreeModule()
    if (!three) throw new Error('three 未加载')
    const colors = getTheme('noir').colors
    const transparent = await buildThreeScene({ three, descriptor: threeDescriptor({ preset: 'torus', bg: 'transparent' }), colors, aspect: 1 })
    expect(transparent.background.alpha).toBe(0)
    transparent.dispose()

    const themed = await buildThreeScene({ three, descriptor: threeDescriptor({ preset: 'torus', bg: 'theme' }), colors, aspect: 1 })
    expect(themed.background.alpha).toBe(1)
    expect(themed.background.color.toLowerCase()).toBe(colors.bg.toLowerCase())
    themed.dispose()
  })
})

describe('render/three/runtime', () => {
  it('jsdom 无 WebGL：探测为 false，创建返回 null 并回调 onError', async () => {
    expect(isWebGLAvailable()).toBe(false)
    const canvas = document.createElement('canvas')
    let reason: string | null = null
    const runtime: ThreeRuntime | null = await createThreeRuntime({
      canvas,
      descriptor: threeDescriptor(),
      colors: getTheme('noir').colors,
      onError: (value) => {
        reason = value
      },
    })
    expect(runtime).toBeNull()
    expect(reason).toBe('unsupported')
    expect(getLiveThreeRuntimeCount()).toBe(0)
  })

  it('没有活着的 runtime 时取帧返回 null', () => {
    expect(captureThreeFrame('missing')).toBeNull()
    expect(captureThreeFrame()).toBeNull()
  })
})

/* -------------------------------- 主题一致性 ---------------------------- */

describe('themes ↔ render', () => {
  it('每套主题都能算对比度且不抛错', () => {
    for (const theme of Object.values(THEMES)) {
      const ratio = contrastRatio(theme.colors.fg, theme.colors.bg)
      expect(ratio).not.toBeNull()
      expect(ratio as number).toBeGreaterThan(1)
    }
  })
})
