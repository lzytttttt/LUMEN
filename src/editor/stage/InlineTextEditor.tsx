/**
 * InlineTextEditor.tsx —— 画布内联改字层。
 *
 * 渲染层负责"看"，这一层负责"改"：位置/旋转/字号/行高/字距/颜色/对齐都与块一致，
 * 但用 contentEditable(plaintext-only) 直接吃键盘。提交规则：
 * - blur 提交（一次历史，由 commands.commitTextEdit 落库）；
 * - Esc 取消（不写库）；
 * - Enter 换行，⌘/Ctrl+Enter 提交；
 * - IME 合成期不提交、不拦 Enter；空文本退出但保留块。
 */
import { useEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { TextBlock } from '@/schema/deck'
import { takeEditingIntent } from '@/editor/interactions/editingIntent'

export interface InlineTextEditorProps {
  block: TextBlock
  /** 主题 CSS 变量（--d-*），保证字号/字体/配色与渲染层完全一致 */
  vars: Record<string, string>
  placeholder: string
  onCommit: (text: string) => void
  onCancel: () => void
}

type CaretCapableDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

function readText(node: HTMLElement): string {
  const raw = typeof node.innerText === 'string' ? node.innerText : node.textContent ?? ''
  return raw.replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n')
}

function placeCaret(node: HTMLElement, point: { x: number; y: number } | null, selectAll: boolean): void {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()

  if (selectAll && node.textContent) {
    range.selectNodeContents(node)
    selection.removeAllRanges()
    selection.addRange(range)
    return
  }

  if (point) {
    const doc = document as CaretCapableDocument
    const hit = doc.caretRangeFromPoint?.(point.x, point.y) ?? null
    if (hit && node.contains(hit.startContainer)) {
      selection.removeAllRanges()
      selection.addRange(hit)
      return
    }
  }

  range.selectNodeContents(node)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

function insertAtCaret(text: string): void {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function InlineTextEditor({ block, vars, placeholder, onCommit, onCancel }: InlineTextEditorProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const composingRef = useRef(false)
  const doneRef = useRef(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const intent = takeEditingIntent()
    node.textContent = block.text
    node.focus({ preventScroll: true })
    if (intent) placeCaret(node, intent.point, intent.selectAll)
    else placeCaret(node, null, false)
    // 只在挂载时同步一次，后续输入由浏览器自己维护 DOM
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const finish = (commit: boolean) => {
    const node = ref.current
    if (doneRef.current || !node) return
    doneRef.current = true
    if (commit) onCommit(readText(node))
    else onCancel()
  }

  const style: CSSProperties = {
    ...(vars as unknown as CSSProperties),
    left: block.x,
    top: block.y,
    width: block.w,
    height: block.h,
    transform: block.rotation ? `rotate(${block.rotation}deg)` : undefined,
    color: `var(--d-${block.color})`,
    textAlign: block.align,
    ...(block.lineHeight ? { lineHeight: block.lineHeight } : {}),
    ...(block.tracking !== undefined ? { letterSpacing: `${block.tracking}em` } : {}),
    ...(block.weight ? { fontWeight: block.weight } : {}),
  }

  return (
    <div
      ref={ref}
      className="lumen-text stage-inline-edit"
      data-variant={block.variant}
      data-placeholder={placeholder}
      style={style}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      aria-multiline="true"
      onBlur={() => finish(true)}
      onPaste={(event) => {
        event.preventDefault()
        insertAtCaret(event.clipboardData.getData('text/plain'))
      }}
      onCompositionStart={() => {
        composingRef.current = true
      }}
      onCompositionEnd={() => {
        composingRef.current = false
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          finish(false)
          return
        }
        if (event.key === 'Enter') {
          if (event.nativeEvent.isComposing || composingRef.current) return
          if (event.metaKey || event.ctrlKey) {
            event.preventDefault()
            event.stopPropagation()
            finish(true)
            return
          }
          event.preventDefault()
          event.stopPropagation()
          insertAtCaret('\n')
          return
        }
        // 其余按键全部留在编辑器内，别让全局快捷键抢走（方向键/删除/输入法）
        event.stopPropagation()
      }}
    />
  )
}
