/**
 * sse.ts —— 手写 SSE（Server-Sent Events）解析器：零依赖、可增式喂入、可单测。
 *
 * 依据 `plan/v0.2.0/05-LLM接入规格.md` §4.2–§4.3 的逐条规则：
 * 1. 帧边界 `\n\n`，同时接受 `\r\n\r\n`（可切在任意位置），行尾单个 `\r` 先剥；
 * 2. 行首 `:` → 心跳注释，丢弃；空行不是帧内容；
 * 3. `data:` 后仅剥一个前导空格；多行 `data` 用 `\n` 拼接；
 * 4. `event:` / `id:` 解析并保留（`retry:` 读掉但不使用）；
 * 5. `[DONE]` 之后所有字节丢弃（部分网关会多发一帧）；
 * 6. 帧 JSON 坏的判定不在这里（本模块只切帧，`provider.ts` 负责把它变成 `streamBroken`）；
 * 7. 无 `[DONE]` 但已见 `finish_reason` → 由调用方按正常收尾处理；
 * 8. 流结束时残留 buffer（半帧）→ 由 `end()` 原样交回，调用方决定丢弃并报 `streamBroken('tail')`。
 *
 * 设计取舍：解析器**不做 JSON**、**不抛异常**，只做「字节流 → 事件」，这样每条规则都能独立断言。
 */

/** 一帧解析结果：`data` 已按 SSE 规则拼接（多行用 `\n`）。 */
export interface SseEvent {
  data: string
  event?: string
  id?: string
}

export interface SseEndResult {
  /** 结束时仍能组成完整帧的事件（正常为空：帧都在 `push` 里发出了）。 */
  events: SseEvent[]
  /** 未形成完整帧的残留文本；空字符串表示干净收尾。 */
  tail: string
}

export interface SseParser {
  /** 喂入一段文本（可以是任意切分，含半个帧边界、半个汉字）。 */
  push(chunk: string): SseEvent[]
  /** 结束输入：返回残留半帧。 */
  end(): SseEndResult
  /** 见过 `[DONE]` 后为真（此后 `push` 一律丢弃）。 */
  readonly done: boolean
  /** 当前未成帧的缓冲区（诊断用）。 */
  readonly buffered: string
}

/** `[DONE]` 的唯一判定口径（`data: [DONE]` 与 `data:[DONE]` 等价）。 */
export const SSE_DONE = '[DONE]'

const BOUNDARIES = ['\r\n\r\n', '\n\n', '\r\r'] as const

function findBoundary(buffer: string): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null
  for (const token of BOUNDARIES) {
    const index = buffer.indexOf(token)
    if (index < 0) continue
    if (best === null || index < best.index) best = { index, length: token.length }
  }
  return best
}

/** 单帧文本（不含帧边界）→ 事件；纯心跳/纯空行返回 null。 */
export function parseSseFrame(frame: string): SseEvent | null {
  const lines = frame.split('\n')
  const data: string[] = []
  let event: string | undefined
  let id: string | undefined

  for (const rawLine of lines) {
    // 规则 1：行尾单个 `\r` 先剥（`\r\n` 与 `\r` 两种换行都覆盖）。
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') continue
    // 规则 2：`:` 开头是注释/心跳。
    if (line.startsWith(':')) continue

    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    // 规则 3：只剥一个前导空格。
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    else if (field === 'id') id = value
    // `retry:` 读掉即弃（当前无用途）。
  }

  // 规则 2：没有 data 也没有 event 的帧（空行/纯心跳）不产生事件。
  if (data.length === 0 && event === undefined) return null
  return { data: data.join('\n'), event, id }
}

export function createSseParser(): SseParser {
  let buffer = ''
  let done = false

  return {
    get done() {
      return done
    },
    get buffered() {
      return buffer
    },
    push(chunk: string): SseEvent[] {
      // 规则 5：`[DONE]` 之后所有字节丢弃。
      if (done || chunk === '') return []
      buffer += chunk
      const events: SseEvent[] = []

      for (;;) {
        const boundary = findBoundary(buffer)
        if (boundary === null) break
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        const parsed = parseSseFrame(frame)
        if (parsed === null) continue
        events.push(parsed)
        if (parsed.data.trim() === SSE_DONE) {
          done = true
          buffer = ''
          break
        }
      }

      return events
    },
    end(): SseEndResult {
      if (done) return { events: [], tail: '' }
      const tail = buffer
      buffer = ''
      // 纯空白残留（例如最后一个 `\n` 之后的空行）不算半帧。
      return { events: [], tail: tail.trim() === '' ? '' : tail }
    },
  }
}

export interface SseStreamHooks {
  onEvent: (event: SseEvent) => void
  /** 收到第一个字节（三层计时器的首字节闸门用它复位）。 */
  onFirstByte?: () => void
  /** 每收到一段文本（帧间隔 idle 计时器用它复位）。 */
  onActivity?: () => void
  /** 流结束时仍有半帧残留（调用方决定是否报 `streamBroken('tail')`）。 */
  onTail?: (tail: string) => void
}

/**
 * 把一个字节流喂给 SSE 解析器。
 *
 * UTF-8 跨 chunk 由 `TextDecoder({stream:true})` 处理：多字节汉字被切成 3 段也能还原，
 * 不需要在字符层做任何补救。读取错误原样上抛，由调用方归因（`streamBroken` / `timeout`）。
 */
export async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  hooks: SseStreamHooks,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  const parser = createSseParser()
  let sawByte = false

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      if (!sawByte) {
        sawByte = true
        hooks.onFirstByte?.()
      }
      hooks.onActivity?.()
      const text = decoder.decode(value, { stream: true })
      if (text === '') continue
      for (const event of parser.push(text)) hooks.onEvent(event)
    }
    for (const event of parser.push(decoder.decode())) hooks.onEvent(event)
  } finally {
    reader.releaseLock()
  }

  const tail = parser.end().tail
  if (tail !== '') hooks.onTail?.(tail)
}
