/**
 * StageOverlay.tsx —— 画布交互图层：网格、选择框、8 向手柄、旋转手柄、参考线、框选、角标。
 *
 * 除手柄外全部 `pointer-events: none`，命中测试只发生在 Stage 的 `.stage-surface` 上。
 * 所有尺寸用设计像素表达，再靠 `--px`（= 1/scale）压回恒定屏幕像素。
 */
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { Block, Slide } from '@/schema/deck'
import type { Rect } from '@/schema/geometry'
import { HANDLES, boundsOf, unionBounds, type Guide, type HandleId } from './geometry'
import type { StageGhost } from './useStageInteraction'
import { STAGE_H, STAGE_W } from '@/schema/deck'

export interface StageOverlayProps {
  slide: Slide
  scale: number
  selectedIds: string[]
  hoveredId: string | null
  editingId: string | null
  ghost: StageGhost
  showGrid: boolean
  showGuides: boolean
  onHandlePointerDown: (event: ReactPointerEvent<HTMLDivElement>, handle: HandleId | 'rotate') => void
}

function boxStyle(block: Block): CSSProperties {
  return {
    left: block.x,
    top: block.y,
    width: block.w,
    height: block.h,
    transform: block.rotation ? `rotate(${block.rotation}deg)` : undefined,
  }
}

function guideStyle(guide: Guide): CSSProperties {
  return guide.axis === 'x' ? { left: guide.pos } : { top: guide.pos }
}

export function StageOverlay({
  slide,
  scale,
  selectedIds,
  hoveredId,
  editingId,
  ghost,
  showGrid,
  showGuides,
  onHandlePointerDown,
}: StageOverlayProps) {
  const pxVars = { '--px': `${1 / Math.max(scale, 0.01)}px` } as unknown as CSSProperties
  const selected = slide.blocks.filter((block) => selectedIds.includes(block.id))
  const single = selected.length === 1 ? selected[0] : null
  // 单选：用块自身矩形 + CSS rotate（不能再叠一层外接框）；多选：用并集外接框
  const selectionBox = single
    ? ({ x: single.x, y: single.y, w: single.w, h: single.h } as Rect)
    : unionBounds(selected.map((block) => boundsOf(block)))
  const hovered =
    hoveredId && !selectedIds.includes(hoveredId) ? slide.blocks.find((block) => block.id === hoveredId) : null
  const handleVisible = selected.length > 0 && !editingId && selected.some((block) => !block.locked)

  return (
    <div className="stage-overlay" style={pxVars}>
      {showGrid ? (
        <>
          <div className="stage-grid" />
          <div className="stage-safe" />
        </>
      ) : null}

      {hovered ? <div className="stage-hover" style={boxStyle(hovered)} /> : null}

      {selected.length > 1
        ? selected.map((block) => <div key={block.id} className="stage-sel stage-sel--multi" style={boxStyle(block)} />)
        : null}

      {selectionBox ? (
        <div
          className={[
            'stage-box',
            single ? '' : 'stage-box--group',
            editingId ? 'stage-box--editing' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            left: selectionBox.x,
            top: selectionBox.y,
            width: selectionBox.w,
            height: selectionBox.h,
            transform: single && single.rotation ? `rotate(${single.rotation}deg)` : undefined,
          }}
        >
          {single && handleVisible ? (
            <div
              className="stage-rotate"
              role="button"
              tabIndex={-1}
              aria-label="rotate"
              onPointerDown={(event) => onHandlePointerDown(event, 'rotate')}
            >
              <span className="stage-rotate__dot" />
            </div>
          ) : null}
          {handleVisible
            ? HANDLES.map((handle) => (
                <div
                  key={handle.id}
                  className={`stage-handle stage-handle--${handle.id}`}
                  style={{ cursor: handle.cursor }}
                  role="button"
                  tabIndex={-1}
                  aria-label={handle.id}
                  onPointerDown={(event) => onHandlePointerDown(event, handle.id)}
                />
              ))
            : null}
        </div>
      ) : null}

      {showGuides
        ? ghost.guides.map((guide) => (
            <div
              key={`${guide.axis}-${guide.pos}`}
              className={`stage-guide stage-guide--${guide.axis}`}
              style={guideStyle(guide)}
            />
          ))
        : null}

      {ghost.marquee ? (
        <div
          className="stage-marquee"
          style={{
            left: ghost.marquee.x,
            top: ghost.marquee.y,
            width: ghost.marquee.w,
            height: ghost.marquee.h,
          }}
        />
      ) : null}

      {ghost.badge ? (
        <div className="stage-badge" style={{ left: ghost.badge.x, top: ghost.badge.y }}>
          {ghost.badge.label}
        </div>
      ) : null}

      <div className="stage-bounds" aria-hidden="true" />
    </div>
  )
}
