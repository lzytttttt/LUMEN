/**
 * PluginKeymapConflictDialog.tsx —— 插件键位冲突确认（02 §6.7 / 03 §3.1）。
 *
 * 冲突不静默覆盖：用户逐条选择「保持内置」→ 写 host 决策；「让给插件」→ 写 plugin 覆盖，
 * 落到 `settings.plugins.keymapOverrides`（plugin-core 的 resolveKeymapConflict 负责写）。
 * 全部条目不解决时弹窗不自动关；Esc/关闭 = 全部保持内置（保守选择）。
 */
import { useEffect, useMemo, useState } from 'react'
import { useT } from '@/i18n'
import { Button, Modal } from '@/ui/primitives'
import { resolveKeymapConflict, useKeymapConflicts } from '@/plugins/public'
import { useReturnFocus } from './useReturnFocus'
import './plugins.css'

export function PluginKeymapConflictDialog() {
  const t = useT()
  const conflicts = useKeymapConflicts()
  const [handled, setHandled] = useState<Record<string, 'host' | 'plugin'>>({})

  const pending = useMemo(() => conflicts.filter((conflict) => !handled[conflict.combo]), [conflicts, handled])
  const open = pending.length > 0
  useReturnFocus(open)

  // 冲突消失后清掉本地决策，避免下次同 combo 复用旧值。
  useEffect(() => {
    if (conflicts.length === 0 && Object.keys(handled).length > 0) setHandled({})
  }, [conflicts.length, handled])

  const decide = (combo: string, decision: 'host' | 'plugin') => {
    setHandled((prev) => ({ ...prev, [combo]: decision }))
    resolveKeymapConflict(combo, decision)
  }

  const keepAll = () => {
    const next: Record<string, 'host' | 'plugin'> = { ...handled }
    for (const conflict of pending) {
      resolveKeymapConflict(conflict.combo, 'host')
      next[conflict.combo] = 'host'
    }
    setHandled(next)
  }

  return (
    <Modal
      open={open}
      onClose={keepAll}
      title={t('plugin.keymap.conflictTitle')}
      subtitle={t('plugin.keymap.conflictBody', {
        keys: pending[0]?.combo ?? '',
        owner: pending[0]?.owner === 'host' ? t('common.plugin.badge.builtin') : (pending[0]?.pluginName ?? ''),
      })}
      size="sm"
      closeLabel={t('common.action.close')}
      footer={
        <>
          <Button variant="ghost" data-keymap-conflict="keep-all" onClick={keepAll}>
            {t('plugin.keymap.keepHost')}
          </Button>
          {pending[0] ? (
            <Button
              variant="primary"
              data-keymap-conflict="give"
              onClick={() => decide(pending[0].combo, 'plugin')}
            >
              {t('plugin.keymap.givePlugin')}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="plug-conflict" data-keymap-conflicts={pending.length}>
        {pending.map((conflict) => (
          <div className="plug-conflict__row" key={conflict.combo} data-keymap-conflict-combo={conflict.combo}>
            <span className="plug-conflict__combo">{conflict.combo}</span>
            <span className="plug-conflict__body">
              {t('plugin.keymap.conflictBody', {
                keys: conflict.combo,
                owner: conflict.owner === 'host' ? t('common.plugin.badge.builtin') : conflict.pluginName,
              })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              data-keymap-decision="host"
              onClick={() => decide(conflict.combo, 'host')}
            >
              {t('plugin.keymap.keepHost')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-keymap-decision="plugin"
              onClick={() => decide(conflict.combo, 'plugin')}
            >
              {t('plugin.keymap.givePlugin')}
            </Button>
          </div>
        ))}
      </div>
    </Modal>
  )
}
