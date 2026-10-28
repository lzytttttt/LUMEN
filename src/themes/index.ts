/**
 * themes/index.ts —— 6 套主题令牌。
 * 规范：《08-设计系统》。主题是 TS 数据，运行时注入 --d-* CSS 变量，
 * 导出时同一份数据序列化进独立 HTML，从而保证"编辑器所见 = 导出所得"。
 */
import type { Theme, ThemeColors, TextVariant, TypeStyle } from '@/schema/deck'
import { BASE_TYPE, typeScaleOf } from '@/schema/deck'

const SANS =
  "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif"
const SERIF =
  "'Songti SC', 'Noto Serif SC', 'Source Han Serif SC', 'Songti TC', Georgia, 'Times New Roman', serif"
const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Mono', Consolas, 'Courier New', monospace"

export const THEMES: Record<string, Theme> = {
  noir: {
    id: 'noir',
    name: { zh: '夜墨', en: 'Noir' },
    vibe: { zh: '深墨底 · 暖白字 · 一束金', en: 'Deep ink, warm white, a thread of gold' },
    colors: {
      bg: '#0c0c0f',
      fg: '#f3f0e9',
      muted: '#8f8b83',
      surface: '#17171c',
      line: '#2a2a32',
      accent: '#c8a15a',
      accent2: '#7ea0b8',
    },
    font: { body: SANS, display: SERIF, mono: MONO },
    typeScale: 1,
    radius: 10,
    motion: { ease: 'cubic-bezier(.32,.72,0,1)', ms: 460 },
  },
  paper: {
    id: 'paper',
    name: { zh: '纸本', en: 'Paper' },
    vibe: { zh: '未漂纸白 · 墨黑 · 朱砂一点', en: 'Unbleached paper, ink black, a drop of vermilion' },
    colors: {
      bg: '#f7f3ea',
      fg: '#1b1916',
      muted: '#6d675d',
      surface: '#efe8db',
      line: '#d9d0c0',
      accent: '#b23a2c',
      accent2: '#3d6b58',
    },
    font: { body: SANS, display: SERIF, mono: MONO },
    typeScale: 0.98,
    radius: 4,
    motion: { ease: 'cubic-bezier(.4,.14,.3,1)', ms: 380 },
  },
  aurora: {
    id: 'aurora',
    name: { zh: '极光', en: 'Aurora' },
    vibe: { zh: '深空蓝 · 青绿与品紫', en: 'Deep-space blue, teal and violet' },
    colors: {
      bg: '#070b16',
      fg: '#e9eefc',
      muted: '#8b98b8',
      surface: '#101a31',
      line: '#1e2b4c',
      accent: '#57e3c2',
      accent2: '#b98bff',
    },
    font: { body: SANS, display: SANS, mono: MONO },
    typeScale: 1.02,
    radius: 14,
    motion: { ease: 'cubic-bezier(.22,.9,.24,1)', ms: 520 },
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
      line: '#c9c9c3',
      accent: '#e4271f',
      accent2: '#1b48d1',
    },
    font: { body: SANS, display: SANS, mono: MONO },
    typeScale: 1.04,
    radius: 0,
    motion: { ease: 'cubic-bezier(.2,.8,.2,1)', ms: 320 },
    typeOverrides: {
      display: { weight: 700, tracking: -0.045 },
      h1: { weight: 700, tracking: -0.035 },
    },
  },
  museum: {
    id: 'museum',
    name: { zh: '美术馆', en: 'Museum' },
    vibe: { zh: '灰米墙 · 深棕墨 · 铜绿', en: 'Gallery greige, umber ink, verdigris' },
    colors: {
      bg: '#e9e4db',
      fg: '#241f1a',
      muted: '#6f675c',
      surface: '#dfd8cc',
      line: '#c8c0b1',
      accent: '#8d4f2a',
      accent2: '#4c6b63',
    },
    font: { body: SANS, display: SERIF, mono: MONO },
    typeScale: 0.94,
    radius: 2,
    motion: { ease: 'cubic-bezier(.45,.1,.25,1)', ms: 560 },
    typeOverrides: {
      display: { weight: 400, tracking: -0.02 },
      h1: { weight: 500 },
      lead: { weight: 400 },
    },
  },
  terminal: {
    id: 'terminal',
    name: { zh: '终端', en: 'Terminal' },
    vibe: { zh: '近黑绿 · 荧光绿 · 琥珀警告', en: 'Near-black green, phosphor green, amber' },
    colors: {
      bg: '#060a09',
      fg: '#d9f6e4',
      muted: '#6f8f80',
      surface: '#0c1512',
      line: '#173127',
      accent: '#4ade80',
      accent2: '#fbbf24',
    },
    font: { body: MONO, display: MONO, mono: MONO },
    typeScale: 0.96,
    radius: 0,
    motion: { ease: 'steps(6, end)', ms: 300 },
    typeOverrides: {
      display: { weight: 500, tracking: -0.04, lineHeight: 1.05 },
      h1: { weight: 500 },
      h2: { weight: 500 },
    },
  },
}

export const THEME_IDS = Object.keys(THEMES) as (keyof typeof THEMES)[]

export function getTheme(id: string | undefined | null): Theme {
  return (id && THEMES[id]) || THEMES.noir
}

/** 主题 + 覆盖色 → CSS 变量表（渲染与导出共用）。 */
export function themeCssVars(theme: Theme, overrides?: Partial<ThemeColors>): Record<string, string> {
  const colors: ThemeColors = { ...theme.colors, ...(overrides ?? {}) }
  const type = typeScaleOf(theme)
  const vars: Record<string, string> = {
    '--d-bg': colors.bg,
    '--d-fg': colors.fg,
    '--d-muted': colors.muted,
    '--d-surface': colors.surface,
    '--d-line': colors.line,
    '--d-accent': colors.accent,
    '--d-accent2': colors.accent2,
    '--d-font-body': theme.font.body,
    '--d-font-display': theme.font.display,
    '--d-font-mono': theme.font.mono,
    '--d-radius': `${theme.radius}px`,
    '--d-ease': theme.motion.ease,
    '--d-motion-ms': `${theme.motion.ms}ms`,
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
