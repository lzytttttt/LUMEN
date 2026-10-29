/**
 * forge/steer.ts —— 生成中纠偏的纯函数（02 §3.2）。
 *
 * 为什么是纯函数：纠偏不新建事件总线，而是把一条 ≤60 字的要求写进「尚未落位」幕的 brief，
 * 让池化管线在下一幕边界自然读到它（02 §1 动作 4）。生效判定只依赖幕序号，
 * 因此 `makeSteerNote` / `pendingSteer` / `steerLabel` 都能脱离 React 与 reducer 单测。
 */
import type { SteerNote } from './types'

/** 一条纠偏的硬上限（契约 §2）：再长就不是「一句话」了。 */
export const STEER_TEXT_MAX = 60

function random4(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0')
}

/** 空串或非法幕序号返回 null —— 调用方据此不派发动作，避免空 note 占住队列。 */
export function makeSteerNote(text: string, fromIndex: number): SteerNote | null {
  const body = text.trim().slice(0, STEER_TEXT_MAX)
  if (body === '') return null
  const from = Math.trunc(fromIndex)
  if (!Number.isFinite(from) || from < 0) return null
  return { id: `st-${Date.now()}-${random4()}`, text: body, fromIndex: from, at: Date.now() }
}

/** 还没到生效边界的条目（fromIndex > doneIndex）：SteerBar 用它算「已排队 n」。 */
export function pendingSteer(notes: SteerNote[], doneIndex: number): SteerNote[] {
  return notes.filter((note) => Math.trunc(note.fromIndex) > doneIndex)
}

/** 最早一条仍会生效的幕序号；全部过期 / 越界则 null。 */
function nextSteerIndex(notes: SteerNote[], slideCount: number): number | null {
  let best: number | null = null
  for (const note of notes) {
    const from = Math.trunc(note.fromIndex)
    if (!Number.isFinite(from) || from < 0 || from >= slideCount) continue
    if (best === null || from < best) best = from
  }
  return best
}

/**
 * 「第 n 幕起生效」这半句（不含「已排队 n」，那部分走 i18n 的 F 类 key）。
 * 没有仍会生效的条目时返回 ''，调用方整段不渲染。
 */
export function steerLabel(notes: SteerNote[], slideCount: number, lang: 'zh' | 'en'): string {
  const from = nextSteerIndex(notes, slideCount)
  if (from === null) return ''
  return lang === 'en' ? `From slide ${from + 1}` : `第 ${from + 1} 幕起生效`
}
