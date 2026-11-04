/**
 * plugins/host/frameUi.ts —— 帧宿主 UI 状态（标题 / busy / 弹窗 / 打开的面板）。
 *
 * 纯模块单例（不依赖 React），`SlotHost.tsx` / `PluginHost.tsx` 用 `useSyncExternalStore` 订阅；
 * `runtime.ts` 把它适配成 `api/context.ts` 的 `HostUiPort` 安装给 API 层。
 */
import type { SlotId } from '../types'

export interface FrameDialogState {
  frameId: string
  pluginId: string
  contributionId: string
  title: string
  size: 'sm' | 'md' | 'lg'
}

export interface FramePanelState {
  frameId: string
  pluginId: string
  slot: SlotId
  contributionId: string
  title: string
}

export interface FrameUiSnapshot {
  dialogs: FrameDialogState[]
  panels: FramePanelState[]
  titles: Record<string, string>
  busy: Record<string, { busy: boolean; label: string }>
}

const MAX_DIALOGS = 1
const MAX_PANELS = 3

let snapshot: FrameUiSnapshot = { dialogs: [], panels: [], titles: {}, busy: {} }
const listeners = new Set<() => void>()

function emit(next: Partial<FrameUiSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
}

export function subscribeFrameUi(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getFrameUiSnapshot(): FrameUiSnapshot {
  return snapshot
}

/* ------------------------------ 标题 / busy ------------------------------ */

export function setFrameTitle(frameId: string, title: string): void {
  const next = title.slice(0, 40)
  if (snapshot.titles[frameId] === next) return
  emit({ titles: { ...snapshot.titles, [frameId]: next } })
}

export function setFrameBusy(frameId: string, busy: boolean, label = ''): void {
  emit({ busy: { ...snapshot.busy, [frameId]: { busy, label: label.slice(0, 40) } } })
}

/* ------------------------------ 弹窗 ------------------------------ */

/** 打开/替换弹窗（同一时刻只保留 1 个插件弹窗，02 §6.11）。 */
export function openFrameDialog(state: FrameDialogState): void {
  const dialogs = [state, ...snapshot.dialogs.filter((dialog) => dialog.frameId !== state.frameId)].slice(0, MAX_DIALOGS)
  emit({ dialogs })
}

export function closeFrameDialog(frameId: string): void {
  emit({ dialogs: snapshot.dialogs.filter((dialog) => dialog.frameId !== frameId) })
}

export function closePluginDialogs(pluginId: string): string[] {
  const closing = snapshot.dialogs.filter((dialog) => dialog.pluginId === pluginId)
  if (closing.length === 0) return []
  emit({ dialogs: snapshot.dialogs.filter((dialog) => dialog.pluginId !== pluginId) })
  return closing.map((dialog) => dialog.frameId)
}

/* ------------------------------ 面板 ------------------------------ */

export function openFramePanel(state: FramePanelState): void {
  const rest = snapshot.panels.filter((panel) => !(panel.pluginId === state.pluginId && panel.contributionId === state.contributionId))
  emit({ panels: [state, ...rest].slice(0, MAX_PANELS) })
}

export function closeFramePanel(frameId: string): void {
  emit({ panels: snapshot.panels.filter((panel) => panel.frameId !== frameId) })
}

export function closePluginPanels(pluginId: string): string[] {
  const closing = snapshot.panels.filter((panel) => panel.pluginId === pluginId)
  if (closing.length === 0) return []
  emit({ panels: snapshot.panels.filter((panel) => panel.pluginId !== pluginId) })
  return closing.map((panel) => panel.frameId)
}

/* ------------------------------ 重置 ------------------------------ */

export function resetFrameUi(): void {
  snapshot = { dialogs: [], panels: [], titles: {}, busy: {} }
  for (const listener of listeners) listener()
}

export function resetFrameUiForTests(): void {
  listeners.clear()
  resetFrameUi()
}
