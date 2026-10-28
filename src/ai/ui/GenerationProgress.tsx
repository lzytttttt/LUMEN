/**
 * GenerationProgress.tsx —— 逐幕成稿进度条（第 n/total 幕 + 取消）。
 * 进度只反映"已完成的幕"，不阻塞画布交互。
 */
import { useT } from '@/i18n'
import { Button } from '@/ui/primitives'

export interface GenerationProgressProps {
  done: number
  total: number
  onCancel?: () => void
}

export function GenerationProgress({ done, total, onCancel }: GenerationProgressProps) {
  const t = useT()
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="ai-progress" role="status" aria-live="polite">
      <div className="ai-progress__bar">
        <span className="ai-progress__fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="ai-progress__row">
        <span>{t('ai.panel.building', { done, total })}</span>
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('ai.panel.cancel')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
