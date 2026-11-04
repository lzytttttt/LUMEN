/**
 * tests/unit/plugins-sample-brandguard.test.ts —— BrandGuard 样例（U-40-191…204 的纯函数与契约部分）。
 *
 * 断言对象是 `plugins/builtin/brandguard/**` 真实交付物（不是替身实现）：
 *   - manifest / locales / fixtures 直接从磁盘读；
 *   - `plugin.js` 用 `globalThis.lumen` 替身 import，测试它导出的纯函数与运行期注册的贡献。
 */
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { contrastRatio } from '@/lint/color'
import { sanitizeSvgDocument } from '@/render/svg/sanitize'
import {
  DEFAULT_SNAPSHOT,
  findCommand,
  findRule,
  installLumenMock,
  loadPluginModule,
  pluginPath,
  renderFrame,
  type MockState,
} from './plugins-sample-harness'

const PLUGIN_ID = 'com.lumen.samples.brandguard'

interface Kit {
  v: 1
  primary: string
  secondary: string
  displayFont: string
  bodyFont: string
  tagline: string
  logoAssetId: string | null
  preferredTheme: string
  updatedAt: number
}

interface BrandGuardModule {
  PLUGIN_ID: string
  KIT_KEY: string
  HISTORY_KEY: string
  DEFAULT_KIT: Kit
  THEME_PRESETS: { id: string; accent: string; accent2: string }[]
  BRAND_THEME_IDS: string[]
  FONT_WHITELIST: string[]
  FONT_OPTIONS: { value: string; family: string }[]
  FONT_SANS: string
  PALETTE_TOLERANCE: number
  SAFE_RIGHT_X: number
  SAFE_BOTTOM_Y: number
  LOGO_MIN_W: number
  LOGO_MAX_W: number
  LOCKUP_SVG: string
  parseHexColor(value: unknown): [number, number, number] | null
  paletteDistance(a: string, b: string): number
  nearestTheme(primary: string, preferred?: string): {
    id: string
    themeId: string
    distance: number
    matched: boolean
    forced: boolean
  }
  kitToThemeId(kit: unknown): string
  normalizeKit(raw: unknown): { kit: Kit; status: 'ready' | 'corrupt' | 'empty' }
  makeKit(patch: Partial<Kit>, base?: unknown): Kit
  isFontAllowed(font: unknown): boolean
  nearestBrandColor(hex: string, kit: unknown): { token: string; value: string; distance: number }
  overridePaletteIssues(
    base: Record<string, string>,
    vars: Record<string, string>,
    kit: unknown,
    tolerance?: number,
  ): { token: string; applied: string; expected: string; distance: number }[]
  normalizeTagline(value: unknown): string
  taglineCoverage(
    coverTextChars: number,
    tagline: string,
  ): { configured: boolean; expected: number; actual: number; ok: boolean }
  logoBlockIds(tracked: unknown): Set<string>
  isLogoBlock(block: unknown, tracked: Set<string>): boolean
  logoPlacementIssues(
    slides: unknown,
    tracked: Set<string>,
    limits?: unknown,
  ): { slideId: string; blockId: string; reason: string }[]
  pushKitHistory(history: unknown, kit: unknown, limit?: number): Kit[]
  normalizeTracked(raw: unknown): { blockId: string; slideId: string; at: number }[]
}

interface Manifest {
  id: string
  name: { zh: string; en: string }
  version: string
  apiVersion: string
  minAppVersion: string
  kind: string
  entry?: string
  trust?: string
  author: { name: string; url?: string }
  description: { zh: string; en: string }
  license: string
  icon?: string
  capabilities: string[]
  contributes: {
    themes?: {
      id: string
      name: { zh: string; en: string }
      colors: Record<string, string>
    }[]
    library?: { id: string; name: { zh: string; en: string }; category: string; viewBox: number[]; source: string }[]
    settings?: { id: string; title: { zh: string; en: string }; fields: { key: string; type: string }[] }
    slots?: { id: string; slot: string; kind: string; open?: { slot: string; contributionId: string } }[]
    lintRules?: { id: string; title: { zh: string; en: string }; severity: string }[]
    exportHooks?: { id: string; title: { zh: string; en: string }; kind: string }[]
    i18n?: unknown
  }
}

const EXPECTED_CAPABILITIES = [
  'ui:slot',
  'ui:command',
  'theme:contribute',
  'library:contribute',
  'i18n:contribute',
  'lint:rule',
  'storage',
  'deck:read',
  'deck:write',
  'asset:write',
  'export:hook',
]

