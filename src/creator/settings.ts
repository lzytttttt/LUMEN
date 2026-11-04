/**
 * creator/settings.ts —— `settings.plugins.creator` 的唯一读写口（02 §7.4 / 04 §13.3.1）。
 *
 * 字段冻结：`{ readDeck, lastDraftId, exportFormat: 'lumenplug', panelWidth }`；
 * `panelWidth` 默认 420、夹紧 360–560（04 §2.2）。设置本身持久化由 settingsSync 负责，
 * 这里只走 `useSettingsStore`（不直接写 IDB）。
 */
import type { PluginCreatorSettings } from '@/plugins/types'
import { useSettingsStore } from '@/state/settingsStore'

export const CREATOR_PANEL_DEFAULT_WIDTH = 420
export const CREATOR_PANEL_MIN_WIDTH = 360
export const CREATOR_PANEL_MAX_WIDTH = 560
/** 面板宽度步进（04 §2.2：写回设置，7 日节流在 UI 层做）。 */
export const CREATOR_PANEL_STEP = 8

export const DEFAULT_CREATOR_SETTINGS: PluginCreatorSettings = {
  readDeck: false,
  lastDraftId: null,
  exportFormat: 'lumenplug',
  panelWidth: CREATOR_PANEL_DEFAULT_WIDTH,
}

/** 夹紧面板宽度到 360–560（非数字回落默认 420）。 */
export function clampPanelWidth(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return CREATOR_PANEL_DEFAULT_WIDTH
  return Math.min(CREATOR_PANEL_MAX_WIDTH, Math.max(CREATOR_PANEL_MIN_WIDTH, Math.round(numeric)))
}

/** 读当前创造模式偏好（结构合并且对旧快照缺字段兜底）。 */
export function creatorSettings(): PluginCreatorSettings {
  const state = useSettingsStore.getState() as unknown as {
    plugins?: { creator?: Partial<PluginCreatorSettings> }
  }
  const raw = state.plugins?.creator ?? {}
  const readDeck = typeof raw.readDeck === 'boolean' ? raw.readDeck : DEFAULT_CREATOR_SETTINGS.readDeck
  const lastDraftId = typeof raw.lastDraftId === 'string' && raw.lastDraftId !== '' ? raw.lastDraftId : null
  return {
    readDeck,
    lastDraftId,
    exportFormat: 'lumenplug',
    panelWidth: clampPanelWidth(raw.panelWidth ?? CREATOR_PANEL_DEFAULT_WIDTH),
  }
}

/** 写回一条偏好（走 Lead 的 `patchPlugins`；只 patch creator 子段）。 */
export function patchCreatorSettings(patch: Partial<PluginCreatorSettings>): void {
  const next = { ...creatorSettings(), ...patch }
  if (patch.panelWidth !== undefined) next.panelWidth = clampPanelWidth(patch.panelWidth)
  if (patch.lastDraftId !== undefined) {
    next.lastDraftId = typeof patch.lastDraftId === 'string' && patch.lastDraftId !== '' ? patch.lastDraftId : null
  }
  const patchPlugins = (useSettingsStore.getState() as unknown as {
    patchPlugins?: (value: { creator: PluginCreatorSettings }) => void
  }).patchPlugins
  if (patchPlugins) patchPlugins({ creator: next })
}

export function creatorLastDraftId(): string | null {
  return creatorSettings().lastDraftId
}

export function setCreatorLastDraftId(draftId: string | null): void {
  patchCreatorSettings({ lastDraftId: draftId })
}

export function creatorReadDeck(): boolean {
  return creatorSettings().readDeck
}

export function setCreatorReadDeck(readDeck: boolean): void {
  patchCreatorSettings({ readDeck })
}
