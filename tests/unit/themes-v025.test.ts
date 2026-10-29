/**
 * tests/unit/themes-v025.test.ts —— v0.2.5「设计预设」打磨的回归闸门。
 *
 * 四件事必须钉死：
 * 1) 六套预设的对比度实测（正文 ≥7、muted ≥4.5、accent/accent2 on bg ≥3，
 *    外加"二级表面"上的 muted ≥4.5、accent ≥3 —— 卡片里也会落字）；
 * 2) themeCssVars 的变量完整性（v0.2.5 八件套 + 内部纹理瓦片 + 7 变体 × 4）；
 * 3) 派生色是纯函数（hex→rgba / mix / darken / surface-2 / 阴影档位 / 纹理瓦片）；
 * 4) 旧主题对象（没有 texture/glow/elevation）照旧可用，且导出内联同一条路。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Theme } from '@/schema/deck'
import { BASE_TYPE, deckSchema, themeSchema, textureSchema } from '@/schema/deck'
import { contrastRatio } from '@/lint/color'
import {
  THEMES,
  THEME_IDS,
  accentSoftOf,
  darkenColor,
  getTheme,
  isDarkColor,
  lightenColor,
  mixColor,
  parseThemeColor,
  shadowsOf,
  surface2Of,
  textureOpacityOf,
  textureTileOf,
  themeCssVars,
  themeInlineStyle,
  themeVarsCss,
  toHexColor,
  typeStyleOf,
  withAlpha,
} from '@/themes'
import { composeStandaloneHtml } from '@/export/standalone'
import { PRINT_CSS } from '@/export/printRoute'
import { createSampleDeck } from '@/sample/sample-deck'

const THEME_LIST = THEME_IDS.map((id) => THEMES[id])

/** 老的 7 色令牌顺序（导入/导出/面板都按这个顺序读）。 */
const COLOR_KEYS = ['bg', 'fg', 'muted', 'surface', 'line', 'accent', 'accent2'] as const

/** v0.2.5 契约要求 themeCssVars 追加的 8 个变量。 */
const V025_KEYS = [
  '--d-texture',
  '--d-texture-op',
  '--d-glow',
  '--d-elevation',
  '--d-surface-2',
  '--d-shadow-1',
  '--d-shadow-2',
  '--d-accent-soft',
] as const

/** 契约之外的内部派生：kind → 纹理瓦片（CSS 没法用关键字选图案）。 */
const TEXTURE_IMAGE_KEY = '--d-texture-image'

/** 读源码：CSS 侧到底有没有消费新变量（导出走同一份 slide.css）。 */
function readSource(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8')
}

function ratio(a: string, b: string): number {
  const value = contrastRatio(a, b)
  expect(value).not.toBeNull()
  return value as number
}

/* ------------------------------- 1. 对比度 ------------------------------- */

describe('v0.2.5 主题对比度（WCAG，实测值进 plan/04 表）', () => {
  it('六套预设：正文 ≥7、muted ≥4.5、accent/accent2 on bg ≥3', () => {
    for (const theme of THEME_LIST) {
      const c = theme.colors
      expect(ratio(c.fg, c.bg), `${theme.id} fg/bg`).toBeGreaterThanOrEqual(7)
      expect(ratio(c.muted, c.bg), `${theme.id} muted/bg`).toBeGreaterThanOrEqual(4.5)
      expect(ratio(c.accent, c.bg), `${theme.id} accent/bg`).toBeGreaterThanOrEqual(3)
      expect(ratio(c.accent2, c.bg), `${theme.id} accent2/bg`).toBeGreaterThanOrEqual(3)
    }
  })

  it('二级表面（surface-2）上落字也达标：muted ≥4.5、fg ≥7、accent ≥3', () => {
    for (const theme of THEME_LIST) {
      const c = theme.colors
      const surface2 = themeCssVars(theme)['--d-surface-2']
      expect(ratio(c.muted, surface2), `${theme.id} muted/surface-2`).toBeGreaterThanOrEqual(4.5)
      expect(ratio(c.fg, surface2), `${theme.id} fg/surface-2`).toBeGreaterThanOrEqual(7)
      expect(ratio(c.accent, surface2), `${theme.id} accent/surface-2`).toBeGreaterThanOrEqual(3)
    }
  })

  it('对比度随覆盖色重算：override 后的 accent 与 accent-soft 同源', () => {
    const themed = themeCssVars(getTheme('noir'), { accent: '#7a5cff' })
    expect(themed['--d-accent']).toBe('#7a5cff')
    expect(themed['--d-accent-soft']).toBe(withAlpha('#7a5cff', 0.12))
  })
})

