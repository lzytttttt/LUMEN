/**
 * presenter.ts —— 主窗与讲者窗之间的同步协议（BroadcastChannel 'lumen-sync'）。
 *
 * 消息很小，单向状态 + 反向命令：
 * - 主窗 → 讲者窗：`state`（幕号/黑屏/自动播放/计时/总数）、`deck`（标题 + 备注）
 * - 讲者窗 → 主窗：`command`（next / prev / go / blackout / timer-reset）、`hello`（请求首帧）
 */

export const SYNC_CHANNEL = 'lumen-sync'

export type PresenterAction = 'next' | 'prev' | 'go' | 'blackout' | 'timer-reset'

export interface SyncStateMessage {
  type: 'state'
  index: number
  blackout: boolean
  autoplay: boolean
  elapsedMs: number
  total: number
}

export interface SyncDeckMessage {
  type: 'deck'
  title: string
  slides: { name: string; notes: string }[]
}

export interface SyncCommandMessage {
  type: 'command'
  action: PresenterAction
  index?: number
}

export interface SyncHelloMessage {
  type: 'hello'
}

export type SyncMessage = SyncStateMessage | SyncDeckMessage | SyncCommandMessage | SyncHelloMessage

export function isSyncMessage(value: unknown): value is SyncMessage {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return type === 'state' || type === 'deck' || type === 'command' || type === 'hello'
}

/** BroadcastChannel 是否可用（老 Safari / 部分内嵌 webview 没有）。 */
export function canBroadcast(): boolean {
  return typeof BroadcastChannel === 'function'
}
