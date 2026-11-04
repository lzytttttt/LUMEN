/**
 * creator/context.ts —— 上下文快照（04 §6.1）、token 估算（04 §6.4）与稳定序列化。
 *
 * 隐私硬线（D-40-01 / 06 D-40-04）：
 * - 默认只发结构摘要；`readDeck === true` 才发 `deckExcerpt`（headline/points 截断：每幕 ≤200 字、≤20 幕、≤2500 token）；
 * - `enabledPlugins` 只给 `[{id,name,version,kind}]` ≤8 条，不含插件数据；
 * - 快照里没有任何时间戳/随机 id（replay digest 可重算，04 §6.6）。
 */
import type { Deck } from '@/schema/deck'
import type { CreatorTemplateId } from './state'

/* ------------------------------ token 估算（04 §6.4） ------------------------------ */

/**
 * 本地估算：`ceil(cjk×0.75 + latin/4)`。
 * cjk = 中日韩字符数；latin = 其余字符数（含空格与标点，保守高估）。
 */
export function countCjk(text: string): number {
  let count = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (
      (code >= 0x2e80 && code <= 0x9fff) || // CJK 部首扩展 ~ 统一表意文字
      (code >= 0xf900 && code <= 0xfaff) || // 兼容表意文字
      (code >= 0x3040 && code <= 0x30ff) || // 假名
      (code >= 0xac00 && code <= 0xd7af) // 谚文
    ) {
      count += 1
    }
  }
  return count
}

export function estimateTokens(text: string): number {
  if (!text) return 0
  const length = Array.from(text).length
  const cjk = countCjk(text)
  const latin = Math.max(0, length - cjk)
  return Math.ceil(cjk * 0.75 + latin / 4)
}

/** 对象 → token 估算（按稳定序列化后的文本算）。 */
export function estimateTokensOf(value: unknown): number {
  return estimateTokens(stableStringify(value))
}

/** 按 token 预算截断文本（二分找最长前缀；不切断代理对）。 */
export function fitTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ''
  if (estimateTokens(text) <= maxTokens) return text
  const chars = Array.from(text)
  let low = 0
  let high = chars.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(chars.slice(0, middle).join('')) <= maxTokens) low = middle
    else high = middle - 1
  }
  return chars.slice(0, low).join('')
}

/* ------------------------------ 稳定序列化 ------------------------------ */

/** 键序固定的 JSON（replay fixture 的 digest 依赖它；04 §6.6）。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item === undefined) continue
      out[key] = sortValue(item)
    }
    return out
  }
  return value
}

/* ------------------------------ 快照形状 ------------------------------ */

/** 04 §6.1 的冻结形状。 */
export interface CreatorLayoutSnapshot {
  railWidth: number
  panelWidth: number
  rightMode: string
  leftTab: string
  inspectorTab: string
}

export interface CreatorEnabledPlugin {
  id: string
  name: { zh: string; en: string }
  version: string
  kind: 'declarative' | 'code'
}

export interface CreatorDeckSummary {
  title: string
  slideCount: number
  blockCounts: Record<string, number>
  lang: string
}

export interface CreatorDeckExcerptSlide {
  headline: string
  points: string[]
}

export interface CreatorContextSnapshot {
  appVersion: string
  apiVersion: '1.0'
  locale: string
  uiTheme: string
  themeId: string
  layout: CreatorLayoutSnapshot
  enabledPlugins: CreatorEnabledPlugin[]
  deckSummary: CreatorDeckSummary
  deckRevision: number
  /** 仅 `readDeck === true` 时出现（默认不发送）。 */
  deckExcerpt?: CreatorDeckExcerptSlide[]
  /** 意图（决定 ABI/样例裁剪；不直接上屏）。 */
  intent: CreatorTemplateId | 'auto'
}

export const CREATOR_CONTEXT_LIMITS = {
  /** user 快照 ≤600 token（04 §6.4）。 */
  userSnapshot: 600,
  /** 显式 deck 摘录 ≤2500 token。 */
  deckExcerpt: 2500,
  /** 单次输入合计 ≤10000；开 deck 摘录 ≤12500。 */
  inputTotal: 10_000,
  inputTotalWithDeck: 12_500,
  /** enabledPlugins 最多 8 条；超限裁到 4 条（04 §6.4）。 */
  enabledPlugins: 8,
  enabledPluginsTrimmed: 4,
  /** deck 摘录：每幕 ≤200 字、≤20 幕。 */
  excerptSlideChars: 200,
  excerptSlides: 20,
} as const

/* ------------------------------ 采集 ------------------------------ */

export interface ComposeCreatorContextInput {
  appVersion: string
  locale: string
  uiTheme: string
  deck: Pick<Deck, 'title' | 'themeId' | 'lang' | 'slides'> | null
  deckRevision: number
  layout: CreatorLayoutSnapshot
  enabledPlugins?: CreatorEnabledPlugin[]
  readDeck?: boolean
  intent?: CreatorTemplateId | 'auto'
}

