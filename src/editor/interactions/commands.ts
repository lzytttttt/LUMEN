/**
 * commands.ts —— 画布上的"命令"（快捷键、右键菜单、对齐条共用）。
 *
 * 所有写操作都经 `blockOps/slideOps/historyOps`；这里只做选择集与锁定的取舍。
 */
import type { Block } from '@/schema/deck'
import type { AlignMode } from '@/schema/geometry'
import { clampToStage } from '@/schema/geometry'
import { makeShape, makeText } from '@/schema/factory'
import { t } from '@/i18n'
import { blockOps, historyOps, resolveSlide } from '@/state/ops'
import { useSelectionStore } from '@/state/selectionStore'
import { useUiStore } from '@/state/uiStore'
import { useDeckStore } from '@/state/deckStore'
import { useStageToolStore, type StageTool } from '@/editor/stage/toolStore'
import { centerBoxAt, type Point } from '@/editor/stage/geometry'
import { setEditingIntent } from './editingIntent'
import { hasBlockClipboard, readBlockClipboard, writeBlockClipboard } from './clipboard'

/* -------------------------------- 选择集 -------------------------------- */

export function activeBlockIds(): string[] {
  return useSelectionStore.getState().selectedBlockIds
}

export function activeBlocks(): Block[] {
  const slide = resolveSlide()
  if (!slide) return []
  const ids = new Set(activeBlockIds())
  return slide.blocks.filter((block) => ids.has(block.id))
}

/** 可写的选中块（锁定块不参与删除/移动）。 */
function writableBlocks(): Block[] {
  return activeBlocks().filter((block) => !block.locked)
}

export function selectionCount(): number {
  return activeBlockIds().length
}

/* -------------------------------- 基础命令 ------------------------------- */

export function deleteSelection(): boolean {
  const blocks = writableBlocks()
  if (blocks.length === 0) return false
  blockOps.remove(blocks.map((block) => block.id))
  return true
}

export function duplicateSelection(): boolean {
  const blocks = writableBlocks()
  if (blocks.length === 0) return false
  blockOps.duplicate(blocks.map((block) => block.id))
  return true
}

export function copySelection(): boolean {
  return writeBlockClipboard(writableBlocks())
}

export function cutSelection(): boolean {
  const blocks = writableBlocks()
  if (blocks.length === 0) return false
  writeBlockClipboard(blocks)
  blockOps.remove(blocks.map((block) => block.id))
  return true
}

/** 内部剪贴板粘贴；返回 false 表示没有内容（交给系统粘贴事件处理）。 */
export function pasteClipboard(): boolean {
  if (!hasBlockClipboard()) return false
  const blocks = readBlockClipboard()
  if (blocks.length === 0) return false
  blockOps.addMany(blocks)
  return true
}

export function selectAllBlocks(): boolean {
  const slide = resolveSlide()
  if (!slide) return false
  const ids = slide.blocks.filter((block) => !block.hidden && !block.locked).map((block) => block.id)
  if (ids.length === 0) return false
  useSelectionStore.getState().setSelection(ids)
  return true
}

export function nudgeSelection(dx: number, dy: number): boolean {
  const ids = writableBlocks().map((block) => block.id)
  if (ids.length === 0) return false
  blockOps.nudge(ids, dx, dy)
  return true
}

export function togglePlay(): void {
  const mode = useUiStore.getState().mode
  useUiStore.getState().setMode(mode === 'play' ? 'edit' : 'play')
}

export function setTool(tool: StageTool): void {
  useStageToolStore.getState().setTool(tool)
}

/* -------------------------------- 对齐/分布 ------------------------------- */

export function alignSelection(mode: AlignMode): boolean {
  const ids = activeBlockIds()
  if (ids.length < 2) return false
  blockOps.align(ids, mode)
  return true
}

export function distributeSelection(axis: 'x' | 'y'): boolean {
  const ids = activeBlockIds()
  if (ids.length < 3) return false
  blockOps.distribute(ids, axis)
  return true
}

export function reorderSelection(mode: 'front' | 'back' | 'forward' | 'backward'): boolean {
  const ids = activeBlockIds()
  if (ids.length === 0) return false
  blockOps.reorderZ(ids, mode)
  return true
}

export function toggleLockSelection(): boolean {
  const blocks = activeBlocks()
  if (blocks.length === 0) return false
  const allLocked = blocks.every((block) => block.locked)
  blockOps.setFlag(blocks.map((block) => block.id), 'locked', !allLocked)
  return true
}

