/**
 * intent.ts —— 意图路由：命令面板发来的自然语言指令 → 具体编辑动作。
 *
 * 入口：`window` 事件 `lumen:intent`，detail = { text, scope }（见 editor/panels/studioBridge.ts）。
 * 规则优先、离线可用；未命中的指令在 Mock 通道下只提示 `ai.intent.unknown`，
 * 配置了真端点时才会走 LLM 重写（由 refineSlide 内部决定）。
 */
import type { MessageKey } from '@/i18n'
import { t } from '@/i18n'
import { THEME_IDS } from '@/themes'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { deckOps } from '@/state/ops'
import { activeSlideIdOf } from '@/state/selectors'
import { aiErrorMessage, isAborted } from './provider'
import { applyRefinePlan, refineSlide } from './refine'

export type IntentScope = 'slide' | 'deck' | 'selection'

export interface IntentDetail {
  text: string
  scope?: IntentScope
}

const THEME_RE = /换.*主题|换个主题|主题|深色|浅色|暗色|亮色|theme|dark|light/i

let installed = false

function nextThemeId(current: string, text: string): string {
  const light = /浅色|亮色|light|paper/i.test(text)
  const dark = /深色|暗色|dark|noir/i.test(text)
  const pool: string[] = light
    ? ['paper', 'signal', 'museum']
    : dark
      ? ['noir', 'aurora', 'terminal']
      : [...THEME_IDS]
  const index = pool.indexOf(current)
  return pool[(index + 1) % pool.length] ?? pool[0]
}

/** 执行一条意图（导出以便单测直接调用）。 */
export async function handleIntent(text: string, scope: IntentScope = 'slide'): Promise<void> {
  const ui = useUiStore.getState()
  const toast = (key: MessageKey, kind: 'info' | 'success' | 'error' = 'success') =>
    ui.pushToast({ kind, message: t(key) })

  const deck = useDeckStore.getState().deck
  if (!deck) return
  const slideId = activeSlideIdOf(deck, ui.activeSlideId)

  try {
    if (THEME_RE.test(text)) {
      deckOps.setTheme(nextThemeId(deck.themeId, text))
      toast('ai.intent.theme')
      return
    }

    if (!slideId) {
      toast('ai.intent.unknown', 'info')
      return
    }

    const { patch } = await refineSlide(text, { deck, slideId, signal: undefined })
    const touched = patch.diff.added.length + patch.diff.removed.length + patch.diff.changed.length
    if (touched === 0) {
      toast('ai.intent.unknown', 'info')
      return
    }
    applyRefinePlan(patch)
    toast(patch.summaryKey as MessageKey)
  } catch (error) {
    if (isAborted(error)) return
    ui.pushToast({ kind: 'error', message: t('ai.panel.failed', { reason: aiErrorMessage(error) }) })
  }
}

/**
 * 监听 `lumen:intent`。幂等：重复调用不会叠加监听器，返回的清理函数也只卸载自己装的那一个。
 */
export function installIntentListener(): () => void {
  if (typeof window === 'undefined') return () => {}
  if (installed) return () => {}
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<IntentDetail | string>).detail
    const text = typeof detail === 'string' ? detail : detail?.text
    if (typeof text !== 'string' || text.trim() === '') return
    const scope: IntentScope = typeof detail === 'object' && detail?.scope ? detail.scope : 'slide'
    void handleIntent(text.trim(), scope)
  }
  window.addEventListener('lumen:intent', handler as EventListener)
  installed = true
  return () => {
    window.removeEventListener('lumen:intent', handler as EventListener)
    installed = false
  }
}

/** 测试用：查询监听器是否已安装。 */
export function isIntentListenerInstalled(): boolean {
  return installed
}
