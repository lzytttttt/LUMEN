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

/** 可聚焦元素选择器（Tab 循环用；不含 disabled / tabindex=-1 / hidden）。 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 当前打开的 Modal 栈（v0.4.0，A-40-03/G7）：
 * - Tab 在弹窗内循环、不逃到背景页；
 * - Esc 只由**最上层**弹窗处理（权限卡叠在管理弹窗上时先关卡）；
 * - 关闭后焦点回到打开前的触发元素。
 */
const modalStack: symbol[] = []

function focusablesOf(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('aria-hidden') && el.offsetParent !== null,
  )
}

export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md', closeLabel = 'Close' }: ModalProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const tokenRef = useRef<symbol>(Symbol('modal'))

  useEffect(() => {
    if (!open) return
    const token = tokenRef.current
    const returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null
    modalStack.push(token)

    const onKey = (event: KeyboardEvent) => {
      const isTop = modalStack[modalStack.length - 1] === token
      if (!isTop) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key === 'Tab') {
        const items = focusablesOf(modalRef.current)
        if (items.length === 0) {
          event.preventDefault()
          return
        }
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement as HTMLElement | null
        const inside = active !== null && modalRef.current?.contains(active) === true
        if (event.shiftKey) {
          if (!inside || active === first) {
            event.preventDefault()
            last.focus()
          }
        } else if (!inside || active === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }

    window.addEventListener('keydown', onKey, true)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const raf = requestAnimationFrame(() => {
      const items = focusablesOf(modalRef.current)
      if (items.length > 0) items[0].focus()
      else modalRef.current?.focus()
    })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey, true)
      const index = modalStack.lastIndexOf(token)
      if (index >= 0) modalStack.splice(index, 1)
      document.body.style.overflow = previousOverflow
      if (returnTarget && returnTarget.isConnected) returnTarget.focus()
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
        tabIndex={-1}
        ref={modalRef}
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
