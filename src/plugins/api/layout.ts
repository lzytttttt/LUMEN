/**
 * plugins/api/layout.ts —— `lumen.layout`（02 §5.2 / §6.8）。
 *
 * 只允许改 02 §6.8 的封闭维度；`apply` 写 `settings.plugins.layoutOverride`（不进 deck 历史），
 * 并把可应用的维度同步到 `uiStore`。`inspectorTab` 不得指向插件页签（`plug:*`），防止把用户锁在插件页签里。
 */
import { getRegisteredLayoutPresets } from '../contributionBus'
import { useSettingsStore, type PluginLayoutOverride } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import type { LocalizedText } from '../types'
import type { ApiCall } from './context'
import { abiError, assertRecord, assertString, registerNamespaceApi } from './gateway'
import { titlePairOf } from './util'

export const LAYOUT_LIMITS = {
  railWidth: { min: 160, max: 360 },
  panelWidth: { min: 260, max: 520 },
  dockHeight: { min: 240, max: 400 },
} as const

const INSPECTOR_TABS = ['props', 'layers', 'motion', 'notes', 'theme', 'lint'] as const
const LEFT_TABS = ['slides', 'outline'] as const
const RIGHT_MODES = ['inspector', 'composer'] as const
const DENSITIES = ['comfortable', 'compact'] as const

function clamp(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.round(Math.min(max, Math.max(min, value)))
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

/**
 * 封闭维度清洗：未知键丢弃、数值夹紧、枚举封闭、`inspectorTab` 拒绝 `plug:*`。
 * 返回 null 表示没有任何可应用维度。
 */
export function sanitizeLayoutOverride(input: unknown): PluginLayoutOverride | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const output: PluginLayoutOverride = {}
  const railWidth = clamp(record.railWidth, LAYOUT_LIMITS.railWidth.min, LAYOUT_LIMITS.railWidth.max)
  if (railWidth !== undefined) output.railWidth = railWidth
  const panelWidth = clamp(record.panelWidth, LAYOUT_LIMITS.panelWidth.min, LAYOUT_LIMITS.panelWidth.max)
  if (panelWidth !== undefined) output.panelWidth = panelWidth
  const dockHeight = clamp(record.dockHeight, LAYOUT_LIMITS.dockHeight.min, LAYOUT_LIMITS.dockHeight.max)
  if (dockHeight !== undefined) output.dockHeight = dockHeight
  if (typeof record.hideRail === 'boolean') output.hideRail = record.hideRail
  if (typeof record.hideInspector === 'boolean') output.hideInspector = record.hideInspector
  if (typeof record.showGrid === 'boolean') output.showGrid = record.showGrid
  const leftTab = pick(record.leftTab, LEFT_TABS)
  if (leftTab) output.leftTab = leftTab
  const rightMode = pick(record.rightMode, RIGHT_MODES)
  if (rightMode) output.rightMode = rightMode
  const inspectorTab = pick(record.inspectorTab, INSPECTOR_TABS)
  if (inspectorTab) output.inspectorTab = inspectorTab
  const density = pick(record.density, DENSITIES)
  if (density) output.density = density
  return Object.keys(output).length > 0 ? output : null
}

/** 应用清洗后的布局到外壳状态（`uiStore` 可直接映射的字段）。 */
export function applyLayoutOverrideToShell(override: PluginLayoutOverride): void {
  const ui = useUiStore.getState()
  if (override.railWidth !== undefined) ui.setRailWidth(override.railWidth)
  if (override.panelWidth !== undefined) ui.setPanelWidth(override.panelWidth)
  if (override.leftTab !== undefined) ui.setLeftTab(override.leftTab)
  if (override.rightMode !== undefined) ui.setRightMode(override.rightMode)
  if (override.inspectorTab !== undefined) ui.setInspectorTab(override.inspectorTab)
  if (override.showGrid !== undefined) useUiStore.setState({ showGrid: override.showGrid })
  // v0.4.0：封闭维度的 hide/dockHeight/density 由外壳（App.tsx / DockHost）消费。
  if (override.hideRail !== undefined) ui.setHideRail(override.hideRail)
  if (override.hideInspector !== undefined) ui.setHideInspector(override.hideInspector)
  if (override.dockHeight !== undefined) ui.setDockHeight(override.dockHeight)
  if (override.density !== undefined) ui.setDensity(override.density)
}

export interface LayoutPresetRuntime {
  id: string
  pluginId: string
  name: LocalizedText
  apply: PluginLayoutOverride
}

const runtimePresets = new Map<string, LayoutPresetRuntime>()

