/**
 * Player.tsx —— 播放器外壳（`uiStore.mode === 'play'` 时由 App 挂载）。
 *
 * 职责边界：
 * - 只做"外壳"：键盘/触摸/鼠标、控制条、黑屏、总览、帮助、全屏、讲者视图入口；
 * - 画面本身交给 `PlaySurface`（exporter 复用同一套）；
 * - 翻页/计时/自动播放状态机在 `usePlayback`，这里不重复实现。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useActiveSlideIndex } from '@/state/selectors'
import { useT } from '@/i18n'
import { PlaySurface } from './PlaySurface'
import { PlayerControls } from './PlayerControls'
import { Overview } from './Overview'
import { HelpOverlay } from './HelpOverlay'
import { usePlayback } from './usePlayback'
import { usePresenterSync } from './usePresenterSync'
import './play.css'

/** 控制条自动隐藏延时。 */
const CHROME_IDLE_MS = 2500
/** 首屏提示停留时长。 */
const HINT_MS = 3000
/** 触摸/鼠标滑动的最小位移。 */
const SWIPE_MIN_PX = 48

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (TYPING_TAGS.has(el.tagName)) return true
  return el.isContentEditable === true
}

export function Player(): JSX.Element {
  const t = useT()
  const deck = useDeckStore((s) => s.deck)
  const setMode = useUiStore((s) => s.setMode)
  const setActiveSlide = useUiStore((s) => s.setActiveSlide)
  const pushToast = useUiStore((s) => s.pushToast)
  const autoPlayMs = useSettingsStore((s) => s.autoPlayMs)
  const lang = useSettingsStore((s) => s.lang)

  // 从编辑器进来时停在当前幕；之后用户怎么翻都不影响这个初值。
  const startIndex = useActiveSlideIndex()
  const initialIndexRef = useRef(startIndex)

  const [loop, setLoop] = useState(false)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [timerVisible, setTimerVisible] = useState(false)
  const [chrome, setChrome] = useState(true)
  const [hintVisible, setHintVisible] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<number | null>(null)
  const swipeRef = useRef<{ x: number; y: number; at: number } | null>(null)
  const lastSwipeAtRef = useRef(0)

  const slides = deck?.slides ?? []
  const total = slides.length
  const playback = usePlayback({
    total,
    initialIndex: initialIndexRef.current,
    autoplayMs: autoPlayMs,
    loop,
    durationOf: (i) => slides[i]?.durationMs ?? autoPlayMs,
  })
  const currentSlide = total > 0 ? slides[Math.min(playback.index, total - 1)] : undefined

  /* ------------------------------ 外壳行为 ------------------------------ */

  const wake = useCallback(() => {
    setChrome(true)
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      setChrome(false)
    }, CHROME_IDLE_MS)
  }, [])

  useEffect(() => {
    wake()
    return () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
    }
  }, [wake])

  useEffect(() => {
    const id = window.setTimeout(() => setHintVisible(false), HINT_MS)
    return () => window.clearTimeout(id)
  }, [])

  const exit = useCallback(() => {
    if (currentSlide) setActiveSlide(currentSlide.id)
    setMode('edit')
  }, [currentSlide, setActiveSlide, setMode])

  const toggleFullscreen = useCallback(() => {
    const run = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen()
        else await rootRef.current?.requestFullscreen?.()
      } catch {
        // 全屏不可用（权限/环境）：留在页内播放即可，不打断。
      }
    }
    void run()
  }, [])

  // 进入播放先试着全屏；失败静默（headless / 无权限 / iframe 受限都很常见）。
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof el.requestFullscreen !== 'function') return
    if (!document.fullscreenEnabled || document.fullscreenElement) return
    el.requestFullscreen().catch(() => {})
  }, [])

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    onChange()
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      // 退出播放时把全屏还回去，别把编辑器留在全屏里。
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {})
      }
    }
  }, [])

  /* ------------------------------ 讲者视图 ------------------------------ */

  const presenter = usePresenterSync({
    deck,
    lang,
    index: playback.index,
    total,
    blackout: playback.blackout,
    autoplay: playback.autoplay,
    elapsedMs: playback.elapsedMs,
    onAction: (action, target) => {
      switch (action) {
        case 'next':
          playback.next()
          break
        case 'prev':
          playback.prev()
          break
        case 'blackout':
          playback.toggleBlackout()
          break
        case 'timer-reset':
          playback.resetTimer()
          break
        case 'go':
          if (typeof target === 'number') playback.go(target)
          break
      }
    },
  })

  const openPresenter = useCallback(() => {
    if (!presenter.open()) {
      pushToast({ kind: 'error', message: t('play.presenterBlocked') })
    }
  }, [presenter, pushToast, t])

  /* ------------------------------- 键盘 -------------------------------- */

  const handleKey = (event: KeyboardEvent): boolean => {
    // 让 ⌘/Ctrl/Alt 组合键留给外壳（⌘K、⌘Enter…）。
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    if (isTypingTarget(event.target)) return false

    const key = event.key
    const lower = key.toLowerCase()

    if (helpOpen) {
      if (key === 'Escape' || key === '?') {
        setHelpOpen(false)
        return true
      }
      return false
    }

    if (overviewOpen) {
      if (key === 'Escape' || lower === 'o') {
        setOverviewOpen(false)
        return true
      }
      if (key === 'ArrowRight' || key === 'PageDown' || key === ' ' || lower === 'n') {
        playback.next()
        return true
      }
      if (key === 'ArrowLeft' || key === 'PageUp' || lower === 'p') {
        playback.prev()
        return true
      }
      if (key === 'Home') {
        playback.first()
        return true
      }
      if (key === 'End') {
        playback.last()
        return true
      }
      return false
    }

    switch (key) {
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
      case 'Spacebar':
        playback.next()
        return true
      case 'ArrowLeft':
      case 'PageUp':
        playback.prev()
        return true
      case 'Home':
        playback.first()
        return true
      case 'End':
        playback.last()
        return true
      case 'Escape':
        exit()
        return true
      case '?':
        setHelpOpen(true)
        return true
      default:
        break
    }

    // n = 下一幕，Shift+N = 讲者视图（规范里 n/N 是两个功能）。
    if (key === 'N' || (lower === 'n' && event.shiftKey)) {
      openPresenter()
      return true
    }
    if (lower === 'n') {
      playback.next()
      return true
    }
    if (lower === 'p') {
      playback.prev()
      return true
    }
    if (lower === 'f') {
      toggleFullscreen()
      return true
    }
    if (lower === 'o') {
      setOverviewOpen(true)
      return true
    }
    if (lower === 'b') {
      playback.toggleBlackout()
      return true
    }
    if (lower === 't') {
      setTimerVisible((v) => !v)
      return true
    }
    if (lower === 'r') {
      playback.resetTimer()
      return true
    }
    return false
  }

  // 用捕获阶段 + stopPropagation：App 的全局 Esc（退出播放）不会与"Esc 先关浮层"打架。
  const keyHandlerRef = useRef(handleKey)
  keyHandlerRef.current = handleKey

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      let handled = false
      try {
        handled = keyHandlerRef.current(event)
      } catch {
        handled = false
      }
      if (!handled) return
      event.preventDefault()
      event.stopPropagation()
      wake()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [wake])

  /* ------------------------------ 指针交互 ------------------------------ */

  const isChrome = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null
    if (!el || typeof el.closest !== 'function') return false
    return Boolean(el.closest('[data-play-chrome="true"], .play-overview, .play-help'))
  }

  const isInteractiveBlock = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null
    if (!el || typeof el.closest !== 'function') return false
    return Boolean(
      el.closest('.lumen-html, .lumen-three[data-interactive="true"], a, button, input, textarea, select, [contenteditable="true"]'),
    )
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isChrome(event.target)) return
    swipeRef.current = { x: event.clientX, y: event.clientY, at: Date.now() }
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = swipeRef.current
    swipeRef.current = null
    if (!start || isChrome(event.target)) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    const elapsed = Date.now() - start.at
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.4 && elapsed < 900) {
      lastSwipeAtRef.current = Date.now()
      if (dx < 0) playback.next()
      else playback.prev()
    }
  }

  // 点左右半屏翻页：只在"非交互内容"上生效，避免点 HTML/3D 块时误触。
  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isChrome(event.target) || isInteractiveBlock(event.target)) return
    if (Date.now() - lastSwipeAtRef.current < 500) return
    if (playback.blackout) {
      playback.toggleBlackout()
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width)
    if (ratio < 0.35) playback.prev()
    else if (ratio > 0.65) playback.next()
  }

  /* -------------------------------- 渲染 -------------------------------- */

  const hintShown = hintVisible && !playback.blackout && !overviewOpen && !helpOpen
  const controlsVisible = chrome && !overviewOpen && !helpOpen

  if (total === 0) {
    return (
      <div className="play-root" data-chrome="visible">
        <div className="play-empty">
          <p>{t('play.noSlides')}</p>
          <button type="button" className="play-btn play-btn--exit" onClick={exit} aria-label={t('play.exit')}>
            {t('play.exit')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className="play-root"
      data-chrome={chrome && !overviewOpen && !helpOpen ? 'visible' : 'hidden'}
      data-blackout={playback.blackout ? 'true' : 'false'}
      onPointerMove={wake}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onClick={onClick}
    >
      <PlaySurface
        deck={deck}
        index={playback.index}
        playing={!playback.blackout}
        className="play-root__surface"
      />

      {playback.blackout ? (
        <div className="play-blackout" data-play-chrome="true">
          <span className="play-blackout__badge">
            <kbd>B</kbd>
            <span>{t('play.blackoutExit')}</span>
          </span>
        </div>
      ) : null}

      {overviewOpen ? (
        <Overview
          deck={deck}
          index={playback.index}
          onJump={(i) => playback.go(i)}
          onClose={() => setOverviewOpen(false)}
        />
      ) : null}

      {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} /> : null}

      {hintShown ? <div className="play-hint">{t('play.hint')}</div> : null}

      <PlayerControls
        index={playback.index}
        total={total}
        elapsedMs={playback.elapsedMs}
        timerVisible={timerVisible}
        autoplay={playback.autoplay}
        loop={loop}
        fullscreen={fullscreen}
        presenterOpen={presenter.isOpen}
        visible={controlsVisible}
        onPrev={playback.prev}
        onNext={playback.next}
        onJump={(i) => playback.go(i)}
        onToggleTimer={() => setTimerVisible((v) => !v)}
        onToggleAutoplay={() => playback.toggleAutoplay()}
        onToggleLoop={() => setLoop((v) => !v)}
        onToggleOverview={() => setOverviewOpen(true)}
        onTogglePresenter={openPresenter}
        onToggleFullscreen={toggleFullscreen}
        onExit={exit}
      />
    </div>
  )
}
