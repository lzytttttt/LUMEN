/**
 * clipboard.ts —— 编辑器内部剪贴板（JSON 序列化，连续粘贴带偏移）。
 *
 * 只处理 deck 内的块；系统剪贴板里的图片/SVG/HTML 由 dnd/blocksFromData.ts 负责。
 */
import type { Block } from '@/schema/deck'
import { clampToStage } from '@/schema/geometry'
import { newId } from '@/schema/ids'

interface ClipboardPayload {
  blocks: Block[]
  /** 已粘贴次数：每粘一次偏移 24px，避免完全重叠 */
  pastes: number
}

const PASTE_OFFSET = 24

let buffer: ClipboardPayload | null = null

function cloneBlocks(blocks: Block[]): Block[] {
  try {
    return structuredClone(blocks)
  } catch {
    return JSON.parse(JSON.stringify(blocks)) as Block[]
  }
}

/** 写入内部剪贴板（深拷贝，源块后续改动不影响）。 */
export function writeBlockClipboard(blocks: Block[]): boolean {
  if (blocks.length === 0) return false
  buffer = { blocks: cloneBlocks(blocks), pastes: 0 }
  return true
}

export function hasBlockClipboard(): boolean {
  return Boolean(buffer && buffer.blocks.length > 0)
}

/**
 * 读出可粘贴的块：换新 id、整体偏移、把几何收进舞台。
 * 每次调用都会让下一次粘贴再偏移 24px。
 */
export function readBlockClipboard(): Block[] {
  if (!buffer) return []
  buffer.pastes += 1
  const shift = PASTE_OFFSET * buffer.pastes
  return buffer.blocks.map((block) => {
    const rect = clampToStage({ x: block.x + shift, y: block.y + shift, w: block.w, h: block.h })
    return { ...block, id: newId(block.type), x: rect.x, y: rect.y, w: rect.w, h: rect.h }
  })
}

export function clearBlockClipboard(): void {
  buffer = null
}
