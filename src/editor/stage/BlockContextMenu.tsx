/**
 * BlockContextMenu.tsx —— 块右键菜单（自绘，克制样式，Portal 到 body）。
 *
 * 置顶/置底/上移/下移、锁定、隐藏、复制、删除；多选时额外给出对齐/分布。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Block } from '@/schema/deck'
import type { AlignMode } from '@/schema/geometry'
import { useT } from '@/i18n'
import {
  deleteSelection,
  distributeSelection,
  duplicateSelection,
  alignSelection,
  reorderSelection,
  toggleHiddenSelection,
  toggleLockSelection,
} from '@/editor/interactions/commands'

export interface BlockContextMenuProps {
  x: number
  y: number
  block: Block
  count: number
  onClose: () => void
}

function MenuRow({
  children,
  onClick,
  tone,
  disabled,
}: {
  children: ReactNode
  onClick: () => void
  tone?: 'danger'
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={tone === 'danger' ? 'stage-menu__row stage-menu__row--danger' : 'stage-menu__row'}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export function BlockContextMenu({ x, y, block, count, onClose }: BlockContextMenuProps): ReactNode {
  const t = useT()
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const multi = count > 1

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const width = node.offsetWidth
    const height = node.offsetHeight
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    })
  }, [x, y])

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const run = (action: () => void) => () => {
    action()
    onClose()
  }

  const alignModes: Array<{ mode: AlignMode; labelKey: string }> = [
    { mode: 'left', labelKey: 'editor.stage.alignLeft' },
    { mode: 'hcenter', labelKey: 'editor.stage.alignHCenter' },
    { mode: 'right', labelKey: 'editor.stage.alignRight' },
    { mode: 'top', labelKey: 'editor.stage.alignTop' },
    { mode: 'vcenter', labelKey: 'editor.stage.alignVCenter' },
    { mode: 'bottom', labelKey: 'editor.stage.alignBottom' },
  ]

  return createPortal(
    <div ref={ref} className="stage-menu" style={pos} role="menu">
      <div className="stage-menu__head">{block.name ?? block.type}</div>
      <MenuRow onClick={run(() => reorderSelection('front'))}>{t('editor.stage.bringFront')}</MenuRow>
      <MenuRow onClick={run(() => reorderSelection('forward'))}>{t('editor.stage.bringForward')}</MenuRow>
      <MenuRow onClick={run(() => reorderSelection('backward'))}>{t('editor.stage.sendBackward')}</MenuRow>
      <MenuRow onClick={run(() => reorderSelection('back'))}>{t('editor.stage.sendBack')}</MenuRow>
      <div className="stage-menu__sep" />
      {multi ? (
        <>
          <div className="stage-menu__label">{t('editor.stage.align')}</div>
          <div className="stage-menu__grid">
            {alignModes.map((item) => (
              <button
                key={item.mode}
                type="button"
                className="stage-menu__chip"
                title={t(item.labelKey as Parameters<typeof t>[0])}
                onClick={run(() => void alignSelection(item.mode))}
              >
                {t(item.labelKey as Parameters<typeof t>[0])}
              </button>
            ))}
          </div>
          <div className="stage-menu__grid">
            <button
              type="button"
              className="stage-menu__chip"
              onClick={run(() => void distributeSelection('x'))}
            >
              {t('editor.stage.distributeH')}
            </button>
            <button
              type="button"
              className="stage-menu__chip"
              onClick={run(() => void distributeSelection('y'))}
            >
              {t('editor.stage.distributeV')}
            </button>
          </div>
          <div className="stage-menu__sep" />
        </>
      ) : null}
      <MenuRow onClick={run(() => void duplicateSelection())}>{t('editor.stage.duplicate')}</MenuRow>
      <MenuRow onClick={run(() => void toggleLockSelection())}>
        {block.locked ? t('editor.stage.unlock') : t('editor.stage.lock')}
      </MenuRow>
      <MenuRow onClick={run(() => void toggleHiddenSelection())}>{t('editor.stage.hide')}</MenuRow>
      <div className="stage-menu__sep" />
      <MenuRow tone="danger" onClick={run(() => void deleteSelection())}>
        {t('editor.stage.deleteSelection')}
      </MenuRow>
    </div>,
    document.body,
  )
}
