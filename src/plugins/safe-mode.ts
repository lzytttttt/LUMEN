/**
 * plugins/safe-mode.ts —— 安全模式三入口判定与插件设置段读取（02 §3.3 / 03 §5.3）。
 *
 * 三入口取 OR：URL `?safe=1` / `#safe`（本次会话）＞ 启动 800ms 内按住 Shift（本次启动）＞ 设置项。
 * 生效时：不读 `plugins` store、不注册贡献、不建帧、`html[data-lumen-safe="1"]`、审计 `plugin.safe-mode-on`。
 */
import { DEFAULT_PLUGINS, useSettingsStore } from '@/state/settingsStore'
import type { PluginSettings } from '@/state/settingsStore'
import type { PluginLayoutOverride } from '@/state/settingsStore'

export type SafeModeSource = 'url' | 'shift' | 'setting'

export interface SafeModeState {
  active: boolean
  source: SafeModeSource | null
}

/** 默认插件设置段 = Lead 的 `DEFAULT_PLUGINS`（02 §7.4 单一来源）。 */
export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = DEFAULT_PLUGINS

const SHIFT_WINDOW_MS = 800
const SHIFT_LISTENER_LIMIT_MS = 2000

let shiftPressedEarly = false
let shiftDetectorInstalled = false

/**
 * 安装 Shift 早按探测器：页面脚本开始后 800ms 内出现 `keydown Shift` 即标记。
 * boot.ts 在模块求值时调用一次（幂等）；2s 后自行退场，不留监听（02 §3.3 / 03 §5.3）。
 */
export function installShiftDetector(): void {
  if (shiftDetectorInstalled) return
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  shiftDetectorInstalled = true
  const startedAt = Date.now()
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Shift') shiftPressedEarly = true
  }
  window.addEventListener('keydown', onKeyDown, { capture: true, passive: true })
  const timer = window.setTimeout(() => {
    window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, SHIFT_WINDOW_MS)
  const hardStop = window.setTimeout(() => window.clearTimeout(timer), SHIFT_LISTENER_LIMIT_MS)
  void hardStop
}

/** 读取 URL 安全模式参数（`?safe=1` / `#safe`；06 §3.4）。 */
export function safeModeFromUrl(href?: string): boolean {
  let search = ''
  let hash = ''
  if (href) {
    const index = href.indexOf('#')
    if (index >= 0) {
      search = href.slice(0, index)
      hash = href.slice(index + 1)
    } else search = href
    const query = search.indexOf('?')
    search = query >= 0 ? search.slice(query + 1) : ''
  } else if (typeof location !== 'undefined') {
    search = location.search.replace(/^\?/, '')
    hash = location.hash.replace(/^#/, '')
  }
  const params = new URLSearchParams(search)
  const value = params.get('safe')
  if (value !== null && value !== '0' && value !== 'false') return true
  return /(?:^|&)safe(?:=1|=true)?(?:&|$)/.test(hash) || hash === 'safe'
}

/** 防御式读取 `settings.plugins`（hydrate 前取默认值）。 */
export function readPluginSettings(): PluginSettings {
  const state = useSettingsStore.getState() as unknown as { plugins?: Partial<PluginSettings> | null }
  return mergePluginSettings(state.plugins)
}

/** 一层合并（`values` 整体替换；`creator` 字段补齐）。 */
export function mergePluginSettings(partial: Partial<PluginSettings> | null | undefined): PluginSettings {
  if (!partial) return cloneDefaultSettings()
  return {
    enabled: { ...(partial.enabled ?? {}) },
    safeMode: partial.safeMode === true,
    keymapOverrides: { ...(partial.keymapOverrides ?? {}) },
    layoutOverride: (partial.layoutOverride ?? null) as PluginLayoutOverride | null,
    values: { ...(partial.values ?? {}) },
    creator: { ...DEFAULT_PLUGIN_SETTINGS.creator, ...(partial.creator ?? {}) },
    auditLimit: typeof partial.auditLimit === 'number' ? partial.auditLimit : DEFAULT_PLUGIN_SETTINGS.auditLimit,
  }
}

function cloneDefaultSettings(): PluginSettings {
  return {
    ...DEFAULT_PLUGIN_SETTINGS,
    enabled: {},
    keymapOverrides: {},
    values: {},
    creator: { ...DEFAULT_PLUGIN_SETTINGS.creator },
  }
}

/** 三入口 OR 判定（02 §3.3 启动事件顺序第 1 步）。 */
export function detectSafeMode(): SafeModeState {
  if (safeModeFromUrl()) return { active: true, source: 'url' }
  if (shiftPressedEarly) return { active: true, source: 'shift' }
  if (readPluginSettings().safeMode) return { active: true, source: 'setting' }
  return { active: false, source: null }
}

/** 镜像到 `html[data-lumen-safe]`（06 §3.1）。 */
export function applySafeModeToDom(state: SafeModeState): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (state.active) root.dataset.lumenSafe = '1'
  else delete root.dataset.lumenSafe
}

/** 安全模式下拒绝安装/启用（`E-SAFE-01`）。 */
export function isSafeModeBlocking(): boolean {
  return safeModeFromUrl() || readPluginSettings().safeMode || shiftPressedEarly
}

/** 仅测试/SSR 用：清空 Shift 标记。 */
export function resetSafeModeProbe(): void {
  shiftPressedEarly = false
}
