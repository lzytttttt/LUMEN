/**
 * creator/templates/theme.ts —— 主题皮肤模板（04 §6.6 / CR-40-187）。
 *
 * 无模型起点：同步生成 `.lumen-plugin.json` + `locales/zh|en.json`，走同一套提案校验。
 * manifest id 固定 `local.creator.template.skin`（不含 `lumen` 段，保留时按 local 信任安装）。
 */
import type { CreatorProposal } from '@/plugins/types'

export interface ThemeTemplateOptions {
  /** 主色（#rrggbb）；同时派生 accent2 与表面色。 */
  accent?: string
  /** 密度：comfortable = 圆角大、行距松；compact = 圆角小、行距紧。 */
  density?: 'comfortable' | 'compact'
  /** 明暗基调（默认 dark，保持与工作台同族）。 */
  mode?: 'dark' | 'light'
}

export const THEME_TEMPLATE_ID = 'local.creator.template.skin'
export const THEME_TEMPLATE_THEME_ID = 'brand-skin'

const DEFAULT_ACCENT = '#1f6feb'

/* ------------------------------ 小型颜色工具（模板私有，非契约） ------------------------------ */

function parseHex(input: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(input.trim())
  if (!match) return null
  const value = Number.parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((channel) => Math.min(255, Math.max(0, Math.round(channel))).toString(16).padStart(2, '0'))
    .join('')}`
}

function mix(from: [number, number, number], to: [number, number, number], ratio: number): string {
  const t = Math.min(1, Math.max(0, ratio))
  return toHex([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t])
}

/** 主色 → 一套可用的 7 令牌主题色（与 6 套内置主题同一套令牌）。 */
export function themeColorsOf(accentInput: string | undefined, mode: 'dark' | 'light'): Record<string, string> {
  const accent = parseHex(accentInput ?? DEFAULT_ACCENT) ?? parseHex(DEFAULT_ACCENT)!
  const dark = mode === 'dark'
  const bg = dark ? [13, 14, 18] : [247, 248, 250]
  const fg = dark ? [235, 238, 245] : [20, 22, 28]
  return {
    bg: toHex(bg as [number, number, number]),
    fg: toHex(fg as [number, number, number]),
    muted: mix(fg as [number, number, number], bg as [number, number, number], 0.45),
    surface: mix(bg as [number, number, number], dark ? [255, 255, 255] : [0, 0, 0], dark ? 0.07 : 0.04),
    line: mix(fg as [number, number, number], bg as [number, number, number], 0.82),
    accent: toHex(accent),
    accent2: mix(accent, [255, 255, 255], 0.42),
  }
}

function manifestOf(options: ThemeTemplateOptions): Record<string, unknown> {
  const density = options.density ?? 'comfortable'
  const radius = density === 'compact' ? 4 : 12
  const typeScale = density === 'compact' ? 0.96 : 1.04
  const colors = themeColorsOf(options.accent, options.mode ?? 'dark')
  return {
    id: THEME_TEMPLATE_ID,
    name: { zh: '品牌皮肤', en: 'Brand skin' },
    version: '0.1.0',
    apiVersion: '1.0',
    minAppVersion: '0.4.0',
    kind: 'declarative',
    author: { name: 'LUMEN Creator' },
    description: {
      zh: '按你的主色生成的一套主题令牌，不覆盖内置 6 套主题。',
      en: 'A theme token set generated from your accent color; built-in themes stay untouched.',
    },
    license: 'CC-BY-4.0',
    capabilities: ['theme:contribute', 'i18n:contribute'],
    contributes: {
      themes: [
        {
          id: THEME_TEMPLATE_THEME_ID,
          name: { zh: '品牌皮肤', en: 'Brand skin' },
          vibe: { zh: '克制、专业', en: 'Restrained and precise' },
          colors,
          typeScale,
          radius,
          elevation: 'raised',
        },
      ],
      i18n: [
        {
          zh: { 'skin.name': '品牌皮肤', 'skin.vibe': '克制、专业' },
          en: { 'skin.name': 'Brand skin', 'skin.vibe': 'Restrained and precise' },
        },
      ],
    },
  }
}

/** 主题皮肤模板 → 提案（未走校验；入口在 `templates/index.ts`）。 */
export function buildThemeTemplate(options: ThemeTemplateOptions = {}): CreatorProposal {
  const densityZh = (options.density ?? 'comfortable') === 'compact' ? '紧凑' : '舒展'
  const densityEn = (options.density ?? 'comfortable') === 'compact' ? 'compact' : 'airy'
  return {
    title: '品牌主题皮肤',
    summary: `按主色 ${(options.accent ?? DEFAULT_ACCENT).toUpperCase()} 生成主题与双语语言包`,
    kind: 'declarative',
    risk: 'low',
    capabilities: ['theme:contribute', 'i18n:contribute'],
    files: [
      { path: '.lumen-plugin.json', content: JSON.stringify(manifestOf(options), null, 2) },
      {
        path: 'locales/zh.json',
        content: JSON.stringify({ 'skin.name': '品牌皮肤', 'skin.vibe': '克制、专业', 'skin.density': densityZh }, null, 2),
      },
      {
        path: 'locales/en.json',
        content: JSON.stringify({ 'skin.name': 'Brand skin', 'skin.vibe': 'Restrained and precise', 'skin.density': densityEn }, null, 2),
      },
    ],
    changes: [
      { surface: 'theme', detail: `新增主题「品牌皮肤」（主色 ${(options.accent ?? DEFAULT_ACCENT).toUpperCase()}）` },
      { surface: 'theme', detail: `圆角与字号密度：${densityZh}` },
      { surface: 'i18n', detail: '附 zh/en 双语语言包' },
    ],
    trialNote: '主题在 6 套预设之外，可随时切回',
  }
}
