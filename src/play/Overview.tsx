/**
 * Overview.tsx —— 总览：九宫格缩略图，点哪去哪。
 *
 * 缩略图一律 `mode="thumb"`（不建 WebGL、不跑动效），并且 `pointer-events: none`，
 * 命中由外层的 button 负责，避免误触到幕内容。
 */
import { useEffect, useState, type JSX } from 'react'
import type { Deck } from '@/schema/deck'
import { STAGE_W } from '@/schema/deck'
import { SlideRenderer } from '@/render/SlideRenderer'
import { useT } from '@/i18n'

export interface OverviewProps {
  deck: Deck
  index: number
  onJump: (index: number) => void
  onClose: () => void
}

function useViewport(): { w: number; h: number } {
  const [size, setSize] = useState(() => ({
    w: typeof window === 'undefined' ? 1280 : window.innerWidth,
    h: typeof window === 'undefined' ? 800 : window.innerHeight,
  }))
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

export function Overview({ deck, index, onJump, onClose }: OverviewProps): JSX.Element {
  const t = useT()
  const viewport = useViewport()
  const total = deck.slides.length
  const cols = Math.min(3, Math.max(1, total))
  const rows = Math.max(1, Math.ceil(total / cols))
  const gap = 16
  const visibleRows = Math.min(3, rows)

  // 宽度、高度各算一个上限，取小的那个，保证一屏能看到 3×3。
  const byWidth = (Math.min(viewport.w - 112, 1560) - gap * (cols - 1)) / cols
  const byHeight = ((viewport.h - 190 - gap * (visibleRows - 1)) / visibleRows) * (16 / 9)
  const cellW = Math.max(160, Math.floor(Math.min(byWidth, byHeight)))
  const cellH = Math.round((cellW * 9) / 16)
  const scale = cellW / STAGE_W

  return (
    <div
      className="play-overview"
      data-play-chrome="true"
      role="dialog"
      aria-modal="true"
      aria-label={t('play.overview')}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="play-overview__inner">
        <header className="play-overview__head">
          <span className="play-overview__title">{t('play.overview')}</span>
          <span className="play-overview__count">
            {t('play.slideCounter', { current: total === 0 ? 0 : index + 1, total })}
          </span>
          <button type="button" className="play-btn" onClick={onClose} aria-label={t('play.exit')}>
            ×
          </button>
        </header>

        <div className="play-overview__grid" style={{ gridTemplateColumns: `repeat(${cols}, ${cellW}px)` }}>
          {deck.slides.map((slide, i) => (
            <button
              key={slide.id}
              type="button"
              className="play-overview__cell"
              data-current={i === index ? 'true' : 'false'}
              style={{ width: cellW }}
              onClick={() => {
                onJump(i)
                onClose()
              }}
              aria-label={t('play.jumpTo', { n: i + 1 })}
              aria-current={i === index ? 'true' : undefined}
            >
              <span className="play-overview__frame" style={{ width: cellW, height: cellH }}>
                <span
                  className="play-overview__fit"
                  style={{ width: STAGE_W, height: Math.round(STAGE_W * (9 / 16)), transform: `scale(${scale})` }}
                >
                  <SlideRenderer deck={deck} slide={slide} mode="thumb" />
                </span>
              </span>
              <span className="play-overview__cap">
                <span className="play-overview__no">{i + 1}</span>
                <span className="play-overview__name">{slide.name ?? ''}</span>
              </span>
            </button>
          ))}
        </div>

        <p className="play-overview__hint">{t('play.hint')}</p>
      </div>
    </div>
  )
}
