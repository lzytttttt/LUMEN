/**
 * plugins/host/rpc.ts —— 帧协议编解码 / 校验 / 限流 / 请求匹配（02 §4.4 / §4.5；纯函数 + 可注入时钟）。
 *
 * 安全判据（顺序不能换）：
 * 1. `event.source === frame.contentWindow`（主判据，照 `src/render/blocks/HtmlView.tsx`）；
 * 2. `pluginId + frameNonce` 与建帧登记一致（身份判据）；
 * 3. `origin` 只做辅助（opaque origin 恒为 `'null'`），**不做主判据**；
 * 4. `v === 1`、`type` 四值、`id` 形状、体积 ≤64KB、深度 ≤8。
 *
 * 限流数字冻结在 `types.ts`（120 msg/s burst 240、256KB/s、单帧在飞请求 ≤32、8s 超时、同一帧 10 次/分钟拒绝 → 挂起）。
 * 本模块不持有 React / DOM 依赖，`plugins-rpc.test.ts` 用假帧 + 假 postMessage 总线直接测。
 */
import {
  FRAME_INFLIGHT_MAX,
  FRAME_MESSAGE_MAX_BYTES,
  FRAME_MESSAGE_MAX_DEPTH,
  FRAME_PROTOCOL_VERSION,
  FRAME_RATE_BURST,
  FRAME_RATE_PER_SECOND,
  FRAME_REJECT_LIMIT_PER_MINUTE,
  FRAME_REQUEST_TIMEOUT_MS,
  FRAME_THROUGHPUT_BYTES_PER_SECOND,
  type FrameMessage,
  type PluginErrorCode,
} from '../types'

/* ------------------------------ 基础工具 ------------------------------ */

export function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

/** 单条消息的 UTF-8 字节数（结构化克隆前的上限判据；循环引用返回 `Infinity`）。 */
export function messageByteSize(message: unknown): number {
  try {
    return utf8ByteLength(JSON.stringify(message) ?? '')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** 值嵌套深度（对象/数组；循环引用 → `Infinity`；原始值 = 0）。 */
export function valueDepth(value: unknown, max = FRAME_MESSAGE_MAX_DEPTH + 1): number {
  const seen = new Set<unknown>()
  function walk(node: unknown, depth: number): number {
    if (depth > max) return depth
    if (node === null || typeof node !== 'object') return depth
    if (seen.has(node)) return Number.POSITIVE_INFINITY
    seen.add(node)
    let deepest = depth
    const values: unknown[] = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>)
    for (const child of values) {
      const found = walk(child, depth + 1)
      if (found > deepest) deepest = found
    }
    seen.delete(node)
    return deepest
  }
  return walk(value, 0)
}

/** 帧消息 id 形状：插件发起 `f<n>`，宿主发起 `h<n>`（02 §4.4）。 */
export const FRAME_ID_PATTERN = /^(f|h)\d{1,9}$/

const FRAME_TYPES = new Set(['req', 'res', 'evt', 'err'])

/** `frameNonce`：每次建帧重铸的 32 hex。 */
export const FRAME_NONCE_PATTERN = /^[0-9a-f]{32}$/

export function createFrameNonce(random: () => number = Math.random): string {
  let nonce = ''
  while (nonce.length < 32) nonce += Math.floor(random() * 0x100000000).toString(16).padStart(8, '0')
  return nonce.slice(0, 32)
}

/* ------------------------------ 校验 ------------------------------ */

export interface FrameIdentity {
  pluginId: string
  frameNonce: string
}

/** 接收侧登记信息：帧内容窗口（主判据）与辅助 origin。 */
export interface FrameSourceMeta {
  source: unknown
  contentWindow: unknown
  origin?: string
}

export type FrameRejectReason =
  | 'source'
  | 'identity'
  | 'version'
  | 'type'
  | 'id'
  | 'size'
  | 'depth'

export type FrameCheckResult =
  | { ok: true; message: FrameMessage }
  | { ok: false; reason: FrameRejectReason; code?: PluginErrorCode }

/**
 * 校验一条 `message` 事件。`reason === 'source'` 属于伪造/串帧（审计 + 计数），
 * 其余格式问题按 02 §4.4 处理（丢弃；体积/深度非法回 `E-ABI-03`）。
 */
export function checkFrameMessage(
  data: unknown,
  identity: FrameIdentity,
  meta: FrameSourceMeta,
): FrameCheckResult {
  // 1) 来源（主判据）：只认本帧的 contentWindow。
  if (!meta.contentWindow || meta.source !== meta.contentWindow) return { ok: false, reason: 'source' }
  // 3) origin 只做辅助：opaque origin 的帧恒为 'null'；不是 'null' 时仍按 source 判据为准，这里不拒绝。
  if (!data || typeof data !== 'object') return { ok: false, reason: 'type' }
  const candidate = data as Partial<FrameMessage>
  // 2) 身份判据。
  if (candidate.pluginId !== identity.pluginId || candidate.frameNonce !== identity.frameNonce) {
    return { ok: false, reason: 'identity' }
  }
  if (candidate.v !== FRAME_PROTOCOL_VERSION) return { ok: false, reason: 'version' }
  if (typeof candidate.type !== 'string' || !FRAME_TYPES.has(candidate.type)) return { ok: false, reason: 'type' }
  // 02 §4.4：`req/res` 的 id 必须非空；`evt` 是单向通知，id 可缺省（bootstrap 的 __log/__ready/__pong 不带 id）。
  const requiresId = candidate.type === 'req' || candidate.type === 'res' || candidate.type === 'err'
  if (candidate.id === undefined) {
    if (requiresId) return { ok: false, reason: 'id' }
  } else if (typeof candidate.id !== 'string' || !FRAME_ID_PATTERN.test(candidate.id)) {
    return { ok: false, reason: 'id' }
  }
  if (messageByteSize(candidate) > FRAME_MESSAGE_MAX_BYTES) return { ok: false, reason: 'size', code: 'E-ABI-03' }
  if (valueDepth(candidate) > FRAME_MESSAGE_MAX_DEPTH) return { ok: false, reason: 'depth', code: 'E-ABI-03' }
  return { ok: true, message: candidate as FrameMessage }
}

/* ------------------------------ 限流 ------------------------------ */

/** 令牌桶（消息速率）。`burst` 是瞬时上限，`rate` 是每秒补充。 */
export class TokenBucket {
  private tokens: number
  private lastAt: number

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst
    this.lastAt = now()
  }

  tryTake(count = 1): boolean {
    this.refill()
    if (this.tokens < count) return false
    this.tokens -= count
    return true
  }

  reset(): void {
    this.tokens = this.burst
    this.lastAt = this.now()
  }

  private refill(): void {
    const now = this.now()
    const elapsed = Math.max(0, now - this.lastAt)
    this.lastAt = now
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.rate)
  }
}

