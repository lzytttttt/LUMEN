import { useSettingsStore, settingsSnapshot } from '@/state/settingsStore'
import { saveSettings } from './decks'

let installed = false

/**
 * 设置 → 持久化 + 应用到 <html>（主题、语言）。
 * 订阅式实现：任何 setLang/setUiTheme 都会立即落到 DOM 与 IndexedDB。
 */
export function startSettingsSync(): () => void {
  if (installed) return () => undefined
  installed = true

  const apply = () => {
    const state = useSettingsStore.getState()
    const resolved =
      state.uiTheme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : state.uiTheme
    document.documentElement.dataset.uiTheme = resolved
    document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en'
    document.documentElement.dataset.reducedMotion = state.reducedMotion ? 'true' : 'false'
  }

  apply()

  let timer: number | undefined
  const unsubscribe = useSettingsStore.subscribe((state) => {
    apply()
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      void saveSettings(settingsSnapshot(state))
    }, 400)
  })

  const media = window.matchMedia('(prefers-color-scheme: light)')
  const onMedia = () => {
    if (useSettingsStore.getState().uiTheme === 'system') apply()
  }
  media.addEventListener('change', onMedia)

  return () => {
    unsubscribe()
    media.removeEventListener('change', onMedia)
    window.clearTimeout(timer)
    installed = false
  }
}
