/**
 * plugins/boot.ts —— 首屏唯一插件增量的**宿主侧入口**（02 §3.3 / §10.3）。
 *
 * 本文件同时持有「早期快照」：启用集 / 安全模式。原因：
 * - `public.ts` 的 hooks 需要它（首帧即可用），但它不能反向 import public（否则 boot 被拆成独立 chunk，
 *   违反 02 §10.3「boot.ts 打进主 chunk」）；
 * - `registry.ts` 变更启用集时通过 `public.ts` 的再导出更新这里。
 *
 * boot 只做四件事：
 * 1. 安全模式三入口判定 + `html[data-lumen-safe]` 镜像；
 * 2. 从 `settings.plugins.enabled` 得启用数并镜像 `html[data-lumen-plugins]`；
 * 3. 注册全局 drop 事件 `lumen:plugin-install`（零插件时也能懒加载安装管线）；
 * 4. **启用集为空且非安全模式 → 同步 early-return**，不 import 任何插件运行时模块。
 */
import { applySafeModeToDom, detectSafeMode, installShiftDetector, readPluginSettings } from './safe-mode'
import { auditSafeModeOn } from './audit'
import type { SafeModeSource } from './safe-mode'

const INSTALL_EVENT = 'lumen:plugin-install'
const OPEN_MANAGER_EVENT = 'lumen:open-plugin-manager'

/** 早期快照（启用集 + 安全模式）；壳层第一帧就可用。 */
export interface PluginBootState {
  enabledIds: string[]
  safeMode: boolean
  safeSource: SafeModeSource | null
}

let bootState: PluginBootState = { enabledIds: [], safeMode: false, safeSource: null }
const bootListeners = new Set<() => void>()
let booted = false
let listenerInstalled = false

function emitBoot(): void {
  for (const listener of bootListeners) listener()
}

/** React 门面用：订阅早期快照。 */
export function subscribePluginBootState(listener: () => void): () => void {
  bootListeners.add(listener)
  return () => {
    bootListeners.delete(listener)
  }
}

export function getPluginBootState(): PluginBootState {
  return bootState
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** 启动第一步调用（同步、幂等）；镜像 `html[data-lumen-plugins]` / `html[data-lumen-safe]`。 */
export function applyPluginBootState(next: PluginBootState): void {
  bootState = { enabledIds: [...next.enabledIds].sort(), safeMode: next.safeMode, safeSource: next.safeSource }
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.lumenPlugins = String(bootState.enabledIds.length)
    if (bootState.safeMode) document.documentElement.dataset.lumenSafe = '1'
    else delete document.documentElement.dataset.lumenSafe
  }
  emitBoot()
}

/** registry 在启用集变化时调用（记录是真源）。 */
export function syncPluginsEnabledSnapshot(ids: string[]): void {
  const next = [...ids].sort()
  if (sameIds(next, bootState.enabledIds)) return
  bootState = { ...bootState, enabledIds: next }
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.lumenPlugins = String(next.length)
  }
  emitBoot()
}

export function syncSafeModeSnapshot(active: boolean, source: SafeModeSource | null = null): void {
  if (bootState.safeMode === active) return
  bootState = { ...bootState, safeMode: active, safeSource: active ? source : null }
  if (typeof document !== 'undefined') {
    if (active) document.documentElement.dataset.lumenSafe = '1'
    else delete document.documentElement.dataset.lumenSafe
  }
  emitBoot()
}

/** `window` 事件 `lumen:plugins-changed`（06 §3.2 宿主测试钩子）。 */
export function emitPluginsChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('lumen:plugins-changed', {
      detail: { enabledIds: [...bootState.enabledIds], count: bootState.enabledIds.length },
    }),
  )
}

/** 已启用插件 id（非响应式快照；测试/诊断用）。 */
export function enabledPluginIdsSnapshot(): string[] {
  return [...bootState.enabledIds]
}

/** 手动触发「打开插件管理器」的 window 事件名（shell-ui 监听）。 */
export const PLUGIN_OPEN_MANAGER_EVENT = OPEN_MANAGER_EVENT

/** 启动入口（App/bootstrap 调用一次；幂等）。 */
export function bootPlugins(): void {
  if (booted) return
  booted = true
  installShiftDetector()

  const safe = detectSafeMode()
  applySafeModeToDom(safe)
  // 安全模式：不读 plugins store、不注册贡献、不建帧；`data-lumen-plugins` 归零（06 G8/E-40-11）。
  // 注意：**不改**持久化的 `settings.plugins.enabled`（03 §5.3 #6，退出安全模式后原启用集恢复）。
  const settings = readPluginSettings()
  const enabledIds = safe.active
    ? []
    : Object.keys(settings.enabled)
        .filter((id) => settings.enabled[id] === true)
        .sort()

  applyPluginBootState({ enabledIds, safeMode: safe.active, safeSource: safe.source })
  installGlobalListeners()

  if (safe.active) {
    // 03 §5.3：安全模式不读 plugins store；审计只进内存日志。
    void auditSafeModeOn(safe.source ?? 'setting')
    return
  }
  if (enabledIds.length === 0) return

  scheduleRuntimeLoad()
}

function scheduleRuntimeLoad(): void {
  const load = () => {
    void import('./runtime')
      .then((module) => module.startPluginRuntime())
      .catch(() => {
        /* 工作台永不因插件白屏（D-40-18） */
      })
  }
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number })
    .requestIdleCallback
  if (typeof idle === 'function') idle(load, { timeout: 1200 })
  else window.setTimeout(load, 0)
}

function installGlobalListeners(): void {
  if (listenerInstalled || typeof window === 'undefined') return
  listenerInstalled = true
  window.addEventListener(INSTALL_EVENT, (event) => {
    const file = (event as CustomEvent<{ file?: File }>).detail?.file
    if (!file) return
    void import('./runtime')
      .then((module) => module.installPluginFromDrop(file))
      .catch(() => {})
  })
  window.addEventListener(OPEN_MANAGER_EVENT, () => {
    // 插件管理器 UI 属 shell-ui 域：由它在 window 上监听本事件并打开弹窗。
  })
}
