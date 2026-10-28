/**
 * streamJson.ts —— 增量 JSON 字段流（`05` §4.7）：把模型的 token 流还原成「字段值 → 上屏」。
 *
 * 为什么不对半截文本反复 `JSON.parse`：那是 O(n²)，而且 1e6 字符的 SVG 会直接把主线程钉住。
 * 这里用一个单遍状态机，只扫**顶层**字符串字段，数组字段按 `points[0..n]` 逐条落位。
 *
 * 规则（逐条对应 §4.7 表格）：
 * - 只扫顶层：`objectDepth === 1 && bracketDepth === 0` 才是字段区；嵌套对象里的同名 key 不触发；
 * - 起始判定：`"key"` + 任意空白 + `:` + 任意空白 + `"`；
 * - 转义：`\" \\ \/ \n \t \r \b \f` 直接映射；`\uXXXX` 四位未到齐**不 emit**，到齐后再发；
 * - 结束：未转义的 `"`；此后回到扫描态（下一个顶层 key / 闭合 `}`）；
 * - 内存上限：缓冲 64KB，超限只保留尾 4KB 并暂停 emit（防 SVG 巨型字符串）；
 * - 未闭合：`end()` 时以 `final:false` + 空值丢弃该字段。
 */

export type FieldEmit = (key: string, value: string, final: boolean) => void

export interface FieldStreamer {
  /** 喂入一段 delta（可以是任意切分，含半个 key、半个转义、半个汉字）。 */
  push(delta: string): void
  /** 当前已知的字段值（含未完成字段的最新前缀）。 */
  snapshot(): Partial<Record<string, string>>
  /** 结束：未闭合字段以 `final:false` 丢弃。 */
  end(): void
}

/** 单个字段的缓冲上限；超限后只保留尾部续接，并停止 emit。 */
export const FIELD_BUFFER_LIMIT = 64 * 1024
export const FIELD_BUFFER_TAIL = 4 * 1024

type Phase = 'scan' | 'key' | 'skipString' | 'value' | 'arrayValue'

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
}

/**
 * @param keys 需要捕获的顶层字段名；数组字段（如 `points`）按 `points[n]` 逐个元素 emit。
 * @param emit 值更新回调：`final:false` 是流式前缀，`final:true` 是完整值。
 */
