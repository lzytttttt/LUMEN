/**
 * settingsStore.ts —— 用户偏好（语言、UI 主题、模型端点、播放默认值）。
 * 持久化见 persistence/settings.ts；这里只做内存状态与默认值。
 */
import { create } from 'zustand'
import type { Lang } from '@/i18n/types'

export type UiTheme = 'dark' | 'light' | 'system'
export type LlmProviderId = 'mock' | 'openai' | 'replay'

/** `response_format` 三档降级（05 §5）。 */
export type LlmFormat = 'auto' | 'json' | 'strict' | 'none'

export interface LlmSettings {
  provider: LlmProviderId
  baseURL: string
  apiKey: string
  model: string
  temperature: number
  jsonMode: boolean
  timeoutMs: number
  /** v0.2.0 增量字段（全部可选语义，默认值见 DEFAULT_LLM）。 */
  format: LlmFormat
  stream: boolean
  firstByteTimeoutMs: number
  frameIdleMs: number
  maxRetries: number
  cache: boolean
  concurrency: number
  presetId: string | null
}

export const DEFAULT_LLM: LlmSettings = {
  provider: 'mock',
  baseURL: '',
  apiKey: '',
  model: '',
  temperature: 0.7,
  jsonMode: true,
  timeoutMs: 90_000,
  format: 'auto',
  stream: true,
  firstByteTimeoutMs: 12_000,
  frameIdleMs: 20_000,
  maxRetries: 2,
  cache: true,
  concurrency: 2,
  presetId: null,
}

/* ------------------------------ 造幕台设置 ------------------------------ */

export type ForgeTierSetting = 'auto' | 'L0' | 'L1' | 'L2' | 'L3'
export type ForgeGameplay = 'min' | 'full'

export interface ForgeSettings {
  /** 台面档位：auto = 按 00 §6.1 判定；L0–L3 = 锁档（只降不升）。 */
  tier: ForgeTierSetting
  /** 五类轻音，默认关（D6）。 */
  sound: boolean
  /** 全部落位后自动进开演（04 §8.3）。 */
  autoPremiere: boolean
  /** 游戏层档位：min（默认，连击 + 3 成就）/ full（v0.2.1 全量）。 */
  gameplay: ForgeGameplay
}

export const DEFAULT_FORGE: ForgeSettings = {
  tier: 'auto',
  sound: false,
  autoPremiere: true,
  gameplay: 'min',
}

export interface SettingsSnapshot {
  lang: Lang
  uiTheme: UiTheme
  reducedMotion: boolean
  llm: LlmSettings
  forge: ForgeSettings
  autoPlayMs: number
  lastDeckId: string | null
  onboarded: boolean
}

export const DEFAULT_SETTINGS: SettingsSnapshot = {
  lang: 'zh',
  uiTheme: 'dark',
  reducedMotion: false,
  llm: DEFAULT_LLM,
  forge: DEFAULT_FORGE,
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
  patchForge: (patch: Partial<ForgeSettings>) => void
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
      forge: { ...DEFAULT_FORGE, ...(snapshot?.forge ?? {}) },
      hydrated: true,
    })),
  setLang: (lang) => set({ lang }),
  setUiTheme: (uiTheme) => set({ uiTheme }),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
  patchLlm: (patch) => set((s) => ({ llm: { ...s.llm, ...patch } })),
  patchForge: (patch) => set((s) => ({ forge: { ...s.forge, ...patch } })),
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
    forge: state.forge,
    autoPlayMs: state.autoPlayMs,
    lastDeckId: state.lastDeckId,
    onboarded: state.onboarded,
  }
}

/** 模型是否已配置（决定 Mock 还是真调用）。`replay` 不依赖端点，恒就绪。 */
export function isLlmReady(llm: LlmSettings): boolean {
  if (llm.provider === 'replay') return true
  return llm.provider === 'openai' && llm.baseURL.trim() !== '' && llm.model.trim() !== ''
}

export function maskKey(key: string): string {
  const k = key.trim()
  if (k === '') return ''
  if (k.length <= 8) return '••••'
  return `${k.slice(0, 3)}••••${k.slice(-3)}`
}
