/** geometry.ts —— 舞台几何纯函数（编辑器、ops、导出共用，无 React 依赖）。 */
import { STAGE_H, STAGE_W } from './deck'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

export const MIN_SIZE = 8
export const GRID = 8

export function clampToStage(rect: Rect, margin = 0): Rect {
  const w = Math.min(Math.max(rect.w, MIN_SIZE), STAGE_W)
  const h = Math.min(Math.max(rect.h, MIN_SIZE), STAGE_H)
  const x = Math.min(Math.max(rect.x, -w + 24 + margin), STAGE_W - 24 - margin)
  const y = Math.min(Math.max(rect.y, -h + 24 + margin), STAGE_H - 24 - margin)
  return { x, y, w, h }
}

export function snapToGrid(value: number, grid = GRID): number {
  return Math.round(value / grid) * grid
}

export interface SnapResult {
  value: number
  guide: number | null
}

/**
 * 单轴吸附：把 value 吸到最近的候选线上（阈值内），返回吸附后的值与命中的参考线。
 */
export function snapValue(value: number, candidates: number[], threshold = 6): SnapResult {
  let best: SnapResult = { value, guide: null }
  let bestDist = threshold
  for (const candidate of candidates) {
    const dist = Math.abs(candidate - value)
    if (dist <= bestDist) {
      bestDist = dist
      best = { value: candidate, guide: candidate }
    }
  }
  return best
}

export function alignRects(reference: Rect, movers: Rect[], mode: AlignMode): Rect[] {
  const ref = reference
  return movers.map((r) => {
    switch (mode) {
      case 'left':
        return { ...r, x: ref.x }
      case 'right':
        return { ...r, x: ref.x + ref.w - r.w }
      case 'hcenter':
        return { ...r, x: ref.x + (ref.w - r.w) / 2 }
      case 'top':
        return { ...r, y: ref.y }
      case 'bottom':
        return { ...r, y: ref.y + ref.h - r.h }
      case 'vcenter':
        return { ...r, y: ref.y + (ref.h - r.h) / 2 }
      default:
        return r
    }
  })
}

/** 等距分布（按中心轴排序，首尾固定）。 */
export function distributeRects(rects: Rect[], axis: 'x' | 'y'): Rect[] {
  if (rects.length < 3) return rects
  const sizeKey = axis === 'x' ? 'w' : 'h'
  const posKey = axis
  const sorted = [...rects].sort((a, b) => a[posKey] - b[posKey])
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const span = last[posKey] + last[sizeKey] - first[posKey]
  const totalSize = sorted.reduce((sum, r) => sum + r[sizeKey], 0)
  const gap = (span - totalSize) / (sorted.length - 1)
  let cursor = first[posKey]
  const placed = new Map<string, number>()
  for (const rect of sorted) {
    placed.set(`${rect[posKey]}-${rect[sizeKey]}-${rect.w}-${rect.h}`, cursor)
    cursor += rect[sizeKey] + gap
  }
  return rects.map((r) => {
    const key = `${r[posKey]}-${r[sizeKey]}-${r.w}-${r.h}`
    const next = placed.get(key)
    return next === undefined ? r : { ...r, [posKey]: Math.round(next) }
  })
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

export function centerOf(rect: Rect): { cx: number; cy: number } {
  return { cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2 }
}

export function roundRect(rect: Rect): Rect {
  return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }
}

/** 旋转后的外接框（用于选择框与命中测试）。 */
export function rotatedBounds(rect: Rect, degrees: number): Rect {
  if (!degrees) return rect
  const rad = (degrees * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const w = rect.w * cos + rect.h * sin
  const h = rect.w * sin + rect.h * cos
  const { cx, cy } = centerOf(rect)
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}
