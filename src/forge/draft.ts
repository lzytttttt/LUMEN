/**
 * forge/draft.ts —— `forgeDraft`（02 §7.2）：只存大纲与进度，不存半成品块。
 * 体积上限 64KB；解析失败一律返回 null（界面静默自愈）。
 */
import { outlineSchema, type Outline } from '@/schema/deck'

export interface ForgeDraftShape {
  v: 1
  prompt: string
  lang: 'zh' | 'en'
  title: string
  outline: Outline
  done: number
  at: number
}

export class ForgeDraft {
  static parse(raw: unknown): ForgeDraftShape | null {
    if (!raw || typeof raw !== 'object') return null
    const input = raw as Record<string, unknown>
    if (input.v !== 1) return null
    const parsed = outlineSchema.safeParse(input.outline)
    if (!parsed.success) return null
    const outline = parsed.data
    if (JSON.stringify(raw).length > 64 * 1024) return null
    return {
      v: 1,
      prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 2000) : '',
      lang: input.lang === 'en' ? 'en' : 'zh',
      title: typeof input.title === 'string' ? input.title.slice(0, 120) : outline.title,
      outline,
      done: typeof input.done === 'number' && Number.isFinite(input.done) ? Math.max(0, Math.trunc(input.done)) : 0,
      at: typeof input.at === 'number' ? input.at : Date.now(),
    }
  }
}
