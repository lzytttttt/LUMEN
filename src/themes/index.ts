/**
 * themes/index.ts —— 6 套主题令牌（v0.2.5「设计预设」打磨版）。
 * 规范：《08-设计系统》。主题是 TS 数据，运行时注入 --d-* CSS 变量，
 * 导出时同一份数据序列化进独立 HTML，从而保证"编辑器所见 = 导出所得"。
 *
 * v0.2.5 新增（全部可选，旧 Deck / 旧主题对象零影响）：
 *   texture?: { kind, opacity }   背景纹理（none/grain/grid/scan/dots）
 *   glow?: number                  accent 光晕强度 0..1
 *   elevation?: 'flat'|'raised'|'layered'   层次（决定 --d-shadow-1/2）
 * 派生色一律走本文件顶部的纯函数（hex→rgba / mix / darken），不引依赖、可单测。
 */
import type { Theme, ThemeColors, TextVariant, TypeStyle, TextureKind, Elevation } from '@/schema/deck'
import { BASE_TYPE, typeScaleOf } from '@/schema/deck'
import { parseColor, relativeLuminance } from '@/lint/color'

const SANS =
  "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
const SERIF =
  "'Songti SC', 'Noto Serif SC', 'Source Han Serif SC', 'Songti TC', Georgia, 'Times New Roman', serif"
const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Mono', Consolas, 'Courier New', monospace"

/* ------------------------------ 派生色纯函数 ------------------------------ */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** 解析 `#rgb` / `#rrggbb` / `rgb()` / `hsl()`；失败返回 null（调用方走 CSS 兜底表达式）。 */
export function parseThemeColor(input: string | null | undefined): Rgb | null {
  const parsed = parseColor(input ?? undefined)
  return parsed ? { r: parsed.r, g: parsed.g, b: parsed.b } : null
}

