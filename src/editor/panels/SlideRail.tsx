/**
 * SlideRail.tsx —— 左侧幕栏（缩略图 / 拖拽排序 / 右键菜单 / 双击重命名 / 虚拟滚动）。
 *
 * 性能约定：
 * - 缩略图是真实渲染（`SlideRenderer mode="thumb"`，不初始化 WebGL、不跑动效）；
 * - 幕数 > VIRTUAL_THRESHOLD 时只渲染可视区（含 overscan）内的缩略图，滚动时用骨架占位；
 * - 拖拽只用一个插入指示线，落点用 DOM 实测矩形计算，不依赖估算。
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ChevronDown, ChevronUp, Copy, Pencil, Plus, StickyNote, Trash2 } from 'lucide-react'
import type { Slide } from '@/schema/deck'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { useSelectionStore } from '@/state/selectionStore'
import { slideOps } from '@/state/ops'
import { activeSlideIdOf } from '@/state/selectors'
import { useT } from '@/i18n'
import { SlideRenderer } from '@/render/SlideRenderer'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { inVisibleRange, moveTargetIndex, visibleRange } from './virtual'
import './panels.css'

const BASE_SCALE = 0.085
const MIN_SCALE = 0.05
const MAX_SCALE = 0.15
const PADDING = 10
const GAP = 8
const META_H = 19
const ITEM_PAD = 10
const ROW_EXTRA = META_H + ITEM_PAD + GAP
const VIRTUAL_THRESHOLD = 24

interface DragState {
  from: number
  to: number
  top: number
  active: boolean
  pointerId: number
  startY: number
}

interface RenameState {
  id: string
  value: string
}

export function SlideRail() {
  const t = useT()
  const deck = useDeckStore((s) => s.deck)
  const requestedActive = useUiStore((s) => s.activeSlideId)
  const setActiveSlide = useUiStore((s) => s.setActiveSlide)
  const pushToast = useUiStore((s) => s.pushToast)
  const clearSelection = useSelectionStore((s) => s.clearSelection)

  const listRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [scale, setScale] = useState(BASE_SCALE)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)
  const [drag, setDragState] = useState<DragState | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; slideId: string } | null>(null)
  const [renaming, setRenaming] = useState<RenameState | null>(null)

  const setDrag = (next: DragState | null) => {
    dragRef.current = next
    setDragState(next)
  }

  // 依据幕栏可用宽度决定缩略图缩放（基准 0.085，实际贴合容器，范围 0.05–0.15）。
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const measure = () => {
      const inner = el.clientWidth - PADDING * 2 - 15 - GAP - ITEM_PAD - 2
      setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, inner / 1600)))
      setViewportH(el.clientHeight)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const slides: Slide[] = deck?.slides ?? []
  const activeId = activeSlideIdOf(deck, requestedActive)
  const itemHeight = 900 * scale + ROW_EXTRA
  const virtualized = slides.length > VIRTUAL_THRESHOLD
  const range = virtualized
    ? visibleRange(slides.length, scrollTop, itemHeight, viewportH, 2, PADDING)
    : { start: 0, end: slides.length - 1 }

  const selectSlide = (slide: Slide) => {
    setActiveSlide(slide.id)
    clearSelection()
    setRenaming(null)
  }

  const startRename = (slide: Slide, index: number) => {
    setRenaming({ id: slide.id, value: slide.name ?? `${t('common.label.page')} ${index + 1}` })
  }

  const commitRename = () => {
    if (!renaming) return
    const next = renaming.value.trim()
    setRenaming(null)
    const current = slides.find((s) => s.id === renaming.id)
    if (!current) return
    if ((current.name ?? '') === next) return
    slideOps.update(renaming.id, (slide) => {
      slide.name = next === '' ? undefined : next.slice(0, 120)
    }, 'slide-name')
    pushToast({ kind: 'success', message: t('editor.toast.renamed') })
  }

  const locateInsertion = (clientY: number): { to: number; top: number } => {
    const list = listRef.current
    if (!list) return { to: slides.length, top: PADDING }
    const items = Array.from(list.querySelectorAll<HTMLElement>('.rail__item'))
    if (items.length === 0) return { to: 0, top: PADDING }
    for (let index = 0; index < items.length; index += 1) {
      const rect = items[index].getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) {
        return { to: index, top: Math.max(PADDING, items[index].offsetTop - 4) }
      }
    }
    const last = items[items.length - 1]
    return { to: items.length, top: last.offsetTop + last.offsetHeight + 4 }
  }

  const autoScroll = (clientY: number) => {
    const list = listRef.current
    if (!list) return
    const rect = list.getBoundingClientRect()
    if (clientY < rect.top + 28) list.scrollTop -= 14
    else if (clientY > rect.bottom - 28) list.scrollTop += 14
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('.rail__rename')) return
    // 不在这里 setPointerCapture：捕获会把后续 click/dblclick 重定向到整行，
    // 导致幕名双击重命名失效。等真正越过拖拽阈值时再捕获。
    setDrag({ from: index, to: index, top: PADDING, active: false, pointerId: event.pointerId, startY: event.clientY })
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragRef.current
    if (!state || state.pointerId !== event.pointerId) return
    if (!state.active && Math.abs(event.clientY - state.startY) < 5) return
    if (!state.active) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    autoScroll(event.clientY)
    const { to, top } = locateInsertion(event.clientY)
    setDrag({ ...state, active: true, to, top })
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragRef.current
    if (!state || state.pointerId !== event.pointerId) return
    setDrag(null)
    if (!state.active) {
      const slide = slides[state.from]
      if (slide) selectSlide(slide)
      return
    }
    const target = moveTargetIndex(state.from, state.to)
    if (target === state.from || target < 0 || target >= slides.length) return
    slideOps.move(state.from, target)
    pushToast({ kind: 'info', message: t('editor.toast.slideMoved') })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, slide: Slide, index: number) => {
    const meta = event.metaKey || event.ctrlKey
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      selectSlide(slide)
      return
    }
    if (event.key === 'F2') {
      event.preventDefault()
      startRename(slide, index)
      return
    }
    if (meta && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      slideOps.duplicate(slide.id)
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (slides.length <= 1) return
      event.preventDefault()
      slideOps.remove(slide.id)
      pushToast({ kind: 'info', message: t('editor.toast.slideDeleted') })
    }
  }

  const menuIndex = menu ? slides.findIndex((s) => s.id === menu.slideId) : -1
  const menuSlide = menuIndex >= 0 ? slides[menuIndex] : undefined
  const menuItems: MenuItem[] =
    menuSlide && menu
      ? [
          {
            id: 'add',
            label: t('editor.rail.contextAddAfter'),
            icon: <Plus size={13} />,
            onSelect: () => slideOps.add({ at: menuIndex + 1 }),
          },
          {
            id: 'duplicate',
            label: t('editor.rail.duplicateSlide'),
            icon: <Copy size={13} />,
            onSelect: () => slideOps.duplicate(menuSlide.id),
          },
          {
            id: 'rename',
            label: t('common.action.rename'),
            icon: <Pencil size={13} />,
            onSelect: () => startRename(menuSlide, menuIndex),
          },
          {
            id: 'up',
            label: t('editor.rail.moveUp'),
            icon: <ChevronUp size={13} />,
            disabled: menuIndex === 0,
            separatorBefore: true,
            onSelect: () => slideOps.move(menuIndex, menuIndex - 1),
          },
          {
            id: 'down',
            label: t('editor.rail.moveDown'),
            icon: <ChevronDown size={13} />,
            disabled: menuIndex === slides.length - 1,
            onSelect: () => slideOps.move(menuIndex, menuIndex + 1),
          },
          {
            id: 'delete',
            label: t('editor.rail.deleteSlide'),
            icon: <Trash2 size={13} />,
            danger: true,
            disabled: slides.length <= 1,
            separatorBefore: true,
            onSelect: () => {
              slideOps.remove(menuSlide.id)
              pushToast({ kind: 'info', message: t('editor.toast.slideDeleted') })
            },
          },
        ]
      : []

  if (!deck) return <aside className="rail" />

  return (
    <aside className="rail" aria-label={t('editor.rail.slides')}>
      <div className="rail__head">
        <span className="rail__title">{t('editor.rail.slides')}</span>
        <span className="rail__badge">{slides.length}</span>
      </div>

      <div
        className="rail__list lumen-scroll"
        ref={listRef}
        role="listbox"
        aria-label={t('editor.rail.slides')}
        aria-activedescendant={activeId ? `rail-item-${activeId}` : undefined}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {drag?.active ? <div className="rail__drop-line" style={{ top: drag.top }} /> : null}
        {slides.map((slide, index) => {
          const active = slide.id === activeId
          const dragging = drag?.active === true && drag.from === index
          const showThumb = inVisibleRange(index, range)
          const label = slide.name ?? `${t('common.label.page')} ${index + 1}`
          return (
            <div
              key={slide.id}
              id={`rail-item-${slide.id}`}
              role="option"
              aria-selected={active}
              tabIndex={0}
              className={[
                'rail__item',
                active ? 'rail__item--active' : '',
                dragging ? 'rail__item--dragging' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onPointerDown={(event) => handlePointerDown(event, index)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={(event) => handleKeyDown(event, slide, index)}
              onDoubleClick={() => selectSlide(slide)}
              onContextMenu={(event) => {
                event.preventDefault()
                setActiveSlide(slide.id)
                setMenu({ x: event.clientX, y: event.clientY, slideId: slide.id })
              }}
            >
              <span className="rail__index">{String(index + 1).padStart(2, '0')}</span>
              <span className="rail__main">
                <span className="rail__thumb">
                  {showThumb ? (
                    <span
                      className="rail__canvas"
                      aria-hidden="true"
                      style={{
                        width: 1600,
                        height: 900,
                        pointerEvents: 'none',
                        transform: `scale(${scale})`,
                      }}
                    >
                      <SlideRenderer deck={deck} slide={slide} mode="thumb" active={false} />
                    </span>
                  ) : (
                    <span className="rail__thumb-skeleton" aria-hidden="true" />
                  )}
                </span>
                <span className="rail__meta">
                  {renaming?.id === slide.id ? (
                    <input
                      className="rail__rename"
                      value={renaming.value}
                      autoFocus
                      aria-label={t('editor.rail.renameTitle')}
                      onFocus={(event) => event.currentTarget.select()}
                      onPointerDown={(event) => event.stopPropagation()}
                      onChange={(event) => setRenaming({ id: slide.id, value: event.target.value })}
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
                    <span
                      className="rail__name"
                      title={`${label} · ${t('editor.rail.dragHint')}`}
                      onDoubleClick={(event) => {
                        event.stopPropagation()
                        startRename(slide, index)
                      }}
                    >
                      {label}
                    </span>
                  )}
                  {slide.notes ? (
                    <span className="rail__note" title={t('editor.rail.notesBadge')}>
                      <StickyNote size={10} />
                    </span>
                  ) : null}
                </span>
              </span>
            </div>
          )
        })}
      </div>

      <div className="rail__foot">
        <button
          type="button"
          className="rail__add"
          onClick={() => {
            slideOps.add({ at: slides.length })
            pushToast({ kind: 'success', message: t('editor.toast.slideAdded') })
          }}
        >
          <Plus size={13} />
          {t('editor.rail.newSlide')}
        </button>
      </div>

      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />
    </aside>
  )
}
