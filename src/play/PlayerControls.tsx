/**
 * PlayerControls.tsx —— 底部控制条。
 *
 * 克制、暗底、只在需要时出现：`visible=false` 时整体淡出且不可点，
 * 鼠标移动 / 键盘操作由 Player 唤回。
 */
import type { JSX } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  Maximize,
  Minimize,
  MonitorPlay,
  Pause,
  Play,
  Repeat,
  Timer,
  X,
} from 'lucide-react'
import { useT } from '@/i18n'
import { formatClock } from './playbackCore'

export interface PlayerControlsProps {
  index: number
  total: number
  elapsedMs: number
  timerVisible: boolean
  autoplay: boolean
  loop: boolean
  fullscreen: boolean
  presenterOpen: boolean
  visible: boolean
  onPrev: () => void
  onNext: () => void
  onJump: (index: number) => void
  onToggleTimer: () => void
  onToggleAutoplay: () => void
  onToggleLoop: () => void
  onToggleOverview: () => void
  onTogglePresenter: () => void
  onToggleFullscreen: () => void
  onExit: () => void
}

export function PlayerControls({
  index,
  total,
  elapsedMs,
  timerVisible,
  autoplay,
  loop,
  fullscreen,
  presenterOpen,
  visible,
  onPrev,
  onNext,
  onJump,
  onToggleTimer,
  onToggleAutoplay,
  onToggleLoop,
  onToggleOverview,
  onTogglePresenter,
  onToggleFullscreen,
  onExit,
}: PlayerControlsProps): JSX.Element {
  const t = useT()
  const safeTotal = Math.max(1, total)
  const progress = total <= 0 ? 0 : ((index + 1) / safeTotal) * 100

  const jump = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0 || total <= 0) return
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    onJump(Math.min(total - 1, Math.max(0, Math.round(ratio * (total - 1)))))
  }

  return (
    <div
      className="play-bar"
      data-play-chrome="true"
      data-visible={visible ? 'true' : 'false'}
      role="toolbar"
      aria-label={t('play.help')}
    >
      <button
        type="button"
        className="play-btn"
        onClick={onPrev}
        title={t('play.prev')}
        aria-label={t('play.prev')}
        disabled={index <= 0}
      >
        <ChevronLeft size={17} strokeWidth={1.8} />
      </button>

      <span className="play-bar__count" aria-live="off">
        {t('play.slideCounter', { current: total === 0 ? 0 : index + 1, total })}
      </span>

      <button
        type="button"
        className="play-btn"
        onClick={onNext}
        title={t('play.next')}
        aria-label={t('play.next')}
        disabled={index >= total - 1}
      >
        <ChevronRight size={17} strokeWidth={1.8} />
      </button>

      <div
        className="play-bar__progress"
        role="slider"
        tabIndex={-1}
        aria-label={t('play.progress')}
        aria-valuemin={1}
        aria-valuemax={safeTotal}
        aria-valuenow={total === 0 ? 0 : index + 1}
        onPointerDown={jump}
      >
        <span className="play-bar__progress-fill" style={{ width: `${progress}%` }} />
        <span className="play-bar__progress-dot" style={{ left: `${progress}%` }} />
      </div>

      <span className="play-bar__sep" />

      <button
        type="button"
        className="play-btn play-btn--wide"
        data-on={timerVisible ? 'true' : 'false'}
        onClick={onToggleTimer}
        title={t('play.timer')}
        aria-label={t('play.timer')}
        aria-pressed={timerVisible}
      >
        <Timer size={15} strokeWidth={1.8} />
        {timerVisible ? <span className="play-bar__timer">{formatClock(elapsedMs)}</span> : null}
      </button>

      <button
        type="button"
        className="play-btn"
        data-on={autoplay ? 'true' : 'false'}
        onClick={onToggleAutoplay}
        title={t('play.autoplay')}
        aria-label={t('play.autoplay')}
        aria-pressed={autoplay}
      >
        {autoplay ? <Pause size={15} strokeWidth={1.9} /> : <Play size={15} strokeWidth={1.9} />}
      </button>

      {autoplay ? (
        <button
          type="button"
          className="play-btn"
          data-on={loop ? 'true' : 'false'}
          onClick={onToggleLoop}
          title={t('play.loop')}
          aria-label={t('play.loop')}
          aria-pressed={loop}
        >
          <Repeat size={15} strokeWidth={1.9} />
        </button>
      ) : null}

      <button
        type="button"
        className="play-btn"
        data-on={presenterOpen ? 'true' : 'false'}
        onClick={onTogglePresenter}
        title={t('play.presenterOpen')}
        aria-label={t('play.presenterOpen')}
        aria-pressed={presenterOpen}
      >
        <MonitorPlay size={16} strokeWidth={1.7} />
      </button>

      <button
        type="button"
        className="play-btn"
        onClick={onToggleOverview}
        title={t('play.overview')}
        aria-label={t('play.overview')}
      >
        <LayoutGrid size={15} strokeWidth={1.8} />
      </button>

      <button
        type="button"
        className="play-btn"
        onClick={onToggleFullscreen}
        title={t('play.fullscreen')}
        aria-label={t('play.fullscreen')}
      >
        {fullscreen ? <Minimize size={16} strokeWidth={1.8} /> : <Maximize size={16} strokeWidth={1.8} />}
      </button>

      <span className="play-bar__sep" />

      <button
        type="button"
        className="play-btn play-btn--exit"
        onClick={onExit}
        title={t('play.exit')}
        aria-label={t('play.exit')}
      >
        <X size={16} strokeWidth={1.9} />
      </button>
    </div>
  )
}
