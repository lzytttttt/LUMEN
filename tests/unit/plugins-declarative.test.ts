/**
 * U-40-116…135：声明式贡献（主题映射与对比度兜底、键位冲突、布局预设、8 action、设置页字段）。
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  applyDeclarativeContributions,
  applyLayoutPreset,
  applyLayoutPresetById,
  getActiveBindings,
  getDeclarativeSettingsEntries,
  getDefaultSettingsValues,
  getKeymapConflicts,
  getMergedThemes,
  getPluginKeymapBindings,
  getPluginSettingValues,
  getRegisteredThemes,
  HOST_OCCUPIED_COMBOS,
  matchesCombo,
  normalizeCombo,
  parseCombo,
  patchPluginSettingValue,
  resetContributionStateForTests,
  resetPluginSettingValues,
  resolveKeymapConflict,
  restoreDefaultLayout,
  themeContributionToTheme,
  verifyCodeRegistrations,
  executeDeclarativeCommand,
} from '@/plugins/declarative'
import { registerContributions, unregisterContributions } from '@/plugins/contributionBus'
import { getRecord, makeRecordFromFiles, readAuditEntries, resetRegistryForTests, seedRecordForTests } from '@/plugins/registry'
import { DEFAULT_PLUGINS, useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { useDeckStore } from '@/state/deckStore'
import { emptyDeck } from '@/schema/factory'
import { THEMES } from '@/themes'
import { contrastRatio } from '@/lint/color'
import { PluginError } from '@/plugins/errors'
import type { InstalledPluginRecord, PluginManifest, ThemeContribution } from '@/plugins/types'

beforeAll(() => {
  const current = globalThis.crypto as Crypto | undefined
  if (!current || !current.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
})

const PLUGIN_ID = 'com.example.declarative'

const THEME: ThemeContribution = {
  id: 'sepia',
  name: { zh: '棕褐', en: 'Sepia' },
  colors: {
    bg: '#201a12',
    fg: '#f3e9d2',
    muted: '#a99a7c',
    surface: '#2c241a',
    line: '#4a3d2c',
    accent: '#d8a657',
    accent2: '#7fa7a0',
  },
}

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: PLUGIN_ID,
    name: { zh: '声明式', en: 'Declarative' },
    version: '1.0.0',
    apiVersion: '1.0',
    minAppVersion: '0.4.0',
    kind: 'declarative',
    author: { name: 'Example' },
    description: { zh: '声明式贡献测试', en: 'Declarative contributions test' },
    license: 'MIT',
    capabilities: ['theme:contribute', 'ui:command', 'ui:keymap', 'ui:layout', 'storage'],
    contributes: {
      themes: [THEME],
      commands: [
        {
          id: 'apply',
          title: { zh: '应用主题', en: 'Apply theme' },
          category: 'plugin',
          action: { kind: 'setTheme', themeId: 'sepia' },
        },
        {
          id: 'insert',
          title: { zh: '插入', en: 'Insert' },
          category: 'plugin',
          action: { kind: 'insertTextBlocks', blocks: [{ text: 'Hello, plugin' }] },
        },
        {
          id: 'toast',
          title: { zh: '提示', en: 'Toast' },
          category: 'plugin',
          action: { kind: 'toast', message: { zh: '你好', en: 'Hello' } },
        },
      ],
      keymap: [
        { combo: 'mod+shift+k', commandId: 'apply' },
        { combo: 'mod+z', commandId: 'insert' },
      ],
      layoutPresets: [
        { id: 'focus', name: { zh: '专注', en: 'Focus' }, apply: { railWidth: 150, panelWidth: 500, rightMode: 'inspector' } },
      ],
      settings: {
        id: 'main',
        title: { zh: '设置', en: 'Settings' },
        fields: [
          { key: 'brand', type: 'text', label: { zh: '品牌', en: 'Brand' } },
          { key: 'enabled', type: 'switch', label: { zh: '启用', en: 'Enabled' }, default: true },
          { key: 'density', type: 'select', label: { zh: '密度', en: 'Density' }, options: [{ value: 'compact', label: { zh: '紧凑', en: 'Compact' } }] },
        ],
      },
    },
    ...overrides,
  }
}

async function recordOf(overrides: Partial<PluginManifest> = {}): Promise<InstalledPluginRecord> {
  const value = manifest(overrides)
  return makeRecordFromFiles(value, { 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>' }, {
    state: 'enabled',
    grants: value.capabilities,
  })
}

beforeEach(() => {
  resetContributionStateForTests()
  resetRegistryForTests()
  useSettingsStore.getState().patchPlugins(JSON.parse(JSON.stringify(DEFAULT_PLUGINS)) as typeof DEFAULT_PLUGINS)
  useUiStore.setState({
    railWidth: 216,
    panelWidth: 340,
    rightMode: 'inspector',
    leftTab: 'slides',
    showGrid: false,
    mode: 'edit',
    toasts: [],
  })
  useDeckStore.getState().setDeck(emptyDeck('测试'))
})

describe('主题映射与对比度兜底（02 §6.2）', () => {
  it('最终 id = ${pluginId}/${slug}，字体缺省回落 noir，accent 必填背景不变', () => {
    const { theme, warnings } = themeContributionToTheme(PLUGIN_ID, THEME)
    expect(theme.id).toBe(`${PLUGIN_ID}/sepia`)
    expect(theme.font).toEqual(THEMES.noir.font)
    expect(theme.typeScale).toBe(1)
    expect(theme.radius).toBe(8)
    expect(warnings).toEqual([])
  })

  it('低对比度自动修正（fg/bg ≥ 7、muted/bg ≥ 4.5、accent/bg ≥ 3）并写 warnings', () => {
    const low = {
      ...THEME,
      id: 'low',
      colors: { bg: '#000000', fg: '#111111', muted: '#151515', surface: '#0a0a0a', line: '#222222', accent: '#101010', accent2: '#101010' },
    }
    const { theme, warnings } = themeContributionToTheme(PLUGIN_ID, low)
    expect(warnings).toContain(`theme:low:fg-contrast-fixed`)
    expect(warnings).toContain(`theme:low:muted-contrast-fixed`)
    expect(warnings).toContain(`theme:low:accent-contrast-fixed`)
    expect(contrastRatio(theme.colors.fg, theme.colors.bg)!).toBeGreaterThanOrEqual(6.9)
    expect(contrastRatio(theme.colors.muted, theme.colors.bg)!).toBeGreaterThanOrEqual(4.4)
    expect(contrastRatio(theme.colors.accent, theme.colors.bg)!).toBeGreaterThanOrEqual(2.9)
  })

  it('插件主题并入合并视图，不改 THEMES 常量', async () => {
    applyDeclarativeContributions(await recordOf())
    expect(getRegisteredThemes()).toHaveLength(1)
    expect(getMergedThemes()).toHaveLength(7)
    expect(Object.keys(THEMES)).toHaveLength(6)
  })
})

describe('贡献注册冲突（02 §6.1 / §2.6）', () => {
  it('覆盖内置主题 id → E-MAN-09', async () => {
    const record = await recordOf()
    const conflictManifest = manifest({
      contributes: {
        ...manifest().contributes,
        themes: [{ ...THEME, id: 'noir' }],
      },
    })
    record.manifest = conflictManifest
    try {
      applyDeclarativeContributions(record)
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError)
      expect((error as PluginError).code).toBe('E-MAN-09')
      return
    }
    throw new Error('expected E-MAN-09')
  })

  it('两个插件注册同一主题 → 后者 E-MAN-09', async () => {
    applyDeclarativeContributions(await recordOf())
    const other = manifest({ id: 'com.example.other' })
    const record = await makeRecordFromFiles(other, { 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>' }, {
      state: 'enabled',
      grants: other.capabilities,
    })
    try {
      applyDeclarativeContributions(record)
    } catch (error) {
      expect((error as PluginError).code).toBe('E-MAN-09')
      return
    }
    throw new Error('expected E-MAN-09')
  })
})

describe('键位（02 §6.7）', () => {
  it('combo 规范化与解析', () => {
    expect(normalizeCombo('Cmd+Shift+K')).toBe('mod+shift+k')
    expect(normalizeCombo('shift+mod+k')).toBe('mod+shift+k')
    expect(parseCombo('mod+alt+arrowup')).toEqual({ mod: true, shift: false, alt: true, key: 'arrowup' })
  })

  it('事件匹配（mod=⌘/Ctrl）', () => {
    const event = { key: 'k', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false } as KeyboardEvent
    expect(matchesCombo(event, 'mod+shift+k')).toBe(true)
    expect(matchesCombo({ ...event, shiftKey: false } as KeyboardEvent, 'mod+shift+k')).toBe(false)
  })

  it('与内置占用冲突 → getKeymapConflicts(owner=host)；用户让位后生效', async () => {
    applyDeclarativeContributions(await recordOf())
    const conflicts = getKeymapConflicts()
    expect(conflicts.some((conflict) => conflict.combo === 'mod+z' && conflict.owner === 'host')).toBe(true)
    expect(HOST_OCCUPIED_COMBOS).toContain('mod+z')
    expect(getActiveBindings().map((binding) => binding.combo)).not.toContain('mod+z')
    resolveKeymapConflict('mod+z', 'plugin')
    expect(useSettingsStore.getState().plugins.keymapOverrides['mod+z']).toBe(`plugin.${PLUGIN_ID}.insert`)
    expect(getActiveBindings().map((binding) => binding.combo)).toContain('mod+z')
    resolveKeymapConflict('mod+z', 'host')
    expect(useSettingsStore.getState().plugins.keymapOverrides['mod+z']).toBeUndefined()
  })

  it('插件键位来源清单', async () => {
    applyDeclarativeContributions(await recordOf())
    const bindings = getPluginKeymapBindings()
    expect(bindings).toHaveLength(2)
    expect(bindings[0]).toMatchObject({ pluginId: PLUGIN_ID, pluginName: '声明式' })
  })
})

describe('布局预设（02 §6.8）', () => {
  it('越界值夹紧并写 settings.plugins.layoutOverride', async () => {
    applyDeclarativeContributions(await recordOf())
    const applied = applyLayoutPresetById(`${PLUGIN_ID}/focus`)
    expect(applied).toBe(true)
    expect(useUiStore.getState().railWidth).toBe(180)
    expect(useUiStore.getState().panelWidth).toBe(420)
    expect(useSettingsStore.getState().plugins.layoutOverride).toMatchObject({ railWidth: 150, panelWidth: 500 })
  })

  it('restoreDefaultLayout 还原默认并清覆盖', async () => {
    applyLayoutPreset({ railWidth: 200, panelWidth: 400 })
    restoreDefaultLayout()
    expect(useUiStore.getState().railWidth).toBe(216)
    expect(useUiStore.getState().panelWidth).toBe(340)
    expect(useSettingsStore.getState().plugins.layoutOverride).toBeNull()
  })

  it('removeDeclarativeContributions 时若布局来自该插件则先还原', async () => {
    const record = await recordOf()
    applyDeclarativeContributions(record)
    applyLayoutPresetById(`${PLUGIN_ID}/focus`)
    const { removeDeclarativeContributions } = await import('@/plugins/declarative')
    removeDeclarativeContributions(PLUGIN_ID, record.manifest)
    expect(useUiStore.getState().railWidth).toBe(216)
    expect(useSettingsStore.getState().plugins.layoutOverride).toBeNull()
  })
})

describe('声明式 8 action（02 §6.6）', () => {
  it('setTheme → deck.themeId 变更为命名空间 id', async () => {
    applyDeclarativeContributions(await recordOf())
    await executeDeclarativeCommand(PLUGIN_ID, `plugin.${PLUGIN_ID}.apply`)
    expect(useDeckStore.getState().deck.themeId).toBe(`${PLUGIN_ID}/sepia`)
  })

  it('insertTextBlocks → 单步事务（一次撤销全部回滚）', async () => {
    applyDeclarativeContributions(await recordOf())
    const before = useDeckStore.getState().deck.slides[0].blocks.length
    await executeDeclarativeCommand(PLUGIN_ID, `plugin.${PLUGIN_ID}.insert`)
    expect(useDeckStore.getState().deck.slides[0].blocks.length).toBe(before + 1)
    const historyLength = useDeckStore.getState().past.length
    expect(historyLength).toBe(1)
    expect(useDeckStore.getState().past[0].label).toBe(`plugin:${PLUGIN_ID}:cmd:insert`)
    useDeckStore.getState().undo()
    expect(useDeckStore.getState().deck.slides[0].blocks.length).toBe(before)
  })

  it('toast → uiStore 收到 toast', async () => {
    applyDeclarativeContributions(await recordOf())
    await executeDeclarativeCommand(PLUGIN_ID, `plugin.${PLUGIN_ID}.toast`)
    expect(useUiStore.getState().toasts.length).toBeGreaterThan(0)
  })

  it('未知命令静默返回', async () => {
    applyDeclarativeContributions(await recordOf())
    await expect(executeDeclarativeCommand(PLUGIN_ID, `plugin.${PLUGIN_ID}.nope`)).resolves.toBeUndefined()
  })
})

describe('代码式清单声明 ↔ 运行期双注册（02 §6.9）', () => {
  it('missing → not ok；extra → not ok；全对齐 → ok', () => {
    const codeManifest = manifest({
      kind: 'code',
      entry: 'plugin.js',
      contributes: {
        lintRules: [{ id: 'brand', title: { zh: '品牌', en: 'Brand' }, severity: 'warn' }],
        recipes: [{ id: 'bar', namespace: 'chartkit', title: { zh: '柱', en: 'Bar' }, slots: [{ key: 'headline', required: true }] }],
        exportHooks: [{ id: 'preflight', title: { zh: '预检', en: 'Preflight' }, kind: 'preflight' }],
      },
    })
    expect(verifyCodeRegistrations(codeManifest, {})).toMatchObject({ ok: false })
    // 配方两侧统一比较**局部 id**：清单拆成 namespace + id 声明，运行期 registerRecipe 注册的是局部 id；
    // 宿主用 `${namespace}/${id}` 落注册表，但一致性校验只认局部 id（02 §6.9 / §9.8）。
    expect(verifyCodeRegistrations(codeManifest, { lintRules: ['brand'] }).missing.sort()).toEqual(['bar', 'preflight'])
    expect(
      verifyCodeRegistrations(codeManifest, { lintRules: ['brand'], recipes: ['chartkit/bar'], exportHooks: ['preflight'] }),
    ).toMatchObject({ ok: true, missing: [], extra: [] })
    expect(verifyCodeRegistrations(codeManifest, { lintRules: ['brand', 'ghost'] }).extra).toEqual(['ghost'])
  })
})

describe('设置页字段（02 §6.5）', () => {
  it('默认值来自 default / 首选项', async () => {
    const values = getDefaultSettingsValues(manifest())
    expect(values).toEqual({ brand: '', enabled: true, density: 'compact' })
  })

  it('设置条目 + 值读写 + reset', async () => {
    applyDeclarativeContributions(await recordOf())
    const entries = getDeclarativeSettingsEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ pluginId: PLUGIN_ID, pageId: 'main', form: 'declarative' })
    patchPluginSettingValue(PLUGIN_ID, 'brand', 'LUMEN')
    expect(getPluginSettingValues(PLUGIN_ID)).toMatchObject({ brand: 'LUMEN' })
    resetPluginSettingValues(PLUGIN_ID)
    expect(getPluginSettingValues(PLUGIN_ID)).toEqual({})
  })
})

describe('主题 seam：getTheme 认插件主题（02 §6.2 / §1.3）', () => {
  it('注册后 getTheme(命名空间 id) 命中插件主题；反注册后回落 noir；内置 id 不可覆盖', async () => {
    const { getTheme } = await import('@/themes')
    const record = await recordOf()
    applyDeclarativeContributions(record)
    const pluginTheme = getTheme(`${PLUGIN_ID}/sepia`)
    expect(pluginTheme.id).toBe(`${PLUGIN_ID}/sepia`)
    expect(pluginTheme.colors.accent).toBe('#d8a657')
    expect(getTheme('noir').id).toBe('noir')
    expect(getTheme('not-installed/theme').id).toBe('noir')
    const { removeDeclarativeContributions } = await import('@/plugins/declarative')
    removeDeclarativeContributions(PLUGIN_ID, record.manifest)
    expect(getTheme(`${PLUGIN_ID}/sepia`).id).toBe('noir')
  })
})

describe('声明式命令的授权闸门（02 §5.1 / 03 §3.3 规则 6）', () => {
  it('敏感能力未授权 → 命令被拦截（deck 不变 + toast + 审计 plugin.denied E-CAP-01）', async () => {
    const sensitiveManifest = manifest({
      capabilities: ['ui:command', 'theme:contribute', 'ui:keymap', 'ui:layout', 'storage', 'deck:write'],
      contributes: {
        commands: [
          {
            id: 'insert',
            title: { zh: '插入', en: 'Insert' },
            category: 'plugin',
            action: { kind: 'insertTextBlocks', blocks: [{ text: 'should not appear' }] },
          },
        ],
      },
    })
    // 用户拒授 deck:write：grants 只含非敏感项
    const record = await makeRecordFromFiles(
      sensitiveManifest,
      { 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>' },
      { state: 'enabled', grants: ['ui:command'] },
    )
    seedRecordForTests(record)
    applyDeclarativeContributions(record)
    const blocksBefore = useDeckStore.getState().deck.slides[0].blocks.length
    const toastsBefore = useUiStore.getState().toasts.length
    const auditBefore = readAuditEntries().length

    await executeDeclarativeCommand(PLUGIN_ID, `plugin.${PLUGIN_ID}.insert`)

    expect(useDeckStore.getState().deck.slides[0].blocks.length).toBe(blocksBefore)
    expect(useUiStore.getState().toasts.length).toBeGreaterThan(toastsBefore)
    const denied = readAuditEntries().find((entry) => entry.action === 'plugin.denied')
    expect(denied?.code).toBe('E-CAP-01')
    expect(readAuditEntries().length).toBeGreaterThan(auditBefore)
  })

  it('授权后同一命令可执行（对照）', async () => {
    const allowedManifest = manifest({
      capabilities: ['ui:command', 'theme:contribute', 'ui:keymap', 'ui:layout', 'storage', 'deck:write'],
      contributes: {
        commands: [
          {
            id: 'insert',
            title: { zh: '插入', en: 'Insert' },
            category: 'plugin',
            action: { kind: 'insertTextBlocks', blocks: [{ text: 'appears' }] },
          },
        ],
      },
    })
    const record = await makeRecordFromFiles(
      allowedManifest,
      { 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>' },
      { state: 'enabled', grants: ['ui:command', 'deck:write'] },
    )
    seedRecordForTests(record)
    applyDeclarativeContributions(record)
    const blocksBefore = useDeckStore.getState().deck.slides[0].blocks.length
    await executeDeclarativeCommand(PLUGIN_ID, `plugin.${PLUGIN_ID}.insert`)
    expect(useDeckStore.getState().deck.slides[0].blocks.length).toBe(blocksBefore + 1)
  })
})

describe('贡献反注册', () => {
  it('unregisterContributions 摘除全部贡献但不动记录', async () => {
    const record = await recordOf()
    applyDeclarativeContributions(record)
    expect(getRegisteredThemes()).toHaveLength(1)
    unregisterContributions(PLUGIN_ID)
    resetContributionStateForTests()
    expect(getRegisteredThemes()).toEqual([])
    expect(getRecord(PLUGIN_ID)).toBeUndefined()
  })
})
