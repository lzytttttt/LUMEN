/**
 * compose.ts —— 编排管线：一句话 → 大纲 → 逐幕成稿。
 *
 * - `composeOutline`：provider → 校验（含一次修复）→ 归一化成可编辑大纲；
 * - `buildDeckFromOutline`：逐幕并发 2 生成内容 → 配方排版 → 单幕 lint → 一次性落库（单步撤销）。
 *
 * 设计要点：
 * - 生成过程不碰 DOM、不阻塞主线程（纯 async，画布可继续操作）；
 * - 单幕失败只降级这一幕（兜底配方 + warning），不中断整套；
 * - 每个 AI 块都带 provenance 与 aiSnapshot（用于「还原 AI 版本」）。
 */
import { z } from 'zod'
import type { Deck, Outline, OutlineSlide, RecipeId, Slide, Theme } from '@/schema/deck'
import { deckSchema, outlineSchema } from '@/schema/deck'
import { makeSlide } from '@/schema/factory'
import { newId, shortHash } from '@/schema/ids'
import { getTheme } from '@/themes'
import { lintDeck } from '@/lint/deckLint'
import { readViewBox } from '@/render/svg/sanitize'
import { useDeckStore } from '@/state/deckStore'
import { deckOps, historyOps, slideOps } from '@/state/ops'
import { useSettingsStore } from '@/state/settingsStore'
import type { BuildDeckOptions, BuildDeckResult, ComposeInput, RecipeContent, RecipeVisual } from './types'
import { AiError, currentProvider, isAborted, type AiProvider } from './provider'
import { outlineRequest, slideRequest } from './prompts'
import { parseWithRepair, repairPrompt } from './validate'
import { buildRecipe } from './recipes'
import { stampBlocks } from './provenance'
import { generateSvgArt, generateThreeScene } from './generate'

/* --------------------------------- 大纲 --------------------------------- */

const slideContentSchema = z.object({
  headline: z.string().min(1).max(160),
  lead: z.string().max(240).optional(),
  points: z.array(z.string().max(200)).max(8).default([]),
  notes: z.string().max(800).optional(),
})

type SlideContent = z.infer<typeof slideContentSchema>

function modelOf(provider: AiProvider): string | undefined {
  return provider.id === 'openai' ? useSettingsStore.getState().llm.model : undefined
}

/** 归一化：幕数 3–20、语言跟随输入、按开关裁剪视觉、最多 2 个 3D 幕。 */
export function normalizeOutline(outline: Outline, input: ComposeInput): Outline {
  const slides: OutlineSlide[] = outline.slides.slice(0, 20).map((slide) => {
    const visual: OutlineSlide['visual'] =
      slide.visual.kind === 'svg' && input.includeSvg === false
        ? { kind: 'none' }
        : slide.visual.kind === 'three' && input.include3d === false
          ? { kind: 'none' }
          : slide.visual
    return {
      ...slide,
      headline: slide.headline.trim() === '' ? (input.lang === 'zh' ? '未命名一幕' : 'Untitled slide') : slide.headline,
      points: (slide.points ?? []).filter((point) => point.trim() !== '').slice(0, 6),
      visual,
    }
  })

  // 3D 预算：整套最多 2 幕（与 lint 同一条尺子）。
  let threeCount = 0
  for (const slide of slides) {
    if (slide.visual.kind !== 'three') continue
    threeCount += 1
    if (threeCount > 2) slide.visual = { kind: 'none' }
  }

  while (slides.length < 3) {
    slides.push({
      recipe: slides.length === 0 ? 'cover' : 'closing',
      headline: input.lang === 'zh' ? '再补一幕' : 'One more slide',
      points: [],
      visual: { kind: 'none' },
    })
  }

  return outlineSchema.parse({
    title: outline.title.trim() === '' ? input.prompt.slice(0, 60) : outline.title,
    subtitle: outline.subtitle,
    lang: input.lang,
    slides,
  })
}

/** 一句话 → 可编辑大纲。 */
export async function composeOutline(
  input: ComposeInput,
  opts: { signal?: AbortSignal } = {},
): Promise<{ outline: Outline; provider: string; model?: string }> {
  const provider = currentProvider()
  const { system, user } = outlineRequest(input)
  const res = await provider.complete({
    system,
    user,
    json: true,
    temperature: 0.65,
    signal: opts.signal,
  })
  const outline = await parseWithRepair(outlineSchema, res.text, {
    signal: opts.signal,
    repair:
      provider.id === 'openai'
        ? async (issues) => {
            const retry = await provider.complete({
              system,
              user: repairPrompt(user, issues),
              json: true,
              signal: opts.signal,
            })
            return retry.text
          }
        : undefined,
  })
  return { outline: normalizeOutline(outline, input), provider: provider.id, model: modelOf(provider) }
}

/* ------------------------------- 逐幕成稿 ------------------------------- */