/** 吞吐窗口（256KB/s 滑动窗口；窗口 1s）。 */
export class ThroughputWindow {
  private samples: Array<{ at: number; bytes: number }> = []

  constructor(
    private readonly bytesPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 预检 + 记账：超限返回 false 且**不记账**（拒绝的请求不重复占用额度）。 */
  tryTake(bytes: number): boolean {
    const now = this.now()
    this.samples = this.samples.filter((sample) => now - sample.at < 1000)
    const used = this.samples.reduce((sum, sample) => sum + sample.bytes, 0)
    if (used + bytes > this.bytesPerSecond) return false
    this.samples.push({ at: now, bytes })
    return true
  }

  reset(): void {
    this.samples = []
  }
}

/** 单帧限流器：消息速率 + 吞吐 + 连续拒绝计数（10 次/分钟 → 挂起）。 */
export class FrameRateLimiter {
  private readonly messages: TokenBucket
  private readonly bytes: ThroughputWindow
  private rejections: number[] = []
  private suspended = false

  constructor(private readonly now: () => number = Date.now) {
    this.messages = new TokenBucket(FRAME_RATE_PER_SECOND, FRAME_RATE_BURST, now)
    this.bytes = new ThroughputWindow(FRAME_THROUGHPUT_BYTES_PER_SECOND, now)
  }

  /** 通过返回 null；超限返回 `E-ABI-04`。 */
  tryConsume(byteSize: number): PluginErrorCode | null {
    if (this.suspended) return 'E-ABI-04'
    if (!this.messages.tryTake(1) || !this.bytes.tryTake(Math.max(1, byteSize))) {
      this.noteRejection()
      return 'E-ABI-04'
    }
    return null
  }

  /** 伪造/非法帧的拒绝计数：同一帧 10 次/分钟 → 挂起（返回 true 表示本次触发挂起）。 */
  noteRejection(): boolean {
    const now = this.now()
    this.rejections = this.rejections.filter((at) => now - at < 60_000)
    this.rejections.push(now)
    if (this.rejections.length >= FRAME_REJECT_LIMIT_PER_MINUTE) {
      this.suspended = true
      return true
    }
    return false
  }

