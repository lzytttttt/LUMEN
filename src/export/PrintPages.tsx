/**
 * PrintPages.tsx —— 打印页视图：全部幕首尾相接、每幕 1600×900、逐页分页。
 *
 * 两个宿主共用：
 * - 应用内 `PrintHost`（`?print=1` 路由 / 导出弹窗触发）；
 * - 独立 HTML 播放器内核（`?print=1` 或 `#print`）。
 *
 * 只做"画"，不做打印时机控制——`window.print()` 由宿主在准备就绪后调。
 *
 * `PrintLayer` 把打印页 portal 到 `document.body`：打印时 `body > *:not(.lumen-print-layer)`
 * 一律 `display:none`，而分页必须发生在普通文档流里（绝对/固定定位的祖先会打断分页）。
 */
import { useEffect, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Deck } from '@/schema/deck'
import { SlideRenderer } from '@/render/SlideRenderer'
import { getTheme, themeCssVars } from '@/themes'

export interface PrintPagesProps {
  deck: Deck
}

export function PrintPages({ deck }: PrintPagesProps): JSX.Element {
  const theme = getTheme(deck.themeId)
  const vars = themeCssVars(theme, deck.themeOverrides) as CSSProperties

  return (
    <div className="lumen-print" style={vars} data-print-pages={deck.slides.length} data-theme={theme.id}>
      {deck.slides.map((slide, index) => (
        <div className="lumen-print__page" data-print-page={index + 1} data-slide-id={slide.id} key={slide.id}>
          <SlideRenderer deck={deck} slide={slide} mode="print" active={false} />
        </div>
      ))}
    </div>
  )
}

/** 打印层：portal 到 body，打印时是唯一参与布局的节点。 */
export function PrintLayer({ children }: { children: ReactNode }): JSX.Element | null {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = document.createElement('div')
    node.className = 'lumen-print-layer'
    node.setAttribute('data-print-layer', '1')
    document.body.appendChild(node)
    setLayer(node)
    return () => {
      node.remove()
      setLayer(null)
    }
  }, [])

  if (!layer) return null
  return createPortal(children, layer)
}
