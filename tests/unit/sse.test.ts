/**
 * sse.test.ts —— SSE 解析与流式通道（`05` §13.1 的 9 条边界 + `07` L-05）。
 *
 * 前 8 条是纯函数级（切帧/心跳/多行/半帧/UTF-8 跨 chunk），
 * 后 4 条是通道级（`finish_reason` 正常收尾、坏 JSON 帧 → `streamBroken`、`[DONE]` 后丢弃、半帧丢弃）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSseParser, parseSseFrame, readSseStream, type SseEvent } from '@/ai/sse'
import {
  AiError,
  OpenAICompatProvider,
  errorCodeForStatus,
  isAborted,
  redact,
  type CompleteRequest,
} from '@/ai/provider'
import { DEFAULT_LLM, type LlmSettings } from '@/state/settingsStore'

/* ------------------------------- 工具 ------------------------------- */

function encoderStream(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      controller.close()
    },
  })
}

function deltaFrame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\r\n\r\n`
}

function stopFrame(usage = { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 }): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    model: 'stub-model',
    usage,
  })}\r\n\r\n`
}

function llm(patch: Partial<LlmSettings> = {}): LlmSettings {
  return {
    ...DEFAULT_LLM,
    provider: 'openai',
    baseURL: 'https://stub.test/v1',
    model: 'stub-model',
    apiKey: 'sk-stub-000000000000',
    cache: false,
    maxRetries: 0,
    ...patch,
  }
}

