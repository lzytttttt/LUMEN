/**
 * shortcuts.ts —— 集中式快捷键表 + 唯一安装点。
 *
 * 用法（App 里只挂一次）：
 *   useEffect(() => installShortcuts(), [])
 *
 * 规则：
 * - input / textarea / select / contentEditable 聚焦时全部让位（`isTypingTarget`）；
 * - `run` 返回 false 表示"不处理"，让浏览器拿到默认行为（例如系统剪贴板粘贴）；
 * - 剪贴板：⌘/Ctrl+C/X/V 走内部 JSON 剪贴板；内部剪贴板为空时 ⌘/Ctrl+V 放行给系统粘贴事件。
 */
import type { MessageKey } from '@/i18n'
import { t } from '@/i18n'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { useSelectionStore } from '@/state/selectionStore'
import { historyOps } from '@/state/ops'
import { blocksFromClipboardData } from '@/editor/dnd/blocksFromData'
import { useStageToolStore } from '@/editor/stage/toolStore'
import {
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  insertBlocksAt,
  nudgeSelection,
  pasteClipboard,
  selectAllBlocks,
  setTool,
  stopEditingBlock,
  togglePlay,
} from './interactions/commands'

export interface ShortcutDef {
  id: string
  /** i18n 键（editor.shortcuts.*） */
  labelKey: MessageKey
  /** 展示用按键串 */
  keys: string
  match: (event: KeyboardEvent) => boolean
  /** 返回 false：不消费该事件 */
  run: (event: KeyboardEvent) => boolean | void
}

/** 焦点在可输入控件里时，快捷键全部让位。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || typeof element.tagName !== 'string') return false
  const tag = element.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return element.isContentEditable === true
}

function isMeta(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey
}

function key(event: KeyboardEvent): string {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key
}

/** Esc 逐级退出：编辑中 → 选中 → 工具 → 播放/预览。 */
function escapeLadder(): boolean {
  const selection = useSelectionStore.getState()
  if (selection.editingBlockId) {
    stopEditingBlock()
    return true
  }
  if (selection.selectedBlockIds.length > 0) {
    selection.clearSelection()
    return true
  }
  if (useStageToolStore.getState().tool !== 'select') {
    setTool('select')
    return true
  }
  const mode = useUiStore.getState().mode
  if (mode === 'play' || mode === 'preview') {
    useUiStore.getState().setMode('edit')
    return true
  }
  return false
}

export const SHORTCUTS: ShortcutDef[] = [
  {
    id: 'undo',
    labelKey: 'editor.shortcuts.undo',
    keys: '⌘/Ctrl + Z',
    match: (event) => isMeta(event) && key(event) === 'z' && !event.shiftKey,
    run: () => {
      historyOps.undo()
    },
  },
  {
    id: 'redo',
    labelKey: 'editor.shortcuts.redo',
    keys: '⌘/Ctrl + Shift + Z',
    match: (event) => isMeta(event) && ((key(event) === 'z' && event.shiftKey) || key(event) === 'y'),
    run: () => {
      historyOps.redo()
    },
  },
  {
    id: 'copy',
    labelKey: 'editor.shortcuts.copy',
    keys: '⌘/Ctrl + C',
    match: (event) => isMeta(event) && key(event) === 'c',
    run: () => copySelection(),
  },
  {
    id: 'cut',
    labelKey: 'editor.shortcuts.cut',
    keys: '⌘/Ctrl + X',
    match: (event) => isMeta(event) && key(event) === 'x',
    run: () => cutSelection(),
  },
  {
    id: 'paste',
    labelKey: 'editor.shortcuts.paste',
    keys: '⌘/Ctrl + V',
    match: (event) => isMeta(event) && key(event) === 'v',
    // 内部剪贴板为空时放行给系统粘贴事件（图片/SVG/HTML）
    run: () => pasteClipboard(),
  },
  {
    id: 'duplicate',
    labelKey: 'editor.shortcuts.duplicate',
    keys: '⌘/Ctrl + D',
    match: (event) => isMeta(event) && key(event) === 'd',
    run: () => duplicateSelection(),
  },
  {
    id: 'selectAll',
    labelKey: 'editor.shortcuts.selectAll',
    keys: '⌘/Ctrl + A',
    match: (event) => isMeta(event) && key(event) === 'a',
    run: () => {
      selectAllBlocks()
    },
  },
  {
    id: 'play',
    labelKey: 'editor.shortcuts.play',
    keys: '⌘/Ctrl + Enter',
    match: (event) => isMeta(event) && key(event) === 'Enter',
    run: () => {
      togglePlay()
    },
  },
  {
    id: 'delete',
    labelKey: 'editor.shortcuts.delete',
    keys: 'Delete',
    match: (event) => !isMeta(event) && (key(event) === 'Delete' || key(event) === 'Backspace'),
    run: () => deleteSelection(),
  },
  {
    id: 'nudge',
    labelKey: 'editor.shortcuts.nudge',
    keys: '↑ ↓ ← →',
    match: (event) => !isMeta(event) && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key(event)),
    run: (event) => {
      const step = event.shiftKey ? 10 : 1
      const direction = key(event)
      const dx = direction === 'ArrowLeft' ? -step : direction === 'ArrowRight' ? step : 0
      const dy = direction === 'ArrowUp' ? -step : direction === 'ArrowDown' ? step : 0
      return nudgeSelection(dx, dy)
    },
  },
  {
    id: 'grid',
    labelKey: 'editor.shortcuts.grid',
    keys: 'G',
    match: (event) => !isMeta(event) && !event.shiftKey && key(event) === 'g',
    run: () => {
      useUiStore.getState().toggleGrid()
    },
  },
  {
    id: 'toolSelect',
    labelKey: 'editor.shortcuts.select',
    keys: 'V',
    match: (event) => !isMeta(event) && !event.shiftKey && key(event) === 'v',
    run: () => {
      setTool('select')
    },
  },
  {
    id: 'toolText',
    labelKey: 'editor.shortcuts.text',
    keys: 'T',
    match: (event) => !isMeta(event) && !event.shiftKey && key(event) === 't',
    // 文本工具：切到十字光标，在画布上点击/拖出文本框
    run: () => {
      setTool('text')
    },
  },
  {
    id: 'toolRect',
    labelKey: 'editor.shortcuts.shape',
    keys: 'R',
    match: (event) => !isMeta(event) && !event.shiftKey && key(event) === 'r',
    run: () => {
      setTool('rect')
    },
  },
  {
    id: 'escape',
    labelKey: 'editor.shortcuts.escape',
    keys: 'Esc',
    match: (event) => key(event) === 'Escape',
    run: () => escapeLadder(),
  },
]

