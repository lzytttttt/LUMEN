/**
 * plugins/api/notify.ts —— `lumen.notify.toast`（02 §5.2：无能力；限流 1 条/秒，文案 ≤160 字符）。
 */
import { useUiStore } from '@/state/uiStore'
import type { ApiCall } from './context'
import { abiError, assertRecord, registerNamespaceApi } from './gateway'

const TOAST_MIN_INTERVAL_MS = 1000
const MESSAGE_MAX = 160
const lastToastAt = new Map<string, number>()

export function handleNotify(method: string, payload: unknown, call: ApiCall): unknown {
  if (method !== 'toast') throw abiError(`unknown notify method "${method}"`)
  const body = assertRecord(payload, 'payload')
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, MESSAGE_MAX) : ''
  if (!message) throw abiError('toast message is required')
  const kind = body.kind === 'success' || body.kind === 'error' ? body.kind : 'info'
  const now = Date.now()
  const last = lastToastAt.get(call.frame.frameId) ?? 0
  if (now - last < TOAST_MIN_INTERVAL_MS) return null
  lastToastAt.set(call.frame.frameId, now)
  const ttl = typeof body.ttl === 'number' && Number.isFinite(body.ttl) ? Math.min(10_000, Math.max(800, body.ttl)) : undefined
  useUiStore.getState().pushToast(ttl === undefined ? { kind, message } : { kind, message, ttl })
  return null
}

export function resetNotifyForTests(): void {
  lastToastAt.clear()
}

export function registerNotifyApi(): void {
  registerNamespaceApi('notify', {
    toast: (payload, call) => handleNotify('toast', payload, call),
  })
}
