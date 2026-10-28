import type { CSSProperties, ReactNode } from 'react'
import type { Block } from '@/schema/deck'

export function BlockFrame({
  block,
  children,
  mode,
  editing,
}: {
  block: Block
  children: ReactNode
  mode: 'stage' | 'play' | 'thumb' | 'print' | 'export'
  editing?: boolean
}) {
  const style: CSSProperties = {
    left: block.x,
    top: block.y,
    width: block.w,
    height: block.h,
    zIndex: block.z,
    opacity: block.opacity,
    transform: block.rotation ? `rotate(${block.rotation}deg)` : undefined,
    ...(block.enterDelayMs ? { animationDelay: `${block.enterDelayMs}ms` } : {}),
  }
  return (
    <div
      className="lumen-block"
      data-block-id={block.id}
      data-block-type={block.type}
      data-enter={block.enter === 'none' ? undefined : block.enter}
      data-locked={block.locked ? 'true' : undefined}
      data-editing={editing ? 'true' : undefined}
      data-mode={mode}
      style={style}
    >
      {children}
    </div>
  )
}
