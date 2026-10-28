import { useUiStore } from '@/state/uiStore'

/** 全局 Toast 栈（数据在 uiStore，渲染在 App 根部）。 */
export function Toasts() {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div className="lm-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`lm-toast lm-toast--${toast.kind}`}>
          <span className="lm-toast__dot" />
          <span className="lm-toast__msg">{toast.message}</span>
          {toast.actionLabel && toast.action ? (
            <button
              type="button"
              className="lm-toast__action"
              onClick={() => {
                toast.action?.()
                dismiss(toast.id)
              }}
            >
              {toast.actionLabel}
            </button>
          ) : null}
          <button type="button" className="lm-icon-btn lm-icon-btn--sm" onClick={() => dismiss(toast.id)} aria-label="close">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
