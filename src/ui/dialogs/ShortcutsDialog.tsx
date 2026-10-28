/**
 * ShortcutsDialog.tsx —— 快捷键表（只读展示，键位由 stage-editor 的 shortcuts.ts 执行）。
 */
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { Button, Modal } from '@/ui/primitives'
import './dialogs.css'

const ROWS: { combo: string; key: MessageKey }[] = [
  { combo: '⌘ / Ctrl + K', key: 'editor.shortcuts.command' },
  { combo: '⌘ / Ctrl + Z', key: 'editor.shortcuts.undo' },
  { combo: '⌘ / Ctrl + ⇧ + Z', key: 'editor.shortcuts.redo' },
  { combo: '⌘ / Ctrl + D', key: 'editor.shortcuts.duplicate' },
  { combo: '⌘ / Ctrl + ⏎', key: 'editor.shortcuts.play' },
  { combo: '⌘ / Ctrl + A', key: 'common.action.selectAll' },
  { combo: 'Del', key: 'editor.shortcuts.delete' },
  { combo: 'G', key: 'editor.shortcuts.grid' },
  { combo: '↑ ↓ ← →', key: 'editor.shortcuts.nudge' },
  { combo: '⇧ + ↑ ↓ ← →', key: 'editor.shortcuts.nudgeBig' },
  { combo: 'F2', key: 'common.action.rename' },
  { combo: 'Esc', key: 'editor.shortcuts.escape' },
]

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('editor.shortcuts.title')}
      subtitle={t('editor.dialog.shortcutsSubtitle')}
      size="sm"
      closeLabel={t('common.action.close')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('common.action.close')}
        </Button>
      }
    >
      <div className="ldlg-keys">
        {ROWS.map((row) => (
          <div className="ldlg-keys__row" key={`${row.combo}-${row.key}`}>
            <span className="ldlg-keys__combo">{row.combo}</span>
            <span className="ldlg-keys__label">{t(row.key)}</span>
          </div>
        ))}
      </div>
    </Modal>
  )
}
