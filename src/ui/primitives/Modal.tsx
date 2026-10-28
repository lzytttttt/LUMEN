import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  closeLabel?: string
}

export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md', closeLabel = 'Close' }: ModalProps) {
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    requestAnimationFrame(() => {
      const focusable = bodyRef.current?.querySelector<HTMLElement>(
        'input, textarea, select, button:not([disabled])',
      )
      focusable?.focus()
    })
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div
      className="lm-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={`lm-modal${size === 'sm' ? ' lm-modal--sm' : size === 'lg' ? ' lm-modal--lg' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="lm-modal__head">
          <div>
            <h2 className="lm-modal__title">{title}</h2>
            {subtitle ? <p className="lm-modal__subtitle">{subtitle}</p> : null}
          </div>
          <button type="button" className="lm-icon-btn" onClick={onClose} aria-label={closeLabel} title={closeLabel}>
            <X size={16} />
          </button>
        </div>
        <div className="lm-modal__body lm-scroll" ref={bodyRef}>
          {children}
        </div>
        {footer ? <div className="lm-modal__foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}