/* --------------------------- 2. 变量表完整性 --------------------------- */

describe('themeCssVars 变量完整性', () => {
  it('7 色 + 8 个 v0.2.5 变量 + 字体/圆角/动效 + 7 变体 × 4', () => {
    for (const theme of THEME_LIST) {
      const vars = themeCssVars(theme)
      for (const key of COLOR_KEYS) expect(vars[`--d-${key}`], `${theme.id} ${key}`).toBe(theme.colors[key])
      for (const key of V025_KEYS) expect(vars[key], `${theme.id} ${key}`).toBeTruthy()
      expect(vars[TEXTURE_IMAGE_KEY], `${theme.id} 纹理瓦片`).toBeTruthy()

      for (const key of ['--d-font-body', '--d-font-display', '--d-font-mono', '--d-radius', '--d-ease', '--d-motion-ms']) {
        expect(vars[key], `${theme.id} ${key}`).toBeTruthy()
      }
      for (const variant of Object.keys(BASE_TYPE)) {
        for (const prefix of ['--d-fs-', '--d-lh-', '--d-fw-', '--d-tk-']) {
          expect(vars[`${prefix}${variant}`], `${theme.id} ${prefix}${variant}`).toBeTruthy()
        }
      }
      // 13 基础 + 8 v0.2.5 + 1 瓦片 + 28 字阶 = 50
      expect(Object.keys(vars), `${theme.id} 变量数`).toHaveLength(50)
      for (const [key, value] of Object.entries(vars)) {
        expect(typeof value, `${theme.id} ${key} 类型`).toBe('string')
        expect(value.length, `${theme.id} ${key} 空值`).toBeGreaterThan(0)
      }
    }
  })

  it('纹理 / 光晕 / 层次写进变量，且 kind=none 时强度归零', () => {
    for (const theme of THEME_LIST) {
      const vars = themeCssVars(theme)
      expect(vars['--d-texture']).toBe(theme.texture?.kind ?? 'none')
      expect(Number(vars['--d-texture-op'])).toBeCloseTo(textureOpacityOf(theme), 5)
      expect(Number(vars['--d-glow'])).toBeCloseTo(theme.glow ?? 0, 5)
      expect(vars['--d-elevation']).toBe(theme.elevation ?? 'flat')
      if (vars['--d-texture'] === 'none') expect(vars['--d-texture-op']).toBe('0')
      if (vars['--d-elevation'] === 'flat') {
        expect(vars['--d-shadow-1']).toBe('none')
        expect(vars['--d-shadow-2']).toBe('none')
      } else {
        expect(vars['--d-shadow-1']).toContain('rgba(')
        expect(vars['--d-shadow-2']).toContain('rgba(')
      }
    }
  })

  it('--d-surface-2 与 --d-accent-soft 是派生色，不是写死的色值表', () => {
    for (const theme of THEME_LIST) {
      const vars = themeCssVars(theme)
      expect(vars['--d-surface-2']).toBe(surface2Of(theme.colors.bg, theme.colors.surface))
      expect(vars['--d-accent-soft']).toBe(accentSoftOf(theme.colors.accent))
      // 覆盖 surface 也要跟着走
      const overridden = themeCssVars(theme, { surface: '#123456' })
      expect(overridden['--d-surface-2']).toBe(surface2Of(theme.colors.bg, '#123456'))
    }
  })
})

/* ----------------------------- 3. 派生纯函数 ----------------------------- */

