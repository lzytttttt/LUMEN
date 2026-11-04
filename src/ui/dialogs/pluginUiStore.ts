/**
 * pluginUiStore.ts —— 插件管理 UI 的本地开关状态（shell-ui 域，不进 deck 历史）。
 *
 * 为什么不放进 uiStore：`uiStore` 属 Lead 域（`DialogId` 联合不扩），
 * 插件管理是 v0.4.0 新增的独立弹窗，用本文件自己的小 store 更省冲突面。
 * 打开入口：
 * - 顶栏「插件」按钮 / 命令面板 `plugin.open` → `openPluginManager()`
 * - 全局 drop（App.tsx）→ `window` 事件 `lumen:plugin-install` → boot 解析后派发
 *   `lumen:plugin-preview` → `PluginManagerHost` 接住并打开权限卡（03 §3.3）
 * - 插件页 `plugins.html` 与调试：`window.dispatchEvent(new CustomEvent('lumen:open-plugin-manager'))`
 */
import { create } from 'zustand'
import type { PluginPackagePreview } from '@/plugins/public'

interface PluginUiState {
  managerOpen: boolean
  /** 已解析、等待用户逐项确认的安装包（权限卡的数据源）。 */
  preview: PluginPackagePreview | null
  openManager: () => void
  closeManager: () => void
  setPreview: (preview: PluginPackagePreview | null) => void
}

export const usePluginUiStore = create<PluginUiState>((set) => ({
  managerOpen: false,
  preview: null,
  openManager: () => set({ managerOpen: true }),
  closeManager: () => set({ managerOpen: false }),
  setPreview: (preview) => set({ preview }),
}))

/** 非组件代码（命令面板 / 事件监听）里打开管理弹窗。 */
export function openPluginManager(): void {
  usePluginUiStore.getState().openManager()
}

export function closePluginManager(): void {
  usePluginUiStore.getState().closeManager()
}
