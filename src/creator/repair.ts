/**
 * creator/repair.ts —— 提案的「语法预检 + 校验 + repair ≤2 轮 + 沙箱错误回喂」（04 §6.5 / §7.4）。
 *
 * 三条边界：
 * - repair 只回喂**结构问题**，不改 `files` 之外的用户需求（提示词固定一句「files 保持不变」）；
 * - 最多 2 轮（默认 1，创造模式显式 2；04 §6.5 / 06 U-40-174）；
 * - 回喂白名单复用 `@/plugins/errors` 的 `isFeedbackErrorCode`（02 §5.5），宿主错误一律不喂。
 */
import { AiError } from '@/ai/provider'
import { closeTruncatedJson, extractJson } from '@/ai/validate'
import type { CreatorProposal, PluginErrorCode, PluginManifest } from '@/plugins/types'
import { isFeedbackErrorCode, redact } from '@/plugins/errors'
import {
  CreatorValidationError,
  FORBIDDEN_CODE_PATTERNS,
  MANIFEST_PATH,
  validateCreatorProposal,
  type CreatorValidationResult,
} from './proposal'

/* ============================ 上限（04 §6.4 / §7.4） ============================ */

/** repair 轮次上限（创造模式显式 2；04 §6.5）。 */
export const MAX_REPAIR_ROUNDS = 2
/** 默认 repair 轮次（对齐 ai/validate 的默认 1）。 */
export const DEFAULT_REPAIR_ROUNDS = 1
/** 回喂文本上限（04 §7.4：≤2000 字符）。 */
export const FEEDBACK_MAX_CHARS = 2000
/** 回喂轮次上限（04 §6.4：单次提案 ≤5 次模型调用 = 1 + 2 repair + 2 回喂）。 */
export const MAX_FEEDBACK_ROUNDS = 2
/** 回喂只带前 8 条 issue（04 §7.4）。 */
export const FEEDBACK_ISSUE_MAX = 8
/** 插件侧 stack 只带前 8 行（04 §7.4）。 */
export const FEEDBACK_STACK_LINES = 8

/* ============================ 语法预检 ============================ */

export interface SyntaxIssue {
  path: string
  message: string
  /** 命中的冻结错误码（安装期沿用 02 §5.5）。 */
  code: PluginErrorCode
}

