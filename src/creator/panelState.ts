/**
 * creator/panelState.ts —— 面板开关的**轻量**状态（首屏零字节预算的关键）。
 *
 * 为什么要单独一层：宿主壳（TopBar/命令面板/App）只需要「开/关/是否打开」，
 * 不应该把整个创造模式（zod/AI/templates/publish/UI）拖进首屏 bundle。
 * 重量级 store 由 `CreatorSurface` 懒加载后接管：`openHandler` / `closeHandler` 在挂载时注册。
 */
import { create } from 'zustand'
import type { CreatorEntrySource, CreatorTemplateId } from './state'

export interface CreatorPanelState {
  open: boolean
  entry: CreatorEntrySource
  template: CreatorTemplateId | null
  /** 懒加载的 CreatorSurface 挂载后注册；未挂载时为 null（bridge 只改开关状态）。 */
  openHandler: ((entry: CreatorEntrySource, template: CreatorTemplateId | null) => void) | null
  closeHandler: (() => void) | null
}

export const useCreatorPanelStore = create<CreatorPanelState>(() => ({
  open: false,
  entry: 'topbar',
  template: null,
  openHandler: null,
  closeHandler: null,
}))

export function requestOpenCreator(source: CreatorEntrySource, template: CreatorTemplateId | null): void {
  useCreatorPanelStore.setState({ open: true, entry: source, template })
  useCreatorPanelStore.getState().openHandler?.(source, template)
}

export function requestCloseCreator(): void {
  const handler = useCreatorPanelStore.getState().closeHandler
  if (handler) {
    handler()
    return
  }
  useCreatorPanelStore.setState({ open: false })
}

export function forceCloseCreator(): void {
  useCreatorPanelStore.setState({ open: false, template: null })
}

/** 重量级面板挂载时注册；卸载时传 null 复原。 */
export function registerCreatorPanelHandlers(handlers: {
  openHandler: (entry: CreatorEntrySource, template: CreatorTemplateId | null) => void
  closeHandler: () => void
} | null): void {
  useCreatorPanelStore.setState({
    openHandler: handlers?.openHandler ?? null,
    closeHandler: handlers?.closeHandler ?? null,
  })
}

export function useCreatorPanelOpen(): boolean {
  return useCreatorPanelStore((state) => state.open)
}