const TRANSITIONS: Record<RecipeId, Slide['transition']['kind']> = {
  cover: 'fade',
  statement: 'fade',
  split: 'push',
  grid3: 'wipe',
  grid4: 'wipe',
  timeline: 'push',
  compare: 'wipe',
  quote: 'fade',
  data: 'fade',
  process: 'push',
  gallery: 'fade',
  closing: 'fade',
}

function visualOf(slide: OutlineSlide): RecipeVisual {
  if (slide.visual.kind === 'svg') return { kind: 'svg', caption: slide.visual.brief }
  if (slide.visual.kind === 'three') return { kind: 'three' }
  return { kind: 'none' }
}

function contentOf(slide: OutlineSlide, lang: 'zh' | 'en', index: number, total: number): RecipeContent {
  return {
    lang,
    headline: slide.headline,
    lead: slide.lead,
    points: slide.points,
    visual: visualOf(slide),
    notes: slide.notes,
    index,
    total,
  }
}

function probeDeck(slide: Slide, outline: Outline, themeId: string): Deck {
  const now = Date.now()
  return {
    schemaVersion: 1,
    id: 'lint-probe',
    title: outline.title,
    lang: outline.lang,
    aspect: '16:9',
    themeId,
    slides: [slide],
    meta: { createdAt: now, updatedAt: now, origin: 'ai' },
  }
}

/** 单幕 lint：只把 error 当失败（warn 记录到返回值里）。 */
function slideIssues(slide: Slide, outline: Outline, themeId: string): { errors: string[]; warns: string[] } {
  const issues = lintDeck(probeDeck(slide, outline, themeId))
  const errors: string[] = []
  const warns: string[] = []
  for (const issue of issues) {
    if (issue.severity === 'error') errors.push(issue.code)
    else if (issue.severity === 'warn') warns.push(issue.code)
  }
  return { errors: Array.from(new Set(errors)), warns: Array.from(new Set(warns)) }
}

/** 兜底配方：内容多就卡片，内容少就主张页——两种都极难溢出。 */
function fallbackRecipeFor(content: RecipeContent): RecipeId {
  return (content.points ?? []).length >= 3 ? 'grid3' : 'statement'
}

function makeSlideFor(seed: OutlineSlide, content: RecipeContent, blocks: Slide['blocks'], recipeId: RecipeId): Slide {
  return makeSlide({
    name: seed.headline.replace(/\n/g, ' ').slice(0, 60),
    recipe: recipeId,
    notes: content.notes,
    transition: { kind: TRANSITIONS[recipeId] ?? 'fade', ms: 420 },
    blocks,
  })
}

/** 简单的并发池（并发 2），支持取消。 */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0
  const size = Math.min(Math.max(limit, 1), Math.max(items.length, 1))
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) return
      const index = cursor
      cursor += 1
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

/** 单幕构建上下文（整盘生成与单幕重试共用）。 */
interface SlideBuildContext {
  provider: AiProvider
  model?: string
  theme: Theme
  digest: string
  outline: Outline
  total: number
  signal?: AbortSignal
}

