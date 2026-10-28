/**
 * uiStore.ts —— 工作台外壳状态（模式、当前幕、面板、缩放、弹窗、Toast）。
 * 与 deck 数据无关，不进撤销历史。
 */
import { create } from 'zustand'
import { newId } from '@/schema/ids'

export type WorkbenchMode = 'edit' | 'preview' | 'play' | 'forge'
export type InspectorTab = 'props' | 'layers' | 'motion' | 'notes' | 'theme' | 'lint'
export type RightPanelMode = 'inspector' | 'composer'
export type DialogId = 'settings' | 'export' | 'shortcuts' | 'about' | 'import' | 'library' | 'open'

export interface ToastItem {
  id: string
  kind: 'info' | 'success' | 'error'
  message: string
  actionLabel?: string
  action?: () => void
  ttl: number
}

export type ZoomMode = 'fit' | number

interface UiState {
  mode: WorkbenchMode
  activeSlideId: string | null
  inspectorTab: InspectorTab
  rightMode: RightPanelMode
  zoom: ZoomMode
  showGrid: boolean
  snapEnabled: boolean
  showGuides: boolean
  railWidth: number
  panelWidth: number
  leftTab: 'slides' | 'outline'
  dialog: DialogId | null
  commandOpen: boolean
  toasts: ToastItem[]
  bootError: string | null

  setMode: (mode: WorkbenchMode) => void
  setActiveSlide: (id: string | null) => void
  setInspectorTab: (tab: InspectorTab) => void
  setRightMode: (mode: RightPanelMode) => void
  setZoom: (zoom: ZoomMode) => void
  toggleGrid: () => void
  toggleSnap: () => void
  toggleGuides: () => void
  setRailWidth: (w: number) => void
  setPanelWidth: (w: number) => void
  setLeftTab: (tab: 'slides' | 'outline') => void
  openDialog: (id: DialogId) => void
  closeDialog: () => void
  setCommandOpen: (open: boolean) => void
  pushToast: (toast: Omit<ToastItem, 'id' | 'ttl'> & { ttl?: number }) => void
  dismissToast: (id: string) => void
  setBootError: (message: string | null) => void
}

export const useUiStore = create<UiState>((set, get) => ({
  mode: 'edit',
  activeSlideId: null,
  inspectorTab: 'props',
  rightMode: 'inspector',
  zoom: 'fit',
  showGrid: false,
  snapEnabled: true,
  showGuides: true,
  railWidth: 216,
  panelWidth: 340,
  leftTab: 'slides',
  dialog: null,
  commandOpen: false,
  toasts: [],
  bootError: null,

  setMode: (mode) => set({ mode }),
  setActiveSlide: (activeSlideId) => set({ activeSlideId }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  setRightMode: (rightMode) => set({ rightMode }),
  setZoom: (zoom) => set({ zoom }),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  toggleGuides: () => set((s) => ({ showGuides: !s.showGuides })),
  setRailWidth: (railWidth) => set({ railWidth }),
  setPanelWidth: (panelWidth) => set({ panelWidth }),
  setLeftTab: (leftTab) => set({ leftTab }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  pushToast: (toast) => {
    const item: ToastItem = { id: newId('toast'), ttl: 3200, ...toast }
    set((s) => ({ toasts: [...s.toasts, item].slice(-4) }))
    if (item.ttl > 0) {
      window.setTimeout(() => get().dismissToast(item.id), item.ttl)
    }
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setBootError: (bootError) => set({ bootError }),
}))
