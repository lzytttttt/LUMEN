/**
 * recipes.ts —— 12 个版式配方（"AI 的品味"由这里决定）。
 *
 * 契约：
 * - 几何必须确定：1600×900、安全边距 120/96、12 列栅格 gap 24；
 * - 字号只用主题令牌（渲染侧 `--d-fs-*`），配方只管盒子；
 * - 内容只来自槽位（headline / lead / points / visual / caption），AI 永远不产出 CSS；
 * - 颜色只用 ColorToken，且用对比度兜底（不达标自动退回 fg），保证 6 套主题都合格；
 * - 任何缺项都有兜底文案，绝不抛错。
 */
import type {
  Block,
  ColorToken,
  RecipeId,
  ShapeBlock,
  SvgBlock,
  TextBlock,
  TextVariant,
  Theme,
  ThreeBlock,
} from '@/schema/deck'
import { SAFE_X, SAFE_Y, STAGE_W } from '@/schema/deck'
import { makeShape, makeSvg, makeText, makeThree } from '@/schema/factory'
import { aaThreshold, contrastRatio } from '@/lint/color'
import { estimateTextLayout } from '@/lint/measure'
import { textStyleOf } from '@/lint/deckLint'
import { plainText } from '@/render/text/markdown'
import { typeStyleOf } from '@/themes'
import { SVG_LIBRARY } from '@/studio/library'
import { mockSvgArt } from './art'
import type { RecipeContent, RecipeSlotSpec, RecipeVisual } from './types'

/* ------------------------------- 栅格常量 ------------------------------- */

const MARGIN_X = SAFE_X
const MARGIN_Y = SAFE_Y
const CONTENT_W = STAGE_W - MARGIN_X * 2
const GAP = 24
const COL_W = (CONTENT_W - GAP * 11) / 12

/** 12 列栅格：第 start 列起，跨 span 列。 */
function col(start: number, span: number): { x: number; w: number } {
  return { x: MARGIN_X + start * (COL_W + GAP), w: span * COL_W + (span - 1) * GAP }
}

/* ------------------------------- 排版工具 ------------------------------- */

function round(value: number): number {
  return Math.round(value)
}

/** 文本高度估计（与 lint 同一套测量，保证"配方排出来的盒子不会溢出"）。 */
function textHeight(value: string, width: number, variant: TextVariant, theme: Theme): number {
  const style = textStyleOf(theme, { variant })
  const layout = estimateTextLayout({
    text: plainText(value),
    width,
    height: 100_000,
    fontSize: style.size,
    lineHeight: style.lineHeight,
    letterSpacing: style.tracking,
    fontWeight: style.weight,
    fontFamily: style.family,
  })
  return layout.contentHeight
}

/** 单行文本的行盒高度（用于数字/短标签）。 */
function lineHeightOf(theme: Theme, variant: TextVariant): number {
  const style = typeStyleOf(theme, variant)
  return Math.ceil(style.size * style.lineHeight)
}

/** 高度不够就截断并加省略号（宁可少一个字，也不让块溢出）。 */
function fitText(value: string, width: number, maxHeight: number, variant: TextVariant, theme: Theme): string {
  if (value.trim() === '') return value
  if (maxHeight <= 0) return value
  if (textHeight(value, width, variant, theme) <= maxHeight) return value
  let text = value
  while (text.length > 1 && textHeight(`${text}…`, width, variant, theme) > maxHeight) {
    text = text.slice(0, -1)
  }
  return `${text.trimEnd()}…`
}

/** 对比度兜底：首选色不达标就退回 fg（避免 lint 对比度告警）。 */
function ink(theme: Theme, preferred: ColorToken, variant: TextVariant, weight?: number): ColorToken {
  const style = typeStyleOf(theme, variant)
  const ratio = contrastRatio(theme.colors[preferred], theme.colors.bg)
  const need = aaThreshold(style.size, weight ?? style.weight)
  if (ratio === null || ratio >= need) return preferred
  return 'fg'
}

/* ------------------------------ 标题字阶自适应 ------------------------------ */