/** 单幕构建：文案 → 视觉 → 配方排版 → 单幕 lint（失败只降级这一幕，不抛给调用方）。 */
async function buildOneSlide(
  seed: OutlineSlide,
  index: number,
  ctx: SlideBuildContext,
): Promise<{ slide: Slide; warnings: string[] }> {
  const warnings: string[] = []
  const { provider, model, theme, outline, signal } = ctx
  const req = slideRequest({ outline, slide: seed, index, lang: outline.lang })
  let content = contentOf(seed, outline.lang, index, ctx.total)

  // 1) 文案（失败只记录，用大纲原文兜底）。
  try {
    const res = await provider.complete({
      system: req.system,
      user: req.user,
      json: true,
      temperature: 0.7,
      signal,
    })
    const parsed: SlideContent = await parseWithRepair(slideContentSchema, res.text, {
      signal,
      repair:
        provider.id === 'openai'
          ? async (issues) => {
              const retry = await provider.complete({
                system: req.system,
                user: repairPrompt(req.user, issues),
                json: true,
                signal,
              })
              return retry.text
            }
          : undefined,
    })
    content = {
      ...content,
      headline: parsed.headline,
      lead: parsed.lead ?? content.lead,
      points: parsed.points.length > 0 ? parsed.points : content.points,
      notes: parsed.notes ?? content.notes,
    }
  } catch (error) {
    if (isAborted(error) || signal?.aborted) throw error
    warnings.push(`#${index + 1} content: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 2) 视觉：svg / three 走单点生成（真端点失败自动回退本地素材）。
  try {
    if (seed.visual.kind === 'svg') {
      const art = await generateSvgArt(seed.visual.brief, { signal })
      content.visual = {
        kind: 'svg',
        source: art.source,
        viewBox: readViewBox(art.source) ?? [0, 0, 820, 560],
        caption: seed.visual.brief,
      }
    } else if (seed.visual.kind === 'three') {
      const scene = await generateThreeScene(seed.headline, { signal })
      content.visual = { kind: 'three', descriptor: scene.descriptor }
    }
  } catch (error) {
    if (isAborted(error) || signal?.aborted) throw error
    content.visual = { kind: 'none' }
    warnings.push(`#${index + 1} visual: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 3) 排版 + 溯源。
  let recipeId = seed.recipe
  let blocks = stampBlocks(buildRecipe(recipeId, content, theme), {
    provider: provider.id,
    model,
    recipeId,
    promptDigest: ctx.digest,
  })
  let slide = makeSlideFor(seed, content, blocks, recipeId)

  // 4) lint：error 才重排，warn 只记录。
  let check = slideIssues(slide, outline, theme.id)
  if (check.errors.length > 0) {
    recipeId = fallbackRecipeFor(content)
    blocks = stampBlocks(buildRecipe(recipeId, content, theme), {
      provider: provider.id,
      model,
      recipeId,
      promptDigest: ctx.digest,
    })
    slide = makeSlideFor(seed, content, blocks, recipeId)
    warnings.push(`#${index + 1} lint ${check.errors.join('+')} → fallback ${recipeId}`)
    const recheck = slideIssues(slide, outline, theme.id)
    if (recheck.errors.length > 0) warnings.push(`#${index + 1} lint still ${recheck.errors.join('+')}`)
    check = recheck
  }
  for (const code of check.warns) warnings.push(`#${index + 1} warn ${code}`)

  return { slide, warnings }
}

/** 单幕重试：只重建大纲里的第 index 幕（部分失败时用）。 */
export async function rebuildOutlineSlide(
  outline: Outline,
  index: number,
  opts: { themeId?: string; prompt?: string; signal?: AbortSignal } = {},
): Promise<{ slide: Slide; warnings: string[] }> {
  const seed = outline.slides[index]
  if (!seed) throw new Error(`slide index out of range: ${index}`)
  const provider = currentProvider()
  const base = useDeckStore.getState().deck
  const theme = getTheme(opts.themeId ?? base?.themeId)
  return buildOneSlide(seed, index, {
    provider,
    model: modelOf(provider),
    theme,
    digest: shortHash(opts.prompt ?? outline.title),
    outline,
    total: outline.slides.length,
    signal: opts.signal,
  })
}

/** 把单幕重试的结果写回当前 deck（单步撤销）。 */
export function applySlideRebuild(index: number, slide: Slide): boolean {
  const deck = useDeckStore.getState().deck
  const target = deck?.slides[index]
  if (!target) return false
  slideOps.update(
    target.id,
    (draft) => {
      draft.blocks = slide.blocks
      draft.recipe = slide.recipe
      draft.notes = slide.notes
    },
    'ai-retry-slide',
  )
  return true
}

/** 逐幕成稿：并发 2 生成内容 → 配方排版 → lint → 一次性落库。 */
export async function buildDeckFromOutline(
  outline: Outline,
  opts: BuildDeckOptions = {},
): Promise<BuildDeckResult> {
  const provider = currentProvider()
  const model = modelOf(provider)
  const base = useDeckStore.getState().deck
  const theme = getTheme(opts.themeId ?? base?.themeId)
  const digest = shortHash(opts.prompt ?? outline.title)
  const total = outline.slides.length
  const slides: Slide[] = new Array(total)
  const warnings: string[] = []
  let done = 0

  await runPool(
    outline.slides,
    2,
    async (seed, index) => {
      if (opts.signal?.aborted) throw new AiError('timeout', 'aborted', true)
      const built = await buildOneSlide(seed, index, {
        provider,
        model,
        theme,
        digest,
        outline,
        total,
        signal: opts.signal,
      })
      warnings.push(...built.warnings)
      slides[index] = built.slide
      done += 1
      opts.onProgress?.(done, total)
    },
    opts.signal,
  )

  if (opts.signal?.aborted) throw new AiError('timeout', 'aborted', true)

  // 5) 组装 + 一次性落库（单步撤销）。
  const now = Date.now()
  const nextDeck: Deck = deckSchema.parse({
    schemaVersion: 1,
    id: base?.id ?? newId('deck'),
    title: outline.title,
    lang: outline.lang,
    aspect: '16:9',
    themeId: theme.id,
    themeOverrides: base?.themeOverrides,
    slides,
    meta: {
      createdAt: base?.meta.createdAt ?? now,
      updatedAt: now,
      origin: 'ai',
      prompt: opts.prompt,
    },
  })

  if (base) {
    historyOps.transaction('ai-build-deck', () => {
      if (base.themeId !== theme.id) deckOps.setTheme(theme.id)
      deckOps.applyOutline(outline.title, slides, { replace: true, prompt: opts.prompt })
    })
  }

  return { deck: nextDeck, warnings }
}
