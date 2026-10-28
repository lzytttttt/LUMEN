/**
 * geometry.ts —— 舞台交互的纯几何层。
 *
 * 命中测试、框选、吸附、缩放、旋转、安全区放置全部落在这里：
 * 无 React、无 store 依赖，`tests/unit/stage-geometry.test.ts` 直接跑。
 * 坐标系一律是设计像素（1600×900），缩放只在外层 transform 做。
 */
import { SAFE_X, SAFE_Y, STAGE_H, STAGE_W } from '@/schema/deck'
import { GRID, MIN_SIZE, rectsIntersect, rotatedBounds, type Rect } from '@/schema/geometry'

export interface Point {
  x: number
  y: number
}

/** 参与交互的最小几何单元（Block 结构上满足它）。 */
export interface StageBox extends Rect {
  id: string
  z?: number
  rotation?: number
  locked?: boolean
  hidden?: boolean
}

export const SNAP_THRESHOLD = 6
/** 允许的出血量：块至少保留 24px 在舞台内（与 clampToStage 保持一致）。 */
export const BLEED = 24

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export interface HandleDef {
  id: HandleId
  /** 0 = 左/上边移动，1 = 右/下边移动，0.5 = 该轴不变 */
  fx: 0 | 0.5 | 1
  fy: 0 | 0.5 | 1
  cursor: string
}

export const HANDLES: readonly HandleDef[] = [
  { id: 'nw', fx: 0, fy: 0, cursor: 'nwse-resize' },
  { id: 'n', fx: 0.5, fy: 0, cursor: 'ns-resize' },
  { id: 'ne', fx: 1, fy: 0, cursor: 'nesw-resize' },
  { id: 'e', fx: 1, fy: 0.5, cursor: 'ew-resize' },
  { id: 'se', fx: 1, fy: 1, cursor: 'nwse-resize' },
  { id: 's', fx: 0.5, fy: 1, cursor: 'ns-resize' },
  { id: 'sw', fx: 0, fy: 1, cursor: 'nesw-resize' },
  { id: 'w', fx: 0, fy: 0.5, cursor: 'ew-resize' },
]

export function handleDef(id: HandleId): HandleDef {
  return HANDLES.find((handle) => handle.id === id) ?? HANDLES[0]
}

export interface Guide {
  axis: 'x' | 'y'
  pos: number
}

export interface AxisLines {
  x: number[]
  y: number[]
}

/* ------------------------------- 基础数学 ------------------------------- */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function roundTo(value: number, step: number): number {
  if (step <= 0) return value
  return Math.round(value / step) * step
}

export function boxCenter(box: Rect): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 }
}

export function rotateVector(vector: Point, degrees: number): Point {
  if (!degrees) return { x: vector.x, y: vector.y }
  const rad = (degrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
  }
}

export function rotatePoint(point: Point, center: Point, degrees: number): Point {
  const local = rotateVector({ x: point.x - center.x, y: point.y - center.y }, degrees)
  return { x: center.x + local.x, y: center.y + local.y }
}

