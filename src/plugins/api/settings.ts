/**
 * plugins/api/settings.ts —— `lumen.settings`（02 §5.2 / §5.3 / §6.5）。
 *
 * 代码式插件用 `declare(fields)` 声明设置页字段（与清单 `contributes.settings` **二选一**，同时出现 → `E-MAN-09`）；
 * 值写 `settings.plugins.values[pluginId]`，不进 `pluginData`（随设置一起同步）。
 * `subscribe` 是帧内本地行为：宿主在 patch/reset 后向该插件帧推 `__settings`。
 */
import { useSettingsStore } from '@/state/settingsStore'
import { broadcastPluginSettings } from '../host/PluginHost'
import { getRegisteredSettings } from '../contributionBus'
import { localizeTitle } from './util'
import type { PluginSettingsEntry, SettingsField } from '../types'
import type { ApiCall } from './context'
import { abiError, assertJsonValue, assertRecord, registerNamespaceApi } from './gateway'

const FIELD_TYPES = ['text', 'textarea', 'switch', 'number', 'select', 'slider'] as const
const KEY_PATTERN = /^[a-z][a-zA-Z0-9._-]{0,63}$/

/** 代码式设置页声明（pluginId → fields）。 */
const declaredFields = new Map<string, SettingsField[]>()

function validateFields(input: unknown): SettingsField[] {
  if (!Array.isArray(input)) throw abiError('settings fields must be an array')
  if (input.length > 64) throw abiError('settings fields exceed limit 64')
  const seen = new Set<string>()
  const fields: SettingsField[] = []
  for (const item of input) {
    const record = assertRecord(item, 'field')
    const key = typeof record.key === 'string' ? record.key : ''
    if (!KEY_PATTERN.test(key)) throw abiError(`invalid settings field key "${String(record.key)}"`)
    if (seen.has(key)) throw abiError(`duplicate settings field "${key}"`)
    seen.add(key)
    const type = record.type
    if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) {
      throw abiError(`invalid settings field type for "${key}"`)
    }
    const label = record.label as { zh?: unknown; en?: unknown } | undefined
    if (!label || typeof label !== 'object') throw abiError(`settings field "${key}" needs a label`)
    const normalized: SettingsField = {
      key,
      type: type as SettingsField['type'],
      label: {
        zh: typeof label.zh === 'string' ? label.zh : '',
        en: typeof label.en === 'string' ? label.en : '',
      },
    } as SettingsField
    if (type === 'select') {
      if (!Array.isArray(record.options) || record.options.length === 0) throw abiError(`select "${key}" needs options`)
      ;(normalized as Extract<SettingsField, { type: 'select' }>).options = record.options.slice(0, 32).map((option) => {
        const entry = assertRecord(option, 'option')
        const value = typeof entry.value === 'string' ? entry.value : ''
        const optionLabel = entry.label as { zh?: unknown; en?: unknown } | undefined
        return {
          value,
          label: {
            zh: typeof optionLabel?.zh === 'string' ? optionLabel.zh : '',
            en: typeof optionLabel?.en === 'string' ? optionLabel.en : '',
          },
        }
      })
    }
    if (record.pholder !== undefined) void record.pholder
    if (typeof record.placeholder === 'string') (normalized as { placeholder?: string }).placeholder = record.placeholder
    if (typeof record.maxLength === 'number') (normalized as { maxLength?: number }).maxLength = record.maxLength
    if (typeof record.min === 'number') (normalized as { min?: number }).min = record.min
    if (typeof record.max === 'number') (normalized as { max?: number }).max = record.max
    if (typeof record.step === 'number') (normalized as { step?: number }).step = record.step
    fields.push(normalized)
  }
  return fields
}

function valuesOf(pluginId: string): Record<string, unknown> {
  return { ...(useSettingsStore.getState().plugins.values[pluginId] ?? {}) }
}

function writeValues(pluginId: string, next: Record<string, unknown>): void {
  const values = { ...useSettingsStore.getState().plugins.values, [pluginId]: next }
  useSettingsStore.getState().patchPlugins({ values })
  // 跨帧同步：同一插件 dock/overlay/页签各自独立实例，值变化后广播 __settings。
  broadcastPluginSettings(pluginId)
}

export function handleSettings(method: string, payload: unknown, call: ApiCall): Promise<unknown> | unknown {
  const { pluginId } = call.frame
  switch (method) {
    case 'declare': {
      const body = assertRecord(payload, 'payload')
      if (getRegisteredSettings().some((entry) => entry.pluginId === pluginId)) {
        throw abiError('contributes.settings and settings.declare are mutually exclusive')
      }
      declaredFields.set(pluginId, validateFields(body.fields))
      return null
    }
    case 'get': {
      return valuesOf(pluginId)
    }
    case 'patch': {
      const body = assertRecord(payload, 'payload')
      const patch = assertRecord(body.patch, 'patch')
      const declared = declaredFields.get(pluginId)
      if (declared) {
        const allowed = new Set(declared.map((field) => field.key))
        for (const key of Object.keys(patch)) {
          if (!allowed.has(key)) throw abiError(`settings key "${key}" is not declared`)
        }
      }
      const next = { ...valuesOf(pluginId) }
      for (const [key, value] of Object.entries(patch)) {
        if (!KEY_PATTERN.test(key)) throw abiError(`invalid settings key "${key}"`)
        next[key] = assertJsonValue(value, `patch.${key}`)
      }
      writeValues(pluginId, next)
      return null
    }
    case 'reset': {
      writeValues(pluginId, {})
      return null
    }
    default:
      throw abiError(`unknown settings method "${method}"`)
  }
}

/** 代码式设置页（宿主 SettingsSection 渲染用：`form:'frame'`）。 */
export function codeSettingsEntries(): PluginSettingsEntry[] {
  const entries: PluginSettingsEntry[] = []
  for (const [pluginId, fields] of declaredFields.entries()) {
    entries.push({
      pluginId,
      pageId: 'code-settings',
      title: { zh: '设置', en: 'Settings' },
      form: 'frame',
      fields,
    })
  }
  return entries
}

/** 合并视图：声明式（清单）→ `form:'declarative'`；代码式 → `form:'frame'`。 */
export function allSettingsEntries(): PluginSettingsEntry[] {
  const entries: PluginSettingsEntry[] = getRegisteredSettings().map((entry) => ({
    pluginId: entry.pluginId,
    pageId: entry.page.id,
    title: entry.page.title,
    form: 'declarative' as const,
    fields: entry.page.fields,
  }))
  return [...entries, ...codeSettingsEntries()]
}

export function declaredSettingsFields(pluginId: string): SettingsField[] | undefined {
  return declaredFields.get(pluginId)
}

export function settingsTitleOf(entry: PluginSettingsEntry, lang: 'zh' | 'en' = 'zh'): string {
  return localizeTitle(entry.title, undefined, lang)
}

export function clearPluginSettingsState(pluginId: string): void {
  declaredFields.delete(pluginId)
  const values = { ...useSettingsStore.getState().plugins.values }
  delete values[pluginId]
  useSettingsStore.getState().patchPlugins({ values })
}

export function resetSettingsApiForTests(): void {
  declaredFields.clear()
}

export function registerSettingsApi(): void {
  registerNamespaceApi('settings', {
    declare: (payload, call) => handleSettings('declare', payload, call),
    get: (payload, call) => handleSettings('get', payload, call),
    patch: (payload, call) => handleSettings('patch', payload, call),
    reset: (payload, call) => handleSettings('reset', payload, call),
    subscribe: () => null,
  })
}
