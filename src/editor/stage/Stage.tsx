/**
 * Stage.tsx —— 舞台外壳：视口适配、缩放/平移、渲染器 + 交互覆盖层、内联改字、拖放、对齐条。
 *
 * 三层结构：
 *   .app-stage           外壳（HUD、对齐条、右键菜单）
 *   .stage-viewport      量尺寸 + 居中 + 裁剪（useElementSize）
 *   .stage-plane         1600×900 缩放后的占位（flex 居中），translate 做平移
 *     .stage-frame       transform: scale()，里面才是真舞台
 * 缩放只在这里做一次，渲染层永远是设计像素。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Grid2x2, Maximize, Minus, Plus } from 'lucide-react'
import { STAGE_H, STAGE_W } from '@/schema/deck'
import { useDeckStore } from '@/state/deckStore'
import { useSelectionStore } from '@/state/selectionStore'
import { useUiStore } from '@/state/uiStore'
import { useActiveSlide } from '@/state/selectors'
import { SlideRenderer } from '@/render/SlideRenderer'
import { useElementSize } from '@/ui/hooks/useElementSize'
import { IconButton } from '@/ui/primitives'
import { useT } from '@/i18n'
import { getTheme, themeCssVars } from '@/themes'
import { blocksFromFiles, blocksFromPlainText, hasAnyDrag } from '@/editor/dnd/blocksFromData'
import { openForge } from '@/forge/ForgeHost'
import {
  alignSelection,
  commitTextEdit,
  distributeSelection,
  insertBlocksAt,
  stopEditingBlock,
} from '@/editor/interactions/commands'
import { isTypingTarget } from '@/editor/shortcuts'
import { StageOverlay } from './StageOverlay'
import { StageAlignBar } from './StageAlignBar'
import { BlockContextMenu } from './BlockContextMenu'
import { InlineTextEditor } from './InlineTextEditor'
import { useStageInteraction } from './useStageInteraction'
import { clamp, type Point } from './geometry'
import './stage.css'

const MIN_ZOOM = 0.1
const MAX_ZOOM = 3

interface MenuState {
  x: number
  y: number
  blockId: string
  count: number
}

export function Stage() {
  const t = useT()
  const deck = useDeckStore((s) => s.deck)
  const slide = useActiveSlide()
  const mode = useUiStore((s) => s.mode)
  const zoom = useUiStore((s) => s.zoom)
  const setZoom = useUiStore((s) => s.setZoom)
  const showGrid = useUiStore((s) => s.showGrid)
  const toggleGrid = useUiStore((s) => s.toggleGrid)
  const snapEnabled = useUiStore((s) => s.snapEnabled)
  const toggleSnap = useUiStore((s) => s.toggleSnap)
  const showGuides = useUiStore((s) => s.showGuides)
  const toggleGuides = useUiStore((s) => s.toggleGuides)

  const selectedIds = useSelectionStore((s) => s.selectedBlockIds)
  const hoveredId = useSelectionStore((s) => s.hoveredBlockId)
  const editingId = useSelectionStore((s) => s.editingBlockId)
  const clearSelection = useSelectionStore((s) => s.clearSelection)

  const [viewportRef, size] = useElementSize<HTMLDivElement>()
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })
  const panRef = useRef(pan)
  panRef.current = pan
  const [spaceHeld, setSpaceHeld] = useState(false)
  const spaceRef = useRef(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const dragDepthRef = useRef(0)

  // 适配缩放：min(w/1600, h/900)，再夹到 0.1–3
  const fit = size.width > 0 && size.height > 0 ? Math.min(size.width / STAGE_W, size.height / STAGE_H) : 0.5
  const scale = clamp(zoom === 'fit' ? fit : zoom, MIN_ZOOM, MAX_ZOOM)
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  const theme = getTheme(deck?.themeId)
  const vars = useMemo(
    () => themeCssVars(theme, deck?.themeOverrides) as Record<string, string>,
    [theme, deck?.themeOverrides],
  )

  const interaction = useStageInteraction({
    frameRef,
    getPan: () => panRef.current,
    setPan: (next) => setPan(next),
    isPanModifier: () => spaceRef.current,
    onContextMenu: ({ client, block }) => {
      if (!block) {
        setMenu(null)
        return
      }
      const count = useSelectionStore.getState().selectedBlockIds.length
      setMenu({ x: client.x, y: client.y, blockId: block.id, count })
    },
  })

  /* ----------------------------- 空格平移态 ----------------------------- */

  useEffect(() => {
    const onDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return
      if (isTypingTarget(event.target)) return
      spaceRef.current = true
      setSpaceHeld(true)
      event.preventDefault()
    }
    const onUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return
      spaceRef.current = false
      setSpaceHeld(false)
    }
    const onBlur = () => {
      spaceRef.current = false
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  /* ---------------------- Ctrl/Cmd + 滚轮缩放（鼠标为锚） ---------------------- */

  const anchorRef = useRef<{ stage: Point; client: Point } | null>(null)

  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const frame = frameRef.current
      if (!frame) return
      const rect = frame.getBoundingClientRect()
      if (rect.width <= 0) return
      const currentScale = rect.width / STAGE_W
      const stage: Point = {
        x: (event.clientX - rect.left) / currentScale,
        y: (event.clientY - rect.top) / currentScale,
      }
      anchorRef.current = { stage, client: { x: event.clientX, y: event.clientY } }
      const factor = Math.exp(-event.deltaY * 0.0016)
      const next = clamp(Math.round(currentScale * factor * 1000) / 1000, MIN_ZOOM, MAX_ZOOM)
      if (Math.abs(next - currentScale) > 0.0005) setZoom(next)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [setZoom, viewportRef])

  // 缩放后把锚点拉回鼠标位置（布局已更新，量一次真实 rect）
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const node = frameRef.current
    if (!anchor || !node) return
    anchorRef.current = null
    const rect = node.getBoundingClientRect()
    const currentScale = rect.width / STAGE_W
    if (currentScale <= 0) return
    const dx = anchor.client.x - anchor.stage.x * currentScale - rect.left
    const dy = anchor.client.y - anchor.stage.y * currentScale - rect.top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }))
  }, [scale])

  /* -------------------------------- 拖放 -------------------------------- */

  const stagePointFromClient = useCallback((clientX: number, clientY: number): Point => {
    const node = frameRef.current
    if (!node) return { x: STAGE_W / 2, y: STAGE_H / 2 }
    const rect = node.getBoundingClientRect()
    const currentScale = rect.width / STAGE_W || 1
    return { x: (clientX - rect.left) / currentScale, y: (clientY - rect.top) / currentScale }
  }, [])

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      const point = stagePointFromClient(event.clientX, event.clientY)
      const files = Array.from(event.dataTransfer?.files ?? [])
      let outcome = files.length > 0 ? await blocksFromFiles(files) : null
      if (!outcome || outcome.blocks.length === 0) {
        const fallback = blocksFromPlainText(event.dataTransfer?.getData('text/plain') ?? '')
        if (fallback.blocks.length > 0) outcome = fallback
      }
      if (!outcome || outcome.blocks.length === 0) {
        const message = outcome?.issues[0] ?? t('editor.toast.pasteFailed')
        useUiStore.getState().pushToast({ kind: 'error', message })
        return
      }
      insertBlocksAt(outcome.blocks, { point })
      if (outcome.issues.length > 0) {
        useUiStore.getState().pushToast({ kind: 'info', message: outcome.issues[0] })
      }
    },
    [stagePointFromClient, t],
  )

  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasAnyDrag(event.dataTransfer)) return
    dragDepthRef.current += 1
    setDropActive(true)
  }, [])

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasAnyDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasAnyDrag(event.dataTransfer)) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDropActive(false)
  }, [])

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasAnyDrag(event.dataTransfer)) return
      event.preventDefault()
      dragDepthRef.current = 0
      setDropActive(false)
      void handleDrop(event)
    },
    [handleDrop],
  )

  /* ------------------------------- 渲染 ------------------------------- */

  if (!deck || !slide) {
    return <div className="app-stage" />
  }

  const editingBlock =
    editingId ? slide.blocks.find((block) => block.id === editingId && block.type === 'text') : undefined
  const menuBlock = menu ? slide.blocks.find((block) => block.id === menu.blockId) : undefined
  const cursor = spaceHeld ? 'grab' : interaction.ghost.cursor

  const onViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    stopEditingBlock()
    clearSelection()
    setMenu(null)
  }

  const planeStyle: CSSProperties = {
    width: STAGE_W * scale,
    height: STAGE_H * scale,
    transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
  }

  // 帧上同时挂主题令牌（空幕提示、内联改字用）与 --px（=1/scale，交互层像素补偿）
  const frameStyle: CSSProperties = {
    transform: `scale(${scale})`,
    ...(vars as unknown as CSSProperties),
    ...({ '--px': `${1 / Math.max(scale, 0.01)}px` } as unknown as CSSProperties),
  }

  return (
    <div
      className="app-stage"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="stage-viewport" ref={viewportRef} onPointerDown={onViewportPointerDown}>
        <div className="stage-plane" style={planeStyle}>
          <div className="stage-frame" ref={frameRef} style={frameStyle}>
            <SlideRenderer
              deck={deck}
              slide={slide}
              mode={mode === 'preview' ? 'play' : 'stage'}
              active
              editingBlockId={editingId}
            />

            {slide.blocks.length === 0 ? (
              <div className="stage-empty">
                <strong>{t('editor.stage.emptyTitle')}</strong>
                <span>{t('editor.stage.emptyHint')}</span>
                <button type="button" className="stage-empty__cta" data-act="forge" onClick={() => openForge('empty')}>
                  {t('forge.entry')}
                </button>
              </div>
            ) : null}

            <div
              className="stage-surface"
              style={{ cursor }}
              onPointerDown={interaction.onSurfacePointerDown}
              onPointerMove={interaction.onSurfacePointerMove}
              onPointerUp={interaction.onSurfacePointerUp}
              onPointerCancel={interaction.onSurfacePointerCancel}
              onDoubleClick={interaction.onSurfaceDoubleClick}
              onContextMenu={interaction.onSurfaceContextMenu}
              onPointerLeave={interaction.onSurfacePointerLeave}
            />

            <StageOverlay
              slide={slide}
              scale={scale}
              selectedIds={selectedIds}
              hoveredId={hoveredId}
              editingId={editingId}
              ghost={interaction.ghost}
              showGrid={showGrid}
              showGuides={showGuides}
              onHandlePointerDown={interaction.onHandlePointerDown}
            />

            {editingBlock && editingBlock.type === 'text' ? (
              <InlineTextEditor
                key={editingBlock.id}
                block={editingBlock}
                vars={vars}
                placeholder={t('editor.stage.emptyText')}
                onCommit={(text) => commitTextEdit(editingBlock.id, text)}
                onCancel={stopEditingBlock}
              />
            ) : null}

            {dropActive ? (
              <div className="stage-drop">
                <span>{t('editor.stage.dropHere')}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <StageAlignBar
        count={selectedIds.length}
        onAlign={(alignMode) => void alignSelection(alignMode)}
        onDistribute={(axis) => void distributeSelection(axis)}
      />

      <div className="stage-hud">
        <IconButton
          icon={<Minus size={13} />}
          size="sm"
          label={t('editor.topbar.zoomOut')}
          onClick={() => setZoom(clamp(Number((scale - 0.1).toFixed(2)), MIN_ZOOM, MAX_ZOOM))}
        />
        <span className="stage-hud__zoom">{Math.round(scale * 100)}%</span>
        <IconButton
          icon={<Plus size={13} />}
          size="sm"
          label={t('editor.topbar.zoomIn')}
          onClick={() => setZoom(clamp(Number((scale + 0.1).toFixed(2)), MIN_ZOOM, MAX_ZOOM))}
        />
        <IconButton
          icon={<Maximize size={13} />}
          size="sm"
          label={t('editor.topbar.fit')}
          onClick={() => setZoom('fit')}
        />
        <span className="stage-hud__sep" />
        <IconButton
          icon={<Grid2x2 size={13} />}
          size="sm"
          active={showGrid}
          label={t('editor.stage.grid')}
          onClick={toggleGrid}
        />
        <button
          type="button"
          className="stage-hud__toggle"
          data-on={snapEnabled ? 'true' : 'false'}
          aria-pressed={snapEnabled}
          onClick={toggleSnap}
        >
          {t('editor.stage.snap')}
        </button>
        <button
          type="button"
          className="stage-hud__toggle"
          data-on={showGuides ? 'true' : 'false'}
          aria-pressed={showGuides}
          onClick={toggleGuides}
        >
          {t('editor.stage.guides')}
        </button>
      </div>

      {menu && menuBlock ? (
        <BlockContextMenu
          x={menu.x}
          y={menu.y}
          block={menuBlock}
          count={menu.count}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}
