import { useSettingsStore } from '@/state/settingsStore'

/** 当前界面语言（响应式）。 */
export function useLang() {
  return useSettingsStore((s) => s.lang)
}
