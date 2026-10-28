/**
 * forge/fx/tier.ts —— 台面降级判定（00 §6.1）。
 * 只降不升：一次判定，运行中不反复抖动；锁档优先于自动判定，`?still=1` 优先于一切。
 */
import { useSettingsStore, type ForgeTierSetting } from '@/state/settingsStore'
import type { ForgeTier } from '../types'

export interface TierInputs {
  locked?: ForgeTierSetting
  reducedMotion?: boolean
  cores?: number
  saveData?: boolean
  webgl2?: boolean
  still?: boolean
}

export function isStillMode(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  return params.get('still') === '1'
}

export function detectTier(inputs: TierInputs = {}): ForgeTier {
  if (inputs.still) return 'L0'
  const locked = inputs.locked ?? 'auto'
  if (locked !== 'auto') return locked
  if (inputs.reducedMotion) return 'L1'
  const cores = inputs.cores ?? (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 4 : 4)
  if (cores <= 2) return 'L1'
  if (inputs.saveData) return 'L1'
  const webgl2 = inputs.webgl2 ?? hasWebgl2()
  return webgl2 && cores >= 4 ? 'L3' : 'L2'
}

export function hasWebgl2(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return canvas.getContext('webgl2') !== null
  } catch {
    return false
  }
}

/** 当前环境的档位（读设置 + 媒体查询 + 网络提示，只算一次）。 */
export function currentTier(): ForgeTier {
  if (typeof window === 'undefined') return 'L0'
  const settings = useSettingsStore.getState()
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const connection = (nav as unknown as { connection?: { saveData?: boolean } } | undefined)?.connection
  const reduced =
    settings.reducedMotion ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  return detectTier({
    locked: settings.forge.tier,
    reducedMotion: reduced,
    cores: nav?.hardwareConcurrency,
    saveData: connection?.saveData === true,
    still: isStillMode(),
  })
}

export function tierVar(tier: ForgeTier): string {
  return `--forge-tier-${tier.toLowerCase()}`
}
