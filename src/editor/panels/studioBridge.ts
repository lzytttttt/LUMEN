/**
 * studioBridge.ts —— 面板到「SVG / 3D 工作室」与「AI 编排」的单向事件桥。
 *
 * 约定（跨模块）：
 * - 工作室挂载后写 `document.documentElement.dataset.lumenStudio = '1'`；
 * - AI 编排挂载后写 `document.documentElement.dataset.lumenAi = '1'`。
 * 面板据此判断对方是否在线：在线就静默转发，不在线就返回 false 由调用方 toast 提示。
 * 事件本身与 detail 结构已固定，监听方无需知道面板实现。
 */
export type StudioKind = 'svg' | 'three'

export interface StudioOpenDetail {
  kind: StudioKind
  blockId: string
}

export const STUDIO_FLAG = 'lumenStudio'
export const AI_FLAG = 'lumenAi'

function flagOn(name: string): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.dataset[name] === '1'
}

/** 派发「打开工作室」；返回值表示工作区是否已注册监听。 */
export function openStudio(detail: StudioOpenDetail): boolean {
  if (typeof window === 'undefined') return false
  window.dispatchEvent(new CustomEvent('lumen:open-studio', { detail }))
  return flagOn(STUDIO_FLAG)
}

/** 派发「一句话意图」（命令面板的「用 AI 改写」与 AI 生成入口共用）。 */
export async function sendIntent(
  text: string,
  scope: 'slide' | 'deck' | 'selection' = 'slide',
): Promise<boolean> {
  if (typeof window === 'undefined') return false
  const trimmed = text.trim()
  if (trimmed === '') return false
  window.dispatchEvent(new CustomEvent('lumen:intent', { detail: { text: trimmed, scope } }))
  if (flagOn(AI_FLAG)) return true
  // 兜底探测：AI 模块在线时会导出 isIntentListenerInstalled（动态 import，缺失也不影响构建）。
  try {
    const mod = (await import('@/ai/intent')) as { isIntentListenerInstalled?: () => boolean }
    return typeof mod.isIntentListenerInstalled === 'function' ? mod.isIntentListenerInstalled() : false
  } catch {
    return false
  }
}
