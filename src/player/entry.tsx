/**
 * entry.tsx —— 独立 HTML 播放器内核（vite.player.config.ts 的构建目标）。
 *
 * 产物 `public/player/lumen-player.js`（IIFE，全局名 `LumenPlayer`）由
 * `src/export/standalone.ts` 内联进单文件 HTML。运行环境是 `file://`：
 * 不许 service worker、不许 fetch 相对资源、零外部请求。
 *
 * 对外契约：
 *   window.LumenPlayer.mount(element, deck, { startAt?, assets?, print?, title? })
 *   window.LumenPlayer.unmount()
 *
 * - 画面必须走 `PlaySurface`（自适应缩放、转场都在那里，禁止自己再实现一遍）；
 * - 3D/动效只在当前幕运行（由 PlaySurface → SlideRenderer 的 active 链路保证）；
 * - 键盘：← → Space PageDown/PageUp Home End F O B T ? Esc；
 * - `?print=1` / `#print`：逐幕堆叠 + 自动 `window.print()`，3D 幕先抓帧成 `<img>`。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { deckSchema, type Deck } from '@/schema/deck'
import { PlaySurface } from '@/play/PlaySurface'
import { SlideRenderer } from '@/render/SlideRenderer'
import { installPlayerAssets } from '@/export/playerAssetBridge'
import { PrintLayer, PrintPages } from '@/export/PrintPages'
import { ensurePrintCss, isPrintRequested, startPrint, waitForPrintReady } from '@/export/printRoute'
import { prepareDeckForPrint } from '@/export/threeFrames'
import '@/styles/tokens.css'
import '@/styles/base.css'

/* -------------------------------- 文案（双语内嵌） ------------------------------- */

interface PlayerStrings {
  loading: string
  empty: string
  overview: string
  help: string
  blackout: string
  notes: string
  noNotes: string
  prev: string
  next: string
  fullscreen: string
  close: string
  printPreparing: string
  printNow: string
  shortcuts: Array<[string, string]>
}

const ZH: PlayerStrings = {
  loading: '正在载入演示…',
  empty: '这份演示没有内容',
  overview: '总览',
  help: '快捷键',
  blackout: '黑屏',
  notes: '讲者备注',
  noNotes: '这一幕没有备注',
  prev: '上一幕',
  next: '下一幕',
  fullscreen: '全屏',
  close: '关闭',
  printPreparing: '正在准备打印视图…',
  printNow: '打印 / 另存为 PDF',
  shortcuts: [
    ['← / →', '上一幕 / 下一幕'],
    ['Space / PageDown', '下一幕'],
    ['Home / End', '第一幕 / 最后一幕'],
    ['F', '进入或退出全屏'],
    ['O', '总览'],
    ['B', '黑屏'],
    ['T', '讲者备注'],
    ['?', '这一页'],
    ['Esc', '关闭浮层'],
  ],
}

const EN: PlayerStrings = {
  loading: 'Loading presentation…',
  empty: 'This deck has no slides',
  overview: 'Overview',
  help: 'Shortcuts',
  blackout: 'Blackout',
  notes: 'Speaker notes',
  noNotes: 'No notes on this slide',
  prev: 'Previous',
  next: 'Next',
  fullscreen: 'Fullscreen',
  close: 'Close',
  printPreparing: 'Preparing the print view…',
  printNow: 'Print / Save as PDF',
  shortcuts: [
    ['← / →', 'Previous / next slide'],
    ['Space / PageDown', 'Next slide'],
    ['Home / End', 'First / last slide'],
    ['F', 'Toggle fullscreen'],
    ['O', 'Overview'],
    ['B', 'Blackout'],
    ['T', 'Speaker notes'],
    ['?', 'This help'],
    ['Esc', 'Close overlay'],
  ],
}

function stringsOf(deck: Deck): PlayerStrings {
  return deck.lang === 'en' ? EN : ZH
}

