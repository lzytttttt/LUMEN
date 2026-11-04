/**
 * plugins/host/SlotHost.tsx —— 9 个插槽的宿主渲染（02 §6.10 / §6.11；06 §3.1 的 data-* 钩子）。
 *
 * | 插槽 | 形态 | 本文件组件 |
 * |---|---|---|
 * | workspace.topbar | inline（宿主渲染，无帧） | `TopbarSlot` |
 * | workspace.rail.footer | inline（宿主渲染，无帧） | `RailFooterSlot` |
 * | workspace.inspector.tab | panel（iframe，首次点开时懒挂） | `InspectorTabSlot` / `SlotView` |
 * | workspace.dock | panel（iframe，高 240–400 可拖） | `DockHost` |
 * | workspace.overlay | overlay（iframe，安全区，编辑态） | `StageOverlaySlot` |
 * | dialog | modal（iframe，打开时创建、关闭即销毁） | `DialogHost` |
 * | settings.page | panel（声明式原生渲染或 iframe） | `SettingsSection` |
 * | play.overlay | overlay（iframe，仅 mode==='play'） | `PlayOverlaySlot` |
 * | command.palette | 宿主渲染（声明式数据，无帧） | （命令面板数据走 runtime.getCommands） |
 *
 * 每个插槽独立 `ErrorBoundary`（D-40-18：崩溃只让该插槽降级，工作台照常）。
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { getRegisteredSlots, contributionRevision, subscribeContributions } from '../contributionBus'
import { getDeclarativeSettingsEntries, getPluginSettingValues, patchPluginSettingValue } from '../declarative'
import { disablePlugin, retryPlugin, getRecord } from '../registry'
import { useUiStore } from '@/state/uiStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useT } from '@/i18n'
import type { PluginSettingsEntry, PluginSlotItem, SettingsField, SlotId } from '../types'
import { codeSettingsEntries } from '../api/settings'
import {
  FrameSlotView,
  destroyFrame,
  ensureFrame,
  frameForItem,
  framesForSlot,
  retryFrame,
  subscribeFrames,
  useFrames,
  type FrameViewState,
} from './PluginHost'
import { getFrameUiSnapshot, openFrameDialog, openFramePanel, subscribeFrameUi } from './frameUi'

/* ------------------------------ 订阅 hooks ------------------------------ */

function useContributionRevision(): number {
  return useSyncExternalStore(subscribeContributions, contributionRevision, contributionRevision)
}

/** 某插槽的贡献（只读 bus，按 order 排序）。 */
export function useSlotItems(slot: SlotId): PluginSlotItem[] {
  const revision = useContributionRevision()
  void revision
  return useMemo(() => getRegisteredSlots(slot), [slot, revision])
}

function useFrameUi() {
  return useSyncExternalStore(subscribeFrameUi, getFrameUiSnapshot, getFrameUiSnapshot)
}

/* ------------------------------ 错误边界 ------------------------------ */

interface SlotBoundaryState {
  error: Error | null
}

/** 每个插槽独立 ErrorBoundary：错误卡「重试 / 停用 / 看日志」（00 D-40-18）。 */
export class SlotErrorBoundary extends Component<{ pluginId?: string; slot: SlotId; children: ReactNode }, SlotBoundaryState> {
  state: SlotBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): SlotBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error): void {
    if (typeof console !== 'undefined') console.warn(`[plugins] slot ${this.props.slot} crashed`, error)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <SlotErrorCard
        pluginId={this.props.pluginId}
        slot={this.props.slot}
        code="E-RUN-01"
        message={this.state.error.message}
        onRetry={() => this.setState({ error: null })}
      />
    )
  }
}

