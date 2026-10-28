/**
 * editingIntent.ts —— 进入内联改字时的一次性意图（是否全选、双击落点）。
 *
 * 选中态只能存 id，光标位置这类"一次性参数"放这里，避免为它扩 store。
 */
import type { Point } from '@/editor/stage/geometry'

export interface EditingIntent {
  selectAll: boolean
  point: Point | null
}

let intent: EditingIntent | null = null

export function setEditingIntent(next: EditingIntent | null): void {
  intent = next
}

/** 读取并清空（内联编辑器挂载时调用一次）。 */
export function takeEditingIntent(): EditingIntent | null {
  const current = intent
  intent = null
  return current
}
