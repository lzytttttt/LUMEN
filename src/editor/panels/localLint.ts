/**
 * localLint.ts —— 面板侧的兜底版式检查（纯函数）。
 *
 * 真正的检查器在 `src/lint/deckLint.ts`（render-core 提供），lintBridge 会优先调用它；
 * 模块尚未落地时用这里的基础规则撑住「检查」页签，保证面板永远有结论可看。
 * code 必须与 `editor.lint.*` 文案表对齐。
 */
import { BASE_TYPE, STAGE_H, STAGE_W, type Block, type Deck } from '@/schema/deck'
import { MIN_SIZE } from '@/schema/geometry'
import { getTheme } from '@/themes'

export interface DeckIssue {
  code: string
  severity: 'error' | 'warn' | 'info'
  slideId?: string
  blockId?: string
  message?: string
  /** 检查器给的插值参数（count / max / ratio…），文案里用 {name} 取。 */
  params?: Record<string, string | number>
}

const BLEED = 24
const DENSE_BLOCKS = 18
const THREE_BUDGET = 2

export function localLint(deck: Deck | null | undefined): DeckIssue[] {
  if (!deck) return []
  const issues: DeckIssue[] = []
  let threeTotal = 0

  for (const slide of deck.slides) {
    if (slide.blocks.length === 0) {
      issues.push({ code: 'emptySlide', severity: 'warn', slideId: slide.id })
      continue
    }
    if (slide.blocks.length > DENSE_BLOCKS) {
      issues.push({ code: 'denseSlide', severity: 'warn', slideId: slide.id })
    }
    for (const block of slide.blocks) {
      if (block.type === 'three') threeTotal += 1
      issues.push(...blockIssues(block, slide.id, deck))
    }
  }

  if (threeTotal > THREE_BUDGET) {
    issues.push({ code: 'threeBudget', severity: 'info' })
  }
  return issues
}

function blockIssues(block: Block, slideId: string, deck: Deck): DeckIssue[] {
  const out: DeckIssue[] = []
  const outsideStage = block.x + block.w < -BLEED || block.y + block.h < -BLEED
  const overflow =
    block.x < -BLEED ||
    block.y < -BLEED ||
    block.x + block.w > STAGE_W + BLEED ||
    block.y + block.h > STAGE_H + BLEED

  if (outsideStage) out.push({ code: 'offstage', severity: 'error', slideId, blockId: block.id })
  else if (overflow) out.push({ code: 'overflow', severity: 'warn', slideId, blockId: block.id })

  if (block.w < MIN_SIZE || block.h < MIN_SIZE) {
    out.push({ code: 'tooSmall', severity: 'warn', slideId, blockId: block.id })
  }

  switch (block.type) {
    case 'text': {
      if (block.text.trim() === '') {
        out.push({ code: 'emptyText', severity: 'info', slideId, blockId: block.id })
        break
      }
      const scale = getTheme(deck.themeId).typeScale ?? 1
      const size = BASE_TYPE[block.variant].size * scale
      if (size < 13) out.push({ code: 'tinyText', severity: 'info', slideId, blockId: block.id })
      break
    }
    case 'image': {
      if (!block.alt || block.alt.trim() === '') {
        out.push({ code: 'missingAlt', severity: 'info', slideId, blockId: block.id })
      }
      break
    }
    case 'svg': {
      if (/<\s*script|on\w+\s*=/i.test(block.source)) {
        out.push({ code: 'svgUnsafe', severity: 'warn', slideId, blockId: block.id })
      }
      break
    }
    default:
      break
  }
  return out
}
