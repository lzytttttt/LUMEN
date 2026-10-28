/**
 * i18n/index.ts —— 轻量自研 i18n。
 * - zh 为类型源；en 结构必须一致（缺键在编译期/单测期即暴露）。
 * - 键名形如 editor.topbar.exportDeck；用 {name} 占位插值。
 */
import { useCallback } from 'react'
import { useSettingsStore } from '@/state/settingsStore'
import type { Lang } from './types'
import { commonZh } from './messages/common.zh'
import { commonEn } from './messages/common.en'
import { editorZh } from './messages/editor.zh'
import { editorEn } from './messages/editor.en'
import { aiZh } from './messages/ai.zh'
import { aiEn } from './messages/ai.en'
import { playZh } from './messages/play.zh'
import { playEn } from './messages/play.en'
import { exportZh } from './messages/export.zh'
import { exportEn } from './messages/export.en'
import { studioZh } from './messages/studio.zh'
import { studioEn } from './messages/studio.en'
import { forgeZh } from './messages/forge.zh'
import { forgeEn } from './messages/forge.en'
import { portalZh } from './messages/portal.zh'
import { portalEn } from './messages/portal.en'
import { onboardZh } from './messages/onboard.zh'
import { onboardEn } from './messages/onboard.en'

export type { Lang } from './types'
export { LANGS, isLang } from './types'
export { useLang } from './useLang'

const zhDict = {
  common: commonZh,
  editor: editorZh,
  ai: aiZh,
  play: playZh,
  export: exportZh,
  studio: studioZh,
  forge: forgeZh,
  portal: portalZh,
  onboard: onboardZh,
}

const enDict: typeof zhDict = {
  common: commonEn,
  editor: editorEn,
  ai: aiEn,
  play: playEn,
  export: exportEn,
  studio: studioEn,
  forge: forgeEn,
  portal: portalEn,
  onboard: onboardEn,
}

type Leaves<T, Prefix extends string = ''> = T extends Record<string, unknown>
  ? {
      [K in keyof T & string]: Leaves<T[K], Prefix extends '' ? K : `${Prefix}.${K}`>
    }[keyof T & string]
  : Prefix

export type MessageKey = Leaves<typeof zhDict>

export type Vars = Record<string, string | number>

function flatten(node: unknown, prefix: string, out: Record<string, string>): void {
  if (typeof node === 'string') {
    out[prefix] = node
    return
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      flatten(value, prefix === '' ? key : `${prefix}.${key}`, out)
    }
  }
}

const flat: Record<Lang, Record<string, string>> = {
  zh: {},
  en: {},
}
flatten(zhDict, '', flat.zh)
flatten(enDict, '', flat.en)

const warned = new Set<string>()

export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  )
}

export function translate(lang: Lang, key: string, vars?: Vars): string {
  const dict = flat[lang] ?? flat.zh
  let raw = dict[key]
  if (raw === undefined) {
    raw = flat.zh[key]
    if (raw === undefined) {
      if (import.meta.env?.DEV && !warned.has(key)) {
        warned.add(key)
        console.warn(`[i18n] missing key: ${key}`)
      }
      return key
    }
    if (import.meta.env?.DEV && !warned.has(key)) {
      warned.add(key)
      console.warn(`[i18n] missing ${lang} translation: ${key}`)
    }
  }
  return interpolate(raw, vars)
}

/** 非响应式取词（事件处理器、导出、播放器内核里用）。 */
export function t(key: MessageKey, vars?: Vars): string {
  return translate(useSettingsStore.getState().lang, key, vars)
}

/** 响应式取词。 */
export function useT() {
  const lang = useSettingsStore((s) => s.lang)
  return useCallback((key: MessageKey, vars?: Vars) => translate(lang, key, vars), [lang])
}

export function formatNumber(value: number, lang: Lang, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US', options).format(value)
}

export function formatDate(ts: number, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts))
}

/** 供 storybook/测试使用：完整扁平词典（只读）。 */
export function dictionaryOf(lang: Lang): Record<string, string> {
  return flat[lang]
}

export function allMessageKeys(): string[] {
  return Object.keys(flat.zh)
}