/** `apply` 查表：运行期注册 → 清单声明 → `E-ABI-02`。 */
function findPreset(presetId: string): { pluginId: string; apply: PluginLayoutOverride } | null {
  const runtime = runtimePresets.get(presetId)
  if (runtime) return { pluginId: runtime.pluginId, apply: runtime.apply }
  const declared = getRegisteredLayoutPresets().find((entry) => entry.hostId === presetId)
  if (declared) return { pluginId: declared.pluginId, apply: declared.preset.apply as PluginLayoutOverride }
  return null
}

export function handleLayout(method: string, payload: unknown, call: ApiCall): Promise<unknown> | unknown {
  switch (method) {
    case 'registerPreset': {
      const body = assertRecord(payload, 'payload')
      const id = assertString(body.id, 'id', { min: 1, max: 64 })
      if (body.remove === true) {
        const existing = runtimePresets.get(id)
        if (existing && existing.pluginId === call.frame.pluginId) runtimePresets.delete(id)
        return null
      }
      const apply = sanitizeLayoutOverride(body.apply)
      if (!apply) throw abiError('layout preset has no applicable dimension')
      const existing = runtimePresets.get(id)
      // 同一插件多帧 boot 时重复注册同 id：幂等覆盖；跨插件同 id 拒绝。
      if (existing && existing.pluginId !== call.frame.pluginId) throw abiError(`layout preset "${id}" is already registered`)
      runtimePresets.set(id, { id, pluginId: call.frame.pluginId, name: titlePairOf(body.name), apply })
      return null
    }
    case 'apply': {
      const body = assertRecord(payload, 'payload')
      const presetId = assertString(body.presetId, 'presetId', { min: 1, max: 96 })
      // 代码式插件通常用清单里的**局部 id**（如 `focus`）调用；宿主注册的 declarative 预设是
      // `${pluginId}/${id}`（02 §6.8）。先按原值查，查不到再按调用方插件的命名空间补全。
      const preset = findPreset(presetId) ?? findPreset(`${call.frame.pluginId}/${presetId}`)
      if (!preset) throw abiError(`layout preset "${presetId}" does not exist`)
      const apply = sanitizeLayoutOverride(preset.apply)
      if (!apply) throw abiError('layout preset has no applicable dimension')
      useSettingsStore.getState().patchPlugins({ layoutOverride: apply })
      applyLayoutOverrideToShell(apply)
      return null
    }
    case 'current': {
      // 契约 02 §5.3：`current(): Promise<LayoutPresetId>` —— 返回**字符串 id**（不是对象）。
      // 调用方插件看到的是自己的局部 id（`focus`），其它插件的预设保持全名。
      const override = useSettingsStore.getState().plugins.layoutOverride
      return localizePresetId(findPresetIdOf(override), call.frame.pluginId)
    }
    default:
      throw abiError(`unknown layout method "${method}"`)
  }
}

function findPresetIdOf(override: PluginLayoutOverride | null): string | null {
  if (!override) return null
  for (const preset of runtimePresets.values()) {
    if (JSON.stringify(preset.apply) === JSON.stringify(override)) return preset.id
  }
  for (const entry of getRegisteredLayoutPresets()) {
    if (JSON.stringify(entry.preset.apply) === JSON.stringify(override)) return entry.hostId
  }
  return null
}

/** 调用方插件看到的是自己的局部 id：`${pluginId}/focus` → `focus`（其它插件的保持全名）。 */
function localizePresetId(presetId: string | null, pluginId: string): string | null {
  if (!presetId) return null
  const prefix = `${pluginId}/`
  return presetId.startsWith(prefix) ? presetId.slice(prefix.length) : presetId
}

/** 「恢复默认工作台」：布局/密度回默认（键位覆盖由 registry.resetWorkbench 清）。 */
export function restoreDefaultWorkbench(): void {
  useSettingsStore.getState().patchPlugins({ layoutOverride: null })
  const ui = useUiStore.getState()
  ui.setRailWidth(216)
  ui.setPanelWidth(340)
  ui.setLeftTab('slides')
  ui.setRightMode('inspector')
  ui.setInspectorTab('props')
}

export function layoutPresetsForPlugin(pluginId: string): LayoutPresetRuntime[] {
  return [...runtimePresets.values()].filter((preset) => preset.pluginId === pluginId)
}

export function clearPluginLayout(pluginId: string): void {
  for (const [id, preset] of [...runtimePresets.entries()]) {
    if (preset.pluginId === pluginId) runtimePresets.delete(id)
  }
}

export function resetLayoutForTests(): void {
  runtimePresets.clear()
}

export function registerLayoutApi(): void {
  registerNamespaceApi('layout', {
    registerPreset: (payload, call) => handleLayout('registerPreset', payload, call),
    apply: (payload, call) => handleLayout('apply', payload, call),
    current: (payload, call) => handleLayout('current', payload, call),
  })
}
