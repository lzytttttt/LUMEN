/**
 * forge/diagnostics.ts —— 「导出诊断 JSON」（01 §8 产品化要件）。
 * 不含 apiKey / baseURL：只记通道档 id、就绪状态与模型名，以及最近 20 条错误码。
 */
import { getStorageMode } from '@/persistence/kv'
import { useSettingsStore } from '@/state/settingsStore'
import { APP_VERSION } from '@/version'

export interface DiagnosticEntry {
  code: string
  at: number
}

const errors: DiagnosticEntry[] = []

export function recordDiagnostic(code: string): void {
  errors.push({ code, at: Date.now() })
  if (errors.length > 20) errors.splice(0, errors.length - 20)
}

export function buildDiagnostics(): Record<string, unknown> {
  const settings = useSettingsStore.getState()
  return {
    app: 'lumen',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    locale: settings.lang,
    storage: getStorageMode(),
    channel: {
      id: settings.llm.provider,
      model: settings.llm.model.trim() || null,
      stream: settings.llm.stream,
      cache: settings.llm.cache,
    },
    forge: {
      tier: settings.forge.tier,
      gameplay: settings.forge.gameplay,
      sound: settings.forge.sound,
      autoPremiere: settings.forge.autoPremiere,
    },
    reducedMotion: settings.reducedMotion,
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    recentErrors: errors.slice(-20),
  }
}

export function downloadDiagnostics(): void {
  const blob = new Blob([JSON.stringify(buildDiagnostics(), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'lumen-diagnostics.json'
  link.click()
  URL.revokeObjectURL(url)
}
