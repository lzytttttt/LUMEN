/**
 * provider.ts —— 模型通道的唯一抽象层（v0.2.0：三通道 + 流式 + 重试 + 缓存）。
 *
 * 契约（`plan/v0.2.0/05-LLM接入规格.md` §1.1 五条硬线）：
 * - P1 `complete` 入参出参**只加可选字段**：10 处旧调用零改动，`stream`/`onDelta` 缺省即旧行为；
 * - P2 通道 id 只加宽不替换：`'mock' | 'openai' | 'replay'`，`providerFor` 新增前置分支；
 * - P3 错误码只增不删：11 个码，`isAborted()` 语义不动（用户取消仍是 `('timeout','aborted',true)`）；
 * - P4 降级只降不升：`json_schema → json_object → none`，`stream_options` 单独降一次；
 * - P5 零新运行时依赖：SSE / 退避 / LRU / 字段流全部手写。
 *
 * 三层计时器（§4.4）与断流回退（§4.6）都在 `OpenAICompatProvider` 里；缓存读写走 `cache.ts`，
 * 退避判定走 `backoff.ts`，SSE 切帧走 `sse.ts`，回放走 `replay.ts`。
 */
import type { LlmSettings } from '@/state/settingsStore'
import { isLlmReady, useSettingsStore } from '@/state/settingsStore'
import { mockOutline, mockSlideContent, type MockOutlineInput, type MockSlideInput } from './corpus'
import { mockSvgArt, mockThreeScene } from './art'
import { AI_CACHE_TTL_MS, cacheGet, cachePut, cacheableText, requestDigestOf } from './cache'
import { isRetryableCode, parseRetryAfter, planRetry } from './backoff'
import { readSseStream, type SseEvent } from './sse'
import { ReplayProvider, hasReplaySet, replaySetFromLocation } from './replay'

/* -------------------------------- 通道与格式 -------------------------------- */

/** 通道 id（P2：只加宽）。 */
export type AiChannelId = 'mock' | 'openai' | 'replay'

/** 结构化输出的三档形态；`auto` 由 `LlmSettings.format` 推导。 */
export type AiFormat = 'auto' | 'json_object' | 'json_schema' | 'none'

/** 任务标记：既用于 Mock 分派，也进 promptDigest 与缓存记录。 */
export type AiTask = 'outline' | 'slide' | 'svg' | 'three' | 'refine'

export interface AiUsage {
  prompt: number
  completion: number
  total?: number
  cachedPrompt?: number
}

export interface AiCapabilities {
  stream: boolean
  usageInStream: boolean
  jsonObject: boolean
  jsonSchema: boolean
}

export const NO_CAPABILITIES: AiCapabilities = {
  stream: false,
  usageInStream: false,
  jsonObject: false,
  jsonSchema: false,
}

/* -------------------------------- 错误模型 -------------------------------- */

export type AiErrorCode =
  | 'network'
  | 'auth'
  | 'timeout'
  | 'badJson'
  | 'notConfigured'
  // ↓ v0.2.0 新增 6 个（P3：只增不删）
  | 'rateLimit'
  | 'quota'
  | 'contextLength'
  | 'modelNotFound'
  | 'streamBroken'
  | 'cors'

export class AiError extends Error {
  readonly code: AiErrorCode
  readonly detail: string
  /** 用户主动取消（不是模型超时）。 */
  readonly aborted: boolean

  constructor(code: AiErrorCode, detail: string, aborted = false) {
    super(`${code}: ${detail}`)
    this.name = 'AiError'
    this.code = code
    this.detail = detail
    this.aborted = aborted
  }
}

export function isAiError(error: unknown): error is AiError {
  return error instanceof AiError
}

/** 取消（含用户点「取消生成」）统一判定。 */
export function isAborted(error: unknown): boolean {
  if (error instanceof AiError) return error.aborted || (error.code === 'timeout' && error.detail === 'aborted')
  return error instanceof DOMException && error.name === 'AbortError'
}

export function aiErrorMessage(error: unknown): string {
  if (error instanceof AiError) return error.detail || error.code
  if (error instanceof Error) return error.message
  return String(error)
}

/** 用户取消的唯一形状（`isAborted()` 必须命中它）。 */
export function abortedError(): AiError {
  return new AiError('timeout', 'aborted', true)
}

