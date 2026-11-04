/**
 * plugins/api/theme.ts —— `lumen.theme`（02 §5.2：只读、无能力要求）。
 *
 * `cssVars()` 返回**已应用用户 themeOverrides** 的最终值（与渲染/导出同一入口 `themeCssVars`）。
 */
import { useDeckStore } from '@/state/deckStore'
import { getTheme, themeCssVars } from '@/themes'
import type { ApiCall } from './context'
import { abiError, registerNamespaceApi } from './gateway'

function currentDeckTheme(): { themeId: string; overrides: Record<string, string> | undefined } {
  const deck = useDeckStore.getState().deck
  if (!deck) return { themeId: 'noir', overrides: undefined }
  return {
    themeId: deck.themeId,
    overrides: deck.themeOverrides as unknown as Record<string, string> | undefined,
  }
}

export function themeSnapshot(): { id: string; name: { zh: string; en: string }; colors: Record<string, string> } {
  const { themeId, overrides } = currentDeckTheme()
  const theme = getTheme(themeId)
  return {
    id: theme.id,
    name: theme.name,
    colors: { ...(theme.colors as unknown as Record<string, string>), ...(overrides ?? {}) },
  }
}

export function currentCssVars(): Record<string, string> {
  const { themeId, overrides } = currentDeckTheme()
  return themeCssVars(
    getTheme(themeId),
    overrides as unknown as Parameters<typeof themeCssVars>[1] | undefined,
  )
}

export function handleTheme(method: string, payload: unknown): unknown {
  void payload
  switch (method) {
    case 'get':
      return themeSnapshot()
    case 'cssVars':
      return currentCssVars()
    case 'subscribe':
      // 帧内本地订阅；宿主在 theme:change 时推事件（events.ts）。
      return null
    default:
      throw abiError(`unknown theme method "${method}"`)
  }
}

export function registerThemeApi(): void {
  registerNamespaceApi('theme', {
    get: (payload, call) => handleTheme('get', payload),
    cssVars: (payload, call) => handleTheme('cssVars', payload),
    subscribe: (payload) => handleTheme('subscribe', payload),
  })
  void (null as unknown as ApiCall)
}
