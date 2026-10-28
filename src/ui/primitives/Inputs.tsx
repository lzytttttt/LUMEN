import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import type { ColorToken } from '@/schema/deck'

/* --------------------------------- Inputs --------------------------------- */

export function TextInput({
  value,
  onValueChange,
  mono,
  suffix,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
  mono?: boolean
  suffix?: string
}) {
  const classes = ['lm-input', mono ? 'lm-input--mono' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <span className="lm-input-wrap">
      <input className={classes} value={value} onChange={(e) => onValueChange(e.target.value)} {...rest} />
      {suffix ? <span className="lm-input-wrap__suffix">{suffix}</span> : null}
    </span>
  )
}

export function TextArea({
  value,
  onValueChange,
  mono,
  rows = 4,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
  mono?: boolean
}) {
  const classes = ['lm-textarea', mono ? 'lm-textarea--mono' : ''].filter(Boolean).join(' ')
  return (
    <textarea
      className={classes}
      rows={rows}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      {...rest}
    />
  )
}

/**
 * 数字输入：本地保留输入中间态（避免 "0." 被格式化掉），失焦或回车提交。
 */
export function NumberInput({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  suffix,
  disabled,
}: {
  value: number
  onValueChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  disabled?: boolean
}) {
  const [draft, setDraft] = useState(String(round(value)))
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setDraft(String(round(value)))
  }, [value])

  const commit = (raw: string) => {
    const parsed = Number.parseFloat(raw)
    if (Number.isNaN(parsed)) {
      setDraft(String(round(value)))
      return
    }
    let next = parsed
    if (min !== undefined) next = Math.max(min, next)
    if (max !== undefined) next = Math.min(max, next)
    onValueChange(next)
    setDraft(String(round(next)))
  }

  return (
    <span className="lm-input-wrap">
      <input
        className="lm-input lm-input--number"
        type="number"
        inputMode="decimal"
        step={step}
        value={draft}
        disabled={disabled}
        onFocus={() => {
          focused.current = true
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          focused.current = false
          commit(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          }
          if (e.key === 'Escape') {
            setDraft(String(round(value)))
            e.currentTarget.blur()
          }
        }}
      />
      {suffix ? <span className="lm-input-wrap__suffix">{suffix}</span> : null}
    </span>
  )
}

function round(v: number): number {
  return Math.round(v * 10) / 10
}

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  disabled,
}: {
  value: T
  onValueChange: (value: T) => void
  options: { value: T; label: string }[]
  disabled?: boolean
}) {
  return (
    <select
      className="lm-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.target.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  block,
}: {
  value: T
  onValueChange: (value: T) => void
  options: { value: T; label: ReactNode; title?: string }[]
  block?: boolean
}) {
  return (
    <div className={block ? 'lm-segmented lm-segmented--block' : 'lm-segmented'} role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          title={option.title}
          className={
            value === option.value
              ? 'lm-segmented__item lm-segmented__item--active'
              : 'lm-segmented__item'
          }
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? 'lm-switch lm-switch--on' : 'lm-switch'}
      onClick={() => onCheckedChange(!checked)}
    />
  )
}

export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 1,
  step = 0.01,
  ariaLabel,
}: {
  value: number
  onValueChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  ariaLabel?: string
}) {
  return (
    <input
      className="lm-slider"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onValueChange(Number(e.target.value))}
    />
  )
}

/* ------------------------------- Color tokens ------------------------------ */

export function ColorSwatches({
  value,
  onValueChange,
  colors,
  allowNone,
  noneLabel,
}: {
  value: ColorToken | undefined
  onValueChange: (token: ColorToken | undefined) => void
  colors: { token: ColorToken; css: string; label: string }[]
  allowNone?: boolean
  noneLabel?: string
}) {
  return (
    <div className="lm-swatches">
      {colors.map((color) => (
        <button
          key={color.token}
          type="button"
          title={color.label}
          aria-label={color.label}
          aria-pressed={value === color.token}
          className={
            value === color.token ? 'lm-swatch lm-swatch--active' : 'lm-swatch'
          }
          style={{ background: color.css }}
          onClick={() => onValueChange(color.token)}
        />
      ))}
      {allowNone ? (
        <button
          type="button"
          title={noneLabel ?? 'none'}
          aria-label={noneLabel ?? 'none'}
          aria-pressed={value === undefined}
          className={value === undefined ? 'lm-swatch lm-swatch--active' : 'lm-swatch'}
          style={{ background: 'transparent' }}
          onClick={() => onValueChange(undefined)}
        >
          <span className="lm-swatch__none" />
        </button>
      ) : null}
    </div>
  )
}
