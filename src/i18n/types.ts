/** i18n/types.ts —— 语言与词典类型（无依赖，避免循环）。 */
export type Lang = 'zh' | 'en'

export const LANGS: { id: Lang; label: string; short: string }[] = [
  { id: 'zh', label: '简体中文', short: '中' },
  { id: 'en', label: 'English', short: 'EN' },
]

export function isLang(v: unknown): v is Lang {
  return v === 'zh' || v === 'en'
}
