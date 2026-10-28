/**
 * lint/deckLint.ts —— deck 检查引擎（右栏「检查」页签的数据源）。
 *
 * 约定：
 * - `code` 是**稳定短标识**，文案由 panels 用 i18n 映射；这里绝不返回 UI 文案。
 * - 纯函数、同步、无 DOM 副作用：canvas 测量惰性创建并缓存，jsdom 下照样能跑。
 * - 启发式只报「确有把握」的问题：阈值留了余量，不追求零告警。
 *
 * code 一览：
 *   slideCount 幕数过少/过多 · emptySlide 空幕 · tooManyBlocks 同幕块数过多
 *   threeBudget 3D 块超预算 · textOverflow 文本溢出 · contrast 对比度不足
 *   fontTooSmall 字号过小 · outOfBounds 越界 · missingAlt 图片缺 alt
 *   readingTime 单幕阅读时长过长 · emptyBlock 空内容块
 */
import type { Block, Deck, Slide, TextBlock, TextVariant, Theme, ThemeColors } from '@/schema/deck'
import { STAGE_H, STAGE_W } from '@/schema/deck'
import { rotatedBounds } from '@/schema/geometry'
import { getTheme } from '@/themes'
import { typeStyleOf } from '@/themes'
import { plainText } from '@/render/text/markdown'
import { aaThreshold, contrastRatio } from './color'
import { estimateTextLayout } from './measure'

export type LintSeverity = 'info' | 'warn' | 'error'

export interface LintIssue {
  code: string
  severity: LintSeverity
  slideId?: string
  blockId?: string
  params?: Record<string, string | number>
}

export interface LintOptions {
  /** 覆盖主题（面板预览用）；缺省读 deck.themeId。 */
  theme?: Theme
}

/* ------------------------------- 阈值常量 ------------------------------- */

export const LINT_CODES = [
  'slideCount',
  'emptySlide',
  'tooManyBlocks',
  'threeBudget',
  'textOverflow',
  'contrast',
  'fontTooSmall',
  'outOfBounds',
  'missingAlt',
  'readingTime',
  'emptyBlock',
] as const

export const LINT_LIMITS = {
  minSlides: 3,
  maxSlides: 24,
  maxThreePerDeck: 2,
  maxBlocksPerSlide: 18,
  minCaptionSize: 13,
  maxReadingSeconds: 90,
  /** 溢出比例超过它才报（留 6% 排版余量）。 */
  overflowRatio: 1.06,
  /** 越界容差（允许少量出血）。 */
  bleed: 2,
} as const

/* --------------------------------- 主体 --------------------------------- */

export function lintDeck(deck: Deck, opts: LintOptions = {}): LintIssue[] {
  const theme = opts.theme ?? getTheme(deck.themeId)
  const colors: ThemeColors = { ...theme.colors, ...(deck.themeOverrides ?? {}) }
  const issues: LintIssue[] = []

  issues.push(...lintDeckLevel(deck))
  for (const slide of deck.slides) {
    issues.push(...lintSlide(slide, deck, theme, colors))
  }
  return issues
}

/** 严重度汇总（面板显示"n 个问题"用）。 */
export function summarizeLint(issues: LintIssue[]): Record<LintSeverity, number> {
  const counts: Record<LintSeverity, number> = { error: 0, warn: 0, info: 0 }
  for (const issue of issues) counts[issue.severity] += 1
  return counts
}

/* -------------------------------- 演示级 -------------------------------- */

function lintDeckLevel(deck: Deck): LintIssue[] {
  const issues: LintIssue[] = []
  const slides = deck.slides.length
  const { minSlides, maxSlides, maxThreePerDeck } = LINT_LIMITS

  if (slides < minSlides || slides > maxSlides) {
    issues.push({ code: 'slideCount', severity: 'info', params: { count: slides, min: minSlides, max: maxSlides } })
  }

  let threeCount = 0
  for (const slide of deck.slides) {
    for (const block of slide.blocks) {
      if (block.type === 'three' && !block.hidden) threeCount += 1
    }
  }
  if (threeCount > maxThreePerDeck) {
    issues.push({
      code: 'threeBudget',
      severity: threeCount > maxThreePerDeck * 2 ? 'error' : 'warn',
      params: { count: threeCount, max: maxThreePerDeck },
    })
  }

  return issues
}

/* -------------------------------- 单幕级 -------------------------------- */

function lintSlide(slide: Slide, deck: Deck, theme: Theme, colors: ThemeColors): LintIssue[] {
  const issues: LintIssue[] = []
  const blocks: Block[] = slide.blocks.filter((block) => !block.hidden)
  const background = slide.background.kind === 'solid' && slide.background.color
    ? colors[slide.background.color] ?? colors.bg
    : colors.bg

  if (blocks.length === 0) {
    issues.push({ code: 'emptySlide', severity: 'warn', slideId: slide.id })
  }

  if (blocks.length > LINT_LIMITS.maxBlocksPerSlide) {
    issues.push({
      code: 'tooManyBlocks',
      severity: 'info',
      slideId: slide.id,
      params: { count: blocks.length, max: LINT_LIMITS.maxBlocksPerSlide },
    })
  }

  const seconds = readingSecondsOf(blocks, deck.lang)
  if (seconds > LINT_LIMITS.maxReadingSeconds) {
    issues.push({
      code: 'readingTime',
      severity: 'info',
      slideId: slide.id,
      params: { seconds: Math.round(seconds), max: LINT_LIMITS.maxReadingSeconds },
    })
  }

  for (const block of blocks) {
    issues.push(...lintBlock(block, slide, theme, colors, background))
  }

  return issues
}