describe('派生色纯函数', () => {
  it('parseThemeColor / toHexColor 往返', () => {
    expect(parseThemeColor('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseThemeColor('rgb(200, 161, 90)')).toEqual({ r: 200, g: 161, b: 90 })
    expect(parseThemeColor('var(--d-accent)')).toBeNull()
    expect(toHexColor({ r: 200, g: 161, b: 90 })).toBe('#c8a15a')
    expect(toHexColor({ r: -10, g: 300, b: 12.6 })).toBe('#00ff0d')
  })

  it('mix / darken / lighten 是线性的', () => {
    expect(mixColor('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixColor('#c8a15a', '#ffffff', 0)).toBe('#c8a15a')
    expect(mixColor('#c8a15a', '#ffffff', 1)).toBe('#ffffff')
    expect(darkenColor('#ffffff', 0.5)).toBe('#808080')
    expect(lightenColor('#000000', 0.5)).toBe('#808080')
    // 解析不了的颜色退回 color-mix()，导出样式永远合法
    expect(mixColor('var(--x)', '#000000', 0.5)).toContain('color-mix(')
  })

  it('withAlpha 出 rgba，解析失败退回 color-mix', () => {
    expect(withAlpha('#c8a15a', 0.12)).toBe('rgba(200, 161, 90, 0.12)')
    expect(withAlpha('var(--d-accent)', 0.12)).toBe('color-mix(in srgb, var(--d-accent) 12%, transparent)')
  })

  it('二级表面跟着底色明暗走：深色提亮、浅色压暗', () => {
    expect(isDarkColor('#0c0c0f')).toBe(true)
    expect(isDarkColor('#f7f3ea')).toBe(false)
    expect(surface2Of('#0c0c0f', '#17171c')).toBe(lightenColor('#17171c', 0.07))
    expect(surface2Of('#f7f3ea', '#efe8db')).toBe(darkenColor('#efe8db', 0.05))
  })

  it('阴影档位：flat 无、raised 一层、layered 两段', () => {
    expect(shadowsOf('flat', '#0c0c0f')).toEqual({ one: 'none', two: 'none' })
    const raised = shadowsOf('raised', '#0c0c0f')
    expect(raised.one.startsWith('0 6px 18px rgba(')).toBe(true)
    expect(raised.two.startsWith('0 20px 52px rgba(')).toBe(true)
    const layered = shadowsOf('layered', '#f7f3ea')
    expect(layered.one.split('rgba(').length - 1).toBe(2)
    expect(layered.two.split('rgba(').length - 1).toBe(2)
  })

  it('纹理瓦片：none 是 none，四种图案都是 data URI 且带固有尺寸', () => {
    expect(textureTileOf('none')).toBe('none')
    for (const kind of ['grain', 'grid', 'scan', 'dots'] as const) {
      const tile = textureTileOf(kind)
      expect(tile.startsWith('url("data:image/svg+xml,')).toBe(true)
      expect(tile).toContain('width=')
      expect(tile).toContain('height=')
      // 不能出现裸 `<`（内联到 <style> 里会提前闭合标签）
      expect(tile).not.toContain('<')
    }
  })

  it('纹理强度归一：缺字段 / kind=none / 越界都收敛到合法值', () => {
    expect(textureOpacityOf({ ...getTheme('noir') })).toBeCloseTo(0.07, 5)
    expect(textureOpacityOf({ ...getTheme('noir'), texture: { kind: 'none', opacity: 0.5 } })).toBe(0)
    expect(textureOpacityOf({ ...getTheme('noir'), texture: { kind: 'grid', opacity: 4 } })).toBe(1)
  })
})

/* --------------------------- 4. schema 与旧数据 --------------------------- */

describe('themeSchema：新字段可选，旧对象/旧 Deck 不受影响', () => {
  const legacy: Theme = {
    id: 'legacy',
    name: { zh: '旧主题', en: 'Legacy' },
    colors: {
      bg: '#101014',
      fg: '#f5f5f5',
      muted: '#9a9a9a',
      surface: '#1a1a20',
      line: '#2a2a32',
      accent: '#c8a15a',
      accent2: '#7ea0b8',
    },
    font: { body: 'system-ui', display: 'system-ui', mono: 'ui-monospace' },
    typeScale: 1,
    radius: 8,
    motion: { ease: 'ease', ms: 420 },
  }

  it('旧主题对象（无 texture/glow/elevation）照旧解析', () => {
    const parsed = themeSchema.parse(legacy)
    expect(parsed.texture).toBeUndefined()
    expect(parsed.glow).toBeUndefined()
    expect(parsed.elevation).toBeUndefined()
  })

  it('旧主题变量 = 无纹理 / 无光晕 / 平层（与 v0.2.0 观感一致）', () => {
    const vars = themeCssVars(legacy)
    expect(vars['--d-texture']).toBe('none')
    expect(vars['--d-texture-op']).toBe('0')
    expect(vars['--d-glow']).toBe('0')
    expect(vars['--d-elevation']).toBe('flat')
    expect(vars['--d-shadow-1']).toBe('none')
    expect(vars['--d-shadow-2']).toBe('none')
    expect(vars[TEXTURE_IMAGE_KEY]).toBe('none')
    // 派生色仍然有值（旧主题立刻获得二级表面能力）
    expect(vars['--d-surface-2']).toBeTruthy()
    expect(vars['--d-accent-soft']).toBeTruthy()
  })

  it('新字段合法值可解析，越界/未知值被拒', () => {
    const withNew = themeSchema.parse({
      ...legacy,
      texture: { kind: 'scan', opacity: 0.09 },
      glow: 0.5,
      elevation: 'layered',
    })
    expect(withNew.texture).toEqual({ kind: 'scan', opacity: 0.09 })
    expect(withNew.glow).toBe(0.5)
    expect(withNew.elevation).toBe('layered')

    expect(textureSchema.parse({}).kind).toBe('none')
    expect(themeSchema.safeParse({ ...legacy, glow: 1.2 }).success).toBe(false)
    expect(themeSchema.safeParse({ ...legacy, elevation: 'high' }).success).toBe(false)
    expect(themeSchema.safeParse({ ...legacy, texture: { kind: 'grain', opacity: 2 } }).success).toBe(false)
  })

  it('旧 Deck（只有 themeId，没有主题对象）反序列化照旧', () => {
    const deck = deckSchema.parse({
      id: 'legacy_deck',
      title: '旧工程',
      slides: [{ id: 's1', blocks: [] }],
    })
    expect(deck.themeId).toBe('noir')
    expect(themeCssVars(getTheme(deck.themeId))['--d-texture']).toBe('grain')
  })

  it('示例 deck 的主题也能拿到 v0.2.5 变量', () => {
    const deck = createSampleDeck('zh')
    const vars = themeCssVars(getTheme(deck.themeId), deck.themeOverrides)
    for (const key of V025_KEYS) expect(vars[key], `sample ${key}`).toBeTruthy()
  })
})

/* ---------------------------- 5. 导出一致性 ---------------------------- */

describe('导出内联：themeCssVars → themeVarsCss → 独立 HTML', () => {
  const deck = createSampleDeck('zh')

  it('themeInlineStyle 与 buildStandaloneHtml 用的是同一条变量表', () => {
    for (const theme of THEME_LIST) {
      const inline = themeInlineStyle(theme)
      expect(inline.startsWith('{')).toBe(false)
      for (const key of [...V025_KEYS, TEXTURE_IMAGE_KEY]) {
        expect(inline, `${theme.id} inline ${key}`).toContain(`${key}:`)
      }
      // 独立 HTML 的 <style id="lumen-theme"> 就是 themeVarsCss(themeCssVars(...))
      const themeCss = themeVarsCss(themeCssVars(theme, deck.themeOverrides))
      const html = composeStandaloneHtml({
        title: 'v0.2.5',
        deck,
        assets: {},
        playerJs: 'window.LumenPlayer={mount:function(){}};',
        playerCss: '.lumen-slide{}',
        themeCss,
      })
      const inlineBlock = html.split('id="lumen-theme">')[1].split('</style>')[0]
      for (const key of [...V025_KEYS, TEXTURE_IMAGE_KEY]) {
        expect(inlineBlock, `${theme.id} export ${key}`).toContain(`${key}:`)
      }
      expect(inlineBlock).toContain('--d-accent-soft:')
    }
  })

  it('打印样式仍然强制出底色（纹理/阴影才会被打印出来）', () => {
    expect(PRINT_CSS).toContain('print-color-adjust: exact')
    expect(PRINT_CSS).toContain('.lumen-print__page')
    expect(PRINT_CSS).toContain('@page')
  })
})

/* ------------------------- 6. CSS 侧的消费点 ------------------------- */

describe('slide.css 消费新变量（导出复用同一份 CSS）', () => {
  const css = readSource('src/render/slide.css')

  it('纹理层 / 光晕 / 层次都有落点', () => {
    expect(css).toContain('.lumen-slide::before')
    expect(css).toContain('mask-image: var(--d-texture-image')
    expect(css).toContain('opacity: var(--d-texture-op')
    expect(css).toContain('.lumen-slide::after')
    expect(css).toContain('var(--d-glow')
    expect(css).toContain('var(--d-accent-soft')
    expect(css).toContain('var(--d-surface-2')
    expect(css).toContain('var(--d-shadow-1')
    expect(css).toContain('var(--d-shadow-2')
    expect(css).toContain('@keyframes lumen-glow-breathe')
  })

  it('光晕在静止态静态化，纹理不受影响', () => {
    expect(css).toContain('[data-forge-still=\'1\'] .lumen-slide::after')
    expect(css).toContain('[data-reduced-motion=\'true\'] .lumen-slide::after')
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('.lumen-slide::after')
    expect(reduced).not.toContain('--d-texture')
  })

  it('构建产物（若已生成）与源码同源', () => {
    const built = resolve(process.cwd(), 'public/player/lumen-player.css')
    if (!existsSync(built)) return
    const playerCss = readFileSync(built, 'utf8')
    expect(playerCss).toContain('--d-texture-image')
    expect(playerCss).toContain('lumen-glow-breathe')
  })
})

/* ---------------------------- 7. 六套打磨口径 ---------------------------- */

describe('六套预设的打磨口径', () => {
  it('display/h1/h2/lead 四档都有明确取向（字重、字距、行高至少一项）', () => {
    for (const theme of THEME_LIST) {
      for (const variant of ['display', 'h1', 'h2', 'lead'] as const) {
        const override = theme.typeOverrides?.[variant]
        expect(override, `${theme.id} ${variant} 覆盖`).toBeTruthy()
        const keys = Object.keys(override ?? {})
        expect(keys.length, `${theme.id} ${variant} 取向`).toBeGreaterThan(0)
      }
    }
  })

  it('四档覆盖不动字号：字号仍由 typeScale 决定（配方版式不受影响）', () => {
    for (const theme of THEME_LIST) {
      for (const variant of Object.keys(BASE_TYPE) as (keyof typeof BASE_TYPE)[]) {
        const expected = Math.round(BASE_TYPE[variant].size * theme.typeScale * 10) / 10
        expect(typeStyleOf(theme, variant).size, `${theme.id} ${variant}`).toBe(expected)
      }
    }
  })

  it('纹理 / 光晕 / 层次是"每套都要有立场"的显式字段', () => {
    for (const theme of THEME_LIST) {
      expect(theme.texture, `${theme.id} texture`).toBeTruthy()
      expect(theme.glow, `${theme.id} glow`).toBeTypeOf('number')
      expect(theme.elevation, `${theme.id} elevation`).toBeTruthy()
    }
    // flat 主题不给阴影，layered 主题一定给两档
    expect(themeCssVars(getTheme('signal'))['--d-elevation']).toBe('flat')
    expect(themeCssVars(getTheme('noir'))['--d-elevation']).toBe('layered')
    expect(themeCssVars(getTheme('terminal'))['--d-elevation']).toBe('flat')
  })
})
