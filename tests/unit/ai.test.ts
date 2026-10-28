import { beforeEach, describe, expect, it } from 'vitest'
import type { Block, Deck, Outline, RecipeId, Theme } from '@/schema/deck'
import { STAGE_H, STAGE_W, deckSchema, threeDescriptorSchema } from '@/schema/deck'
import { createSampleDeck } from '@/sample/sample-deck'
import { lintDeck, summarizeLint } from '@/lint/deckLint'
import { getTheme } from '@/themes'
import { useDeckStore } from '@/state/deckStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { useSelectionStore } from '@/state/selectionStore'
import {
  AiError,
  RECIPES,
  applySlideRebuild,
  buildDeckFromOutline,
  buildRecipe,
  composeOutline,
  detectIntent,
  extractJson,
  fillContent,
  generateSvgArt,
  generateThreeScene,
  handleIntent,
  installIntentListener,
  isIntentListenerInstalled,
  mockOutline,
  mockSvgArt,
  parseWithRepair,
  rebuildOutlineSlide,
  refineSlide,
  topicOf,
  translateText,
} from '@/ai'
import type { ComposeInput, RecipeContent } from '@/ai'
import { z } from 'zod'

/* ------------------------------- 测试夹具 ------------------------------- */

const INPUT: ComposeInput = {
  prompt: '给设计团队讲一次：为什么我们的演示该换成 HTML',
  lang: 'zh',
  audience: '设计团队',
  length: 'normal',
  include3d: true,
  includeSvg: true,
}

const RECIPE_CONTENT: Record<RecipeId, RecipeContent> = {
  cover: { lang: 'zh', headline: '演示，该换一种载体了', lead: '从静态文件到可运行的作品。' },
  statement: { lang: 'zh', headline: '功能会被忘记，\n场景会被复述。', lead: '所以只讲三件事。' },
  split: {
    lang: 'zh',
    headline: '三个断点',
    lead: '为什么旧格式卡住了',
    points: ['**静态**：改一页要重排版。', '**线性**：观众只能跟着翻。', '**离线**：文件发出去就失联。'],
  },
  grid3: {
    lang: 'zh',
    headline: '三个关键判断',
    points: ['**问题**：谁在为什么付钱。', '**变化**：今天之后哪里不一样。', '**证据**：一个能被复述的细节。'],
  },
  grid4: {
    lang: 'zh',
    headline: '四条要点',
    points: ['先把结论说清。', '再给一个证据。', '然后讲代价。', '最后留一个动作。'],
  },
  timeline: {
    lang: 'zh',
    headline: '载体变迁',
    points: ['1987｜PowerPoint 诞生｜投影仪进了办公室', '2006｜Web 演示｜浏览器能放幻灯片', '2026｜AI 原生｜一句话生成一件作品'],
  },
  compare: {
    lang: 'zh',
    headline: '幻灯片 / 作品',
    points: ['幻灯片｜静态排版，改一页要重来', '幻灯片｜线性翻页，观众只能跟', '作品｜改一处全篇更新', '作品｜可交互，观众自己看'],
  },
  quote: { lang: 'zh', headline: '把页面交出去，\n还是把体验交出去？', lead: 'LUMEN 设计原则 · P6' },
  data: {
    lang: 'zh',
    headline: '观众记得住什么',
    lead: '示意数据：用于说明差异，非严谨统计。',
    points: ['纯文字=10%', '图文=35%', '动图=65%', '可交互=90%'],
  },
  process: {
    lang: 'zh',
    headline: '现场演示的四步节奏',
    points: ['开场｜30 秒｜先给结论', '问题｜90 秒｜用一个真实场景', '演示｜3 分钟｜只演一条主路径'],
  },
  gallery: { lang: 'zh', headline: '三种画面', points: ['开场：一个被拉长的瞬间', '中段：把结构摊开', '收尾：留一个动作'] },
  closing: { lang: 'zh', headline: '开始第一幕', lead: '按 ⌘K 输入你的主题。' },
}

const ALL_RECIPES = Object.keys(RECIPES) as RecipeId[]

