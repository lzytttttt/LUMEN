/**
 * StageAlignBar.tsx —— 多选浮条：对齐 / 分布 + 选中计数。
 * 图标是自绘 16×16 SVG（不引依赖，尺寸与线宽都可控）。
 */
import type { ReactNode } from 'react'
import type { AlignMode } from '@/schema/geometry'
import { IconButton } from '@/ui/primitives'
import { useT } from '@/i18n'

const ALIGN_MODES: Array<{ mode: AlignMode; labelKey: string }> = [
  { mode: 'left', labelKey: 'editor.stage.alignLeft' },
  { mode: 'hcenter', labelKey: 'editor.stage.alignHCenter' },
  { mode: 'right', labelKey: 'editor.stage.alignRight' },
  { mode: 'top', labelKey: 'editor.stage.alignTop' },
  { mode: 'vcenter', labelKey: 'editor.stage.alignVCenter' },
  { mode: 'bottom', labelKey: 'editor.stage.alignBottom' },
]

const BARS: Record<AlignMode, Array<[number, number, number, number]>> = {
  left: [
    [6, 3, 8, 3],
    [6, 10, 5, 3],
  ],
  hcenter: [
    [3, 3, 10, 3],
    [5, 10, 6, 3],
  ],
  right: [
    [2, 3, 8, 3],
    [5, 10, 5, 3],
  ],
  top: [
    [3, 6, 3, 8],
    [10, 6, 3, 5],
  ],
  vcenter: [
    [3, 3, 3, 10],
    [10, 5, 3, 6],
  ],
  bottom: [
    [3, 2, 3, 8],
    [10, 5, 3, 5],
  ],
}

const LINES: Record<AlignMode, [number, number, number, number]> = {
  left: [2, 1, 2, 14],
  hcenter: [8, 1, 8, 14],
  right: [14, 1, 14, 14],
  top: [1, 2, 14, 2],
  vcenter: [1, 8, 14, 8],
  bottom: [1, 14, 14, 14],
}

function AlignIcon({ mode }: { mode: AlignMode }) {
  const line = LINES[mode]
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="currentColor">
      <rect x={line[0] - 0.6} y={line[1]} width="1.2" height={line[3] - line[1]} opacity="0.5" />
      {BARS[mode].map(([x, y, w, h], index) => (
        <rect key={index} x={x} y={y} width={w} height={h} rx="1" opacity={index === 0 ? 0.95 : 0.6} />
      ))}
    </svg>
  )
}

function DistributeIcon({ axis }: { axis: 'x' | 'y' }) {
  const bars =
    axis === 'x'
      ? [
          [1.5, 3, 2.6, 10],
          [6.7, 3, 2.6, 10],
          [11.9, 3, 2.6, 10],
        ]
      : [
          [3, 1.5, 10, 2.6],
          [3, 6.7, 10, 2.6],
          [3, 11.9, 10, 2.6],
        ]
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="currentColor">
      {bars.map(([x, y, w, h], index) => (
        <rect key={index} x={x} y={y} width={w} height={h} rx="1" opacity={0.75} />
      ))}
    </svg>
  )
}

export interface StageAlignBarProps {
  count: number
  onAlign: (mode: AlignMode) => void
  onDistribute: (axis: 'x' | 'y') => void
}

export function StageAlignBar({ count, onAlign, onDistribute }: StageAlignBarProps): ReactNode {
  const t = useT()
  if (count < 2) return null
  return (
    <div className="stage-alignbar" role="toolbar" aria-label={t('editor.stage.align')}>
      <span className="stage-alignbar__count">{t('editor.stage.selectionCount', { count })}</span>
      <span className="stage-alignbar__sep" />
      {ALIGN_MODES.map((item) => (
        <IconButton
          key={item.mode}
          size="sm"
          icon={<AlignIcon mode={item.mode} />}
          label={t(item.labelKey as Parameters<typeof t>[0])}
          onClick={() => onAlign(item.mode)}
        />
      ))}
      {count >= 3 ? (
        <>
          <span className="stage-alignbar__sep" />
          <IconButton
            size="sm"
            icon={<DistributeIcon axis="x" />}
            label={t('editor.stage.distributeH')}
            onClick={() => onDistribute('x')}
          />
          <IconButton
            size="sm"
            icon={<DistributeIcon axis="y" />}
            label={t('editor.stage.distributeV')}
            onClick={() => onDistribute('y')}
          />
        </>
      ) : null}
    </div>
  )
}
