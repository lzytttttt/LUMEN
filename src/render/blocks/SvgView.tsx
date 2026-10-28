/**
 * blocks/SvgView.tsx —— SVG 块。
 *
 * - 净化入口唯一：`sanitizeSvgDocument`（本层不做第二次 DOM 注入，只补字符串级外壳）。
 * - `animate='draw'` 只在 `mode='play'`、非 reduced-motion 时跑描边生长。
 * - 空/非法内容降级为占位；净化被清理的条目数量以克制的角标显示（仅编辑态）。
 */
import { useEffect, useMemo, useRef } from 'react'
import type { SvgBlock } from '@/schema/deck'
import { sanitizeSvgDocument } from '../svg/sanitize'
import { ensureSvgFrame, prefersReducedMotion } from '../svg/frame'
import { runSvgDrawAnimation } from '../svg/draw'
import type { RenderMode } from '../types'

export function SvgView({ block, mode }: { block: SvgBlock; mode: RenderMode }) {
  const result = useMemo(() => sanitizeSvgDocument(block.source), [block.source])
  const frame = useMemo(
    () => (result.svg ? ensureSvgFrame(result.svg, block.viewBox) : null),
    [result.svg, block.viewBox],
  )
  const hostRef = useRef<HTMLDivElement | null>(null)

  const animate = mode === 'play' ? block.animate : 'none'

  // 描边生长：只在播放态、且声明 draw 时执行。
  useEffect(() => {
    const host = hostRef.current
    if (!host || !frame) return
    if (mode !== 'play' || block.animate !== 'draw') return
    if (prefersReducedMotion()) return
    return runSvgDrawAnimation(host)
  }, [mode, block.animate, frame])

  if (!frame) {
    // 空/超限/解析失败：给一个克制的降级视图，诊断细节放在 title 里（面板负责正式文案）
    const reason = result.issues[0]?.level ?? 'parse'
    return (
      <div
        className="lumen-placeholder"
        data-svg-empty="true"
        data-svg-reason={reason}
        title={result.issues.map((issue) => issue.message).join('\n')}
      >
        <strong>SVG</strong>
        <span>{reason}</span>
      </div>
    )
  }

  const issues = result.issues
  const showBadge = mode === 'stage' && issues.length > 0
  const aspect = frame.aspect

  return (
    <div className="lumen-svg-wrap">
      <div
        ref={hostRef}
        className="lumen-svg"
        data-animate={animate}
        data-mode={mode}
        data-viewbox={frame.viewBox.join(' ')}
        data-aspect={aspect ? aspect.toFixed(3) : undefined}
        data-issues={issues.length > 0 ? String(issues.length) : undefined}
        dangerouslySetInnerHTML={{ __html: frame.markup }}
      />
      {showBadge ? (
        <span
          className="lumen-svg__badge"
          title={issues
            .slice(0, 4)
            .map((issue) => issue.message)
            .join('\n')}
        >
          {issues.length}
        </span>
      ) : null}
    </div>
  )
}
