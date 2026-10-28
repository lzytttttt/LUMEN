/**
 * backoff.test.ts —— 退避与重试决策（`05` §7.1–§7.2 + `07` L-09）。
 *
 * 断言精确值：`random` 固定后 jitter 因子为 1.0，退避序列必须是 600 / 1 200 / 2 400，cap 8 000。
 */
import { describe, expect, it } from 'vitest'
import type { AiErrorCode } from '@/ai/provider'
import {
  BACKOFF_CAP_MS,
  DEFAULT_MAX_RETRIES,
  RETRY_AFTER_CAP_MS,
  baseDelayForAttempt,
  delayForAttempt,
  isRetryableCode,
  jitterFactor,
  parseRetryAfter,
  planRetry,
} from '@/ai/backoff'

const flat = () => 0.5
const lowest = () => 0
const highest = () => 0.9999999

describe('ai/backoff', () => {
  it('基线 600 / 1 200 / 2 400，cap 8 000', () => {
    expect([1, 2, 3, 4].map((attempt) => baseDelayForAttempt(attempt))).toEqual([600, 1200, 2400, 4800])
    expect(baseDelayForAttempt(5)).toBe(BACKOFF_CAP_MS)
    expect(baseDelayForAttempt(9)).toBe(BACKOFF_CAP_MS)
    // jitter 因子为 1 时序列原值。
    expect([1, 2, 3].map((attempt) => delayForAttempt(attempt, flat))).toEqual([600, 1200, 2400])
  })

  it('jitter 落在 ±20% 内', () => {
    expect(jitterFactor(lowest)).toBeCloseTo(0.8, 5)
    expect(jitterFactor(flat)).toBeCloseTo(1, 5)
    expect(jitterFactor(highest)).toBeLessThanOrEqual(1.2)
    for (let i = 0; i < 200; i += 1) {
      const delay = delayForAttempt(2, () => i / 200)
      expect(delay).toBeGreaterThanOrEqual(1200 * 0.8 - 1)
      expect(delay).toBeLessThanOrEqual(1200 * 1.2 + 1)
    }
  })

  it('Retry-After 优先且上限 10s', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter('1.5')).toBe(1500)
    expect(parseRetryAfter('30')).toBe(RETRY_AFTER_CAP_MS)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('not-a-date')).toBeNull()
    const at = Date.parse('2026-10-28T00:00:05.000Z')
    expect(parseRetryAfter('Wed, 28 Oct 2026 00:00:05 GMT', at - 2000)).toBe(2000)

    const decision = planRetry({
      attempt: 1,
      error: { code: 'rateLimit' },
      retryAfter: '2',
      remainingMs: 60_000,
      maxRetries: 2,
      random: highest,
    })
    expect(decision).toEqual({ retry: true, delay: 2000, reason: 'ok' })
  })

  it('不重试码逐一断言', () => {
    const noRetry: AiErrorCode[] = ['auth', 'quota', 'notConfigured', 'contextLength', 'modelNotFound', 'cors', 'badJson']
    for (const code of noRetry) {
      expect(isRetryableCode(code), code).toBe(false)
      expect(
        planRetry({ attempt: 1, error: { code }, remainingMs: 60_000, maxRetries: 2 }).reason,
        code,
      ).toBe('notRetryable')
    }
    for (const code of ['network', 'timeout', 'rateLimit', 'streamBroken'] as AiErrorCode[]) {
      expect(isRetryableCode(code), code).toBe(true)
    }
    // streamBroken 只在「未收到 delta」时重试。
    expect(isRetryableCode('streamBroken', { receivedDelta: true })).toBe(false)
    expect(
      planRetry({ attempt: 1, error: { code: 'streamBroken' }, receivedDelta: true, remainingMs: 60_000 }).reason,
    ).toBe('notRetryable')
  })

  it('剩余预算不足即放弃', () => {
    const decision = planRetry({
      attempt: 1,
      error: { code: 'network' },
      remainingMs: 400,
      maxRetries: 2,
      random: flat,
    })
    expect(decision).toEqual({ retry: false, delay: 600, reason: 'budget' })
  })

  it('maxRetries 边界：默认 2，attempt 3 不再重试', () => {
    expect(DEFAULT_MAX_RETRIES).toBe(2)
    const args = { error: { code: 'network' as AiErrorCode }, remainingMs: 60_000, random: flat }
    expect(planRetry({ ...args, attempt: 1 }).retry).toBe(true)
    expect(planRetry({ ...args, attempt: 2 }).retry).toBe(true)
    expect(planRetry({ ...args, attempt: 3 })).toEqual({ retry: false, delay: 0, reason: 'maxRetries' })
    expect(planRetry({ ...args, attempt: 1, maxRetries: 0 }).reason).toBe('maxRetries')
  })

  it('取消优先于一切：aborted 直接不重试', () => {
    expect(
      planRetry({ attempt: 1, error: { code: 'timeout', aborted: true }, remainingMs: 60_000 }).reason,
    ).toBe('aborted')
  })
})
