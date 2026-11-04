/**
 * plugins/i18n.ts —— 插件语言包 overlay（02 §8.2 / §6.4）。
 *
 * 规则：
 * - overlay **不进** `zhDict/enDict`（否则 MessageKey 膨胀、卸载无法重建）；
 * - 键 = `plugin.<pluginId>.` + 相对键；前缀外一律拒绝；
 * - zh/en 键集必须相等，值为空/超 200 字符一律拒绝；
 * - 查找链：overlay(当前语言) → overlay(zh) → 宿主 `plugin.*` 同键 → 键原文。
 */
import { translate } from '@/i18n'
import type { Lang } from '@/i18n/types'
import { PluginError } from './errors'
import type { LocalePackContribution } from './types'

export const LOCALE_KEY_PATTERN = /^[a-z][a-zA-Z0-9._-]{0,63}$/
export const LOCALE_VALUE_MAX = 200

interface LocaleOverlay {
  zh: Record<string, string>
  en: Record<string, string>
}

const overlays = new Map<string, LocaleOverlay>()

function prefixOf(pluginId: string): string {
  return `plugin.${pluginId}.`
}

/** 校验相对键（清单 `contributes.i18n` 的键 = 前缀后的相对键，02 §6.4）。 */
export function validateRelativeLocalePack(pack: LocalePackContribution): void {
  const zhKeys = Object.keys(pack.zh)
  const enKeys = Object.keys(pack.en)
  if (zhKeys.length !== enKeys.length || zhKeys.some((key) => !Object.prototype.hasOwnProperty.call(pack.en, key))) {
    throw new PluginError('E-MAN-09', 'locale pack zh/en key sets must be equal')
  }
  for (const key of zhKeys) {
    if (!LOCALE_KEY_PATTERN.test(key)) throw new PluginError('E-MAN-09', `invalid locale key "${key}"`)
    const zh = pack.zh[key]
    const en = pack.en[key]
    if (!zh || !en) throw new PluginError('E-MAN-09', `locale value for "${key}" is empty`)
    if (zh.length > LOCALE_VALUE_MAX || en.length > LOCALE_VALUE_MAX) {
      throw new PluginError('E-MAN-09', `locale value for "${key}" is longer than ${LOCALE_VALUE_MAX}`)
    }
  }
}

/** 注册清单声明的语言包（相对键 → 宿主加 `plugin.<id>.` 前缀）。 */
export function registerManifestLocalePack(pluginId: string, pack: LocalePackContribution): void {
  validateRelativeLocalePack(pack)
  const prefix = prefixOf(pluginId)
  const zh: Record<string, string> = {}
  const en: Record<string, string> = {}
  for (const key of Object.keys(pack.zh)) {
    zh[prefix + key] = pack.zh[key]
    en[prefix + key] = pack.en[key]
  }
  overlays.set(pluginId, { zh, en })
}

/** 注册运行期语言包（`lumen.i18n.register`）：键必须已带自己的前缀（02 §5.3）。 */
export function registerRuntimeLocalePack(pluginId: string, pack: LocalePackContribution): void {
  const prefix = prefixOf(pluginId)
  const zhKeys = Object.keys(pack.zh)
  const enKeys = Object.keys(pack.en)
  if (zhKeys.length !== enKeys.length || zhKeys.some((key) => !Object.prototype.hasOwnProperty.call(pack.en, key))) {
    throw new PluginError('E-ABI-02', 'locale pack zh/en key sets must be equal')
  }
  for (const key of zhKeys) {
    if (!key.startsWith(prefix)) {
      throw new PluginError('E-ABI-02', `locale key must start with "${prefix}"`)
    }
    const relative = key.slice(prefix.length)
    if (!LOCALE_KEY_PATTERN.test(relative)) throw new PluginError('E-ABI-02', `invalid locale key "${key}"`)
    const zh = pack.zh[key]
    const en = pack.en[key]
    if (!zh || !en) throw new PluginError('E-ABI-02', `locale value for "${key}" is empty`)
    if (zh.length > LOCALE_VALUE_MAX || en.length > LOCALE_VALUE_MAX) {
      throw new PluginError('E-ABI-02', `locale value for "${key}" is too long`)
    }
  }
  const next = overlays.get(pluginId) ?? { zh: {}, en: {} }
  overlays.set(pluginId, { zh: { ...next.zh, ...pack.zh }, en: { ...next.en, ...pack.en } })
}

export function unregisterLocalePack(pluginId: string): void {
  overlays.delete(pluginId)
}

export function getLocaleOverlay(pluginId: string): LocaleOverlay | undefined {
  return overlays.get(pluginId)
}

export function hasLocalePack(pluginId: string): boolean {
  return overlays.has(pluginId)
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  )
}

/** 插件内 `lumen.i18n.t`：按 02 §8.2 的回落链取词。 */
export function pluginTranslate(pluginId: string, lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const overlay = overlays.get(pluginId)
  if (overlay) {
    const localized = overlay[lang] ?? overlay.zh
    const found = localized[key]
    if (found !== undefined) return interpolate(found, vars)
    const fallback = overlay.zh[key]
    if (fallback !== undefined) return interpolate(fallback, vars)
  }
  if (key.startsWith('plugin.')) {
    const host = translate(lang, key, vars)
    if (host !== key) return host
  }
  return key
}

/** 仅测试用。 */
export function resetLocaleOverlaysForTests(): void {
  overlays.clear()
}
