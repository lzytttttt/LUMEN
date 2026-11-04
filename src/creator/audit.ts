/**
 * creator/audit.ts —— 创造模式的 5 类审计调用（04 §7.5）。
 *
 * 纪律：唯一写入点是 `src/plugins/audit.ts` 的 `appendAudit`（宿主单点），
 * 这里只拼 `actor:'creator'` 与固定 action，**不落库、不另写环形缓冲**。
 */
import { appendAudit } from '@/plugins/audit'
import type { AuditAction, PluginErrorCode } from '@/plugins/types'

export type CreatorAuditResult = 'ok' | 'denied' | 'error' | 'cancelled'

export interface CreatorAuditInput {
  action: Extract<AuditAction, `creator.${string}`>
  result: CreatorAuditResult
  draftId?: string
  code?: PluginErrorCode
  /** ≤200 字符，由 audit.ts 统一脱敏。 */
  detail?: string
}

/** 写一条创造模式审计；任何异常都被吞掉（不得影响业务）。 */
export function creatorAudit(input: CreatorAuditInput): void {
  try {
    appendAudit({
      action: input.action,
      actor: 'creator',
      result: input.result,
      ...(input.draftId !== undefined ? { draftId: input.draftId } : {}),
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    })
  } catch {
    /* E-AUDIT-01：不提示、不阻断 */
  }
}
