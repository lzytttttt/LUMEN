/**
 * plugins/declarative/keymap.ts —— 插件键位（02 §6.7 / 03 §3.1）。
 *
 * 规则：
 * - combo 形如 `mod+shift+k`；**必须含修饰键**（manifest 期已拦裸键）；
 * - 与 `SHORTCUTS`（15 条内置）或另一插件冲突时**不静默覆盖**：产生 conflict 由 UI 弹确认；
 *   用户「让给插件」后写 `settings.plugins.keymapOverrides[combo] = 插件命令 hostId`；
 * - 内置快捷键的 `match` 不能反射，故用与 `src/editor/shortcuts.ts` 同步的占用表（改内置键位需同步这里）。
 */
import { isTypingTarget } from '@/editor/shortcuts'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { getRegisteredKeymap } from '../contributionBus'
import type { KeymapConflictInfo, PluginKeymapBinding } from '../types'

/** 内置快捷键的规范化占用表（与 `src/editor/shortcuts.ts` 的 15 条一致；改内置键位要同步）。 */
export const HOST_OCCUPIED_COMBOS: readonly string[] = [
  'mod+z',
  'mod+shift+z',
  'mod+y',
  'mod+c',
  'mod+x',
  'mod+v',
  'mod+d',
  'mod+a',
  'mod+enter',
  'delete',
  'backspace',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'shift+arrowup',
  'shift+arrowdown',
  'shift+arrowleft',
  'shift+arrowright',
  'g',
  'v',
  't',
  'r',
  'escape',
]

const MODIFIER_ORDER = ['mod', 'shift', 'alt'] as const

/** 规范化 combo：小写、修饰符按 mod→shift→alt 排序、键名小写、去空格。 */
export function normalizeCombo(combo: string): string {
  const parts = combo
    .trim()
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  const modifiers: string[] = []
  let key = ''
  for (const part of parts) {
    const canonical = part === 'ctrl' || part === 'cmd' || part === 'meta' || part === 'command' ? 'mod' : part === 'option' ? 'alt' : part
    if ((MODIFIER_ORDER as readonly string[]).includes(canonical)) modifiers.push(canonical)
    else key = canonical
  }
  modifiers.sort((left, right) => MODIFIER_ORDER.indexOf(left as (typeof MODIFIER_ORDER)[number]) - MODIFIER_ORDER.indexOf(right as (typeof MODIFIER_ORDER)[number]))
  return [...modifiers, key].filter(Boolean).join('+')
}

interface ParsedCombo {
  mod: boolean
  shift: boolean
  alt: boolean
  key: string
}

export function parseCombo(combo: string): ParsedCombo | null {
  const parts = normalizeCombo(combo).split('+')
  const key = parts.pop()
  if (!key) return null
  return {
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    key,
  }
}

function keyOfEvent(event: KeyboardEvent): string {
  const raw = event.key
  if (raw === ' ') return 'space'
  if (raw === 'Esc') return 'escape'
  if (raw === 'Delete' || raw === 'Backspace') return raw.toLowerCase()
  if (raw.startsWith('Arrow')) return raw.toLowerCase()
  if (raw === 'Enter') return 'enter'
  if (raw === 'Tab') return 'tab'
  if (/^F\d{1,2}$/.test(raw)) return raw.toLowerCase()
  return raw.toLowerCase()
}

export function matchesCombo(event: KeyboardEvent, combo: string): boolean {
  const parsed = parseCombo(combo)
  if (!parsed) return false
  const key = keyOfEvent(event)
  if (key !== parsed.key) return false
  const modPressed = event.metaKey || event.ctrlKey
  return parsed.mod === modPressed && parsed.shift === event.shiftKey && parsed.alt === event.altKey
}

/** 已启用插件的全部键位（快捷键弹窗「来源」列）。 */
export function getPluginKeymapBindings(): PluginKeymapBinding[] {
  return getRegisteredKeymap().map((registered) => ({
    combo: registered.binding.combo,
    commandId: registered.hostCommandId,
    pluginId: registered.pluginId,
    pluginName: registered.pluginName,
  }))
}

