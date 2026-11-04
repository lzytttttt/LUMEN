/**
 * plugins/declarative/index.ts —— 声明式贡献的统一装配与反装配（02 §6.1 / §3.4）。
 *
 * 11 类贡献的生命周期：
 * - 主题/素材/语言包/设置页/命令/键位/布局预设 → `registerContributions()` 进 ContributionBus；
 * - 主题另存插件主题副本（`declarative/theme.ts`）；语言包另进 overlay（`plugins/i18n.ts`）；
 * - 代码式清单声明（lintRules/recipes/exportHooks）只进 bus 作为「唯一真相」，运行期由 api 层注册同 id 并做双向校验。
 */
import { BUILTIN_RECIPE_IDS } from '@/schema/deck'
import { LINT_CODES } from '@/lint/deckLint'
import { useSettingsStore } from '@/state/settingsStore'
import {
  CONTRIBUTION_LIMITS,
  type InstalledPluginRecord,
  type PluginManifest,
  type PluginSettingsEntry,
} from '../types'
import {
  contributionCounts,
  getRegisteredLayoutPresets,
  getRegisteredSettings,
  getRegisteredThemes,
  registerContributions,
  resetContributionsForTests as resetBusForTests,
  unregisterContributions,
} from '../contributionBus'
import { registerManifestLocalePack, resetLocaleOverlaysForTests as resetLocaleForTests, unregisterLocalePack } from '../i18n'
import { registerPluginThemes, resetPluginThemesForTests as resetThemesForTests, unregisterPluginThemes } from './theme'
import { installThemeResolverBridge, resetThemeResolverBridgeForTests, uninstallThemeResolverBridge } from './themeBridge'
import { applyLayoutPreset, isLayoutFromPresets, restoreDefaultLayout } from './layout'

export { themeContributionToTheme, registerPluginThemes, getPluginThemes, resolvePluginTheme, getMergedThemes } from './theme'
export { applyLayoutPreset, restoreDefaultLayout, DEFAULT_LAYOUT, layoutDefaults } from './layout'
export { getRegisteredLayoutPresets, getRegisteredSettings, getRegisteredThemes } from '../contributionBus'
export {
  HOST_OCCUPIED_COMBOS,
  getActiveBindings,
  getKeymapConflicts,
  getPluginKeymapBindings,
  installPluginKeymapListener,
  matchesCombo,
  normalizeCombo,
  parseCombo,
  resolveKeymapConflict,
  setPluginCommandRunner,
  uninstallPluginKeymapListener,
} from './keymap'
export { executeDeclarativeCommand, parsePluginCommandHostId, PLUGIN_COMMAND_LABEL_PREFIX } from './commands'

/** 仅测试用：清空贡献总线 / 插件主题 / 语言包 overlay / 主题 seam。 */
export function resetContributionStateForTests(): void {
  resetBusForTests()
  resetThemesForTests()
  resetLocaleForTests()
  resetThemeResolverBridgeForTests()
}

export interface ApplyContributionsResult {
  warnings: string[]
  /** 11 类贡献的注册计数（插件页摘要用）。 */
  counts: Record<string, number>
}

/** 内置命名空间（与内置模块同步；冲突检测用）。 */
const BUILTIN_LINT_CODES = new Set<string>(LINT_CODES as readonly string[])
const BUILTIN_RECIPES = new Set<string>(BUILTIN_RECIPE_IDS as readonly string[])

/**
 * enable / 启动恢复：把清单里的全部声明式贡献原子注册（冲突 → E-MAN-09，不留半注册态）。
 */
export function applyDeclarativeContributions(record: InstalledPluginRecord): ApplyContributionsResult {
  const manifest = record.manifest
  const owner = {
    pluginId: record.manifest.id,
    pluginVersion: record.manifest.version,
    manifest,
    trust: record.trust,
    capabilities: record.grants,
  }
  registerContributions(owner, manifest, {
    builtinLintCodes: BUILTIN_LINT_CODES,
    builtinRecipeIds: BUILTIN_RECIPES,
  })
  const warnings: string[] = []
  if (manifest.contributes.themes && manifest.contributes.themes.length > 0) {
    warnings.push(...registerPluginThemes(record.manifest.id, manifest.contributes.themes))
    // 渲染/lint/导出走 getTheme()：把插件主题解析器接到 themes 的 seam（Lead 未落地时静默跳过）。
    installThemeResolverBridge()
  }
  const localePack = manifest.contributes.i18n?.[0]
  if (localePack) registerManifestLocalePack(record.manifest.id, localePack)
  return { warnings, counts: contributionCounts(record.manifest.id) }
}

/**
 * disable / uninstall：反注册该插件的一切声明式贡献（§3.4 的 3/4/5/6/7/8 项）。
 * 布局预设被移除且当前布局来自它 → 先还原默认工作台布局。
 */