/** 错误卡（iframe 启动失败 / 心跳丢失 / 插槽渲染崩溃共用）。 */
export function SlotErrorCard(props: {
  pluginId?: string
  slot: SlotId
  code: string
  message?: string | null
  onRetry: () => void
}) {
  const t = useT()
  const { pluginId, code, message } = props
  void props.slot
  const reason = message ? t('plugin.errorCard.reason' as never, { reason: message } as never) : t('plugin.errorCard.title' as never)
  return (
    <div
      className="plugin-error-card"
      data-plugin-error-card=""
      data-plugin-id={pluginId}
      data-plugin-state={pluginStateOfView(pluginId)}
      data-plugin-frame-state="error"
      data-plugin-error={code}
      role="alert"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        margin: 8,
        border: '1px solid var(--ui-line-strong)',
        borderRadius: 'var(--ui-radius-sm)',
        background: 'var(--ui-panel-2)',
        color: 'var(--ui-fg-dim)',
        fontSize: 12,
      }}
    >
      <strong style={{ color: 'var(--ui-fg)' }}>{t('plugin.errorCard.title' as never)}</strong>
      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{reason}</span>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="lumen-button" data-plugin-action="retry" onClick={props.onRetry}>
          {t('plugin.errorCard.retry' as never)}
        </button>
        {pluginId ? (
          <button
            type="button"
            className="lumen-button"
            data-plugin-action="disable"
            onClick={() => {
              void disablePlugin(pluginId).catch(() => undefined)
            }}
          >
            {t('plugin.errorCard.disable' as never)}
          </button>
        ) : null}
        <button
          type="button"
          className="lumen-button"
          data-plugin-action="logs"
          onClick={() => {
            if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('lumen:open-plugin-manager', { detail: { tab: 'audit' } }))
          }}
        >
          {t('plugin.errorCard.logs' as never)}
        </button>
      </div>
    </div>
  )
}

/** 错误卡的 `data-plugin-state`：登记态（草稿 → draft）。 */
function pluginStateOfView(pluginId?: string): string {
  if (!pluginId) return 'installed'
  if (pluginId.startsWith('draft/')) return 'draft'
  return getRecord(pluginId)?.state ?? 'installed'
}

/* ------------------------------ 帧条目 ------------------------------ */

/** 一个插槽贡献的懒挂帧（首次可见时创建；错误卡替代 iframe）。 */
function SlotFrameItem({ item, slot, fill }: { item: PluginSlotItem; slot: SlotId; fill?: boolean }) {
  const frames = useFrames()
  const current = frames.find((frame) => frame.pluginId === item.pluginId && frame.contributionId === localIdOf(item) && frame.slot === slot)
  const errorView = frames.find((frame) => frame.pluginId === item.pluginId && frame.slot === slot && frame.status === 'error')

  useEffect(() => {
    if (current || errorView) return
    ensureFrame({ pluginId: item.pluginId, slot, contributionId: localIdOf(item), title: item.title.zh || item.title.en })
  }, [item, slot, current, errorView])

  if (errorView) {
    const pluginState = pluginStateOfView(item.pluginId)
    return (
      <SlotErrorCard
        pluginId={item.pluginId}
        slot={slot}
        code={errorView.errorCode ?? 'E-HOST-02'}
        message={errorView.errorMessage}
        onRetry={() => {
          if (pluginState === 'quarantined') {
            // 02 §3.5：quarantined 的用户「重试」才清零 failureCount（registry.retryPlugin）。
            void retryPlugin(item.pluginId)
              .catch(() => undefined)
              .finally(() => {
                retryFrame(errorView.frameId)
              })
            return
          }
          // enabled/installed 态的错误卡「重试」只重建帧，**不清零** registry 的连续失败计数，
          // 否则永远到不了第 3 次 quarantine（E-40-10/10b）。
          retryFrame(errorView.frameId)
        }}
      />
    )
  }
  if (!current) return null
  return (
    <div
      className="plugin-frame-slot"
      data-plugin-frame=""
      data-plugin-id={item.pluginId}
      data-plugin-state={current.pluginState}
      data-plugin-frame-state={current.status}
      style={{ width: '100%', height: fill ? '100%' : 240, minHeight: 0 }}
    >
      <FrameSlotView frame={current} style={{ height: '100%' }} />
    </div>
  )
}

function localIdOf(item: PluginSlotItem): string {
  return item.id.startsWith(`${item.pluginId}:`) ? item.id.slice(item.pluginId.length + 1) : item.id
}

