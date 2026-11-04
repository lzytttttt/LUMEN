/**
 * ShortcutsDialog.tsx —— 快捷键表（只读展示，键位由 stage-editor 的 shortcuts.ts 执行）。
 *
 * v0.4.0：追加插件键位（02 §6.7 / 03 §3.1）——列出「插件来源」徽标，让用户知道某个组合
 * 是插件绑的还是内置的；冲突确认在 `PluginKeymapConflictDialog` 里做。
 */
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { Button, Modal } from '@/ui/primitives'
import { usePluginCommands, usePluginKeymap } from '@/plugins/public'
import './dialogs.css'
import './plugins.css'

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

const KEY_LABELS: Record<string, string> = {
  mod: '⌘ / Ctrl',
  shift: '⇧',
  alt: 'Alt',
  enter: '⏎',
  escape: 'Esc',
}

/** `mod+shift+k` → `⌘ / Ctrl + ⇧ + K`（只做展示；语义由 shortcuts.ts 解释）。 */
export function formatComboForDisplay(combo: string): string {
  return combo
    .split('+')
    .map((part) => {
      const key = part.trim()
      const lower = key.toLowerCase()
      if (KEY_LABELS[lower]) return KEY_LABELS[lower]
      if (KEY_LABELS[key]) return KEY_LABELS[key]
      if (lower.startsWith('f') && /^f\d{1,2}$/.test(lower)) return key.toUpperCase()
      return key.length === 1 ? key.toUpperCase() : key
    })
    .join(' + ')
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const pluginKeymap = usePluginKeymap()
  const pluginCommands = usePluginCommands()

  const titleOf = (commandId: string): string => {
    const command = pluginCommands.find((item) => item.id === commandId)
    return command ? command.title : commandId
  }

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

        {/* 插件键位（02 §6.7：列出插件来源；卸载即还原） */}
        {pluginKeymap.length > 0 ? (
          <>
            <div className="ldlg-keys__row ldlg-keys__row--group">
              <span className="ldlg-keys__label">{t('plugin.title')}</span>
            </div>
            {pluginKeymap.map((entry) => (
              <div
                className="ldlg-keys__row"
                key={`${entry.combo}-${entry.commandId}`}
                data-plugin-keymap={entry.pluginId}
              >
                <span className="ldlg-keys__combo">{formatComboForDisplay(entry.combo)}</span>
                <span className="ldlg-keys__label">
                  {titleOf(entry.commandId)}
                  <span className="plug-badge">{t('plugin.keymap.sourcePlugin', { name: entry.pluginName })}</span>
                </span>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </Modal>
  )
}
