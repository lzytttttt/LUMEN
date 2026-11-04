/**
 * Dialogs.tsx —— 全站弹窗与命令面板的挂载点（App 只渲染这一个组件）。
 *
 * v0.4.0 增：插件管理宿主（dialog 插槽宿主 + 权限卡）与键位冲突确认弹窗。
 * 首屏预算（02 §10.3）：管理 UI 用 `lazy()` 懒加载，只有打开管理页/收到安装预览时才拉 chunk；
 * 事件监听放在常挂的轻量 `PluginEventBridge` 里（不含重量级组件）。
 */
import { lazy, Suspense } from 'react'
import { useUiStore } from '@/state/uiStore'
import { usePluginUiStore } from './pluginUiStore'
import { SettingsDialog } from './SettingsDialog'
import { ExportDialog } from './ExportDialog'
import { ShortcutsDialog } from './ShortcutsDialog'
import { AboutDialog } from './AboutDialog'
import { CommandPalette } from './CommandPalette'
import { PluginEventBridge } from './PluginEventBridge'
import { PluginKeymapConflictDialog } from './PluginKeymapConflictDialog'
import { PluginDialogHost } from '@/plugins/public'
import './dialogs.css'

const LazyPluginManagerHost = lazy(() =>
  import('./PluginManagerDialog').then((module) => ({ default: module.PluginManagerHost })),
)

/**
 * 只在「管理弹窗打开或已有安装预览」时才请求管理 UI chunk（02 §10.3）；
 * 未打开时返回 null，`import()` 永不触发（首屏 0 字节）。
 */
function PluginManagerSurface() {
  const managerOpen = usePluginUiStore((s) => s.managerOpen)
  const hasPreview = usePluginUiStore((s) => s.preview !== null)
  if (!managerOpen && !hasPreview) return null
  return (
    <Suspense fallback={null}>
      <LazyPluginManagerHost />
    </Suspense>
  )
}

export function Dialogs() {
  const dialog = useUiStore((s) => s.dialog)
  const close = useUiStore((s) => s.closeDialog)
  return (
    <>
      <SettingsDialog open={dialog === 'settings'} onClose={close} />
      <ExportDialog open={dialog === 'export'} onClose={close} />
      <ShortcutsDialog open={dialog === 'shortcuts'} onClose={close} />
      <AboutDialog open={dialog === 'about'} onClose={close} />
      <PluginEventBridge />
      <PluginManagerSurface />
      <PluginKeymapConflictDialog />
      {/* dialog 插槽（02 §6.10）：打开时建帧、关闭即销毁；每槽独立 ErrorBoundary 由 SlotHost 负责 */}
      <PluginDialogHost />
      <CommandPalette />
    </>
  )
}