/** Rgb → `#rrggbb`（四舍五入并夹回 0..255）。 */
export function toHexColor(rgb: Rgb): string {
  const channel = (value: number): string => {
    const clamped = Number.isFinite(value) ? Math.min(255, Math.max(0, Math.round(value))) : 0
    return clamped.toString(16).padStart(2, '0')
  }
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`
}

/** 主题色是不是深色底（决定 surface-2 往亮还是往暗走）。 */
export function isDarkColor(color: string): boolean {
  const parsed = parseColor(color)
  if (!parsed) return true
  return relativeLuminance(parsed) < 0.5
}

/**
 * 线性混色：`from` → `to`，t=0 取 from、t=1 取 to。
 * 任一端解析失败时退回 CSS `color-mix()`，保证导出样式永远合法。
 */
export function mixColor(from: string, to: string, t: number): string {
  const a = parseThemeColor(from)
  const b = parseThemeColor(to)
  const ratio = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
  if (!a || !b) return `color-mix(in srgb, ${from} ${Math.round(ratio * 100)}%, ${to})`
  return toHexColor({
    r: a.r + (b.r - a.r) * ratio,
    g: a.g + (b.g - a.g) * ratio,
    b: a.b + (b.b - a.b) * ratio,
  })
}

/** 往黑里压：amount=0 原色，amount=1 纯黑。 */
export function darkenColor(color: string, amount: number): string {
  return mixColor(color, '#000000', amount)
}

/** 往白里提：amount=0 原色，amount=1 纯白。 */
export function lightenColor(color: string, amount: number): string {
  return mixColor(color, '#ffffff', amount)
}

/**
 * 带 alpha 的 rgba()：主题强调色的 12% 软底就靠它。
 * 解析失败退回 `color-mix()`（浏览器原生混合，语义等价）。
 */
export function withAlpha(color: string, alpha: number): string {
  const parsed = parseThemeColor(color)
  const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1
  if (!parsed) return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`
  const rounded = Math.round(a * 1000) / 1000
  return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${rounded})`
}

/**
 * 二级表面 --d-surface-2：沿"远离 bg"的方向再走一步。
 * 深色主题（bg 暗）提亮 7%，浅色主题（bg 亮）压暗 5% —— 两档都保持 muted 可读。
 */
export function surface2Of(bg: string, surface: string): string {
  return isDarkColor(bg) ? lightenColor(surface, 0.07) : darkenColor(surface, 0.05)
}

/** accent 的 12% 透明软底（芯片、焦点、图表底色）。 */
export function accentSoftOf(color: string): string {
  return withAlpha(color, 0.12)
}

/**
 * 阴影档位：flat 干净（靠描线分层）、raised 一层托起、layered 两段叠加。
 * 阴影色不是纯黑，而是 bg 压暗 58% 的"同族暗色"，深色主题里不脏、浅色主题里不发灰。
 */
export function shadowsOf(elevation: Elevation, bg: string): { one: string; two: string } {
  const tint = darkenColor(bg, 0.58)
  switch (elevation) {
    case 'flat':
      return { one: 'none', two: 'none' }
    case 'raised':
      return {
        one: `0 6px 18px ${withAlpha(tint, 0.22)}`,
        two: `0 20px 52px ${withAlpha(tint, 0.3)}`,
      }
    default:
      return {
        one: `0 2px 6px ${withAlpha(tint, 0.18)}, 0 12px 28px ${withAlpha(tint, 0.22)}`,
        two: `0 8px 22px ${withAlpha(tint, 0.26)}, 0 34px 76px ${withAlpha(tint, 0.34)}`,
      }
  }
}

/**
 * 纹理层：以 alpha 遮罩的方式铺在幕底（`mask-image`），所以同一块瓦片能被任意墨色染色。
 * 用 data URI + 显式 width/height（有固有尺寸），`mask-size: auto` 即按瓦片平铺。
 * `none` 返回 `none`（对应主题的 --d-texture-op 归一为 0）。
 */
export function textureTileOf(kind: TextureKind): string {
  switch (kind) {
    case 'grain':
      return "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.86' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.34'/%3E%3C/svg%3E\")"
    case 'grid':
      return "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cpath d='M31.5 0V32H0' fill='none' stroke='%23fff' stroke-width='1'/%3E%3C/svg%3E\")"
    case 'scan':
      return "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='6'%3E%3Crect width='6' height='1' fill='%23fff'/%3E%3C/svg%3E\")"
    case 'dots':
      return "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18'%3E%3Ccircle cx='9' cy='9' r='1.1' fill='%23fff'/%3E%3C/svg%3E\")"
    default:
      return 'none'
  }
}

/** 纹理强度归一：`kind: none` 一律 0，避免"无图案但有墨层"的假纹理。 */
export function textureOpacityOf(theme: Theme): number {
  const texture = theme.texture
  if (!texture || texture.kind === 'none') return 0
  const value = Number.isFinite(texture.opacity) ? texture.opacity : 0
  return Math.min(1, Math.max(0, value))
}

/* --------------------------------- 令牌 --------------------------------- */

export const THEMES: Record<string, Theme> = {
  noir: {
    id: 'noir',
    name: { zh: '夜墨', en: 'Noir' },
    vibe: { zh: '深墨底 · 暖白字 · 一束金', en: 'Deep ink, warm white, a thread of gold' },
    colors: {
      bg: '#0c0c0f',
      fg: '#f3f0e9',
      muted: '#9b958d',
      surface: '#17171c',
      line: '#2e2b28',
      accent: '#c8a15a',
      accent2: '#86a8c0',
    },
    font: { body: SANS, display: SERIF, mono: MONO },
    typeScale: 1,
    radius: 10,
    motion: { ease: 'cubic-bezier(.32,.72,0,1)', ms: 460 },
    // 电影感：衬线标题收到 500，微微压字距；lead 留足行距，让"一束金"落在短行上。
    typeOverrides: {
      display: { weight: 500, tracking: -0.035, lineHeight: 1.02 },
      h1: { weight: 600, tracking: -0.025, lineHeight: 1.08 },
      h2: { weight: 600, tracking: -0.012, lineHeight: 1.16 },
      lead: { weight: 400, lineHeight: 1.56 },
    },
    texture: { kind: 'grain', opacity: 0.07 },
    glow: 0.45,
    elevation: 'layered',
  },
  paper: {
    id: 'paper',
    name: { zh: '纸本', en: 'Paper' },
    vibe: { zh: '未漂纸白 · 墨黑 · 朱砂一点', en: 'Unbleached paper, ink black, a drop of vermilion' },
    colors: {
      bg: '#f7f3ea',
      fg: '#1b1916',
      muted: '#625b50',
      surface: '#efe8db',
      line: '#d5cbb9',
      accent: '#b23a2c',
      accent2: '#3d6b58',
    },
    font: { body: SANS, display: SERIF, mono: MONO },
    typeScale: 0.98,
    radius: 4,
    motion: { ease: 'cubic-bezier(.4,.14,.3,1)', ms: 380 },
    // 书卷：标题比 noir 更松一档（-0.03 / 1.04），h2 回到 600 做主副层级分离。
    typeOverrides: {
      display: { weight: 500, tracking: -0.03, lineHeight: 1.04 },
      h1: { weight: 500, tracking: -0.02, lineHeight: 1.1 },
      h2: { weight: 600, tracking: -0.008, lineHeight: 1.2 },
      lead: { weight: 400, lineHeight: 1.58 },
    },
    texture: { kind: 'dots', opacity: 0.05 },
    glow: 0.18,
    elevation: 'raised',
  },
  aurora: {
    id: 'aurora',
    name: { zh: '极光', en: 'Aurora' },
    vibe: { zh: '深空蓝 · 青绿与品紫', en: 'Deep-space blue, teal and violet' },
    colors: {
      bg: '#070b16',
      fg: '#e9eefc',
      muted: '#939fbf',
      surface: '#101a31',
      line: '#232a52',
      accent: '#57e3c2',
      accent2: '#b98bff',
    },
    font: { body: SANS, display: SANS, mono: MONO },
    typeScale: 1.02,
    radius: 14,
    motion: { ease: 'cubic-bezier(.22,.9,.24,1)', ms: 520 },
    // 科技：无衬线紧排（-0.042），行距给到 1.04 让大字更"块面"。
    typeOverrides: {
      display: { weight: 600, tracking: -0.042, lineHeight: 1.04 },
      h1: { weight: 600, tracking: -0.03, lineHeight: 1.08 },
      h2: { weight: 600, tracking: -0.015, lineHeight: 1.16 },
      lead: { weight: 400, lineHeight: 1.6 },
    },
    texture: { kind: 'grain', opacity: 0.04 },
    glow: 0.75,
    elevation: 'layered',
  },
  signal: {
    id: 'signal',
    name: { zh: '信号', en: 'Signal' },
    vibe: { zh: '瑞士栅格 · 黑白 · 电红', en: 'Swiss grid, black and white, electric red' },
    colors: {
      bg: '#f4f4f1',
      fg: '#0a0a0a',
      muted: '#5b5b5b',
      surface: '#e7e7e2',
      line: '#cfcfc9',
      accent: '#e4271f',
      accent2: '#1b48d1',
    },
    font: { body: SANS, display: SANS, mono: MONO },
    typeScale: 1.04,
    radius: 0,
    motion: { ease: 'cubic-bezier(.2,.8,.2,1)', ms: 320 },
    // 瑞士国际主义：重体 + 极紧排 + 单倍行高；lead 也上到 500，把副标题按"标签"处理。
    typeOverrides: {
      display: { weight: 800, tracking: -0.05, lineHeight: 1 },
      h1: { weight: 800, tracking: -0.04, lineHeight: 1.04 },
      h2: { weight: 700, tracking: -0.02, lineHeight: 1.12 },
      lead: { weight: 500, tracking: -0.005, lineHeight: 1.45 },
    },
    texture: { kind: 'grid', opacity: 0.05 },
    glow: 0.08,
    elevation: 'flat',
  },
  museum: {
    id: 'museum',
    name: { zh: '美术馆', en: 'Museum' },
    vibe: { zh: '灰米墙 · 深棕墨 · 铜绿', en: 'Gallery greige, umber ink, verdigris' },
    colors: {
      bg: '#e9e4db',
      fg: '#241f1a',
      muted: '#5a5247',
      surface: '#dfd8cc',
      line: '#c3baa8',
      accent: '#8d4f2a',
      accent2: '#4c6b63',
    },
    font: { body: SANS, display: SERIF, mono: MONO },
    typeScale: 0.94,
    radius: 2,
    motion: { ease: 'cubic-bezier(.45,.1,.25,1)', ms: 560 },
    // 展签：标题一律轻体（400/500），行距放到 1.08–1.2，靠留白而不是靠字重压场。
    typeOverrides: {
      display: { weight: 400, tracking: -0.015, lineHeight: 1.08 },
      h1: { weight: 500, tracking: -0.015, lineHeight: 1.12 },
      h2: { weight: 500, tracking: -0.005, lineHeight: 1.2 },
      lead: { weight: 400, tracking: 0.005, lineHeight: 1.64 },
    },
    texture: { kind: 'none', opacity: 0 },
    glow: 0.12,
    elevation: 'raised',
  },
  terminal: {
    id: 'terminal',
    name: { zh: '终端', en: 'Terminal' },
    vibe: { zh: '近黑绿 · 荧光绿 · 琥珀警告', en: 'Near-black green, phosphor green, amber' },
    colors: {
      bg: '#060a09',
      fg: '#d9f6e4',
      muted: '#7d9c8e',
      surface: '#0c1512',
      line: '#1d3a2e',
      accent: '#4ade80',
      accent2: '#fbbf24',
    },
    font: { body: MONO, display: MONO, mono: MONO },
    typeScale: 0.96,
    radius: 0,
    motion: { ease: 'steps(6, end)', ms: 300 },
    // 等宽屏：字重统一 500（等宽字体上没有真正的 600），字距靠 -0.035 收成方块感。
    typeOverrides: {
      display: { weight: 500, tracking: -0.035, lineHeight: 1.02 },
      h1: { weight: 500, tracking: -0.02, lineHeight: 1.06 },
      h2: { weight: 500, tracking: -0.005, lineHeight: 1.14 },
      lead: { weight: 400, lineHeight: 1.5 },
    },
    texture: { kind: 'scan', opacity: 0.06 },
    glow: 0.55,
    elevation: 'flat',
  },
}

export const THEME_IDS = Object.keys(THEMES) as (keyof typeof THEMES)[]

export function getTheme(id: string | undefined | null): Theme {
  return (id && THEMES[id]) || THEMES.noir
}

/**
 * 主题 + 覆盖色 → CSS 变量表（渲染与导出共用，唯一入口）。
 *
 * 顺序：7 色 → 派生表面/软底 → 字体/圆角/动效 → 纹理/光晕/层次（v0.2.5）→ 7 变体 × 4。
 * 旧主题对象（没有 texture/glow/elevation）走的默认值 = 无纹理、无光晕、平层，
 * 因此旧 Deck 的渲染结果与 v0.2.0 逐像素一致。
 */
export function themeCssVars(theme: Theme, overrides?: Partial<ThemeColors>): Record<string, string> {
  const colors: ThemeColors = { ...theme.colors, ...(overrides ?? {}) }
  const type = typeScaleOf(theme)
  const textureKind: TextureKind = theme.texture?.kind ?? 'none'
  const textureOp = textureOpacityOf(theme)
  const glow = Math.min(1, Math.max(0, Number.isFinite(theme.glow) ? (theme.glow as number) : 0))
  const elevation: Elevation = theme.elevation ?? 'flat'
  const shadows = shadowsOf(elevation, colors.bg)
  const vars: Record<string, string> = {
    '--d-bg': colors.bg,
    '--d-fg': colors.fg,
    '--d-muted': colors.muted,
    '--d-surface': colors.surface,
    '--d-line': colors.line,
    '--d-accent': colors.accent,
    '--d-accent2': colors.accent2,
    // 派生色：全部由上面 7 色算出，改强调色时二级表面与软底自动跟随。
    '--d-surface-2': surface2Of(colors.bg, colors.surface),
    '--d-accent-soft': accentSoftOf(colors.accent),
    '--d-font-body': theme.font.body,
    '--d-font-display': theme.font.display,
    '--d-font-mono': theme.font.mono,
    '--d-radius': `${theme.radius}px`,
    '--d-ease': theme.motion.ease,
    '--d-motion-ms': `${theme.motion.ms}ms`,
    // 纹理 / 光晕 / 层次
    '--d-texture': textureKind,
    '--d-texture-op': `${textureOp}`,
    '--d-glow': `${glow}`,
    '--d-elevation': elevation,
    '--d-shadow-1': shadows.one,
    '--d-shadow-2': shadows.two,
    // 纹理瓦片（契约 8 个变量之外的内部派生：CSS 没法用关键字直接选图案，
    // 渲染器与 BlockFrame 不在本任务写作用域，所以把"kind → 瓦片"这一步放在这里，
    // 保证 :before 的 mask-image 与 --d-texture 同源、导出后也一样。）
    '--d-texture-image': textureTileOf(textureKind),
  }
  for (const variant of Object.keys(type) as TextVariant[]) {
    vars[`--d-fs-${variant}`] = `${type[variant].size}px`
    vars[`--d-lh-${variant}`] = `${type[variant].lineHeight}`
    vars[`--d-fw-${variant}`] = `${type[variant].weight}`
    vars[`--d-tk-${variant}`] = `${type[variant].tracking}em`
  }
  return vars
}

export function themeVarsCss(vars: Record<string, string>, selector = ':root'): string {
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}:${v};`)
    .join('')
  return `${selector}{${body}}`
}

/** 导出/快照用的纯 CSS 文本（不含函数，可直接内联）。 */
export function themeInlineStyle(theme: Theme, overrides?: Partial<ThemeColors>): string {
  return themeVarsCss(themeCssVars(theme, overrides), '')
    .replace(/^\{/, '')
    .replace(/\}$/, '')
}

export function typeStyleOf(theme: Theme, variant: TextVariant): TypeStyle {
  const base = BASE_TYPE[variant]
  const override = theme.typeOverrides?.[variant]
  const merged = { ...base, ...override }
  return { ...merged, size: Math.round(merged.size * theme.typeScale * 10) / 10 }
}
