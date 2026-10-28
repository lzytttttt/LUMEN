/**
 * backoff.ts —— 指数退避、`Retry-After`、可重试码判定（`05` §7.1–§7.2）。
 *
 * 参数全部集中在这里，方便单测用固定 `random` 断言精确值：
 * 600 / 1 200 / 2 400ms，cap 8 000ms，jitter ±20%（equal jitter：`0.8 + 0.4 × random()`），
 * `Retry-After` 优先且上限 10 000ms；不重试 `auth/quota/notConfigured/contextLength/
 * modelNotFound/cors/badJson`；`streamBroken` 只在「未收到 delta」时重试。
 */
import type { AiErrorCode } from './provider'

export const BACKOFF_BASE_MS = 600
export const BACKOFF_FACTOR = 2
export const BACKOFF_CAP_MS = 8_000
export const BACKOFF_JITTER = 0.2
export const RETRY_AFTER_CAP_MS = 10_000
export const DEFAULT_MAX_RETRIES = 2

/** 一律不重试的码（§7.2）。 */
export const NO_RETRY_CODES: readonly AiErrorCode[] = [
  'auth',
  'quota',
  'notConfigured',
  'contextLength',
  'modelNotFound',
  'cors',
  'badJson',
]

/** equal jitter：落在 `[0.8, 1.2]`。 */
export function jitterFactor(random: () => number = Math.random): number {
  return 1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * random()
}

/** 第 `attempt` 次重试的**未抖动**基数（attempt 从 1 开始：600 → 1 200 → 2 400 → cap）。 */
export function baseDelayForAttempt(attempt: number): number {
  const step = Math.max(0, Math.floor(attempt) - 1)
  return Math.min(BACKOFF_CAP_MS, Math.round(BACKOFF_BASE_MS * BACKOFF_FACTOR ** step))
}

/** 抖动后的等待时长。 */
export function delayForAttempt(attempt: number, random: () => number = Math.random): number {
  return Math.round(baseDelayForAttempt(attempt) * jitterFactor(random))
}

/**
 * `Retry-After` → 毫秒：支持秒数（`2`、`1.5`）与 HTTP-date，上限 10 000ms；无法解析返回 null。
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (value === null || value === undefined) return null
  const raw = value.trim()
  if (raw === '') return null
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw)
    if (!Number.isFinite(seconds)) return null
    return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, Math.round(seconds * 1000)))
  }
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, at - now))
}

/** 是否值得重试（不含取消判定；取消由调用方先行 `isAborted()`）。 */
export function isRetryableCode(code: AiErrorCode, opts: { receivedDelta?: boolean } = {}): boolean {
  if (code === 'streamBroken') return opts.receivedDelta !== true
  return !NO_RETRY_CODES.includes(code)
}

export type RetryReason = 'ok' | 'aborted' | 'notRetryable' | 'maxRetries' | 'budget'

export interface RetryDecision {
  retry: boolean
  /** 建议等待时长（`retry:false` 时也给出，便于日志）。 */
  delay: number
  reason: RetryReason
}

export interface RetryArgs {
  /** 已经失败的尝试次数（1 = 第一次失败之后）。 */
  attempt: number
  error: { code: AiErrorCode; aborted?: boolean }
  receivedDelta?: boolean
  retryAfter?: string | null
  /** 本次请求剩余预算（毫秒）；`timeoutMs` 含重试与回退（§7.1）。 */
  remainingMs: number
  maxRetries?: number
  random?: () => number
  now?: number
}

/** 单点决策：能不能重试、等多久、为什么放弃。 */
export function planRetry(args: RetryArgs): RetryDecision {
  const maxRetries = args.maxRetries ?? DEFAULT_MAX_RETRIES
  if (args.error.aborted === true) return { retry: false, delay: 0, reason: 'aborted' }
  if (!isRetryableCode(args.error.code, { receivedDelta: args.receivedDelta })) {
    return { retry: false, delay: 0, reason: 'notRetryable' }
  }
  if (maxRetries <= 0 || args.attempt > maxRetries) return { retry: false, delay: 0, reason: 'maxRetries' }

  const serverDelay = parseRetryAfter(args.retryAfter, args.now ?? Date.now())
  const delay = serverDelay !== null ? serverDelay : delayForAttempt(args.attempt, args.random)
  // 剩余预算不够等下一次退避 → 直接放弃并抛当前错误（§7.1）。
  if (args.remainingMs < delay) return { retry: false, delay, reason: 'budget' }
  return { retry: true, delay, reason: 'ok' }
}
