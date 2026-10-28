/**
 * provider.ts —— 模型通道的唯一抽象层。
 *
 * - `AiProvider` 只有 `complete` 一个能力：system + user → text。
 * - `OpenAICompatProvider` 单文件 fetch，不引 SDK；JSON 模式被拒时自动降级重试一次；
 *   超时 / 取消 / 鉴权 / 网络 / 非 JSON 全部归一成 `AiError`。
 * - `MockProvider` 是离线确定性生成器：按 prompt 种子选语料与素材，产出可直接演示的 JSON。
 * - 路由：`isLlmReady(llm) ? openai : mock`，UI 用 `ai.panel.mockBadge` 明示当前通道。
 */
import type { LlmSettings } from '@/state/settingsStore'
import { isLlmReady, useSettingsStore } from '@/state/settingsStore'
import { mockOutline, mockSlideContent, type MockOutlineInput, type MockSlideInput } from './corpus'
import { mockSvgArt, mockThreeScene } from './art'

/* -------------------------------- 错误模型 -------------------------------- */

export type AiErrorCode = 'network' | 'auth' | 'timeout' | 'badJson' | 'notConfigured'

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

/* -------------------------------- 通道接口 -------------------------------- */

export interface CompleteRequest {
  system: string
  user: string
  json?: boolean
  temperature?: number
  signal?: AbortSignal
}

export interface CompleteResult {
  text: string
  usage?: { prompt: number; completion: number }
}

export interface AiProvider {
  id: 'mock' | 'openai'
  label: string
  complete(req: CompleteRequest): Promise<CompleteResult>
}

/* ------------------------------ Mock 通道 ------------------------------ */

/** 模拟一点延迟，让进度条与取消按钮有意义；测试环境为 0。 */
const TEST_MODE = typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'test'
export const MOCK_LATENCY_MS = TEST_MODE ? 0 : 110

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(new AiError('timeout', 'aborted', true))
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AiError('timeout', 'aborted', true))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AiError('timeout', 'aborted', true))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 从 system prompt 里读任务标记（提示词自带 `[TASK:x]`，Mock 据此分派）。 */
export function taskOf(system: string): string {
  const match = /\[TASK:([a-z0-9-]+)\]/i.exec(system)
  return match ? match[1].toLowerCase() : ''
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

export class MockProvider implements AiProvider {
  readonly id = 'mock' as const
  readonly label = 'Local mock'
  private readonly latencyMs: number

  constructor(opts: { latencyMs?: number } = {}) {
    this.latencyMs = opts.latencyMs ?? MOCK_LATENCY_MS
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    await wait(this.latencyMs, req.signal)
    const text = mockText(req)
    return {
      text,
      usage: { prompt: estimateTokens(req.system + req.user), completion: estimateTokens(text) },
    }
  }
}

/* --------------------------- OpenAI 兼容通道 --------------------------- */

interface ChatPayload {
  choices?: { message?: { content?: unknown } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function normalizeEndpoint(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, '')
  if (base === '') return ''
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`
}

export class OpenAICompatProvider implements AiProvider {
  readonly id = 'openai' as const
  readonly label = 'OpenAI-compatible'

  constructor(private readonly llm: LlmSettings) {}

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const endpoint = normalizeEndpoint(this.llm.baseURL)
    const model = this.llm.model.trim()
    if (endpoint === '' || model === '') throw new AiError('notConfigured', 'baseURL/model 为空')

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      temperature: req.temperature ?? this.llm.temperature,
      stream: false,
    }
    const wantJson = req.json === true && this.llm.jsonMode
    if (wantJson) body.response_format = { type: 'json_object' }

    let response = await this.post(endpoint, body, req.signal)

    // 部分兼容端点不支持 response_format：400/404/422 且响应提到 json 时降级重试一次。
    if (!response.ok && wantJson && [400, 404, 422].includes(response.status)) {
      const text = await response.text().catch(() => '')
      if (/json/i.test(text)) {
        delete body.response_format
        response = await this.post(endpoint, body, req.signal)
      } else {
        throw this.fail(response.status, text)
      }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw this.fail(response.status, text)
    }

    const payload = (await response.json().catch(() => null)) as ChatPayload | null
    if (!payload) throw new AiError('badJson', '响应不是合法 JSON')

    const content = payload.choices?.[0]?.message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .map((part) => {
          if (typeof part === 'string') return part
          if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text ?? '')
          return ''
        })
        .join('')
    }
    if (text.trim() === '') throw new AiError('badJson', 'choices[0].message.content 为空')

    const usage = payload.usage
    return {
      text,
      usage:
        usage && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined)
          ? { prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0 }
          : undefined,
    }
  }

  /** 单次 POST：超时 + 外部取消 + 网络错误归一。 */
  private async post(url: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const timeoutMs = Math.max(1000, this.llm.timeoutMs || 90_000)
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        throw new AiError('timeout', 'aborted', true)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.llm.apiKey.trim() !== '' ? { authorization: `Bearer ${this.llm.apiKey.trim()}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (signal?.aborted) throw new AiError('timeout', 'aborted', true)
      if (timedOut) throw new AiError('timeout', `超过 ${timeoutMs}ms`)
      throw new AiError('network', aiErrorMessage(error))
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private fail(status: number, bodyText: string): AiError {
    const snippet = bodyText.replace(/\s+/g, ' ').slice(0, 180)
    if (status === 401 || status === 403) return new AiError('auth', `HTTP ${status} ${snippet}`.trim())
    return new AiError('network', `HTTP ${status} ${snippet}`.trim())
  }
}

/* --------------------------------- 路由 --------------------------------- */

export function providerFor(llm: LlmSettings): AiProvider {
  return isLlmReady(llm) ? new OpenAICompatProvider(llm) : new MockProvider()
}

/** 读当前设置决定通道（UI 与管线共用）。 */
export function currentProvider(): AiProvider {
  return providerFor(useSettingsStore.getState().llm)
}

/** 通道展示信息（徽标用）。 */
export function channelInfo(llm: LlmSettings): { id: 'mock' | 'openai'; ready: boolean; model: string; host: string } {
  const ready = isLlmReady(llm)
  let host = ''
  try {
    host = llm.baseURL.trim() === '' ? '' : new URL(llm.baseURL.trim()).host
  } catch {
    host = llm.baseURL.trim().replace(/^https?:\/\//i, '').split('/')[0] ?? ''
  }
  return { id: ready ? 'openai' : 'mock', ready, model: llm.model.trim(), host }
}
