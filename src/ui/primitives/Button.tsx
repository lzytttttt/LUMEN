import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'subtle' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  block?: boolean
  active?: boolean
}

export function Button({
  variant = 'subtle',
  size = 'md',
  icon,
  block,
  active,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    'lm-btn',
    `lm-btn--${variant}`,
    size === 'sm' ? 'lm-btn--sm' : '',
    block ? 'lm-btn--block' : '',
    active ? 'lm-btn--active' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button type={type} className={classes} {...rest}>
      {icon}
      {children}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode
  label: string
  active?: boolean
  size?: 'sm' | 'md'
  tone?: 'default' | 'danger'
}

export function IconButton({
  icon,
  label,
  active,
  size = 'md',
  tone = 'default',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const classes = [
    'lm-icon-btn',
    size === 'sm' ? 'lm-icon-btn--sm' : '',
    active ? 'lm-icon-btn--active' : '',
    tone === 'danger' ? 'lm-icon-btn--danger' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button type={type} className={classes} title={label} aria-label={label} aria-pressed={active} {...rest}>
      {icon}
    </button>
  )
}