/** 打开 inline 贡献绑定的面板/弹窗（02 §6.10 inline 槽点击绑定）。 */
function openSlotTarget(item: PluginSlotItem): void {
  const target = item.open
  if (!target) return
  const slot = target.slot
  const localId = target.contributionId
  const title = item.title.zh || item.title.en
  const view = ensureFrame({ pluginId: item.pluginId, slot, contributionId: localId, title })
  if (!view) return
  if (slot === 'dialog') {
    // 与 `lumen.ui.openDialog` 同一条宿主路径：写 FrameUi → DialogHost 渲染 + Esc/焦点语义。
    openFrameDialog({ frameId: view.frameId, pluginId: item.pluginId, contributionId: localId, title, size: 'md' })
  } else if (slot === 'workspace.inspector.tab') {
    useUiStore.getState().setInspectorTab(`plug:${item.pluginId}:${localId}`)
    useUiStore.getState().setMode('edit')
  } else {
    openFramePanel({ frameId: view.frameId, pluginId: item.pluginId, slot, contributionId: localId, title })
  }
}

/* ------------------------------ inline 插槽 ------------------------------ */

function InlineSlotButton({ item }: { item: PluginSlotItem }) {
  const interactive = Boolean(item.open)
  return (
    <button
      type="button"
      className="lumen-button"
      data-slot={item.slot}
      data-plugin-id={item.pluginId}
      data-plugin-slot-item={item.id}
      title={item.title.zh || item.title.en}
      aria-label={item.title.zh || item.title.en}
      onClick={() => openSlotTarget(item)}
      disabled={!interactive}
      style={{
        height: 24,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '0 8px',
        border: '1px solid var(--ui-line)',
        borderRadius: 'var(--ui-radius-xs)',
        background: 'var(--ui-panel-2)',
        color: 'var(--ui-fg-dim)',
        font: 'inherit',
        fontSize: 11.5,
        cursor: interactive ? 'pointer' : 'default',
      }}
    >
      <span aria-hidden="true" style={{ color: 'var(--ui-accent)' }}>
        ✦
      </span>
      <span>{item.title.zh || item.title.en}</span>
    </button>
  )
}

function InlineSlot({ slot }: { slot: SlotId }) {
  const items = useSlotItems(slot)
  if (items.length === 0) return null
  return (
    <div
      data-slot={slot}
      style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}
    >
      {items.map((item) => (
        <SlotErrorBoundary key={item.id} pluginId={item.pluginId} slot={slot}>
          <InlineSlotButton item={item} />
        </SlotErrorBoundary>
      ))}
    </div>
  )
}

export function TopbarSlot() {
  return <InlineSlot slot="workspace.topbar" />
}

export function RailFooterSlot() {
  return <InlineSlot slot="workspace.rail.footer" />
}

/* ------------------------------ inspector.tab ------------------------------ */

export function InspectorTabSlot({ contributionId, title }: { contributionId: string; title?: string }) {
  const items = useSlotItems('workspace.inspector.tab')
  const resolved = resolveItem(items, contributionId)
  if (!resolved) return null
  if (resolved.pluginId.startsWith('draft/') && !getRecord(resolved.pluginId)) {
    // 草稿没有 registry 记录，靠 draft 端口建帧；ensureFrame 内部已分流。
  }
  return (
    <SlotErrorBoundary pluginId={resolved.pluginId} slot="workspace.inspector.tab">
      <div data-slot="workspace.inspector.tab" style={{ height: '100%', minHeight: 0 }}>
        <SlotFrameItem item={resolved} slot="workspace.inspector.tab" fill />
      </div>
      {title ? <span hidden>{title}</span> : null}
    </SlotErrorBoundary>
  )
}

function resolveItem(items: PluginSlotItem[], contributionId: string): PluginSlotItem | undefined {
  const raw = contributionId.startsWith('plug:') ? contributionId.slice(5) : contributionId
  return (
    items.find((item) => item.id === raw) ??
    items.find((item) => localIdOf(item) === raw) ??
    items.find((item) => item.id.endsWith(`:${raw}`))
  )
}

/* ------------------------------ dock ------------------------------ */

