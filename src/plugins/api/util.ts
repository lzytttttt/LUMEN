/**
 * plugins/api/util.ts —— api 层共用小工具（标题本地化 / 参数归一）。
 */
import type { Lang } from '@/i18n/types'
import { currentLocale, type ApiCall } from './context'
import type { LocalizedText } from '../types'

export function titlePairOf(value: unknown): LocalizedText {
  if (typeof value === 'string') return { zh: value, en: value }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const zh = typeof record.zh === 'string' ? record.zh : ''
    const en = typeof record.en === 'string' ? record.en : ''
    return { zh: zh || en, en: en || zh }
  }
  return { zh: '', en: '' }
}

export function localizeTitle(value: LocalizedText | string | undefined, call?: ApiCall, lang?: Lang): string {
  const pair = typeof value === 'string' ? { zh: value, en: value } : value
  if (!pair) return ''
  const locale = lang ?? safeLocale(call)
  const primary = locale === 'en' ? pair.en : pair.zh
  return primary || pair.zh || pair.en || ''
}

function safeLocale(call?: ApiCall): Lang {
  void call
  try {
    return currentLocale()
  } catch {
    return 'zh'
  }
}

/** 命令面板里的双语标题：`插件 · <插件名> · <标题>`（02 §5.3）。 */
export function commandPaletteTitle(pluginName: LocalizedText, commandTitle: LocalizedText, lang: Lang): string {
  const plugin = lang === 'en' ? pluginName.en || pluginName.zh : pluginName.zh || pluginName.en
  const title = lang === 'en' ? commandTitle.en || commandTitle.zh : commandTitle.zh || commandTitle.en
  return lang === 'en' ? `Plugin · ${plugin} · ${title}` : `插件 · ${plugin} · ${title}`
}

/** 把 `mod+shift+k` 归一成 token 数组（小写、去空）。 */
export function parseCombo(combo: string): string[] {
  return combo
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
}

/** `mod` 在 Mac 是 ⌘、其他平台是 Ctrl；`SHORTCUTS.keys` 的展示串归一成同一套 token。 */
export function normalizeCombo(combo: string): string[] {
  const tokens: string[] = []
  for (const token of parseCombo(combo)) {
    if (token === 'cmd' || token === 'ctrl' || token === 'control') tokens.push('mod')
    else if (token === 'shift' || token === 'alt' || token === 'option') tokens.push(token === 'option' ? 'alt' : token)
    else if (token === 'meta') tokens.push('mod')
    else tokens.push(token)
  }
  return [...new Set(tokens)].sort()
}

/** 展示串 → 归一 combo（`⌘⇧K` / `Ctrl+Shift+K` → `mod+shift+k`）。 */
export function comboFromDisplay(display: string): string[] {
  const cleaned = display
    .replace(/⌘/g, 'mod+')
    .replace(/Ctrl/gi, 'mod+')
    .replace(/⇧/g, 'shift+')
    .replace(/Shift/gi, 'shift+')
    .replace(/⌥/g, 'alt+')
    .replace(/Alt/gi, 'alt+')
  const tokens: string[] = []
  for (const raw of cleaned.split('+')) {
    const token = raw.trim().toLowerCase()
    if (!token) continue
    tokens.push(token === 'ctrl' || token === 'cmd' ? 'mod' : token)
  }
  return [...new Set(tokens)].sort()
}