/* --------------------------------- 播放器样式 -------------------------------- */

const PLAYER_CSS = `
.lp-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: #05060a;
  color: #fff;
  font-family: var(--d-font-body, var(--ui-font, system-ui, sans-serif));
  -webkit-font-smoothing: antialiased;
}
.lp-stage { position: absolute; inset: 0; cursor: default; }
.lp-root[data-blackout='true'] .lp-stage { visibility: hidden; }
.lp-blackout { position: absolute; inset: 0; background: #000; }
.lp-chrome {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  padding-bottom: 8px;
  opacity: 1;
  transition: opacity 240ms var(--d-ease, ease);
}
.lp-root[data-chrome='hidden'] .lp-chrome { opacity: 0; pointer-events: none; }
.lp-progress {
  position: relative;
  height: 4px;
  background: rgba(255, 255, 255, 0.14);
  cursor: pointer;
}
.lp-progress::before {
  content: '';
  position: absolute; inset: -6px 0 -6px;
}
.lp-progress__fill {
  height: 100%;
  background: linear-gradient(90deg, var(--d-accent, #c8a15a), var(--d-accent2, #7ea0b8));
  transition: width 240ms var(--d-ease, ease);
}
.lp-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px 0;
  font-size: 12px;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.62);
}
.lp-title { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-spacer { flex: 1 1 auto; }
.lp-count {
  font-family: var(--d-font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}
.lp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.lp-btn:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
.lp-btn[aria-pressed='true'] { border-color: var(--d-accent, #c8a15a); color: #fff; }
.lp-notes {
  position: absolute;
  left: 18px;
  bottom: 60px;
  max-width: 560px;
  max-height: 40vh;
  overflow: auto;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(8, 9, 13, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.82);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.lp-notes strong { display: block; margin-bottom: 6px; color: var(--d-accent, #c8a15a); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; }
.lp-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  background: rgba(5, 6, 10, 0.94);
  overflow: auto;
  padding: 28px 30px 40px;
}
.lp-overlay__head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 18px; color: rgba(255,255,255,.7); font-size: 12px; letter-spacing: .1em; text-transform: uppercase; }
.lp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 18px;
  align-content: start;
}
.lp-thumb {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.72);
}
.lp-thumb__frame {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #0a0b10;
}
.lp-thumb[data-active='true'] .lp-thumb__frame { border-color: var(--d-accent, #c8a15a); box-shadow: 0 0 0 2px color-mix(in srgb, var(--d-accent, #c8a15a) 40%, transparent); }
.lp-thumb__fit { position: absolute; display: block; top: 0; left: 0; width: 1600px; height: 900px; transform-origin: top left; }
.lp-thumb__label { display: block; margin-top: 7px; font-size: 12px; font-family: var(--d-font-mono, ui-monospace, monospace); }
.lp-help {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(5, 6, 10, 0.9);
}
.lp-help__card {
  min-width: 320px;
  max-width: 460px;
  padding: 20px 22px;
  border-radius: 12px;
  background: #101219;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.82);
  font-size: 13px;
}
.lp-help__card h2 { margin: 0 0 14px; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--d-accent, #c8a15a); }
.lp-help__row { display: flex; gap: 14px; padding: 4px 0; }
.lp-help__key { flex: 0 0 132px; color: #fff; font-family: var(--d-font-mono, ui-monospace, monospace); font-size: 12px; }
.lp-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,.5); font-size: 13px; }
`

let playerCssInjected = false

/** 播放器 UI 样式内联注入（独立文件里没有构建产物可依赖）。 */
export function ensurePlayerCss(doc: Document = document): void {
  if (playerCssInjected || doc.getElementById('lumen-player-ui-css')) return
  const style = doc.createElement('style')
  style.id = 'lumen-player-ui-css'
  style.textContent = PLAYER_CSS
  doc.head.appendChild(style)
  playerCssInjected = true
}

