import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface PopoverProps {
  open: boolean
  onClose: () => void
  anchor: HTMLElement | null
  children: ReactNode
  align?: 'start' | 'end'
  width?: number
}

/** 轻量浮层：锚点定位 + 外部点击/Esc 关闭 + 视口内翻转。 */
export function Popover({ open, onClose, anchor, children, align = 'start', width }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  useLayoutEffect(() => {
    if (!open || !anchor) return
    const rect = anchor.getBoundingClientRect()
    const node = ref.current
    const w = width ?? node?.offsetWidth ?? 200
    const h = node?.offsetHeight ?? 160
    let left = align === 'start' ? rect.left : rect.right - w
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    let top = rect.bottom + 6
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6)
    setPos({ top, left })
  }, [open, anchor, align, width])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (ref.current?.contains(target)) return
      if (anchor?.contains(target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, anchor])

  if (!open) return null
  return createPortal(
    <div ref={ref} className="lm-popover" style={{ top: pos.top, left: pos.left, width }}>
      {children}
    </div>,
    document.body,
  )
}

export function PopoverRow({
  children,
  onClick,
  active,
  icon,
}: {
  children: ReactNode
  onClick?: () => void
  active?: boolean
  icon?: ReactNode
}) {
  return (
    <button
      type="button"
      className={active ? 'lm-popover__row lm-popover__row--active' : 'lm-popover__row'}
      onClick={onClick}
    >
      {icon}
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
    </button>
  )
}

export function PopoverSeparator() {
  return <div className="lm-popover__sep" />
}

export function PopoverLabel({ children }: { children: ReactNode }) {
  return <div className="lm-popover__label">{children}</div>
}
