/**
 * plugins/api/log.ts —— `lumen.log`（02 §5.2：无能力；进本地会话日志环 ≤500 条，**不进审计环**）。
 *
 * `warn/error` 另进诊断 `recentErrors`（由 runtime 的 getDiagnostics 汇总；冻结 8 字段里的 errorCounts 只记错误码）。
 */
import { appendAudit } from '../audit'
import type { ApiCall } from './context'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface SessionLogEntry {
  at: number
  pluginId: string
  frameId: string
  level: LogLevel
  message: string
}

const LOG_LIMIT = 500
const MESSAGE_MAX = 500
const entries: SessionLogEntry[] = []

/** 帧内 `evt __log` 的落点（bootstrap 已经 console 过一次，这里只进宿主环）。 */
export function appendSessionLog(frame: Pick<ApiCall['frame'], 'frameId' | 'pluginId'>, level: LogLevel, message: string): void {
  entries.push({
    at: Date.now(),
    pluginId: frame.pluginId,
    frameId: frame.frameId,
    level,
    message: message.slice(0, MESSAGE_MAX),
  })
  if (entries.length > LOG_LIMIT) entries.splice(0, entries.length - LOG_LIMIT)
  if (level === 'error') {
    appendAudit({
      action: 'plugin.error',
      actor: 'plugin',
      result: 'error',
      pluginId: frame.pluginId,
      detail: message.slice(0, 200),
    })
  }
}

export function getSessionLogs(pluginId?: string): SessionLogEntry[] {
  return entries.filter((entry) => (pluginId ? entry.pluginId === pluginId : true)).map((entry) => ({ ...entry }))
}

export function getRecentErrors(limit = 20): SessionLogEntry[] {
  return entries.filter((entry) => entry.level === 'error' || entry.level === 'warn').slice(-limit)
}

export function resetSessionLogsForTests(): void {
  entries.length = 0
}

/** `lumen.log.*` 本身是帧内方法（console + evt）；宿主侧无 RPC 方法。 */
export const LOG_METHODS: readonly string[] = []