/* ---------------------------------- 工具 ---------------------------------- */

function parseDeck(input: unknown): Deck | null {
  const result = deckSchema.safeParse(input)
  if (!result.success) {
    console.error('[lumen-player] invalid deck', result.error.issues.slice(0, 5))
    return null
  }
  return result.data as Deck
}

function clampIndex(value: number, total: number): number {
  if (total <= 0) return 0
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(total - 1, Math.trunc(value)))
}

function isTypingTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null
  if (!node) return false
  const tag = node.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true
}

/* -------------------------------- 播放器主体 ------------------------------- */

interface PlayerProps {
  deck: Deck
  startAt: number
}

function LumenPlayer({ deck, startAt }: PlayerProps): JSX.Element {
  const strings = useMemo(() => stringsOf(deck), [deck])
  const total = deck.slides.length
  const [index, setIndex] = useState(() => clampIndex(startAt, total))
  const [blackout, setBlackout] = useState(false)
  const [overlay, setOverlay] = useState<'overview' | 'help' | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const [chromeVisible, setChromeVisible] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const hideTimer = useRef<number | null>(null)

  const slide = total > 0 ? deck.slides[clampIndex(index, total)] : undefined
  const playing = !blackout && overlay === null

  const goTo = useCallback(
    (next: number) => {
      setIndex(clampIndex(next, total))
    },
    [total],
  )
  const goNext = useCallback(() => setIndex((i) => clampIndex(i + 1, total)), [total])
  const goPrev = useCallback(() => setIndex((i) => clampIndex(i - 1, total)), [total])

  /* 全屏状态跟随浏览器（用户按 Esc 退出时按钮状态也要跟着变） */
  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', sync)
    sync()
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {})
      return
    }
    void document.documentElement.requestFullscreen?.().catch(() => {})
  }, [])

  /* 键盘（file:// 下同样工作，不依赖任何宿主） */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      const key = event.key
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey

      if (key === 'ArrowRight' || key === 'PageDown' || (plain && key === ' ')) {
        event.preventDefault()
        if (overlay) closeOverlay()
        goNext()
        return
      }
      if (key === 'ArrowLeft' || key === 'PageUp') {
        event.preventDefault()
        if (overlay) closeOverlay()
        goPrev()
        return
      }
      if (key === 'Home') {
        event.preventDefault()
        goTo(0)
        return
      }
      if (key === 'End') {
        event.preventDefault()
        goTo(total - 1)
        return
      }
      if (key === '?' || (event.shiftKey && key === '/')) {
        event.preventDefault()
        setOverlay((current) => (current === 'help' ? null : 'help'))
        return
      }
      if (key === 'Escape') {
        if (overlay) {
          event.preventDefault()
          closeOverlay()
          return
        }
        if (notesOpen) {
          setNotesOpen(false)
          return
        }
        if (blackout) {
          setBlackout(false)
          return
        }
        if (document.fullscreenElement) return // 交给浏览器退出全屏
        return
      }
      if (!plain) return
      const lower = key.toLowerCase()
      if (lower === 'f') {
        event.preventDefault()
        toggleFullscreen()
      } else if (lower === 'o') {
        event.preventDefault()
        setOverlay((current) => (current === 'overview' ? null : 'overview'))
      } else if (lower === 'b') {
        event.preventDefault()
        setBlackout((v) => !v)
      } else if (lower === 't') {
        event.preventDefault()
        setNotesOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // closeOverlay 用函数声明在下方，闭包捕获的是同一个引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goNext, goPrev, goTo, overlay, notesOpen, blackout, total, toggleFullscreen])

  function closeOverlay(): void {
    setOverlay(null)
  }

  /* 鼠标静止 2.6s 后收起播放控件（全屏演示时不挡画面） */
  useEffect(() => {
    const arm = () => {
      setChromeVisible(true)
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
      hideTimer.current = window.setTimeout(() => setChromeVisible(false), 2600)
    }
    arm()
    window.addEventListener('mousemove', arm)
    window.addEventListener('touchstart', arm, { passive: true })
    return () => {
      window.removeEventListener('mousemove', arm)
      window.removeEventListener('touchstart', arm)
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    }
  }, [])

  const progress = total > 0 ? ((index + 1) / total) * 100 : 0
  const thumbScale = 280 / 1600

  const jumpByPointer = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    goTo(Math.round(ratio * total) - 1)
  }

  if (total === 0 || !slide) {
    return (
      <div className="lp-root">
        <div className="lp-empty">{strings.empty}</div>
      </div>
    )
  }

  return (
    <div
      className="lp-root"
      data-blackout={blackout ? 'true' : 'false'}
      data-chrome={chromeVisible ? 'shown' : 'hidden'}
      data-slide-index={index}
    >
      <div className="lp-stage" onClick={goNext} role="presentation">
        <PlaySurface deck={deck} index={index} playing={playing} />
      </div>
      {blackout ? <div className="lp-blackout" aria-hidden="true" /> : null}

      {notesOpen ? (
        <div className="lp-notes" data-notes="1">
          <strong>{strings.notes}</strong>
          {deck.slides[index]?.notes?.trim() ? deck.slides[index].notes : strings.noNotes}
        </div>
      ) : null}

      <div className="lp-chrome">
        <div
          className="lp-progress"
          role="slider"
          aria-label="progress"
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={index + 1}
          tabIndex={-1}
          onClick={jumpByPointer}
        >
          <div className="lp-progress__fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="lp-row">
          <span className="lp-title">{deck.title}</span>
          <span className="lp-spacer" />
          <span className="lp-count" data-player-counter="1">
            {index + 1} / {total}
          </span>
          <button type="button" className="lp-btn" title={strings.prev} onClick={goPrev}>
            ‹
          </button>
          <button type="button" className="lp-btn" title={strings.next} onClick={goNext}>
            ›
          </button>
          <button
            type="button"
            className="lp-btn"
            aria-pressed={overlay === 'overview'}
            title={strings.overview}
            onClick={() => setOverlay((current) => (current === 'overview' ? null : 'overview'))}
          >
            O
          </button>
          <button
            type="button"
            className="lp-btn"
            aria-pressed={blackout}
            title={strings.blackout}
            onClick={() => setBlackout((v) => !v)}
          >
            B
          </button>
          <button
            type="button"
            className="lp-btn"
            aria-pressed={notesOpen}
            title={strings.notes}
            onClick={() => setNotesOpen((v) => !v)}
          >
            T
          </button>
          <button
            type="button"
            className="lp-btn"
            aria-pressed={fullscreen}
            title={strings.fullscreen}
            onClick={toggleFullscreen}
          >
            ⛶
          </button>
          <button
            type="button"
            className="lp-btn"
            aria-pressed={overlay === 'help'}
            title={strings.help}
            onClick={() => setOverlay((current) => (current === 'help' ? null : 'help'))}
          >
            ?
          </button>
        </div>
      </div>

      {overlay === 'overview' ? (
        <div className="lp-overlay" role="dialog" aria-label={strings.overview}>
          <div className="lp-overlay__head">
            <span>{strings.overview}</span>
            <span className="lp-spacer" />
            <button type="button" className="lp-btn" onClick={closeOverlay}>
              {strings.close}
            </button>
          </div>
          <div className="lp-grid">
            {deck.slides.map((item, i) => (
              <button
                type="button"
                key={item.id}
                className="lp-thumb"
                data-active={i === index ? 'true' : 'false'}
                onClick={() => {
                  goTo(i)
                  closeOverlay()
                }}
              >
                <span className="lp-thumb__frame">
                  <span className="lp-thumb__fit" style={{ transform: `scale(${thumbScale})` }}>
                    <SlideRenderer deck={deck} slide={item} mode="thumb" active={false} />
                  </span>
                </span>
                <span className="lp-thumb__label">
                  {i + 1}. {item.name ?? `#${i + 1}`}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {overlay === 'help' ? (
        <div className="lp-help" role="dialog" aria-label={strings.help} onClick={closeOverlay}>
          <div className="lp-help__card" onClick={(event) => event.stopPropagation()}>
            <h2>{strings.help}</h2>
            {strings.shortcuts.map(([keys, label]) => (
              <div className="lp-help__row" key={keys}>
                <span className="lp-help__key">{keys}</span>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------- 打印模式（?print=1） ------------------------------ */

function StandalonePrint({ deck }: { deck: Deck }): JSX.Element {
  const strings = stringsOf(deck)
  const [prepared, setPrepared] = useState<Deck | null>(null)

  useEffect(() => {
    ensurePrintCss()
    let alive = true
    void (async () => {
      try {
        const result = await prepareDeckForPrint(deck)
        if (alive) setPrepared(result.deck)
      } catch (error) {
        console.error('[lumen-player] 打印准备失败', error)
        if (alive) setPrepared(deck)
      }
    })()
    return () => {
      alive = false
    }
  }, [deck])

  useEffect(() => {
    if (!prepared) return
    let alive = true
    document.documentElement.classList.add('lumen-printing')
    void (async () => {
      await waitForPrintReady()
      if (!alive) return
      startPrint()
    })()
    return () => {
      alive = false
    }
  }, [prepared])

  if (!prepared) {
    return (
      <div className="lumen-print__state" data-print-state="preparing">
        {strings.printPreparing}
      </div>
    )
  }

  return (
    <>
      <PrintLayer>
        <div className="lumen-print__bar" data-print-state="ready">
          <strong>{deck.title}</strong>
          <span>{prepared.slides.length}</span>
          <button type="button" onClick={() => void startPrint()}>
            {strings.printNow}
          </button>
        </div>
        <PrintPages deck={prepared} />
      </PrintLayer>
    </>
  )
}

/* --------------------------------- 挂载接口 -------------------------------- */

export interface PlayerMountOptions {
  /** 起始幕下标。 */
  startAt?: number
  /** assetId → dataURL 内联素材表（来自单文件 HTML 的 #lumen-assets）。 */
  assets?: Record<string, string>
  /** 强制打印模式（缺省按 `?print=1` / `#print` 自动判断）。 */
  print?: boolean
  /** 文档标题。 */
  title?: string
}

interface Mounted {
  root: Root
  element: HTMLElement
}

let mounted: Mounted | null = null

/** 版本号（导出物里方便排查用的是哪一版内核）。 */
export const PLAYER_VERSION = '1.0.0'

/**
 * 挂载播放器。返回 false 表示 deck 结构不合法（已把原因写进控制台）。
 */
export function mount(element: HTMLElement, rawDeck: unknown, options: PlayerMountOptions = {}): boolean {
  const deck = parseDeck(rawDeck)
  if (!deck) {
    element.textContent = 'LUMEN: invalid deck data'
    return false
  }
  installPlayerAssets(options.assets)
  ensurePlayerCss()
  ensurePrintCss()

  unmount()

  const printMode = options.print ?? isPrintRequested()
  if (printMode) document.documentElement.classList.add('lumen-printing')

  const root = createRoot(element)
  root.render(printMode ? <StandalonePrint deck={deck} /> : <LumenPlayer deck={deck} startAt={options.startAt ?? 0} />)
  mounted = { root, element }

  if (options.title) document.title = options.title
  else if (deck.title) document.title = deck.title
  return true
}

/** 卸载播放器（重复调用安全）。 */
export function unmount(): void {
  if (!mounted) return
  const current = mounted
  mounted = null
  try {
    current.root.unmount()
  } catch (error) {
    console.warn('[lumen-player] unmount failed', error)
  }
}
