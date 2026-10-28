/**
 * Dialogs.tsx —— 全站弹窗与命令面板的挂载点（App 只渲染这一个组件）。
 */
import { useUiStore } from '@/state/uiStore'
import { SettingsDialog } from './SettingsDialog'
import { ExportDialog } from './ExportDialog'
import { ShortcutsDialog } from './ShortcutsDialog'
import { AboutDialog } from './AboutDialog'
import { CommandPalette } from './CommandPalette'
import './dialogs.css'

export function Dialogs() {
  const dialog = useUiStore((s) => s.dialog)
  const close = useUiStore((s) => s.closeDialog)
  return (
    <>
      <SettingsDialog open={dialog === 'settings'} onClose={close} />
      <ExportDialog open={dialog === 'export'} onClose={close} />
      <ShortcutsDialog open={dialog === 'shortcuts'} onClose={close} />
      <AboutDialog open={dialog === 'about'} onClose={close} />
      <CommandPalette />
    </>
  )
}
