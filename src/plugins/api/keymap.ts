/**
 * plugins/api/keymap.ts —— `lumen.keymap`（02 §5.2 / §5.3 / §6.7）。
 *
 * 约束：
 * - combo 必须含 `mod`/`shift`/`alt` 之一（裸单键拒绝，§9.7 #20）；
 * - 与内置 `SHORTCUTS`（`src/editor/shortcuts.ts`）或另一插件冲突时**不静默覆盖**，返回 conflict 由 UI 确认；
 * - 用户在 `settings.plugins.keymapOverrides[combo] === 'plugin'` 显式同意后才生效；
 * - 声明式 `contributes.keymap` 已在安装期完成同一判定，这里把它与运行期绑定合并成「活动绑定表」供宿主按键监听。
 */
import { SHORTCUTS } from '@/editor/shortcuts'
import { useSettingsStore } from '@/state/settingsStore'
import { getRegisteredKeymap } from '../contributionBus'
import { getRegisteredSlots } from '../contributionBus'
import { appendAudit } from '../audit'
import type { ApiCall } from './context'
import { abiError, assertRecord, assertString, registerNamespaceApi } from './gateway'
import { comboFromDisplay, normalizeCombo, parseCombo } from './util'

export interface KeymapConflictInfo {
  owner: string
  keys: string
}

export interface KeymapBindResult {
  ok: boolean
  conflict?: KeymapConflictInfo
}

export interface ActiveKeyBinding {
  combo: string
  tokens: string[]
  pluginId: string
  /** 局部命令 id（运行期）或宿主命令 id（声明式）。 */
  commandId: string
  hostCommandId: string
  source: 'runtime' | 'declarative'
}

const MODIFIERS = new Set(['mod', 'shift', 'alt'])

interface RuntimeBinding {
  pluginId: string
  commandId: string
  combo: string
}

/** combo → 运行期绑定（同一 combo 只允许一个插件，冲突必须显式覆盖）。 */
const runtimeBindings = new Map<string, RuntimeBinding>()

/** 内置快捷键的归一 combo（冲突判定读 `SHORTCUTS`，02 §1.3 / §6.7）。 */
const HOST_COMBOS: Array<{ combo: string; tokens: string[]; keys: string }> = SHORTCUTS.map((shortcut) => ({
  combo: normalizeCombo(shortcut.keys).join('+'),
  tokens: comboFromDisplay(shortcut.keys),
  keys: shortcut.keys,
}))

export function hostShortcutCombos(): Array<{ combo: string; keys: string }> {
  return HOST_COMBOS.map((entry) => ({ combo: entry.combo, keys: entry.keys }))
}

/** combo 是否有修饰键（裸键拒绝）。 */
export function hasModifier(tokens: readonly string[]): boolean {
  return tokens.some((token) => MODIFIERS.has(token))
}

/** `event` → 归一 token（与 combo 比对）。 */
export function tokensOfEvent(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>): string[] {
  const tokens: string[] = []
  if (event.ctrlKey || event.metaKey) tokens.push('mod')
  if (event.shiftKey) tokens.push('shift')
  if (event.altKey) tokens.push('alt')
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase()
  if (key && key !== 'control' && key !== 'meta' && key !== 'shift' && key !== 'alt') tokens.push(key)
  return [...new Set(tokens)].sort()
}

export function matchesCombo(tokens: readonly string[], event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>): boolean {
  const expected = [...tokens].sort()
  const actual = tokensOfEvent(event)
  if (expected.length !== actual.length) return false
  return expected.every((token, index) => token === actual[index])
}

function keymapOverrides(): Record<string, string> {
  return useSettingsStore.getState().plugins.keymapOverrides
}

function setOverride(combo: string, decision: 'host' | 'plugin'): void {
  const overrides = { ...keymapOverrides() }
  if (decision === 'plugin') overrides[combo] = 'plugin'
  else delete overrides[combo]
  useSettingsStore.getState().patchPlugins({ keymapOverrides: overrides })
}

function findPluginName(pluginId: string): string {
  try {
    const record = useSettingsStore.getState()
    void record
  } catch {
    /* noop */
  }
  const item = getRegisteredSlots().find((slot) => slot.pluginId === pluginId)
  return item ? item.title.zh || item.title.en : pluginId
}

/* ------------------------------ 方法 ------------------------------ */