/** 日志与错误 detail 的统一脱敏（§10）：key / bearer / query 一律打码。 */
export function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***')
    .replace(/((?:api[_-]?key|key|token)=)[^&\s"']+/gi, '$1***')
}

/**
 * HTTP 状态码 + body 特征 → 错误码（§6 的检测顺序）：
 * `quota → contextLength → modelNotFound → rateLimit → auth → network`。
 * `cors` 不走这条路径（它由 `fetch` 抛 `TypeError` 触发，见 `corsBlocked()`）。
 */
export function errorCodeForStatus(status: number, body: string): AiErrorCode {
  const text = body || ''
  const quotaWord = /insufficient|quota|balance|余额|额度/i.test(text)
  if (status === 402) return 'quota'
  if (quotaWord && (status === 429 || status === 400)) return 'quota'
  if ((status === 400 || status === 413) && /context_length|maximum context|too many tokens|上下文/i.test(text)) {
    return 'contextLength'
  }
  if (status === 404 && /model/i.test(text)) return 'modelNotFound'
  if (status === 400 && /model.*(not.*found|no.*such|exist)/i.test(text)) return 'modelNotFound'
  if (status === 429) return 'rateLimit'
  if (status === 401 || status === 403) return 'auth'
  return 'network'
}

/* -------------------------------- 通道接口 -------------------------------- */

export interface CompleteRequest {
  system: string
  user: string
  json?: boolean
  temperature?: number
  signal?: AbortSignal
  /* ↓ v0.2.0 增量，全部可选；缺省 = v0.1.0 行为 */
  stream?: boolean
  schema?: { name: string; json: unknown }
  task?: AiTask
  onDelta?: (text: string) => void
  onUsage?: (usage: AiUsage) => void
}

export interface CompleteResult {
  text: string
  usage?: AiUsage
  /* ↓ v0.2.0 增量 */
  streamed?: boolean
  finish?: 'stop' | 'length' | 'aborted'
  model?: string
  cached?: boolean
  effectiveFormat?: AiFormat
}

export interface AiProvider {
  id: AiChannelId
  label: string
  capabilities?: AiCapabilities
  complete(req: CompleteRequest): Promise<CompleteResult>
}

/** 旧实现（含第三方）无需感知新字段：缺省按「全 false」解释。 */
export function capabilitiesOf(provider: AiProvider): AiCapabilities {
  return provider.capabilities ?? NO_CAPABILITIES
}

/* ------------------------------ Mock 通道 ------------------------------ */

/** 模拟一点延迟，让进度条与取消按钮有意义；测试环境为 0。 */
const TEST_MODE = typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test'
export const MOCK_LATENCY_MS = TEST_MODE ? 0 : 110

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(abortedError())
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 从 system prompt 里读任务标记（提示词自带 `[TASK:x]`，Mock 据此分派）。 */
export function taskOf(system: string): string {
  const match = /\[TASK:([a-z0-9-]+)\]/i.exec(system)
  return match ? match[1].toLowerCase() : ''
}

const AI_TASKS: readonly AiTask[] = ['outline', 'slide', 'svg', 'three', 'refine']

/** `req.task` 缺省时回落到 system 里的 `[TASK:x]`（旧调用点不传 task）。 */
export function resolveTask(req: CompleteRequest): AiTask | undefined {
  if (req.task !== undefined) return req.task
  const marker = taskOf(req.system)
  return (AI_TASKS as readonly string[]).includes(marker) ? (marker as AiTask) : undefined
}

/** 从 user 消息里读出 JSON 负载（Mock 只需要结构化输入）。 */
function readPayload(user: string): Record<string, unknown> {
  const start = user.indexOf('{')
  const end = user.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try {
    const parsed = JSON.parse(user.slice(start, end + 1))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/** 纯函数：给定任务标记与负载，产出确定性 JSON 文本。 */
export function mockText(req: CompleteRequest): string {
  const task = taskOf(req.system)
  const payload = readPayload(req.user)
  switch (task) {
    case 'outline':
      return JSON.stringify(mockOutline(payload as unknown as MockOutlineInput))
    case 'slide':
      return JSON.stringify(mockSlideContent(payload as unknown as MockSlideInput))
    case 'svg': {
      const prompt = String(payload.prompt ?? '')
      const art = mockSvgArt(prompt, { style: typeof payload.style === 'string' ? payload.style : undefined })
      return JSON.stringify({ svg: art.source, viewBox: art.viewBox, caption: prompt.slice(0, 80) })
    }
    case 'three':
      return JSON.stringify({ descriptor: mockThreeScene(String(payload.prompt ?? '')) })
    default:
      return JSON.stringify({ text: 'mock: no task marker' })
  }
}

/**
 * 离线确定性通道：同 prompt 同结果、零网络、**不流式**（D8）。
 * 传了 `onDelta` 也只在结束时一次落位，避免动效依赖 Mock 的帧节奏。
 */
export class MockProvider implements AiProvider {
  readonly id = 'mock' as const
  readonly label = 'Local mock'
  readonly capabilities: AiCapabilities = NO_CAPABILITIES
  private readonly latencyMs: number

  constructor(opts: { latencyMs?: number } = {}) {
    this.latencyMs = opts.latencyMs ?? MOCK_LATENCY_MS
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    await wait(this.latencyMs, req.signal)
    const text = mockText(req)
    // D8：Mock 不流式——但给消费方一次「整段落位」，动效层不必为 mock 分支特判。
    req.onDelta?.(text)
    return {
      text,
      usage: { prompt: estimateTokens(req.system + req.user), completion: estimateTokens(text) },
      streamed: false,
      finish: 'stop',
      effectiveFormat: 'none',
    }
  }
}

/* --------------------------- 计时器与 SSE 读取 --------------------------- */

export type AbortReason = 'user' | 'firstByte' | 'idle' | 'total'

interface AttemptTimers {
  readonly signal: AbortSignal
  readonly reason: AbortReason | null
  /** 收到第一段字节：首字节闸门放行，同时开始算帧间隔。 */
  onByte(): void
  /** 收到任意一段字节（复位帧间隔）。 */
  onActivity(): void
  dispose(): void
}

/**
 * 三层计时器（§4.4）：首字节 / 帧间隔 / 总时长，共用一个 `AbortController`。
 * 监听器一律 `{ once: true }` + `dispose()` 里移除（照抄 `post()` 的写法）。
 */
export function createAttemptTimers(opts: {
  totalMs: number
  firstByteMs?: number
  idleMs?: number
  outer?: AbortSignal
}): AttemptTimers {
  const controller = new AbortController()
  let reason: AbortReason | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const abortWith = (why: AbortReason) => {
    if (reason !== null) return
    reason = why
    controller.abort()
  }

  const totalTimer = setTimeout(() => abortWith('total'), Math.max(1, opts.totalMs))
  const firstTimer =
    opts.firstByteMs === undefined
      ? null
      : setTimeout(() => abortWith('firstByte'), Math.max(1, opts.firstByteMs))

  const armIdle = () => {
    if (opts.idleMs === undefined) return
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => abortWith('idle'), Math.max(1, opts.idleMs))
  }

  const onAbort = () => abortWith('user')
  if (opts.outer) {
    if (opts.outer.aborted) abortWith('user')
    else opts.outer.addEventListener('abort', onAbort, { once: true })
  }

  return {
    signal: controller.signal,
    get reason() {
      return reason
    },
    onByte() {
      if (firstTimer !== null) clearTimeout(firstTimer)
      armIdle()
    },
    onActivity() {
      armIdle()
    },
    dispose() {
      clearTimeout(totalTimer)
      if (firstTimer !== null) clearTimeout(firstTimer)
      if (idleTimer !== null) clearTimeout(idleTimer)
      opts.outer?.removeEventListener('abort', onAbort)
    },
  }
}

/* --------------------------- OpenAI 兼容通道 --------------------------- */

interface ChatPayload {
  choices?: { message?: { content?: unknown }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  model?: string
}

interface ChatChunk {
  choices?: { index?: number; delta?: { content?: unknown }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  model?: string
}

function normalizeEndpoint(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, '')
  if (base === '') return ''
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`
}

function usageOf(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): AiUsage | undefined {
  if (!usage) return undefined
  if (usage.prompt_tokens === undefined && usage.completion_tokens === undefined) return undefined
  const out: AiUsage = { prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0 }
  if (usage.total_tokens !== undefined) out.total = usage.total_tokens
  return out
}

/** `LlmSettings.format`（auto/json/strict/none）→ 线上形态。 */
export function aiFormatOf(llm: LlmSettings): AiFormat {
  switch (llm.format) {
    case 'none':
      return 'none'
    case 'json':
      return 'json_object'
    case 'strict':
      return 'json_schema'
    case 'auto':
    default:
      return llm.jsonMode === false ? 'none' : 'auto'
  }
}

/** 内容既可能是字符串，也可能是 `[{type:'text',text:'…'}]` 数组。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text ?? '')
        return ''
      })
      .join('')
  }
  return ''
}

function clampRetries(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 2
  return Math.min(3, Math.max(0, Math.round(value)))
}

/** CORS 探测缓存（§6：结果缓存 30s）。 */
const CORS_PROBE_TTL_MS = 30_000
const corsProbeCache = new Map<string, { at: number; blocked: boolean }>()

/** 并发去重表（§7.3）：同 `promptDigest` 的请求共享同一个 Promise。 */
interface InflightRequest {
  promise: Promise<CompleteResult>
  listeners: Set<(text: string) => void>
  usageListeners: Set<(usage: AiUsage) => void>
}
const inflight = new Map<string, InflightRequest>()

/** 在飞请求数（测试与诊断用）。 */
export function inflightCount(): number {
  return inflight.size
}

/** 测试用：清空去重表。 */
export function resetInflight(): void {
  inflight.clear()
}

/** 测试用：清空 CORS 探测缓存。 */
export function resetCorsProbeCache(): void {
  corsProbeCache.clear()
}

/**
 * 跨域被拦判定（§6 `cors` 行）：`fetch` 抛 `TypeError` + 页面是 http(s) +
 * 端点 host 与页面 host 不同 + 一次 `GET /models` 探测同样抛 `TypeError`。
 */
async function corsBlocked(endpoint: string): Promise<boolean> {
  if (typeof location === 'undefined') return false
  const protocol = location.protocol
  if (protocol !== 'http:' && protocol !== 'https:') return false
  let target: URL
  try {
    target = new URL(endpoint, location.href)
  } catch {
    return false
  }
  if (target.host === location.host) return false

  const probeUrl = `${target.origin}/models`
  const cached = corsProbeCache.get(probeUrl)
  const now = Date.now()
  if (cached && now - cached.at < CORS_PROBE_TTL_MS) return cached.blocked

  let blocked = false
  const probe = new AbortController()
  const timer = setTimeout(() => probe.abort(), 3000)
  try {
    await fetch(probeUrl, { method: 'GET', signal: probe.signal })
  } catch (error) {
    // 只有 `TypeError` 才是「拿不到响应」的跨域特征；探测超时不算证据。
    blocked = error instanceof TypeError
  } finally {
    clearTimeout(timer)
  }
  corsProbeCache.set(probeUrl, { at: now, blocked })
  return blocked
}

/** 流式整数帧的解析结果。 */
interface StreamOutcome {
  text: string
  usage?: AiUsage
  finish: 'stop' | 'length'
  model?: string
}

export class OpenAICompatProvider implements AiProvider {
  readonly id = 'openai' as const
  readonly label = 'OpenAI-compatible'
  readonly capabilities: AiCapabilities = {
    stream: true,
    usageInStream: true,
    jsonObject: true,
    jsonSchema: true,
  }

  /** 本次实例的降级状态（P4：只降不升）。 */
  private format: AiFormat | null = null
  /** `stream_options` 是否已被端点拒绝。 */
  private streamOptions = true
  /** 最近一次响应的 `Retry-After`（秒或 HTTP-date）。 */
  private retryAfter: string | null = null

  constructor(private readonly llm: LlmSettings) {}

  /** 本次请求实际要发的 `response_format` 形态。 */
  effectiveFormat(req: CompleteRequest): AiFormat {
    const base = this.format ?? aiFormatOf(this.llm)
    if (req.json !== true) return 'none'
    return base
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const endpoint = normalizeEndpoint(this.llm.baseURL)
    const model = this.llm.model.trim()
    if (endpoint === '' || model === '') throw new AiError('notConfigured', 'baseURL/model 为空')
    if (req.signal?.aborted) throw abortedError()

    const totalMs = Math.max(1000, this.llm.timeoutMs || 90_000)
    const deadline = Date.now() + totalMs
    const task = resolveTask(req)
    const digest = requestDigestOf({
      system: req.system,
      user: req.user,
      model,
      format: this.effectiveFormat(req),
      temperature: req.temperature ?? this.llm.temperature,
      task,
      channel: `openai:${endpoint}`,
    })

    // 1) 缓存：命中即返回，不发网络、不进 inflight（§8.2）。
    const hit = await this.readCache(digest, req)
    if (hit) return hit

    // 2) 并发去重（§7.3）：同 digest 共享同一个 Promise，onDelta 多播给所有订阅者。
    return this.withDedupe(digest, req, endpoint, model, deadline)
  }

  /**
   * 同一 `promptDigest` 的并发请求只发一次 HTTP：第二个调用方 0 次请求，只订阅 delta。
   * 成功/失败/abort 后立刻从表里删掉（不跨会话、不跨设置）。
   */
  private async withDedupe(
    digest: string,
    req: CompleteRequest,
    endpoint: string,
    model: string,
    deadline: number,
  ): Promise<CompleteResult> {
    const existing = inflight.get(digest)
    if (existing) {
      if (req.onDelta) existing.listeners.add(req.onDelta)
      if (req.onUsage) existing.usageListeners.add(req.onUsage)
      try {
        return await existing.promise
      } finally {
        if (req.onDelta) existing.listeners.delete(req.onDelta)
        if (req.onUsage) existing.usageListeners.delete(req.onUsage)
      }
    }

    const listeners = new Set<(text: string) => void>()
    const usageListeners = new Set<(usage: AiUsage) => void>()
    if (req.onDelta) listeners.add(req.onDelta)
    if (req.onUsage) usageListeners.add(req.onUsage)

    const shared: CompleteRequest = {
      ...req,
      onDelta: (text: string) => {
        for (const listener of listeners) listener(text)
      },
      onUsage: (usage: AiUsage) => {
        for (const listener of usageListeners) listener(usage)
      },
    }

    const promise = this.attemptLoop(endpoint, model, shared, deadline, digest).finally(() => {
      inflight.delete(digest)
    })
    inflight.set(digest, { promise, listeners, usageListeners })
    return promise
  }

  private async attemptLoop(
    endpoint: string,
    model: string,
    req: CompleteRequest,
    deadline: number,
    digest: string,
  ): Promise<CompleteResult> {
    const wantStream = req.stream ?? this.llm.stream !== false
    let streaming = wantStream
    let streamFallbacks = 0
    let attempt = 0
    const maxRetries = clampRetries(this.llm.maxRetries)
    const received = { deltas: 0 }
    /** 触发断流回退的那个错误：回退也失败时抛原错误（§4.6「仍失败抛原错误」）。 */
    let fallbackError: AiError | null = null

    for (;;) {
      if (req.signal?.aborted) throw abortedError()
      this.retryAfter = null
      try {
        const result = streaming
          ? await this.streamOnce(endpoint, model, req, deadline, received)
          : await this.jsonOnce(endpoint, model, req, deadline)
        await this.writeCache(digest, req, result)
        return result
      } catch (error) {
        if (isAborted(error)) throw error instanceof AiError ? error : abortedError()
        const failure = error instanceof AiError ? error : new AiError('network', aiErrorMessage(error))
        if (fallbackError) throw fallbackError

        // 断流回退（§4.6）：0 delta + 首字节/空闲超时/流断 → 用同 body 走一次非流式。
        const fallbackable =
          failure.code === 'timeout' || failure.code === 'streamBroken' || failure.code === 'network'
        if (streaming && received.deltas === 0 && streamFallbacks === 0 && fallbackable) {
          streamFallbacks += 1
          fallbackError = failure
          streaming = false
          continue
        }

        const decision = planRetry({
          attempt: attempt + 1,
          error: failure,
          receivedDelta: received.deltas > 0,
          retryAfter: this.retryAfter,
          remainingMs: deadline - Date.now(),
          maxRetries,
        })
        if (!decision.retry) throw failure
        attempt += 1
        await wait(decision.delay, req.signal)
      }
    }
  }

  /* ------------------------------ 非流式 ------------------------------ */

  private async jsonOnce(
    endpoint: string,
    model: string,
    req: CompleteRequest,
    deadline: number,
  ): Promise<CompleteResult> {
    for (let step = 0; step < 3; step += 1) {
      const format = this.effectiveFormat(req)
      const body = this.buildBody(model, req, format, false)
      if (format === 'none') delete body.response_format
      const { response, timers } = await this.send(endpoint, body, req, deadline, false)
      try {
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          if (this.downgrade(format, response.status, text, false)) continue
          throw this.statusError(response.status, text)
        }
        const payload = (await response.json().catch(() => null)) as ChatPayload | null
        if (!payload) throw new AiError('badJson', '响应不是合法 JSON')
        const text = contentToText(payload.choices?.[0]?.message?.content)
        if (text.trim() === '') throw new AiError('badJson', 'choices[0].message.content 为空')
        const usage = usageOf(payload.usage)
        if (usage) req.onUsage?.(usage)
        return {
          text,
          usage,
          streamed: false,
          finish: 'stop',
          model: payload.model ?? model,
          effectiveFormat: format,
        }
      } finally {
        timers.dispose()
      }
    }
    throw new AiError('badJson', 'response_format 三次都未被接受')
  }

  /* ------------------------------- 流式 ------------------------------- */

  private async streamOnce(
    endpoint: string,
    model: string,
    req: CompleteRequest,
    deadline: number,
    received: { deltas: number },
  ): Promise<CompleteResult> {
    const format = this.effectiveFormat(req)
    const body = this.buildBody(model, req, format, true)
    const { response, timers } = await this.send(endpoint, body, req, deadline, true)

    /** 已收到的正文：断流时交给修复环，不重发（§4.6）。 */
    let text = ''
    let usage: AiUsage | undefined
    let finish: 'stop' | 'length' | null = null
    let modelSeen: string | undefined
    let sawDone = false
    let sawFinish = false
    let tailError: AiError | null = null

    /** 已收到 delta 的收尾：不重发，`finish:'aborted'`。 */
    const partial = (): CompleteResult => {
      if (usage) req.onUsage?.(usage)
      return {
        text,
        usage,
        streamed: true,
        finish: 'aborted',
        model: modelSeen ?? model,
        effectiveFormat: format,
      }
    }

    try {
      if (!response.ok) {
        const failure = await response.text().catch(() => '')
        if (this.downgrade(format, response.status, failure, true)) {
          // 降级后重发：这一次的失败不计入 delta。
          return await this.streamOnce(endpoint, model, req, deadline, received)
        }
        throw this.statusError(response.status, failure)
      }
      const stream = response.body
      if (!stream) throw new AiError('streamBroken', '响应没有 body')

      await readSseStream(stream, {
        onFirstByte: () => timers.onByte(),
        onActivity: () => timers.onActivity(),
        onEvent: (event: SseEvent) => {
          if (sawDone) return
          const raw = event.data.trim()
          if (raw === '') return
          if (raw === '[DONE]') {
            sawDone = true
            return
          }
          let chunk: ChatChunk | null = null
          try {
            chunk = JSON.parse(raw) as ChatChunk
          } catch {
            // 规则 6：坏 JSON 帧 → streamBroken，不静默跳过。
            throw new AiError('streamBroken', redact(raw.slice(0, 120)))
          }
          if (!chunk) throw new AiError('streamBroken', '空帧')
          if (chunk.model) modelSeen = chunk.model
          if (chunk.usage) usage = usageOf(chunk.usage)
          const choice = chunk.choices?.[0]
          if (!choice) return
          const delta = contentToText(choice.delta?.content)
          if (delta !== '') {
            text += delta
            received.deltas += 1
            req.onDelta?.(delta)
          }
          if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') {
            sawFinish = true
            finish = choice.finish_reason
          }
        },
        onTail: (tail) => {
          // 规则 8：半帧 → 丢弃；只有「既没 [DONE] 也没 finish_reason」才算断流。
          if (!sawDone && !sawFinish) {
            tailError = new AiError('streamBroken', `尾帧不完整：${redact(tail.slice(0, 60))}`)
          }
        },
      })

      if (tailError) {
        // 规则 8：半帧丢弃；已收到 delta 时按 §4.6 交给调用方，不再重发。
        if (received.deltas > 0 && text.trim() !== '') return partial()
        throw tailError
      }
      if (!sawDone && !sawFinish) {
        // 规则 7 的反面：既无 [DONE] 也无 finish_reason → 提前 EOF。
        if (received.deltas > 0 && text.trim() !== '') return partial()
        throw new AiError('streamBroken', '提前 EOF')
      }
      if (text.trim() === '') throw new AiError('badJson', '流里没有 content')
      if (usage) req.onUsage?.(usage)
      return {
        text,
        usage,
        streamed: true,
        finish: finish ?? 'stop',
        model: modelSeen ?? model,
        effectiveFormat: format,
      }
    } catch (error) {
      // 计时器造成的失败要按 abortReason 归因（§4.5）。
      if (isAborted(error)) throw error instanceof AiError ? error : abortedError()
      if (error instanceof AiError) {
        if (error.code !== 'auth' && received.deltas > 0 && text.trim() !== '') return partial()
        throw error
      }
      if (timers.reason !== null) {
        if (received.deltas > 0 && text.trim() !== '') return partial()
        throw this.timeoutError(timers.reason)
      }
      if (error instanceof TypeError && (await corsBlocked(endpoint))) {
        if (received.deltas > 0 && text.trim() !== '') return partial()
        throw new AiError('cors', redact(aiErrorMessage(error)))
      }
      if (received.deltas > 0 && text.trim() !== '') return partial()
      if (error instanceof TypeError) throw new AiError('network', redact(aiErrorMessage(error)))
      throw new AiError('streamBroken', redact(aiErrorMessage(error)))
    } finally {
      timers.dispose()
    }
  }

  /* ------------------------------ 公共设施 ------------------------------ */

  private buildBody(
    model: string,
    req: CompleteRequest,
    format: AiFormat,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      temperature: req.temperature ?? this.llm.temperature,
      stream,
    }
    if (stream && this.streamOptions) body.stream_options = { include_usage: true }
    if (format === 'json_schema') {
      if (req.schema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: req.schema.name, schema: req.schema.json, strict: true },
        }
      } else {
        body.response_format = { type: 'json_object' }
      }
    } else if (format === 'json_object') {
      body.response_format = { type: 'json_object' }
    }
    return body
  }

  /**
   * 降级（§5.2 / §4.1）：400/404/422 且 body 命中特征时降一档并返回 true（同一次请求内重发）。
   * `format` 的降级只降不升，且写回实例与（同一个）设置对象。
   */
  private downgrade(format: AiFormat, status: number, body: string, stream: boolean): boolean {
    if (![400, 404, 422].includes(status)) return false
    if (stream && this.streamOptions && /stream_options|unknown.*field/i.test(body)) {
      this.streamOptions = false
      return true
    }
    if (format === 'json_schema' && /json|response_format|schema/i.test(body)) {
      this.applyFormat('json_object')
      return true
    }
    if (format === 'json_object' && /json|response_format/i.test(body)) {
      this.applyFormat('none')
      return true
    }
    return false
  }

  /** 记录降级结果：实例 + 活的设置对象（同一个引用才写，避免污染测试与历史快照）。 */
  private applyFormat(next: AiFormat): void {
    this.format = next
    const store = useSettingsStore.getState()
    if (store.llm !== this.llm) return
    const settingsFormat = next === 'json_object' ? 'json' : next === 'none' ? 'none' : 'auto'
    try {
      store.patchLlm({ format: settingsFormat })
    } catch {
      // 设置只读或已卸载时忽略：降级仍在本实例生效。
    }
  }

  /** 单次 POST：三层计时器 + 外部取消 + Retry-After 捕获。 */
  private async send(
    endpoint: string,
    body: Record<string, unknown>,
    req: CompleteRequest,
    deadline: number,
    stream: boolean,
  ): Promise<{ response: Response; timers: AttemptTimers }> {
    const totalMs = Math.max(1000, this.llm.timeoutMs || 90_000)
    const remaining = Math.max(1000, Math.min(totalMs, deadline - Date.now()))
    const timers = createAttemptTimers({
      totalMs: remaining,
      firstByteMs: stream ? Math.max(1000, this.llm.firstByteTimeoutMs ?? 12_000) : undefined,
      idleMs: stream ? Math.max(1000, this.llm.frameIdleMs ?? 20_000) : undefined,
      outer: req.signal,
    })

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.llm.apiKey.trim() !== '' ? { authorization: `Bearer ${this.llm.apiKey.trim()}` } : {}),
        },
        body: JSON.stringify(body),
        signal: timers.signal,
      })
      const retryAfter = response.headers?.get?.('retry-after') ?? null
      if (retryAfter) this.retryAfter = retryAfter
      return { response, timers }
    } catch (error) {
      timers.dispose()
      if (req.signal?.aborted) throw abortedError()
      if (timers.reason !== null) throw this.timeoutError(timers.reason)
      if (error instanceof TypeError) {
        if (await corsBlocked(endpoint)) throw new AiError('cors', redact(aiErrorMessage(error)))
        throw new AiError('network', redact(aiErrorMessage(error)))
      }
      throw new AiError('network', redact(aiErrorMessage(error)))
    }
  }

  private timeoutError(reason: AbortReason): AiError {
    switch (reason) {
      case 'user':
        return abortedError()
      case 'firstByte':
        return new AiError('timeout', '首字节超时')
      case 'idle':
        return new AiError('timeout', '流空闲超时')
      default:
        return new AiError('timeout', `超过 ${Math.max(1000, this.llm.timeoutMs || 90_000)}ms`)
    }
  }

  private statusError(status: number, bodyText: string): AiError {
    // 先脱敏再截断：反过来的话，被切断的 key 前缀会漏过 `sk-…` 正则。
    const snippet = redact(bodyText.replace(/\s+/g, ' ').trim()).slice(0, 180)
    const code = errorCodeForStatus(status, bodyText)
    return new AiError(code, `HTTP ${status} ${snippet}`.trim())
  }

  /* ------------------------------- 缓存 ------------------------------- */

  private async readCache(key: string, req: CompleteRequest): Promise<CompleteResult | null> {
    if (this.llm.cache === false) return null
    if (req.signal?.aborted) throw abortedError()
    const record = await cacheGet(key)
    if (!record || record.text.trim() === '') return null
    req.onDelta?.(record.text)
    if (record.usage) req.onUsage?.(record.usage)
    return {
      text: record.text,
      usage: record.usage,
      streamed: false,
      cached: true,
      finish: 'stop',
      model: record.model,
      effectiveFormat: (record.format as AiFormat) ?? this.effectiveFormat(req),
    }
  }

  private async writeCache(key: string, req: CompleteRequest, result: CompleteResult): Promise<void> {
    if (this.llm.cache === false) return
    if (result.cached === true) return
    if (!cacheableText(result.text, req.json === true)) return
    try {
      await cachePut({
        key,
        task: resolveTask(req) ?? 'outline',
        text: result.text,
        model: this.llm.model.trim(),
        format: result.effectiveFormat ?? this.effectiveFormat(req),
        usage: result.usage,
        ttlMs: AI_CACHE_TTL_MS,
      })
    } catch {
      // 缓存写失败（配额 / 隐私模式）不影响本次结果。
    }
  }
}

/* --------------------------------- 路由 --------------------------------- */

/** `?channel=replay` 强制走回放（e2e / 离线演示）。 */
export function forcedChannelFromLocation(search?: string): AiChannelId | null {
  const query = search ?? (typeof location !== 'undefined' ? location.search : '')
  if (query === '') return null
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query)
  const channel = params.get('channel')
  return channel === 'replay' || channel === 'mock' || channel === 'openai' ? channel : null
}

/**
 * 通道判定（§2 的增量，其余分支原样）：
 * `?channel=replay` → replay；`llm.provider === 'replay'` → replay；
 * 其余仍走 `isLlmReady(llm) ? openai : mock`。
 */
export function providerFor(llm: LlmSettings): AiProvider {
  const forced = forcedChannelFromLocation()
  const setId = replaySetFromLocation()
  if (forced === 'replay' || (forced !== 'mock' && llm.provider === 'replay')) {
    return new ReplayProvider({ setId })
  }
  if (forced === 'mock') return new MockProvider()
  return isLlmReady(llm) ? new OpenAICompatProvider(llm) : new MockProvider()
}

/** 读当前设置决定通道（UI 与管线共用）。 */
export function currentProvider(): AiProvider {
  return providerFor(useSettingsStore.getState().llm)
}

export interface ChannelInfo {
  /** 有效通道（v0.2.0 起可能是 replay）。 */
  id: AiChannelId
  /** replay 恒为真（fixture 命中与否在 `complete` 时报错）；openai 看端点；mock 恒真。 */
  ready: boolean
  model: string
  host: string
  /** 与 `id` 同值，保留给「通道徽标」这一层语义（§14.5）。 */
  channel: AiChannelId
}

/** 通道展示信息（徽标用）：`replay` 不应落到「离线示例模式」。 */
export function channelInfo(llm: LlmSettings): ChannelInfo {
  const setId = replaySetFromLocation()
  const replay = forcedChannelFromLocation() === 'replay' || llm.provider === 'replay'
  let host = ''
  try {
    host = llm.baseURL.trim() === '' ? '' : new URL(llm.baseURL.trim()).host
  } catch {
    host = llm.baseURL.trim().replace(/^https?:\/\//i, '').split('/')[0] ?? ''
  }
  if (replay) {
    return {
      id: 'replay',
      ready: hasReplaySet(setId),
      model: setId,
      host: 'replay',
      channel: 'replay',
    }
  }
  const ready = isLlmReady(llm)
  return { id: ready ? 'openai' : 'mock', ready, model: llm.model.trim(), host, channel: ready ? 'openai' : 'mock' }
}

/* ------------------------------ 导出给测试 ------------------------------ */

/** 重试判定转发（单测直接 import `backoff.ts` 更细，这里是管线级快捷入口）。 */
export { isRetryableCode, parseRetryAfter }
