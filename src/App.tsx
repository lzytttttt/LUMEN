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

export default function App() {
  const deck = useDeckStore((s) => s.deck)
  const mode = useUiStore((s) => s.mode)
  const commandOpen = useUiStore((s) => s.commandOpen)
  const setCommandOpen = useUiStore((s) => s.setCommandOpen)
  const bootError = useUiStore((s) => s.bootError)

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
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen(!useUiStore.getState().commandOpen)
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

  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-body">
        <SlideRail />
        <Stage />
        <Inspector />
      </div>
      <Toasts />
      <StudioHost />
      <ForgeHost />
      <PrintHost />
      <Dialogs />
      <Onboarding />
      {mode === 'play' ? <Player /> : null}
    </div>
  )
}
