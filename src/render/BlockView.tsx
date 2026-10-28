/**
 * BlockView.tsx —— 块类型分发（唯一渲染入口的内部实现）。
 * 每一类块的具体实现见 ./blocks/*；这里只负责分派与主题色下沉。
 */
import type { Block, Theme, ThemeColors } from '@/schema/deck'
import { getTheme } from '@/themes'
import { TextView } from './blocks/TextView'
import { ShapeView } from './blocks/ShapeView'
import { ImageView } from './blocks/ImageView'
import { SvgView } from './blocks/SvgView'
import { ThreeView } from './blocks/ThreeView'
import { HtmlView } from './blocks/HtmlView'
import type { RenderMode } from './types'

export interface BlockViewProps {
  block: Block
  mode: RenderMode
  slideActive: boolean
  /** 当前主题（3D 取色用）；缺省退回默认主题。 */
  theme?: Theme
  /** 主题色（已合并 deck.themeOverrides）；缺省用 theme.colors。 */
  colors?: ThemeColors
}

export function BlockView({ block, mode, slideActive, theme, colors }: BlockViewProps) {
  switch (block.type) {
    case 'text':
      return <TextView block={block} />
    case 'shape':
      return <ShapeView block={block} />
    case 'image':
      return <ImageView block={block} />
    case 'svg':
      return <SvgView block={block} mode={mode} />
    case 'three':
      return (
        <ThreeView
          block={block}
          mode={mode}
          slideActive={slideActive}
          colors={colors ?? theme?.colors ?? getTheme(null).colors}
        />
      )
    case 'html':
      return <HtmlView block={block} mode={mode} />
    default:
      return <div className="lumen-placeholder">Unknown block</div>
  }
}

/** HTML 块文档组装（导出/播放器也会用同一份 CSP 与外壳）。 */
export { composeHtmlDoc, HTML_HEIGHT_MESSAGE } from './blocks/HtmlView'
