/**
 * plugins-recipe.test.ts —— v0.4.0 契约层（U-40-231…240 的配方/设置迁移子集）。
 *
 * 依据：`plan/v0.4.0/02` §9.1（recipeIdSchema 放宽，唯一 schema 加法）、§9.2（配方缺失回落）、
 * §7.4（settings.plugins 段与默认值）、§7.1（DB v4 store 名）。
 * 目标：锁住「旧 deck 原样可读 + 插件配方命名空间可用 + 插件缺失回落 statement」三件事。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILTIN_RECIPE_IDS,
  PLUGIN_RECIPE_ID_RE,
  deckSchema,
  isBuiltinRecipeId,
  outlineSlideSchema,
  recipeIdSchema,
  slideSchema,
  type RecipeId,
} from '@/schema/deck'
import { emptyDeck } from '@/schema/factory'
import {
  RECIPES,
  buildRecipe,
  fillContent,
  installPluginRecipeResolver,
  recipeSlots,
  resolveRecipeOf,
  type Recipe,
} from '@/ai/recipes'
import { getTheme } from '@/themes'
import { DEFAULT_PLUGINS, DEFAULT_SETTINGS, settingsSnapshot, useSettingsStore } from '@/state/settingsStore'
import { loadSettings } from '@/persistence/decks'

const theme = getTheme('noir')
const content = { lang: 'zh' as const, headline: '一句话', lead: '副标题', points: ['一', '二', '三'] }

afterEach(() => {
  installPluginRecipeResolver(null)
})

describe('recipeIdSchema：内置 12 名 + 插件命名空间（02 §9.1）', () => {
  it('12 个内置配方全部通过，且类型守卫一致', () => {
    expect(BUILTIN_RECIPE_IDS).toHaveLength(12)
    for (const id of BUILTIN_RECIPE_IDS) {
      expect(recipeIdSchema.safeParse(id).success).toBe(true)
      expect(isBuiltinRecipeId(id)).toBe(true)
    }
  })

  it('插件命名空间 ns/slug 通过', () => {
    for (const id of ['chartkit/bar', 'chartkit/donut', 'a/b', 'brand-guard2/palette-check']) {
      expect(recipeIdSchema.safeParse(id).success, id).toBe(true)
      expect(isBuiltinRecipeId(id)).toBe(false)
    }
  })

  it('非命名空间/大写/三段/空段一律拒绝', () => {
    for (const id of ['', 'chartkit', 'ChartKit/bar', 'chartkit/Bar', 'chartkit/bar/baz', 'chartkit/', '/bar', 'chart kit/bar', 'a//b', '1ns/x']) {
      expect(recipeIdSchema.safeParse(id).success, id).toBe(false)
    }
  })

  it('总长超过 80 拒绝（两段各 41 字符）', () => {
    const tooLong = `${'a'.repeat(41)}/${'b'.repeat(41)}`
    expect(tooLong.length).toBeGreaterThan(80)
    expect(recipeIdSchema.safeParse(tooLong).success).toBe(false)
    expect(PLUGIN_RECIPE_ID_RE.test('chartkit/bar')).toBe(true)
  })
})

describe('deck/outline 共用同一 schema：插件配方可落库（02 §9.1 口径补充）', () => {
  it('slide.recipe 接受插件命名空间', () => {
    const slide = slideSchema.parse({ id: 's1', recipe: 'chartkit/bar', blocks: [] })
    expect(slide.recipe).toBe('chartkit/bar')
  })

  it('outline.slides[i].recipe 接受插件命名空间', () => {
    const outlineSlide = outlineSlideSchema.parse({ recipe: 'chartkit/bar', headline: '数据一页' })
    expect(outlineSlide.recipe).toBe('chartkit/bar')
  })

  it('deckSchema 往返：插件配方不丢失，旧 deck 仍原样可读', () => {
    const deck = emptyDeck('契约')
    deck.slides[0].recipe = 'chartkit/bar' as RecipeId
    deck.slides.push({ ...deck.slides[0], id: 'legacy', recipe: 'timeline' })
    const parsed = deckSchema.parse(JSON.parse(JSON.stringify(deck)))
    expect(parsed.slides[0].recipe).toBe('chartkit/bar')
    expect(parsed.slides[1].recipe).toBe('timeline')
  })
})

describe('配方回落链（02 §9.2）：插件 → 内置 → statement', () => {
  it('undefined / 未知插件配方都回落 statement', () => {
    expect(resolveRecipeOf(undefined).id).toBe('statement')
    expect(resolveRecipeOf('chartkit/bar').id).toBe('statement')
    expect(resolveRecipeOf('no-such-plugin/x').id).toBe('statement')
  })

  it('内置配方直接命中', () => {
    for (const id of BUILTIN_RECIPE_IDS) {
      expect(resolveRecipeOf(id).id).toBe(id)
    }
  })

  it('注册解析器后插件配方命中，反注册后回落 statement', () => {
    const pluginRecipe: Recipe = {
      id: 'chartkit/bar',
      slots: [{ key: 'headline', required: true }],
      build: (c, t) => RECIPES.statement.build(c, t).slice(0, 1),
    }
    installPluginRecipeResolver((id) => (id === 'chartkit/bar' ? pluginRecipe : undefined))
    expect(resolveRecipeOf('chartkit/bar')).toBe(pluginRecipe)
    expect(recipeSlots('chartkit/bar')).toEqual([{ key: 'headline', required: true }])
    const blocks = buildRecipe('chartkit/bar', content, theme)
    expect(blocks).toHaveLength(1)

    installPluginRecipeResolver(null)
    expect(resolveRecipeOf('chartkit/bar').id).toBe('statement')
    expect(recipeSlots('chartkit/bar').length).toBeGreaterThan(0)
  })

  it('fillContent 对插件配方不抛错（用 statement 兜底文案）', () => {
    const filled = fillContent('chartkit/bar' as RecipeId, { lang: 'zh', headline: '  ' })
    expect(filled.headline.trim().length).toBeGreaterThan(0)
  })

  it('buildRecipe 对任意配方都不抛错且返回块', () => {
    for (const id of BUILTIN_RECIPE_IDS) {
      expect(buildRecipe(id, content, theme).length).toBeGreaterThan(0)
    }
  })
})

describe('settings.plugins 段与旧设置迁移（02 §7.4）', () => {
  it('DEFAULT_SETTINGS 含完整 plugins 段与 creator 默认值', () => {
    expect(DEFAULT_SETTINGS.plugins).toEqual(DEFAULT_PLUGINS)
    expect(DEFAULT_SETTINGS.plugins.creator).toEqual({
      readDeck: false,
      lastDraftId: null,
      exportFormat: 'lumenplug',
      panelWidth: 420,
    })
    expect(DEFAULT_SETTINGS.plugins.auditLimit).toBe(200)
  })

  it('hydrate 旧快照（无 plugins）补默认值；部分 plugins 保留已知键', () => {
    useSettingsStore.getState().hydrate({ lang: 'en', onboarded: true } as never)
    let state = useSettingsStore.getState()
    expect(state.lang).toBe('en')
    expect(state.plugins).toEqual(DEFAULT_PLUGINS)

    useSettingsStore.getState().hydrate({ plugins: { safeMode: true, enabled: { 'com.a.b': true } } } as never)
    state = useSettingsStore.getState()
    expect(state.plugins.safeMode).toBe(true)
    expect(state.plugins.enabled).toEqual({ 'com.a.b': true })
    expect(state.plugins.creator.panelWidth).toBe(420)
    expect(state.plugins.layoutOverride).toBeNull()
  })

  it('settingsSnapshot 携带 plugins 段（自动落库）', () => {
    useSettingsStore.getState().hydrate(null)
    useSettingsStore.getState().patchPlugins({ auditLimit: 120 })
    const snapshot = settingsSnapshot(useSettingsStore.getState())
    expect(snapshot.plugins.auditLimit).toBe(120)
    expect(snapshot.plugins.creator.panelWidth).toBe(420)
  })

  it('loadSettings 在无存量时返回含 plugins 的默认快照（旧设置 → 0.4.0）', async () => {
    const snapshot = await loadSettings()
    expect(snapshot.plugins).toBeDefined()
    expect(snapshot.plugins.safeMode).toBe(false)
    expect(snapshot.plugins.creator.exportFormat).toBe('lumenplug')
  })
})
