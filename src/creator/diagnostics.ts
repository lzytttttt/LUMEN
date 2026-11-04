/**
 * creator/diagnostics.ts —— 「复制诊断」的脱敏文本（04 §7.3 / §13.1）。
 *
 * 只含：错误码、错误详情（已脱敏 ≤300）、插件/草稿 id、revision、应用版本、文件名列表；
 * **不含** deck 内容、用户输入原文、API key、插件数据（06 D-40-02）。
 */
import { APP_VERSION } from '@/version'
import type { CreatorMachine } from './state'

export function feedbackDiagnosticsOf(machine: CreatorMachine): string {
  return JSON.stringify(
    {
      app: 'lumen',
      appVersion: APP_VERSION,
      draftId: machine.draftId,
      revision: machine.revision,
      status: machine.status,
      proposalId: machine.draftId ? `draft/${machine.draftId}@${machine.revision}` : null,
      error: machine.error ? { code: machine.error.code, uiKey: machine.error.uiKey, detail: machine.error.detail } : null,
      files: machine.proposal?.files.map((file) => file.path) ?? [],
    },
    null,
    2,
  )
}
