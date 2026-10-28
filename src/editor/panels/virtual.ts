/**
 * virtual.ts —— 幕栏的定高窗口计算（纯函数）。
 * 幕栏每一项高度只取决于缩略图缩放，因此可以精确地把可视区换算成下标区间。
 */

export interface VisibleRange {
  /** 首/末可见下标（含）。空列表时 start=0、end=-1。 */
  start: number
  end: number
}

export function visibleRange(
  count: number,
  scrollTop: number,
  itemHeight: number,
  viewportHeight: number,
  overscan = 2,
  paddingTop = 0,
): VisibleRange {
  if (count <= 0) return { start: 0, end: -1 }
  const row = itemHeight > 0 ? itemHeight : 1
  const top = Math.max(0, scrollTop - paddingTop)
  const first = Math.floor(top / row) - overscan
  const last = Math.ceil((top + Math.max(0, viewportHeight)) / row) + overscan
  return {
    start: Math.max(0, first),
    end: Math.min(count - 1, Math.max(0, last)),
  }
}

export function inVisibleRange(index: number, range: VisibleRange): boolean {
  return index >= range.start && index <= range.end
}

/** 把「从 from 挪到插槽 to」换算成移动后的目标下标（插入语义 → 交换语义）。 */
export function moveTargetIndex(from: number, insertIndex: number): number {
  return insertIndex > from ? insertIndex - 1 : insertIndex
}

/** 数组内移动（返回新数组，不改原数组）。 */
export function moveWithin<T>(list: T[], from: number, insertIndex: number): T[] {
  const to = moveTargetIndex(from, insertIndex)
  if (from < 0 || from >= list.length) return list.slice()
  const next = list.slice()
  const [moved] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved)
  return next
}
