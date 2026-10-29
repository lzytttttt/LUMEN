/**
 * forge/materials.ts —— 材料篮的预算与纯函数（02 §3.1）。
 *
 * 为什么单独成文件：材料只有「文本」一种形态进模型（00 §6 不做二进制解析），
 * 于是截断、估算、坏数据丢弃全都能写成纯函数；起念屏（UI）与 prompt 拼装共用同一把尺子，
 * 避免两处上限各自漂移。kv 读回的数据一律走 normalizeMaterials：脏数据只丢不抛。
 */
import type { ForgeMaterial, MaterialKind, MaterialStatus } from './types'

/** 材料条数上限（契约 §2 硬约束 5）：第 6 条 `material:add` 由 reducer 拦掉。 */
export const MATERIAL_MAX = 5
/** 单条正文硬上限；超出即截断，不报错（用户不该被自己的粘贴卡住）。 */
export const MATERIAL_TEXT_MAX = 4000
/** 本地文件选择器的接受类型：v0.2.5 只吃纯文本，二进制解析放 v0.3。 */
export const MATERIAL_FILE_ACCEPT = '.txt,.md,.markdown,.json,.csv'

/** label 是展示字段（D 类预算 14 汉字 ≈ 24 字符），超出部分不进 state。 */
const LABEL_MAX = 24
/** 拼进 prompt 的材料段每条最多吃这么多字（契约 §3.4 的 200 字预算）。 */
const BRIEF_TEXT_MAX = 200

const KINDS: MaterialKind[] = ['paste', 'url', 'file']
const STATUSES: MaterialStatus[] = ['ready', 'parsing', 'failed']

/** 粗估 token：中文约 2.2 字符一个 token，只用于 UI 体量提示。 */
export function estimateTokens(text: string): number {
  if (text === '') return 0
  return Math.ceil(text.length / 2.2)
}

function random4(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0')
}

export function newMaterialId(): string {
  return `mat-${Date.now()}-${random4()}`
}

function defaultLabel(kind: MaterialKind, lang: 'zh' | 'en' = 'zh'): string {
  if (lang === 'en') return kind === 'paste' ? 'Paste' : kind === 'url' ? 'Link' : 'File'
  return kind === 'paste' ? '粘贴' : kind === 'url' ? '网址' : '文件'
}

/** label 兜底：用户没给就取正文首句，正文也空才退回类型名。 */
function labelOf(label: string, text: string, kind: MaterialKind): string {
  const trimmed = label.trim()
  if (trimmed !== '') return trimmed.slice(0, LABEL_MAX)
  const fromText = text.replace(/\s+/g, ' ').trim()
  if (fromText !== '') return fromText.slice(0, LABEL_MAX)
  return defaultLabel(kind)
}

/** 从任意输入造一条 ready 材料：截断、算 tokens、label 兜底。 */
export function makeMaterial(input: { kind: MaterialKind; label: string; text: string }): ForgeMaterial {
  const kind: MaterialKind = KINDS.includes(input.kind) ? input.kind : 'paste'
  const text = input.text.slice(0, MATERIAL_TEXT_MAX)
  return {
    id: newMaterialId(),
    kind,
    label: labelOf(input.label, text, kind),
    text,
    tokens: estimateTokens(text),
    at: Date.now(),
    status: 'ready',
  }
}

/** 单条宽松校验：形状不对就返回 null（调用方只负责丢）。 */
function normalizeOne(raw: unknown): ForgeMaterial | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  // 正文允许为空：文件读取失败的条也会留在篮子里（status='failed'），丢掉会让用户以为操作没发生。
  const text = typeof input.text === 'string' ? input.text.slice(0, MATERIAL_TEXT_MAX) : ''
  if (id === '') return null
  if (!KINDS.includes(input.kind as MaterialKind)) return null
  const kind = input.kind as MaterialKind
  const status = STATUSES.includes(input.status as MaterialStatus) ? (input.status as MaterialStatus) : 'ready'
  const label = typeof input.label === 'string' ? input.label.trim().slice(0, LABEL_MAX) : ''
  const at = typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now()
  const tokens =
    typeof input.tokens === 'number' && Number.isFinite(input.tokens) && input.tokens >= 0
      ? Math.trunc(input.tokens)
      : estimateTokens(text)
  return { id, kind, label: label === '' ? labelOf('', text, kind) : label, text, tokens, at, status }
}

/** kv 读回时的宽松校验：坏数据返回 []，绝不抛。 */
export function normalizeMaterials(raw: unknown): ForgeMaterial[] {
  if (!Array.isArray(raw)) return []
  const out: ForgeMaterial[] = []
  for (const item of raw) {
    if (out.length >= MATERIAL_MAX) break
    try {
      const material = normalizeOne(item)
      if (material) out.push(material)
    } catch {
      // 代理对象 / getter 抛错：按坏数据处理，静默丢弃（界面不能因为一条脏数据白屏）。
    }
  }
  return out
}

/** 拼进 prompt 的材料段（zh/en 同构，纯文本，≤ MATERIAL_MAX * 200 字）。 */
export function materialsBrief(materials: ForgeMaterial[], lang: 'zh' | 'en'): string {
  const list = materials.slice(0, MATERIAL_MAX)
  if (list.length === 0) return ''
  const lines = list.map((material, index) => {
    const label = material.label.trim() === '' ? defaultLabel(material.kind, lang) : material.label.trim()
    return `${index + 1}. [${label}] ${material.text.slice(0, BRIEF_TEXT_MAX)}`
  })
  const head = lang === 'en' ? 'Sources (verbatim excerpts):' : '材料（原文节选）：'
  return `${head}\n${lines.join('\n')}`
}

/** 给 UI 的一句话摘要（aria-label 用，不占文字预算；语言无关，避免多一份文案表）。 */
export function materialsSummary(materials: ForgeMaterial[]): string {
  const list = materials.slice(0, MATERIAL_MAX)
  const chars = list.reduce((sum, material) => sum + material.text.length, 0)
  return `materials ${list.length}/${MATERIAL_MAX} · ${chars} chars`
}
