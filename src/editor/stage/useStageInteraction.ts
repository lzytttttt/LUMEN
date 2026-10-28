/**
 * useStageInteraction.ts —— 画布指针交互状态机。
 *
 * 设计要点：
 * - 指针移动只把最新事件写进 ref，**用 rAF 合帧**，一帧最多一次写库；
 * - 几何写入统一走 `blockOps.setGeometry(..., { coalesceKey: 'drag' })`，历史合并成一步；
 * - 移动/缩放只改被拖块的几何，参考线/角标/框选矩形是局部 state，不牵动整树；
 * - 任何中断（Esc、pointercancel、卸载、切选中）都走同一个 `finishDrag`，保证释放 capture、清理参考线。
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { RefObject } from 'react'
import type { Block } from '@/schema/deck'
import type { Rect } from '@/schema/geometry'
import { clampToStage, GRID, MIN_SIZE } from '@/schema/geometry'
import { blockOps, resolveSlide } from '@/state/ops'
import { useSelectionStore } from '@/state/selectionStore'
import { useUiStore } from '@/state/uiStore'
import { useStageToolStore } from './toolStore'
import {
  angleDeg,
  blockSnapLines,
  boundsOf,
  clampMoveDelta,
  handleDef,
  hitTestBoxes,
  marqueeBoxes,
  mergeLines,
  normalizeAngle,
  normalizeRect,
  resizeRect,
  roundTo,
  scaleBoxes,
  snapMove,
  snapResizeEdge,
  stageSnapLines,
  unionBounds,
  type AxisLines,
  type Guide,
  type HandleId,
  type Point,
} from './geometry'
import { insertRectAt, insertTextAt, startEditingBlock, stopEditingBlock } from '@/editor/interactions/commands'

const CLICK_SLOP_PX = 3

export interface StageGhost {
  guides: Guide[]
  marquee: Rect | null
  /** 拖拽角标：设计像素坐标 + 文案（W×H 或角度） */
  badge: { x: number; y: number; label: string } | null
  cursor: string
}

const EMPTY_GHOST: StageGhost = { guides: [], marquee: null, badge: null, cursor: 'default' }

export interface StageInteractionOptions {
  frameRef: RefObject<HTMLDivElement | null>
  getPan: () => Point
  setPan: (point: Point) => void
  isPanModifier: () => boolean
  onContextMenu?: (payload: { client: Point; block: Block | null }) => void
}

export interface StageInteraction {
  ghost: StageGhost
  onSurfacePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onSurfacePointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onSurfacePointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
  onSurfacePointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
  onSurfaceDoubleClick: (event: ReactPointerEvent<HTMLDivElement>) => void
  onSurfaceContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void
  onSurfacePointerLeave: () => void
  onHandlePointerDown: (event: ReactPointerEvent<HTMLDivElement>, handle: HandleId | 'rotate') => void
  /** 供快捷键 Esc 使用：取消当前拖拽并还原几何 */
  cancelDrag: () => void
  isDragging: () => boolean
}

interface FrameMetrics {
  left: number
  top: number
  scale: number
}

interface PointerSnapshot {
  clientX: number
  clientY: number
  shiftKey: boolean
  altKey: boolean
}

interface DragBase {
  pointerId: number
  captureEl: HTMLElement
  frame: FrameMetrics
  /** 舞台坐标起点 */
  start: Point
  /** 客户端坐标起点 */
  startClient: Point
  blocks: Block[]
  origin: Map<string, Rect>
  lines: AxisLines
  moved: boolean
}

interface MoveDrag extends DragBase {
  kind: 'move'
  bounds: Rect
}

interface ResizeDrag extends DragBase {
  kind: 'resize'
  handle: HandleId
  /** 单块时是块自身，多选时是并集外接框 */
  box: Rect
  rotation: number
  single: boolean
}

interface RotateDrag extends DragBase {
  kind: 'rotate'
  blockId: string
  center: Point
  startAngle: number
  startRotation: number
}

interface MarqueeDrag extends DragBase {
  kind: 'marquee'
  base: string[]
  additive: boolean
  lastKey: string
}

interface DrawDrag extends DragBase {
  kind: 'draw'
  tool: 'text' | 'rect'
  lastRect: Rect
}

interface PanDrag extends DragBase {
  kind: 'pan'
  startPan: Point
}

type Drag = MoveDrag | ResizeDrag | RotateDrag | MarqueeDrag | DrawDrag | PanDrag

