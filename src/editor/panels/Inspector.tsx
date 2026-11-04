/**
 * Inspector.tsx —— 右侧栏外壳：6 个页签 + AI 编排模式挂载。
 *
 * 页签内容各自拆到 tabs/*；本文件只负责标签栏、选中集派生与底部状态条。
 * `rightMode === 'composer'` 时整栏交给 `@/ai/ui/ComposerPanel`（零 props）。
 */
import { useMemo, type CSSProperties } from 'react'
import type { Block } from '@/schema/deck'
import { useDeckStore } from '@/state/deckStore'
import { useActiveSlide } from '@/state/selectors'
import { useUiStore, type InspectorTab } from '@/state/uiStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useSelectionStore } from '@/state/selectionStore'
import { getTheme, themeCssVars } from '@/themes'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import ComposerPanel from '@/ai/ui/ComposerPanel'
import { InspectorTabSlot, useInspectorTabs } from '@/plugins/public'
import { PropsTab } from './tabs/PropsTab'
import { LayersTab } from './tabs/LayersTab'
import { MotionTab } from './tabs/MotionTab'
import { NotesTab } from './tabs/NotesTab'
import { ThemeTab } from './tabs/ThemeTab'
import { LintTab } from './tabs/LintTab'
import { PluginsTab } from './tabs/PluginsTab'
import './panels.css'

const TABS: InspectorTab[] = ['props', 'layers', 'motion', 'notes', 'theme', 'lint']

export function Inspector() {
  const t = useT()
  const rightMode = useUiStore((s) => s.rightMode)

  if (rightMode === 'composer') {
    return (
      <aside className="panel" aria-label={t('ai.panel.title')}>
        <div className="panel__body lumen-scroll">
          <ComposerPanel />
        </div>
      </aside>
    )
  }

  return <InspectorPane />
}

function InspectorPane() {
  const t = useT()
  const deck = useDeckStore((s) => s.deck)
  const slide = useActiveSlide()
  const tab = useUiStore((s) => s.inspectorTab)
  const setTab = useUiStore((s) => s.setInspectorTab)
  const setCommandOpen = useUiStore((s) => s.setCommandOpen)
  const selectedIds = useSelectionStore((s) => s.selectedBlockIds)
  const lang = useSettingsStore((s) => s.lang)
  // workspace.inspector.tab 动态页签（02 §6.10：TABS 数组后追加；插件停用即摘除）。
  const pluginTabs = useInspectorTabs()
  const activePluginTab = tab.startsWith('plug:') ? pluginTabs.find((item) => item.id === tab) : undefined

  const selected = useMemo<Block[]>(
    () => (slide ? slide.blocks.filter((block) => selectedIds.includes(block.id)) : []),
    [slide, selectedIds],
  )

  // 检查器里的色板/预览直接用 var(--d-*) 令牌，所以要把 deck 主题变量注入到面板根上。
  const themeVars = useMemo(
    () => themeCssVars(getTheme(deck?.themeId), deck?.themeOverrides),
    [deck?.themeId, deck?.themeOverrides],
  )

  if (!deck || !slide) return <aside className="panel" />

  return (
    <aside className="panel" aria-label={t('editor.inspector.title')} style={themeVars as CSSProperties}>
      <div className="lm-tabs insp-tabs" role="tablist" aria-label={t('editor.inspector.title')}>
        {TABS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={tab === item ? 'lm-tab lm-tab--active' : 'lm-tab'}
            onClick={() => setTab(item)}
          >
            {t(`editor.inspector.tabs.${item}` as MessageKey)}
          </button>
        ))}
        {pluginTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            data-plugin-tab={item.pluginId}
            className={tab === item.id ? 'lm-tab lm-tab--active' : 'lm-tab'}
            onClick={() => setTab(item.id)}
          >
            {item.titleOf(lang) || item.title}
          </button>
        ))}
      </div>

      <div className="panel__body lumen-scroll">
        {tab === 'props' ? <PropsTab selected={selected} /> : null}
        {tab === 'layers' ? <LayersTab slide={slide} /> : null}
        {tab === 'motion' ? <MotionTab slide={slide} selected={selected} /> : null}
        {tab === 'notes' ? <NotesTab slide={slide} /> : null}
        {tab === 'theme' ? <ThemeTab /> : null}
        {tab === 'lint' ? <LintTab /> : null}
        {tab.startsWith('plug:') ? (
          activePluginTab ? (
            <div className="plug-insp-tab">
              <InspectorTabSlot
                contributionId={activePluginTab.id.slice('plug:'.length)}
                title={activePluginTab.title}
              />
            </div>
          ) : (
            <PluginsTab contributionId={tab.slice('plug:'.length)} />
          )
        ) : null}
      </div>

      <div className="insp-foot">
        <span>{t('editor.inspector.layerCount', { count: slide.blocks.length })}</span>
        <span className="insp-foot__spacer" />
        <button type="button" className="insp-foot__hint" onClick={() => setCommandOpen(true)}>
          ⌘K
        </button>
      </div>
    </aside>
  )
}
