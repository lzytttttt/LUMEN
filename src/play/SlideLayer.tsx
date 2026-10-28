/**
 * SlideLayer.tsx —— 播放面里的一层（正在入场的当前幕 / 正在离场的上一幕）。
 *
 * 一个 layer = 外层（负责转场动画）+ 内层（把 1600×900 等比缩放到容器）。
 * 动画全部由 `data-phase` / `data-transition` / `data-dir` 驱动，见 transitions.css。
 */
import { memo, type CSSProperties } from 'react'
import type { Deck, TransitionKind } from '@/schema/deck'
import { STAGE_H, STAGE_W } from '@/schema/deck'
import { SlideRenderer } from '@/render/SlideRenderer'
import type { PlayDirection } from './playbackCore'

export interface SlideLayerProps {
  deck: Deck
  index: number
  scale: number
  /** in = 当前幕（进场），out = 上一幕（离场）。 */
  phase: 'in' | 'out'
  transition: TransitionKind
  direction: PlayDirection
  /** 该幕的转场时长（已按 200–800ms 归一）。 */
  durationMs: number
  /** 在台上才跑 3D / 入场动效。 */
  playing: boolean
}

export const SlideLayer = memo(function SlideLayer({
  deck,
  index,
  scale,
  phase,
  transition,
  direction,
  durationMs,
  playing,
}: SlideLayerProps) {
  const slide = deck.slides[index]
  if (!slide) return null

  return (
    <div
      className="play-layer"
      data-phase={phase}
      data-transition={transition}
      data-dir={direction}
      data-playing={playing ? 'true' : 'false'}
      style={{ '--play-ms': `${durationMs}ms` } as CSSProperties}
    >
      <div
        className="play-layer__fit"
        style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}
      >
        <SlideRenderer deck={deck} slide={slide} mode="play" active={playing} />
      </div>
    </div>
  )
})
