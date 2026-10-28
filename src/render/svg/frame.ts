/**
 * svg/frame.ts —— SVG 外壳归一（viewBox / preserveAspectRatio）。
 *
 * 净化（sanitize.ts）是唯一 DOM 注入入口；这里只做"字符串级"的外壳补齐，
 * 不引入任何新的解析/注入路径：缺 viewBox 就用块自身的 viewBox 兜底，
 * 缺 preserveAspectRatio 就补 `xMidYMid meet`（等比完整显示，不裁切）。
 */

export type ViewBox = [number, number, number, number]

const ROOT_TAG_RE = /<svg\b[^>]*>/i
const VIEW_BOX_RE = /\bviewBox\s*=\s*"([^"]*)"/i
const PRESERVE_RE = /\bpreserveAspectRatio\s*=\s*"([^"]*)"/i
const DEFAULT_VIEW_BOX: ViewBox = [0, 0, 1600, 900]

export interface SvgFrame {
  markup: string
  viewBox: ViewBox
  /** 内容宽高比；null 表示无法判定。 */
  aspect: number | null
  /** viewBox 是否由兜底补上（内容本身没给）。 */
  injectedViewBox: boolean
}

export function parseViewBox(raw: string | null | undefined): ViewBox | null {
  if (!raw) return null
  const parts = raw.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null
  if (parts[2] <= 0 || parts[3] <= 0) return null
  return [parts[0], parts[1], parts[2], parts[3]]
}

/** 合法 viewBox → 宽高比；非法返回 null。 */
export function aspectOf(viewBox: ViewBox | null): number | null {
  if (!viewBox) return null
  return viewBox[2] / viewBox[3]
}

/**
 * 补齐 SVG 根节点的 viewBox 与 preserveAspectRatio。
 * 输入必须是 sanitizeSvgDocument 的产物；这里不会放宽任何白名单。
 */
export function ensureSvgFrame(markup: string, fallbackViewBox: ViewBox = DEFAULT_VIEW_BOX): SvgFrame {
  const match = ROOT_TAG_RE.exec(markup)
  if (!match) {
    return { markup, viewBox: fallbackViewBox, aspect: aspectOf(fallbackViewBox), injectedViewBox: false }
  }

  const tag = match[0]
  const found = parseViewBox(VIEW_BOX_RE.exec(tag)?.[1] ?? null)
  let injectedViewBox = false
  let nextTag = tag

  if (!found) {
    nextTag = nextTag.replace(/^<svg\b/i, `<svg viewBox="${formatViewBox(fallbackViewBox)}"`)
    injectedViewBox = true
  }
  if (!PRESERVE_RE.test(nextTag)) {
    nextTag = nextTag.replace(/^<svg\b/i, '<svg preserveAspectRatio="xMidYMid meet"')
  }

  const viewBox = found ?? fallbackViewBox
  const nextMarkup = nextTag === tag ? markup : markup.replace(tag, nextTag)
  return { markup: nextMarkup, viewBox, aspect: aspectOf(viewBox), injectedViewBox }
}

export function formatViewBox(viewBox: ViewBox): string {
  return viewBox.map((value) => (Number.isInteger(value) ? String(value) : value.toFixed(3))).join(' ')
}

/** 系统级 reduced-motion 偏好（SSR / jsdom 安全）。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
