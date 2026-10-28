/** blocks/TextView.tsx —— 文本块：内联标记 + 主题字号阶。 */
import type { TextBlock } from '@/schema/deck'
import { renderRichText } from '../text/markdown'

export function TextView({ block }: { block: TextBlock }) {
  const style = {
    color: `var(--d-${block.color})`,
    textAlign: block.align,
    ...(block.lineHeight ? { lineHeight: block.lineHeight } : {}),
    ...(block.tracking !== undefined ? { letterSpacing: `${block.tracking}em` } : {}),
    ...(block.weight ? { fontWeight: block.weight } : {}),
  } as const
  return (
    <div className="lumen-text" data-variant={block.variant} style={style}>
      {renderRichText(block.text)}
    </div>
  )
}
