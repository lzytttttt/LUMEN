/**
 * src/pages/plugins/mount.tsx —— 插件页挂载器（`plugins.html` 唯一入口）。
 *
 * 只依赖设置（拿语言 + 持久化）与 i18n，不加载工作台；`?still=1` 关动画（06 §3.4）。
 */
import { createRoot } from 'react-dom/client'
import { PluginsPage } from './PluginsPage'
import { loadSettings } from '@/persistence/decks'
import { startSettingsSync } from '@/persistence/settingsSync'
import { useSettingsStore } from '@/state/settingsStore'
import '@/styles/tokens.css'
import '@/styles/base.css'
import './plugins-page.css'

function stillRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('still') === '1'
  } catch {
    return false
  }
}

export async function mountPluginsPage(container: HTMLElement): Promise<void> {
  const settings = useSettingsStore.getState()
  try {
    settings.hydrate(await loadSettings())
  } catch {
    settings.hydrate(null)
  }
  startSettingsSync()

  const root = document.documentElement
  root.dataset.lumenPluginsPage = '1'
  root.dataset.still = stillRequested() ? '1' : '0'
  root.dataset.page = 'plugins'

  createRoot(container).render(<PluginsPage />)
}
