/**
 * plugins/declarative/layout.ts —— 布局预设贡献（02 §6.8）。
 *
 * 只允许改壳层的封闭维度：railWidth / panelWidth / leftTab / rightMode / dockHeight /
 * inspectorTab / showGrid / density / hideRail / hideInspector。不写 deck 历史，写
 * `settings.plugins.layoutOverride`（「恢复默认工作台」清空该项）。
 */
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import type { PluginLayoutOverride } from '@/state/settingsStore'
import type { LayoutPresetContribution, LayoutSnapshot } from '../types'

export const DEFAULT_LAYOUT: LayoutSnapshot = {
  railWidth: 216,
  panelWidth: 340,
  rightMode: 'inspector',
  leftTab: 'slides',
  dockHeight: 300,
  density: 'comfortable',
}

const RAIL_MIN = 180
const RAIL_MAX = 280
const PANEL_MIN = 300
const PANEL_MAX = 420
const DOCK_MIN = 240
const DOCK_MAX = 400

function clamp(value: number | undefined, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 应用布局预设（越界值夹紧；不存在的维度静默跳过）。返回实际生效的快照。 */
export function applyLayoutPreset(apply: PluginLayoutOverride): LayoutSnapshot {
  const ui = useUiStore.getState()
  const snapshot: LayoutSnapshot = {
    railWidth: clamp(apply.railWidth, RAIL_MIN, RAIL_MAX) ?? ui.railWidth,
    panelWidth: clamp(apply.panelWidth, PANEL_MIN, PANEL_MAX) ?? ui.panelWidth,
    rightMode: apply.rightMode ?? (ui.rightMode === 'creator' ? 'composer' : ui.rightMode),
    leftTab: apply.leftTab ?? ui.leftTab,
    dockHeight: clamp(apply.dockHeight, DOCK_MIN, DOCK_MAX) ?? ui.dockHeight,
    density: apply.density ?? ui.density,
  }
  ui.setRailWidth(snapshot.railWidth)
  ui.setPanelWidth(snapshot.panelWidth)
  ui.setRightMode(snapshot.rightMode)
  ui.setLeftTab(snapshot.leftTab)
  ui.setDockHeight(snapshot.dockHeight)
  ui.setDensity(snapshot.density)
  if (apply.showGrid !== undefined) {
    if (useUiStore.getState().showGrid !== apply.showGrid) useUiStore.getState().toggleGrid()
  }
  if (apply.inspectorTab) ui.setInspectorTab(apply.inspectorTab)
  if (apply.hideRail !== undefined) ui.setHideRail(apply.hideRail)
  if (apply.hideInspector !== undefined) ui.setHideInspector(apply.hideInspector)
  useSettingsStore.getState().patchPlugins({ layoutOverride: apply })
  return snapshot
}

/** 还原默认工作台布局（停用布局预设插件 / 恢复默认时调用）。 */
export function restoreDefaultLayout(): void {
  const ui = useUiStore.getState()
  ui.setRailWidth(DEFAULT_LAYOUT.railWidth)
  ui.setPanelWidth(DEFAULT_LAYOUT.panelWidth)
  ui.setRightMode(DEFAULT_LAYOUT.rightMode)
  ui.setLeftTab(DEFAULT_LAYOUT.leftTab)
  ui.setDockHeight(DEFAULT_LAYOUT.dockHeight)
  ui.setDensity(DEFAULT_LAYOUT.density)
  ui.setHideRail(false)
  ui.setHideInspector(false)
  if (useUiStore.getState().showGrid) useUiStore.getState().toggleGrid()
  useSettingsStore.getState().patchPlugins({ layoutOverride: null })
}

/** 当前插件布局是否由某插件的预设应用（停用/卸载时判断是否还原）。 */
export function isLayoutFromPresets(presets: readonly LayoutPresetContribution[]): boolean {
  const current = useSettingsStore.getState().plugins.layoutOverride
  if (!current) return false
  return presets.some((preset) => sameLayoutPreset(preset.apply, current))
}

function sameLayoutPreset(left: PluginLayoutOverride, right: PluginLayoutOverride): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    const a = (left as Record<string, unknown>)[key]
    const b = (right as Record<string, unknown>)[key]
    if (JSON.stringify(a) !== JSON.stringify(b)) return false
  }
  return true
}

/** 「恢复默认工作台」的布局维度（保持与 DEFAULT_LAYOUT 同步的自检）。 */
export function layoutDefaults(): LayoutSnapshot {
  return { ...DEFAULT_LAYOUT }
}
