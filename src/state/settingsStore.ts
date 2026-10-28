/**
 * settingsStore.ts —— 用户偏好（语言、UI 主题、模型端点、播放默认值）。
 * 持久化见 persistence/settings.ts；这里只做内存状态与默认值。
 */
import { create } from 'zustand'
import type { Lang } from '@/i18n/types'

export type UiTheme = 'dark' | 'light' | 'system'
export type LlmProviderId = 'mock' | 'openai'

export interface LlmSettings {
  provider: LlmProviderId
  baseURL: string
  apiKey: string
  model: string
  temperature: number
  jsonMode: boolean
  timeoutMs: number
}

export const DEFAULT_LLM: LlmSettings = {
  provider: 'mock',
  baseURL: '',
  apiKey: '',
  model: '',
  temperature: 0.7,
  jsonMode: true,
  timeoutMs: 90_000,
}

export interface SettingsSnapshot {
  lang: Lang
  uiTheme: UiTheme
  reducedMotion: boolean
  llm: LlmSettings
  autoPlayMs: number
  lastDeckId: string | null
  onboarded: boolean
}

export const DEFAULT_SETTINGS: SettingsSnapshot = {
  lang: 'zh',
  uiTheme: 'dark',
  reducedMotion: false,
  llm: DEFAULT_LLM,
  autoPlayMs: 8000,
  lastDeckId: null,
  onboarded: false,
}

interface SettingsState extends SettingsSnapshot {
  hydrated: boolean
  hydrate: (snapshot: Partial<SettingsSnapshot> | null | undefined) => void
  setLang: (lang: Lang) => void
  setUiTheme: (theme: UiTheme) => void
  setReducedMotion: (v: boolean) => void
  patchLlm: (patch: Partial<LlmSettings>) => void
  setAutoPlayMs: (ms: number) => void
  setLastDeckId: (id: string | null) => void
  setOnboarded: (v: boolean) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ...DEFAULT_SETTINGS,
  hydrated: false,
  hydrate: (snapshot) =>
    set((state) => ({
      ...state,
      ...(snapshot ?? {}),
      llm: { ...DEFAULT_LLM, ...(snapshot?.llm ?? {}) },
      hydrated: true,
    })),
  setLang: (lang) => set({ lang }),
  setUiTheme: (uiTheme) => set({ uiTheme }),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
  patchLlm: (patch) => set((s) => ({ llm: { ...s.llm, ...patch } })),
  setAutoPlayMs: (autoPlayMs) => set({ autoPlayMs }),
  setLastDeckId: (lastDeckId) => set({ lastDeckId }),
  setOnboarded: (onboarded) => set({ onboarded }),
}))

export function settingsSnapshot(state: SettingsState): SettingsSnapshot {
  return {
    lang: state.lang,
    uiTheme: state.uiTheme,
    reducedMotion: state.reducedMotion,
    llm: state.llm,
    autoPlayMs: state.autoPlayMs,
    lastDeckId: state.lastDeckId,
    onboarded: state.onboarded,
  }
}

/** 模型是否已配置（决定 Mock 还是真调用）。 */
export function isLlmReady(llm: LlmSettings): boolean {
  return llm.provider === 'openai' && llm.baseURL.trim() !== '' && llm.model.trim() !== ''
}

export function maskKey(key: string): string {
  const k = key.trim()
  if (k === '') return ''
  if (k.length <= 8) return '••••'
  return `${k.slice(0, 3)}••••${k.slice(-3)}`
}
