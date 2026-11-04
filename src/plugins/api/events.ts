/**
 * plugins/api/events.ts —— `lumen.events` 的能力门（02 §5.4 冻结 10 个事件）。
 *
 * 订阅发生在帧内（bootstrap 本地表），宿主侧**只在推送时**按事件所需能力过滤：
 * 未授权的事件不会出现在白名单，宿主也不发（插件看不到它没资格看的事件）。
 * `deck:change` / `slide:change` / `theme:change` 由宿主合并到 ≤10Hz（02 §4.4）。
 */
import { registryPort, type ApiFrame } from './context'
import type { Capability } from '../types'

export type LumenEventName =
  | 'app:ready'
  | 'deck:open'
  | 'deck:change'
  | 'slide:change'
  | 'theme:change'
  | 'mode:change'
  | 'play:start'
  | 'play:stop'
  | 'export:before'
  | 'export:after'

/** 事件 → 所需能力（02 §5.4；`null` = 都能收）。 */
export const EVENT_CAPABILITIES: Readonly<Record<LumenEventName, Capability | null>> = {
  'app:ready': null,
  'deck:open': 'deck:read',
  'deck:change': 'deck:read',
  'slide:change': 'deck:read',
  'theme:change': null,
  'mode:change': null,
  'play:start': 'ui:slot',
  'play:stop': 'ui:slot',
  'export:before': 'export:hook',
  'export:after': 'export:hook',
}

export const LUMEN_EVENT_NAMES = Object.keys(EVENT_CAPABILITIES) as LumenEventName[]

export function isLumenEventName(value: unknown): value is LumenEventName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EVENT_CAPABILITIES, value)
}

/** 帧是否有资格接收某事件（每次实时判 grants，不缓存）。 */
export function canReceiveEvent(frame: Pick<ApiFrame, 'pluginId' | 'draftId'>, name: LumenEventName): boolean {
  const capability = EVENT_CAPABILITIES[name]
  if (capability === null) return true
  if (frame.draftId) {
    // 草稿帧：能力由 draft 授权集决定；draft 端口在 runtime 安装，这里保守返回 false 由调用方补 draft 判定。
    return false
  }
  return registryPort().hasGrant(frame.pluginId, capability)
}

/** 合并事件（≤10Hz）：宿主在 deck/slide/theme 变化时用这个节流器广播。 */
export class EventThrottle {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: unknown = undefined
  private lastAt = 0

  constructor(
    private readonly minIntervalMs: number,
    private readonly flush: (payload: unknown) => void,
  ) {}

  push(payload: unknown): void {
    this.pending = payload
    const elapsed = Date.now() - this.lastAt
    const wait = Math.max(0, this.minIntervalMs - elapsed)
    if (wait === 0) this.run()
    else if (this.timer === null) this.timer = setTimeout(() => this.run(), wait)
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending = undefined
  }

  private run(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.lastAt = Date.now()
    const payload = this.pending
    this.pending = undefined
    if (payload !== undefined) this.flush(payload)
  }
}

/** 事件订阅本身是帧内行为；宿主侧不登记 RPC 方法（网关表里没有 `events.*`）。 */
export const EVENTS_METHODS: readonly string[] = []
