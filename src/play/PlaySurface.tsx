/**
 * PlaySurface.tsx —— 播放面：当前幕 + 转场 + 自适应缩放。
 *
 * 对外契约（exporter 依赖，字段语义不要变）：
 * - `deck` / `index` 决定播哪一幕；
 * - `playing` 决定是否处于"在台上"：false 时 3D 停转、转场瞬时；
 * - 自身可放进任意尺寸容器：内部按 `min(w/1600, h/900)` 居中等比缩放。
 *
 * 转场实现：双层缓冲（离场层 + 入场层），CSS class + `data-phase` 驱动，
 * 时长归一化到 200–800ms（2000ms 的极端值按 800ms 执行，避免节奏拖沓），
 * 到点后卸载离场层。`prefers-reduced-motion` 时统一退化为 120ms 淡入。
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react'
import type { Deck, TransitionKind } from '@/schema/deck'
import { STAGE_H, STAGE_W } from '@/schema/deck'
import { SlideLayer } from './SlideLayer'
import { clampIndex, directionBetween, type PlayDirection } from './playbackCore'
import { useReducedMotion } from './useReducedMotion'
import './transitions.css'

/** 转场时长下界：再快就只剩闪烁。 */
export const TRANSITION_MIN_MS = 200
/** 转场时长上界：幕上写 2000ms 也按 800ms 播。 */
export const TRANSITION_MAX_MS = 800
/** 减少动效时的淡入时长。 */
export const REDUCED_MOTION_MS = 120

export interface PlaySurfaceProps {
  deck: Deck
  index: number
  /** 是否在播放态（决定转场/入场动效/3D 是否运行） */
  playing?: boolean
  className?: string
}

interface TransitionPlan {
  kind: TransitionKind
  ms: number
}

/** 幕的转场配置 → 实际执行的（类型, 时长）。 */
export function planTransition(
  slide: Deck['slides'][number] | undefined,
  reducedMotion: boolean,
): TransitionPlan {
  if (reducedMotion) return { kind: 'fade', ms: REDUCED_MOTION_MS }
  const rawKind = slide?.transition?.kind ?? 'fade'
  const rawMs = slide?.transition?.ms
  if (!Number.isFinite(rawMs ?? NaN)) return { kind: rawKind, ms: 420 }
  const value = Math.max(0, Math.min(2000, rawMs as number))
  if (value === 0 || rawKind === 'none') return { kind: rawKind, ms: 0 }
  return {
    kind: rawKind,
    ms: Math.max(TRANSITION_MIN_MS, Math.min(TRANSITION_MAX_MS, Math.round(value))),
  }
}

/** 观察容器尺寸，给出 `min(w/1600, h/900)` 的缩放比。 */
function useFitScale(): [React.RefObject<HTMLDivElement | null>, number] {
  const hostRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)

  useLayoutEffect(() => {
    const node = hostRef.current
    if (!node) return
    const apply = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return
      const next = Math.min(w / STAGE_W, h / STAGE_H)
      setScale((prev) => (Math.abs(prev - next) < 0.0005 ? prev : next))
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) apply(box.width, box.height)
    })
    observer.observe(node)
    apply(node.clientWidth, node.clientHeight)
    return () => observer.disconnect()
  }, [])

  return [hostRef, scale]
}

export function PlaySurface({ deck, index, playing = true, className }: PlaySurfaceProps): JSX.Element {
  const [hostRef, scale] = useFitScale()
  const reducedMotion = useReducedMotion()
  const total = deck.slides.length
  const safeIndex = total === 0 ? -1 : clampIndex(index, total)
  const slide = safeIndex >= 0 ? deck.slides[safeIndex] : undefined

  const { kind, ms } = planTransition(slide, reducedMotion)
  const animated = kind !== 'none' && ms > 0

  /** 正在离场的上一幕下标（null = 没有转场）。 */
  const [fromIndex, setFromIndex] = useState<number | null>(null)
  const [direction, setDirection] = useState<PlayDirection>('fwd')
  const lastIndexRef = useRef(safeIndex)

  // 索引变化要在绘制前完成"谁在离场"的记账，否则会闪一帧新幕。
  useLayoutEffect(() => {
    if (lastIndexRef.current === safeIndex) return
    const from = lastIndexRef.current
    lastIndexRef.current = safeIndex
    if (from < 0 || safeIndex < 0 || from === safeIndex) {
      setFromIndex(null)
      return
    }
    setDirection(directionBetween(from, safeIndex))
    setFromIndex(from)
  }, [safeIndex])

  // 转场结束（或本幕根本不转场）就卸掉离场层。
  useEffect(() => {
    if (fromIndex === null) return
    if (!animated) {
      setFromIndex(null)
      return
    }
    const id = window.setTimeout(() => setFromIndex(null), ms + 80)
    return () => window.clearTimeout(id)
  }, [fromIndex, animated, ms])

  // 快速连按翻页时，上一幕可能已被替换，这里再兜一层有效性检查。
  const outgoingIndex =
    fromIndex !== null && fromIndex !== safeIndex && fromIndex >= 0 && fromIndex < total
      ? fromIndex
      : null

  const stage = useMemo(() => {
    if (safeIndex < 0 || !slide) return null
    return (
      <div
        className="play-surface__stage"
        data-transition={kind}
        data-dir={direction}
        style={{ width: STAGE_W * scale, height: STAGE_H * scale }}
      >
        {outgoingIndex !== null && animated ? (
          <SlideLayer
            key={`out:${outgoingIndex}`}
            deck={deck}
            index={outgoingIndex}
            scale={scale}
            phase="out"
            transition={kind}
            direction={direction}
            durationMs={ms}
            // 离场幕立刻让出"在台上"资格：3D 停下来，动效不再重放。
            playing={false}
          />
        ) : null}
        <SlideLayer
          key={`in:${safeIndex}`}
          deck={deck}
          index={safeIndex}
          scale={scale}
          phase="in"
          transition={kind}
          direction={direction}
          durationMs={ms}
          playing={playing}
        />
      </div>
    )
  }, [deck, safeIndex, outgoingIndex, animated, scale, playing, direction, kind, ms, slide])

  return (
    <div
      ref={hostRef}
      className={className ? `play-surface ${className}` : 'play-surface'}
      data-playing={playing ? 'true' : 'false'}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      style={{ '--play-ms': `${ms}ms` } as CSSProperties}
    >
      {stage ?? <div className="play-surface__empty" aria-hidden="true" />}
    </div>
  )
}
