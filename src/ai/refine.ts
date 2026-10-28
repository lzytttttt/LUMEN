/**
 * refine.ts —— 自然语言微调（规则优先，LLM 只做增强）。
 *
 * 返回结构化的 `SlidePatchPlan`：调用方先展示 diff（哪些块会变），确认后再用 blockOps 应用。
 * 规则命中时不发网络请求，离线可用；未命中且配置了真端点时才请求模型重写文案。
 */
import { z } from 'zod'
import type { Block, Deck, RecipeId, Slide, TextBlock } from '@/schema/deck'
import { shortHash } from '@/schema/ids'
import { getTheme } from '@/themes'
import { blockOps, historyOps, slideOps } from '@/state/ops'
import { useSettingsStore } from '@/state/settingsStore'
import { buildRecipe } from './recipes'
import { stampBlocks } from './provenance'
import { generateSvgArt, generateThreeScene } from './generate'
import { translateText } from './corpus'
import { aiErrorMessage, currentProvider, isAborted } from './provider'
import { refineRequest } from './prompts'
import { parseWithRepair, repairPrompt } from './validate'
import type { RecipeContent, RecipeVisual, RefineIntent, SlidePatchPlan } from './types'

const refineSchema = z.object({
  headline: z.string().min(1).max(160),
  lead: z.string().max(240).optional(),
  points: z.array(z.string().max(200)).max(8).default([]),
})

/* -------------------------------- 意图识别 -------------------------------- */

const RULES: [RefineIntent, RegExp][] = [
  ['translate', /翻译|translate|英文|中文|english|chinese/i],
  ['timeline', /时间轴|时间线|timeline/i],
  ['process', /流程|步骤|process|steps?\b/i],
  ['compare', /对比|比较|compare|versus|\bvs\b/i],
  ['add3d', /\b3d\b|立体|三维|three/i],
  ['addSvg', /插图|配图|矢量|vector|illustration|\bsvg\b/i],
  ['quieter', /安静|克制|简洁|清爽|calm|quiet|minimal|cleaner|less busy/i],
  ['shorter', /精简|缩短|短一点|太长|压缩|shorten|shorter|tighter|trim/i],
  ['grid', /卡片|网格|要点|分点|grid|cards?\b|bullets?/i],
  ['restyle', /风格|配色|颜色|换色|style|palette|colou?r/i],
]

export function detectRefineIntent(instruction: string): RefineIntent {
  for (const [intent, re] of RULES) if (re.test(instruction)) return intent
  return 'unknown'
}

/* -------------------------------- 内容抽取 -------------------------------- */

function textsOf(slide: Slide): TextBlock[] {
  return slide.blocks.filter((block): block is TextBlock => block.type === 'text')
}

function visualOfSlide(slide: Slide): RecipeVisual {
  const svg = slide.blocks.find((block) => block.type === 'svg')
  if (svg && svg.type === 'svg') return { kind: 'svg', source: svg.source, viewBox: svg.viewBox }
  const three = slide.blocks.find((block) => block.type === 'three')
  if (three && three.type === 'three') return { kind: 'three', descriptor: three.descriptor }
  return { kind: 'none' }
}

/** 从现有块反推内容槽位（用于重建版式）。 */
export function contentFromSlide(slide: Slide, lang: 'zh' | 'en'): RecipeContent {
  const texts = textsOf(slide)
  const headline =
    texts.find((block) => block.variant === 'display') ??
    texts.find((block) => block.variant === 'h1') ??
    texts.find((block) => block.variant === 'h2') ??
    texts[0]
  const lead = texts.find((block) => block.variant === 'lead')
  const points = texts
    .filter((block) => block.id !== headline?.id && block.id !== lead?.id)
    .filter((block) => block.variant === 'body' && block.y < 620)
    .map((block) => block.text)
  return {
    lang,
    headline: headline?.text ?? (lang === 'zh' ? '这一幕' : 'This slide'),
    lead: lead?.text,
    points,
    visual: visualOfSlide(slide),
    notes: slide.notes,
  }
}