/** 给「快捷键」弹窗用的只读清单（非响应式，弹窗打开时取一次即可）。 */
export function listShortcuts(): Array<{ id: string; keys: string; label: string }> {
  return SHORTCUTS.map((shortcut) => ({
    id: shortcut.id,
    keys: shortcut.keys,
    label: t(shortcut.labelKey),
  }))
}

function isPasteableBlock(data: DataTransfer): boolean {
  const hasImage = Array.from(data.items ?? []).some(
    (item) => item.kind === 'file' && item.type.startsWith('image/'),
  )
  if (hasImage) return true
  const text = data.getData('text/plain')
  if (!text) return false
  return /<svg[\s>]/i.test(text) || /<([a-z][\w:-]*)(\s[^>]*)?\/?>/i.test(text)
}

let activeDisposer: (() => void) | null = null

/**
 * 安装全局快捷键与系统粘贴监听。返回卸载函数；重复调用返回同一个卸载函数。
 * App 里只挂一次：`useEffect(() => installShortcuts(), [])`。
 */
export function installShortcuts(): () => void {
  if (activeDisposer) return activeDisposer

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return
    if (isTypingTarget(event.target)) return
    // 播放/预览态：编辑类快捷键让位给播放器（方向键翻页），只保留退出与播放开关。
    const editingMode = useUiStore.getState().mode === 'edit'
    for (const shortcut of SHORTCUTS) {
      if (!editingMode && shortcut.id !== 'escape' && shortcut.id !== 'play') continue
      if (!shortcut.match(event)) continue
      const handled = shortcut.run(event)
      if (handled === false) return
      event.preventDefault()
      event.stopPropagation()
      return
    }
  }

  const onPaste = (event: ClipboardEvent) => {
    if (isTypingTarget(event.target)) return
    const data = event.clipboardData
    if (!data || !isPasteableBlock(data)) return
    // 必须同步 preventDefault，异步解码图片时浏览器已经不会再插入文本
    event.preventDefault()
    void blocksFromClipboardData(data).then((outcome) => {
      if (outcome.blocks.length > 0) {
        insertBlocksAt(outcome.blocks)
        return
      }
      if (outcome.issues.length > 0) {
        useUiStore.getState().pushToast({ kind: 'error', message: outcome.issues[0] })
      }
    })
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('paste', onPaste)
  activeDisposer = () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('paste', onPaste)
    activeDisposer = null
  }
  return activeDisposer
}

/** 供命令面板/调试使用：当前是否有安装。 */
export function shortcutsInstalled(): boolean {
  return activeDisposer !== null
}

/** 兼容性导出：历史栈可撤销判断。 */
export function canUndoNow(): boolean {
  return useDeckStore.getState().past.length > 0
}