export function DockHost() {
  const t = useT()
  const items = useSlotItems('workspace.dock')
  const ui = useUiStore()
  const [collapsed, setCollapsed] = useState(true)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const height = ui.dockHeight || 300

  // 有插件托盘贡献时默认展开一次（「首次展开才懒挂帧」；安装后用户能直接看到内容）。
  useEffect(() => {
    if (items.length > 0) setCollapsed(false)
  }, [items.length])

  useEffect(() => {
    if (items.length === 0) return
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const next = Math.round(drag.startHeight + (drag.startY - event.clientY))
      ui.setDockHeight(next)
    }
    const onPointerUp = () => {
      dragRef.current = null
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [items.length, ui])

  if (items.length === 0) return null
  return (
    <section
      className="plugin-dock"
      data-slot="workspace.dock"
      data-plugin-dock=""
      data-dock-collapsed={collapsed ? '1' : '0'}
      style={{
        borderTop: '1px solid var(--ui-line)',
        background: 'var(--ui-bg-2)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 30,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={t(collapsed ? ('plugin.dock.expand' as never) : ('plugin.dock.collapse' as never))}
        data-plugin-action="toggle-dock"
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setCollapsed((value) => !value)
          }
        }}
        onClick={() => setCollapsed((value) => !value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 28,
          padding: '0 10px',
          cursor: 'pointer',
          color: 'var(--ui-fg-mute)',
          fontSize: 11.5,
          userSelect: 'none',
        }}
      >
        <span aria-hidden="true">{collapsed ? '▴' : '▾'}</span>
        <span>{t("plugin.dock.title" as never)}</span>
        <span style={{ marginLeft: 'auto' }}>{items.map((item) => item.title.zh || item.title.en).join(' · ')}</span>
      </div>
      {collapsed ? null : (
        <div style={{ height }}>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-valuemin={240}
            aria-valuemax={400}
            aria-valuenow={height}
            aria-label={t('plugin.dock.resize' as never)}
            data-plugin-action="resize-dock"
            onPointerDown={(event) => {
              dragRef.current = { startY: event.clientY, startHeight: height }
            }}
            style={{ height: 4, cursor: 'row-resize', background: 'var(--ui-line)' }}
          />
          <div style={{ display: 'flex', height: height - 4, minHeight: 0 }}>
            {items.map((item) => (
              <SlotErrorBoundary key={item.id} pluginId={item.pluginId} slot="workspace.dock">
                <SlotFrameItem item={item} slot="workspace.dock" fill />
              </SlotErrorBoundary>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/* ------------------------------ overlay ------------------------------ */

function OverlaySlot({ slot }: { slot: SlotId }) {
  const items = useSlotItems(slot)
  const frames = framesForSlot(slot)
  if (items.length === 0) return null
  return (
    <div
      data-slot={slot}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'stretch',
      }}
    >
      {items.map((item) => {
        const frame = frames.find((candidate) => candidate.pluginId === item.pluginId && candidate.contributionId === localIdOf(item))
        if (!frame) {
          return (
            <div key={item.id} style={{ pointerEvents: 'auto', alignSelf: 'flex-start', margin: 12 }}>
              <SlotFrameItem item={item} slot={slot} fill />
            </div>
          )
        }
        return (
          <div key={item.id} style={{ flex: 1, minWidth: 0, pointerEvents: 'auto', position: 'relative' }}>
            <FrameSlotView frame={frame} />
          </div>
        )
      })}
    </div>
  )
}

/** 画布浮层：只在 `mode==='edit'` 且插件启用时挂载（06 §3.1 `[data-slot="workspace.overlay"]`）。 */
export function StageOverlaySlot() {
  const mode = useUiStore((state) => state.mode)
  const items = useSlotItems('workspace.overlay')
  if (mode !== 'edit' || items.length === 0) return null
  return (
    <SlotErrorBoundary slot="workspace.overlay">
      <OverlaySlot slot="workspace.overlay" />
    </SlotErrorBoundary>
  )
}

/** 播放态浮层：只在 `mode==='play'` 时挂载，退出播放立即销毁（02 §6.11）。 */
export function PlayOverlaySlot() {
  const mode = useUiStore((state) => state.mode)
  const items = useSlotItems('play.overlay')
  const frames = useFrames()

  useEffect(() => {
    if (mode === 'play') return
    for (const frame of frames) if (frame.slot === 'play.overlay') destroyFrame(frame.frameId, 'leave-play')
  }, [mode, frames])

  if (mode !== 'play' || items.length === 0) return null
  return (
    <SlotErrorBoundary slot="play.overlay">
      <div
        data-slot="play.overlay"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'center',
          padding: 16,
        }}
      >
        {items.map((item) => (
          <div key={item.id} style={{ pointerEvents: 'auto', width: '100%', maxWidth: 640, height: 160 }}>
            <SlotFrameItem item={item} slot="play.overlay" fill />
          </div>
        ))}
      </div>
    </SlotErrorBoundary>
  )
}

/* ------------------------------ dialog ------------------------------ */

/** 弹窗宿主：`FrameUiSnapshot.dialogs` 驱动；关闭即销毁帧（02 §6.10）。 */
export function DialogHost() {
  const t = useT()
  const frameUi = useFrameUi()
  const frames = useFrames()
  const dialog = frameUi.dialogs[0]
  const frame = dialog ? frames.find((candidate) => candidate.frameId === dialog.frameId) : undefined

  useEffect(() => {
    if (!dialog) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      destroyFrame(dialog.frameId, 'dialog-escape')
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [dialog])

  if (!dialog) return null
  const size = dialog.size === 'sm' ? 420 : dialog.size === 'lg' ? 860 : 640
  return (
    <div
      className="plugin-dialog-backdrop"
      data-plugin-dialog=""
      data-slot="dialog"
      data-plugin-id={dialog.pluginId}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) destroyFrame(dialog.frameId, 'dialog-backdrop')
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(0,0,0,0.42)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
        style={{
          width: size,
          maxWidth: 'calc(100vw - 48px)',
          height: 'min(72vh, 640px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--ui-panel)',
          border: '1px solid var(--ui-line-strong)',
          borderRadius: 'var(--ui-radius)',
          boxShadow: 'var(--ui-shadow)',
          overflow: 'hidden',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--ui-line)',
            color: 'var(--ui-fg)',
            fontSize: 12.5,
          }}
        >
          <strong>{dialog.title}</strong>
          <button
            type="button"
            className="lumen-iconButton"
            aria-label={t("plugin.slot.dialog" as never)}
            data-plugin-action="close-dialog"
            style={{ marginLeft: 'auto' }}
            onClick={() => destroyFrame(dialog.frameId, 'dialog-close')}
          >
            ×
          </button>
        </header>
        <div style={{ flex: 1, minHeight: 0 }}>
          {frame ? (
            <FrameSlotView frame={frame} style={{ height: '100%' }} />
          ) : (
            <div style={{ padding: 16, color: 'var(--ui-fg-mute)' }}>{t("plugin.slot.loading" as never)}</div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------ settings.page ------------------------------ */

function DeclarativeField({ entry, field }: { entry: PluginSettingsEntry; field: SettingsField }) {
  const values = useSettingsStore((state) => state.plugins.values[entry.pluginId] ?? getPluginSettingValues(entry.pluginId))
  const current = values[field.key]
  const setValue = (value: unknown) => {
    patchPluginSettingValue(entry.pluginId, field.key, value)
  }
  const label = field.label.zh || field.label.en
  const control = (() => {
    switch (field.type) {
      case 'switch':
        return (
          <input
            type="checkbox"
            checked={current === true || (current === undefined && field.default === true)}
            onChange={(event) => setValue(event.target.checked)}
          />
        )
      case 'textarea':
        return (
          <textarea
            className="lumen-textarea"
            value={typeof current === 'string' ? current : ''}
            maxLength={field.maxLength}
            onChange={(event) => setValue(event.target.value)}
          />
        )
      case 'number':
        return (
          <input
            className="lumen-textInput"
            type="number"
            value={typeof current === 'number' ? current : field.default ?? ''}
            min={field.min}
            max={field.max}
            step={field.step}
            onChange={(event) => setValue(event.target.value === '' ? undefined : Number(event.target.value))}
          />
        )
      case 'slider':
        return (
          <input
            className="lumen-slider"
            type="range"
            value={typeof current === 'number' ? current : field.default ?? field.min}
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            onChange={(event) => setValue(Number(event.target.value))}
          />
        )
      case 'select':
        return (
          <select
            className="lumen-select"
            value={typeof current === 'string' ? current : ''}
            onChange={(event) => setValue(event.target.value)}
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label.zh || option.label.en}
              </option>
            ))}
          </select>
        )
      default:
        return (
          <input
            className="lumen-textInput"
            type="text"
            value={typeof current === 'string' ? current : ''}
            placeholder={field.placeholder}
            maxLength={field.maxLength}
            onChange={(event) => setValue(event.target.value)}
          />
        )
    }
  })()
  return (
    <label className="lumen-field" data-plugin-setting={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      <span style={{ color: 'var(--ui-fg-mute)' }}>{label}</span>
      {control}
    </label>
  )
}

/** 设置弹窗「插件」分组：声明式字段宿主原生渲染 + 代码式 settings.page 帧 + 管理入口。 */
export function SettingsSection() {
  const entries = useMemo<PluginSettingsEntry[]>(() => [...getDeclarativeSettingsEntries(), ...codeSettingsEntries()], [])
  const pageItems = useSlotItems('settings.page')
  return (
    <div data-plugin-settings="" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ color: 'var(--ui-fg)' }}>插件</strong>
        <button
          type="button"
          className="lumen-button"
          data-plugin-action="open-manager"
          onClick={() => window.dispatchEvent(new CustomEvent('lumen:open-plugin-manager', { detail: {} }))}
          style={{ marginLeft: 'auto' }}
        >
          插件管理
        </button>
      </div>
      {entries.map((entry) => (
        <section key={`${entry.pluginId}:${entry.pageId}`} data-plugin-id={entry.pluginId} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h4 style={{ margin: 0, fontSize: 12.5, color: 'var(--ui-fg)' }}>{entry.title.zh || entry.title.en}</h4>
          {entry.form === 'declarative' && entry.fields ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {entry.fields.map((field) => (
                <DeclarativeField key={field.key} entry={entry} field={field} />
              ))}
            </div>
          ) : (
            <SlotFrameItem
              item={pageItems.find((item) => item.pluginId === entry.pluginId) ?? fallbackSettingsItem(entry)}
              slot="settings.page"
              fill
            />
          )}
        </section>
      ))}
      {entries.length === 0 ? <div style={{ color: 'var(--ui-fg-mute)', fontSize: 12 }}>还没有插件提供设置。</div> : null}
    </div>
  )
}

