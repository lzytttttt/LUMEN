import type { ReactNode } from 'react'

export function Section({
  title,
  actions,
  children,
}: {
  title?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="lm-section">
      {(title || actions) && (
        <div className="lm-section__head">
          {title ? <span className="lm-section__title">{title}</span> : <span />}
          {actions}
        </div>
      )}
      <div className="lm-section__body">{children}</div>
    </section>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  inline,
}: {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
  htmlFor?: string
  inline?: boolean
}) {
  return (
    <div className={inline ? 'lm-field lm-field--row' : 'lm-field'}>
      {label !== undefined && (
        <label className="lm-field__label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {error ? <span className="lm-field__error">{error}</span> : null}
      {hint && !error ? <span className="lm-field__hint">{hint}</span> : null}
    </div>
  )
}

export function Row({ cols = 2, children }: { cols?: 2 | 3 | 4; children: ReactNode }) {
  return <div className={`lm-row lm-row--${cols}`}>{children}</div>
}

export function PanelHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="lm-panel-head">
      <div className="lm-panel-head__text">
        <div className="lm-panel-head__title">{title}</div>
        {subtitle ? <div className="lm-panel-head__subtitle">{subtitle}</div> : null}
      </div>
      {actions ? <div className="lm-panel-head__actions">{actions}</div> : null}
    </div>
  )
}
