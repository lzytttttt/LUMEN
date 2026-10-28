import { useMemo, type CSSProperties } from 'react'
import type { Deck, Slide, Theme, ThemeColors } from '@/schema/deck'
import { getTheme, themeCssVars } from '@/themes'
import { BlockFrame } from './BlockFrame'
import { BlockView } from './BlockView'
import type { RenderMode } from './types'
import './slide.css'

export type { RenderMode } from './types'

export interface SlideRendererProps {
  deck: Deck
  slide: Slide
  mode?: RenderMode
  /** 该幕当前是否处于"在台上"状态（播放时用来启停 3D/动效）。 */
  active?: boolean
  /** 覆盖主题（面板预览用）。 */
  theme?: Theme
  /** 编辑器中正在内联编辑的块：只有它会接收指针事件。 */
  editingBlockId?: string | null
  className?: string
  style?: CSSProperties
}

/**
 * 唯一渲染入口：编辑器舞台、缩略图、播放、打印、PNG 快照全部走这里。
 * 尺寸固定 1600×900，由调用方负责整体缩放。
 */
export function SlideRenderer({
  deck,
  slide,
  mode = 'stage',
  active = true,
  theme: themeOverride,
  editingBlockId,
  className,
  style,
}: SlideRendererProps) {
  const theme = themeOverride ?? getTheme(deck.themeId)
  const vars = useMemo(() => themeCssVars(theme, deck.themeOverrides), [theme, deck.themeOverrides])

  // 3D 取色要和 CSS 变量同源：主题 + deck 覆盖色合并后的实际色值。
  const colors = useMemo<ThemeColors>(
    () => ({ ...theme.colors, ...(deck.themeOverrides ?? {}) }),
    [theme, deck.themeOverrides],
  )

  const blocks = useMemo(
    () => [...slide.blocks].filter((b) => !b.hidden).sort((a, b) => a.z - b.z),
    [slide.blocks],
  )

  const background: CSSProperties =
    slide.background.kind === 'solid' && slide.background.color
      ? ({ '--slide-bg': `var(--d-${slide.background.color})` } as CSSProperties)
      : {}

  return (
    <div
      className={className ? `lumen-slide ${className}` : 'lumen-slide'}
      data-mode={mode}
      data-slide-id={slide.id}
      data-bg={slide.background.kind}
      data-theme={theme.id}
      style={{ ...(vars as CSSProperties), ...background, ...style }}
    >
      {blocks.map((block) => (
        <BlockFrame key={block.id} block={block} mode={mode} editing={block.id === editingBlockId}>
          <BlockView block={block} mode={mode} slideActive={active} theme={theme} colors={colors} />
        </BlockFrame>
      ))}
    </div>
  )
}