function blocksOfRecipe(id: RecipeId, theme: Theme): Block[] {
  return buildRecipe(id, RECIPE_CONTENT[id], theme)
}

function assertInsideStage(blocks: Block[], label: string): void {
  for (const block of blocks) {
    expect(block.w, `${label} w`).toBeGreaterThan(0)
    expect(block.h, `${label} h`).toBeGreaterThan(0)
    expect(block.x, `${label} ${block.type} x`).toBeGreaterThanOrEqual(0)
    expect(block.y, `${label} ${block.type} y`).toBeGreaterThanOrEqual(0)
    expect(block.x + block.w, `${label} ${block.type} right`).toBeLessThanOrEqual(STAGE_W + 0.5)
    expect(block.y + block.h, `${label} ${block.type} bottom`).toBeLessThanOrEqual(STAGE_H + 0.5)
  }
}

function textOf(block: Block): string {
  if (block.type === 'text') return block.text
  if (block.type === 'svg') return block.source
  if (block.type === 'html') return block.html + (block.css ?? '')
  return ''
}

function resetStores(deck?: Deck): void {
  useSettingsStore.getState().hydrate(null)
  useDeckStore.getState().setDeck(deck ?? createSampleDeck('zh'), { resetHistory: true })
  useUiStore.getState().setActiveSlide((deck ?? useDeckStore.getState().deck).slides[0]?.id ?? null)
  useUiStore.setState({ toasts: [] })
  useSelectionStore.getState().clearSelection()
}

/* --------------------------------- 语料 --------------------------------- */

describe('ai/corpus', () => {
  it('识别四种意图并提炼主题', () => {
    expect(detectIntent('新品发布会')).toBe('launch')
    expect(detectIntent('技术方案评审')).toBe('plan')
    expect(detectIntent('入门课程讲解')).toBe('course')
    expect(detectIntent('季度复盘')).toBe('retro')
    expect(topicOf('给设计团队讲一次：为什么我们的演示该换成 HTML', 'zh')).toBe('为什么我们的演示该换成 HTML')
    expect(topicOf('', 'zh')).toBe('这次分享')
  })

  it('同一句提示词得到同一份大纲（确定性）', () => {
    const a = mockOutline(INPUT)
    const b = mockOutline(INPUT)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.slides.length).toBe(9)
    expect(a.slides[0].recipe).toBe('cover')
    expect(a.slides[a.slides.length - 1].recipe).toBe('closing')
  })

  it('按开关裁剪 SVG / 3D 幕', () => {
    const withVisuals = mockOutline(INPUT)
    const kinds = withVisuals.slides.map((slide) => slide.visual.kind)
    expect(kinds).toContain('svg')
    expect(kinds).toContain('three')

    const none = mockOutline({ ...INPUT, include3d: false, includeSvg: false })
    expect(none.slides.every((slide) => slide.visual.kind === 'none')).toBe(true)
  })

  it('长度与时长改变幕数', () => {
    expect(mockOutline({ ...INPUT, length: 'short' }).slides.length).toBe(6)
    expect(mockOutline({ ...INPUT, length: 'deep' }).slides.length).toBe(12)
    expect(mockOutline({ ...INPUT, durationMin: 20 }).slides.length).toBeGreaterThan(9)
  })

  it('英文大纲跟随输入语言', () => {
    const en = mockOutline({ prompt: 'Tell the design team why decks should become HTML', lang: 'en' })
    expect(en.lang).toBe('en')
    expect(en.slides.every((slide) => /[\u4e00-\u9fff]/.test(slide.headline) === false)).toBe(true)
  })
})

/* --------------------------------- 配方 --------------------------------- */

