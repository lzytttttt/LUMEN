/**
 * src/portal/mount.tsx —— 门户页的挂载器（`portal.html` 与 `?portal=1` 共用）。
 * 只依赖设置与 i18n，不加载编辑器 / 渲染器 / three。
 */
import { createRoot } from 'react-dom/client'
import { PortalApp } from './PortalApp'
import { loadSettings } from '@/persistence/decks'
import { startSettingsSync } from '@/persistence/settingsSync'
import { useSettingsStore } from '@/state/settingsStore'
import '@/styles/tokens.css'
import '@/styles/base.css'
import './portal.css'

export async function mountPortal(container: HTMLElement): Promise<void> {
  const settings = useSettingsStore.getState()
  try {
    settings.hydrate(await loadSettings())
  } catch {
    settings.hydrate(null)
  }
  startSettingsSync()
  document.documentElement.dataset.portal = '1'
  createRoot(container).render(<PortalApp />)
}
