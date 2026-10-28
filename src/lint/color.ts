/**
 * lint/color.ts —— 主题色解析与 WCAG 对比度（纯函数，无 DOM）。
 *
 * 主题色通常是 #rrggbb，但用户覆盖色可能是 rgb()/hsl()；解析不了的直接返回 null，
 * 规则层据此跳过而不是报一条假问题。
 */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_RE = /^rgba?\(\s*([^)]+)\)$/i
const HSL_RE = /^hsla?\(\s*([^)]+)\)$/i

export function parseColor(input: string | undefined | null): Rgba | null {
  if (!input) return null
  const value = input.trim()
  const hex = HEX_RE.exec(value)
  if (hex) return parseHex(hex[1])
  const rgb = RGB_RE.exec(value)
  if (rgb) return parseRgbArgs(rgb[1])
  const hsl = HSL_RE.exec(value)
  if (hsl) return parseHslArgs(hsl[1])
  return null
}

function parseHex(raw: string): Rgba | null {
  const hex = raw.toLowerCase()
  if (hex.length === 3 || hex.length === 4) {
    const r = Number.parseInt(hex[0] + hex[0], 16)
    const g = Number.parseInt(hex[1] + hex[1], 16)
    const b = Number.parseInt(hex[2] + hex[2], 16)
    const a = hex.length === 4 ? Number.parseInt(hex[3] + hex[3], 16) / 255 : 1
    return Number.isFinite(r + g + b) ? { r, g, b, a } : null
  }
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1
  return Number.isFinite(r + g + b) ? { r, g, b, a } : null
}

function parseRgbArgs(raw: string): Rgba | null {
  const parts = raw.split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return null
  const channel = (token: string): number => {
    if (token.endsWith('%')) return clamp255((Number.parseFloat(token) / 100) * 255)
    return clamp255(Number.parseFloat(token))
  }
  const r = channel(parts[0])
  const g = channel(parts[1])
  const b = channel(parts[2])
  const a = parts[3] === undefined ? 1 : clamp01(Number.parseFloat(parts[3]))
  if (![r, g, b, a].every(Number.isFinite)) return null
  return { r, g, b, a }
}

function parseHslArgs(raw: string): Rgba | null {
  const parts = raw.split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return null
  const h = ((Number.parseFloat(parts[0]) % 360) + 360) % 360
  const s = clamp01(Number.parseFloat(parts[1]) / 100)
  const l = clamp01(Number.parseFloat(parts[2]) / 100)
  const a = parts[3] === undefined ? 1 : clamp01(Number.parseFloat(parts[3]))
  if (![h, s, l, a].every(Number.isFinite)) return null
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const segment = Math.floor(h / 60) % 6
  const [r1, g1, b1] =
    segment === 0
      ? [c, x, 0]
      : segment === 1
        ? [x, c, 0]
        : segment === 2
          ? [0, c, x]
          : segment === 3
            ? [0, x, c]
            : segment === 4
              ? [x, 0, c]
              : [c, 0, x]
  return { r: clamp255((r1 + m) * 255), g: clamp255((g1 + m) * 255), b: clamp255((b1 + m) * 255), a }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : Number.NaN
}

function clamp255(value: number): number {
  return Number.isFinite(value) ? Math.min(255, Math.max(0, value)) : Number.NaN
}

/** WCAG 相对亮度。 */
export function relativeLuminance(color: Rgba): number {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/**
 * 前景/背景对比度（1~21）。带 alpha 的前景色按背景混合后再算，
 * 任一色值解析失败返回 null（调用方跳过该条规则）。
 */
export function contrastRatio(foreground: string | undefined, background: string | undefined): number | null {
  const fg = parseColor(foreground)
  const bg = parseColor(background)
  if (!fg || !bg) return null
  const blended = fg.a >= 1 ? fg : blendOver(fg, bg)
  const l1 = relativeLuminance(blended)
  const l2 = relativeLuminance(bg)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

function blendOver(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  }
}

/** AA 阈值：大字 3:1，正文 4.5:1。 */
export function aaThreshold(fontSize: number, fontWeight: number): number {
  const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700)
  return large ? 3 : 4.5
}