function stubFetch(bodies: ReadableStream<Uint8Array>[] | ((call: number) => Response)): ReturnType<typeof vi.fn> {
  let call = 0
  const mock = vi.fn(async () => {
    call += 1
    if (typeof bodies === 'function') return bodies(call)
    const stream = bodies[Math.min(call - 1, bodies.length - 1)]
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/* ------------------------------- 解析器 ------------------------------- */

describe('ai/sse 解析器', () => {
  it('帧边界切在 \\r\\n\\r\\n 中间也能切出完整帧', () => {
    const parser = createSseParser()
    const frames = [deltaFrame('你好'), deltaFrame('世界'), stopFrame(), 'data: [DONE]\r\n\r\n']
    const raw = frames.join('')
    const events: SseEvent[] = []
    // 逐字符喂：边界必然被切开。
    for (const char of raw) events.push(...parser.push(char))
    const data = events.map((event) => event.data)
    expect(data).toHaveLength(4)
    expect(data[0]).toContain('你好')
    expect(data[3]).toBe('[DONE]')
    expect(parser.done).toBe(true)
    expect(parser.end().tail).toBe('')
  })

  it('多行 data 用 \\n 拼接（每行只剥一个前导空格）', () => {
    const frame = 'data: {"a":1,\ndata:  "b":2}\n\n'
    const events = createSseParser().push(frame)
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('{"a":1,\n "b":2}')
    expect(JSON.parse(events[0].data)).toEqual({ a: 1, b: 2 })
  })

  it('心跳、空行与 retry 被丢弃，event/id 保留', () => {
    const raw = ': ping\n\n\nevent: message\nid: 7\nretry: 500\ndata: hello\n\n'
    const events = createSseParser().push(raw)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ data: 'hello', event: 'message', id: '7' })
  })

  it('[DONE] 之后的字节一律丢弃（同 chunk 与后续 push）', () => {
    const parser = createSseParser()
    const events = parser.push(`data: one\n\ndata: [DONE]\n\ndata: two\n\n`)
    expect(events.map((event) => event.data)).toEqual(['one', '[DONE]'])
    expect(parser.push(deltaFrame('three'))).toEqual([])
    expect(parser.done).toBe(true)
  })

  it('流结束时半帧进 tail，不冒充值', () => {
    const parser = createSseParser()
    parser.push('data: {"choices":[{"delta":{"content":"半')
    const ended = parser.end()
    expect(ended.events).toEqual([])
    expect(ended.tail).toContain('半')
  })

  it('空 data: 行解析为空字符串事件，不炸', () => {
    const events = createSseParser().push('data:\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('')
  })

  it('parseSseFrame 对纯心跳返回 null', () => {
    expect(parseSseFrame(': keep-alive')).toBeNull()
    expect(parseSseFrame('')).toBeNull()
  })

  it('中文 UTF-8 跨 3 个 byte chunk 按 code unit 切也能还原', async () => {
    const bytes = new TextEncoder().encode(deltaFrame('慢慢来，比较快'))
    const split = [
      bytes.slice(0, 12),
      bytes.slice(12, 13),
      bytes.slice(13, 20),
      bytes.slice(20),
    ]
    const events: SseEvent[] = []
    await readSseStream(encoderStream(split), { onEvent: (event) => events.push(event) })
    expect(events).toHaveLength(1)
    expect(events[0].data).toContain('慢慢来，比较快')
  })
})

/* ------------------------------- 通道级 ------------------------------- */

async function collectStream(
  raw: (string | Uint8Array)[],
  req: Partial<CompleteRequest> = {},
): Promise<{ result: Awaited<ReturnType<OpenAICompatProvider['complete']>>; deltas: string[]; fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = stubFetch([encoderStream(raw)])
  const provider = new OpenAICompatProvider(llm())
  const deltas: string[] = []
  const result = await provider.complete({
    system: 'sys',
    user: 'usr',
    json: true,
    stream: true,
    onDelta: (text) => deltas.push(text),
    ...req,
  })
  return { result, deltas, fetchMock }
}

describe('ai/sse 流式通道', () => {
  it('多帧 delta 逐帧回传，最终 text 为拼接结果，usage 取末帧', async () => {
    const { result, deltas, fetchMock } = await collectStream([
      deltaFrame('{"headline":'),
      ': heartbeat\n\n',
      deltaFrame('"慢就是快"}'),
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 34 } })}\r\n\r\n`,
      'data: [DONE]\r\n\r\n',
    ])
    expect(deltas).toEqual(['{"headline":', '"慢就是快"}'])
    expect(result.text).toBe('{"headline":"慢就是快"}')
    expect(result.streamed).toBe(true)
    expect(result.finish).toBe('stop')
    expect(result.usage).toEqual({ prompt: 12, completion: 34 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('无 [DONE] 但已见 finish_reason → 正常收尾', async () => {
    const { result } = await collectStream([deltaFrame('ok'), stopFrame()])
    expect(result.text).toBe('ok')
    expect(result.finish).toBe('stop')
  })

  it('坏 JSON 帧 → streamBroken（回退也失败时抛原错误）', async () => {
    stubFetch((call) =>
      call === 1
        ? new Response(encoderStream(['data: {not json}\n\n']), { status: 200 })
        : new Response('{"error":"nope"}', { status: 500 }),
    )
    const provider = new OpenAICompatProvider(llm())
    await expect(provider.complete({ system: 's', user: 'u', stream: true })).rejects.toMatchObject({
      code: 'streamBroken',
    })
  })

  it('已收 delta 后遇到坏帧 → 不解 streamBroken 冒泡，改为交回已收文本', async () => {
    stubFetch(() => new Response(encoderStream([deltaFrame('ok'), 'data: {not json}\n\n']), { status: 200 }))
    const provider = new OpenAICompatProvider(llm())
    const result = await provider.complete({ system: 's', user: 'u', stream: true })
    expect(result.text).toBe('ok')
    expect(result.finish).toBe('aborted')
  })

  it('[DONE] 之后的多余帧不会进 text', async () => {
    const { result } = await collectStream([
      deltaFrame('A'),
      'data: [DONE]\n\n',
      deltaFrame('B'),
      stopFrame(),
    ])
    expect(result.text).toBe('A')
  })

  it('半帧收尾 → streamBroken（未收到 delta 时）', async () => {
    stubFetch((call) =>
      call === 1
        ? new Response(encoderStream(['data: {"choices":[{"delta":{"content":"半']), { status: 200 })
        : new Response('{"error":"nope"}', { status: 500 }),
    )
    const provider = new OpenAICompatProvider(llm())
    await expect(provider.complete({ system: 's', user: 'u', stream: true })).rejects.toMatchObject({
      code: 'streamBroken',
    })
  })

  it('已收到 delta 后断流 → 不重发，返回 partial（finish: aborted）', async () => {
    stubFetch(() => new Response(encoderStream([deltaFrame('甲'), deltaFrame('乙')]), { status: 200 }))
    const provider = new OpenAICompatProvider(llm())
    const deltas: string[] = []
    const result = await provider.complete({
      system: 's',
      user: 'u',
      stream: true,
      onDelta: (text) => deltas.push(text),
    })
    expect(deltas).toEqual(['甲', '乙'])
    expect(result.text).toBe('甲乙')
    expect(result.finish).toBe('aborted')
  })

  it('未就绪：baseURL 为空直接 notConfigured', async () => {
    const provider = new OpenAICompatProvider(llm({ baseURL: '' }))
    await expect(provider.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(AiError)
    await expect(provider.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'notConfigured' })
  })
})

/* --------------------------- 错误矩阵与退避（§6 / §7） --------------------------- */

describe('错误码矩阵', () => {
  it('状态码 × body 特征 → 11 码里的 6 个新码', () => {
    expect(errorCodeForStatus(401, '')).toBe('auth')
    expect(errorCodeForStatus(403, 'nope')).toBe('auth')
    expect(errorCodeForStatus(429, 'slow down')).toBe('rateLimit')
    expect(errorCodeForStatus(429, 'insufficient balance 余额不足')).toBe('quota')
    expect(errorCodeForStatus(402, '')).toBe('quota')
    expect(errorCodeForStatus(400, 'maximum context length is 8192')).toBe('contextLength')
    expect(errorCodeForStatus(413, 'too many tokens')).toBe('contextLength')
    expect(errorCodeForStatus(404, 'model not found: foo')).toBe('modelNotFound')
    expect(errorCodeForStatus(400, 'model gpt-x does not exist')).toBe('modelNotFound')
    expect(errorCodeForStatus(500, 'boom')).toBe('network')
  })

  it('redact 打码 key / bearer / query', () => {
    expect(redact('key sk-abcdefghijklmnop failed')).toBe('key sk-*** failed')
    expect(redact('authorization: Bearer abcdefghijkl')).toContain('Bearer ***')
    expect(redact('https://x/v1?api_key=secret123&y=1')).toContain('api_key=***')
  })

  it('401 不重试：只发一次请求', async () => {
    const fetchMock = stubFetch([encoderStream(['data: [DONE]\n\n'])])
    fetchMock.mockImplementation(async () => new Response('{"error":"bad key"}', { status: 401 }))
    const provider = new OpenAICompatProvider(llm({ stream: false, maxRetries: 2 }))
    await expect(provider.complete({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'auth' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('500 按 maxRetries 重试后成功（同 body）', async () => {
    let call = 0
    const bodies: string[] = []
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1
      bodies.push(String(init.body))
      if (call <= 2) return new Response('{"error":"boom"}', { status: 500 })
      return new Response(
        JSON.stringify({ model: 'stub-model', choices: [{ message: { content: '{"ok":1}' } }] }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', mock)
    const provider = new OpenAICompatProvider(llm({ stream: false, maxRetries: 2 }))
    const result = await provider.complete({ system: 's', user: 'u', json: true })
    expect(result.text).toBe('{"ok":1}')
    expect(mock).toHaveBeenCalledTimes(3)
    expect(new Set(bodies).size).toBe(1)
  }, 15_000)

  it('json_schema 被拒 → 降为 json_object 重发一次', async () => {
    const sent: Record<string, unknown>[] = []
    let call = 0
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      if (call === 1) return new Response('{"error":"unknown response_format schema"}', { status: 400 })
      return new Response(
        JSON.stringify({ model: 'stub-model', choices: [{ message: { content: '{"ok":1}' } }] }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', mock)
    const provider = new OpenAICompatProvider(llm({ stream: false, jsonMode: true, format: 'strict' }))
    const result = await provider.complete({
      system: 's',
      user: 'u',
      json: true,
      schema: { name: 'outline', json: { type: 'object' } },
    })
    expect(result.text).toBe('{"ok":1}')
    expect(sent[0].response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'outline', schema: { type: 'object' }, strict: true },
    })
    expect(sent[1].response_format).toEqual({ type: 'json_object' })
    expect(result.effectiveFormat).toBe('json_object')
  })

  it('取消：外部 abort → timeout/aborted，isAborted 命中', async () => {
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(deltaFrame('甲')))
          // 不主动 close：让流挂住，直到外部取消（真 fetch 同样会以 AbortError 结束）。
          signal.addEventListener(
            'abort',
            () => controller.error(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        },
      })
      return new Response(stream, { status: 200 })
    })
    vi.stubGlobal('fetch', mock)
    const controller = new AbortController()
    const provider = new OpenAICompatProvider(llm({ stream: true, firstByteTimeoutMs: 30_000 }))
    const promise = provider.complete({ system: 's', user: 'u', stream: true, signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    const failure = await promise.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AiError)
    expect(isAborted(failure)).toBe(true)
    expect((failure as AiError).code).toBe('timeout')
    expect((failure as AiError).detail).toBe('aborted')
    expect(mock).toHaveBeenCalledTimes(1)
  }, 5_000)
})