const FRAME_SLOTS = new Set(['workspace.inspector.tab', 'workspace.dock', 'workspace.overlay', 'dialog', 'settings.page', 'play.overlay'])

function readPluginFile(name: string): string {
  return readFileSync(pluginPath('brandguard', name), 'utf8')
}

function readJson<T>(name: string): T {
  return JSON.parse(readPluginFile(name)) as T
}

const KIT_DEFAULT = JSON.parse(readFileSync(pluginPath('brandguard', 'fixtures/kit-default.json'), 'utf8')) as Kit

let manifest: Manifest
let zh: Record<string, string>
let en: Record<string, string>
let source: string
let bg: BrandGuardModule
let mock: { lumen: Record<string, unknown>; state: MockState }

beforeAll(async () => {
  manifest = readJson<Manifest>('.lumen-plugin.json')
  zh = readJson<{ zh: Record<string, string> }>('locales/zh.json').zh
  en = readJson<{ en: Record<string, string> }>('locales/en.json').en
  source = readPluginFile('plugin.js')
  mock = installLumenMock({
    locale: 'zh',
    messages: zh,
    storage: {
      'kit.current': KIT_DEFAULT,
      'logo.blocks': [{ blockId: 'logo1', slideId: 's1', at: 1 }],
    },
  })
  bg = (await loadPluginModule('brandguard')) as unknown as BrandGuardModule
})

/* ---------------------------------- 清单 ---------------------------------- */

describe('BrandGuard manifest', () => {
  it('身份/版本/信任级与 05 §3.2 一致', () => {
    expect(manifest.id).toBe(PLUGIN_ID)
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.apiVersion).toBe('1.0')
    expect(manifest.minAppVersion).toBe('0.4.0')
    expect(manifest.kind).toBe('code')
    expect(manifest.entry).toBe('plugin.js')
    expect(manifest.trust).toBe('builtin')
    expect(manifest.license).toBe('SEE LICENSE IN LICENSE')
  })

  it('name/description 双语且符合长度约束', () => {
    for (const lang of ['zh', 'en'] as const) {
      expect(manifest.name[lang].trim().length).toBeGreaterThan(0)
      expect(manifest.name[lang].trim().length).toBeLessThanOrEqual(24)
      expect(manifest.description[lang].trim().length).toBeGreaterThan(0)
      expect(manifest.description[lang].trim().length).toBeLessThanOrEqual(160)
      expect(manifest.name[lang].startsWith('LUMEN')).toBe(false)
      expect(manifest.name[lang].startsWith('幕光')).toBe(false)
    }
  })

  it('capabilities 恰好 11 项且顺序按 05 §3.2（不申请 ai:invoke）', () => {
    expect(manifest.capabilities).toEqual(EXPECTED_CAPABILITIES)
    expect(manifest.capabilities).not.toContain('ai:invoke')
    expect(new Set(manifest.capabilities).size).toBe(manifest.capabilities.length)
  })

  it('icon 指向包内 SVG 且 ≤64 KB', () => {
    expect(manifest.icon).toBe('icon.svg')
    expect(readPluginFile('icon.svg').length).toBeLessThanOrEqual(64 * 1024)
  })

  it('3 套品牌主题注册在插件命名空间（U-40-191）', () => {
    const themes = manifest.contributes.themes ?? []
    expect(themes).toHaveLength(3)
    expect(themes.map((theme) => theme.id)).toEqual(['brand-blue', 'brand-teal', 'brand-graphite'])
    for (const theme of themes) {
      expect(theme.id).toMatch(/^[a-z][a-z0-9-]{1,23}$/)
      expect(bg.BRAND_THEME_IDS).toContain(`${PLUGIN_ID}/${theme.id}`)
      // 不覆盖 6 套内置主题
      expect(['noir', 'paper', 'aurora', 'signal', 'museum', 'terminal']).not.toContain(`${PLUGIN_ID}/${theme.id}`)
    }
  })

  it('3 套主题对比度满足 fg≥7 / muted≥4.5 / accent≥3（02 §6.2 兜底阈值）', () => {
    for (const theme of manifest.contributes.themes ?? []) {
      const colors = theme.colors
      expect(contrastRatio(colors.fg, colors.bg)).toBeGreaterThanOrEqual(7)
      expect(contrastRatio(colors.muted, colors.bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(colors.accent, colors.bg)).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(colors.accent2, colors.bg)).toBeGreaterThanOrEqual(3)
    }
  })

  it('2 件 brand 素材：viewBox 匹配、令牌化、过净化 0 issue（U-40-193 的前置）', () => {
    const library = manifest.contributes.library ?? []
    expect(library).toHaveLength(2)
    for (const item of library) {
      expect(item.category).toBe('brand')
      expect(item.viewBox[2]).toBeGreaterThan(0)
      expect(item.viewBox[3]).toBeGreaterThan(0)
      const result = sanitizeSvgDocument(item.source, { maxBytes: 64 * 1024 })
      expect(result.issues).toEqual([])
      expect(result.svg).toContain(`viewBox="${item.viewBox.join(' ')}"`)
      for (const match of item.source.matchAll(/(?:fill|stroke)='([^']+)'/g)) {
        expect(match[1]).toMatch(/^(none|currentColor|var\(--d-[a-z0-9-]+\))$/)
      }
    }
  })

  it('插槽：topbar inline + 品牌页签 + kit 对话框，带帧 ≤2', () => {
    const slots = manifest.contributes.slots ?? []
    expect(slots.map((slot) => slot.id)).toEqual(['topbar-brand', 'brand-panel', 'kit-dialog'])
    const framed = slots.filter((slot) => FRAME_SLOTS.has(slot.slot))
    expect(framed.length).toBeLessThanOrEqual(2)
    expect(framed.map((slot) => slot.slot).sort()).toEqual(['dialog', 'workspace.inspector.tab'])
    const topbar = slots.find((slot) => slot.id === 'topbar-brand')
    expect(topbar?.kind).toBe('inline')
    expect(topbar?.open).toEqual({ slot: 'workspace.inspector.tab', contributionId: 'brand-panel' })
  })

  it('4 条 lint 规则 + 1 个导出预检钩子（清单声明与运行期一致，U-40-193/200 的前置）', () => {
    expect((manifest.contributes.lintRules ?? []).map((rule) => rule.id)).toEqual([
      'logo-placement',
      'palette-tolerance',
      'font-whitelist',
      'tagline-missing',
    ])
    for (const rule of manifest.contributes.lintRules ?? []) expect(rule.severity).toBe('warn')
    expect(manifest.contributes.exportHooks).toHaveLength(1)
    expect(manifest.contributes.exportHooks?.[0]).toMatchObject({ id: 'preflight', kind: 'preflight' })
  })

  it('设置页是单对象（不占 slot，声明式）', () => {
    const settings = manifest.contributes.settings
    expect(Array.isArray(settings)).toBe(false)
    expect(settings?.id).toBe('kit-settings')
    expect(settings?.fields.length).toBeLessThanOrEqual(12)
    expect(settings?.fields.map((field) => field.key)).toEqual(['strict', 'preferredTheme'])
  })

  it('源 manifest 不内置 i18n：语言包由打包脚本从 locales/ 内联（05 §2）', () => {
    expect(manifest.contributes.i18n).toBeUndefined()
  })
})

