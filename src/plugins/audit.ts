/**
 * plugins/audit.ts —— 本地环形审计（200 条）的**单点写入**（02 §7.7 / 03 §5.2）。
 *
 * 纪律：
 * - 只有宿主能写；`lumen.log` 不进审计环；插件没有任何写接口（S-40-09）。
 * - 写失败不抛：退化为内存环形继续（`E-AUDIT-01` 不提示）。
 * - detail ≤200 字符且已 redact；字段（seq/at/actor/action/result）由宿主生成，插件不可伪造。
 */
import { kvGet, kvSet } from '@/persistence/kv'
import { PluginError, redact } from './errors'
import { AUDIT_DETAIL_MAX, AUDIT_LIMIT } from './types'
import type { AuditEntry, PluginErrorCode } from './types'

const AUDIT_KEY = '__audit'

type NewAuditEntry = Omit<AuditEntry, 'seq' | 'at'> & { at?: number }

let entries: AuditEntry[] = []
let nextSeq = 1
let loaded = false
let persistenceEnabled = true
let persistTimer: ReturnType<typeof setTimeout> | null = null
const errorCounts = new Map<string, number>()

function trim(): void {
  if (entries.length > AUDIT_LIMIT) entries.splice(0, entries.length - AUDIT_LIMIT)
}

function sanitize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return redact(value).slice(0, AUDIT_DETAIL_MAX)
}

/**
 * 追加一条审计（同步入环，异步落库）。返回写入的记录。
 * 任何异常都被吞掉（审计失败不得影响业务，`E-AUDIT-01`）。
 */
export function appendAudit(input: NewAuditEntry): AuditEntry {
  const entry: AuditEntry = {
    seq: nextSeq++,
    at: input.at ?? Date.now(),
    action: input.action,
    actor: input.actor,
    result: input.result,
  }
  if (input.pluginId !== undefined) entry.pluginId = input.pluginId
  if (input.draftId !== undefined) entry.draftId = input.draftId
  if (input.code !== undefined) entry.code = input.code
  const detail = sanitize(input.detail)
  if (detail !== undefined) entry.detail = detail
  entries.push(entry)
  trim()
  if (input.code) bumpErrorCount(input.code)
  schedulePersist()
  return entry
}

/** 错误码计数（诊断 JSON `errorCounts`，02 §7.7）。 */
export function bumpErrorCount(code: PluginErrorCode | string): void {
  errorCounts.set(code, (errorCounts.get(code) ?? 0) + 1)
}

export function getErrorCounts(): Record<string, number> {
  return Object.fromEntries([...errorCounts.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

export function resetErrorCounts(): void {
  errorCounts.clear()
}

/** 审计环（返回浅拷贝；内部按插入顺序，UI 自行倒序）。 */
export function getAuditEntries(): AuditEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

/** UI 用：最新在前。 */
export function getAuditEntriesNewestFirst(): AuditEntry[] {
  return getAuditEntries().reverse()
}

export function getAuditCount(): number {
  return entries.length
}

/** 从 `plugins/__audit` 载入（registry 启动时调用一次；安全模式不调用）。 */
export async function loadAudit(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const stored = await kvGet<AuditEntry[]>( 'plugins', AUDIT_KEY)
    if (Array.isArray(stored)) {
      entries = stored
        .filter((entry) => entry && typeof entry === 'object' && typeof entry.action === 'string')
        .slice(-AUDIT_LIMIT)
      nextSeq = entries.reduce((max, entry) => Math.max(max, Number(entry.seq) || 0), 0) + 1
    }
  } catch {
    /* 读失败：保留内存环（E-AUDIT-01 不提示） */
  }
}

/** 安全模式下只保留内存日志（03 §5.3 #5）。 */
export function setAuditPersistence(enabled: boolean): void {
  persistenceEnabled = enabled
}

export function isAuditPersistenceEnabled(): boolean {
  return persistenceEnabled
}

function schedulePersist(): void {
  if (!persistenceEnabled || persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void flushAudit()
  }, 250)
}

/** 立即落库（测试/关闭页前调用）。失败吞掉。 */
export async function flushAudit(): Promise<void> {
  if (!persistenceEnabled) return
  try {
    await kvSet('plugins', AUDIT_KEY, entries.map((entry) => ({ ...entry })))
  } catch {
    /* 保持内存环形继续 */
  }
}

/** 安全模式启动审计（03 §5.3 / 02 §7.7；source: 'url' | 'shift' | 'setting'）。 */
export async function auditSafeModeOn(source: 'url' | 'shift' | 'setting'): Promise<void> {
  setAuditPersistence(false)
  appendAudit({
    action: 'plugin.safe-mode-on',
    actor: source === 'setting' ? 'user' : 'system',
    result: 'ok',
    detail: `source:${source}`,
  })
}

/** 由 PluginError 生成审计用的 code/detail（detail 已脱敏）。 */
export function auditFromError(error: unknown, fallbackCode: PluginErrorCode = 'E-HOST-01'): { code: PluginErrorCode; detail: string } {
  if (error instanceof PluginError) {
    return { code: error.code, detail: redact(error.message).slice(0, AUDIT_DETAIL_MAX) }
  }
  return { code: fallbackCode, detail: redact(String(error)).slice(0, AUDIT_DETAIL_MAX) }
}

/** 仅测试用：重置内存环。 */
export function resetAuditForTests(): void {
  entries = []
  nextSeq = 1
  loaded = false
  persistenceEnabled = true
  errorCounts.clear()
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
}
