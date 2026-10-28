/**
 * CodeEditor.tsx —— CodeMirror 6 的薄封装（编辑器/工作室/弹窗共用的唯一代码输入口）。
 *
 * 设计要点：
 * - CodeMirror 走**动态 import**，不进首屏 bundle；加载失败时降级为原生 textarea，绝不白屏。
 * - 受控更新只在「外部 value 真的变了」时 dispatch，避免打字时整篇重设导致光标跳动。
 * - 卸载销毁 EditorView；Tab 插入两个空格而不是跳焦点；暗色 one-dark 与工作台一致。
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { EditorView } from 'codemirror'
import './code.css'

export type CodeLanguage = 'html' | 'svg' | 'css' | 'json'

export interface CodeEditorProps {
  value: string
  language: CodeLanguage
  /** isTyping=true 表示来自用户的连续输入（用于合并撤销步）。 */
  onChange: (value: string, isTyping: boolean) => void
  height?: number | string
  readOnly?: boolean
  ariaLabel?: string
}

type EditorStatus = 'loading' | 'ready' | 'failed'

const LANGUAGE_LABEL: Record<CodeLanguage, string> = {
  html: 'HTML',
  svg: 'SVG',
  css: 'CSS',
  json: 'JSON',
}

export function CodeEditor({
  value,
  language,
  onChange,
  height = 320,
  readOnly = false,
  ariaLabel,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  /** 最近一次「已知」的文本：外部变化与内部输入共用，用来判断是否需要 dispatch。 */
  const knownValue = useRef(value)
  const onChangeRef = useRef(onChange)
  const [status, setStatus] = useState<EditorStatus>('loading')

  onChangeRef.current = onChange

  useEffect(() => {
    let disposed = false
    const host = hostRef.current
    if (!host) return
    setStatus('loading')

    void (async () => {
      try {
        const [cm, htmlLang, jsonLang, oneDark] = await Promise.all([
          import('codemirror'),
          import('@codemirror/lang-html'),
          import('@codemirror/lang-json'),
          import('@codemirror/theme-one-dark'),
        ])
        if (disposed || !hostRef.current) return

        const { EditorView: View, basicSetup } = cm
        const extensions: unknown[] = [
          basicSetup,
          oneDark.oneDark,
          View.lineWrapping,
          View.theme({
            '&': { height: '100%', fontSize: '12.5px', background: 'transparent' },
            '.cm-scroller': {
              fontFamily: 'var(--ui-font-mono)',
              lineHeight: '1.55',
              overflow: 'auto',
            },
            '.cm-gutters': {
              background: 'transparent',
              borderRight: '1px solid var(--ui-line)',
              color: 'var(--ui-fg-mute)',
            },
            '.cm-content': { caretColor: 'var(--ui-accent)' },
            '&.cm-focused': { outline: 'none' },
          }),
          View.updateListener.of((update) => {
            if (!update.docChanged) return
            const next = update.state.doc.toString()
            if (next === knownValue.current) return
            knownValue.current = next
            const typing = update.transactions.some(
              (transaction) =>
                transaction.isUserEvent('input') ||
                transaction.isUserEvent('delete') ||
                transaction.isUserEvent('delete.selection'),
            )
            onChangeRef.current(next, typing)
          }),
        ]

        if (readOnly) extensions.unshift(View.editable.of(false))
        if (language === 'json') extensions.unshift(jsonLang.json())
        // html/svg 共用 HTML 语言支持；css 暂无独立语言包（不新增依赖），退回纯文本 + 括号匹配。
        else if (language === 'html' || language === 'svg') extensions.unshift(htmlLang.html())

        const view = new View({
          doc: value,
          extensions: extensions as never,
          parent: hostRef.current,
        })
        if (ariaLabel) view.contentDOM.setAttribute('aria-label', ariaLabel)
        viewRef.current = view
        knownValue.current = value
        setStatus('ready')
      } catch (error) {
        if (!disposed) {
          setStatus('failed')
          console.warn('[CodeEditor] CodeMirror 加载失败，已降级为纯文本输入', error)
        }
      }
    })()

    return () => {
      disposed = true
      viewRef.current?.destroy()
      viewRef.current = null
    }
    // 语言/只读变更时重建视图：静态扩展无法热替换（不引入 @codemirror/state 的 Compartment）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly])

  // 外部 value → 编辑器（仅在确实不同的时候 dispatch，保持光标与选区）。
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (value === knownValue.current) return
    const current = view.state.doc.toString()
    if (current === value) {
      knownValue.current = value
      return
    }
    // 先记下「已知值」再 dispatch：updateListener 里据此判断这不是用户输入，避免回环。
    knownValue.current = value
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value, status])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || readOnly) return
    const view = viewRef.current
    if (!view) return
    event.preventDefault()
    view.dispatch(view.state.replaceSelection('  '))
    view.focus()
  }

  const style: CSSProperties = { height: typeof height === 'number' ? `${height}px` : height }

  return (
    <div
      className="lcm"
      style={style}
      data-language={language}
      data-status={status}
      data-readonly={readOnly ? 'true' : undefined}
      onKeyDown={handleKeyDown}
    >
      <div className="lcm__host" ref={hostRef} hidden={status === 'failed'} />
      {status === 'loading' ? (
        <div className="lcm__loading" aria-live="polite">
          <span className="lcm__dot" />
          {LANGUAGE_LABEL[language]}
        </div>
      ) : null}
      {status === 'failed' ? (
        <textarea
          className="lcm__fallback"
          value={value}
          readOnly={readOnly}
          aria-label={ariaLabel}
          spellCheck={false}
          onChange={(event) => {
            knownValue.current = event.target.value
            onChange(event.target.value, true)
          }}
        />
      ) : null}
    </div>
  )
}

export default CodeEditor
