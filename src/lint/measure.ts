/**
 * lint/measure.ts —— 文本溢出的启发式估计。
 *
 * 策略：
 * - 能用 canvas 的 `measureText` 就用（按字素宽度缓存，字体变了才重算）；
 * - 没有 canvas（jsdom / 无头环境）就退到按字符类别的宽度系数，保证 lint 不报错也不瞎报；
 * - 折行按 CSS 的行为近似：CJK 逐字断行，拉丁词整体断行，超长词才拆。
 *
 * 纯函数、同步、无 DOM 副作用（canvas 惰性创建并缓存）。
 */

export interface TextLayoutInput {
  text: string
  /** 可用宽度（设计像素）。 */
  width: number
  /** 块高度（设计像素）。 */
  height: number
  fontSize: number
  /** 行高倍数（CSS line-height）。 */
  lineHeight: number
  /** 字距（em）。 */
  letterSpacing: number
  fontWeight: number
  fontFamily: string
}

export interface TextLayoutEstimate {
  lines: number
  maxLineWidth: number
  contentHeight: number
  /** 溢出比例：max(高比, 宽比)，1 表示刚好放下。 */
  ratio: number
}

const CJK_RE = /[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/
const SPACE_RE = /[\s\u00a0]/

let measureCtx: CanvasRenderingContext2D | null | undefined
let measureUnavailable = false
const widthCache = new Map<string, number>()

/** 惰性创建测量上下文；不可用则永久返回 null（jsdom 下不会产生控制台噪音）。 */
function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureUnavailable) return null
  if (measureCtx !== undefined) return measureCtx
  try {
    if (typeof document === 'undefined' || typeof CanvasRenderingContext2D === 'undefined') {
      measureUnavailable = true
      measureCtx = null
      return null
    }
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    measureCtx = canvas.getContext('2d')
    if (!measureCtx) measureUnavailable = true
  } catch {
    measureUnavailable = true
    measureCtx = null
  }
  return measureCtx ?? null
}

/** 仅供测试：重置 canvas 缓存。 */
export function resetMeasureCache(): void {
  measureCtx = undefined
  measureUnavailable = false
  widthCache.clear()
}

function fontKey(input: TextLayoutInput): string {
  return `${input.fontWeight} ${input.fontSize}px ${input.fontFamily}`
}

/** 单个"排版单元"（一个字 / 一个词）的宽度。 */
function unitWidth(unit: string, input: TextLayoutInput, cacheKey: string): number {
  const ctx = getMeasureContext()
  const key = `${cacheKey}\u0000${unit}`
  const cached = widthCache.get(key)
  if (cached !== undefined) return cached

  let width: number
  if (ctx) {
    try {
      ctx.font = cacheKey
      width = ctx.measureText(unit).width
    } catch {
      width = fallbackWidth(unit, input.fontSize)
    }
  } else {
    width = fallbackWidth(unit, input.fontSize)
  }
  width += unit.length * input.letterSpacing * input.fontSize
  if (widthCache.size > 4000) widthCache.clear()
  widthCache.set(key, width)
  return width
}

/** 无 canvas 时的宽度系数（保守略偏宽，避免漏报严重溢出）。 */
function fallbackWidth(unit: string, fontSize: number): number {
  let em = 0
  for (const char of unit) {
    if (CJK_RE.test(char)) em += 1
    else if (SPACE_RE.test(char)) em += 0.3
    else if (/[A-Z0-9]/.test(char)) em += 0.62
    else if (/[a-z]/.test(char)) em += 0.52
    else if (/[.,:;'!|]/.test(char)) em += 0.28
    else em += 0.5
  }
  return em * fontSize
}

/** 把一行文本切成排版单元：CJK 单字成单元，拉丁词整体成单元。 */
function tokenize(line: string): string[] {
  const tokens: string[] = []
  let word = ''
  for (const char of line) {
    if (CJK_RE.test(char) || SPACE_RE.test(char)) {
      if (word) {
        tokens.push(word)
        word = ''
      }
      tokens.push(char)
    } else {
      word += char
    }
  }
  if (word) tokens.push(word)
  return tokens
}

function wrapLine(line: string, input: TextLayoutInput, cacheKey: string): { lines: number; maxWidth: number } {
  const tokens = tokenize(line)
  if (tokens.length === 0) return { lines: 1, maxWidth: 0 }

  let lines = 1
  let current = 0
  let maxWidth = 0
  const limit = Math.max(1, input.width)

  const pushToken = (token: string): void => {
    const width = unitWidth(token, input, cacheKey)
    if (current + width <= limit) {
      current += width
      return
    }
    if (current > 0) {
      maxWidth = Math.max(maxWidth, current)
      lines += 1
      current = 0
      if (SPACE_RE.test(token)) return
    }
    // 单个单元本身就超宽：按字符硬拆
    if (width > limit) {
      const perChar = Math.max(0.0001, width / Array.from(token).length)
      for (const char of token) {
        const charWidth = unitWidth(char, input, cacheKey)
        if (current + charWidth > limit && current > 0) {
          maxWidth = Math.max(maxWidth, current)
          lines += 1
          current = 0
        }
        current += charWidth
        void perChar
      }
      return
    }
    current = width
  }

  for (const token of tokens) pushToken(token)
  maxWidth = Math.max(maxWidth, current)
  return { lines, maxWidth }
}

/**
 * 估计文本块内容占用的行数/宽度，返回溢出比例。
 * 空文本返回 0，避免"空块"被当成溢出。
 */
export function estimateTextLayout(input: TextLayoutInput): TextLayoutEstimate {
  const width = Math.max(1, input.width)
  const height = Math.max(1, input.height)
  const size = Math.max(1, input.fontSize)
  const lineHeight = Math.max(0.5, input.lineHeight)
  const cacheKey = fontKey(input)

  if (input.text.trim() === '') {
    return { lines: 0, maxLineWidth: 0, contentHeight: 0, ratio: 0 }
  }

  const paragraphs = input.text.split(/\n{2,}/)
  let lines = 0
  let maxLineWidth = 0

  for (const paragraph of paragraphs) {
    const segments = paragraph.split('\n')
    for (const segment of segments) {
      const wrapped = wrapLine(segment, input, cacheKey)
      lines += wrapped.lines
      maxLineWidth = Math.max(maxLineWidth, wrapped.maxWidth)
    }
  }
  if (lines === 0) return { lines: 0, maxLineWidth: 0, contentHeight: 0, ratio: 0 }

  // 段落间距与 .lumen-para + .lumen-para 的 0.55em 对齐
  const paragraphGap = paragraphs.length > 1 ? (paragraphs.length - 1) * size * 0.55 : 0
  /**
   * 可见字面高度：行盒高度减去首尾各一半的行距（half-leading）。
   * 也就是 `size * (lines * lineHeight - (lineHeight - 1))`。
   * 这样"一行字刚好塞进一个行盒"的紧排块不会被误报，只有真正会被裁切的多行文本才报。
   */
  const leading = Math.max(0, lineHeight - 1)
  const contentHeight = size * (lines * lineHeight - leading) + paragraphGap
  const ratio = Math.max(contentHeight / height, maxLineWidth / width)

  return { lines, maxLineWidth, contentHeight, ratio }
}
