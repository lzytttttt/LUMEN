/** lint —— deck 检查引擎公共出口（右栏「检查」页签只依赖这里）。 */
export {
  LINT_CODES,
  LINT_LIMITS,
  lintDeck,
  readingSeconds,
  summarizeLint,
  textStyleOf,
  type LintIssue,
  type LintOptions,
  type LintSeverity,
} from './deckLint'

export { aaThreshold, contrastRatio, parseColor, relativeLuminance } from './color'
export { estimateTextLayout, resetMeasureCache, type TextLayoutEstimate, type TextLayoutInput } from './measure'