function lintBlock(
  block: Block,
  slide: Slide,
  theme: Theme,
  colors: ThemeColors,
  background: string,
): LintIssue[] {
  const issues: LintIssue[] = []
  const base = { slideId: slide.id, blockId: block.id }

  if (isEmptyBlock(block)) {
    issues.push({ code: 'emptyBlock', severity: 'info', ...base })
  }

  const overflow = boundsOverflow(block)
  if (overflow > LINT_LIMITS.bleed) {
    issues.push({
      code: 'outOfBounds',
      severity: overflow > 160 ? 'error' : 'warn',
      ...base,
      params: { over: Math.round(overflow) },
    })
  }

  if (block.type === 'text') {
    const style = textStyleOf(theme, block)

    const layout = estimateTextLayout({
      text: plainText(block.text),
      width: block.w,
      height: block.h,
      fontSize: style.size,
      lineHeight: style.lineHeight,
      letterSpacing: style.tracking,
      fontWeight: style.weight,
      fontFamily: style.family,
    })
    if (layout.ratio > LINT_LIMITS.overflowRatio) {
      issues.push({
        code: 'textOverflow',
        severity: layout.ratio > 1.25 ? 'error' : 'warn',
        ...base,
        params: {
          ratio: round2(layout.ratio),
          lines: layout.lines,
          height: Math.round(layout.contentHeight),
        },
      })
    }

    const foreground = colors[block.color] ?? colors.fg
    const ratio = contrastRatio(foreground, background)
    const threshold = aaThreshold(style.size, style.weight)
    if (ratio !== null && ratio < threshold) {
      issues.push({
        code: 'contrast',
        severity: 'warn',
        ...base,
        params: { ratio: round2(ratio), threshold, size: round2(style.size) },
      })
    }

    if (block.variant === 'caption' && style.size < LINT_LIMITS.minCaptionSize) {
      issues.push({
        code: 'fontTooSmall',
        severity: 'info',
        ...base,
        params: { size: round2(style.size), min: LINT_LIMITS.minCaptionSize },
      })
    }
  }

  if (block.type === 'image' && !block.alt?.trim()) {
    issues.push({ code: 'missingAlt', severity: 'info', ...base })
  }

  return issues
}

/* -------------------------------- 小工具 -------------------------------- */

interface ResolvedTextStyle {
  size: number
  weight: number
  lineHeight: number
  tracking: number
  family: string
}

/** 与 slide.css 的字号阶保持一致：display/h1/h2 用 display 字体，mono 用等宽，其余用正文字体。 */
export function textStyleOf(theme: Theme, block: Pick<TextBlock, 'variant' | 'weight' | 'lineHeight' | 'tracking'>): ResolvedTextStyle {
  const style = typeStyleOf(theme, block.variant as TextVariant)
  const family =
    block.variant === 'mono'
      ? theme.font.mono
      : block.variant === 'display' || block.variant === 'h1' || block.variant === 'h2'
        ? theme.font.display
        : theme.font.body
  return {
    size: style.size,
    weight: block.weight ?? style.weight,
    lineHeight: block.lineHeight ?? style.lineHeight,
    tracking: block.tracking ?? style.tracking,
    family,
  }
}

function isEmptyBlock(block: Block): boolean {
  switch (block.type) {
    case 'text':
      return plainText(block.text).trim() === ''
    case 'svg':
      return block.source.trim() === ''
    case 'html':
      return block.html.trim() === ''
    default:
      return false
  }
}

/** 超出舞台的最大距离（设计像素）；未越界返回 0。 */
function boundsOverflow(block: Block): number {
  const rect = rotatedBounds({ x: block.x, y: block.y, w: block.w, h: block.h }, block.rotation ?? 0)
  const overLeft = -rect.x
  const overTop = -rect.y
  const overRight = rect.x + rect.w - STAGE_W
  const overBottom = rect.y + rect.h - STAGE_H
  return Math.max(0, overLeft, overTop, overRight, overBottom)
}

/** 单幕阅读时长（秒）：中文按字/4.2，英文按词/2.6（≈156 wpm）。 */
function readingSecondsOf(blocks: Block[], lang: 'zh' | 'en'): number {
  let total = 0
  for (const block of blocks) {
    if (block.type === 'text') total += readingSeconds(block.text, lang)
    else if (block.type === 'image' && block.caption) total += readingSeconds(block.caption, lang)
  }
  return total
}

export function readingSeconds(text: string, lang: 'zh' | 'en'): number {
  const plain = plainText(text)
  if (plain.trim() === '') return 0
  if (lang === 'en') {
    const words = plain.trim().split(/\s+/).filter(Boolean).length
    return words / 2.6
  }
  const chars = plain.replace(/\s+/g, '').length
  return chars / 4.2
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
