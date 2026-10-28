/**
 * forge/ForgeHost.tsx —— 造幕台全局挂载点（照 StudioHost 的两条硬要求）。
 *
 * 事件契约：`lumen:open-forge`，detail 为 `{ source }`；四个入口共用（02 §2.1）。
 * 生命周期：`session === null` 零渲染；挂载期写 `html[data-lumen-forge="1"]`；
 * `Esc` 关闭后焦点回到触发按钮（returnFocus）。
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'

const ForgeApp = lazy(() => import('./ForgeApp').then((module) => ({ default: module.ForgeApp })))

export const FORGE_EVENT = 'lumen:open-forge'

export type ForgeSource = 'topbar' | 'palette' | 'rail' | 'empty'

export interface ForgeOpenDetail {
  source: ForgeSource
  /** 首启引导可以带一句预填词，省掉第一步打字。 */
  prefill?: string
}

export function parseForgeDetail(detail: unknown): ForgeOpenDetail {
  const raw = detail as { source?: unknown; prefill?: unknown } | null
  const source = raw && typeof raw === 'object' ? raw.source : undefined
  const allowed: ForgeSource[] = ['topbar', 'palette', 'rail', 'empty']
  const prefill = typeof raw?.prefill === 'string' && raw.prefill.trim() !== '' ? raw.prefill.slice(0, 400) : undefined
  return {
    source: allowed.includes(source as ForgeSource) ? (source as ForgeSource) : 'topbar',
    prefill,
  }
}

export function openForge(source: ForgeSource = 'topbar', prefill?: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<ForgeOpenDetail>(FORGE_EVENT, { detail: { source, prefill } }))
}

interface ForgeSession {
  nonce: number
  prefill?: string
}

export function ForgeHost() {
  const [session, setSession] = useState<ForgeSession | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onOpen = (event: Event) => {
      const active = document.activeElement
      returnFocus.current = active instanceof HTMLElement ? active : null
      const detail = parseForgeDetail((event as CustomEvent<unknown>).detail)
      setSession({ nonce: Date.now() + Math.random(), prefill: detail.prefill })
    }
    window.addEventListener(FORGE_EVENT, onOpen)
    return () => {
      window.removeEventListener(FORGE_EVENT, onOpen)
      delete document.documentElement.dataset.lumenForge
    }
  }, [])

  const close = useCallback(() => {
    setSession(null)
    const target = returnFocus.current
    returnFocus.current = null
    if (target && document.contains(target)) {
      window.setTimeout(() => target.focus({ preventScroll: true }), 0)
    }
  }, [])

  if (!session) return null
  return (
    <Suspense fallback={null}>
      <ForgeApp key={session.nonce} onClose={close} initialPrompt={session.prefill} />
    </Suspense>
  )
}

export default ForgeHost
