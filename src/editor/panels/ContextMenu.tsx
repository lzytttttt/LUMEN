/**
 * ContextMenu.tsx —— 幕栏/图层共用的右键菜单（portal + 视口翻转 + Esc/外点关闭）。
 * 不引入新依赖，也不复用 Popover：右键菜单需要跟随光标而非锚点元素。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
  onSelect: () => void
}

export interface ContextMenuProps {
  open: boolean
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
  width?: number
}

export function ContextMenu({ open, x, y, items, onClose, width = 190 }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: y, left: x })

  useLayoutEffect(() => {
    if (!open) return
    const node = ref.current
    const w = width
    const h = node?.offsetHeight ?? items.length * 30 + 12
    const left = Math.max(6, Math.min(x, window.innerWidth - w - 6))
    let top = y
    if (top + h > window.innerHeight - 6) top = Math.max(6, y - h)
    setPos({ top, left })
  }, [open, x, y, width, items.length])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const onScroll = () => onClose()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      ref={ref}
      className="lmp-menu"
      style={{ top: pos.top, left: pos.left, width }}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore ? <div className="lmp-menu__sep" /> : null}
          <button
            type="button"
            role="menuitem"
            className={
              item.danger ? 'lmp-menu__row lmp-menu__row--danger' : 'lmp-menu__row'
            }
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
              item.onSelect()
              onClose()
            }}
          >
            <span className="lmp-menu__icon">{item.icon}</span>
            <span className="lmp-menu__label">{item.label}</span>
            {item.shortcut ? <span className="lmp-menu__shortcut">{item.shortcut}</span> : null}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}
