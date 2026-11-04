/**
 * plugins/declarative/themeBridge.ts —— 把插件主题解析器接到 `src/themes/index.ts` 的 seam。
 *
 * Lead 的契约层提供 `installExternalThemeResolver(resolver)`（内置 6 套优先，其次 external，
 * 最后 noir）。`applyDeclarativeContributions` 时注册、没有插件主题时清空。
 */
import { installExternalThemeResolver } from '@/themes'
import type { Theme } from '@/schema/deck'
import { resolvePluginTheme } from './theme'

let installed = false

/** 注册插件主题解析器（幂等）。 */
export function installThemeResolverBridge(): void {
  if (installed) return
  installed = true
  installExternalThemeResolver((id: string): Theme | undefined => resolvePluginTheme(id))
}

/** 撤销解析器（没有插件主题时调用，让 `getTheme` 回到纯内置）。 */
export function uninstallThemeResolverBridge(): void {
  if (!installed) return
  installed = false
  installExternalThemeResolver(null)
}

/** seam 是否可用（诊断用；静态 import 后恒为 true）。 */
export function themeResolverSeamAvailable(): boolean {
  return typeof installExternalThemeResolver === 'function'
}

/** 仅测试用。 */
export function resetThemeResolverBridgeForTests(): void {
  installed = false
  installExternalThemeResolver(null)
}
