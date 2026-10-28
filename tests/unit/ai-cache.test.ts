/**
 * ai-cache.test.ts —— 响应缓存（`05` §8 + `07` L-10）。
 *
 * 覆盖：命中不发 fetch、TTL 过期再发、LRU 按 `at` 淘汰、坏 JSON 不入缓存、
 * 换 model 自然 miss、kv 降级到内存模式仍工作、命中计数、replay 不写缓存。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getStorageMode } from '@/persistence/kv'
import { DEFAULT_LLM, type LlmSettings } from '@/state/settingsStore'
import { OpenAICompatProvider, inflightCount, resetInflight } from '@/ai/provider'
import { ReplayProvider } from '@/ai/replay'
import {
  AI_CACHE_MAX_ENTRIES,
  AI_CACHE_TTL_MS,
  cacheClear,
  cacheEntries,
  cacheGet,
  cachePut,
  cacheStats,
  cacheableText,
  evict,
  requestDigestOf,
  resetCacheStats,
} from '@/ai/cache'

function llm(patch: Partial<LlmSettings> = {}): LlmSettings {
  return {
    ...DEFAULT_LLM,
    provider: 'openai',
    baseURL: 'https://cache.test/v1',
    model: 'cache-model',
    apiKey: 'sk-cache-000000000000',
    cache: true,
    maxRetries: 0,
    stream: false,
    ...patch,
  }
}

const ANSWER = '{"headline":"缓存里的答案","points":["甲","乙"]}'

function okResponse(text = ANSWER, usage = { prompt_tokens: 10, completion_tokens: 20 }): Response {
  return new Response(
    JSON.stringify({
      model: 'cache-model',
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function stubFetch(factory: () => Response = () => okResponse()): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => factory())
  vi.stubGlobal('fetch', mock)
  return mock
}

beforeEach(async () => {
  await cacheClear()
  resetCacheStats()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ai/cache 存取', () => {
  it('同 digest 第二次命中：不发 fetch', async () => {
    const fetchMock = stubFetch()
    const provider = new OpenAICompatProvider(llm())
    const req = { system: 'sys', user: 'usr', json: true, task: 'outline' as const }

    const first = await provider.complete(req)
    expect(first.cached).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const second = await provider.complete(req)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second.cached).toBe(true)
    expect(second.text).toBe(first.text)
    expect(cacheStats().hits).toBe(1)
  })

  it('命中时 onDelta 一次灌完（streamed:false）', async () => {
    const fetchMock = stubFetch()
    const provider = new OpenAICompatProvider(llm())
    const req = { system: 'sys', user: 'usr', json: true }
    await provider.complete(req)

    const deltas: string[] = []
    const hit = await provider.complete({ ...req, onDelta: (text) => deltas.push(text) })
    expect(hit.cached).toBe(true)
    expect(hit.streamed).toBe(false)
    expect(deltas).toEqual([ANSWER])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('TTL 过期 → 再发 fetch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = new Date('2026-10-28T00:00:00.000Z').getTime()
      vi.setSystemTime(start)
      const fetchMock = stubFetch()
      const provider = new OpenAICompatProvider(llm())
      const req = { system: 's', user: 'u', json: true }
      await provider.complete(req)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // 7 天内再取：命中，不发第二次。
      vi.setSystemTime(start + AI_CACHE_TTL_MS - 1000)
      const hit = await provider.complete(req)
      expect(hit.cached).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // 超过 TTL：过期 → 重新发。
      vi.setSystemTime(start + AI_CACHE_TTL_MS + 2000)
      const miss = await provider.complete(req)
      expect(miss.cached).toBeUndefined()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('LRU：超过 200 条按 at 升序淘汰最早的', async () => {
    const base = Date.now()
    for (let i = 0; i < AI_CACHE_MAX_ENTRIES + 5; i += 1) {
      await cachePut(
        { key: `k${i}`, task: 'slide', text: `t${i}`, model: 'm', format: 'auto', createdAt: base + i },
        base + i,
      )
    }
    const entries = await cacheEntries()
    expect(entries.length).toBe(AI_CACHE_MAX_ENTRIES)
    const keys = new Set(entries.map((entry) => entry.key))
    expect(keys.has('k0')).toBe(false)
    expect(keys.has('k4')).toBe(false)
    expect(keys.has('k5')).toBe(true)
    expect(keys.has(`k${AI_CACHE_MAX_ENTRIES + 4}`)).toBe(true)
  })

  it('坏 JSON 不入缓存；空文本也不入', async () => {
    expect(cacheableText('不是 JSON 的废话', true)).toBe(false)
    expect(cacheableText('{"ok":1}', true)).toBe(true)
    expect(cacheableText('   ', false)).toBe(false)

    const fetchMock = stubFetch(() => okResponse('这不是 JSON', { prompt_tokens: 1, completion_tokens: 1 }))
    const provider = new OpenAICompatProvider(llm())
    const result = await provider.complete({ system: 's', user: 'u', json: true })
    expect(result.text).toBe('这不是 JSON')
    expect(await cacheEntries()).toHaveLength(0)

    await provider.complete({ system: 's', user: 'u', json: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('换 model 自然 miss', async () => {
    const fetchMock = stubFetch()
    const req = { system: 's', user: 'u', json: true }
    await new OpenAICompatProvider(llm({ model: 'model-a' })).complete(req)
    await new OpenAICompatProvider(llm({ model: 'model-b' })).complete(req)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('kv 不可用时降级内存模式，缓存仍工作', async () => {
    // jsdom 没有 indexedDB → kv 一开始就是内存模式（这正是「降级仍工作」的场景）。
    expect(getStorageMode()).toBe('memory')
    const fetchMock = stubFetch()
    const provider = new OpenAICompatProvider(llm())
    await provider.complete({ system: 's', user: 'u', json: true })
    const hit = await provider.complete({ system: 's', user: 'u', json: true })
    expect(hit.cached).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('digest 口径：字段顺序稳定，model/format/task 变化即不同', () => {
    const base = { system: 's', user: 'u', model: 'm', format: 'auto' }
    expect(requestDigestOf(base)).toBe(requestDigestOf({ ...base }))
    expect(requestDigestOf(base)).not.toBe(requestDigestOf({ ...base, model: 'm2' }))
    expect(requestDigestOf(base)).not.toBe(requestDigestOf({ ...base, format: 'json_object' }))
    expect(requestDigestOf(base)).not.toBe(requestDigestOf({ ...base, task: 'slide' }))
    expect(requestDigestOf(base)).toHaveLength(10)
  })

  it('evict() 清掉过期条目并统计淘汰数', async () => {
    const now = Date.now()
    await cachePut({ key: 'fresh', task: 'outline', text: 'x', model: 'm', format: 'auto' }, now)
    await cachePut(
      { key: 'stale', task: 'outline', text: 'y', model: 'm', format: 'auto', createdAt: now - AI_CACHE_TTL_MS - 5 },
      now,
    )
    const removed = await evict(now)
    expect(removed).toBeGreaterThanOrEqual(1)
    const keys = (await cacheEntries()).map((entry) => entry.key)
    expect(keys).toEqual(['fresh'])
  })

  it('replay 通道不写缓存', async () => {
    const provider = new ReplayProvider({ setId: 'zh-normal', strict: false, speed: 0 })
    const result = await provider.complete({ system: '[TASK:outline]x', user: 'any', stream: false })
    expect(result.text.length).toBeGreaterThan(0)
    expect(await cacheEntries()).toHaveLength(0)
  })

  it('同 digest 并发去重：只发一次请求，onDelta 多播（§7.3）', async () => {
    resetInflight()
    const frame = (content: string) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
    const encoder = new TextEncoder()
    const mock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of [frame('甲'), frame('乙'), `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`, 'data: [DONE]\n\n']) {
            controller.enqueue(encoder.encode(chunk))
          }
          controller.close()
        },
      })
      return new Response(stream, { status: 200 })
    })
    vi.stubGlobal('fetch', mock)
    const provider = new OpenAICompatProvider(llm({ cache: false, stream: true }))
    const req = { system: 'dedupe', user: 'dedupe', json: true }
    const first: string[] = []
    const second: string[] = []
    const [a, b] = await Promise.all([
      provider.complete({ ...req, onDelta: (text) => first.push(text) }),
      provider.complete({ ...req, onDelta: (text) => second.push(text) }),
    ])
    expect(mock).toHaveBeenCalledTimes(1)
    expect(a.text).toBe('甲乙')
    expect(b.text).toBe('甲乙')
    expect(first.join('')).toBe('甲乙')
    expect(second.join('')).toBe('甲乙')
    expect(inflightCount()).toBe(0)
  })
})