const CJK_RE = /[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 等效全角字数：CJK 1 字、拉丁 0.55 字、空格 0.3 字（中英混排统一估算）。 */
function emWidth(text: string): number {
  let em = 0
  for (const char of text.replace(/\n/g, '')) {
    if (CJK_RE.test(char)) em += 1
    else if (/\s/.test(char)) em += 0.3
    else em += 0.55
  }
  return em
}

type Ladder = [maxEm: number, variant: TextVariant][]

/** 按长度在阶梯里选字阶：AI 不负责"自觉"，版式负责兜住。 */
function headlineVariant(text: string, ladder: Ladder): TextVariant {
  const em = emWidth(text)
  for (const [maxEm, variant] of ladder) if (em <= maxEm) return variant
  return ladder[ladder.length - 1][1]
}

/** 封面/收尾：≤10 字 display，11–18 字 h1，>18 字 h2。 */
const COVER_LADDER: Ladder = [
  [10, 'display'],
  [18, 'h1'],
  [Number.POSITIVE_INFINITY, 'h2'],
]

/** 主张页：>20 字降一档。 */
const STATEMENT_LADDER: Ladder = [
  [20, 'h1'],
  [Number.POSITIVE_INFINITY, 'h2'],
]

/** 引用页：>20 字降一档。 */
const QUOTE_LADDER: Ladder = [
  [20, 'display'],
  [Number.POSITIVE_INFINITY, 'h1'],
]

/** 内容页标题（900px 参考宽度）：>16 字降一档（h2 → lead + 600 字重）。 */
const TITLE_LADDER: Ladder = [
  [16, 'h2'],
  [Number.POSITIVE_INFINITY, 'lead'],
]

/** 标题块的最大高度：按该字阶的行数留足（至少 2 行，封面类 3 行）。 */
function headlineMaxH(theme: Theme, variant: TextVariant, lines: number): number {
  return Math.ceil(typeStyleOf(theme, variant).size * typeStyleOf(theme, variant).lineHeight) * lines
}

interface TextOpts {
  variant?: TextVariant
  color?: ColorToken
  align?: 'left' | 'center' | 'right'
  weight?: number
  maxH?: number
  enter?: TextBlock['enter']
  delay?: number
}

/** 文本块：位置由调用方给，高度由内容算。 */
function txt(value: string, box: { x: number; y: number; w: number }, theme: Theme, opts: TextOpts = {}): TextBlock {
  const variant = opts.variant ?? 'body'
  const color = ink(theme, opts.color ?? 'fg', variant, opts.weight)
  const text = opts.maxH ? fitText(value, box.w, opts.maxH, variant, theme) : value
  const style = typeStyleOf(theme, variant)
  const h = Math.max(lineHeightOf(theme, variant), Math.ceil(textHeight(text, box.w, variant, theme)) + 4)
  return makeText({
    text,
    x: round(box.x),
    y: round(box.y),
    w: round(box.w),
    h,
    variant,
    color,
    align: opts.align ?? 'left',
    weight: opts.weight,
    enter: opts.enter ?? 'none',
    enterDelayMs: opts.delay ?? 0,
  })
}

function panel(
  box: { x: number; y: number; w: number; h: number },
  theme: Theme,
  opts: { fill?: ColorToken; stroke?: ColorToken; radius?: number; strokeWidth?: number } = {},
): ShapeBlock {
  return makeShape({
    kind: 'rect',
    x: round(box.x),
    y: round(box.y),
    w: round(box.w),
    h: round(box.h),
    fill: opts.fill ?? 'surface',
    stroke: opts.stroke ?? 'line',
    strokeWidth: opts.strokeWidth ?? 1,
    radius: opts.radius ?? theme.radius,
  })
}

function rule(box: { x: number; y: number; w: number; h?: number }, color: ColorToken = 'accent'): ShapeBlock {
  return makeShape({
    kind: 'rule',
    x: round(box.x),
    y: round(box.y),
    w: round(box.w),
    h: box.h ?? 2,
    fill: color,
    strokeWidth: box.h ?? 2,
  })
}

function line(box: { x: number; y: number; w: number; h: number }, color: ColorToken = 'line'): ShapeBlock {
  // ShapeView 用 strokeWidth 决定线的高度，schema 上限 40；竖线请用 rect。
  const thickness = Math.min(40, Math.max(1, box.h))
  return makeShape({
    kind: 'line',
    x: round(box.x),
    y: round(box.y),
    w: round(box.w),
    h: round(box.h),
    fill: color,
    strokeWidth: thickness,
  })
}

/** 竖分隔线：用 1px 宽的 rect 画，避免 line 的高度语义。 */
function divider(box: { x: number; y: number; h: number }, color: ColorToken = 'line'): ShapeBlock {
  return makeShape({
    kind: 'rect',
    x: round(box.x),
    y: round(box.y),
    w: 1,
    h: round(box.h),
    fill: color,
  })
}

function dot(cx: number, cy: number, size: number, color: ColorToken): ShapeBlock {
  return makeShape({
    kind: 'ellipse',
    x: round(cx - size / 2),
    y: round(cy - size / 2),
    w: round(size),
    h: round(size),
    fill: color,
  })
}

/** 视觉块：svg 按 viewBox 比例放进给定盒子并垂直居中；three 直接铺满。 */
function visualBlock(visual: RecipeVisual | undefined, box: { x: number; y: number; w: number; h: number }): Block | null {
  if (!visual || visual.kind === 'none') return null
  if (visual.kind === 'three' && visual.descriptor) {
    return makeThree({
      x: round(box.x),
      y: round(box.y),
      w: round(box.w),
      h: round(box.h),
      descriptor: visual.descriptor,
    }) as ThreeBlock
  }
  if (visual.kind === 'svg' && visual.source) {
    const vb = visual.viewBox ?? [0, 0, 800, 600]
    const ratio = vb[3] / vb[2]
    const w = box.w
    const h = Math.min(box.h, w * ratio)
    const actualW = h === box.h ? Math.min(box.w, box.h / ratio) : w
    return makeSvg({
      x: round(box.x + (box.w - actualW) / 2),
      y: round(box.y + (box.h - h) / 2),
      w: round(actualW),
      h: round(h),
      source: visual.source,
      viewBox: vb,
      animate: 'float',
    }) as SvgBlock
  }
  return null
}

/** z 序按数组顺序落定，避免同 z 时顺序随机。 */
function tidy(blocks: (Block | null)[]): Block[] {
  return blocks.filter((block): block is Block => block !== null).map((block, index) => ({ ...block, z: index + 1 }))
}

/* ------------------------------ 内容解析工具 ------------------------------ */

function stripBold(value: string): string {
  return value.replace(/\*\*([^*]+)\*\*/g, '$1').trim()
}

/** 拆「A｜B｜C」结构（全角/半角竖线都认）。 */
function splitPipe(value: string): string[] {
  return stripBold(value)
    .split(/[｜|]/u)
    .map((part) => part.trim())
}

/** 卡片：`**标签**：正文` 或 `标签：正文`。 */
function parseCard(value: string, lang: 'zh' | 'en'): { label: string; body: string } {
  const bold = /^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/u.exec(value.trim())
  if (bold) return { label: bold[1].trim(), body: bold[2].trim() }
  const plain = /^([^：:]{1,14})\s*[：:]\s*(.+)$/u.exec(stripBold(value))
  if (plain) return { label: plain[1].trim(), body: plain[2].trim() }
  const text = stripBold(value)
  return { label: text.slice(0, lang === 'zh' ? 8 : 22), body: text.slice(lang === 'zh' ? 8 : 22).trim() }
}

interface DataPoint {
  label: string
  value: number
  suffix: string
}

/** 数据页要点：`标签=数值` / `标签：数值` / `标签 数值`。 */
function parseDataPoints(points: string[]): DataPoint[] {
  const out: DataPoint[] = []
  for (const raw of points) {
    const text = stripBold(raw)
    const match =
      /^(.+?)\s*[=＝]\s*([\d.]+)\s*(%?)$/u.exec(text) ??
      /^(.+?)\s*[：:]\s*([\d.]+)\s*(%?)$/u.exec(text) ??
      /^(.+?)\s+([\d.]+)\s*(%?)$/u.exec(text)
    if (!match) continue
    const value = Number.parseFloat(match[2])
    if (!Number.isFinite(value)) continue
    out.push({ label: match[1].trim(), value, suffix: match[3] || '' })
  }
  return out
}

/* -------------------------------- 兜底文案 -------------------------------- */

const FALLBACK: Record<RecipeId, Record<'zh' | 'en', { headline: string; lead?: string; points?: string[] }>> = {
  cover: {
    zh: { headline: '未命名主题', lead: '一句话，一套演示。' },
    en: { headline: 'Untitled talk', lead: 'One sentence in, one deck out.' },
  },
  statement: {
    zh: { headline: '把话说短，\n把事说清。', lead: '演示不是把信息搬上台，而是把结论交出去。' },
    en: { headline: 'Say it shorter.\nMake it land.', lead: 'A deck is not a document. It is a conclusion.' },
  },
  split: {
    zh: {
      headline: '为什么是现在',
      lead: '先讲清约束，再谈方案。',
      points: ['**边界**：必须做什么，明确不做什么。', '**代价**：每个选择要付什么。', '**验证**：怎么证明它成立。'],
    },
    en: {
      headline: 'Why now',
      lead: 'Constraints first, then the plan.',
      points: ['**Boundary**: what we must do, and what we refuse to do.', '**Cost**: what each choice takes.', '**Proof**: how we will know it works.'],
    },
  },
  grid3: {
    zh: { headline: '三个关键判断', points: ['**问题**：谁在为什么付钱。', '**变化**：今天之后哪里不一样。', '**证据**：一个能被复述的细节。'] },
    en: { headline: 'Three key judgements', points: ['**Problem**: who pays, and for what.', '**Change**: what is different after today.', '**Proof**: one detail people can repeat.'] },
  },
  grid4: {
    zh: { headline: '四条要点', points: ['先把结论说清。', '再给一个证据。', '然后讲代价。', '最后留一个动作。'] },
    en: { headline: 'Four points', points: ['Land the conclusion.', 'Give one proof.', 'Name the cost.', 'Leave one action.'] },
  },
  timeline: {
    zh: { headline: '关键节点', points: ['01｜起点｜先定一句话', '02｜推进｜把主线跑通', '03｜收尾｜留下一个动作'] },
    en: { headline: 'Key moments', points: ['01｜Start｜One sentence first', '02｜Build｜Make the main path run', '03｜Close｜Leave one action'] },
  },
  compare: {
    zh: { headline: '两种做法', points: ['现在｜改一页要重排', '现在｜问题靠人盯', '之后｜改一处全篇更新', '之后｜问题在检查阶段暴露'] },
    en: { headline: 'Two ways', points: ['Today｜Every edit a rebuild', 'Today｜Problems caught by people', 'After｜Edit once, update everywhere', 'After｜Problems surface in checks'] },
  },
  quote: {
    zh: { headline: '把页面交出去，\n还是把体验交出去？', lead: 'LUMEN 设计原则 · P6 同一渲染器' },
    en: { headline: 'Hand over a page,\nor an experience?', lead: 'LUMEN design principle · P6 One renderer' },
  },
  data: {
    zh: {
      headline: '同一份内容，不同载体',
      lead: '示意数据：用于说明差异，非严谨统计。',
      points: ['纯文字=10%', '图文=35%', '动图=65%', '可交互=90%'],
    },
    en: {
      headline: 'Same content, different media',
      lead: 'Illustrative figures, not a rigorous study.',
      points: ['Text only=10%', 'Text + image=35%', 'Motion=65%', 'Interactive=90%'],
    },
  },
  process: {
    zh: { headline: '四步推进', points: ['01｜明确目标｜先对齐结论', '02｜做出样板｜跑通一条主路径', '03｜验证取舍｜看指标有没有变', '04｜收尾｜留下一个动作'] },
    en: { headline: 'Four steps', points: ['01｜Align｜Agree on the conclusion', '02｜Prototype｜Make one path run', '03｜Verify｜Watch the metric', '04｜Close｜Leave one action'] },
  },
  gallery: {
    zh: { headline: '三种画面', points: ['开场：一个瞬间', '中段：结构摊开', '收尾：留一个动作'] },
    en: { headline: 'Three images', points: ['Open: one moment', 'Middle: the structure', 'Close: one action'] },
  },
  closing: {
    zh: { headline: '下一步，只有一件事', lead: '把最强的一幕，做成能跑的东西。' },
    en: { headline: 'One next step', lead: 'Make your strongest moment run.' },
  },
}

/** 兜底填充：内容缺项时用占位文案，永不抛错。 */
export function fillContent(id: RecipeId, content: RecipeContent): RecipeContent {
  const fallback = FALLBACK[id][content.lang] ?? FALLBACK[id].zh
  const points = (content.points ?? []).filter((point) => point.trim() !== '')
  return {
    ...content,
    headline: content.headline?.trim() ? content.headline : fallback.headline,
    lead: content.lead?.trim() ? content.lead : fallback.lead,
    points: points.length > 0 ? points : fallback.points,
  }
}

/* -------------------------------- 配方实现 -------------------------------- */

export interface Recipe {
  id: RecipeId
  slots: RecipeSlotSpec[]
  build(content: RecipeContent, theme: Theme): Block[]
}

const HEADLINE_SLOTS: RecipeSlotSpec[] = [
  { key: 'headline', required: true },
  { key: 'lead' },
  { key: 'points', max: 5 },
  { key: 'visual' },
  { key: 'caption' },
]

function defaultFoot(lang: 'zh' | 'en'): string {
  return lang === 'zh' ? '1600 × 900 · 无插件 · 双击即播' : '1600 × 900 · No plugins · Double-click to present'
}

function defaultKicker(lang: 'zh' | 'en'): string {
  return lang === 'zh' ? 'LUMEN · 幕光 · AI 原生演示' : 'LUMEN · AI-native decks'
}

function defaultConclusion(lang: 'zh' | 'en'): string {
  return lang === 'zh'
    ? '能被记住的不是信息量，\n而是**可操作的体验**。'
    : 'What sticks is not the volume —\nit is the **manipulable experience**.'
}

function conclusionTitle(lang: 'zh' | 'en'): string {
  return lang === 'zh' ? '结论' : 'The point'
}

/** 内容页通用头部：标题 + 副标题，返回内容起始 y。 */
function header(content: RecipeContent, theme: Theme, width = 900): { blocks: Block[]; top: number } {
  const variant = headlineVariant(content.headline, TITLE_LADDER)
  const compact = variant === 'lead'
  const headline = txt(content.headline, { x: MARGIN_X, y: 136, w: width }, theme, {
    variant,
    weight: compact ? 600 : undefined,
    maxH: headlineMaxH(theme, variant, 2),
  })
  const blocks: Block[] = [headline]
  let bottom = headline.y + headline.h
  if (content.lead) {
    const lead = txt(content.lead, { x: MARGIN_X, y: bottom + 10, w: width }, theme, {
      variant: 'caption',
      color: 'muted',
      maxH: lineHeightOf(theme, 'caption') * 2,
    })
    blocks.push(lead)
    bottom = lead.y + lead.h
  }
  return { blocks, top: Math.min(340, Math.max(288, bottom + 40)) }
}

/** 把一组块在 [bandTop, bandBottom] 里垂直居中（只下移，不越过顶部元素）。 */
function centerGroup(blocks: Block[], bandTop: number, bandBottom: number): void {
  if (blocks.length === 0) return
  const top = Math.min(...blocks.map((block) => block.y))
  const bottom = Math.max(...blocks.map((block) => block.y + block.h))
  const delta = Math.round((bandBottom - bandTop - (bottom - top)) / 2) - (top - bandTop)
  if (delta <= 0) return
  for (const block of blocks) block.y += delta
}

/* --------------------------------- cover --------------------------------- */

const cover: Recipe = {
  id: 'cover',
  slots: HEADLINE_SLOTS,
  build(content, theme) {
    const c = fillContent('cover', content)
    const hasVisual = !!c.visual && c.visual.kind !== 'none'
    const blocks: (Block | null)[] = []
    blocks.push(
      txt(c.kicker ?? defaultKicker(c.lang), { x: MARGIN_X, y: 176, w: 620 }, theme, {
        variant: 'caption',
        color: 'accent',
        maxH: lineHeightOf(theme, 'caption'),
      }),
    )

    // 标题字阶按长度自适应，整组再在安全区里垂直居中（标题短时不至于全部挤在顶部）。
    const variant = headlineVariant(c.headline, COVER_LADDER)
    const group: Block[] = []
    const headline = txt(c.headline, { x: MARGIN_X, y: 224, w: hasVisual ? 720 : 1120 }, theme, {
      variant,
      maxH: headlineMaxH(theme, variant, 3),
    })
    group.push(headline)
    const ruleY = headline.y + headline.h + 32
    group.push(rule({ x: MARGIN_X, y: ruleY, w: 96 }))
    if (c.lead) {
      group.push(
        txt(c.lead, { x: MARGIN_X, y: ruleY + 32, w: hasVisual ? 660 : 900 }, theme, {
          variant: 'lead',
          color: 'muted',
          maxH: lineHeightOf(theme, 'lead') * 3,
        }),
      )
    }
    centerGroup(group, 200, 700)
    blocks.push(...group)

    blocks.push(
      txt(c.caption ?? defaultFoot(c.lang), { x: MARGIN_X, y: 780, w: 640 }, theme, {
        variant: 'caption',
        color: 'muted',
        maxH: lineHeightOf(theme, 'caption'),
      }),
    )
    if (hasVisual) {
      const box =
        c.visual?.kind === 'three'
          ? { x: 900, y: 110, w: 580, h: 680 }
          : { x: 860, y: 120, w: 620, h: 660 }
      blocks.push(visualBlock(c.visual, box))
    }
    return tidy(blocks)
  },
}

/* ------------------------------- statement ------------------------------- */

const statement: Recipe = {
  id: 'statement',
  slots: HEADLINE_SLOTS,
  build(content, theme) {
    const c = fillContent('statement', content)
    const blocks: (Block | null)[] = []
    const variant = headlineVariant(c.headline, STATEMENT_LADDER)
    const headline = txt(c.headline, { x: MARGIN_X, y: 250, w: CONTENT_W }, theme, {
      variant,
      align: 'center',
      maxH: headlineMaxH(theme, variant, 3),
    })
    blocks.push(headline)
    const ruleY = headline.y + headline.h + 40
    blocks.push(rule({ x: STAGE_W / 2 - 40, y: ruleY, w: 80 }))
    if (c.lead) {
      blocks.push(
        txt(c.lead, { x: MARGIN_X, y: ruleY + 34, w: CONTENT_W }, theme, {
          variant: 'lead',
          color: 'muted',
          align: 'center',
          maxH: lineHeightOf(theme, 'lead') * 2,
        }),
      )
    }
    return tidy(blocks)
  },
}

/* --------------------------------- split --------------------------------- */

const split: Recipe = {
  id: 'split',
  slots: HEADLINE_SLOTS,
  build(content, theme) {
    const c = fillContent('split', content)
    const hasVisual = !!c.visual && c.visual.kind !== 'none'
    const textW = hasVisual ? 520 : 640
    const blocks: (Block | null)[] = []
    const titleVariant = headlineVariant(c.headline, TITLE_LADDER)
    const headline = txt(c.headline, { x: MARGIN_X, y: 148, w: hasVisual ? 520 : 1160 }, theme, {
      variant: titleVariant,
      weight: titleVariant === 'lead' ? 600 : undefined,
      maxH: headlineMaxH(theme, titleVariant, 2),
    })
    blocks.push(headline)
    let cursor = headline.y + headline.h
    if (c.lead) {
      const lead = txt(c.lead, { x: MARGIN_X, y: cursor + 12, w: hasVisual ? 520 : 1160 }, theme, {
        variant: 'caption',
        color: 'muted',
        maxH: lineHeightOf(theme, 'caption') * 2,
      })
      blocks.push(lead)
      cursor = lead.y + lead.h
    }
    const points = (c.points ?? []).slice(0, hasVisual ? 3 : 4)
    const startY = Math.max(296, cursor + 44)
    if (hasVisual) {
      // 动态分配每条要点的可用高度，保证 3 条要点 + 页脚永远不重叠。
      const areaBottom = 632
      const gap = 26
      const maxPer = Math.max(
        lineHeightOf(theme, 'body') * 2,
        Math.floor((areaBottom - startY - gap * Math.max(points.length - 1, 0)) / Math.max(points.length, 1)),
      )
      let pointY = startY
      for (const point of points) {
        const block = txt(point, { x: MARGIN_X, y: pointY, w: textW }, theme, {
          variant: 'body',
          maxH: maxPer,
        })
        blocks.push(block)
        pointY = block.y + block.h + gap
      }
      blocks.push(line({ x: MARGIN_X, y: 660, w: 520, h: 1 }))
      blocks.push(
        txt(c.caption ?? (c.lang === 'zh' ? '改一处，全篇更新。' : 'Edit once, update everywhere.'), {
          x: MARGIN_X,
          y: 684,
          w: 520,
        }, theme, {
          variant: 'body',
          color: 'accent',
          maxH: lineHeightOf(theme, 'body'),
        }),
      )
    } else {
      const perColumn = Math.ceil(points.length / 2)
      points.forEach((point, index) => {
        const column = index < perColumn ? 0 : 1
        const row = index < perColumn ? index : index - perColumn
        const x = column === 0 ? MARGIN_X : MARGIN_X + 640 + 40
        const block = txt(point, { x, y: startY + row * 140, w: 640 }, theme, {
          variant: 'body',
          maxH: lineHeightOf(theme, 'body') * 3,
        })
        blocks.push(block)
      })
      blocks.push(line({ x: MARGIN_X, y: 660, w: CONTENT_W, h: 1 }))
    }
    if (hasVisual) {
      const box = c.visual?.kind === 'three' ? { x: 720, y: 110, w: 760, h: 680 } : { x: 740, y: 120, w: 740, h: 660 }
      blocks.push(visualBlock(c.visual, box))
    }
    return tidy(blocks)
  },
}

/* -------------------------------- 卡片网格 -------------------------------- */

function cardGrid(id: 'grid3' | 'grid4', count: number): Recipe {
  return {
    id,
    slots: HEADLINE_SLOTS,
    build(content, theme) {
      const c = fillContent(id, content)
      const head = header(c, theme)
      const blocks: (Block | null)[] = [...head.blocks]
      const cards = (c.points ?? []).slice(0, count)
      const cardW = (CONTENT_W - GAP * (count - 1)) / count
      const cardY = head.top
      const cardH = 300
      cards.forEach((point, index) => {
        const x = MARGIN_X + index * (cardW + GAP)
        const card = parseCard(point, c.lang)
        blocks.push(panel({ x, y: cardY, w: cardW, h: cardH }, theme))
        blocks.push(
          txt(`0${index + 1}`, { x: x + 28, y: cardY + 26, w: cardW - 56 }, theme, {
            variant: 'caption',
            color: 'accent',
            maxH: lineHeightOf(theme, 'caption'),
            enter: 'rise',
            delay: index * 60,
          }),
        )
        const label = txt(card.label, { x: x + 28, y: cardY + 64, w: cardW - 56 }, theme, {
          variant: 'h2',
          maxH: lineHeightOf(theme, 'h2') * 2,
          enter: 'rise',
          delay: index * 60,
        })
        blocks.push(label)
        if (card.body) {
          blocks.push(
            txt(card.body, { x: x + 28, y: label.y + label.h + 14, w: cardW - 56 }, theme, {
              variant: 'body',
              color: 'muted',
              maxH: cardY + cardH - (label.y + label.h + 14) - 24,
              enter: 'rise',
              delay: index * 60,
            }),
          )
        }
      })
      blocks.push(
        txt(c.caption ?? (c.lang === 'zh' ? '所有要点都能继续被拖动、改写。' : 'Every point stays editable.'), {
          x: MARGIN_X,
          y: cardY + cardH + 36,
          w: 900,
        }, theme, {
          variant: 'caption',
          color: 'muted',
          maxH: lineHeightOf(theme, 'caption'),
        }),
      )
      return tidy(blocks)
    },
  }
}

const grid3 = cardGrid('grid3', 3)
const grid4 = cardGrid('grid4', 4)

/* -------------------------------- timeline -------------------------------- */

const timeline: Recipe = {
  id: 'timeline',
  slots: HEADLINE_SLOTS,
  build(content, theme) {
    const c = fillContent('timeline', content)
    const head = header(c, theme)
    const blocks: (Block | null)[] = [...head.blocks]
    const nodes = (c.points ?? []).slice(0, 5)
    const axisY = 462
    blocks.push(line({ x: MARGIN_X, y: axisY, w: CONTENT_W, h: 1 }))
    const step = CONTENT_W / Math.max(nodes.length, 1)
    nodes.forEach((point, index) => {
      const parts = splitPipe(point)
      const marker = parts.length >= 3 ? parts[0] : parts.length === 2 ? parts[0] : `0${index + 1}`
      const name = parts.length >= 3 ? parts[1] : parts.length === 2 ? parts[1] : parts[0]
      const desc = parts.length >= 3 ? parts.slice(2).join('｜') : ''
      const cx = MARGIN_X + (index + 0.5) * step
      const w = Math.min(240, step - 24)
      blocks.push(dot(cx, axisY, 18, 'accent'))
      blocks.push(
        txt(marker, { x: cx - w / 2, y: axisY - 78, w }, theme, {
          variant: 'h2',
          color: 'accent',
          align: 'center',
          maxH: lineHeightOf(theme, 'h2'),
          enter: 'rise',
          delay: index * 70,
        }),
      )
      const nameBlock = txt(name, { x: cx - w / 2, y: axisY + 36, w }, theme, {
        variant: 'body',
        align: 'center',
        weight: 600,
        maxH: lineHeightOf(theme, 'body') * 2,
        enter: 'rise',
        delay: index * 70,
      })
      blocks.push(nameBlock)
      if (desc) {
        blocks.push(
          txt(desc, { x: cx - w / 2, y: nameBlock.y + nameBlock.h + 8, w }, theme, {
            variant: 'caption',
            color: 'muted',
            align: 'center',
            maxH: lineHeightOf(theme, 'caption') * 4,
            enter: 'rise',
            delay: index * 70,
          }),
        )
      }
    })
    return tidy(blocks)
  },
}

/* --------------------------------- compare --------------------------------- */

const compare: Recipe = {
  id: 'compare',
  slots: HEADLINE_SLOTS,
  build(content, theme) {
    const c = fillContent('compare', content)
    const head = header(c, theme)
    const blocks: (Block | null)[] = [...head.blocks]
    const points = (c.points ?? []).slice(0, 6)
    const grouped = new Map<string, string[]>()
    for (const point of points) {
      const parts = splitPipe(point)
      if (parts.length >= 2) {
        const key = parts[0]
        const list = grouped.get(key) ?? []
        list.push(parts.slice(1).join('｜'))
        grouped.set(key, list)
      }
    }
    const topY = Math.max(270, head.top - 18)
    let leftTitle = c.lang === 'zh' ? '现在的做法' : 'Today'
    let rightTitle = c.lang === 'zh' ? '方案里的做法' : 'With the plan'
    let leftItems: string[] = []
    let rightItems: string[] = []
    if (grouped.size >= 2) {
      const keys = Array.from(grouped.keys())
      leftTitle = keys[0]
      rightTitle = keys[1]
      leftItems = grouped.get(keys[0]) ?? []
      rightItems = grouped.get(keys[1]) ?? []
    } else {
      const half = Math.ceil(points.length / 2)
      leftItems = points.slice(0, half).map(stripBold)
      rightItems = points.slice(half).map(stripBold)
    }
    blocks.push(
      txt(leftTitle, { x: MARGIN_X, y: topY, w: 600 }, theme, {
        variant: 'h2',
        color: 'muted',
        maxH: lineHeightOf(theme, 'h2'),
      }),
    )
    blocks.push(
      txt(rightTitle, { x: 860, y: topY, w: 600 }, theme, {
        variant: 'h2',
        color: 'accent',
        maxH: lineHeightOf(theme, 'h2'),
      }),
    )
    blocks.push(divider({ x: 800, y: topY - 12, h: 360 }))
    leftItems.slice(0, 3).forEach((item, index) => {
      blocks.push(
        txt(item, { x: MARGIN_X, y: topY + 86 + index * 84, w: 620 }, theme, {
          variant: 'body',
          color: 'muted',
          maxH: lineHeightOf(theme, 'body') * 2,
          enter: 'rise',
          delay: index * 60,
        }),
      )
    })
    rightItems.slice(0, 3).forEach((item, index) => {
      blocks.push(
        txt(item, { x: 860, y: topY + 86 + index * 84, w: 600 }, theme, {
          variant: 'body',
          maxH: lineHeightOf(theme, 'body') * 2,
          enter: 'rise',
          delay: index * 60,
        }),
      )
    })
    blocks.push(
      txt(c.caption ?? (c.lang === 'zh' ? '同一份内容，两种交付方式。' : 'One story, two ways to hand it over.'), {
        x: MARGIN_X,
        y: 700,
        w: 900,
      }, theme, {
        variant: 'caption',
        color: 'muted',
        maxH: lineHeightOf(theme, 'caption'),
      }),
    )
    return tidy(blocks)
  },
}

/* ---------------------------------- quote ---------------------------------- */

const quote: Recipe = {
  id: 'quote',
  slots: HEADLINE_SLOTS,
  build(content, theme) {
    const c = fillContent('quote', content)
    const blocks: (Block | null)[] = []
    const variant = headlineVariant(c.headline, QUOTE_LADDER)
    const headline = txt(c.headline, { x: MARGIN_X, y: 250, w: CONTENT_W }, theme, {
      variant,
      align: 'center',
      maxH: headlineMaxH(theme, variant, 3),
    })
    blocks.push(headline)
    const ruleY = headline.y + headline.h + 44
    blocks.push(rule({ x: STAGE_W / 2 - 40, y: ruleY, w: 80 }))
    if (c.lead) {
      blocks.push(
        txt(c.lead, { x: MARGIN_X, y: ruleY + 32, w: CONTENT_W }, theme, {
          variant: 'caption',
          color: 'muted',
          align: 'center',
          maxH: lineHeightOf(theme, 'caption') * 2,
        }),
      )
    }
    return tidy(blocks)
  },
}

/* ---------------------------------- data ---------------------------------- */

/** 环形图（令牌色，纯 SVG，无脚本）。 */
function donutSource(points: DataPoint[]): { source: string; viewBox: [number, number, number, number] } {
  const total = points.reduce((sum, point) => sum + point.value, 0) || 1
  const size = 420
  const cx = size / 2
  const cy = size / 2
  const r = 150
  const circumference = 2 * Math.PI * r
  const colors: ColorToken[] = ['accent', 'accent2', 'muted', 'fg', 'line']
  let offset = 0
  const segments = points.map((point, index) => {
    const length = (point.value / total) * circumference
    const segment = `<circle cx="${cx}" cy="${cy}" r="${r}" stroke="var(--d-${colors[index % colors.length]})" stroke-width="34" fill="none" stroke-dasharray="${length.toFixed(1)} ${(circumference - length).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`
    offset += length
    return segment
  })
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" fill="none">
  <circle cx="${cx}" cy="${cy}" r="${r}" stroke="var(--d-line)" stroke-width="34" fill="none"/>
  ${segments.join('\n  ')}
  <circle cx="${cx}" cy="${cy}" r="104" stroke="var(--d-line)" stroke-width="1" fill="none"/>
</svg>`
  return { source, viewBox: [0, 0, size, size] }
}

const data: Recipe = {
  id: 'data',
  slots: HEADLINE_SLOTS,
  build(content, theme) {
    const c = fillContent('data', content)
    const head = header(c, theme)
    const blocks: (Block | null)[] = [...head.blocks]
    const points = parseDataPoints(c.points ?? []).slice(0, 5)
    const values = points.length >= 2 ? points : parseDataPoints(FALLBACK.data[c.lang].points ?? [])
    const percentLike = values.every((point) => point.suffix === '%')
    const totalValue = values.reduce((sum, point) => sum + point.value, 0)
    const useDonut = percentLike && values.length <= 5 && totalValue >= 70 && totalValue <= 130

    if (useDonut) {
      const chart = donutSource(values)
      const chartY = Math.min(290, Math.max(258, head.top - 26))
      const chartSize = 360
      blocks.push(
        makeSvg({
          x: MARGIN_X,
          y: chartY,
          w: chartSize,
          h: chartSize,
          source: chart.source,
          viewBox: chart.viewBox,
        }),
      )
      // 图例放在环的右侧，避免压住图形；数值右对齐在结论面板之前收口。
      values.forEach((point, index) => {
        const rowY = chartY + 44 + index * 72
        blocks.push(dot(540, rowY + 12, 14, index === 0 ? 'accent' : index === 1 ? 'accent2' : 'muted'))
        blocks.push(
          txt(point.label, { x: 564, y: rowY, w: 200 }, theme, {
            variant: 'body',
            maxH: lineHeightOf(theme, 'body'),
            enter: 'rise',
            delay: index * 60,
          }),
        )
        blocks.push(
          txt(`${point.value}${point.suffix}`, { x: 770, y: rowY, w: 100 }, theme, {
            variant: 'h2',
            color: index === 0 ? 'accent' : 'fg',
            align: 'right',
            maxH: lineHeightOf(theme, 'h2'),
            enter: 'rise',
            delay: index * 60,
          }),
        )
      })
    } else {
      const maxValue = Math.max(...values.map((point) => point.value), 1)
      const baseline = 700
      const chartTop = 320
      const chartH = baseline - chartTop
      const barGap = 56
      const barW = Math.min(120, (820 - (values.length - 1) * barGap) / values.length)
      for (let i = 1; i <= 3; i += 1) {
        const y = baseline - (chartH * i) / 3
        blocks.push(line({ x: MARGIN_X, y, w: 820, h: 1 }, 'line'))
      }
      values.forEach((point, index) => {
        const x = MARGIN_X + index * (barW + barGap)
        const h = Math.max(6, (point.value / maxValue) * chartH)
        const barTop = baseline - h
        blocks.push(
          makeShape({
            kind: 'rect',
            x: round(x),
            y: round(barTop),
            w: round(barW),
            h: round(h),
            fill: index === values.length - 1 ? 'accent' : index === 0 ? 'muted' : 'accent2',
            radius: 4,
            enter: 'rise',
            enterDelayMs: index * 60,
          }),
        )
        blocks.push(
          txt(`${point.value}${point.suffix}`, { x: x - 20, y: barTop - 46, w: barW + 40 }, theme, {
            variant: 'h2',
            color: index === values.length - 1 ? 'accent' : 'fg',
            align: 'center',
            maxH: lineHeightOf(theme, 'h2'),
            enter: 'rise',
            delay: index * 60,
          }),
        )
        blocks.push(
          txt(point.label, { x: x - 20, y: baseline + 14, w: barW + 40 }, theme, {
            variant: 'caption',
            color: 'muted',
            align: 'center',
            maxH: lineHeightOf(theme, 'caption') * 2,
          }),
        )
      })
    }

    blocks.push(
      txt(conclusionTitle(c.lang), { x: 1000, y: 300, w: 480 }, theme, {
        variant: 'h2',
        color: 'accent',
        maxH: lineHeightOf(theme, 'h2'),
      }),
    )
    const conclusion = txt(c.caption ?? defaultConclusion(c.lang), { x: 1000, y: 368, w: 480 }, theme, {
      variant: 'lead',
      maxH: lineHeightOf(theme, 'lead') * 4,
    })
    blocks.push(conclusion)
    blocks.push(line({ x: 1000, y: conclusion.y + conclusion.h + 28, w: 120, h: 1 }))
    blocks.push(
      txt(c.lead ?? (c.lang === 'zh' ? '示意数据：用于说明差异，非严谨统计。' : 'Illustrative figures, not a rigorous study.'), {
        x: 1000,
        y: conclusion.y + conclusion.h + 56,
        w: 480,
      }, theme, {
        variant: 'caption',
        color: 'muted',
        maxH: lineHeightOf(theme, 'caption') * 3,
      }),
    )
    return tidy(blocks)
  },
}

/* --------------------------------- process --------------------------------- */

const process: Recipe = {
  id: 'process',
  slots: HEADLINE_SLOTS,
  build(content, theme) {
    const c = fillContent('process', content)
    const head = header(c, theme)
    const blocks: (Block | null)[] = [...head.blocks]
    const steps = (c.points ?? []).slice(0, 5)
    const count = Math.max(steps.length, 1)
    const panelW = (CONTENT_W - GAP * (count - 1)) / count
    const panelY = Math.max(head.top, 320)
    const panelH = 220
    steps.forEach((point, index) => {
      const parts = splitPipe(point)
      const marker = parts.length >= 3 ? parts[0] : `0${index + 1}`
      const label = parts.length >= 3 ? parts[1] : parts.length === 2 ? parts[0] : parts[0]
      const desc = parts.length >= 3 ? parts.slice(2).join('｜') : parts.length === 2 ? parts[1] : ''
      const x = MARGIN_X + index * (panelW + GAP)
      blocks.push(panel({ x, y: panelY, w: panelW, h: panelH }, theme))
      blocks.push(
        txt(marker, { x: x + 24, y: panelY + 24, w: panelW - 48 }, theme, {
          variant: 'caption',
          color: 'accent',
          maxH: lineHeightOf(theme, 'caption'),
          enter: 'rise',
          delay: index * 60,
        }),
      )
      const labelBlock = txt(label, { x: x + 24, y: panelY + 56, w: panelW - 48 }, theme, {
        variant: 'h2',
        maxH: lineHeightOf(theme, 'h2') * 2,
        enter: 'rise',
        delay: index * 60,
      })
      blocks.push(labelBlock)
      if (desc) {
        blocks.push(
          txt(desc, { x: x + 24, y: labelBlock.y + labelBlock.h + 14, w: panelW - 48 }, theme, {
            variant: 'caption',
            color: 'muted',
            maxH: panelY + panelH - (labelBlock.y + labelBlock.h + 14) - 24,
            enter: 'rise',
            delay: index * 60,
          }),
        )
      }
      if (index < steps.length - 1) {
        blocks.push(
          makeShape({
            kind: 'triangle',
            x: round(x + panelW + 4),
            y: round(panelY + panelH / 2 - 10),
            w: 16,
            h: 20,
            fill: 'muted',
            rotation: 90,
          }),
        )
      }
    })
    blocks.push(
      txt(c.caption ?? (c.lang === 'zh' ? '每一步都要有可验收的产出。' : 'Every step needs a verifiable output.'), {
        x: MARGIN_X,
        y: panelY + panelH + 44,
        w: 900,
      }, theme, {
        variant: 'caption',
        color: 'muted',
        maxH: lineHeightOf(theme, 'caption'),
      }),
    )
    return tidy(blocks)
  },
}

/* --------------------------------- gallery --------------------------------- */

const gallery: Recipe = {
  id: 'gallery',
  slots: HEADLINE_SLOTS,
  build(content, theme) {
    const c = fillContent('gallery', content)
    const head = header(c, theme)
    const blocks: (Block | null)[] = [...head.blocks]
    const captions = (c.points ?? []).slice(0, 3)
    const count = Math.max(captions.length, 1)
    const cardW = (CONTENT_W - GAP * (count - 1)) / count
    const cardY = Math.max(head.top, 300)
    const cardH = 420
    const library = SVG_LIBRARY.length > 0 ? SVG_LIBRARY : []
    captions.forEach((caption, index) => {
      const x = MARGIN_X + index * (cardW + GAP)
      const item = library[index % Math.max(library.length, 1)]
      const art = item
        ? { source: item.source, viewBox: item.viewBox }
        : { source: mockSvgArt(caption).source, viewBox: mockSvgArt(caption).viewBox }
      blocks.push(panel({ x, y: cardY, w: cardW, h: cardH }, theme))
      blocks.push(
        makeSvg({
          x: round(x + 16),
          y: round(cardY + 16),
          w: round(cardW - 32),
          h: round(cardW - 32) * (art.viewBox[3] / art.viewBox[2]),
          source: art.source,
          viewBox: art.viewBox,
        }),
      )
      blocks.push(
        txt(caption, { x: x + 20, y: cardY + cardH - 56, w: cardW - 40 }, theme, {
          variant: 'caption',
          color: 'muted',
          maxH: lineHeightOf(theme, 'caption') * 2,
          enter: 'rise',
          delay: index * 60,
        }),
      )
    })
    return tidy(blocks)
  },
}

/* --------------------------------- closing --------------------------------- */

const closing: Recipe = {
  id: 'closing',
  slots: HEADLINE_SLOTS,
  build(content, theme) {
    const c = fillContent('closing', content)
    const hasVisual = !!c.visual && c.visual.kind !== 'none'
    const blocks: (Block | null)[] = []
    const variant = headlineVariant(c.headline, COVER_LADDER)
    const group: Block[] = []
    const headline = txt(c.headline, { x: MARGIN_X, y: 268, w: hasVisual ? 720 : 1120 }, theme, {
      variant,
      maxH: headlineMaxH(theme, variant, 3),
    })
    group.push(headline)
    if (c.lead) {
      group.push(
        txt(c.lead, { x: MARGIN_X, y: headline.y + headline.h + 32, w: hasVisual ? 660 : 900 }, theme, {
          variant: 'lead',
          color: 'muted',
          maxH: lineHeightOf(theme, 'lead') * 3,
        }),
      )
    }
    centerGroup(group, 240, 720)
    blocks.push(...group)
    blocks.push(
      txt(c.caption ?? (c.lang === 'zh' ? 'LUMEN · 幕光工作台 · 2026' : 'LUMEN · Workbench · 2026'), {
        x: MARGIN_X,
        y: 780,
        w: 640,
      }, theme, {
        variant: 'caption',
        color: 'muted',
        maxH: lineHeightOf(theme, 'caption'),
      }),
    )
    if (hasVisual) {
      const box = c.visual?.kind === 'three' ? { x: 920, y: 150, w: 560, h: 600 } : { x: 900, y: 160, w: 560, h: 580 }
      blocks.push(visualBlock(c.visual, box))
    }
    return tidy(blocks)
  },
}

/* --------------------------------- 注册表 --------------------------------- */

export const RECIPES: Record<RecipeId, Recipe> = {
  cover,
  statement,
  split,
  grid3,
  grid4,
  timeline,
  compare,
  quote,
  data,
  process,
  gallery,
  closing,
}

/** 用配方把内容排成块；任何缺项都走兜底，不抛错。 */
export function buildRecipe(id: RecipeId, content: RecipeContent, theme: Theme): Block[] {
  const recipe = RECIPES[id] ?? RECIPES.statement
  try {
    return recipe.build(fillContent(recipe.id, content), theme)
  } catch {
    return RECIPES.statement.build(fillContent('statement', content), theme)
  }
}

/** 配方的槽位说明（UI 提示与测试用）。 */
export function recipeSlots(id: RecipeId): RecipeSlotSpec[] {
  return RECIPES[id]?.slots ?? []
}