describe('ai/recipes', () => {
  it('12 个配方都能排版，且几何全部落在舞台内', () => {
    expect(ALL_RECIPES).toHaveLength(12)
    for (const themeId of ['noir', 'paper', 'signal']) {
      const theme = getTheme(themeId)
      for (const id of ALL_RECIPES) {
        assertInsideStage(blocksOfRecipe(id, theme), `${themeId}/${id}`)
      }
    }
  })

  it('AI 产物里没有 CSS / 脚本 / 外链', () => {
    for (const id of ALL_RECIPES) {
      const blocks = blocksOfRecipe(id, getTheme('noir'))
      for (const block of blocks) {
        const text = textOf(block)
        expect(text, `${id} script`).not.toMatch(/<script/i)
        expect(text, `${id} style`).not.toMatch(/\sstyle\s*=/i)
        expect(text, `${id} css`).not.toMatch(/[{};]\s*\n?\s*[a-z-]+\s*:/i)
        expect(text, `${id} http`).not.toMatch(/https?:\/\/(?!www\.w3\.org)/i)
        expect(block.type, `${id} html block`).not.toBe('html')
      }
    }
  })

  it('颜色只用令牌，且与主题 bg 对比度达标', () => {
    for (const themeId of ['noir', 'paper', 'aurora', 'signal', 'museum', 'terminal']) {
      const theme = getTheme(themeId)
      for (const id of ALL_RECIPES) {
        const blocks = blocksOfRecipe(id, theme)
        const issues = lintDeck(
          deckSchema.parse({
            id: 'probe',
            title: 'probe',
            lang: 'zh',
            themeId,
            slides: [
              {
                id: 's1',
                blocks,
                background: { kind: 'theme' },
                transition: { kind: 'fade', ms: 420 },
              },
            ],
          }),
        )
        const bad = issues.filter((issue) => issue.code === 'contrast' || issue.code === 'outOfBounds')
        expect(bad, `${themeId}/${id}`).toEqual([])
      }
    }
  })

  it('每个配方都真的用上了自己的版式（不会静默退回 statement）', () => {
    const dense: RecipeId[] = ['cover', 'split', 'grid3', 'grid4', 'timeline', 'compare', 'data', 'process', 'gallery']
    for (const id of dense) {
      expect(blocksOfRecipe(id, getTheme('noir')).length, `${id} block count`).toBeGreaterThan(4)
    }

    const compareBlocks = blocksOfRecipe('compare', getTheme('noir'))
    expect(compareBlocks.some((block) => block.type === 'shape' && block.kind === 'rect' && block.w === 1)).toBe(true)
    const headers = compareBlocks.filter((block) => block.type === 'text' && block.variant === 'h2')
    expect(headers.length).toBeGreaterThanOrEqual(2)

    const dataBlocks = blocksOfRecipe('data', getTheme('noir'))
    expect(dataBlocks.filter((block) => block.type === 'shape' && block.kind === 'rect').length).toBeGreaterThanOrEqual(4)
  })

  it('缺内容时用兜底文案而不是抛错', () => {
    for (const id of ALL_RECIPES) {
      const blocks = buildRecipe(id, { lang: 'zh', headline: '' }, getTheme('noir'))
      expect(blocks.length).toBeGreaterThan(0)
      const filled = fillContent(id, { lang: 'en', headline: '' })
      expect((filled.headline ?? '').length).toBeGreaterThan(0)
    }
  })

  it('data 配方会画柱状图与环形图，timeline 真的排成时间线', () => {
    const bars = blocksOfRecipe('data', getTheme('noir'))
    expect(bars.filter((block) => block.type === 'shape' && block.kind === 'rect').length).toBeGreaterThanOrEqual(4)
    const values = bars.filter((block) => block.type === 'text' && /%$/.test(block.text))
    expect(values.length).toBeGreaterThanOrEqual(4)

    // 占比型数据（合计 100%）走环形图：一块 svg + 图例
    const donut = buildRecipe(
      'data',
      { ...RECIPE_CONTENT.data, points: ['沟通对齐=40%', '返工重做=30%', '真正实现=30%'] },
      getTheme('noir'),
    )
    expect(donut.some((block) => block.type === 'svg')).toBe(true)

    const timeline = blocksOfRecipe('timeline', getTheme('noir'))
    const dots = timeline.filter((block) => block.type === 'shape' && block.kind === 'ellipse')
    expect(dots.length).toBe(3)
  })
})

/* -------------------------------- 编排管线 -------------------------------- */