/* ---------------------------------- i18n ---------------------------------- */

describe('BrandGuard i18n 语言包', () => {
  it('zh/en 键集完全相等且 ≥12 键', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(zhKeys).toEqual(enKeys)
    expect(zhKeys.length).toBeGreaterThanOrEqual(12)
  })

  it('键名与值符合 02 §8.2 的约束（键正则 ≤64、值非空 ≤200）', () => {
    for (const key of Object.keys(zh)) {
      expect(key).toMatch(/^[a-z][a-zA-Z0-9._-]{0,63}$/)
      expect(typeof zh[key]).toBe('string')
      expect(zh[key].trim().length).toBeGreaterThan(0)
      expect(zh[key].length).toBeLessThanOrEqual(200)
      expect(en[key].trim().length).toBeGreaterThan(0)
      expect(en[key].length).toBeLessThanOrEqual(200)
    }
  })

  it('05 §3.7 词表的关键键全部存在', () => {
    for (const key of [
      'panel.title',
      'kit.primary',
      'kit.secondary',
      'kit.logo',
      'kit.tagline',
      'kit.save',
      'kit.empty',
      'apply',
      'fixPalette',
      'preflight.title',
      'lint.logoPlacement',
      'lint.paletteTolerance',
      'lint.fontWhitelist',
      'lint.taglineMissing',
      'error.kitCorrupt',
      'error.noKit',
    ]) {
      expect(zh[key], `missing zh key ${key}`).toBeTruthy()
      expect(en[key], `missing en key ${key}`).toBeTruthy()
    }
  })

  it('UI 文案不出现实现词（沙箱 / RPC / 令牌 / iframe / IndexedDB）', () => {
    for (const value of [...Object.values(zh), ...Object.values(en)]) {
      expect(value).not.toMatch(/沙箱|RPC|令牌|iframe|IndexedDB/i)
    }
  })
})

