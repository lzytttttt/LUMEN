/**
 * forge/draft.ts —— `forgeDraft`（02 §7.2）：只存大纲与进度，不存半成品块。
 * 体积上限 64KB；解析失败一律返回 null（界面静默自愈）。
 *
 * v0.2.5 增量：草稿要能「原样回到起念屏」，所以带上 themeId / audience / materials。
 * 旧草稿（只有 v/prompt/lang/title/outline/done/at）必须还能 parse —— 全部字段缺省补空值，
 * 不能因为多了三个键就让用户丢了一次大纲。
 */
import { outlineSchema, type Outline } from '@/schema/deck'
import { normalizeMaterials } from './materials'
import type { ForgeMaterial } from './types'

export interface ForgeDraftShape {
  v: 1
  prompt: string
  lang: 'zh' | 'en'
  title: string
  outline: Outline
  done: number
  at: number
  /** v0.2.5：继续编辑时沿用上次的预设（'' = 跟随 deck）。 */
  themeId: string
  /** v0.2.5：上次选的受众（'' = 没选）。 */
  audience: string
  /** v0.2.5：材料篮（逐条过 normalizeMaterials，坏数据静默丢弃）。 */
  materials: ForgeMaterial[]
}

const MAX_BYTES = 64 * 1024

export class ForgeDraft {
  static parse(raw: unknown): ForgeDraftShape | null {
    if (!raw || typeof raw !== 'object') return null
    const input = raw as Record<string, unknown>
    if (input.v !== 1) return null
    const parsed = outlineSchema.safeParse(input.outline)
    if (!parsed.success) return null
    const outline = parsed.data
    try {
      if (JSON.stringify(raw).length > MAX_BYTES) return null
    } catch {
      // 循环引用 / getter 抛错：当成坏草稿。
      return null
    }
    return {
      v: 1,
      prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 2000) : '',
      lang: input.lang === 'en' ? 'en' : 'zh',
      title: typeof input.title === 'string' ? input.title.slice(0, 120) : outline.title,
      outline,
      done: typeof input.done === 'number' && Number.isFinite(input.done) ? Math.max(0, Math.trunc(input.done)) : 0,
      at: typeof input.at === 'number' ? input.at : Date.now(),
      themeId: typeof input.themeId === 'string' ? input.themeId.slice(0, 60) : '',
      audience: typeof input.audience === 'string' ? input.audience.slice(0, 20) : '',
      materials: normalizeMaterials(input.materials),
    }
  }
}
