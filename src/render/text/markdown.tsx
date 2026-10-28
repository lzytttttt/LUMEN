/**
 * markdown.ts —— 极简内联标记：**粗** *斜* `代码` 与段落/换行。
 * 不解析 HTML，不引第三方库，输出 React 节点。
 */
import { Fragment, type ReactNode } from 'react'

const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE_RE).filter((part) => part !== '')
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={key} className="lumen-code">
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

export function renderRichText(text: string): ReactNode {
  const paragraphs = text.split(/\n{2,}/)
  return paragraphs.map((paragraph, pIndex) => {
    const lines = paragraph.split('\n')
    return (
      <p key={`p-${pIndex}`} className="lumen-para">
        {lines.map((line, lIndex) => (
          <Fragment key={`l-${lIndex}`}>
            {lIndex > 0 ? <br /> : null}
            {renderInline(line, `i-${pIndex}-${lIndex}`)}
          </Fragment>
        ))}
      </p>
    )
  })
}

/** 纯文本长度（用于 lint 的字数估算）。 */
export function plainText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}
