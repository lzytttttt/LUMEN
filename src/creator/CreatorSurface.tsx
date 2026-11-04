/**
 * creator/CreatorSurface.tsx —— 创造面板的**重量级**实现（懒加载入口，见 CreatorHost）。
 *
 * 只有面板真正打开时才加载：store、AI 管线、templates、publish、trial、UI、CSS。
 * 职责：把轻量 panelState 与重量级 store 对齐、写 `html[data-lumen-creator="1"]`、
 * Esc 关闭、焦点归还、面板宽度拖拽（360–560，步进 8）。
 */
import { useEffect, useRef, useState } from 'react'
import { closeCreator, CREATOR_OPEN_EVENT, openCreator } from './bridge'
import {
  forceCloseCreator,
  registerCreatorPanelHandlers,
  useCreatorPanelStore,
} from './panelState'
import { useCreatorStore, useCreatorSettings } from './store'
import { clampPanelWidth, CREATOR_PANEL_STEP, patchCreatorSettings } from './settings'
import { creatorStateAttrs } from './state'
import { CreatorPanel } from './CreatorPanel'
import './creator.css'

function isTrialStatus(status: string): boolean {
  return status === 'trialing' || status === 'applied'
}

export function CreatorSurface() {
  const machine = useCreatorStore((state) => state.machine)
  const panelOpen = useCreatorStore((state) => state.panelOpen)
  const cancel = useCreatorStore((state) => state.cancel)
  const restore = useCreatorStore((state) => state.restore)
  const settings = useCreatorSettings()
  const [width, setWidth] = useState(() => clampPanelWidth(settings.panelWidth))
  const widthRef = useRef(width)
  widthRef.current = width
  const returnFocus = useRef<HTMLElement | null>(null)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  // 挂载：对齐 store 与轻量 panelState；注册 close/open 处理器（bridge 用）。
  useEffect(() => {
    if (typeof document !== 'undefined') {
      const active = document.activeElement
      returnFocus.current = active instanceof HTMLElement ? active : null
      document.documentElement.dataset.lumenCreator = '1'
    }
    const panel = useCreatorPanelStore.getState()
    void restore()
    const store = useCreatorStore.getState()
    if (!store.panelOpen) {
      const template = store.machine.status === 'idle' ? panel.template : null
      store.open(panel.entry, template)
    }
    registerCreatorPanelHandlers({
      openHandler: (entry, template) => useCreatorStore.getState().open(entry, template),
      closeHandler: () => {
        useCreatorStore.getState().close()
        forceCloseCreator()
      },
    })
    return () => {
      registerCreatorPanelHandlers(null)
    }
  }, [restore])

  // store.panelOpen 变 false（面板内按钮/Esc）→ 卸载轻量外壳。
  // 注意首次渲染时 panelOpen 仍是 false（mount 副作用里才 open），用 opened 标记区分。
  const opened = useRef(false)
  useEffect(() => {
    if (panelOpen) {
      opened.current = true
      return
    }
    if (opened.current) forceCloseCreator()
  }, [panelOpen])

  // 卸载：清 DOM 标记 + 焦点还给触发元素。
  useEffect(() => {
    return () => {
      if (typeof document !== 'undefined') {
        delete document.documentElement.dataset.lumenCreator
        const target = returnFocus.current
        returnFocus.current = null
        if (target && document.contains(target)) {
          window.setTimeout(() => target.focus({ preventScroll: true }), 0)
        }
      }
    }
  }, [])

  // 外部「请求打开」事件：面板已开时只更新来源/模板，不再递归打开。
  useEffect(() => {
    const onOpen = (event: Event) => {
      if (useCreatorStore.getState().panelOpen) return
      const detail = (event as CustomEvent<{ source?: string; templateId?: string }>).detail
      openCreator((detail?.source ?? 'palette') as Parameters<typeof openCreator>[0], detail?.templateId ?? null)
    }
    window.addEventListener(CREATOR_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(CREATOR_OPEN_EVENT, onOpen)
  }, [])

  useEffect(() => {
    setWidth(clampPanelWidth(settings.panelWidth))
  }, [settings.panelWidth])

  // Esc 一级：生成中先取消，否则关闭面板（有试跑先停用再关，04 §10）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const busy = useCreatorStore.getState().machine.status === 'reading' ||
        useCreatorStore.getState().machine.status === 'proposing'
      if (busy) {
        event.preventDefault()
        event.stopPropagation()
        void cancel()
        return
      }
      event.preventDefault()
      closeCreator()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel])

  // 拖宽：pointer 事件在 window 上收尾，避免指针移出后卡住。
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const current = drag.current
      if (!current) return
      const delta = current.startX - event.clientX
      setWidth(clampPanelWidth(current.startWidth + delta))
    }
    const onUp = () => {
      if (!drag.current) return
      drag.current = null
      patchCreatorSettings({ panelWidth: widthRef.current })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  return (
    <aside
      className="creator-panel"
      role="complementary"
      aria-label="Creator"
      style={{ width }}
      data-creator-panel=""
      data-creator-source={machine.entry ?? 'topbar'}
      data-creator-trial={isTrialStatus(machine.status) ? '1' : undefined}
      {...creatorStateAttrs(machine)}
    >
      <button
        type="button"
        className="creator-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize creator panel"
        aria-valuemin={360}
        aria-valuemax={560}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={(event) => {
          drag.current = { startX: event.clientX, startWidth: width }
          ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            const next = clampPanelWidth(width + CREATOR_PANEL_STEP)
            setWidth(next)
            patchCreatorSettings({ panelWidth: next })
          } else if (event.key === 'ArrowRight') {
            const next = clampPanelWidth(width - CREATOR_PANEL_STEP)
            setWidth(next)
            patchCreatorSettings({ panelWidth: next })
          } else if (event.key === 'Home') {
            setWidth(360)
            patchCreatorSettings({ panelWidth: 360 })
          } else if (event.key === 'End') {
            setWidth(560)
            patchCreatorSettings({ panelWidth: 560 })
          }
        }}
      />
      <CreatorPanel panelWidth={width} />
    </aside>
  )
}

export default CreatorSurface