/* -------------------------------- 局部变换 -------------------------------- */

function clip(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, Math.max(2, max - 1)).join('')}…`
}

function shortenBlocks(blocks: Block[], only: Set<string>): Block[] {
  return blocks.map((block) => {
    if (block.type !== 'text') return block
    if (only.size > 0 && !only.has(block.id)) return block
    const ratio =
      block.variant === 'caption' ? 0.7 : block.variant === 'display' || block.variant === 'h1' ? 0.55 : 0.5
    return { ...block, text: clip(block.text, Math.max(6, Math.round(Array.from(block.text).length * ratio))) }
  })
}

function restyleBlocks(blocks: Block[]): Block[] {
  return blocks.map((block) => {
    if (block.type === 'text' && block.color === 'accent') return { ...block, color: 'accent2' as const }
    if (block.type === 'shape' && block.fill === 'accent') return { ...block, fill: 'accent2' as const }
    if (block.type === 'shape' && block.stroke === 'accent') return { ...block, stroke: 'accent2' as const }
    return block
  })
}

function translateBlocks(blocks: Block[], target: 'zh' | 'en'): Block[] {
  return blocks.map((block) => (block.type === 'text' ? { ...block, text: translateText(block.text, target) } : block))
}

function splitPipe(value: string): string[] {
  return value
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .split(/[｜|]/u)
    .map((part) => part.trim())
}

/** 把任意要点改写成「时间｜标题｜说明」。 */
function timelineNodes(points: string[]): string[] {
  return points.slice(0, 5).map((point, index) => {
    const parts = splitPipe(point)
    if (parts.length >= 3) return parts.join('｜')
    if (parts.length === 2) return `${parts[0]}｜${parts[1]}`
    const colon = point.split(/[：:]/)
    if (colon.length >= 2) return `${index + 1}｜${colon[0].trim()}｜${colon.slice(1).join('：').trim()}`
    return `${index + 1}｜${clip(point, 24)}`
  })
}

/** 把任意要点改写成「步骤｜说明」。 */
function processSteps(points: string[]): string[] {
  return points.slice(0, 5).map((point, index) => {
    const parts = splitPipe(point)
    if (parts.length >= 2) return parts.slice(0, 2).join('｜')
    const colon = point.split(/[：:]/)
    if (colon.length >= 2) return `${colon[0].trim()}｜${colon.slice(1).join('：').trim()}`
    return `${index + 1}｜${clip(point, 24)}`
  })
}

/** 把任意要点改写成「组名｜一句话」的左右对比。 */
function compareGroups(points: string[], lang: 'zh' | 'en'): string[] {
  const hasGroups = points.some((point) => splitPipe(point).length >= 2)
  if (hasGroups) return points.slice(0, 6)
  const left = lang === 'zh' ? '现在' : 'Today'
  const right = lang === 'zh' ? '之后' : 'After'
  const half = Math.ceil(points.length / 2)
  return [
    ...points.slice(0, half).map((point) => `${left}｜${point}`),
    ...points.slice(half).map((point) => `${right}｜${point}`),
  ].slice(0, 6)
}

/* ---------------------------------- 计划 ---------------------------------- */

function diffOf(before: Block[], after: Block[]): SlidePatchPlan['diff'] {
  const beforeMap = new Map(before.map((block) => [block.id, JSON.stringify(block)]))
  const afterMap = new Map(after.map((block) => [block.id, JSON.stringify(block)]))
  const removed = Array.from(beforeMap.keys()).filter((id) => !afterMap.has(id))
  const added = Array.from(afterMap.keys()).filter((id) => !beforeMap.has(id))
  const changed = Array.from(afterMap.keys()).filter(
    (id) => beforeMap.has(id) && beforeMap.get(id) !== afterMap.get(id),
  )
  return { removed, added, changed }
}

interface PlanCore {
  blocks: Block[]
  recipe: RecipeId
  summaryKey: string
  warnings: string[]
}

/** 规则 → 目标块集合。 */
async function buildByRules(
  intent: RefineIntent,
  ctx: { instruction: string; deck: Deck; slide: Slide; content: RecipeContent; blockIds?: string[] },
): Promise<PlanCore> {
  const theme = getTheme(ctx.deck.themeId)
  const content = ctx.content
  const points = (content.points ?? []).filter((point) => point.trim() !== '')
  const only = new Set(ctx.blockIds ?? [])
  const currentRecipe = (ctx.slide.recipe ?? 'grid3') as RecipeId

  switch (intent) {
    case 'shorter':
      return {
        blocks: shortenBlocks(ctx.slide.blocks, only),
        recipe: currentRecipe,
        summaryKey: 'ai.intent.shorter',
        warnings: [],
      }
    case 'translate':
      return {
        blocks: translateBlocks(ctx.slide.blocks, ctx.deck.lang === 'zh' ? 'en' : 'zh'),
        recipe: currentRecipe,
        summaryKey: 'ai.intent.translate',
        warnings: [],
      }
    case 'restyle':
      return {
        blocks: restyleBlocks(ctx.slide.blocks),
        recipe: currentRecipe,
        summaryKey: 'ai.intent.restyle',
        warnings: [],
      }
    case 'quieter':
      return {
        blocks: buildRecipe(
          'statement',
          { ...content, points: [], lead: content.lead ?? points[0] ?? undefined },
          theme,
        ),
        recipe: 'statement',
        summaryKey: 'ai.intent.quieter',
        warnings: [],
      }
    case 'timeline':
      return {
        blocks: buildRecipe('timeline', { ...content, points: timelineNodes(points) }, theme),
        recipe: 'timeline',
        summaryKey: 'ai.intent.timeline',
        warnings: [],
      }
    case 'process':
      return {
        blocks: buildRecipe('process', { ...content, points: processSteps(points) }, theme),
        recipe: 'process',
        summaryKey: 'ai.intent.process',
        warnings: [],
      }
    case 'compare':
      return {
        blocks: buildRecipe('compare', { ...content, points: compareGroups(points, content.lang) }, theme),
        recipe: 'compare',
        summaryKey: 'ai.intent.compare',
        warnings: [],
      }
    case 'grid': {
      const recipe: RecipeId = points.length > 3 ? 'grid4' : 'grid3'
      return {
        blocks: buildRecipe(recipe, { ...content, points: points.slice(0, 4) }, theme),
        recipe,
        summaryKey: 'ai.intent.grid',
        warnings: [],
      }
    }
    case 'addSvg': {
      const art = await generateSvgArt(content.headline)
      return {
        blocks: buildRecipe(
          'split',
          {
            ...content,
            points: points.slice(0, 3),
            visual: { kind: 'svg', source: art.source, viewBox: [0, 0, 820, 560], caption: content.headline },
          },
          theme,
        ),
        recipe: 'split',
        summaryKey: 'ai.intent.addSvg',
        warnings: art.provider.endsWith(':fallback') ? ['svg-fallback'] : [],
      }
    }
    case 'add3d': {
      const scene = await generateThreeScene(content.headline)
      return {
        blocks: buildRecipe('split', { ...content, points: points.slice(0, 3), visual: { kind: 'three', descriptor: scene.descriptor } }, theme),
        recipe: 'split',
        summaryKey: 'ai.intent.add3d',
        warnings: scene.provider.endsWith(':fallback') ? ['three-fallback'] : [],
      }
    }
    default:
      return { blocks: ctx.slide.blocks, recipe: currentRecipe, summaryKey: 'ai.intent.unknown', warnings: ['unknown-intent'] }
  }
}

/** LLM 增强：规则未命中且端点就绪时，请模型重写这一页的文案。 */
async function buildByModel(
  instruction: string,
  ctx: { deck: Deck; slide: Slide; content: RecipeContent; signal?: AbortSignal },
): Promise<PlanCore> {
  const provider = currentProvider()
  const theme = getTheme(ctx.deck.themeId)
  const recipe = (ctx.slide.recipe ?? 'grid3') as RecipeId
  const req = refineRequest({
    instruction,
    lang: ctx.content.lang,
    recipe,
    headline: ctx.content.headline,
    lead: ctx.content.lead,
    points: ctx.content.points ?? [],
  })
  const res = await provider.complete({ system: req.system, user: req.user, json: true, signal: ctx.signal })
  const parsed = await parseWithRepair(refineSchema, res.text, {
    signal: ctx.signal,
    repair:
      provider.id === 'openai'
        ? async (issues) => {
            const retry = await provider.complete({
              system: req.system,
              user: repairPrompt(req.user, issues),
              json: true,
              signal: ctx.signal,
            })
            return retry.text
          }
        : undefined,
  })
  const points = parsed.points.length > 0 ? parsed.points : ctx.content.points ?? []
  return {
    blocks: buildRecipe(recipe, { ...ctx.content, headline: parsed.headline, lead: parsed.lead ?? ctx.content.lead, points }, theme),
    recipe,
    summaryKey: 'ai.intent.rewrite',
    warnings: [],
  }
}

/** 自然语言局部指令 → 结构化 patch plan。 */
export async function refineSlide(
  instruction: string,
  ctx: { deck: Deck; slideId: string; blockIds?: string[]; signal?: AbortSignal },
): Promise<{ patch: SlidePatchPlan; provider: string }> {
  const slide = ctx.deck.slides.find((item) => item.id === ctx.slideId)
  if (!slide) throw new Error(`slide not found: ${ctx.slideId}`)
  const provider = currentProvider()
  const content = contentFromSlide(slide, ctx.deck.lang)
  const intent = detectRefineIntent(instruction)

  let core: PlanCore
  if (intent === 'unknown' && provider.id === 'openai') {
    try {
      core = await buildByModel(instruction, { deck: ctx.deck, slide, content, signal: ctx.signal })
    } catch (error) {
      if (isAborted(error)) throw error
      core = {
        blocks: slide.blocks,
        recipe: (slide.recipe ?? 'grid3') as RecipeId,
        summaryKey: 'ai.intent.unknown',
        warnings: [aiErrorMessage(error)],
      }
    }
  } else {
    core = await buildByRules(intent, {
      instruction,
      deck: ctx.deck,
      slide,
      content,
      blockIds: ctx.blockIds,
    })
  }

  const diff = diffOf(slide.blocks, core.blocks)
  const touched = new Set([...diff.added, ...diff.changed])
  const meta = {
    provider: provider.id,
    model: provider.id === 'openai' ? useSettingsStore.getState().llm.model : undefined,
    recipeId: core.recipe,
    promptDigest: shortHash(instruction),
  }
  const nextBlocks =
    touched.size === 0
      ? core.blocks
      : core.blocks.map((block) => (touched.has(block.id) ? stampBlocks([block], meta)[0] : block))

  const patch: SlidePatchPlan = {
    slideId: slide.id,
    intent,
    summaryKey: core.summaryKey,
    recipe: core.recipe,
    nextBlocks,
    diff,
    warnings: core.warnings,
    provider: provider.id,
  }
  return { patch, provider: provider.id }
}

/** 应用 patch plan（单步撤销）：调用方确认后调用。 */
export function applyRefinePlan(plan: SlidePatchPlan): void {
  const { removed, added, changed } = plan.diff
  if (removed.length === 0 && added.length === 0 && changed.length === 0) return
  historyOps.transaction('ai-refine', () => {
    if (removed.length > 0) blockOps.remove(removed, plan.slideId)
    for (const block of plan.nextBlocks) {
      if (added.includes(block.id)) blockOps.add(block, plan.slideId)
      else if (changed.includes(block.id)) blockOps.replace(block, plan.slideId)
    }
    if (plan.recipe) {
      slideOps.update(plan.slideId, (slide) => {
        slide.recipe = plan.recipe
      }, 'ai-refine-recipe')
    }
  })
}
