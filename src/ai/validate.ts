/**
 * validate.ts —— JSON 提取 + zod 校验 + 一次修复回喂。
 *
 * 规则：
 * - 模型输出可能带 ```json 围栏、前后解释、甚至两个 JSON 块，这里只取第一个完整对象；
 * - 校验失败时把 issue 列表原样回喂一次（`repair`），仍失败则抛结构化 `AiError('badJson')`；
 * - 任何失败都不允许把异常抛到 UI 之外：调用方只处理 `AiError`。
 */
import type { z } from 'zod'
import { AiError } from './provider'

/**
 * 去掉 Markdown 围栏与前后解释。闭合围栏优先；模型被截断时围栏可能没闭合，
 * 这里也兼容"只有开头 ```json"的情况，交给 closeTruncatedJson 补齐。
 */
function stripFenceNoise(text: string): string {
  const source = text.trim()
  const closed = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(source)
  if (closed && closed[1].trim() !== '') return closed[1].trim()
  const open = /```(?:json|JSON)?\s*([\s\S]*)$/.exec(source)
  if (open && open[1].trim() !== '') return open[1].trim()
  return source
}

/**
 * 从任意文本里抽出第一个 JSON 对象（支持 ```json 围栏与前后噪音）。
 * 找不到返回 null；括号不平衡时返回尽力而为的切片。
 */
export function extractJson(text: string): string | null {
  if (typeof text !== 'string') return null
  let source = text.trim()
  if (source === '') return null
  source = stripFenceNoise(source)

  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  const end = source.lastIndexOf('}')
  return end > start ? source.slice(start, end + 1) : null
}

/** zod issue → 一行人类可读文本（回喂给模型用）。 */
export function zodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
}

/**
 * 尽力修补被截断的 JSON 对象：补未闭合的字符串/对象/数组，清掉悬空的逗号或冒号。
 *
 * 使用场景：`none` 降级模式下模型不保证结构化输出，常见尾部截断
 * （`{"text":"…`、`{"items":["a","b"`）。修不好就返回 null，交给 repair 回喂，
 * 绝不把"半截 JSON"当成功结果。
 *
 * 注意：只在 `JSON.parse` 失败后作为兜底调用；合法 JSON 永远走原路径。
 */
export function closeTruncatedJson(text: string): string | null {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  if (start < 0) return null
  const source = text.slice(start)

  const closers: string[] = []
  let inString = false
  let escaped = false
  let lastSignificant = ''

  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') {
        inString = false
        lastSignificant = '"'
      }
      continue
    }
    if (char === '"') {
      inString = true
      lastSignificant = '"'
      continue
    }
    if (char === '{') closers.push('}')
    else if (char === '[') closers.push(']')
    else if (char === '}' || char === ']') closers.pop()
    if (!/\s/.test(char)) lastSignificant = char
  }

  let out = source
  if (inString) {
    if (escaped) out = out.slice(0, -1)
    out += '"'
    lastSignificant = '"'
  }
  if (lastSignificant === ',') out = out.replace(/,\s*$/, '')
  else if (lastSignificant === ':') out += ' null'

  for (let i = closers.length - 1; i >= 0; i -= 1) out += closers[i]
  try {
    JSON.parse(out)
    return out
  } catch {
    return null
  }
}

export interface ParseWithRepairOptions {
  /** 修复回调：拿到 issue 列表，返回模型重写的文本；返回 null 表示不再重试。 */
  repair?: (issues: string[]) => Promise<string | null>
  signal?: AbortSignal
  /** 修复次数上限，默认 1（"回喂一次"）。 */
  maxRepair?: number
}

/**
 * 解析 + 校验 + 修复环。成功返回 schema 的解析结果，失败抛 `AiError('badJson')`。
 */
export async function parseWithRepair<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  text: string,
  opts: ParseWithRepairOptions = {},
): Promise<T> {
  const maxRepair = opts.maxRepair ?? 1
  let current = text
  let issues: string[] = []

  for (let attempt = 0; attempt <= maxRepair; attempt += 1) {
    if (opts.signal?.aborted) throw new AiError('timeout', 'aborted', true)

    if (attempt > 0) {
      if (!opts.repair) break
      const repaired = await opts.repair(issues)
      if (repaired === null || repaired.trim() === '') break
      current = repaired
    }

    const json = extractJson(current) ?? closeTruncatedJson(stripFenceNoise(current))
    if (!json) {
      issues = ['输出里没有 JSON 对象']
      continue
    }

    let value: unknown
    let parsed = false
    try {
      value = JSON.parse(json)
      parsed = true
    } catch (error) {
      // 先尝试补齐截断的括号/引号（`none` 降级模式的常见输出），修不好再走 repair。
      const closed = closeTruncatedJson(json)
      if (closed) {
        try {
          value = JSON.parse(closed)
          parsed = true
        } catch {
          /* 修补后仍解析失败，交给下面的 repair */
        }
      }
      if (!parsed) {
        issues = [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`]
        continue
      }
    }
    if (!parsed) continue

    const result = schema.safeParse(value)
    if (result.success) return result.data
    issues = zodIssues(result.error)
  }

  const detail = issues.length > 0 ? issues.slice(0, 4).join(' | ') : '结构校验失败'
  throw new AiError('badJson', detail)
}

/** 把修复 issue 拼进 user 消息（真端点重试时用）。 */
export function repairPrompt(user: string, issues: string[]): string {
  return `${user}

上一次输出没有通过结构校验，问题如下：
${issues.map((issue) => `- ${issue}`).join('\n')}

请只输出修正后的 JSON 对象：不要解释、不要 Markdown 围栏、不要新增字段。`
}
