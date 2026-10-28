/**
 * geometry.ts —— 工作室插入落点（纯函数）。
 *
 * 规则与 panels 的 `insertGeometry` 一致：落在 1600×900 的视觉中心，且不越出安全区（120/96）。
 * 这里独立实现一份，避免 studio ↔ editor 之间产生反向依赖。
 */
import { SAFE_X, SAFE_Y, STAGE_H, STAGE_W } from '@/schema/deck'

export interface StudioRect {
  x: number
  y: number
  w: number
  h: number
}

export function centeredRect(w: number, h: number): StudioRect {
  const safeW = STAGE_W - SAFE_X * 2
  const safeH = STAGE_H - SAFE_Y * 2
  const width = Math.max(8, Math.min(Math.round(w), safeW))
  const height = Math.max(8, Math.min(Math.round(h), safeH))
  return {
    x: Math.round((STAGE_W - width) / 2),
    y: Math.round((STAGE_H - height) / 2),
    w: width,
    h: height,
  }
}

/** 按纵横比推定插入尺寸（给定宽度，高度封顶安全区）。 */
export function rectForAspect(width: number, aspect: number): StudioRect {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  const safeH = STAGE_H - SAFE_Y * 2
  const w = Math.max(8, Math.min(Math.round(width), STAGE_W - SAFE_X * 2))
  const h = Math.max(8, Math.min(Math.round(w * ratio), safeH))
  return centeredRect(w, h)
}