function fallbackSettingsItem(entry: PluginSettingsEntry): PluginSlotItem {
  return {
    id: `${entry.pluginId}:${entry.pageId}`,
    pluginId: entry.pluginId,
    slot: 'settings.page',
    kind: 'panel',
    title: entry.title,
    order: 50,
  }
}

/* ------------------------------ 通用 SlotView ------------------------------ */

/** 9 插槽通用渲染（兜底；`itemId` 缺省渲染该槽全部）。 */
export function SlotView({ slot, itemId, className }: { slot: SlotId; itemId?: string; className?: string }) {
  const items = useSlotItems(slot)
  const filtered = itemId ? items.filter((item) => item.id === itemId) : items
  const Wrapper: ComponentType<{ children: ReactNode }> = ({ children }) => (
    <div className={className} data-slot={slot}>
      {children}
    </div>
  )
  if (filtered.length === 0) return null
  if (slot === 'workspace.topbar' || slot === 'workspace.rail.footer') {
    return (
      <Wrapper>
        <InlineSlot slot={slot} />
      </Wrapper>
    )
  }
  if (slot === 'dialog') return <DialogHost />
  if (slot === 'settings.page') return <SettingsSection />
  if (slot === 'command.palette') return null
  return (
    <Wrapper>
      {filtered.map((item) => (
        <SlotErrorBoundary key={item.id} pluginId={item.pluginId} slot={slot}>
          <SlotFrameItem item={item} slot={slot} fill />
        </SlotErrorBoundary>
      ))}
    </Wrapper>
  )
}

/** 供 e2e 等测试读取当前所有帧（不经 public 门面）。 */
export function debugFrameList(): FrameViewState[] {
  return framesForSlot as unknown as FrameViewState[]
}