  get rejectionCount(): number {
    return this.rejections.length
  }

  get isSuspended(): boolean {
    return this.suspended
  }

  reset(): void {
    this.messages.reset()
    this.bytes.reset()
    this.rejections = []
    this.suspended = false
  }
}

/* ------------------------------ 错误与帧构造 ------------------------------ */

export function errorMessageOf(error: unknown): { code: PluginErrorCode; message: string } {
  const code = (error as { code?: PluginErrorCode } | null)?.code
  const message = (error as { message?: unknown } | null)?.message
  return {
    code: typeof code === 'string' ? code : 'E-HOST-01',
    message: typeof message === 'string' ? message.slice(0, 300) : 'plugin host internal error',
  }
}

export function createFrameMessage(
  type: FrameMessage['type'],
  identity: FrameIdentity,
  id: string,
  extras: { method?: string; payload?: unknown; code?: PluginErrorCode; message?: string } = {},
): FrameMessage {
  const message: FrameMessage = {
    v: FRAME_PROTOCOL_VERSION,
    id,
    type,
    pluginId: identity.pluginId,
    frameNonce: identity.frameNonce,
  }
  if (extras.method !== undefined) message.method = extras.method
  if (extras.payload !== undefined) message.payload = extras.payload
  if (extras.code !== undefined) message.code = extras.code
  if (extras.message !== undefined) message.message = extras.message.slice(0, 300)
  return message
}

/* ------------------------------ 请求匹配 ------------------------------ */

export interface PendingRequest {
  id: string
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  startedAt: number
}

export interface RequestTrackerOptions {
  timeoutMs?: number
  inflightMax?: number
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
  onTimeout?: (request: PendingRequest) => void
}

/** 宿主 → 帧的请求表（`h<n>`）：8s 超时、在飞 ≤32、重复 id 后到者丢弃。 */
export class RequestTracker {
  private readonly pending = new Map<string, PendingRequest>()
  private seq = 0
  private readonly timeoutMs: number
  private readonly inflightMax: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly onTimeout?: (request: PendingRequest) => void

  constructor(options: RequestTrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? FRAME_REQUEST_TIMEOUT_MS
    this.inflightMax = options.inflightMax ?? FRAME_INFLIGHT_MAX
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer))
    this.onTimeout = options.onTimeout
  }

  get size(): number {
    return this.pending.size
  }

  nextId(): string {
    this.seq += 1
    return `h${this.seq}`
  }

  /** 新建一次宿主发起请求；在飞超限 → `E-ABI-04`。 */
  create(method: string): { request: PendingRequest; promise: Promise<unknown> } {
    if (this.pending.size >= this.inflightMax) {
      const error = new Error('too many in-flight requests') as Error & { code?: PluginErrorCode }
      error.code = 'E-ABI-04'
      return {
        request: { id: '', method, resolve: () => {}, reject: () => {}, timer: null, startedAt: this.now() },
        promise: Promise.reject(error),
      }
    }
    const id = this.nextId()
    let resolve!: (value: unknown) => void
    let reject!: (error: Error) => void
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res
      reject = rej
    })
    const request: PendingRequest = { id, method, resolve, reject, timer: null, startedAt: this.now() }
    request.timer = this.setTimer(() => {
      this.pending.delete(id)
      this.onTimeout?.(request)
      const error = new Error(`request timeout: ${method}`) as Error & { code?: PluginErrorCode }
      error.code = 'E-ABI-05'
      reject(error)
    }, this.timeoutMs)
    this.pending.set(id, request)
    return { request, promise }
  }

  /** 收到 `res`/`err`：匹配并清掉计时器；未知 id 返回 false（后到者丢弃）。 */
  settle(id: string, ok: boolean, value: unknown, failure?: { code?: PluginErrorCode; message?: string }): boolean {
    const request = this.pending.get(id)
    if (!request) return false
    this.pending.delete(id)
    if (request.timer !== null) this.clearTimer(request.timer)
    if (ok) request.resolve(value)
    else {
      const error = new Error(failure?.message ?? failure?.code ?? 'plugin error') as Error & { code?: PluginErrorCode }
      error.code = failure?.code ?? 'E-RUN-01'
      request.reject(error)
    }
    return true
  }

  rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      if (request.timer !== null) this.clearTimer(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  has(id: string): boolean {
    return this.pending.has(id)
  }
}

/* ------------------------------ 宿主侧通道 ------------------------------ */

