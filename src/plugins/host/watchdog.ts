/**
 * plugins/host/watchdog.ts —— 帧看门狗 / 配额（02 §3.5 / §4.5；可注入定时器，单测无需真等待）。
 *
 * 数字冻结：
 * - ready 超时 **2500ms** → `E-RUN-02`；
 * - 心跳 `ping/pong` 每 **4000ms**，连续 **3** 次无 pong → `E-HOST-03`（不自动隔离，错误卡）；
 * - 帧数全局 ≤**8**、每插件 UI 帧 ≤**2**、草稿帧 ≤**1** → `E-QUOTA-04`。
 */
import {
  FRAME_GLOBAL_LIMIT,
  FRAME_HEARTBEAT_MISS_LIMIT,
  FRAME_HEARTBEAT_MS,
  FRAME_PER_PLUGIN_LIMIT,
  FRAME_DRAFT_LIMIT,
  FRAME_READY_TIMEOUT_MS,
  type PluginErrorCode,
} from '../types'

type Timer = ReturnType<typeof setTimeout>
type Interval = ReturnType<typeof setInterval>

export interface WatchdogClock {
  setTimeout: (fn: () => void, ms: number) => Timer
  clearTimeout: (timer: Timer) => void
  setInterval: (fn: () => void, ms: number) => Interval
  clearInterval: (interval: Interval) => void
  now: () => number
}

export const defaultWatchdogClock: WatchdogClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (interval) => clearInterval(interval),
  now: () => Date.now(),
}

export interface FrameWatchdogOptions {
  readyTimeoutMs?: number
  heartbeatMs?: number
  missLimit?: number
  onReadyTimeout?: () => void
  /** 连续 missLimit 次无 pong 时调用一次；参数为累计 miss 数。 */
  onHung?: (misses: number) => void
  /** 每次到点的心跳回调（宿主在这里 `channel.emit('__ping')`）。 */
  onTick?: () => void
  clock?: WatchdogClock
}

/**
 * 单帧看门狗：
 * `start()` 起 ready 计时（2500ms）→ `markReady()` 后切心跳（4000ms×3）→ `stop()` 全清。
 * 心跳 miss 只在 `markReady()` 之后统计；ready 前不 ping（帧还没跑起来）。
 */
export class FrameWatchdog {
  private readyTimer: Timer | null = null
  private heartbeat: Interval | null = null
  private misses = 0
  private ready = false
  private hung = false
  private stopped = false
  private readonly readyTimeoutMs: number
  private readonly heartbeatMs: number
  private readonly missLimit: number
  private readonly clock: WatchdogClock

  constructor(private readonly options: FrameWatchdogOptions = {}) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? FRAME_READY_TIMEOUT_MS
    this.heartbeatMs = options.heartbeatMs ?? FRAME_HEARTBEAT_MS
    this.missLimit = options.missLimit ?? FRAME_HEARTBEAT_MISS_LIMIT
    this.clock = options.clock ?? defaultWatchdogClock
  }

  get isReady(): boolean {
    return this.ready
  }

  get isHung(): boolean {
    return this.hung
  }

  get missedBeats(): number {
    return this.misses
  }

  start(): void {
    if (this.stopped) return
    this.clearReadyTimer()
    this.readyTimer = this.clock.setTimeout(() => {
      this.readyTimer = null
      if (this.ready || this.stopped) return
      this.options.onReadyTimeout?.()
    }, this.readyTimeoutMs)
  }

  /** 收到 `__ready`：清 ready 计时器并启动心跳。 */
  markReady(): void {
    if (this.stopped || this.ready) return
    this.ready = true
    this.clearReadyTimer()
    this.heartbeat = this.clock.setInterval(() => this.tick(), this.heartbeatMs)
  }

  /** 收到 `__pong`：清零 miss。 */
  pong(): void {
    this.misses = 0
  }

  /** 心跳到点：先记 miss，超过上限回调一次；未超限时通知宿主发 ping。 */
  private tick(): void {
    if (this.stopped || this.hung) return
    this.misses += 1
    if (this.misses >= this.missLimit) {
      this.hung = true
      this.stopHeartbeat()
      this.options.onHung?.(this.misses)
      return
    }
    this.options.onTick?.()
  }

  stop(): void {
    this.stopped = true
    this.clearReadyTimer()
    this.stopHeartbeat()
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== null) {
      this.clock.clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      this.clock.clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }
}

