/**
 * blockLabels.ts —— 块的「人类可读名字」。
 * 只用于面板展示（图层列表、属性页标题），不写回 deck，所以不参与 i18n 类型源之外的逻辑。
 */
import type { Block } from '@/schema/deck'
import type { MessageKey } from '@/i18n'

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string

export function blockLabelOf(block: Block, t: Translate): string {
  if (block.name && block.name.trim() !== '') return block.name
  switch (block.type) {
    case 'text':
      return block.text.replace(/\s+/g, ' ').trim().slice(0, 26) || t('editor.inspector.untitledText')
    case 'shape':
      return t(`editor.inspector.shapeKinds.${block.kind}` as MessageKey)
    case 'image':
      return block.caption?.trim() || block.alt?.trim() || t('editor.inspector.untitledImage')
    case 'svg':
      return block.presetId ?? t('editor.inspector.untitledSvg')
    case 'three':
      return t(`studio.three.presets.${block.descriptor.preset}` as MessageKey)
    case 'html':
      return t('editor.inspector.untitledHtml')
  }
  return 'block'
}
