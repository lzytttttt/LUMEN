/**
 * plugins/contributionBus.ts —— 11 类声明式贡献的注册 / 反注册 / 冲突检测（02 §6.1）。
 *
 * 原子性：`registerContributions` 先做全量命名空间/冲突校验，全部通过才一次性提交；
 * 任一冲突 → `E-MAN-09` 抛错且**不留半注册态**（02 §6.1 末段）。
 * 冲突检测只做宿主能判的部分；素材与内置库的 id 冲突由调用方传入 `builtinLibraryIds`。
 */
import { PluginError } from './errors'
import { CONTRIBUTION_LIMITS, SLOT_KINDS, type Capability, type PluginManifest } from './types'
import type {
  DeclarativeCommand,
  ExportHookDeclaration,
  KeymapBinding,
  LayoutPresetContribution,
  LintRuleDeclaration,
  LocalePackContribution,
  PluginSlotItem,
  RecipeDeclaration,
  RegisteredLibraryItem,
  RegisteredTheme,
  SettingsPageContribution,
  SlotContribution,
  ThemeContribution,
} from './types'
import { BUILTIN_THEME_IDS, isValidKeymapCombo, SLUG_PATTERN } from './manifest'

/* ------------------------------ 内置命名空间（02 §2.6） ------------------------------ */

/** 6 套内置主题 id（02 §2.6）。 */
export const BUILTIN_THEME_NAMESPACE: readonly string[] = BUILTIN_THEME_IDS

/** 内置布局预设 id（02 §6.8；0.4.0 暂无内置预设，保留占位）。 */
export const BUILTIN_LAYOUT_IDS: readonly string[] = []

/** `buildCommands` 的内置命令 id（02 §2.6，29 条；由 shell-ui 命令表对齐）。 */
export const BUILTIN_COMMAND_IDS: readonly string[] = [
  'deck.new',
  'deck.open',
  'deck.save',
  'deck.export',
  'deck.import',
  'deck.settings',
  'deck.theme',
  'deck.play',
  'deck.present',
  'deck.preview',
  'edit.undo',
  'edit.redo',
  'edit.duplicate',
  'edit.delete',
  'edit.copy',
  'edit.cut',
  'edit.paste',
  'edit.selectAll',
  'slide.add',
  'slide.delete',
  'slide.duplicate',
  'slide.moveUp',
  'slide.moveDown',
  'view.inspector',
  'view.notes',
  'view.lint',
  'view.composer',
  'view.play',
  'view.gotoSlide',
]

/** 插件命令最终 id 前缀（02 §2.6）。 */
export function pluginCommandId(pluginId: string, commandId: string): string {
  return `plugin.${pluginId}.${commandId}`
}

/** 主题 / 布局 / 素材 / lint / slot 的最终 id。 */
export function namespacedId(pluginId: string, localId: string): string {
  return `${pluginId}/${localId}`
}

export function slotHostId(pluginId: string, contributionId: string): string {
  return `${pluginId}:${contributionId}`
}

export function lintRuleCode(pluginId: string, ruleId: string): string {
  return `${pluginId}/${ruleId}`
}

/* ------------------------------ 注册表结构 ------------------------------ */

export interface ContributionOwner {
  pluginId: string
  pluginVersion: string
  manifest: PluginManifest
  trust: 'builtin' | 'local' | 'draft'
  capabilities: readonly Capability[]
}

interface Registered<T> {
  owner: ContributionOwner
  value: T
}

export interface ContributionSnapshot {
  themes: RegisteredTheme[]
  library: RegisteredLibraryItem[]
  settings: Array<{ pluginId: string; page: SettingsPageContribution }>
  commands: Array<{ pluginId: string; command: DeclarativeCommand; hostId: string }>
  keymap: Array<{ pluginId: string; binding: KeymapBinding; hostCommandId: string }>
  layoutPresets: Array<{ pluginId: string; preset: LayoutPresetContribution; hostId: string }>
  slots: PluginSlotItem[]
  lintRules: Array<{ pluginId: string; declaration: LintRuleDeclaration; code: string }>
  recipes: Array<{ pluginId: string; declaration: RecipeDeclaration; recipeId: string }>
  exportHooks: Array<{ pluginId: string; declaration: ExportHookDeclaration; hookId: string }>
  i18n: Array<{ pluginId: string; pack: LocalePackContribution }>
}