/** 两点夹角（设计像素空间，度）。 */
export function angleDeg(center: Point, point: Point): number {
  return (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI
}

/** 归一到 (-180, 180]。 */
export function normalizeAngle(degrees: number): number {
  const wrapped = (((degrees + 180) % 360) + 360) % 360 - 180
  return wrapped === -180 ? 180 : wrapped
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/* ------------------------------- 命中测试 ------------------------------- */

/** 是否命中（含旋转：把点逆变换到块本地坐标）。 */
export function pointInBox(box: StageBox, point: Point): boolean {
  const center = boxCenter(box)
  const local = rotateVector({ x: point.x - center.x, y: point.y - center.y }, -(box.rotation ?? 0))
  return Math.abs(local.x) <= box.w / 2 && Math.abs(local.y) <= box.h / 2
}

/** 旋转后的外接框（选择框、框选都用它）。 */
export function boundsOf(box: StageBox): Rect {
  return rotatedBounds({ x: box.x, y: box.y, w: box.w, h: box.h }, box.rotation ?? 0)
}

export function unionBounds(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.w)
    maxY = Math.max(maxY, rect.y + rect.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * 顶层层命中：z 由低到高排列，从高到低找第一个命中的块。
 * 默认跳过 hidden / locked；`includeLocked` 由 Alt 点击打开（穿透选择被锁块）。
 */
export function hitTestBoxes<T extends StageBox>(
  boxes: readonly T[],
  point: Point,
  opts?: { includeLocked?: boolean },
): T | null {
  const ordered = [...boxes].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const box = ordered[i]
    if (box.hidden) continue
    if (box.locked && !opts?.includeLocked) continue
    if (pointInBox(box, point)) return box
  }
  return null
}

/** 框选：与块（旋转后外接框）相交即命中。 */
export function marqueeBoxes<T extends StageBox>(
  boxes: readonly T[],
  rect: Rect,
  opts?: { includeLocked?: boolean },
): T[] {
  return boxes.filter((box) => {
    if (box.hidden) return false
    if (box.locked && !opts?.includeLocked) return false
    return rectsIntersect(rect, boundsOf(box))
  })
}

/* --------------------------------- 吸附 --------------------------------- */

export function stageSnapLines(): AxisLines {
  return {
    x: [0, SAFE_X, STAGE_W / 2, STAGE_W - SAFE_X, STAGE_W],
    y: [0, SAFE_Y, STAGE_H / 2, STAGE_H - SAFE_Y, STAGE_H],
  }
}

/** 同级块的左/中/右、上/中/下候选线；`exclude` 是正在拖动的块索引。 */
export function blockSnapLines(boxes: readonly StageBox[], exclude: ReadonlySet<string>): AxisLines {
  const x: number[] = []
  const y: number[] = []
  for (const box of boxes) {
    if (box.hidden || exclude.has(box.id)) continue
    if (box.rotation) {
      // 旋转块用外接框的边线，避免吸到看不见的轴上
      const bounds = boundsOf(box)
      x.push(bounds.x, bounds.x + bounds.w / 2, bounds.x + bounds.w)
      y.push(bounds.y, bounds.y + bounds.h / 2, bounds.y + bounds.h)
      continue
    }
    x.push(box.x, box.x + box.w / 2, box.x + box.w)
    y.push(box.y, box.y + box.h / 2, box.y + box.h)
  }
  return { x, y }
}

export function mergeLines(a: AxisLines, b: AxisLines): AxisLines {
  return { x: [...a.x, ...b.x], y: [...a.y, ...b.y] }
}

export interface EdgeSnap {
  delta: number
  guide: number | null
}

/** 单轴边缘吸附：在所有 (边, 候选线) 组合里挑阈值内最近的一对。 */
export function snapEdge(values: readonly number[], candidates: readonly number[], threshold = SNAP_THRESHOLD): EdgeSnap {
  let best: EdgeSnap = { delta: 0, guide: null }
  let bestDist = threshold + 1e-6
  for (const value of values) {
    for (const candidate of candidates) {
      const delta = candidate - value
      const dist = Math.abs(delta)
      if (dist < bestDist) {
        bestDist = dist
        best = { delta, guide: candidate }
      }
    }
  }
  return best
}

export interface MoveSnapResult {
  /** 在原始位移上追加的修正量 */
  dx: number
  dy: number
  guides: Guide[]
}

function pushGuide(guides: Guide[], axis: Guide['axis'], pos: number): void {
  if (guides.some((guide) => guide.axis === axis && Math.abs(guide.pos - pos) < 0.5)) return
  guides.push({ axis, pos })
}

/**
 * 移动吸附：先试同级块 / 舞台边距与中线（阈值 6px），没命中再退化为 8px 网格。
 * 返回的是「修正量」，加到原始位移上即可。
 */
export function snapMove(
  bounds: Rect,
  lines: AxisLines,
  opts?: { threshold?: number; grid?: number },
): MoveSnapResult {
  const threshold = opts?.threshold ?? SNAP_THRESHOLD
  const grid = opts?.grid ?? GRID
  const xs = [bounds.x, bounds.x + bounds.w / 2, bounds.x + bounds.w]
  const ys = [bounds.y, bounds.y + bounds.h / 2, bounds.y + bounds.h]

  const snappedX = snapEdge(xs, lines.x, threshold)
  const snappedY = snapEdge(ys, lines.y, threshold)

  const dx = snappedX.guide === null ? (grid > 0 ? roundTo(bounds.x, grid) - bounds.x : 0) : snappedX.delta
  const dy = snappedY.guide === null ? (grid > 0 ? roundTo(bounds.y, grid) - bounds.y : 0) : snappedY.delta

  const guides: Guide[] = []
  if (snappedX.guide !== null && dx !== 0) {
    for (const value of xs) {
      const moved = value + dx
      for (const candidate of lines.x) {
        if (Math.abs(candidate - moved) < 0.5) pushGuide(guides, 'x', candidate)
      }
    }
  }
  if (snappedY.guide !== null && dy !== 0) {
    for (const value of ys) {
      const moved = value + dy
      for (const candidate of lines.y) {
        if (Math.abs(candidate - moved) < 0.5) pushGuide(guides, 'y', candidate)
      }
    }
  }
  // 位移为 0（刚好对齐）时也要给线，方便用户确认
  if (snappedX.guide !== null && dx === 0) pushGuide(guides, 'x', snappedX.guide)
  if (snappedY.guide !== null && dy === 0) pushGuide(guides, 'y', snappedY.guide)
  return { dx, dy, guides }
}

/**
 * 把整组块的位移限制在舞台内（允许 24px 出血）。
 * 约束的是「位移量」而不是逐个 clamp，这样多选拖拽时相对位置不会漂。
 */
export function clampMoveDelta(
  boxes: readonly Rect[],
  dx: number,
  dy: number,
  bleed = BLEED,
): { dx: number; dy: number } {
  if (boxes.length === 0) return { dx, dy }
  let minDx = Number.NEGATIVE_INFINITY
  let maxDx = Number.POSITIVE_INFINITY
  let minDy = Number.NEGATIVE_INFINITY
  let maxDy = Number.POSITIVE_INFINITY
  for (const box of boxes) {
    minDx = Math.max(minDx, -box.w + bleed - box.x)
    maxDx = Math.min(maxDx, STAGE_W - bleed - box.x)
    minDy = Math.max(minDy, -box.h + bleed - box.y)
    maxDy = Math.min(maxDy, STAGE_H - bleed - box.y)
  }
  const clampedX = Number.isFinite(minDx) && Number.isFinite(maxDx) ? clamp(dx, minDx, maxDx) : dx
  const clampedY = Number.isFinite(minDy) && Number.isFinite(maxDy) ? clamp(dy, minDy, maxDy) : dy
  return { dx: clampedX, dy: clampedY }
}

/* ------------------------------- 缩放 / 旋转 ------------------------------ */

export interface ResizeOptions {
  origin: Rect
  rotation?: number
  handle: HandleId
  /** 指针相对起点的设计像素位移 */
  delta: Point
  /** 等比缩放 */
  shift?: boolean
  /** 以中心为锚点 */
  alt?: boolean
  minSize?: number
}

/**
 * 8 向手柄缩放，支持旋转块：把手柄位移逆旋转进块本地坐标系计算新尺寸，
 * 再以「对边/对角（或中心）」为锚点反算新的中心点。
 */
export function resizeRect(options: ResizeOptions): Rect {
  const { origin, handle, delta, shift = false, alt = false } = options
  const rotation = options.rotation ?? 0
  const minSize = options.minSize ?? MIN_SIZE
  const def = handleDef(handle)
  const local = rotateVector(delta, -rotation)
  const signX = def.fx === 0 ? -1 : def.fx === 1 ? 1 : 0
  const signY = def.fy === 0 ? -1 : def.fy === 1 ? 1 : 0
  const centerScale = alt ? 2 : 1

  let w = origin.w + signX * local.x * centerScale
  let h = origin.h + signY * local.y * centerScale

  if (shift && signX !== 0 && signY !== 0) {
    const sx = origin.w > 0 ? w / origin.w : 1
    const sy = origin.h > 0 ? h / origin.h : 1
    const factor = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy
    w = origin.w * factor
    h = origin.h * factor
  }

  w = Math.max(minSize, w)
  h = Math.max(minSize, h)

  const ax = alt ? 0.5 : 1 - def.fx
  const ay = alt ? 0.5 : 1 - def.fy
  const originCenter = boxCenter(origin)
  const anchor = rotatePoint({ x: origin.x + ax * origin.w, y: origin.y + ay * origin.h }, originCenter, rotation)
  const offset = rotateVector({ x: (0.5 - ax) * w, y: (0.5 - ay) * h }, rotation)
  const cx = anchor.x + offset.x
  const cy = anchor.y + offset.y
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/** 多选缩放：整组按比例映射。 */
export function scaleBoxes(boxes: readonly Rect[], from: Rect, to: Rect, minSize = MIN_SIZE): Rect[] {
  const sx = from.w > 0 ? to.w / from.w : 1
  const sy = from.h > 0 ? to.h / from.h : 1
  return boxes.map((box) => ({
    x: to.x + (box.x - from.x) * sx,
    y: to.y + (box.y - from.y) * sy,
    w: Math.max(minSize, box.w * sx),
    h: Math.max(minSize, box.h * sy),
  }))
}

/** 缩放时对正在移动的那条边做吸附，返回需要追加到尺寸上的修正。 */
export function snapResizeEdge(
  rect: Rect,
  def: HandleDef,
  lines: AxisLines,
  threshold = SNAP_THRESHOLD,
): { dw: number; dh: number; dx: number; dy: number; guides: Guide[] } {
  const guides: Guide[] = []
  let dx = 0
  let dw = 0
  let dy = 0
  let dh = 0

  if (def.fx === 0) {
    const snap = snapEdge([rect.x], lines.x, threshold)
    if (snap.guide !== null) {
      dx = snap.delta
      dw = -snap.delta
      pushGuide(guides, 'x', snap.guide)
    }
  } else if (def.fx === 1) {
    const snap = snapEdge([rect.x + rect.w], lines.x, threshold)
    if (snap.guide !== null) {
      dw = snap.delta
      pushGuide(guides, 'x', snap.guide)
    }
  }

  if (def.fy === 0) {
    const snap = snapEdge([rect.y], lines.y, threshold)
    if (snap.guide !== null) {
      dy = snap.delta
      dh = -snap.delta
      pushGuide(guides, 'y', snap.guide)
    }
  } else if (def.fy === 1) {
    const snap = snapEdge([rect.y + rect.h], lines.y, threshold)
    if (snap.guide !== null) {
      dh = snap.delta
      pushGuide(guides, 'y', snap.guide)
    }
  }

  return { dw, dh, dx, dy, guides }
}

/* ------------------------------- 放置规则 ------------------------------- */

/** 把矩形收进安全边距内（放不下时居中）。 */
export function fitIntoSafe(rect: Rect): Rect {
  const w = Math.max(MIN_SIZE, Math.min(rect.w, STAGE_W))
  const h = Math.max(MIN_SIZE, Math.min(rect.h, STAGE_H))
  const minX = SAFE_X
  const maxX = STAGE_W - SAFE_X - w
  const minY = SAFE_Y
  const maxY = STAGE_H - SAFE_Y - h
  const x = maxX < minX ? (STAGE_W - w) / 2 : clamp(rect.x, minX, maxX)
  const y = maxY < minY ? (STAGE_H - h) / 2 : clamp(rect.y, minY, maxY)
  return { x, y, w, h }
}

/** 以某点为视觉中心放一个给定尺寸的块（再收进安全区）。 */
export function centerBoxAt(point: Point, size: { w: number; h: number }): Rect {
  return fitIntoSafe({ x: point.x - size.w / 2, y: point.y - size.h / 2, w: size.w, h: size.h })
}

/** 按最大边约束缩放尺寸（保比例），用于素材导入。 */
export function fitSize(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const safeW = Math.max(1, w)
  const safeH = Math.max(1, h)
  const factor = Math.min(1, maxW / safeW, maxH / safeH)
  return { w: Math.round(safeW * factor), h: Math.round(safeH * factor) }
}
