/**
 * svg/SvgPreview.tsx —— 工作室里的 SVG 预览（净化产物 + 主题令牌 + 选中高亮 + 动效）。
 *
 * 约定：
 * - 只吃**净化过**的 markup（调用方负责 sanitize），这里不再引入第二条注入路径；
 * - 预览里带 `data-lumen-node` 标记，选中节点用一个测量出来的浮层框起来（不改内容）；
 * - 动效复用渲染层的语义：float / pulse / spinSlow 由同名 CSS 驱动，draw 复用 `runSvgDrawAnimation`。
 */
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react'
import { runSvgDrawAnimation } from '@/render/svg/draw'
import { prefersReducedMotion } from '@/render/svg/frame'
import type { SvgBlock } from '@/schema/deck'
import type { ViewBoxTuple } from './document'

export interface SvgPreviewProps {
  /** 净化后（可带 data-lumen-node 标记）的源码。 */
  markup: string
  viewBox: ViewBoxTuple
  animate: SvgBlock['animate']
  /** 主题令牌 CSS 变量表（--d-*）。 */
  cssVars: Record<string, string>
  selectedIndex: number | null
  onPickNode?: (index: number) => void
  onDropFile?: (file: File) => void
  emptyLabel?: string
}

interface SelectionBox {
  left: number
  top: number
  width: number
  height: number
}

export function SvgPreview({
  markup,
  viewBox,
  animate,
  cssVars,
  selectedIndex,
  onPickNode,
  onDropFile,
  emptyLabel,
}: SvgPreviewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [box, setBox] = useState<SelectionBox | null>(null)
  const [dropping, setDropping] = useState(false)

  // 尺寸变化 → 重新量高亮框
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => setSize({ w: host.clientWidth, h: host.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  // 选中节点 → 用包围盒做一个浮层（不走改源码那条路）
  useEffect(() => {
    const host = hostRef.current
    if (!host || selectedIndex === null) {
      setBox(null)
      return
    }
    const node = host.querySelector<SVGGraphicsElement>(`[data-lumen-node="${selectedIndex}"]`)
    if (!node) {
      setBox(null)
      return
    }
    try {
      const hostRect = host.getBoundingClientRect()
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 && rect.height <= 0) {
        setBox(null)
        return
      }
      setBox({
        left: rect.left - hostRect.left,
        top: rect.top - hostRect.top,
        width: rect.width,
        height: rect.height,
      })
    } catch {
      setBox(null)
    }
  }, [selectedIndex, markup, size.w, size.h])

  // 描边生长：只在这个预览里跑，不改动源码
  useEffect(() => {
    const host = hostRef.current
    if (!host || animate !== 'draw' || markup === '') return
    if (prefersReducedMotion()) return
    return runSvgDrawAnimation(host)
  }, [markup, animate])

  const pick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onPickNode) return
    const target = event.target as Element | null
    const node = target?.closest?.('[data-lumen-node]')
    if (!node) return
    const raw = node.getAttribute('data-lumen-node')
    const index = raw === null ? Number.NaN : Number.parseInt(raw, 10)
    if (Number.isFinite(index)) onPickNode(index)
  }

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDropping(false)
    const file = event.dataTransfer?.files?.[0]
    if (file && onDropFile) onDropFile(file)
  }

  return (
    <div
      className="st-preview"
      data-dropping={dropping ? 'true' : undefined}
      style={cssVars as CSSProperties}
      onDragOver={(event) => {
        if (!onDropFile) return
        event.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={drop}
    >
      <div className="st-preview__stage" data-viewbox={viewBox.join(' ')}>
        {markup === '' ? (
          <div className="st-preview__empty">{emptyLabel}</div>
        ) : (
          <div
            ref={hostRef}
            className="st-preview__canvas"
            data-animate={animate}
            onClick={pick}
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        )}
        {box ? (
          <span
            className="st-preview__selbox"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            aria-hidden="true"
          />
        ) : null}
      </div>
      {dropping ? <div className="st-preview__drop">{emptyLabel}</div> : null}
    </div>
  )
}
