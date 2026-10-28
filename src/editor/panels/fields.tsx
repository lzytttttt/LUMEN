/**
 * fields.tsx —— 检查器内部的小控件（令牌色板、对齐、可选数值）。
 * 只做组合，不放业务逻辑；业务提交一律走 state/ops。
 */
import type { ReactNode } from 'react'
import { AlignCenter, AlignLeft, AlignRight, RotateCcw } from 'lucide-react'
import type { ColorToken } from '@/schema/deck'
import { useT } from '@/i18n'
import { IconButton, NumberInput, Segmented } from '@/ui/primitives'

export const TOKEN_SWATCHES: { token: ColorToken; label: string; css: string }[] = [
  { token: 'fg', label: 'fg', css: 'var(--d-fg)' },
  { token: 'muted', label: 'muted', css: 'var(--d-muted)' },
  { token: 'accent', label: 'accent', css: 'var(--d-accent)' },
  { token: 'accent2', label: 'accent2', css: 'var(--d-accent2)' },
  { token: 'surface', label: 'surface', css: 'var(--d-surface)' },
  { token: 'line', label: 'line', css: 'var(--d-line)' },
  { token: 'bg', label: 'bg', css: 'var(--d-bg)' },
]

export type TextAlign = 'left' | 'center' | 'right'

export function AlignControl({
  value,
  onValueChange,
}: {
  value: TextAlign
  onValueChange: (align: TextAlign) => void
}) {
  const t = useT()
  return (
    <Segmented
      value={value}
      onValueChange={onValueChange}
      options={[
        { value: 'left', label: <AlignLeft size={13} />, title: t('editor.inspector.alignKinds.left') },
        { value: 'center', label: <AlignCenter size={13} />, title: t('editor.inspector.alignKinds.center') },
        { value: 'right', label: <AlignRight size={13} />, title: t('editor.inspector.alignKinds.right') },
      ]}
    />
  )
}

/**
 * 可选数值：schema 里这些字段可以是 undefined（表示继承主题）。
 * 显示 fallback，但只有在用户真的改动时才写入；右侧按钮清回 undefined。
 */
export function OptionalNumber({
  value,
  fallback,
  min,
  max,
  step,
  suffix,
  onValueChange,
  onClear,
}: {
  value: number | undefined
  fallback: number
  min?: number
  max?: number
  step?: number
  suffix?: string
  onValueChange: (value: number) => void
  onClear: () => void
}) {
  const t = useT()
  return (
    <div className="insp-inline">
      <NumberInput
        value={value ?? fallback}
        min={min}
        max={max}
        step={step}
        suffix={suffix}
        onValueChange={onValueChange}
      />
      <IconButton
        size="sm"
        icon={<RotateCcw size={12} />}
        label={t('editor.inspector.auto')}
        disabled={value === undefined}
        onClick={onClear}
      />
    </div>
  )
}

export function InlineRow({ children }: { children: ReactNode }) {
  return <div className="insp-actions">{children}</div>
}