export interface RegisterOptions {
  /** 内置素材库 id 集合（与 `src/studio/library` 对齐；由 samples/svg3d-studio 提供）。 */
  builtinLibraryIds?: ReadonlySet<string>
  /** 内置配方命名空间/名字（12 个内置配方名）。 */
  builtinRecipeIds?: ReadonlySet<string>
  /** 内置 lint code（11 个，`LINT_CODES`）。 */
  builtinLintCodes?: ReadonlySet<string>
}

/* ------------------------------ 状态 ------------------------------ */

const themes = new Map<string, Registered<ThemeContribution>>()
const library = new Map<string, Registered<LibrarySpec>>()
const settings = new Map<string, ContributionOwner & { page: SettingsPageContribution }>()
const commands = new Map<string, Registered<DeclarativeCommand>>()
const keymap = new Map<string, Registered<KeymapBinding>>()
const layoutPresets = new Map<string, Registered<LayoutPresetContribution>>()
const slots = new Map<string, Registered<SlotContribution>>()
const lintRules = new Map<string, Registered<LintRuleDeclaration>>()
const recipes = new Map<string, Registered<RecipeDeclaration>>()
const exportHooks = new Map<string, Registered<ExportHookDeclaration>>()
const localePacks = new Map<string, Registered<LocalePackContribution>>()

interface LibrarySpec {
  item: RegisteredLibraryItem
}

let revision = 0
const listeners = new Set<() => void>()

function emit(): void {
  revision += 1
  for (const listener of listeners) listener()
}