const SVG_FORBIDDEN = /<\s*(script|foreignObject|iframe|object|embed|image|use\s+xlink:href)\b/i
const SVG_EVENT_ATTR = /\son[a-z]+\s*=/i
const SVG_EXTERNAL = /(?:href|xlink:href)\s*=\s*["']\s*(?:https?:\/\/|\/\/)/i

/** 简单字符串/注释/模板字面量感知的括号平衡检查（不做完整 JS 解析，零依赖）。 */
export function checkBalanced(source: string): string | null {
  const stack: string[] = []
  let index = 0
  const length = source.length
  /** 上一个有效字符（判断 `/` 是否为正则字面量开头）。 */
  let previous = ''

  const fail = (message: string): string => message

  while (index < length) {
    const char = source[index]
    const next = source[index + 1]

    // 注释
    if (char === '/' && next === '/') {
      while (index < length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }

    // 字符串
    if (char === '"' || char === "'") {
      const quote = char
      index += 1
      let closed = false
      while (index < length) {
        const current = source[index]
        if (current === '\\') {
          index += 2
          continue
        }
        if (current === quote) {
          closed = true
          index += 1
          break
        }
        if (current === '\n') return fail('字符串没有闭合')
        index += 1
      }
      if (!closed) return fail('字符串没有闭合')
      previous = '"'
      continue
    }

    // 模板字面量（${ } 里允许任意表达式，按嵌套花括号处理）
    if (char === '`') {
      index += 1
      let closed = false
      while (index < length) {
        const current = source[index]
        if (current === '\\') {
          index += 2
          continue
        }
        if (current === '`') {
          closed = true
          index += 1
          break
        }
        index += 1
      }
      if (!closed) return fail('模板字符串没有闭合')
      previous = '`'
      continue
    }

    // 正则字面量启发式：`/` 出现在表达式起始位置时按正则吞掉，避免把里面的括号当代码。
    if (char === '/' && /[(,=:[!&|?{};+\-*%<>~^]/.test(previous || '(')) {
      index += 1
      let inClass = false
      let closed = false
      while (index < length) {
        const current = source[index]
        if (current === '\\') {
          index += 2
          continue
        }
        if (current === '[') inClass = true
        else if (current === ']') inClass = false
        else if (current === '/' && !inClass) {
          closed = true
          index += 1
          break
        } else if (current === '\n') break
        index += 1
      }
      if (!closed) return fail('正则字面量没有闭合')
      previous = '/'
      continue
    }

    if (char === '(' || char === '[' || char === '{') {
      stack.push(char)
      previous = char
      index += 1
      continue
    }
    if (char === ')' || char === ']' || char === '}') {
      const open = stack.pop()
      const expected = char === ')' ? '(' : char === ']' ? '[' : '{'
      if (open !== expected) return fail(`括号不匹配：多余的 ${char}`)
      previous = char
      index += 1
      continue
    }
    if (!/\s/.test(char)) previous = char
    index += 1
  }
  if (stack.length > 0) return fail(`括号没有闭合：缺少 ${stack.map((open) => (open === '(' ? ')' : open === '[' ? ']' : '}')).join('')}`)
  return null
}

/** 单文件语法/禁用 API 预检（04 §6.5；不编译、不用 eval）。 */
export function preflightFile(path: string, content: string): SyntaxIssue[] {
  const issues: SyntaxIssue[] = []
  const bytes = new TextEncoder().encode(content).length
  if (bytes === 0) issues.push({ path, message: '文件为空', code: 'E-PKG-03' })

  if (path.endsWith('.json')) {
    try {
      JSON.parse(content)
    } catch (error) {
      issues.push({
        path,
        message: `JSON 不合法：${error instanceof Error ? error.message : String(error)}`,
        code: 'E-PKG-01',
      })
    }
    return issues
  }

  if (path.endsWith('.svg')) {
    const trimmed = content.trim()
    if (!/^<svg[\s>]/i.test(trimmed)) {
      issues.push({ path, message: 'SVG 必须以 <svg> 开头', code: 'E-PKG-06' })
    }
    if (SVG_FORBIDDEN.test(content)) issues.push({ path, message: 'SVG 含禁用元素', code: 'E-MAN-12' })
    if (SVG_EVENT_ATTR.test(content)) issues.push({ path, message: 'SVG 含事件属性', code: 'E-MAN-12' })
    if (SVG_EXTERNAL.test(content)) issues.push({ path, message: 'SVG 含外链资源', code: 'E-MAN-12' })
    return issues
  }

  if (path.endsWith('.js') || path.endsWith('.mjs')) {
    for (const forbidden of FORBIDDEN_CODE_PATTERNS) {
      if (forbidden.pattern.test(content)) {
        issues.push({ path, message: `命中禁用 API：${forbidden.name}`, code: 'E-MAN-12' })
      }
    }
    const balance = checkBalanced(content)
    if (balance) issues.push({ path, message: balance, code: 'E-RUN-02' })
  }
  return issues
}

/** 整份提案的语法预检（`.lumen-plugin.json` + 每个文件）。 */
export function syntaxPreflight(files: { path: string; content: string }[]): SyntaxIssue[] {
  const issues: SyntaxIssue[] = []
  if (!files.some((file) => file.path === MANIFEST_PATH)) {
    issues.push({ path: MANIFEST_PATH, message: '缺少清单文件', code: 'E-PKG-03' })
  }
  for (const file of files) issues.push(...preflightFile(file.path, file.content))
  return issues
}

/* ============================ 解析 + repair 环 ============================ */

export type CreatorParseResult =
  | {
      ok: true
      proposal: CreatorProposal
      manifest: PluginManifest
      /** 实际用掉的 repair 轮次（0 = 一次通过；Mock 必须 0）。 */
      repairs: number
    }
  | {
      ok: false
      /** 失败时的校验错误（含 issues）。 */
      error: CreatorValidationError
      repairs: number
    }

export interface CreatorParseOptions {
  /** repair 回调：拿到 issue 列表，返回模型重写后的文本；返回 null 终止。 */
  repair?: (issues: string[]) => Promise<string | null>
  signal?: AbortSignal
  /** 最多 repair 轮次，默认 1；创造模式显式传 2。 */
  maxRepair?: number
  /** 解析前追加语法预检（默认 true：坏 JSON/坏代码提前暴露）。 */
  preflight?: boolean
}

/** 从模型文本里抽出提案对象（不做 repair，不发请求）。 */
export function readProposalJson(text: string): unknown | null {
  const json = extractJson(text) ?? closeTruncatedJson(text)
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    const closed = closeTruncatedJson(json)
    if (!closed) return null
    try {
      return JSON.parse(closed)
    } catch {
      return null
    }
  }
}

function issuesOf(error: CreatorValidationError): string[] {
  return error.issues.slice(0, FEEDBACK_ISSUE_MAX)
}

/**
 * `parseWithRepair` 的创造模式特化：zod + 双向一致性 + 语法预检一起进 repair 环。
 * 最多调用 `maxRepair + 1` 次 repair 回调；仍失败返回 `ok:false`（调用方给「换模板」）。
 */
export async function parseCreatorProposal(
  text: string,
  options: CreatorParseOptions = {},
): Promise<CreatorParseResult> {
  const maxRepair = Math.max(0, Math.min(MAX_REPAIR_ROUNDS, options.maxRepair ?? DEFAULT_REPAIR_ROUNDS))
  let current = text
  let repairs = 0
  /** 当前轮的 issue 列表：repair 回调的输入（局部而非模块级，避免并发串台）。 */
  let issues: string[] = []

  for (let attempt = 0; attempt <= maxRepair; attempt += 1) {
    if (options.signal?.aborted) throw new AiError('timeout', 'aborted', true)

    if (attempt > 0) {
      if (!options.repair) break
      const repaired = await options.repair(issues)
      repairs += 1
      if (repaired === null || repaired.trim() === '') break
      current = repaired
    }

    const raw = readProposalJson(current)
    if (raw === null) {
      issues = ['输出里没有合法 JSON 对象']
      continue
    }

    // 先做语法预检：坏代码不进入 zod（错误信息更可操作）。
    const rawFiles = (raw as { files?: { path?: unknown; content?: unknown }[] }).files
    if (options.preflight !== false && Array.isArray(rawFiles)) {
      const files = rawFiles
        .filter(
          (file): file is { path: string; content: string } =>
            !!file && typeof file.path === 'string' && typeof file.content === 'string',
        )
        .map((file) => ({ path: file.path, content: file.content }))
      if (files.length > 0) {
        const syntax = syntaxPreflight(files)
        if (syntax.length > 0) {
          issues = syntax.slice(0, FEEDBACK_ISSUE_MAX).map((issue) => `${issue.path}: ${issue.message}`)
          continue
        }
      }
    }

    const result: CreatorValidationResult = validateCreatorProposal(raw)
    if (result.ok) {
      return { ok: true, proposal: result.proposal, manifest: result.manifest, repairs }
    }
    issues = issuesOf(result.error)
    if (attempt === maxRepair) {
      return { ok: false, repairs, error: result.error }
    }
  }

  return {
    ok: false,
    repairs,
    error: new CreatorValidationError('E-MAN-13', issues.length > 0 ? issues : ['提案无法解析']),
  }
}

/* ============================ repair / 回喂提示词 ============================ */

/** repair 回喂的 user 消息（04 §6.5：files 保持不变，只改不合法字段）。 */
export function repairProposalPrompt(user: string, issues: string[]): string {
  const list = issues.slice(0, FEEDBACK_ISSUE_MAX)
  return `${user}

上一次输出没有通过创造模式校验，问题如下：
${list.map((issue) => `- ${issue}`).join('\n')}

要求：files 保持不变，只改不合法字段；只输出修正后的 CreatorProposal JSON 对象，不要解释、不要 Markdown 围栏、不要新增字段。`
}

export interface PluginErrorFeedbackInput {
  code: PluginErrorCode
  message?: string
  /** `plugin.js:<行>`（04 §7.4 的 where）。 */
  where?: string
  stack?: string[]
  note?: string
}

/** 错误码是否允许回喂（02 §5.5 白名单，复用 plugins/errors）。 */
export function isFeedbackCode(code: PluginErrorCode): boolean {
  return isFeedbackErrorCode(code)
}

/**
 * 沙箱错误回喂文本（04 §7.4）：
 * `[PLUGIN_ERROR] code / message(≤300) / where / stack: 前 8 行 / note`，`redact()` 后 ≤2000 字符。
 */
export function buildFeedbackText(input: PluginErrorFeedbackInput): string {
  if (!isFeedbackCode(input.code)) return ''
  const message = redact(String(input.message ?? '').slice(0, 300))
  const where = input.where ? `\nwhere: ${redact(input.where.slice(0, 160))}` : ''
  const stackLines = (input.stack ?? []).slice(0, FEEDBACK_STACK_LINES).map((line) => redact(line.slice(0, 300)))
  const stack = stackLines.length > 0 ? `\nstack:\n${stackLines.join('\n')}` : ''
  const note = `\nnote: ${input.note ?? '只输出修正后的 CreatorProposal JSON，不要解释。'}`
  const text = `[PLUGIN_ERROR] ${input.code} / ${message}${where}${stack}${note}`
  return text.slice(0, FEEDBACK_MAX_CHARS)
}

/** 回喂是否还有轮次（04 §7.4：最多 2 次，再失败给「换模板」）。 */
export function canFeedbackRound(used: number): boolean {
  return used < MAX_FEEDBACK_ROUNDS
}
