/**
 * PluginEventBridge.tsx —— 插件 UI 的轻量事件桥（常挂，不进主 chunk 的重量级代码）。
 *
 * 只有三件事（都来自 plugin-core 的公开约定）：
 * 1. `lumen:open-plugin-manager` → 打开管理弹窗（`openPluginManager()` 派发）；
 * 2. `lumen:plugin-preview` → 全局 drop / 插件页的安装预览，接住后打开权限卡；
 * 3. 预览失败 → toast 用户可读文案。
 *
 * 管理弹窗本体（`PluginManagerDialog`，02 §10.3 目标 ≤14KB gzip）由 `Dialogs.tsx`
 * 在真正需要时才 `lazy()` 加载；本文件只依赖 zustand store 与 `pluginErrorKey`。
 */
import { useEffect } from 'react'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { useUiStore } from '@/state/uiStore'
import { pluginErrorKey, type PluginPackagePreview } from '@/plugins/public'
import { usePluginUiStore } from './pluginUiStore'

interface PluginPreviewDetail {
  preview?: PluginPackagePreview
  error?: { code?: string }
}

export function PluginEventBridge() {
  const t = useT()
  const pushToast = useUiStore((s) => s.pushToast)

  useEffect(() => {
    const onOpen = () => usePluginUiStore.getState().openManager()
    const onPreview = (event: Event) => {
      const detail = (event as CustomEvent<PluginPreviewDetail>).detail
      if (detail?.preview) {
        usePluginUiStore.getState().setPreview(detail.preview)
        usePluginUiStore.getState().openManager()
        return
      }
      if (detail?.error) {
        const code = detail.error.code ?? 'E-HOST-01'
        pushToast({ kind: 'error', message: t(pluginErrorKey(code as never) as MessageKey) })
      }
    }
    window.addEventListener('lumen:open-plugin-manager', onOpen)
    window.addEventListener('lumen:plugin-preview', onPreview)
    return () => {
      window.removeEventListener('lumen:open-plugin-manager', onOpen)
      window.removeEventListener('lumen:plugin-preview', onPreview)
    }
  }, [pushToast, t])

  return null
}