export function subscribeContributions(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function contributionRevision(): number {
  return revision
}

/* ------------------------------ 注册 / 反注册 ------------------------------ */

/**
 * 注册一个插件清单里的全部声明式贡献（install/enable 时机，02 §6.1）。
 * 冲突 → `E-MAN-09`，且不留下任何部分注册。
 */
export function registerContributions(
  owner: ContributionOwner,
  manifest: PluginManifest,
  opts: RegisterOptions = {},
): void {
  const contributes = manifest.contributes
  const pluginId = owner.pluginId
  const builtinLibraryIds = opts.builtinLibraryIds ?? new Set<string>()
  const builtinRecipeIds = opts.builtinRecipeIds ?? new Set<string>()
  const builtinLintCodes = opts.builtinLintCodes ?? new Set<string>()

  const nextThemes = new Map(themes)
  const nextLibrary = new Map(library)
  const nextSettings = new Map(settings)
  const nextCommands = new Map(commands)
  const nextKeymap = new Map(keymap)
  const nextLayouts = new Map(layoutPresets)
  const nextSlots = new Map(slots)
  const nextLintRules = new Map(lintRules)
  const nextRecipes = new Map(recipes)
  const nextExportHooks = new Map(exportHooks)
  const nextLocalePacks = new Map(localePacks)

  // 1) 主题
  for (const theme of contributes.themes ?? []) {
    const finalId = namespacedId(pluginId, theme.id)
    if (!SLUG_PATTERN.test(theme.id)) throw new PluginError('E-MAN-09', `invalid theme id "${theme.id}"`)
    if (BUILTIN_THEME_NAMESPACE.includes(theme.id) || BUILTIN_THEME_NAMESPACE.includes(finalId)) {
      throw new PluginError('E-MAN-09', `theme "${theme.id}" collides with a built-in theme`)
    }
    ensureFree(nextThemes, finalId, pluginId, 'theme')
    nextThemes.set(finalId, { owner, value: theme })
  }

  // 2) 素材
  for (const item of contributes.library ?? []) {
    const finalId = namespacedId(pluginId, item.id)
    if (!SLUG_PATTERN.test(item.id)) throw new PluginError('E-MAN-09', `invalid library id "${item.id}"`)
    if (builtinLibraryIds.has(finalId) || builtinLibraryIds.has(item.id)) {
      throw new PluginError('E-MAN-09', `library "${item.id}" collides with a built-in item`)
    }
    ensureFree(nextLibrary, finalId, pluginId, 'library')
    nextLibrary.set(finalId, {
      owner,
      value: {
        item: {
          id: finalId,
          name: item.name,
          category: item.category,
          viewBox: item.viewBox,
          source: item.source,
          pluginId,
        },
      },
    })
  }

  // 3) 设置页（单对象）
  if (contributes.settings) {
    if (nextSettings.has(pluginId)) throw new PluginError('E-MAN-09', 'duplicate settings page')
    nextSettings.set(pluginId, { ...owner, page: contributes.settings })
  }

  // 4) 声明式命令（只服务 kind:'declarative'，02 §6.6）
  if (contributes.commands && manifest.kind !== 'declarative') {
    throw new PluginError('E-MAN-09', 'contributes.commands is only allowed for declarative plugins')
  }
  for (const command of contributes.commands ?? []) {
    const hostId = pluginCommandId(pluginId, command.id)
    if (BUILTIN_COMMAND_IDS.includes(hostId)) {
      throw new PluginError('E-MAN-09', `command "${command.id}" collides with a built-in command`)
    }
    ensureFree(nextCommands, hostId, pluginId, 'command')
    nextCommands.set(hostId, { owner, value: command })
  }

  // 5) 键位
  for (const binding of contributes.keymap ?? []) {
    if (!isValidKeymapCombo(binding.combo)) {
      throw new PluginError('E-MAN-09', `invalid key combo "${binding.combo}"`)
    }
    const key = binding.combo.trim().toLowerCase()
    const ownerOfCombo = nextKeymap.get(key)
    if (ownerOfCombo && ownerOfCombo.owner.pluginId !== pluginId) {
      throw new PluginError('E-MAN-09', `key combo "${binding.combo}" is already used by ${ownerOfCombo.owner.pluginId}`)
    }
    nextKeymap.set(key, { owner, value: binding })
  }

  // 6) 布局预设
  for (const preset of contributes.layoutPresets ?? []) {
    const finalId = namespacedId(pluginId, preset.id)
    if (BUILTIN_LAYOUT_IDS.includes(finalId)) {
      throw new PluginError('E-MAN-09', `layout preset "${preset.id}" collides with a built-in preset`)
    }
    ensureFree(nextLayouts, finalId, pluginId, 'layout preset')
    nextLayouts.set(finalId, { owner, value: preset })
  }

  // 7) 插槽
  let framed = 0
  for (const slot of contributes.slots ?? []) {
    const hostId = slotHostId(pluginId, slot.id)
    if (!SLOT_KINDS[slot.slot].includes(slot.kind)) {
      throw new PluginError('E-MAN-09', `slot "${slot.id}" kind "${slot.kind}" mismatches ${slot.slot}`)
    }
    if (slot.kind !== 'inline') framed += 1
    if (framed > CONTRIBUTION_LIMITS.slotFrames) {
      throw new PluginError('E-MAN-09', `too many framed slots (limit ${CONTRIBUTION_LIMITS.slotFrames})`)
    }
    ensureFree(nextSlots, hostId, pluginId, 'slot')
    nextSlots.set(hostId, { owner, value: slot })
  }

  // 8) lint 规则声明（代码式）
  for (const rule of contributes.lintRules ?? []) {
    const code = lintRuleCode(pluginId, rule.id)
    if (builtinLintCodes.has(code) || builtinLintCodes.has(rule.id)) {
      throw new PluginError('E-MAN-09', `lint rule "${rule.id}" collides with a built-in rule`)
    }
    ensureFree(nextLintRules, code, pluginId, 'lint rule')
    nextLintRules.set(code, { owner, value: rule })
  }

  // 9) 配方声明（代码式）
  //    注意：`namespace` 是**插件级短命名空间**，同一插件可声明多条配方共享它（02 §2.6/§6.9，
  //    例：ChartKit 的 chartkit/bar、chartkit/donut…），冲突只发生在「跨插件」。
  const namespaceOwners = new Map<string, string>()
  for (const recipe of contributes.recipes ?? []) {
    const recipeId = `${recipe.namespace}/${recipe.id}`
    if (builtinRecipeIds.has(recipeId) || builtinRecipeIds.has(recipe.id)) {
      throw new PluginError('E-MAN-09', `recipe "${recipeId}" collides with a built-in recipe`)
    }
    const ownerPlugin = namespaceOwners.get(recipe.namespace)
    if (ownerPlugin && ownerPlugin !== pluginId) {
      throw new PluginError('E-MAN-09', `recipe namespace "${recipe.namespace}" is taken by ${ownerPlugin}`)
    }
    for (const [existingId, existing] of nextRecipes) {
      if (existingId.split('/')[0] === recipe.namespace && existing.owner.pluginId !== pluginId) {
        throw new PluginError(
          'E-MAN-09',
          `recipe namespace "${recipe.namespace}" is taken by ${existing.owner.pluginId}`,
        )
      }
    }
    namespaceOwners.set(recipe.namespace, pluginId)
    ensureFree(nextRecipes, recipeId, pluginId, 'recipe')
    nextRecipes.set(recipeId, { owner, value: recipe })
  }

  // 10) 导出钩子声明
  for (const hook of contributes.exportHooks ?? []) {
    ensureFree(nextExportHooks, hook.id, pluginId, 'export hook')
    nextExportHooks.set(hook.id, { owner, value: hook })
  }

  // 11) 语言包
  for (const pack of contributes.i18n ?? []) {
    const existing = nextLocalePacks.get(pluginId)
    if (existing) throw new PluginError('E-MAN-09', 'only one locale pack is allowed')
    nextLocalePacks.set(pluginId, { owner, value: pack })
  }

  // 全部校验通过 → 原子提交
  themes.clear()
  for (const [key, value] of nextThemes) themes.set(key, value)
  library.clear()
  for (const [key, value] of nextLibrary) library.set(key, value)
  settings.clear()
  for (const [key, value] of nextSettings) settings.set(key, value)
  commands.clear()
  for (const [key, value] of nextCommands) commands.set(key, value)
  keymap.clear()
  for (const [key, value] of nextKeymap) keymap.set(key, value)
  layoutPresets.clear()
  for (const [key, value] of nextLayouts) layoutPresets.set(key, value)
  slots.clear()
  for (const [key, value] of nextSlots) slots.set(key, value)
  lintRules.clear()
  for (const [key, value] of nextLintRules) lintRules.set(key, value)
  recipes.clear()
  for (const [key, value] of nextRecipes) recipes.set(key, value)
  exportHooks.clear()
  for (const [key, value] of nextExportHooks) exportHooks.set(key, value)
  localePacks.clear()
  for (const [key, value] of nextLocalePacks) localePacks.set(key, value)
  emit()
}

function ensureFree<T>(map: Map<string, Registered<T>>, id: string, pluginId: string, kind: string): void {
  const existing = map.get(id)
  if (existing && existing.owner.pluginId !== pluginId) {
    throw new PluginError('E-MAN-09', `${kind} "${id}" is already registered by ${existing.owner.pluginId}`)
  }
}

/** 反注册一个插件的全部贡献（disable/uninstall，02 §3.4）。 */
export function unregisterContributions(pluginId: string): void {
  const removeOwned = <T>(map: Map<string, Registered<T>>) => {
    for (const [key, value] of [...map.entries()]) {
      if (value.owner.pluginId === pluginId) map.delete(key)
    }
  }
  removeOwned(themes)
  removeOwned(library)
  removeOwned(commands)
  removeOwned(keymap)
  removeOwned(layoutPresets)
  removeOwned(slots)
  removeOwned(lintRules)
  removeOwned(recipes)
  removeOwned(exportHooks)
  settings.delete(pluginId)
  localePacks.delete(pluginId)
  emit()
}

/** 反注册单个贡献（插件页单独撤销某项时用，02 §3.4）。 */
export function unregisterContribution(pluginId: string, mapName: keyof ContributionSnapshot, hostId: string): void {
  switch (mapName) {
    case 'themes':
      themes.delete(hostId)
      break
    case 'library':
      library.delete(hostId)
      break
    case 'commands':
      commands.delete(hostId)
      break
    case 'keymap':
      keymap.delete(hostId.trim().toLowerCase())
      break
    case 'layoutPresets':
      layoutPresets.delete(hostId)
      break
    case 'slots':
      slots.delete(hostId)
      break
    case 'lintRules':
      lintRules.delete(hostId)
      break
    case 'recipes':
      recipes.delete(hostId)
      break
    case 'exportHooks':
      exportHooks.delete(hostId)
      break
    case 'settings':
      settings.delete(pluginId)
      break
    case 'i18n':
      localePacks.delete(pluginId)
      break
    default:
      break
  }
  emit()
}

/* ------------------------------ 读取（只读快照） ------------------------------ */

export function getRegisteredThemes(): RegisteredTheme[] {
  return [...themes.values()].map((entry) => ({ pluginId: entry.owner.pluginId, theme: toTheme(entry.owner.pluginId, entry.value) }))
}

function toTheme(pluginId: string, contribution: ThemeContribution): RegisteredTheme['theme'] {
  // 实际映射（字体兜底 / 对比度修正）在 declarative/theme.ts 完成；这里返回结构稳定的最小形态。
  return {
    id: namespacedId(pluginId, contribution.id),
    name: contribution.name,
    vibe: contribution.vibe,
    colors: contribution.colors,
    font: {
      body: contribution.font?.body ?? '',
      display: contribution.font?.display ?? '',
      mono: contribution.font?.mono ?? '',
    },
    typeScale: contribution.typeScale ?? 1,
    radius: contribution.radius ?? 8,
    motion: contribution.motion ?? { ease: 'cubic-bezier(.32,.72,0,1)', ms: 420 },
    texture: contribution.texture,
    glow: contribution.glow,
    elevation: contribution.elevation,
  } as RegisteredTheme['theme']
}

export function getRegisteredLibrary(): RegisteredLibraryItem[] {
  return [...library.values()].map((entry) => entry.value.item)
}

export function getRegisteredSettings(): Array<{ pluginId: string; page: SettingsPageContribution }> {
  return [...settings.values()].map((entry) => ({ pluginId: entry.pluginId, page: entry.page }))
}

export function getRegisteredCommands(): Array<{ pluginId: string; command: DeclarativeCommand; hostId: string }> {
  return [...commands.entries()].map(([hostId, entry]) => ({
    pluginId: entry.owner.pluginId,
    command: entry.value,
    hostId,
  }))
}

export function getRegisteredKeymap(): Array<{ pluginId: string; pluginName: string; binding: KeymapBinding; hostCommandId: string }> {
  return [...keymap.entries()].map(([combo, entry]) => ({
    pluginId: entry.owner.pluginId,
    pluginName: entry.owner.manifest.name.zh,
    binding: { ...entry.value, combo },
    hostCommandId: pluginCommandId(entry.owner.pluginId, entry.value.commandId),
  }))
}

export function getRegisteredLayoutPresets(): Array<{ pluginId: string; preset: LayoutPresetContribution; hostId: string }> {
  return [...layoutPresets.entries()].map(([hostId, entry]) => ({
    pluginId: entry.owner.pluginId,
    preset: entry.value,
    hostId,
  }))
}

export function getRegisteredSlots(slot?: PluginSlotItem['slot']): PluginSlotItem[] {
  const items: PluginSlotItem[] = []
  for (const [hostId, entry] of slots.entries()) {
    const contribution = entry.value
    if (slot && contribution.slot !== slot) continue
    items.push({
      id: hostId,
      pluginId: entry.owner.pluginId,
      pluginName: entry.owner.manifest.name.zh,
      slot: contribution.slot,
      kind: contribution.kind,
      title: contribution.title,
      icon: contribution.icon,
      order: contribution.order ?? 50,
      open: contribution.open,
      size: contribution.size,
    })
  }
  items.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  return items
}

export function getRegisteredLintRules(): Array<{ pluginId: string; declaration: LintRuleDeclaration; code: string }> {
  return [...lintRules.entries()].map(([code, entry]) => ({
    pluginId: entry.owner.pluginId,
    declaration: entry.value,
    code,
  }))
}

export function getRegisteredRecipes(): Array<{ pluginId: string; declaration: RecipeDeclaration; recipeId: string }> {
  return [...recipes.entries()].map(([recipeId, entry]) => ({
    pluginId: entry.owner.pluginId,
    declaration: entry.value,
    recipeId,
  }))
}

export function getRegisteredExportHooks(): Array<{ pluginId: string; declaration: ExportHookDeclaration; hookId: string }> {
  return [...exportHooks.entries()].map(([hookId, entry]) => ({
    pluginId: entry.owner.pluginId,
    declaration: entry.value,
    hookId,
  }))
}

export function getRegisteredLocalePacks(): Array<{ pluginId: string; pack: LocalePackContribution }> {
  return [...localePacks.values()].map((entry) => ({ pluginId: entry.owner.pluginId, pack: entry.value }))
}

/** 贡献总数（诊断/插件页摘要用）。 */
export function contributionCounts(pluginId: string): Record<string, number> {
  const count = <T>(map: Map<string, Registered<T>>) =>
    [...map.values()].filter((entry) => entry.owner.pluginId === pluginId).length
  return {
    themes: count(themes),
    library: count(library),
    commands: count(commands),
    keymap: count(keymap),
    layoutPresets: count(layoutPresets),
    slots: count(slots),
    lintRules: count(lintRules),
    recipes: count(recipes),
    exportHooks: count(exportHooks),
    settings: settings.has(pluginId) ? 1 : 0,
    i18n: localePacks.has(pluginId) ? 1 : 0,
  }
}

/** 仅测试用：清空全部贡献。 */
export function resetContributionsForTests(): void {
  themes.clear()
  library.clear()
  settings.clear()
  commands.clear()
  keymap.clear()
  layoutPresets.clear()
  slots.clear()
  lintRules.clear()
  recipes.clear()
  exportHooks.clear()
  localePacks.clear()
  revision = 0
}