function blockCountsOf(deck: Pick<Deck, 'slides'> | null): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const slide of deck?.slides ?? []) {
    for (const block of slide.blocks ?? []) counts[block.type] = (counts[block.type] ?? 0) + 1
  }
  return counts
}

/** 纯函数：把外部状态拼成快照（不读 store，单测直接用）。 */
export function composeCreatorContext(input: ComposeCreatorContextInput): CreatorContextSnapshot {
  const deck = input.deck
  const snapshot: CreatorContextSnapshot = {
    appVersion: input.appVersion,
    apiVersion: '1.0',
    locale: input.locale,
    uiTheme: input.uiTheme,
    themeId: deck?.themeId ?? 'noir',
    layout: { ...input.layout },
    enabledPlugins: (input.enabledPlugins ?? []).slice(0, CREATOR_CONTEXT_LIMITS.enabledPlugins).map((plugin) => ({
      id: plugin.id,
      name: { zh: plugin.name.zh, en: plugin.name.en },
      version: plugin.version,
      kind: plugin.kind,
    })),
    deckSummary: {
      title: (deck?.title ?? '').slice(0, 160),
      slideCount: deck?.slides.length ?? 0,
      blockCounts: blockCountsOf(deck),
      lang: deck?.lang ?? input.locale,
    },
    deckRevision: input.deckRevision,
    intent: input.intent ?? 'auto',
  }
  if (input.readDeck === true && deck) {
    snapshot.deckExcerpt = deckExcerptOf(deck)
  }
  return snapshot
}

/** 抽 deck 摘录：每幕取文字块的 headline/points，截断到预算（隐私硬线）。 */
export function deckExcerptOf(deck: Pick<Deck, 'slides'>): CreatorDeckExcerptSlide[] {
  const excerpt: CreatorDeckExcerptSlide[] = []
  for (const slide of deck.slides.slice(0, CREATOR_CONTEXT_LIMITS.excerptSlides)) {
    const texts: string[] = []
    for (const block of slide.blocks ?? []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        texts.push(block.text.trim())
      }
    }
    if (texts.length === 0) continue
    const headline = texts[0].slice(0, CREATOR_CONTEXT_LIMITS.excerptSlideChars)
    const points = texts
      .slice(1)
      .map((text) => text.slice(0, CREATOR_CONTEXT_LIMITS.excerptSlideChars))
      .slice(0, 4)
    excerpt.push({ headline, points })
  }
  return excerpt
}

/* ------------------------------ 预算裁剪（04 §6.4） ------------------------------ */

export interface TrimmedContext {
  snapshot: CreatorContextSnapshot
  /** 被裁掉的内容（诊断/状态条用，不上屏）。 */
  trimmed: string[]
  tokens: number
}

/**
 * 按预算裁剪：先裁 `enabledPlugins`（8→4）→ 再按幕截断 deck 摘录 → 最后压 title。
 * 顺序对应 04 §6.4 的「user 快照超限处置」。
 */
export function trimCreatorContext(
  snapshot: CreatorContextSnapshot,
  maxTokens: number = CREATOR_CONTEXT_LIMITS.userSnapshot,
): TrimmedContext {
  const trimmed: string[] = []
  let current: CreatorContextSnapshot = { ...snapshot, enabledPlugins: [...snapshot.enabledPlugins] }
  const fits = () => estimateTokensOf(payloadOf(current)) <= maxTokens

  if (!fits() && current.enabledPlugins.length > CREATOR_CONTEXT_LIMITS.enabledPluginsTrimmed) {
    current = { ...current, enabledPlugins: current.enabledPlugins.slice(0, CREATOR_CONTEXT_LIMITS.enabledPluginsTrimmed) }
    trimmed.push('enabledPlugins')
  }

  if (!fits() && current.deckExcerpt) {
    let excerpt = current.deckExcerpt
    while (excerpt.length > 0 && estimateTokensOf(payloadOf({ ...current, deckExcerpt: excerpt })) > maxTokens) {
      excerpt = excerpt.slice(0, -1)
    }
    // 还超就按字符砍每幕的 points。
    if (excerpt.length > 0 && estimateTokensOf(payloadOf({ ...current, deckExcerpt: excerpt })) > maxTokens) {
      excerpt = excerpt.map((slide) => ({
        headline: fitTextToTokens(slide.headline, 80),
        points: slide.points.map((point) => fitTextToTokens(point, 60)),
      }))
    }
    current = { ...current, deckExcerpt: excerpt }
    trimmed.push('deckExcerpt')
  }

  if (!fits()) {
    current = {
      ...current,
      deckSummary: {
        ...current.deckSummary,
        title: fitTextToTokens(current.deckSummary.title, 24),
      },
    }
    trimmed.push('title')
  }

  return { snapshot: current, trimmed, tokens: estimateTokensOf(payloadOf(current)) }
}

/** 快照 → user payload（去掉 intent；intent 单独放在顶层供 Mock 分派）。 */
export function payloadOf(snapshot: CreatorContextSnapshot): Record<string, unknown> {
  const { intent, ...rest } = snapshot
  void intent
  return rest
}