export function removeDeclarativeContributions(pluginId: string, manifest?: PluginManifest): void {
  const presets = manifest?.contributes.layoutPresets
  if (presets && presets.length > 0 && isLayoutFromPresets(presets)) restoreDefaultLayout()
  unregisterPluginThemes(pluginId)
  unregisterLocalePack(pluginId)
  unregisterContributions(pluginId)
  // 没有插件主题了 → 让 getTheme 回到纯内置。
  if (getRegisteredThemes().length === 0) uninstallThemeResolverBridge()
}

/* ------------------------------ 代码式清单声明 ↔ 运行期双注册（02 §6.9） ------------------------------ */

export interface RuntimeRegistrations {
  lintRules?: string[]
  recipes?: string[]
  exportHooks?: string[]
}

export interface DeclarationCheck {
  ok: boolean
  /** 清单声明了但运行期没注册（→ E-MAN-13）。 */
  missing: string[]
  /** 运行期注册了但清单没声明（→ E-CAP-01 拒绝该次注册）。 */
  extra: string[]
}

/** ready 之后的一致性校验：清单是唯一真相（缺失 → E-MAN-13）。 */
export function verifyCodeRegistrations(manifest: PluginManifest, registered: RuntimeRegistrations): DeclarationCheck {
  const declaredLint = (manifest.contributes.lintRules ?? []).map((rule) => rule.id)
  // 配方在清单里拆成 namespace + id；运行期 `lumen.ai.registerRecipe` 注册的是局部 id。
  // 两者比较统一到局部 id（namespace 由宿主拼成 `${namespace}/${id}` 落注册表，02 §6.9）。
  const declaredRecipes = (manifest.contributes.recipes ?? []).map((recipe) => recipe.id)
  const declaredHooks = (manifest.contributes.exportHooks ?? []).map((hook) => hook.id)
  const actualLint = registered.lintRules ?? []
  const actualRecipes = (registered.recipes ?? []).map((recipeId) => recipeId.split('/').pop() ?? recipeId)
  const actualHooks = registered.exportHooks ?? []
  const missing = [
    ...declaredLint.filter((id) => !actualLint.includes(id)),
    ...declaredRecipes.filter((id) => !actualRecipes.includes(id)),
    ...declaredHooks.filter((id) => !actualHooks.includes(id)),
  ]
  const extra = [
    ...actualLint.filter((id) => !declaredLint.includes(id)),
    ...actualRecipes.filter((id) => !declaredRecipes.includes(id)),
    ...actualHooks.filter((id) => !declaredHooks.includes(id)),
  ]
  return { ok: missing.length === 0 && extra.length === 0, missing, extra }
}

/* ------------------------------ 声明式设置页（02 §6.5） ------------------------------ */

/** 设置弹窗「插件」分组里的声明式页（宿主原生渲染，不占 slot）。 */
export function getDeclarativeSettingsEntries(): PluginSettingsEntry[] {
  return getRegisteredSettings().map((entry) => ({
    pluginId: entry.pluginId,
    pageId: entry.page.id,
    title: entry.page.title,
    form: 'declarative',
    fields: entry.page.fields,
  }))
}

/** 清单默认值（fields[].default；无默认值的类型给空串/false/0）。 */
export function getDefaultSettingsValues(manifest: PluginManifest): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of manifest.contributes.settings?.fields ?? []) {
    switch (field.type) {
      case 'switch':
        values[field.key] = field.default ?? false
        break
      case 'number':
        values[field.key] = field.default ?? field.min ?? 0
        break
      case 'slider':
        values[field.key] = field.default ?? field.min ?? 0
        break
      case 'select':
        values[field.key] = field.options[0]?.value ?? ''
        break
      case 'text':
      case 'textarea':
        values[field.key] = ''
        break
      default:
        break
    }
  }
  return values
}

export function getPluginSettingValues(pluginId: string): Record<string, unknown> {
  return { ...(useSettingsStore.getState().plugins.values[pluginId] ?? {}) }
}

export function patchPluginSettingValue(pluginId: string, key: string, value: unknown): void {
  const settings = useSettingsStore.getState()
  const current = settings.plugins.values[pluginId] ?? {}
  settings.patchPlugins({ values: { ...settings.plugins.values, [pluginId]: { ...current, [key]: value } } })
}

export function resetPluginSettingValues(pluginId: string): void {
  const settings = useSettingsStore.getState()
  const values = { ...settings.plugins.values }
  delete values[pluginId]
  settings.patchPlugins({ values })
}

/* ------------------------------ 布局预设 / 主题便利入口 ------------------------------ */

/** 按宿主 id（`${pluginId}/${presetId}`）应用布局预设；找不到返回 false。 */
export function applyLayoutPresetById(hostId: string): boolean {
  const preset = getRegisteredLayoutPresets().find((entry) => entry.hostId === hostId)
  if (!preset) return false
  applyLayoutPreset(preset.preset.apply)
  return true
}

/** 已注册主题的插件 id 列表（诊断/权限回收判断用）。 */
export function themeOwnerIds(): string[] {
  return [...new Set(getRegisteredThemes().map((entry) => entry.pluginId))]
}

/** 声明式贡献上限表（插件页/诊断引用；来自 02 §2.3）。 */
export const DECLARATIVE_LIMITS = CONTRIBUTION_LIMITS