export function createFieldStreamer(keys: readonly string[], emit: FieldEmit): FieldStreamer {
  const wanted = new Set(keys)
  const snapshot: Partial<Record<string, string>> = {}

  let phase: Phase = 'scan'
  let objectDepth = 0
  let bracketDepth = 0

  /** 顶层字段区里，此刻是否「期待一个 key」。字符串值不会被误判成 key。 */
  let expectKey = true
  /** 刚读完的、需要捕获的顶层 key。 */
  let pendingKey: string | null = null
  /** 正在落位的数组字段名与元素下标。 */
  let arrayBase: string | null = null
  let arrayIndex = 0

  let keyBuf = ''
  let keyEscaped = false
  let skipEscaped = false

  let captureKey: string | null = null
  let capBuf = ''
  let capEscaped = false
  let uBuf: string | null = null
  /** 超限后暂停 emit（值仍然被吃掉，但不再上屏）。 */
  let paused = false
  /** 本次 push 是否更新了当前字段（用于每段 delta 只 emit 一次）。 */
  let dirty = false

  function emitCurrent(final: boolean): void {
    if (captureKey === null || paused) return
    snapshot[captureKey] = capBuf
    emit(captureKey, capBuf, final)
    dirty = false
  }

  function beginCapture(key: string, asArray: boolean): void {
    captureKey = key
    capBuf = ''
    capEscaped = false
    uBuf = null
    paused = false
    dirty = false
    expectKey = false
    pendingKey = null
    phase = asArray ? 'arrayValue' : 'value'
  }

  function finishCapture(): void {
    emitCurrent(true)
    captureKey = null
    capBuf = ''
    capEscaped = false
    uBuf = null
    paused = false
    dirty = false
    phase = 'scan'
    expectKey = false
    pendingKey = null
  }

  /** 单字符转义解码；返回要追加到缓冲的文本（可能为空）。 */
  function feedEscaped(char: string): string {
    if (uBuf !== null) {
      uBuf += char
      if (uBuf.length < 4) return ''
      const code = Number.parseInt(uBuf, 16)
      uBuf = null
      return Number.isFinite(code) ? String.fromCharCode(code) : ''
    }
    if (capEscaped) {
      capEscaped = false
      if (char === 'u') {
        uBuf = ''
        return ''
      }
      return SIMPLE_ESCAPES[char] ?? char
    }
    if (char === '\\') {
      capEscaped = true
      return ''
    }
    return char
  }

  /** 转义序列是否完整（不完整时本次 push 不 emit，等下一段补齐）。 */
  function escapePending(): boolean {
    return uBuf !== null || capEscaped
  }

  function feed(char: string): void {
    switch (phase) {
      case 'key': {
        if (keyEscaped) {
          keyEscaped = false
          keyBuf += char
          return
        }
        if (char === '\\') {
          keyEscaped = true
          return
        }
        if (char === '"') {
          const name = keyBuf
          keyBuf = ''
          phase = 'scan'
          expectKey = false
          pendingKey = wanted.has(name) && objectDepth === 1 && bracketDepth === 0 ? name : null
          return
        }
        keyBuf += char
        return
      }

      case 'skipString': {
        if (skipEscaped) {
          skipEscaped = false
          return
        }
        if (char === '\\') {
          skipEscaped = true
          return
        }
        if (char === '"') {
          phase = 'scan'
          expectKey = false
        }
        return
      }

      case 'value':
      case 'arrayValue': {
        if (char === '"' && !escapePending()) {
          const wasArray = phase === 'arrayValue'
          finishCapture()
          if (wasArray) arrayIndex += 1
          return
        }
        const piece = feedEscaped(char)
        // 暂停后仍然解析转义（否则巨型字符串里的 \" 会误判字段结束），但不再累积、不再上屏。
        if (paused || piece === '') return
        capBuf += piece
        dirty = true
        if (capBuf.length > FIELD_BUFFER_LIMIT) {
          capBuf = capBuf.slice(-FIELD_BUFFER_TAIL)
          paused = true
          capEscaped = false
          uBuf = null
        }
        return
      }

      case 'scan':
      default: {
        if (char === '"') {
          if (pendingKey !== null && objectDepth === 1 && bracketDepth === 0) {
            beginCapture(pendingKey, false)
            return
          }
          if (arrayBase !== null && objectDepth === 1 && bracketDepth === 1 && !expectKey) {
            beginCapture(`${arrayBase}[${arrayIndex}]`, true)
            return
          }
          if (expectKey) {
            keyBuf = ''
            keyEscaped = false
            phase = 'key'
            return
          }
          phase = 'skipString'
          return
        }
        if (char === '{') {
          objectDepth += 1
          if (objectDepth === 1) expectKey = true
          return
        }
        if (char === '}') {
          objectDepth = Math.max(0, objectDepth - 1)
          expectKey = false
          pendingKey = null
          if (objectDepth === 0) {
            bracketDepth = 0
            arrayBase = null
          }
          return
        }
        if (char === '[') {
          bracketDepth += 1
          expectKey = false
          if (bracketDepth === 1 && objectDepth === 1 && pendingKey !== null) {
            arrayBase = pendingKey
            arrayIndex = 0
            pendingKey = null
          }
          return
        }
        if (char === ']') {
          bracketDepth = Math.max(0, bracketDepth - 1)
          expectKey = false
          if (bracketDepth === 0) arrayBase = null
          return
        }
        if (char === ',') {
          expectKey = objectDepth === 1 && bracketDepth === 0
          pendingKey = null
          return
        }
        return
      }
    }
  }

  return {
    push(delta: string): void {
      if (delta === '') return
      dirty = false
      let i = 0
      while (i < delta.length) {
        if (paused && captureKey !== null) {
          // 超限字段的快速通道：只关心转义与结束引号，逐字符 3 次比较，1e6 字符也在毫秒级。
          const char = delta[i]
          if (capEscaped) {
            capEscaped = false
          } else if (char === '\\') {
            capEscaped = true
          } else if (char === '"') {
            finishCapture()
          }
          i += 1
          continue
        }
        feed(delta[i])
        i += 1
      }
      // 一段 delta 只发一次前缀值（避免逐字符刷屏）。
      if (dirty && captureKey !== null) emitCurrent(false)
    },
    snapshot(): Partial<Record<string, string>> {
      const out: Partial<Record<string, string>> = { ...snapshot }
      if (captureKey !== null && !paused) out[captureKey] = capBuf
      return out
    },
    end(): void {
      // 未闭合：以空值 + final:false 丢弃（不把半截 JSON 当成值）。
      if ((phase === 'value' || phase === 'arrayValue') && captureKey !== null) {
        const key = captureKey
        captureKey = null
        if (!paused) emit(key, '', false)
      }
      phase = 'scan'
      captureKey = null
      capBuf = ''
      capEscaped = false
      uBuf = null
      paused = false
      dirty = false
    },
  }
}
