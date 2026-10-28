/**
 * LayersTab.tsx —— 图层页签：按 z 倒序、点选、拖拽改层级、双击重命名、眼睛/锁。
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Eye, EyeOff, GripVertical, Lock, Unlock } from 'lucide-react'
import type { Block, Slide } from '@/schema/deck'
import { blockOps, slideOps } from '@/state/ops'
import { useSelectionStore } from '@/state/selectionStore'
import { useT } from '@/i18n'
import { Section } from '@/ui/primitives'
import { blockLabelOf } from '../blockLabels'
import { moveWithin, moveTargetIndex } from '../virtual'

interface LayerDrag {
  from: number
  to: number
  active: boolean
  pointerId: number
  startY: number
}

export function LayersTab({ slide }: { slide: Slide }) {
  const t = useT()
  const listRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<LayerDrag | null>(null)
  const suppressClick = useRef(false)
  const [drag, setDragState] = useState<LayerDrag | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const selectedIds = useSelectionStore((s) => s.selectedBlockIds)
  const toggleSelection = useSelectionStore((s) => s.toggleSelection)

  const ordered = useMemo(() => [...slide.blocks].sort((a, b) => b.z - a.z), [slide.blocks])

  const setDrag = (next: LayerDrag | null) => {
    dragRef.current = next
    setDragState(next)
  }

  const locate = (clientY: number): number => {
    const list = listRef.current
    if (!list) return ordered.length
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.insp-layer'))
    for (let index = 0; index < rows.length; index += 1) {
      const rect = rows[index].getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return index
    }
    return rows.length
  }

  const commitOrder = (from: number, insertAt: number) => {
    const target = moveTargetIndex(from, insertAt)
    if (target === from) return
    const next = moveWithin(ordered, from, insertAt)
    const total = next.length
    slideOps.update(
      slide.id,
      (draft) => {
        next.forEach((block, index) => {
          const item = draft.blocks.find((candidate) => candidate.id === block.id)
          if (item) item.z = total - index
        })
      },
      'reorder-layers',
    )
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('.insp-layer__act, .insp-layer__rename')) return
    // 阈值过了才捕获指针，否则双击重命名会被整行吞掉。
    setDrag({ from: index, to: index, active: false, pointerId: event.pointerId, startY: event.clientY })
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragRef.current
    if (!state || state.pointerId !== event.pointerId) return
    if (!state.active && Math.abs(event.clientY - state.startY) < 4) return
    if (!state.active) event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ ...state, active: true, to: locate(event.clientY) })
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragRef.current
    if (!state || state.pointerId !== event.pointerId) return
    setDrag(null)
    if (state.active) {
      suppressClick.current = true
      commitOrder(state.from, state.to)
    }
  }

  const commitRename = () => {
    if (!renaming) return
    const value = renaming.value.trim()
    setRenaming(null)
    blockOps.setName(renaming.id, value)
  }

  if (ordered.length === 0) {
    return <div className="panel__empty">{t('editor.inspector.noLayers')}</div>
  }

  return (
    <Section
      title={t('editor.inspector.tabs.layers')}
      actions={<span className="insp-char">{t('editor.inspector.layerCount', { count: ordered.length })}</span>}
    >
      <div ref={listRef} role="listbox" aria-label={t('editor.inspector.tabs.layers')}>
        {ordered.map((block, index) => {
          const active = selectedIds.includes(block.id)
          const dragging = drag?.active === true && drag.from === index
          return (
            <div
              key={block.id}
              role="option"
              aria-selected={active}
              tabIndex={0}
              className={['insp-layer', active ? 'insp-layer--active' : '', dragging ? 'insp-layer--dragging' : '']
                .filter(Boolean)
                .join(' ')}
              onPointerDown={(event) => handlePointerDown(event, index)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => setDrag(null)}
              onClick={(event) => {
                if (suppressClick.current) {
                  suppressClick.current = false
                  return
                }
                toggleSelection(block.id, event.metaKey || event.ctrlKey || event.shiftKey)
              }}
              onDoubleClick={() => setRenaming({ id: block.id, value: block.name ?? blockLabelOf(block, t) })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  toggleSelection(block.id, event.metaKey || event.ctrlKey)
                }
                if (event.key === 'F2') {
                  event.preventDefault()
                  setRenaming({ id: block.id, value: block.name ?? blockLabelOf(block, t) })
                }
              }}
            >
              <span className="insp-layer__grip">
                <GripVertical size={12} />
              </span>
              {renaming?.id === block.id ? (
                <input
                  className="insp-layer__rename"
                  value={renaming.value}
                  autoFocus
                  aria-label={t('editor.inspector.renameLayer')}
                  onFocus={(event) => event.currentTarget.select()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onChange={(event) => setRenaming({ id: block.id, value: event.target.value })}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitRename()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setRenaming(null)
                    }
                    event.stopPropagation()
                  }}
                />
              ) : (
                <span className="insp-layer__name" title={blockLabelOf(block, t)}>
                  {blockLabelOf(block, t)}
                </span>
              )}
              <span className="insp-layer__type">{block.type}</span>
              <button
                type="button"
                className="insp-layer__act"
                aria-label={block.hidden ? t('editor.stage.show') : t('editor.stage.hide')}
                title={block.hidden ? t('editor.stage.show') : t('editor.stage.hide')}
                onClick={(event) => {
                  event.stopPropagation()
                  blockOps.setFlag([block.id], 'hidden')
                }}
              >
                {block.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
              <button
                type="button"
                className="insp-layer__act"
                aria-label={block.locked ? t('editor.stage.unlock') : t('editor.stage.lock')}
                title={block.locked ? t('editor.stage.unlock') : t('editor.stage.lock')}
                onClick={(event) => {
                  event.stopPropagation()
                  blockOps.setFlag([block.id], 'locked')
                }}
              >
                {block.locked ? <Lock size={13} /> : <Unlock size={13} />}
              </button>
            </div>
          )
        })}
      </div>
    </Section>
  )
}
