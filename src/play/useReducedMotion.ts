/**
 * useReducedMotion.ts —— 统一的"减少动效"判定。
 * 系统偏好（prefers-reduced-motion）或用户在设置里手动开启，任一为真即视为开启。
 */
import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/state/settingsStore'

const QUERY = '(prefers-reduced-motion: reduce)'

function systemPrefersReduced(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(QUERY).matches
  } catch {
    return false
  }
}

export function useReducedMotion(): boolean {
  const setting = useSettingsStore((s) => s.reducedMotion)
  const [system, setSystem] = useState<boolean>(systemPrefersReduced)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(QUERY)
    const onChange = () => setSystem(mq.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  return setting || system
}
