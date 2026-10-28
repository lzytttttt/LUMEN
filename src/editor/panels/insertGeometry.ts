/**
 * insertGeometry.ts —— 插入元素的落点计算（纯函数，便于单测）。
 * 规则：一律落在 1600×900 舞台的视觉中心，且不越出安全区（120/96）。
 */
import { SAFE_X, SAFE_Y, STAGE_H, STAGE_W } from '@/schema/deck'

export interface Rect4 {
  x: number
  y: number
  w: number
  h: number
}

/** 居中矩形：超宽/超高时先夹到安全区内，再居中。 */
export function centeredRect(w: number, h: number): Rect4 {
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

/** 按素材纵横比推算插入尺寸（宽度给定，高度 = 宽度 × aspect，并封顶安全区）。 */
export function rectForAspect(width: number, aspect: number): Rect4 {
  // aspect 定义为 高/宽（图片、SVG viewBox 都是这个约定）。
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 9 / 16
  const safeH = STAGE_H - SAFE_Y * 2
  const w = Math.max(8, Math.min(Math.round(width), STAGE_W - SAFE_X * 2))
  const rawH = w * ratio
  const h = Math.max(8, Math.min(Math.round(rawH), safeH))
  return centeredRect(w, h)
}

/** 图片/AI 素材的默认宽度（舞台宽度的 45%）。 */
export const INSERT_IMAGE_W = 720
