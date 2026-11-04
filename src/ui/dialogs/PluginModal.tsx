/**
 * PluginModal.tsx —— 插件 UI 专用弹窗外壳（shell-ui 域）。
 *
 * 为什么不复用 `ui/primitives` 的 Modal：
 * - 06 §3.1/§4.7 的 e2e 需要把 `data-plugin-manager` / `data-plugin-permission-card`
 *   等钩子挂在**整个弹窗根**（含头部关闭键与 footer 按钮），通用 Modal 不接收 data-*；
 * - 插件弹窗需要**焦点陷阱**（Tab/Shift+Tab 在根内循环、不逃到外壳）、多层弹窗 Esc 只关最上层、
 *   关闭后焦点归还（`useReturnFocus` 已覆盖归还）；
 * - 视觉完全复用 `.lm-modal*` 类，与内置弹窗逐像素同族（不另写样式）。
 *
 * 层级语义：模块级栈 `openStack`，只有栈顶弹窗响应 Esc / 焦点循环；
 * 打开本组件前请确保 `open` 的父级已渲染（嵌套弹窗天然成为栈顶）。
 */
import {
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export interface PluginModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  closeLabel?: string
  /** 额外 data-* 钩子（挂到 `.lm-modal` 根上，e2e 用）。 */
  dataHooks?: Record<string, string>
  /** 初始焦点目标；缺省 = 根内第一个可见可聚焦元素。 */
  initialFocus?: RefObject<HTMLElement | null>
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const openStack: symbol[] = []
let scrollLockCount = 0

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (node) => !node.hasAttribute('hidden') && node.offsetParent !== null && node.getAttribute('aria-hidden') !== 'true',
  )
}

export function PluginModal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
  closeLabel = 'Close',
  dataHooks,
  initialFocus,
}: PluginModalProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const tokenRef = useRef<symbol>(Symbol('plugin-modal'))
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    if (!open) return
    const token = tokenRef.current
    openStack.push(token)
    scrollLockCount += 1
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // 首焦点：同步（layout 阶段）落到弹窗内，满足 e2e「打开即焦点在管理器内」。
    const root = rootRef.current
    const target = initialFocus?.current ?? focusableIn(root)[0] ?? root
    target?.focus?.({ preventScroll: true } as FocusOptions)

    const onKeyDown = (event: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== token) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const node = rootRef.current
      if (!node) return
      const items = focusableIn(node)
      if (items.length === 0) {
        event.preventDefault()
        node.focus({ preventScroll: true })
        return
      }
      const active = document.activeElement as HTMLElement | null
      const index = active ? items.indexOf(active) : -1
      event.preventDefault()
      if (event.shiftKey) {
        items[index <= 0 ? items.length - 1 : index - 1]?.focus()
      } else {
        items[index < 0 || index === items.length - 1 ? 0 : index + 1]?.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      openStack.pop()
      scrollLockCount = Math.max(0, scrollLockCount - 1)
      if (scrollLockCount === 0) document.body.style.overflow = previousOverflow
    }
  }, [open, initialFocus])

  if (!open) return null

  const modalClass = [
    'lm-modal',
    size === 'sm' ? 'lm-modal--sm' : size === 'lg' ? 'lm-modal--lg' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return createPortal(
    <div
      className="lm-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={rootRef}
        className={modalClass}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        {...(dataHooks as HTMLAttributes<HTMLDivElement>)}
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
        <div className="lm-modal__body lm-scroll">{children}</div>
        {footer ? <div className="lm-modal__foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}