export function bindKeymap(payload: unknown, call: ApiCall): KeymapBindResult {
  const body = assertRecord(payload, 'payload')
  const combo = assertString(body.combo, 'combo', { min: 1, max: 64 })
  const commandId = assertString(body.commandId, 'commandId', { min: 1, max: 72 })
  const tokens = normalizeCombo(combo)
  if (!hasModifier(tokens)) {
    return { ok: false, conflict: { owner: 'host', keys: combo } }
  }
  const normalized = tokens.join('+')
  const hostConflict = HOST_COMBOS.find((entry) => entry.combo === normalized)
  const override = keymapOverrides()[normalized]
  if (hostConflict && override !== 'plugin') {
    return { ok: false, conflict: { owner: 'host', keys: hostConflict.keys } }
  }
  const other = runtimeBindings.get(normalized)
  if (other && other.pluginId !== call.frame.pluginId) {
    return { ok: false, conflict: { owner: findPluginName(other.pluginId), keys: combo } }
  }
  runtimeBindings.set(normalized, { pluginId: call.frame.pluginId, commandId, combo: normalized })
  appendAudit({
    action: 'plugin.permission-grant',
    actor: 'user',
    result: 'ok',
    pluginId: call.frame.pluginId,
    detail: `keymap:${normalized}`,
  })
  return { ok: true }
}

export function unbindKeymap(payload: unknown, call: ApiCall): null {
  const body = assertRecord(payload, 'payload')
  const combo = assertString(body.combo, 'combo', { min: 1, max: 64 })
  const normalized = normalizeCombo(combo).join('+')
  const existing = runtimeBindings.get(normalized)
  if (existing && existing.pluginId === call.frame.pluginId) runtimeBindings.delete(normalized)
  return null
}

/** 用户确认键位冲突（`resolveKeymapConflict(combo,'plugin')`，由 shell-ui 调 public 门面）。 */
export function resolveKeymapConflict(combo: string, decision: 'host' | 'plugin'): void {
  const normalized = normalizeCombo(combo).join('+')
  setOverride(normalized, decision)
}

/** 活动绑定表：运行期绑定 + 声明式贡献（declarative 已做安装期冲突校验）。 */
export function activeKeyBindings(): ActiveKeyBinding[] {
  const bindings: ActiveKeyBinding[] = []
  for (const [normalized, binding] of runtimeBindings.entries()) {
    bindings.push({
      combo: normalized,
      tokens: parseCombo(normalized),
      pluginId: binding.pluginId,
      commandId: binding.commandId,
      hostCommandId: `plugin.${binding.pluginId}.${binding.commandId}`,
      source: 'runtime',
    })
  }
  const overrides = keymapOverrides()
  for (const entry of getRegisteredKeymap()) {
    const normalized = normalizeCombo(entry.binding.combo).join('+')
    if (overrides[normalized] === 'host') continue
    if (bindings.some((binding) => binding.combo === normalized)) continue
    bindings.push({
      combo: normalized,
      tokens: parseCombo(normalized),
      pluginId: entry.pluginId,
      commandId: entry.binding.commandId,
      hostCommandId: entry.hostCommandId,
      source: 'declarative',
    })
  }
  return bindings.sort((left, right) => left.combo.localeCompare(right.combo))
}

/** 键位冲突快照（public 门面 `getKeymapConflicts` 用）。 */
export interface KeymapConflictSnapshot {
  combo: string
  owner: 'host' | string
  pluginId: string
  pluginName: string
}

export function keymapConflicts(): KeymapConflictSnapshot[] {
  const conflicts: KeymapConflictSnapshot[] = []
  const overrides = keymapOverrides()
  for (const binding of activeKeyBindings()) {
    if (binding.source !== 'runtime') continue
    const host = HOST_COMBOS.find((entry) => entry.combo === binding.combo)
    if (!host) continue
    if (overrides[binding.combo] === 'plugin') continue
    conflicts.push({
      combo: binding.combo,
      owner: 'host',
      pluginId: binding.pluginId,
      pluginName: findPluginName(binding.pluginId),
    })
  }
  return conflicts
}

export function clearPluginKeybindings(pluginId: string): void {
  for (const [key, binding] of [...runtimeBindings.entries()]) {
    if (binding.pluginId === pluginId) runtimeBindings.delete(key)
  }
}

export function resetKeymapForTests(): void {
  runtimeBindings.clear()
}

export function registerKeymapApi(): void {
  registerNamespaceApi('keymap', {
    bind: (payload, call) => bindKeymap(payload, call),
    unbind: (payload, call) => unbindKeymap(payload, call),
  })
}

/** 声明式键位冲突检测（供 PluginManager 展示；类型与 public 门面一致）。 */
export function detectDeclarativeConflicts(): Array<{ combo: string; pluginId: string }> {
  const result: Array<{ combo: string; pluginId: string }> = []
  const seen = new Map<string, string>()
  for (const entry of getRegisteredKeymap()) {
    const normalized = normalizeCombo(entry.binding.combo).join('+')
    const existing = seen.get(normalized)
    if (existing && existing !== entry.pluginId) {
      result.push({ combo: normalized, pluginId: entry.pluginId })
    } else {
      seen.set(normalized, entry.pluginId)
    }
  }
  return result
}

export { abiError }