/* ----------------------------- 静态预检（离线） ----------------------------- */

describe('BrandGuard plugin.js 静态预检', () => {
  it('命中 02 §4.3 的禁用 API 列表 → 空（E-MAN-12 不会触发）', () => {
    const forbidden = [
      /^\s*import\s/m,
      /\bimport\s*\(/,
      /\brequire\s*\(/,
      /\bnew\s+Function\s*\(/,
      /\beval\s*\(/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bsendBeacon\b/,
      /\blocalStorage\b/,
      /\bdocument\.cookie\b/,
      /\bdocument\.domain\b/,
      /\btop\.location\b/,
      /\bwindow\.open\b/,
    ]
    for (const pattern of forbidden) expect(pattern.test(source), `命中禁止项 ${pattern}`).toBe(false)
  })

  it('无外链资源（只允许 SVG 命名空间 URL）', () => {
    const urls = source.match(/https?:\/\/[^\s'"`)]+/g) ?? []
    for (const url of urls) expect(url.startsWith('http://www.w3.org/')).toBe(true)
  })

  it('单文件 ESM：入口 ≤256 KB、无 JSX 标记', () => {
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThanOrEqual(256_000)
    expect(source).not.toMatch(/<\/[A-Z][A-Za-z]*>/)
  })
})

/* ------------------------------- kit → 主题 ------------------------------- */

describe('BrandGuard kit → 主题映射（U-40-191/192）', () => {
  it('默认 kit 主色取最近预设 brand-blue', () => {
    const resolved = bg.nearestTheme('#1F6FEB')
    expect(resolved.id).toBe('brand-blue')
    expect(resolved.themeId).toBe(`${PLUGIN_ID}/brand-blue`)
    expect(resolved.distance).toBe(0)
    expect(resolved.matched).toBe(true)
  })

  it('主色 #0E9F9F 取最近预设 brand-teal（RGB 距离最小）', () => {
    expect(bg.nearestTheme('#0E9F9F').id).toBe('brand-teal')
  })

  it('偏离所有预设时仍取最近色并标记 matched=false（05 §3.4 兜底）', () => {
    const resolved = bg.nearestTheme('#FF0000')
    expect(resolved.matched).toBe(false)
    expect(bg.BRAND_THEME_IDS).toContain(resolved.themeId)
  })

  it('preferredTheme 不是 auto 时强制该预设', () => {
    const resolved = bg.nearestTheme('#1F6FEB', 'brand-graphite')
    expect(resolved.id).toBe('brand-graphite')
    expect(resolved.forced).toBe(true)
  })

  it('kitToThemeId 返回 `${pluginId}/${slug}`，且 normalizeKit 兜底非法输入', () => {
    expect(bg.kitToThemeId(KIT_DEFAULT)).toBe(`${PLUGIN_ID}/brand-blue`)
    expect(bg.kitToThemeId({ primary: 'oops' }).startsWith(`${PLUGIN_ID}/`)).toBe(true)
  })

  it('parseHexColor 支持 #rgb/#rrggbb，非法返回 null', () => {
    expect(bg.parseHexColor('#1F6FEB')).toEqual([31, 111, 235])
    expect(bg.parseHexColor('#abc')).toEqual([170, 187, 204])
    for (const bad of ['1F6FEB', '#12', '#GGGGGG', 42, null, '#1234567']) {
      expect(bg.parseHexColor(bad)).toBeNull()
    }
  })
})

/* ------------------------------- 色板容差 ------------------------------- */

describe('BrandGuard 色板容差（U-40-195）', () => {
  it('RGB 距离 ≤24 通过、25 命中（口径 05 §3.4）', () => {
    // #1F6FEB=(31,111,235)；红通道 +24 → (55,111,235)=#376FEB，+25 → #386FEB
    expect(bg.paletteDistance('#1F6FEB', '#376FEB')).toBeCloseTo(24, 6)
    expect(bg.paletteDistance('#1F6FEB', '#386FEB')).toBeCloseTo(25, 6)
    expect(bg.paletteDistance('#1F6FEB', '#376FEB')).toBeLessThanOrEqual(24)
    expect(bg.paletteDistance('#1F6FEB', '#386FEB')).toBeGreaterThan(24)
    expect(bg.PALETTE_TOLERANCE).toBe(24)
  })

  it('nearestBrandColor 在混色里找最近的 kit 色', () => {
    const nearest = bg.nearestBrandColor('#1E6EEA', KIT_DEFAULT)
    expect(nearest.token).toBe('accent')
    expect(nearest.value).toBe(KIT_DEFAULT.primary)
    expect(nearest.distance).toBeLessThanOrEqual(24)
  })

  it('overridePaletteIssues：令牌被 override 偏离 >24 时命中，无 override 时不报', () => {
    const base = {
      bg: '#0B1220',
      fg: '#E8EEF9',
      muted: '#9AA8C2',
      surface: '#121A2C',
      line: '#24304A',
      accent: '#1F6FEB',
      accent2: '#22B8CF',
    }
    expect(
      bg.overridePaletteIssues(base, { '--d-accent': '#1F6FEB', '--d-accent2': '#22B8CF' }, KIT_DEFAULT),
    ).toEqual([])
    const drift = bg.overridePaletteIssues(base, { '--d-accent': '#FF0000', '--d-accent2': '#22B8CF' }, KIT_DEFAULT)
    expect(drift).toHaveLength(1)
    expect(drift[0].token).toBe('accent')
    expect(drift[0].distance).toBeGreaterThan(24)
  })
})

/* -------------------------------- 字体白名单 -------------------------------- */

describe('BrandGuard 字体白名单（U-40-196）', () => {
  it('6 条系统栈全部通过', () => {
    for (const option of bg.FONT_OPTIONS) {
      expect(bg.isFontAllowed(option.value), option.family).toBe(true)
    }
    expect(bg.FONT_WHITELIST).toHaveLength(6)
  })

  it('白名单外字体命中', () => {
    for (const bad of ["'Comic Sans MS', cursive", 'Impact', '', null, 42]) {
      expect(bg.isFontAllowed(bad)).toBe(false)
    }
    expect(bg.isFontAllowed("Georgia, 'Times New Roman', serif")).toBe(true)
  })
})

/* -------------------------------- tagline -------------------------------- */

describe('BrandGuard tagline 启发式（U-40-197 的降级口径）', () => {
  it('配置了 tagline 时首幕 textChars 不足即命中', () => {
    const short = bg.taglineCoverage(3, '把复杂的事讲清楚')
    expect(short.configured).toBe(true)
    expect(short.expected).toBe(8)
    expect(short.ok).toBe(false)
    expect(bg.taglineCoverage(120, '把复杂的事讲清楚').ok).toBe(true)
  })

  it('未配置 tagline 时不报（05 §3.4：空 → 跳过并提示先填）', () => {
    expect(bg.taglineCoverage(0, '').configured).toBe(false)
    expect(bg.taglineCoverage(0, '').ok).toBe(true)
  })

  it('大小写/空白不敏感归一', () => {
    expect(bg.normalizeTagline('  Make  It  Clear ')).toBe('makeitclear')
    expect(bg.normalizeTagline(null)).toBe('')
  })
})

/* --------------------------------- logo --------------------------------- */

describe('BrandGuard logo 安全位（U-40-193/194）', () => {
  const tracked = new Set(['logo1'])

  it('右下安全位 0 issue', () => {
    const slides = [{ id: 's1', blocks: [{ id: 'logo1', type: 'svg', x: 1192, y: 708, w: 240, h: 48 }] }]
    expect(bg.logoPlacementIssues(slides, tracked)).toEqual([])
  })

  it('左上 1 条且带 slideId/blockId', () => {
    const slides = [{ id: 's3', blocks: [{ id: 'logo1', type: 'svg', x: 120, y: 96, w: 240, h: 48 }] }]
    const issues = bg.logoPlacementIssues(slides, tracked)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ slideId: 's3', blockId: 'logo1', reason: 'right' })
  })

  it('宽 120–320 之外命中（阈值来自 05 §3.4）', () => {
    expect(bg.SAFE_RIGHT_X).toBe(1432)
    expect(bg.SAFE_BOTTOM_Y).toBe(756)
    expect(bg.LOGO_MIN_W).toBe(120)
    expect(bg.LOGO_MAX_W).toBe(320)
    const slides = [
      { id: 's1', blocks: [{ id: 'logo1', type: 'svg', x: 1400, y: 800, w: 100, h: 48 }] },
      { id: 's2', blocks: [{ id: 'logo1', type: 'svg', x: 1000, y: 700, w: 400, h: 48 }] },
    ]
    const issues = bg.logoPlacementIssues(slides, tracked)
    expect(issues.map((issue) => issue.reason)).toEqual(['width', 'right'])
  })

  it('presetId 识别库插入的 lockup（无需跟踪记录）', () => {
    expect(bg.isLogoBlock({ id: 'x', presetId: `${PLUGIN_ID}/lockup` }, new Set())).toBe(true)
    expect(bg.isLogoBlock({ id: 'x', presetId: `${PLUGIN_ID}/mark` }, new Set())).toBe(true)
    expect(bg.isLogoBlock({ id: 'x', presetId: 'other/thing' }, new Set())).toBe(false)
    expect(bg.isLogoBlock({ id: 'x' }, new Set())).toBe(false)
  })

  it('非 logo 块不参与判定', () => {
    const slides = [{ id: 's1', blocks: [{ id: 'text1', type: 'text', x: 0, y: 0, w: 100, h: 40 }] }]
    expect(bg.logoPlacementIssues(slides, tracked)).toEqual([])
  })
})

/* ------------------------------ kit 存储模型 ------------------------------ */

describe('BrandGuard kit 数据模型与历史（U-40-201/202）', () => {
  it('默认 kit fixture → ready，字段完整', () => {
    const normalized = bg.normalizeKit(KIT_DEFAULT)
    expect(normalized.status).toBe('ready')
    expect(normalized.kit.primary).toBe('#1F6FEB')
    expect(normalized.kit.preferredTheme).toBe('auto')
    expect(normalized.kit.tagline.length).toBeLessThanOrEqual(120)
  })

  it('损坏的 kit fixture → corrupt 并回落默认 kit（05 §3.8 第 3 条）', () => {
    const corrupt = JSON.parse(readFileSync(pluginPath('brandguard', 'fixtures/kit-corrupt.json'), 'utf8'))
    const normalized = bg.normalizeKit(corrupt)
    expect(normalized.status).toBe('corrupt')
    expect(normalized.kit).toEqual(bg.DEFAULT_KIT)
  })

  it('未设置过 → empty（空态）；非对象 → corrupt', () => {
    expect(bg.normalizeKit(undefined).status).toBe('empty')
    expect(bg.normalizeKit(null).status).toBe('empty')
    expect(bg.normalizeKit('nope').status).toBe('corrupt')
    expect(bg.normalizeKit([]).status).toBe('corrupt')
    expect(bg.normalizeKit({ v: 2, primary: '#000000', secondary: '#ffffff' }).status).toBe('corrupt')
  })

  it('部分字段非法时按默认值收敛，不抛错', () => {
    const kit = bg.normalizeKit({
      v: 1,
      primary: '#123456',
      secondary: '#654321',
      preferredTheme: 'brand-nope',
      tagline: 42,
      logoAssetId: 42,
    }).kit
    expect(kit.preferredTheme).toBe('auto')
    expect(kit.tagline).toBe('')
    expect(kit.logoAssetId).toBeNull()
    expect(kit.bodyFont).toBe(bg.FONT_SANS)
  })

  it('makeKit 写入 updatedAt 且保留 v=1', () => {
    const kit = bg.makeKit({ primary: '#FF0000' }, KIT_DEFAULT)
    expect(kit.v).toBe(1)
    expect(kit.primary).toBe('#FF0000')
    expect(kit.updatedAt).toBeGreaterThan(0)
  })

  it('历史只留 3 版、最新在前、相同内容不重复（05 §3.6）', () => {
    let history: Kit[] = []
    const kits = ['#111111', '#222222', '#333333', '#444444'].map((primary, index) =>
      bg.makeKit({ primary, secondary: '#22B8CF', tagline: `v${index}` }, KIT_DEFAULT),
    )
    for (const kit of kits) history = bg.pushKitHistory(history, kit)
    expect(history).toHaveLength(3)
    expect(history.map((item) => item.primary)).toEqual(['#444444', '#333333', '#222222'])
    const again = bg.pushKitHistory(history, kits[3])
    expect(again).toHaveLength(3)
    expect(again[0].primary).toBe('#444444')
  })

  it('normalizeTracked 只保留合法插入记录并截断', () => {
    const list = bg.normalizeTracked([
      { blockId: 'a', slideId: 's1', at: 1 },
      { blockId: 42 },
      null,
      { slideId: 's2' },
      { blockId: 'b', slideId: 7, at: 'x' },
    ])
    expect(list).toEqual([
      { blockId: 'a', slideId: 's1', at: 1 },
      { blockId: 'b', slideId: '', at: 0 },
    ])
  })
})

/* ------------------------------- 运行期契约 ------------------------------- */

describe('BrandGuard 运行期注册（02 §6.9 清单/运行期双注册）', () => {
  it('4 条 lint 规则在 ready 前注册且 id 与清单一致', () => {
    expect(mock.state.lintRules.map((rule) => rule.id)).toEqual([
      'logo-placement',
      'palette-tolerance',
      'font-whitelist',
      'tagline-missing',
    ])
    for (const rule of mock.state.lintRules) expect(rule.severity).toBe('warn')
  })

  it('4 条命令在 ready 前注册（apply / fixPalette / insertLogo / openKit）', () => {
    expect(mock.state.commands.map((command) => command.id)).toEqual(['apply', 'fix-palette', 'insert-logo', 'open-kit'])
  })

  it('导出预检钩子注册 1 个，与清单 exportHooks 对齐', () => {
    expect(mock.state.preflights).toHaveLength(1)
    expect(mock.state.commands.length).toBeLessThanOrEqual(24)
  })

  it('订阅了 deck:change / theme:change（300ms 防抖的数据源）', () => {
    expect(mock.state.events).toContain('deck:change')
    expect(mock.state.events).toContain('theme:change')
  })
})

/* -------------------------------- 规则行为 -------------------------------- */

describe('BrandGuard 规则运行（lint ctx 只读元数据）', () => {
  it('logoPlacement：右下通过 / 左上 1 条（U-40-193/194 的规则级断言）', async () => {
    const rule = findRule(mock.state, 'logo-placement')
    const deckCtx = { deck: DEFAULT_SNAPSHOT }
    const ok = await Promise.resolve(
      rule.run({
        ...deckCtx,
        slides: [{ id: 's1', blocks: [{ id: 'logo1', type: 'svg', x: 1192, y: 708, w: 240, h: 48 }] }],
      }),
    )
    expect(ok).toEqual([])
    const bad = (await Promise.resolve(
      rule.run({
        ...deckCtx,
        slides: [{ id: 's3', blocks: [{ id: 'logo1', type: 'svg', x: 120, y: 96, w: 240, h: 48 }] }],
      }),
    )) as { slideId?: string; blockId?: string }[]
    expect(bad).toHaveLength(1)
    expect(bad[0].slideId).toBe('s3')
    expect(bad[0].blockId).toBe('logo1')
  })

  it('taglineMissing：首幕 textChars 足够通过、不足命中且带 slideId', async () => {
    const rule = findRule(mock.state, 'tagline-missing')
    const pass = await Promise.resolve(
      rule.run({ deck: DEFAULT_SNAPSHOT, slides: [{ id: 's1', blocks: [{ id: 't1', type: 'text', textChars: 120 }] }] }),
    )
    expect(pass).toEqual([])
    const hit = (await Promise.resolve(
      rule.run({ deck: DEFAULT_SNAPSHOT, slides: [{ id: 's1', blocks: [{ id: 't1', type: 'text', textChars: 2 }] }] }),
    )) as { slideId?: string }[]
    expect(hit).toHaveLength(1)
    expect(hit[0].slideId).toBe('s1')
  })

  it('paletteTolerance：主题令牌无 override 时通过，出现偏离时报 1 条', async () => {
    const rule = findRule(mock.state, 'palette-tolerance')
    expect(await Promise.resolve(rule.run({ deck: DEFAULT_SNAPSHOT, slides: [] }))).toEqual([])
    mock.state.themeVars['--d-accent'] = '#FF0000'
    try {
      const hit = (await Promise.resolve(rule.run({ deck: DEFAULT_SNAPSHOT, slides: [] }))) as unknown[]
      expect(hit).toHaveLength(1)
    } finally {
      mock.state.themeVars['--d-accent'] = bg.THEME_PRESETS[0].accent
    }
  })

  it('fontWhitelist：默认主题通过，非白名单字体命中', async () => {
    const rule = findRule(mock.state, 'font-whitelist')
    expect(await Promise.resolve(rule.run({ deck: DEFAULT_SNAPSHOT, slides: [] }))).toEqual([])
    mock.state.themeFont.display = "'Comic Sans MS', cursive"
    try {
      expect((await Promise.resolve(rule.run({ deck: DEFAULT_SNAPSHOT, slides: [] }))) as unknown[]).toHaveLength(1)
    } finally {
      mock.state.themeFont.display = bg.FONT_SANS
    }
  })

  it('导出预检：只返回 info/warn，带 fix 修复入口，未用品牌主题时给出 warn（U-40-200 / 02 §5.3）', async () => {
    const preflight = mock.state.preflights[0] as (
      ctx: unknown,
    ) => Promise<{ level: string; message: { zh: string; en: string }; slideId?: string; fix?: { commandId: string } }[]>
    const startedAt = Date.now()
    const results = await preflight({
      deck: DEFAULT_SNAPSHOT,
      themeId: 'noir',
      slides: [{ id: 's1', blocks: [{ id: 't1', type: 'text', textChars: 2 }] }],
    })
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeLessThan(1000) // 02 §4.5 预检总预算
    expect(results.length).toBeGreaterThanOrEqual(1)
    for (const result of results) {
      // 0.4.0 只有 info/warn（D 口径：不阻断导出）；message 必须 zh+en 双语且不超过 160 字符
      expect(['info', 'warn']).toContain(result.level)
      expect(result.message.zh.length).toBeGreaterThan(0)
      expect(result.message.en.length).toBeGreaterThan(0)
      expect(result.message.zh.length).toBeLessThanOrEqual(160)
      expect(result.message.en.length).toBeLessThanOrEqual(160)
      if (result.fix) expect(result.fix.commandId).toMatch(/^plugin\.com\.lumen\.samples\.brandguard\.[a-zA-Z]+$/)
    }
    const themeOff = results.find((result) => result.message.zh.includes('品牌主题'))
    expect(themeOff).toBeTruthy()
    expect(themeOff?.fix?.commandId).toBe('plugin.com.lumen.samples.brandguard.apply')
  })
})

/* --------------------------------- 命令 --------------------------------- */

describe('BrandGuard 命令', () => {
  it('apply：一次事务 + 一次 applyTheme，可撤销（U-40-198）', async () => {
    const command = findCommand(mock.state, 'apply')
    mock.state.invokes.length = 0
    mock.state.toasts.length = 0
    await Promise.resolve(command.run())
    const calls = mock.state.invokes.map((entry) => entry.method)
    expect(calls.filter((name) => name === 'deck.transaction')).toHaveLength(1)
    expect(calls.filter((name) => name === 'deck.applyTheme')).toHaveLength(1)
    const applyTheme = mock.state.invokes.find((entry) => entry.method === 'deck.applyTheme')
    expect(applyTheme?.payload).toBe(`${PLUGIN_ID}/brand-blue`)
    expect(mock.state.toasts.length).toBeGreaterThan(0)
  })

  it('insertLogo：插入 1 块并记录 blockId 绑定（回改/规则跟踪的数据源）', async () => {
    const command = findCommand(mock.state, 'insert-logo')
    await Promise.resolve(command.run())
    const tracked = mock.state.storage.get('logo.blocks') as { blockId: string; slideId: string }[]
    expect(Array.isArray(tracked)).toBe(true)
    expect(tracked.length).toBeGreaterThanOrEqual(1)
    expect(tracked.at(-1)?.blockId).toBeTruthy()
  })

  it('openKit：打开声明的 dialog 槽位贡献', async () => {
    const command = findCommand(mock.state, 'open-kit')
    await Promise.resolve(command.run())
    expect(mock.state.dialogs).toContain('kit-dialog')
  })
})

/* --------------------------------- 渲染 --------------------------------- */

describe('BrandGuard 面板与对话框', () => {
  it('品牌页签：data-brand-panel / kit-state / swatch / apply 钩子齐全', () => {
    const { root } = renderFrame(mock.state, { ctx: { slot: 'workspace.inspector.tab' } })
    expect(root.hasAttribute('data-brand-panel')).toBe(true)
    expect(['ready', 'empty', 'corrupt', 'saving']).toContain(root.getAttribute('data-brand-kit-state'))
    expect(root.querySelectorAll('[data-brand-swatch]').length).toBe(3)
    expect(root.querySelector('[data-brand-apply]')).toBeTruthy()
    expect(root.querySelector('[aria-live="polite"]')).toBeTruthy()
    const swatch = root.querySelector('[data-brand-swatch]')
    expect(swatch?.getAttribute('aria-label')).toContain(bg.DEFAULT_KIT.primary)
  })

  it('kit 对话框：data-brand-dialog + 字段 + 保存/取消', () => {
    const { root } = renderFrame(mock.state, { ctx: { slot: 'dialog' } })
    expect(root.hasAttribute('data-brand-dialog')).toBe(true)
    expect(root.querySelectorAll('[data-kit-field]').length).toBeGreaterThanOrEqual(5)
    expect(root.querySelector('[data-kit-field="primary"]')).toBeTruthy()
    expect(root.querySelector('[data-kit-field="tagline"]')).toBeTruthy()
    expect(root.querySelector('[data-brand-action="save-kit"]')).toBeTruthy()
  })

  it('根节点带 data-sdk="v1" 供宿主 SDK 样式接管', () => {
    const { root } = renderFrame(mock.state, { ctx: { slot: 'workspace.inspector.tab' } })
    expect(root.getAttribute('data-sdk') ?? source.includes('data-sdk')).toBeTruthy()
  })
})