/* ------------------------------ 帧配额 ------------------------------ */

export type FrameQuotaKind = 'ui' | 'draft'

export interface FrameQuotaEntry {
  frameId: string
  pluginId: string
  kind: FrameQuotaKind
}

export interface FrameQuotaResult {
  ok: boolean
  code?: PluginErrorCode
  reason?: string
}

/**
 * 全局帧配额（02 §4.5）：
 * - 全局 ≤8；
 * - 每插件 UI 帧 ≤2（草稿帧不计入每插件 UI 上限，单独 ≤1）；
 * - 草稿帧全局 ≤1。
 */
export class FrameQuota {
  private readonly frames = new Map<string, FrameQuotaEntry>()

  acquire(frameId: string, pluginId: string, kind: FrameQuotaKind = 'ui'): FrameQuotaResult {
    if (this.frames.has(frameId)) return { ok: true }
    if (this.frames.size >= FRAME_GLOBAL_LIMIT) {
      return { ok: false, code: 'E-QUOTA-04', reason: `global frame limit ${FRAME_GLOBAL_LIMIT} reached` }
    }
    if (kind === 'draft') {
      const draftCount = this.count({ kind: 'draft' })
      if (draftCount >= FRAME_DRAFT_LIMIT) {
        return { ok: false, code: 'E-QUOTA-04', reason: `draft frame limit ${FRAME_DRAFT_LIMIT} reached` }
      }
    } else {
      const pluginCount = this.count({ pluginId, kind: 'ui' })
      if (pluginCount >= FRAME_PER_PLUGIN_LIMIT) {
        return { ok: false, code: 'E-QUOTA-04', reason: `per-plugin frame limit ${FRAME_PER_PLUGIN_LIMIT} reached` }
      }
    }
    this.frames.set(frameId, { frameId, pluginId, kind })
    return { ok: true }
  }

  release(frameId: string): void {
    this.frames.delete(frameId)
  }

  releasePlugin(pluginId: string): string[] {
    const released: string[] = []
    for (const [frameId, entry] of [...this.frames.entries()]) {
      if (entry.pluginId === pluginId) {
        this.frames.delete(frameId)
        released.push(frameId)
      }
    }
    return released
  }

  count(filter: { pluginId?: string; kind?: FrameQuotaKind } = {}): number {
    let count = 0
    for (const entry of this.frames.values()) {
      if (filter.pluginId !== undefined && entry.pluginId !== filter.pluginId) continue
      if (filter.kind !== undefined && entry.kind !== filter.kind) continue
      count += 1
    }
    return count
  }

  get total(): number {
    return this.frames.size
  }

  ids(): string[] {
    return [...this.frames.keys()]
  }

  clear(): void {
    this.frames.clear()
  }
}

/* ------------------------------ 启动失败计数 ------------------------------ */

export interface FailureState {
  failureCount: number
  quarantined: boolean
}

/**
 * 连续启动失败计数（§3.5 判定口径：第 3 次连续失败 → quarantined；成功一次即清零）。
 * 真正的落库/隔离由 registry 负责；这里只保证同一会话内的计数与判定口径。
 */
export class BootFailureTracker {
  private readonly failures = new Map<string, number>()
  private readonly selfRestarts = new Map<string, number>()

  fail(pluginId: string): FailureState {
    const next = (this.failures.get(pluginId) ?? 0) + 1
    this.failures.set(pluginId, next)
    return { failureCount: next, quarantined: next >= 3 }
  }

  success(pluginId: string): void {
    this.failures.delete(pluginId)
    this.selfRestarts.delete(pluginId)
  }

  count(pluginId: string): number {
    return this.failures.get(pluginId) ?? 0
  }

  /** 自动重启仅 1 次（同一会话内）；用户手动重试不受限并清零。 */
  allowAutoRestart(pluginId: string): boolean {
    const used = this.selfRestarts.get(pluginId) ?? 0
    if (used >= 1) return false
    this.selfRestarts.set(pluginId, used + 1)
    return true
  }

  reset(): void {
    this.failures.clear()
    this.selfRestarts.clear()
  }
}