describe('ai/compose', () => {
  beforeEach(() => {
    resetStores()
  })

  it('Mock 生成大纲：3–20 幕、可编辑、provider 为 mock', async () => {
    const result = await composeOutline(INPUT)
    expect(result.provider).toBe('mock')
    expect(result.outline.slides.length).toBeGreaterThanOrEqual(3)
    expect(result.outline.slides.length).toBeLessThanOrEqual(20)
    expect(result.outline.lang).toBe('zh')
    for (const slide of result.outline.slides) {
      expect(slide.headline.length).toBeGreaterThan(0)
      expect(slide.points.length).toBeGreaterThanOrEqual(0)
    }
  })

  it('逐幕成稿：9 幕、无 lint error、块全部在舞台内', async () => {
    const outline = (await composeOutline(INPUT)).outline
    const progress: number[] = []
    const { deck, warnings } = await buildDeckFromOutline(outline, {
      prompt: INPUT.prompt,
      onProgress: (done) => progress.push(done),
    })

    expect(deck.slides).toHaveLength(outline.slides.length)
    expect(progress[progress.length - 1]).toBe(deck.slides.length)
    expect(warnings.filter((warning) => warning.includes('lint'))).toEqual([])

    const issues = lintDeck(deck)
    const summary = summarizeLint(issues)
    expect(summary.error, JSON.stringify(issues.filter((issue) => issue.severity === 'error'))).toBe(0)

    for (const [index, slide] of deck.slides.entries()) {
      assertInsideStage(slide.blocks, `slide ${index}`)
      expect(slide.recipe).toBeTruthy()
      expect(slide.notes && slide.notes.length > 0).toBe(true)
    }

    const types = new Set(deck.slides.flatMap((slide) => slide.blocks.map((block) => block.type)))
    expect(types.has('text')).toBe(true)
    expect(types.has('svg')).toBe(true)
    expect(types.has('three')).toBe(true)
  })

  it('每个 AI 块都带 provenance 与 aiSnapshot', async () => {
    const outline = (await composeOutline(INPUT)).outline
    const { deck } = await buildDeckFromOutline(outline, { prompt: INPUT.prompt })
    for (const slide of deck.slides) {
      for (const block of slide.blocks) {
        expect(block.provenance?.provider).toBe('mock')
        expect(block.provenance?.recipeId).toBe(slide.recipe)
        expect(block.provenance?.promptDigest).toMatch(/^[a-z0-9]{4,10}$/)
        expect(block.aiSnapshot && block.aiSnapshot.length > 0).toBe(true)
      }
    }
    const three = deck.slides.flatMap((slide) => slide.blocks).find((block) => block.type === 'three')
    expect(three).toBeTruthy()
    if (three && three.type === 'three') {
      expect(threeDescriptorSchema.safeParse(three.descriptor).success).toBe(true)
    }
  })

  it('一次性落库：撤销一次回到原来的 deck', async () => {
    const before = useDeckStore.getState().deck
    const beforeSlides = before.slides.length
    const outline = (await composeOutline(INPUT)).outline
    const { deck } = await buildDeckFromOutline(outline, { prompt: INPUT.prompt })

    expect(useDeckStore.getState().deck.slides.length).toBe(deck.slides.length)
    expect(useDeckStore.getState().deck.title).toBe(outline.title)

    useDeckStore.getState().undo()
    expect(useDeckStore.getState().deck.slides.length).toBe(beforeSlides)
    expect(useDeckStore.getState().deck.id).toBe(before.id)
  })

  it('取消：signal 中断后不落库', async () => {
    const before = useDeckStore.getState().deck
    const outline = (await composeOutline(INPUT)).outline
    const controller = new AbortController()
    controller.abort()
    await expect(
      buildDeckFromOutline(outline, { prompt: INPUT.prompt, signal: controller.signal }),
    ).rejects.toBeInstanceOf(AiError)
    expect(useDeckStore.getState().deck.slides.length).toBe(before.slides.length)
  })

  it('单幕重试：只重建一幕并写回，撤销一次可还原', async () => {
    const outline = (await composeOutline(INPUT)).outline
    await buildDeckFromOutline(outline, { prompt: INPUT.prompt })
    const beforeDeck = useDeckStore.getState().deck
    const targetId = beforeDeck.slides[2].id
    const beforeBlockIds = beforeDeck.slides[2].blocks.map((block) => block.id)

    const rebuilt = await rebuildOutlineSlide(outline, 2, { prompt: INPUT.prompt })
    expect(rebuilt.slide.blocks.length).toBeGreaterThan(0)
    expect(applySlideRebuild(2, rebuilt.slide)).toBe(true)

    const afterDeck = useDeckStore.getState().deck
    expect(afterDeck.slides[2].id).toBe(targetId)
    expect(afterDeck.slides[2].blocks[0].provenance?.provider).toBe('mock')
    expect(afterDeck.slides[2].blocks.map((block) => block.id)).not.toEqual(beforeBlockIds)

    useDeckStore.getState().undo()
    expect(useDeckStore.getState().deck.slides[2].blocks.map((block) => block.id)).toEqual(beforeBlockIds)
  })
})

