/**
 * svg/colors.ts —— 颜色 ↔ 主题令牌的双向映射（工作室「调色」工具条）。
 *
 * 两件事：
 * 1) `tokenizeSvgColors`：把源码里的字面色值（hex / rgb / hsl …）就近映射到 7 个主题令牌，
 *    这样 AI 或用户上传的插图在任何主题下都成立（净化器只拦「非法颜色」，不做语义映射）；
 * 2) `expandThemeTokens`：反向把 `var(--d-*)` 展开成具体色值，
 *    供「导出到非 LUMEN 环境」时使用。
 *
 * 两个方向都只在净化产物上工作，输出仍是可渲染的 SVG 源码。
 */
import type { ThemeColors } from '@/schema/deck'
import { parseColor, type Rgba } from '@/lint/color'
import { parseSvgDocument, serializeSvg } from './document'

export const COLOR_TOKENS = ['bg', 'fg', 'muted', 'surface', 'line', 'accent', 'accent2'] as const
export type ThemeColorToken = (typeof COLOR_TOKENS)[number]

/** 与 `@/render/svg/sanitize` 的颜色属性白名单保持一致。 */
const COLOR_ATTRS = new Set(['fill', 'stroke', 'stop-color', 'flood-color', 'color'])

const TOKEN_VALUE_RE = /^var\(\s*--d-([a-z0-9-]+)\s*\)$/i
const NON_LITERAL = new Set(['none', 'currentcolor', 'transparent', 'inherit', 'context-fill', 'context-stroke'])

export interface ColorMapping {
  from: string
  to: string
}

export interface ColorMappingResult {
  markup: string
  count: number
  mappings: ColorMapping[]
}

function isLiteralColor(value: string): boolean {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '' || NON_LITERAL.has(trimmed)) return false
  if (trimmed.startsWith('url(') || trimmed.startsWith('var(')) return false
  return parseColor(trimmed) !== null
}

function distance(a: Rgba, b: Rgba): number {
  // 人眼对绿更敏感：加权欧氏距离足够做「就近令牌」判定
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db)
}

/** 就近令牌；解析失败或几乎全透明返回 null（保持原值，不做有损改写）。 */
export function nearestThemeToken(value: string, colors: ThemeColors): ThemeColorToken | null {
  const source = parseColor(value)
  if (!source || source.a < 0.04) return null
  let best: ThemeColorToken | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const token of COLOR_TOKENS) {
    const target = parseColor(colors[token])
    if (!target) continue
    const current = distance(source, target)
    if (current < bestDistance) {
      bestDistance = current
      best = token
    }
  }
  return best
}

function walkElements(root: Element, visit: (node: Element) => void): void {
  visit(root)
  for (const child of Array.from(root.children)) walkElements(child, visit)
}

/** 字面色值 → 主题令牌。已经令牌化过的值原样保留。 */
export function tokenizeSvgColors(markup: string, colors: ThemeColors): ColorMappingResult {
  const doc = parseSvgDocument(markup)
  if (!doc) return { markup, count: 0, mappings: [] }

  const mappings: ColorMapping[] = []
  const seen = new Set<string>()

  walkElements(doc.documentElement, (node) => {
    for (const attr of Array.from(node.attributes)) {
      if (!COLOR_ATTRS.has(attr.name.toLowerCase())) continue
      const value = attr.value.trim()
      if (!isLiteralColor(value)) continue
      const token = nearestThemeToken(value, colors)
      if (!token) continue
      const next = `var(--d-${token})`
      attr.value = next
      if (!seen.has(value)) {
        seen.add(value)
        mappings.push({ from: value, to: next })
      }
    }
  })

  if (mappings.length === 0) return { markup, count: 0, mappings }
  return { markup: serializeSvg(doc.documentElement), count: mappings.length, mappings }
}

/** 主题令牌 → 具体色值（导出到非 LUMEN 环境时用）。 */
export function expandThemeTokens(markup: string, colors: ThemeColors): ColorMappingResult {
  const doc = parseSvgDocument(markup)
  if (!doc) return { markup, count: 0, mappings: [] }

  const mappings: ColorMapping[] = []
  const seen = new Set<string>()

  walkElements(doc.documentElement, (node) => {
    for (const attr of Array.from(node.attributes)) {
      if (!COLOR_ATTRS.has(attr.name.toLowerCase())) continue
      const value = attr.value.trim()
      const match = TOKEN_VALUE_RE.exec(value)
      if (!match) continue
      const token = match[1] as ThemeColorToken
      if (!COLOR_TOKENS.includes(token)) continue
      const next = colors[token]
      if (!next) continue
      attr.value = next
      if (!seen.has(value)) {
        seen.add(value)
        mappings.push({ from: value, to: next })
      }
    }
  })

  if (mappings.length === 0) return { markup, count: 0, mappings }
  return { markup: serializeSvg(doc.documentElement), count: mappings.length, mappings }
}