/** 冲突列表：内置占用（未被用户让位）+ 其他插件占用。 */
export function getKeymapConflicts(): KeymapConflictInfo[] {
  const overrides = useSettingsStore.getState().plugins.keymapOverrides
  const conflicts: KeymapConflictInfo[] = []
  const all = getRegisteredKeymap()
  for (const registered of all) {
    const combo = normalizeCombo(registered.binding.combo)
    const override = overrides[combo]
    const resolvedToPlugin = override === registered.hostCommandId
    if (HOST_OCCUPIED_COMBOS.includes(combo) && !resolvedToPlugin) {
      conflicts.push({
        combo,
        owner: 'host',
        pluginId: registered.pluginId,
        pluginName: registered.pluginName,
      })
      continue
    }
    const other = all.find((entry) => entry.pluginId !== registered.pluginId && normalizeCombo(entry.binding.combo) === combo)
    if (other) {
      conflicts.push({
        combo,
        owner: other.pluginId,
        pluginId: registered.pluginId,
        pluginName: registered.pluginName,
      })
    }
  }
  return conflicts
}

/** 用户确认后落盘覆盖（decision='plugin' 让位给插件；'host' 保持内置）。 */
export function resolveKeymapConflict(combo: string, decision: 'host' | 'plugin'): void {
  const normalized = normalizeCombo(combo)
  const settings = useSettingsStore.getState()
  const overrides = { ...settings.plugins.keymapOverrides }
  if (decision === 'host') {
    delete overrides[normalized]
  } else {
    const registered = getRegisteredKeymap().find((entry) => normalizeCombo(entry.binding.combo) === normalized)
    if (!registered) return
    overrides[normalized] = registered.hostCommandId
  }
  settings.patchPlugins({ keymapOverrides: overrides })
}

/** 真正生效的绑定：未被内置占用，或用户已让位给该插件。 */
export function getActiveBindings(): Array<{ combo: string; hostCommandId: string; pluginId: string }> {
  const overrides = useSettingsStore.getState().plugins.keymapOverrides
  return getRegisteredKeymap()
    .map((entry) => ({
      combo: normalizeCombo(entry.binding.combo),
      hostCommandId: entry.hostCommandId,
      pluginId: entry.pluginId,
    }))
    .filter((entry) => !HOST_OCCUPIED_COMBOS.includes(entry.combo) || overrides[entry.combo] === entry.hostCommandId)
}

export type PluginCommandRunner = (hostCommandId: string) => void | Promise<void>

let commandRunner: PluginCommandRunner | null = null
let installedDisposer: (() => void) | null = null

/** 宿主（runtime/api 层）提供「按 hostId 执行插件命令」的实现（含运行期注册的代码式命令）。 */
export function setPluginCommandRunner(runner: PluginCommandRunner | null): void {
  commandRunner = runner
}

/** 安装插件快捷键监听（全宿主唯一；重复调用返回同一个卸载函数）。 */
export function installPluginKeymapListener(): () => void {
  if (installedDisposer) return installedDisposer
  if (typeof window === 'undefined') return () => {}
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return
    if (isTypingTarget(event.target)) return
    if (useUiStore.getState().mode === 'forge') return
    for (const binding of getActiveBindings()) {
      if (!matchesCombo(event, binding.combo)) continue
      if (!commandRunner) return
      event.preventDefault()
      event.stopPropagation()
      void Promise.resolve(commandRunner(binding.hostCommandId)).catch(() => {})
      return
    }
  }
  window.addEventListener('keydown', onKeyDown, { capture: true })
  installedDisposer = () => {
    window.removeEventListener('keydown', onKeyDown, { capture: true })
    installedDisposer = null
  }
  return installedDisposer
}

export function uninstallPluginKeymapListener(): void {
  installedDisposer?.()
}