/* --------------------------------- 单点生成 -------------------------------- */

describe('ai/generate', () => {
  it('SVG 已净化且只用令牌色', async () => {
    const art = await generateSvgArt('一条被拉长的胶片，末端变成屏幕')
    expect(art.provider).toBe('mock')
    expect(art.source).toMatch(/^<svg/)
    expect(art.source).not.toMatch(/<script/i)
    expect(art.source).not.toMatch(/#[0-9a-f]{3,6}\b/i)
    expect(art.source).toMatch(/var\(--d-/)
  })

  it('3D 描述符通过 schema', async () => {
    const scene = await generateThreeScene('发光的球体阵列，缓慢自转')
    expect(scene.provider).toBe('mock')
    expect(threeDescriptorSchema.safeParse(scene.descriptor).success).toBe(true)
    expect(scene.descriptor.objects.length).toBeLessThanOrEqual(24)
  })

  it('同一提示词生成同一张图（确定性）', () => {
    const a = mockSvgArt('轨道与点阵')
    const b = mockSvgArt('轨道与点阵')
    expect(a.source).toBe(b.source)
  })
})

/* --------------------------------- 微调 --------------------------------- */

describe('ai/refine', () => {
  beforeEach(async () => {
    resetStores()
    const outline = (await composeOutline(INPUT)).outline
    await buildDeckFromOutline(outline, { prompt: INPUT.prompt })
    useUiStore.getState().setActiveSlide(useDeckStore.getState().deck.slides[3].id)
  })

  it('改成时间轴：重建成 timeline 配方', async () => {
    const deck = useDeckStore.getState().deck
    const slideId = useUiStore.getState().activeSlideId ?? deck.slides[0].id
    const { patch } = await refineSlide('把这一页改成时间轴', { deck, slideId })
    expect(patch.intent).toBe('timeline')
    expect(patch.recipe).toBe('timeline')
    expect(patch.diff.removed.length).toBeGreaterThan(0)
    expect(patch.nextBlocks.some((block) => block.type === 'shape' && block.kind === 'ellipse')).toBe(true)
  })

  it('更安静：收敛成主张页', async () => {
    const deck = useDeckStore.getState().deck
    const slideId = useUiStore.getState().activeSlideId ?? deck.slides[0].id
    const { patch } = await refineSlide('让这页更安静一点', { deck, slideId })
    expect(patch.intent).toBe('quieter')
    expect(patch.recipe).toBe('statement')
    expect(patch.nextBlocks.length).toBeLessThanOrEqual(4)
  })

  it('缩短：只改文字，不换版式', async () => {
    const deck = useDeckStore.getState().deck
    const slideId = useUiStore.getState().activeSlideId ?? deck.slides[0].id
    const { patch } = await refineSlide('缩短', { deck, slideId })
    expect(patch.intent).toBe('shorter')
    expect(patch.diff.removed).toEqual([])
    expect(patch.diff.changed.length).toBeGreaterThan(0)
  })

  it('加一张插图：产出 svg 块', async () => {
    const deck = useDeckStore.getState().deck
    const slideId = useUiStore.getState().activeSlideId ?? deck.slides[0].id
    const { patch } = await refineSlide('加一张插图', { deck, slideId })
    expect(patch.intent).toBe('addSvg')
    expect(patch.nextBlocks.some((block) => block.type === 'svg')).toBe(true)
  })

  it('翻译：文字变成另一种语言', async () => {
    const deck = useDeckStore.getState().deck
    const slideId = useUiStore.getState().activeSlideId ?? deck.slides[0].id
    const { patch } = await refineSlide('翻译成英文', { deck, slideId })
    expect(patch.intent).toBe('translate')
    const before = deck.slides.find((slide) => slide.id === slideId)
    const beforeTexts = new Set((before?.blocks ?? []).filter((block) => block.type === 'text').map((block) => block.text))
    const changed = patch.nextBlocks.filter((block) => block.type === 'text' && !beforeTexts.has(block.text))
    expect(changed.length).toBeGreaterThan(0)
  })

  it('未命中指令：Mock 下不产生变化', async () => {
    const deck = useDeckStore.getState().deck
    const slideId = useUiStore.getState().activeSlideId ?? deck.slides[0].id
    const { patch } = await refineSlide('随便来点什么', { deck, slideId })
    expect(patch.intent).toBe('unknown')
    expect(patch.diff.added.length + patch.diff.changed.length + patch.diff.removed.length).toBe(0)
    expect(patch.warnings).toContain('unknown-intent')
  })

  it('翻译词表可用（中英双向）', () => {
    expect(translateText('幻灯片与观众', 'en')).toContain('slides')
    expect(translateText('timeline of the plan', 'zh')).toContain('时间轴')
  })
})

/* --------------------------------- 意图 --------------------------------- */

describe('ai/intent', () => {
  beforeEach(() => {
    resetStores()
  })

  it('安装/卸载监听器是幂等的', () => {
    const uninstall = installIntentListener()
    expect(isIntentListenerInstalled()).toBe(true)
    const second = installIntentListener()
    second()
    expect(isIntentListenerInstalled()).toBe(true)
    uninstall()
    expect(isIntentListenerInstalled()).toBe(false)
  })

  it('「换个主题」切主题并 toast', async () => {
    const before = useDeckStore.getState().deck.themeId
    await handleIntent('换个深色主题')
    expect(useDeckStore.getState().deck.themeId).not.toBe(before)
    const toasts = useUiStore.getState().toasts
    expect(toasts.length).toBe(1)
    expect(toasts[0].message.length).toBeGreaterThan(0)
  })

  it('「加一张插图」在当前幕插入 SVG', async () => {
    await handleIntent('加一张插图')
    const deck = useDeckStore.getState().deck
    const slide = deck.slides.find((item) => item.id === useUiStore.getState().activeSlideId) ?? deck.slides[0]
    expect(slide.blocks.some((block) => block.type === 'svg')).toBe(true)
  })

  it('未命中 → toast ai.intent.unknown', async () => {
    await handleIntent('随便说点什么')
    const toasts = useUiStore.getState().toasts
    expect(toasts.length).toBe(1)
    expect(toasts[0].kind).toBe('info')
  })
})

/* -------------------------------- 校验修复 -------------------------------- */

describe('ai/validate', () => {
  const schema = z.object({ title: z.string(), slides: z.array(z.string()).min(1) })

  it('从围栏与噪音里抽出 JSON', () => {
    expect(extractJson('前缀\n```json\n{"a":1}\n```\n后缀')).toBe('{"a":1}')
    expect(extractJson('没有对象')).toBeNull()
  })

  it('第一次不合法时回喂一次并成功', async () => {
    const repair = async (issues: string[]) => {
      expect(issues.length).toBeGreaterThan(0)
      return '{"title":"ok","slides":["a"]}'
    }
    const value = await parseWithRepair(schema, '{"title":"ok","slides":[]}', { repair })
    expect(value.title).toBe('ok')
  })

  it('两次都失败 → 结构化 AiError(badJson)', async () => {
    await expect(
      parseWithRepair(schema, 'not json', { repair: async () => '{"still":"wrong"}' }),
    ).rejects.toMatchObject({ code: 'badJson' })
  })

  it('取消信号优先于解析', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      parseWithRepair(schema, '{"title":"ok","slides":["a"]}', { signal: controller.signal }),
    ).rejects.toMatchObject({ aborted: true })
  })
})
