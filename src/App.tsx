import { useEffect } from 'react'
import { TopBar } from '@/editor/toolbar/TopBar'
import { SlideRail } from '@/editor/panels/SlideRail'
import { Inspector } from '@/editor/panels/Inspector'
import { Stage } from '@/editor/stage/Stage'
import { Player } from '@/play/Player'
import { Dialogs } from '@/ui/dialogs/Dialogs'
import { StudioHost } from '@/studio/StudioHost'
import { ForgeHost } from '@/forge/ForgeHost'
import { Onboarding } from '@/onboarding/Onboarding'
import { PrintHost } from '@/export/PrintHost'
import { Toasts } from '@/ui/primitives'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { slideOps } from '@/state/ops'
import { installShortcuts } from '@/editor/shortcuts'
import { installIntentListener } from '@/ai/intent'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { bootPlugins, DockHost, installBuiltinSample, isPluginError, pluginErrorKey, usePluginsEnabled } from '@/plugins/public'
import { toggleCreator } from '@/creator/bridge'
import { CreatorHost } from '@/creator/CreatorHost'

/** 从拖放载荷里取第一个插件包（`.lumenplug`）；非插件文件返回 null，交还给画布拖放。 */
function pluginFileOf(transfer: DataTransfer | null): File | null {
  if (!transfer) return null
  const candidates: File[] = []
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) candidates.push(file)
  }
  if (candidates.length === 0) candidates.push(...Array.from(transfer.files ?? []))
  return candidates.find((file) => /\.lumenplug$/i.test(file.name)) ?? null
}

export default function App() {
  const deck = useDeckStore((s) => s.deck)
  const mode = useUiStore((s) => s.mode)
  const commandOpen = useUiStore((s) => s.commandOpen)
  const setCommandOpen = useUiStore((s) => s.setCommandOpen)
  const bootError = useUiStore((s) => s.bootError)
  // v0.4.0 布局预设可改维度（02 §6.8）：插件 `ui:layout` 应用的隐藏/密度在这里落到外壳。
  const hideRail = useUiStore((s) => s.hideRail)
  const hideInspector = useUiStore((s) => s.hideInspector)
  const density = useUiStore((s) => s.density)
  const pluginsEnabled = usePluginsEnabled()
  const t = useT()

  // 插件启动（02 §3.3）：安全模式判定 + 启用数镜像；无插件时同步早退，不加载运行时。
  useEffect(() => {
    bootPlugins()
  }, [])

  /**
   * `?installSample=<id>` 深链（plugins.html「打开工作台」入口用）：
   * 只触发一次（清掉 URL 参数），装完 toast 引导去插件页启用（D-40-22 样例默认不启用）。
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const sampleId = params.get('installSample')
    if (!sampleId) return
    params.delete('installSample')
    const search = params.toString()
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
    )
    let alive = true
    void installBuiltinSample(sampleId).then(
      () => {
        if (alive) {
          useUiStore.getState().pushToast({ kind: 'success', message: t('plugin.install.successDisabled') })
        }
      },
      (error: unknown) => {
        if (!alive) return
        const key = isPluginError(error) ? pluginErrorKey(error.code) : 'plugin.error.host'
        useUiStore.getState().pushToast({ kind: 'error', message: t(key as MessageKey) })
      },
    )
    return () => {
      alive = false
    }
  }, [t])

  /**
   * 全局 drop 监听（02 §11.1）：`.lumenplug` 交给插件层（boot 解析后派发
   * `lumen:plugin-preview`），其余文件继续走画布的既有拖放。
   * 用 capture 保证在画布 onDrop 之前拦下插件包，避免被当成图片/SVG 插入。
   */
  useEffect(() => {
    const isPluginDrag = (event: DragEvent) => pluginFileOf(event.dataTransfer) !== null
    const onDragOver = (event: DragEvent) => {
      if (!isPluginDrag(event)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (event: DragEvent) => {
      const file = pluginFileOf(event.dataTransfer)
      if (!file) return
      event.preventDefault()
      event.stopPropagation()
      window.dispatchEvent(new CustomEvent('lumen:plugin-install', { detail: { file } }))
    }
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [])

  /**
   * 画布快捷键统一由 editor/shortcuts 的表驱动（stage-editor 拥有）。
   * App 只保留两个"全局之外"的：命令面板与新增幕。
   */
  useEffect(() => installShortcuts(), [])

  // AI 意图路由（命令面板 → 自然语言指令）；标记让面板侧知道已有监听者。
  useEffect(() => {
    document.documentElement.dataset.lumenAi = '1'
    return installIntentListener()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
      if (meta && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen(!useUiStore.getState().commandOpen)
        return
      }
      // ⌘/Ctrl+⇧+K：开关创造模式（04 §2.1；仅 edit/preview 响应，不进 shortcuts.ts 表）
      if (meta && event.shiftKey && event.key.toLowerCase() === 'k') {
        const current = useUiStore.getState().mode
        if (current !== 'edit' && current !== 'preview') return
        event.preventDefault()
        toggleCreator('shortcut')
        return
      }
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable === true
      if (typing) return
      if (!meta && event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        slideOps.add({ at: deck?.slides.length })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setCommandOpen, commandOpen, deck?.slides.length])

  if (bootError) {
    return (
      <div style={{ padding: 40, color: 'var(--ui-danger)', fontFamily: 'var(--ui-font)' }}>
        <h1 style={{ fontSize: 18 }}>LUMEN</h1>
        <p>{bootError}</p>
      </div>
    )
  }

  useEffect(() => {
    document.documentElement.dataset.density = density
  }, [density])

  return (
    <div className="app-shell" data-density={density}>
      <TopBar />
      <div className="app-body">
        {hideRail ? null : <SlideRail />}
        <Stage />
        {hideInspector ? null : <Inspector />}
      </div>
      {/* workspace.dock（02 §6.10：.app-body 之后；panel，整宽 240–400 可拖高，收起保留 1 帧） */}
      {pluginsEnabled ? <DockHost /> : null}
      <Toasts />
      <StudioHost />
      <ForgeHost />
      {/* 创造模式（04 §2.1）：零渲染宿主，内部负责 ?creator=、Esc、焦点归还与 data-lumen-creator。 */}
      <CreatorHost />
      <PrintHost />
      <Dialogs />
      <Onboarding />
      {mode === 'play' ? <Player /> : null}
    </div>
  )
}
