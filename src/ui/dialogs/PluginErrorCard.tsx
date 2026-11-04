/**
 * PluginErrorCard.tsx —— 插件错误卡（D-40-18：重试 / 停用 / 看日志 三按钮）。
 *
 * 用法：
 * - 插槽宿主崩溃/隔离（plugin-core 的 SlotHost 内部也会画同款；这里给宿主壳用）
 * - 管理弹窗里 quarantined 插件的卡片
 * 文案：`plugin.errorCard.*`（06 §6.3 无实现词）。
 */
import { AlertTriangle } from 'lucide-react'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { Button } from '@/ui/primitives'

export interface PluginErrorCardProps {
  /** 标题，缺省 `plugin.errorCard.title`。 */
  titleKey?: MessageKey
  /** 原因句（本地化后的错误文案，通常来自 `pluginErrorKey(code)`）。 */
  reason?: string
  /** 原始错误码（按 06 §3.2 诊断用；不翻译）。 */
  code?: string
  failureCount?: number
  /** 三按钮；不传则不渲染对应按钮。 */
  onRetry?: () => void
  onDisable?: () => void
  onViewLogs?: () => void
  /** 额外的正文（例如隔离说明）。 */
  body?: string
  className?: string
  'data-plugin-id'?: string
}

export function PluginErrorCard({
  titleKey = 'plugin.errorCard.title',
  reason,
  code,
  failureCount,
  onRetry,
  onDisable,
  onViewLogs,
  body,
  className,
  ...rest
}: PluginErrorCardProps) {
  const t = useT()
  const classes = ['plug-error', className ?? ''].filter(Boolean).join(' ')
  return (
    <div className={classes} role="group" aria-label={t('plugin.a11y.errorCard')} {...rest}>
      <div className="plug-error__title">
        <AlertTriangle size={14} aria-hidden="true" />
        {t(titleKey)}
      </div>
      {body ? <p className="plug-error__body">{body}</p> : null}
      {reason ? (
        <p className="plug-error__body">
          {t('plugin.errorCard.reason', { reason })}
          {code ? <span className="plug-error__reason"> · {code}</span> : null}
        </p>
      ) : code ? (
        <p className="plug-error__reason">{code}</p>
      ) : null}
      {typeof failureCount === 'number' && failureCount > 0 ? (
        <p className="plug-error__body">{t('plugin.errorCard.failureCount', { count: failureCount })}</p>
      ) : null}
      {onRetry || onDisable || onViewLogs ? (
        <div className="plug-actions">
          {onRetry ? (
            <Button size="sm" variant="outline" data-plugin-error-action="retry" onClick={onRetry}>
              {t('plugin.errorCard.retry')}
            </Button>
          ) : null}
          {onDisable ? (
            <Button size="sm" variant="ghost" data-plugin-error-action="disable" onClick={onDisable}>
              {t('plugin.errorCard.disable')}
            </Button>
          ) : null}
          {onViewLogs ? (
            <Button size="sm" variant="ghost" data-plugin-error-action="logs" onClick={onViewLogs}>
              {t('plugin.errorCard.logs')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