export function toggleHiddenSelection(): boolean {
  const blocks = activeBlocks()
  if (blocks.length === 0) return false
  const allHidden = blocks.every((block) => block.hidden)
  blockOps.setFlag(blocks.map((block) => block.id), 'hidden', !allHidden)
  if (!allHidden) useSelectionStore.getState().clearSelection()
  return true
}

/* -------------------------------- 插入块 -------------------------------- */

export interface InsertOptions {
  point?: Point
  size?: { w: number; h: number }
  select?: boolean
}

/** 把已有块按「以点为视觉中心」放进安全区并落库。 */
export function insertBlocksAt(blocks: Block[], options: InsertOptions = {}): Block[] {
  const slide = resolveSlide()
  if (!slide || blocks.length === 0) return []
  const point = options.point ?? { x: 800, y: 450 }
  const placed = blocks.map((block, index) => {
    const rect = centerBoxAt(
      { x: point.x + index * 24, y: point.y + index * 24 },
      { w: block.w, h: block.h },
    )
    return { ...block, x: rect.x, y: rect.y, w: rect.w, h: rect.h }
  })
  blockOps.addMany(placed)
  return placed
}

export function insertTextAt(options: InsertOptions = {}): string | null {
  const size = options.size ?? { w: 640, h: 148 }
  const point = options.point ?? { x: 800, y: 450 }
  const rect = centerBoxAt(point, size)
  const block = makeText({
    text: t('editor.stage.newText'),
    variant: 'h2',
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
  })
  blockOps.add(block)
  startEditingBlock(block.id, { selectAll: true })
  setTool('select')
  return block.id
}

export function insertRectAt(options: InsertOptions = {}): string | null {
  const size = options.size ?? { w: 360, h: 220 }
  const point = options.point ?? { x: 800, y: 450 }
  const rect = centerBoxAt(point, size)
  const block = makeShape({
    kind: 'rect',
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
  })
  blockOps.add(block)
  setTool('select')
  return block.id
}

/* -------------------------------- 内联改字 ------------------------------- */

export function startEditingBlock(blockId: string, options?: { selectAll?: boolean; point?: Point }): boolean {
  const slide = resolveSlide()
  const block = slide?.blocks.find((item) => item.id === blockId)
  if (!block || block.type !== 'text' || block.locked || block.hidden) return false
  useSelectionStore.getState().setSelection([blockId])
  setEditingIntent({ selectAll: options?.selectAll ?? false, point: options?.point ?? null })
  useSelectionStore.getState().setEditing(blockId)
  return true
}

export function stopEditingBlock(): void {
  setEditingIntent(null)
  useSelectionStore.getState().setEditing(null)
}

/** 提交文本（一次历史）。空文本也提交，但保留块。 */
export function commitTextEdit(blockId: string, text: string): void {
  const slide = resolveSlide()
  const block = slide?.blocks.find((item) => item.id === blockId)
  if (!block || block.type !== 'text') {
    stopEditingBlock()
    return
  }
  const next = text.replace(/\r\n/g, '\n').replace(/\s+$/g, '').slice(0, 6000)
  if (next !== block.text) {
    blockOps.updateOfType(blockId, 'text', (draft) => {
      draft.text = next
    }, { label: 'edit-text' })
  }
  stopEditingBlock()
}

/** 确保几何仍在舞台内（粘贴/拖放后的兜底）。 */
export function clampBlockRect(block: Block): Block {
  const rect = clampToStage(block)
  return { ...block, x: rect.x, y: rect.y, w: rect.w, h: rect.h }
}

/* -------------------------------- 别名导出 ------------------------------- */

export const canvasCommands = {
  deleteSelection,
  duplicateSelection,
  copySelection,
  cutSelection,
  pasteClipboard,
  selectAllBlocks,
  nudgeSelection,
  alignSelection,
  distributeSelection,
  reorderSelection,
  toggleLockSelection,
  toggleHiddenSelection,
  insertTextAt,
  insertRectAt,
  insertBlocksAt,
  startEditingBlock,
  stopEditingBlock,
  commitTextEdit,
  setTool,
  togglePlay,
}

/** 历史便捷（右键菜单/工具栏复用）。 */
export const canvasHistory = {
  undo: () => historyOps.undo(),
  redo: () => historyOps.redo(),
  canUndo: () => useDeckStore.getState().past.length > 0,
}