function sameGuides(a: Guide[], b: Guide[]): boolean {
  if (a.length !== b.length) return false
  return a.every((guide, index) => guide.axis === b[index].axis && Math.abs(guide.pos - b[index].pos) < 0.01)
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

function sameGhost(a: StageGhost, b: StageGhost): boolean {
  return (
    a.cursor === b.cursor &&
    sameGuides(a.guides, b.guides) &&
    sameRect(a.marquee, b.marquee) &&
    a.badge?.label === b.badge?.label &&
    a.badge?.x === b.badge?.x &&
    a.badge?.y === b.badge?.y
  )
}

function badgeFor(rect: Rect): StageGhost['badge'] {
  return {
    x: rect.x + rect.w / 2,
    y: rect.y + rect.h,
    label: `${Math.round(rect.w)} × ${Math.round(rect.h)}`,
  }
}

function boxOf(block: Block): Rect {
  return { x: block.x, y: block.y, w: block.w, h: block.h }
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids))
}

export function useStageInteraction(options: StageInteractionOptions): StageInteraction {
  const optionsRef = useRef(options)
  optionsRef.current = options

  const [ghost, setGhost] = useState<StageGhost>(EMPTY_GHOST)
  const ghostRef = useRef<StageGhost>(EMPTY_GHOST)
  const dragRef = useRef<Drag | null>(null)
  const pendingRef = useRef<PointerSnapshot | null>(null)
  const rafRef = useRef(0)

  const applyGhost = useCallback((patch: Partial<StageGhost>) => {
    const next = { ...ghostRef.current, ...patch }
    if (sameGhost(next, ghostRef.current)) return
    ghostRef.current = next
    setGhost(next)
  }, [])

  const frameMetrics = useCallback((): FrameMetrics | null => {
    const node = optionsRef.current.frameRef.current
    if (!node) return null
    const rect = node.getBoundingClientRect()
    if (rect.width <= 0) return null
    return { left: rect.left, top: rect.top, scale: rect.width / 1600 }
  }, [])

  const toStage = useCallback((frame: FrameMetrics, clientX: number, clientY: number): Point => {
    return { x: (clientX - frame.left) / frame.scale, y: (clientY - frame.top) / frame.scale }
  }, [])

  const activeBlocks = useCallback((): Block[] => {
    const slide = resolveSlide()
    return slide ? slide.blocks : []
  }, [])

  /* ------------------------------ 拖拽落库 ------------------------------ */

  const applyMove = useCallback(
    (drag: MoveDrag, point: Point) => {
      const rawDx = point.x - drag.start.x
      const rawDy = point.y - drag.start.y
      if (!drag.moved && Math.hypot(rawDx, rawDy) * drag.frame.scale < CLICK_SLOP_PX) return
      drag.moved = true

      let dx = rawDx
      let dy = rawDy
      let guides: Guide[] = []
      if (useUiStore.getState().snapEnabled) {
        const moved = { x: drag.bounds.x + rawDx, y: drag.bounds.y + rawDy, w: drag.bounds.w, h: drag.bounds.h }
        const snapped = snapMove(moved, drag.lines, { threshold: 6, grid: GRID })
        dx += snapped.dx
        dy += snapped.dy
        guides = snapped.guides
      }
      const clamped = clampMoveDelta(
        drag.blocks.map((block) => drag.origin.get(block.id) ?? boxOf(block)),
        dx,
        dy,
      )

      const updates = drag.blocks.map((block) => {
        const origin = drag.origin.get(block.id) ?? boxOf(block)
        const rect = clampToStage({ x: origin.x + clamped.dx, y: origin.y + clamped.dy, w: origin.w, h: origin.h })
        return { id: block.id, ...rect }
      })
      blockOps.setGeometry(updates, { coalesceKey: 'drag' })

      const bounds = unionBounds(updates)
      applyGhost({ guides, badge: bounds ? badgeFor(bounds) : null, marquee: null })
    },
    [applyGhost],
  )

  const applyResize = useCallback(
    (drag: ResizeDrag, point: Point, pending: PointerSnapshot) => {
      const delta = { x: point.x - drag.start.x, y: point.y - drag.start.y }
      if (!drag.moved && Math.hypot(delta.x, delta.y) * drag.frame.scale < CLICK_SLOP_PX) return
      drag.moved = true

      const shift = pending.shiftKey
      const alt = pending.altKey
      const snapEnabled = useUiStore.getState().snapEnabled

      if (drag.single) {
        const next = resizeRect({ origin: drag.box, rotation: drag.rotation, handle: drag.handle, delta, shift, alt })
        let rect = next
        let guides: Guide[] = []
        if (snapEnabled && Math.abs(drag.rotation) < 0.01 && !alt) {
          const snap = snapResizeEdge(next, handleDef(drag.handle), drag.lines)
          if (snap.dw !== 0 || snap.dh !== 0 || snap.dx !== 0 || snap.dy !== 0) {
            rect = {
              x: next.x + snap.dx,
              y: next.y + snap.dy,
              w: Math.max(MIN_SIZE, next.w + snap.dw),
              h: Math.max(MIN_SIZE, next.h + snap.dh),
            }
            guides = snap.guides
          }
        }
        const clamped = clampToStage(rect)
        blockOps.setGeometry([{ id: drag.blocks[0].id, ...clamped }], { coalesceKey: 'drag' })
        applyGhost({ guides, badge: badgeFor(clamped), marquee: null })
        return
      }

      const nextBox = resizeRect({ origin: drag.box, rotation: 0, handle: drag.handle, delta, shift, alt })
      const scaled = scaleBoxes(
        drag.blocks.map((block) => drag.origin.get(block.id) ?? boxOf(block)),
        drag.box,
        nextBox,
      )
      const updates = scaled.map((rect, index) => {
        const clamped = clampToStage(rect)
        return { id: drag.blocks[index].id, ...clamped }
      })
      blockOps.setGeometry(updates, { coalesceKey: 'drag' })
      const bounds = unionBounds(updates)
      applyGhost({ guides: [], badge: bounds ? badgeFor(bounds) : null, marquee: null })
    },
    [applyGhost],
  )

  const applyRotate = useCallback(
    (drag: RotateDrag, point: Point, pending: PointerSnapshot) => {
      const current = angleDeg(drag.center, point)
      let rotation = drag.startRotation + (current - drag.startAngle)
      rotation = pending.shiftKey ? roundTo(rotation, 15) : roundTo(rotation, 0.5)
      rotation = normalizeAngle(rotation)
      if (!drag.moved && Math.abs(rotation - drag.startRotation) < 0.01) return
      drag.moved = true
      blockOps.update(
        drag.blockId,
        (block) => {
          block.rotation = rotation
        },
        { coalesceKey: 'rotate', label: 'rotate-block' },
      )
      const rect = drag.origin.get(drag.blockId) ?? boxOf(drag.blocks[0])
      const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
      applyGhost({
        guides: [],
        marquee: null,
        badge: { x: center.x, y: rect.y + rect.h / 2, label: `${Math.round(rotation)}°` },
      })
    },
    [applyGhost],
  )

  const applyMarquee = useCallback(
    (drag: MarqueeDrag, point: Point) => {
      const rect = normalizeRect(drag.start, point)
      if (!drag.moved && Math.hypot(rect.w, rect.h) * drag.frame.scale < CLICK_SLOP_PX) return
      drag.moved = true
      const slide = resolveSlide()
      const hits = slide ? marqueeBoxes(slide.blocks, rect, { includeLocked: false }) : []
      const next = drag.additive ? uniqueIds([...drag.base, ...hits.map((block) => block.id)]) : hits.map((block) => block.id)
      const key = next.join('|')
      if (key !== drag.lastKey) {
        drag.lastKey = key
        useSelectionStore.getState().setSelection(next)
      }
      applyGhost({ marquee: rect, guides: [], badge: null })
    },
    [applyGhost],
  )

  const applyDraw = useCallback(
    (drag: DrawDrag, point: Point) => {
      const rect = normalizeRect(drag.start, point)
      drag.lastRect = rect
      drag.moved = drag.moved || Math.hypot(rect.w, rect.h) * drag.frame.scale >= CLICK_SLOP_PX
      applyGhost({ marquee: rect, guides: [], badge: null })
    },
    [applyGhost],
  )

  const applyPan = useCallback((drag: PanDrag, pending: PointerSnapshot) => {
    drag.moved = true
    optionsRef.current.setPan({
      x: drag.startPan.x + (pending.clientX - drag.startClient.x),
      y: drag.startPan.y + (pending.clientY - drag.startClient.y),
    })
  }, [])

  const flush = useCallback(() => {
    rafRef.current = 0
    const drag = dragRef.current
    const pending = pendingRef.current
    if (!drag || !pending) return
    const point = toStage(drag.frame, pending.clientX, pending.clientY)
    switch (drag.kind) {
      case 'move':
        applyMove(drag, point)
        break
      case 'resize':
        applyResize(drag, point, pending)
        break
      case 'rotate':
        applyRotate(drag, point, pending)
        break
      case 'marquee':
        applyMarquee(drag, point)
        break
      case 'draw':
        applyDraw(drag, point)
        break
      case 'pan':
        applyPan(drag, pending)
        break
      default:
        break
    }
  }, [applyDraw, applyMarquee, applyMove, applyPan, applyResize, applyRotate, toStage])

  const scheduleFlush = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(flush)
  }, [flush])

  /** 收尾：释放 capture、清参考线、必要时落新块/清选择。 */
  const finishDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current
      dragRef.current = null
      pendingRef.current = null
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
      if (drag) {
        try {
          if (drag.captureEl.hasPointerCapture?.(drag.pointerId)) {
            drag.captureEl.releasePointerCapture(drag.pointerId)
          }
        } catch {
          /* 元素已卸载时忽略 */
        }
        if (drag.kind === 'marquee' && !drag.moved && !drag.additive) {
          useSelectionStore.getState().clearSelection()
        }
        if (drag.kind === 'draw' && commit) {
          const rect = drag.lastRect
          const tiny = rect.w * drag.frame.scale < 10 && rect.h * drag.frame.scale < 10
          const size = tiny ? undefined : { w: Math.round(rect.w), h: Math.round(rect.h) }
          const point = tiny ? drag.start : { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
          if (drag.tool === 'text') insertTextAt({ point, size })
          else insertRectAt({ point, size })
          useStageToolStore.getState().setTool('select')
        }
      }
      ghostRef.current = { ...EMPTY_GHOST }
      setGhost(ghostRef.current)
    },
    [],
  )

  /** 取消并还原几何（Esc / 右键中断）。 */
  const cancelDrag = useCallback(() => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.moved && (drag.kind === 'move' || drag.kind === 'resize' || drag.kind === 'rotate')) {
      if (drag.kind === 'move' || drag.kind === 'resize') {
        const updates = drag.blocks.map((block) => {
          const origin = drag.origin.get(block.id)
          return origin ? { id: block.id, ...origin } : null
        })
        blockOps.setGeometry(updates.filter((item): item is { id: string } & Rect => item !== null), {
          coalesceKey: 'drag',
        })
      } else {
        blockOps.update(
          drag.blockId,
          (block) => {
            block.rotation = drag.startRotation
          },
          { coalesceKey: 'rotate', label: 'rotate-block' },
        )
      }
    }
    finishDrag(false)
  }, [finishDrag])

  /* ------------------------------ 指针入口 ------------------------------ */

  const beginCapture = (event: ReactPointerEvent<HTMLElement>) => {
    const element = event.currentTarget
    try {
      element.setPointerCapture(event.pointerId)
    } catch {
      /* 某些触控环境不支持，忽略 */
    }
    return element
  }

  const onSurfacePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 && event.button !== 1) return
      const frame = frameMetrics()
      const slide = resolveSlide()
      if (!frame || !slide) return
      if (dragRef.current) finishDrag(true)

      const point = toStage(frame, event.clientX, event.clientY)
      const startClient = { x: event.clientX, y: event.clientY }
      const tool = useStageToolStore.getState().tool
      // 只有真的开始拖拽时才 setPointerCapture，早退分支不会留下孤立的 pointer capture
      const makeBase = (): Omit<DragBase, 'blocks' | 'origin' | 'lines'> => ({
        pointerId: event.pointerId,
        captureEl: beginCapture(event),
        frame,
        start: point,
        startClient,
        moved: false,
      })

      // 1) 平移：空格 / 中键
      if (event.button === 1 || optionsRef.current.isPanModifier()) {
        if (event.button === 1) event.preventDefault()
        dragRef.current = {
          ...makeBase(),
          kind: 'pan',
          blocks: [],
          origin: new Map(),
          lines: { x: [], y: [] },
          startPan: optionsRef.current.getPan(),
        }
        applyGhost({ cursor: 'grabbing' })
        return
      }

      // 2) 工具落块
      if (tool !== 'select') {
        dragRef.current = {
          ...makeBase(),
          kind: 'draw',
          tool,
          blocks: [],
          origin: new Map(),
          lines: { x: [], y: [] },
          lastRect: { x: point.x, y: point.y, w: 0, h: 0 },
        }
        applyGhost({ cursor: 'crosshair', marquee: { x: point.x, y: point.y, w: 0, h: 0 } })
        return
      }

      // 3) 命中测试（Alt 穿透锁定块）
      const hit = hitTestBoxes(slide.blocks, point, { includeLocked: event.altKey })
      const selection = useSelectionStore.getState()

      if (!hit) {
        dragRef.current = {
          ...makeBase(),
          kind: 'marquee',
          blocks: [],
          origin: new Map(),
          lines: { x: [], y: [] },
          base: event.shiftKey ? selection.selectedBlockIds : [],
          additive: event.shiftKey,
          lastKey: event.shiftKey ? selection.selectedBlockIds.join('|') : '',
        }
        applyGhost({ cursor: 'crosshair', marquee: { x: point.x, y: point.y, w: 0, h: 0 } })
        return
      }

      let nextSelection: string[]
      if (event.shiftKey) {
        nextSelection = selection.selectedBlockIds.includes(hit.id)
          ? selection.selectedBlockIds.filter((id) => id !== hit.id)
          : [...selection.selectedBlockIds, hit.id]
      } else if (selection.selectedBlockIds.includes(hit.id)) {
        nextSelection = selection.selectedBlockIds
      } else {
        nextSelection = [hit.id]
      }
      if (nextSelection.join('|') !== selection.selectedBlockIds.join('|')) {
        selection.setSelection(nextSelection)
      }
      if (nextSelection.length === 0) return

      const ids = new Set(nextSelection)
      // 锁定块可以选中（Alt 穿透，交给检查器改属性），但不参与拖动
      const blocks = slide.blocks.filter((block) => ids.has(block.id) && !block.hidden && !block.locked)
      if (blocks.length === 0) return
      const origin = new Map(blocks.map((block) => [block.id, boxOf(block)]))
      const bounds =
        unionBounds(blocks.map((block) => boundsOf(block))) ?? unionBounds(blocks.map(boxOf)) ?? boxOf(blocks[0])
      const lines = mergeLines(stageSnapLines(), blockSnapLines(slide.blocks, ids))
      dragRef.current = { ...makeBase(), kind: 'move', blocks, origin, lines, bounds }
      applyGhost({ cursor: 'move', guides: [], badge: badgeFor(bounds) })
    },
    [applyGhost, finishDrag, frameMetrics, toStage],
  )

  const onSurfacePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 拖拽期间由 window 级监听接管（手柄捕获指针后事件不会再冒到这里）
      if (dragRef.current) return
      // 悬停反馈：只在高亮目标变化时写状态
      const frame = frameMetrics()
      if (!frame) return
      const point = toStage(frame, event.clientX, event.clientY)
      const hit = hitTestBoxes(activeBlocks(), point)
      const hovered = useSelectionStore.getState().hoveredBlockId
      if ((hit?.id ?? null) !== hovered) useSelectionStore.getState().setHovered(hit?.id ?? null)
      const tool = useStageToolStore.getState().tool
      const cursor =
        tool !== 'select'
          ? 'crosshair'
          : optionsRef.current.isPanModifier()
            ? 'grab'
            : hit
              ? 'move'
              : 'default'
      if (cursor !== ghostRef.current.cursor) applyGhost({ cursor })
    },
    [activeBlocks, applyGhost, frameMetrics, toStage],
  )

  const onSurfacePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      pendingRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      }
      // 先把最后一帧落下，再收尾
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
      flush()
      finishDrag(true)
    },
    [finishDrag, flush],
  )

  const onSurfacePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      finishDrag(false)
    },
    [finishDrag],
  )

  const onSurfaceDoubleClick = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const frame = frameMetrics()
      const slide = resolveSlide()
      if (!frame || !slide) return
      const point = toStage(frame, event.clientX, event.clientY)
      const hit = hitTestBoxes(slide.blocks, point, { includeLocked: false })
      if (hit && hit.type === 'text') {
        startEditingBlock(hit.id, { point })
        return
      }
      // 双击空白：退出编辑 + 清空选择
      stopEditingBlock()
      useSelectionStore.getState().clearSelection()
      useSelectionStore.getState().setHovered(null)
    },
    [frameMetrics, toStage],
  )

  const onSurfaceContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      const frame = frameMetrics()
      const slide = resolveSlide()
      if (!frame || !slide) return
      if (dragRef.current) finishDrag(true)
      const point = toStage(frame, event.clientX, event.clientY)
      const hit = hitTestBoxes(slide.blocks, point, { includeLocked: true })
      if (hit) {
        const selected = useSelectionStore.getState().selectedBlockIds
        if (!selected.includes(hit.id)) useSelectionStore.getState().setSelection([hit.id])
      }
      optionsRef.current.onContextMenu?.({ client: { x: event.clientX, y: event.clientY }, block: hit })
    },
    [finishDrag, frameMetrics, toStage],
  )

  const onSurfacePointerLeave = useCallback(() => {
    if (dragRef.current) return
    if (useSelectionStore.getState().hoveredBlockId !== null) useSelectionStore.getState().setHovered(null)
  }, [])

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, handle: HandleId | 'rotate') => {
      if (event.button !== 0) return
      event.stopPropagation()
      if (dragRef.current) finishDrag(true)
      const frame = frameMetrics()
      const slide = resolveSlide()
      if (!frame || !slide) return
      const selected = useSelectionStore.getState().selectedBlockIds
      if (selected.length === 0) return
      const ids = new Set(selected)
      const blocks = slide.blocks.filter((block) => ids.has(block.id) && !block.locked && !block.hidden)
      if (blocks.length === 0) return

      const point = toStage(frame, event.clientX, event.clientY)
      const origin = new Map(blocks.map((block) => [block.id, boxOf(block)]))
      const single = blocks.length === 1
      // 旋转手柄只支持单选；先判再抓指针，避免抓了不放
      if (handle === 'rotate' && !single) return
      const union = unionBounds(blocks.map((block) => boundsOf(block))) ?? boxOf(blocks[0])
      const lines = mergeLines(stageSnapLines(), blockSnapLines(slide.blocks, ids))
      const base: Omit<DragBase, 'blocks' | 'origin' | 'lines'> = {
        pointerId: event.pointerId,
        captureEl: beginCapture(event),
        frame,
        start: point,
        startClient: { x: event.clientX, y: event.clientY },
        moved: false,
      }

      if (handle === 'rotate') {
        const block = blocks[0]
        const center = { x: block.x + block.w / 2, y: block.y + block.h / 2 }
        dragRef.current = {
          ...base,
          kind: 'rotate',
          blocks,
          origin,
          lines,
          blockId: block.id,
          center,
          startAngle: angleDeg(center, point),
          startRotation: block.rotation ?? 0,
        }
        applyGhost({ cursor: 'grabbing', guides: [], badge: null })
        return
      }

      dragRef.current = {
        ...base,
        kind: 'resize',
        blocks,
        origin,
        lines,
        handle,
        box: single ? boxOf(blocks[0]) : union,
        rotation: single ? (blocks[0].rotation ?? 0) : 0,
        single,
      }
      applyGhost({ cursor: handleDef(handle).cursor, guides: [], badge: badgeFor(union) })
    },
    [applyGhost, finishDrag, frameMetrics, toStage],
  )

  /* -------------------------- 中断与生命周期 -------------------------- */

  /**
   * 拖拽期的 move/up 走 window 级监听：
   * 手柄上 `setPointerCapture` 之后事件目标变成手柄自身，不会冒泡回 `.stage-surface`，
   * 用 window 监听才能让"从手柄开始的缩放/旋转"和"从画布空白开始的框选"共用一条管线。
   */
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      pendingRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      }
      scheduleFlush()
    }
    const onUp = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      pendingRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
      flush()
      finishDrag(true)
    }
    const onCancel = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      finishDrag(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [finishDrag, flush, scheduleFlush])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (!dragRef.current) return
      event.preventDefault()
      event.stopPropagation()
      cancelDrag()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [cancelDrag])

  useEffect(() => {
    return () => {
      const drag = dragRef.current
      dragRef.current = null
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (drag) {
        try {
          if (drag.captureEl.hasPointerCapture?.(drag.pointerId)) {
            drag.captureEl.releasePointerCapture(drag.pointerId)
          }
        } catch {
          /* 忽略 */
        }
      }
    }
  }, [])

  const isDragging = useCallback(() => dragRef.current !== null, [])

  return {
    ghost,
    onSurfacePointerDown,
    onSurfacePointerMove,
    onSurfacePointerUp,
    onSurfacePointerCancel,
    onSurfaceDoubleClick,
    onSurfaceContextMenu,
    onSurfacePointerLeave,
    onHandlePointerDown,
    cancelDrag,
    isDragging,
  }
}
