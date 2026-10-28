/**
 * StudioHost.tsx —— SVG / 3D 工作室的全局挂载点（零 props，App 里挂一次）。
 *
 * 事件契约（与 panels 的 `studioBridge.ts` 一致，别改）：
 *   window.dispatchEvent(new CustomEvent('lumen:open-studio', { detail: { kind, blockId } }))
 * - `kind`：'svg' | 'three'
 * - `blockId`：有值 = 编辑既有块；缺省 = 新建流程（插入到当前幕）
 *
 * 生命周期的两条硬要求：
 * - **没有会话时零渲染**：`session === null` 直接返回 null（连 Modal 都不创建）；
 * - 挂载期间写 `document.documentElement.dataset.lumenStudio = '1'`，
 *   面板据此判断工作区是否已注册监听（`openStudio()` 的返回值）。
 */
import { useEffect, useState } from 'react'
import { useT } from '@/i18n'
import { Modal } from '@/ui/primitives'
import { SvgStudio } from './svg/SvgStudio'
import { ThreeStudio } from './three/ThreeStudio'
import './studio.css'

export type StudioKind = 'svg' | 'three'

export const STUDIO_EVENT = 'lumen:open-studio'

export interface StudioOpenDetail {
  kind: StudioKind
  blockId?: string
}

interface StudioSession extends StudioOpenDetail {
  /** 每次打开都换 key：重开时丢弃上一次的本地草稿。 */
  nonce: number
}

/** 宽松解析事件 detail（新建流程允许没有 blockId；非法 kind 一律忽略）。 */
export function parseStudioDetail(detail: unknown): StudioOpenDetail | null {
  if (!detail || typeof detail !== 'object') return null
  const raw = detail as { kind?: unknown; blockId?: unknown }
  if (raw.kind !== 'svg' && raw.kind !== 'three') return null
  const blockId = typeof raw.blockId === 'string' && raw.blockId.trim() !== '' ? raw.blockId : undefined
  return { kind: raw.kind, blockId }
}

export function StudioHost() {
  const t = useT()
  const [session, setSession] = useState<StudioSession | null>(null)

  useEffect(() => {
    const onOpen = (event: Event) => {
      const category = event as CustomEvent<unknown>
      const detail = parseStudioDetail(category.detail)
      if (!detail) return
      setSession({ ...detail, nonce: Date.now() + Math.random() })
    }
    window.addEventListener(STUDIO_EVENT, onOpen)
    document.documentElement.dataset.lumenStudio = '1'
    return () => {
      window.removeEventListener(STUDIO_EVENT, onOpen)
      delete document.documentElement.dataset.lumenStudio
    }
  }, [])

  if (!session) return null

  const close = () => setSession(null)
  const title = session.kind === 'svg' ? t('studio.svg.title') : t('studio.three.title')

  return (
    <Modal open onClose={close} title={title} size="lg" closeLabel={t('studio.common.close')}>
      {session.kind === 'svg' ? (
        <SvgStudio key={`svg-${session.nonce}`} blockId={session.blockId} onClose={close} />
      ) : (
        <ThreeStudio key={`three-${session.nonce}`} blockId={session.blockId} onClose={close} />
      )}
    </Modal>
  )
}

export default StudioHost
