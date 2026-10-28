/**
 * HelpOverlay.tsx —— 播放快捷键浮层（?）。
 * 键位与 Player 的实际处理保持一致；文案统一走 play.* 命名空间。
 */
import type { JSX } from 'react'
import { useT } from '@/i18n'
import type { MessageKey } from '@/i18n'

export interface HelpOverlayProps {
  onClose: () => void
}

interface ShortcutRow {
  keys: string[]
  label: MessageKey
}

const ROWS: ShortcutRow[] = [
  { keys: ['→', 'Space', 'PageDown', 'N'], label: 'play.next' },
  { keys: ['←', 'PageUp', 'P'], label: 'play.prev' },
  { keys: ['Home'], label: 'play.firstSlide' },
  { keys: ['End'], label: 'play.lastSlide' },
  { keys: ['F'], label: 'play.fullscreen' },
  { keys: ['O'], label: 'play.overview' },
  { keys: ['Shift', 'N'], label: 'play.presenter' },
  { keys: ['B'], label: 'play.blackout' },
  { keys: ['T'], label: 'play.timer' },
  { keys: ['R'], label: 'play.timerReset' },
  { keys: ['?'], label: 'play.help' },
  { keys: ['Esc'], label: 'play.exit' },
]

export function HelpOverlay({ onClose }: HelpOverlayProps): JSX.Element {
  const t = useT()
  return (
    <div
      className="play-help"
      data-play-chrome="true"
      role="dialog"
      aria-modal="true"
      aria-label={t('play.help')}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="play-help__card">
        <header className="play-help__head">
          <span className="play-help__title">{t('play.help')}</span>
          <button type="button" className="play-btn" onClick={onClose} aria-label={t('common.action.close')}>
            ×
          </button>
        </header>
        <dl className="play-help__list">
          {ROWS.map((row) => (
            <div className="play-help__row" key={row.label}>
              <dt>
                {row.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </dt>
              <dd>{t(row.label)}</dd>
            </div>
          ))}
        </dl>
        <p className="play-help__foot">{t('play.helpClose')}</p>
      </div>
    </div>
  )
}