export interface RpcChannelOptions {
  identity: FrameIdentity
  /** 发送函数（宿主 → 帧）；测试注入假总线。 */
  post: (message: FrameMessage) => void
  /** 帧 → 宿主的请求处理器：返回结果或抛错。 */
  onRequest: (method: string, payload: unknown) => Promise<unknown>
  /** 帧 → 宿主的事件处理器。 */
  onEvent: (method: string, payload: unknown) => void
  /** 拒绝回调（source/身份/格式）；返回 true 表示该帧已挂起。 */
  onRejected?: (reason: FrameRejectReason) => void
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
  timeoutMs?: number
}

/** 每帧一个 RPC 通道：负责校验、限流、请求/响应匹配、宿主发起请求。 */
export class HostRpcChannel {
  private readonly tracker: RequestTracker
  private readonly limiter: FrameRateLimiter
  private readonly post: (message: FrameMessage) => void
  private readonly identity: FrameIdentity
  private readonly onRequest: (method: string, payload: unknown) => Promise<unknown>
  private readonly onEvent: (method: string, payload: unknown) => void
  private readonly onRejected?: (reason: FrameRejectReason) => void
  private disposed = false

  constructor(options: RpcChannelOptions) {
    this.identity = options.identity
    this.post = options.post
    this.onRequest = options.onRequest
    this.onEvent = options.onEvent
    this.onRejected = options.onRejected
    this.tracker = new RequestTracker({
      timeoutMs: options.timeoutMs,
      now: options.now,
      setTimeout: options.setTimeout,
      clearTimeout: options.clearTimeout,
    })
    this.limiter = new FrameRateLimiter(options.now ?? Date.now)
  }

  /** 处理一条 `message` 事件（调用方已按帧路由到这里）。 */
  handle(data: unknown, meta: FrameSourceMeta): FrameRejectReason | null {
    if (this.disposed) return null
    const checked = checkFrameMessage(data, this.identity, meta)
    if (!checked.ok) {
      this.limiter.noteRejection()
      this.onRejected?.(checked.reason)
      return checked.reason
    }
    const message = checked.message
    const limit = this.limiter.tryConsume(messageByteSize(message))
    if (limit) {
      if (message.type === 'req') {
        this.sendError(message.id, limit, 'rate limit exceeded')
      }
      return null
    }
    if (message.type === 'req') {
      void this.dispatch(message)
      return null
    }
    if (message.type === 'res' || message.type === 'err') {
      this.tracker.settle(message.id, message.type === 'res', message.payload, {
        code: message.code,
        message: message.message,
      })
      return null
    }
    if (message.type === 'evt' && typeof message.method === 'string') {
      this.onEvent(message.method, message.payload)
    }
    return null
  }

  /** 宿主 → 帧请求（`h<n>`）：8s 超时、在飞 ≤32。 */
  request(method: string, payload?: unknown): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('frame disposed'))
    const { request, promise } = this.tracker.create(method)
    if (!request.id) return promise
    try {
      this.post(createFrameMessage('req', this.identity, request.id, { method, payload }))
    } catch (error) {
      this.tracker.settle(request.id, false, undefined, errorMessageOf(error))
    }
    return promise
  }

  /** 宿主 → 帧事件（不构造请求、不等响应）。 */
  emit(method: string, payload?: unknown): void {
    if (this.disposed) return
    try {
      this.post(createFrameMessage('evt', this.identity, `h${Date.now().toString(36)}`, { method, payload }))
    } catch {
      /* 帧已销毁 */
    }
  }

  get inflight(): number {
    return this.tracker.size
  }

  get limiterState(): { suspended: boolean; rejections: number } {
    return { suspended: this.limiter.isSuspended, rejections: this.limiter.rejectionCount }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.tracker.rejectAll(new Error('frame disposed'))
  }

  private sendError(id: string, code: PluginErrorCode, message: string): void {
    try {
      this.post(createFrameMessage('err', this.identity, id, { code, message }))
    } catch {
      /* noop */
    }
  }

  private async dispatch(message: FrameMessage): Promise<void> {
    if (typeof message.method !== 'string' || message.method === '') {
      this.sendError(message.id, 'E-ABI-01', 'unknown method')
      return
    }
    try {
      const result = await this.onRequest(message.method, message.payload)
      this.post(createFrameMessage('res', this.identity, message.id, { payload: result === undefined ? null : result }))
    } catch (error) {
      const failure = errorMessageOf(error)
      this.post(createFrameMessage('err', this.identity, message.id, failure))
    }
  }
}
