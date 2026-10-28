/**
 * TopBar.tsx —— 顶栏：品牌 / 标题 / 模式 / 撤销重做 / 插入 / 主题 / 语言 / UI 明暗 / AI / 导出 / 设置。
 *
 * 布局语言保持原样（.topbar__* 类名不变），新增的只有「插入」下拉与命令面板入口；
 * 窄屏时由 toolbar.css 的媒体查询逐级收起次要信息，保证永不溢出。
 */
import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Command,
  Download,
  Globe2,
  Moon,
  Play,
  Plus,
  Redo2,
  Settings,
  Sun,
  Undo2,
} from 'lucide-react'
import { canRedo, canUndo, useDeckStore } from '@/state/deckStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore, type WorkbenchMode } from '@/state/uiStore'
import { deckOps } from '@/state/ops'
import { useTheme } from '@/themes/useTheme'
import { THEMES } from '@/themes'
import type { Lang } from '@/i18n'
import { useT } from '@/i18n'
import { IconButton, Popover, PopoverLabel, PopoverRow, PopoverSeparator } from '@/ui/primitives'
import { InsertMenu } from './InsertMenu'
import './toolbar.css'

const MODES: { id: WorkbenchMode; labelKey: 'editor.mode.edit' | 'editor.mode.preview' | 'editor.mode.play' }[] = [
  { id: 'edit', labelKey: 'editor.mode.edit' },
  { id: 'preview', labelKey: 'editor.mode.preview' },
  { id: 'play', labelKey: 'editor.mode.play' },
]

export function TopBar() {
  const t = useT()
  const deck = useDeckStore((s) => s.deck)
  const undoable = useDeckStore(canUndo)
  const redoable = useDeckStore(canRedo)
  const undo = useDeckStore((s) => s.undo)
  const redo = useDeckStore((s) => s.redo)
  const mode = useUiStore((s) => s.mode)
  const setMode = useUiStore((s) => s.setMode)
  const openDialog = useUiStore((s) => s.openDialog)
  const setInspectorTab = useUiStore((s) => s.setInspectorTab)
  const rightMode = useUiStore((s) => s.rightMode)
  const setRightMode = useUiStore((s) => s.setRightMode)
  const setCommandOpen = useUiStore((s) => s.setCommandOpen)
  const lang = useSettingsStore((s) => s.lang)
  const setLang = useSettingsStore((s) => s.setLang)
  const uiTheme = useSettingsStore((s) => s.uiTheme)
  const setUiTheme = useSettingsStore((s) => s.setUiTheme)
  const theme = useTheme()

  const [themeOpen, setThemeOpen] = useState(false)
  const [themeAnchor, setThemeAnchor] = useState<HTMLElement | null>(null)
  const [langOpen, setLangOpen] = useState(false)
  const [langAnchor, setLangAnchor] = useState<HTMLElement | null>(null)
  const [insertOpen, setInsertOpen] = useState(false)
  const insertAnchorRef = useRef<HTMLButtonElement>(null)
  const [title, setTitle] = useState(deck?.title ?? '')

  useEffect(() => {
    setTitle(deck?.title ?? '')
  }, [deck?.id, deck?.title])

  // 撤销/重做交给 editor/shortcuts.ts 的集中式快捷键表统一处理。
  // 同节点（window）上的第二个监听器无法被 stopPropagation 拦住，会造成"一次按键撤销两步"。

  if (!deck) return <header className="topbar" />

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__logo">
          LUMEN<span>.</span>
        </span>
        <span className="topbar__sub">{t('common.app.subtitle')}</span>
      </div>

      <div className="topbar__divider" />

      <div className="topbar__title">
        <input
          value={title}
          aria-label={t('editor.topbar.deckTitle')}
          placeholder={t('editor.topbar.untitled')}
          title={t('editor.topbar.rename')}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            const next = title.trim()
            if (next !== '' && next !== deck.title) deckOps.setTitle(next)
            else setTitle(deck.title)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              setTitle(deck.title)
              event.currentTarget.blur()
            }
          }}
        />
      </div>

      <button
        ref={insertAnchorRef}
        type="button"
        className="lm-btn lm-btn--outline tbar-insert"
        aria-expanded={insertOpen}
        aria-haspopup="menu"
        onClick={() => setInsertOpen((value) => !value)}
      >
        <Plus size={14} />
        {t('editor.insert.title')}
        <ChevronDown size={12} />
      </button>

      <div className="lm-segmented" role="tablist" aria-label={t('editor.mode.edit')}>
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={mode === item.id}
            className={mode === item.id ? 'lm-segmented__item lm-segmented__item--active' : 'lm-segmented__item'}
            onClick={() => setMode(item.id)}
          >
            {item.id === 'play' ? <Play size={12} /> : null}
            {t(item.labelKey)}
          </button>
        ))}
      </div>

      <div className="topbar__divider topbar__divider--wide" />

      <div className="topbar__group">
        <IconButton icon={<Undo2 size={15} />} label={t('editor.topbar.undo')} disabled={!undoable} onClick={undo} />
        <IconButton icon={<Redo2 size={15} />} label={t('editor.topbar.redo')} disabled={!redoable} onClick={redo} />
      </div>

      <div className="topbar__divider topbar__divider--wide" />

      <div className="topbar__group">
        <button
          type="button"
          className="lm-btn lm-btn--ghost"
          title={t('editor.topbar.theme')}
          onClick={(event) => {
            setThemeAnchor(event.currentTarget)
            setThemeOpen(true)
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 12,
              height: 12,
              borderRadius: 3,
              background: theme.colors.accent,
              display: 'inline-block',
            }}
          />
          {theme.name[lang]}
          <ChevronDown size={12} />
        </button>
        <span className="tbar-lang">
          <IconButton
            icon={<Globe2 size={15} />}
            label={t('common.label.uiLanguage')}
            onClick={(event) => {
              setLangAnchor(event.currentTarget)
              setLangOpen(true)
            }}
          />
        </span>
        <IconButton
          icon={uiTheme === 'light' ? <Sun size={15} /> : <Moon size={15} />}
          label={t('common.label.theme')}
          onClick={() => setUiTheme(uiTheme === 'light' ? 'dark' : 'light')}
        />
        <IconButton
          icon={<Command size={15} />}
          label={`${t('editor.topbar.commandPalette')} ⌘K`}
          onClick={() => setCommandOpen(true)}
        />
      </div>

      <div className="topbar__spacer" />

      <div className="topbar__group">
        <span className="topbar__status">
          {t('common.label.slideCount', { count: deck.slides.length })}
        </span>
        <button
          type="button"
          className="lm-btn lm-btn--ghost"
          aria-pressed={rightMode === 'composer'}
          onClick={() => {
            setRightMode(rightMode === 'composer' ? 'inspector' : 'composer')
            setInspectorTab('props')
          }}
        >
          ✦ {t('ai.panel.title')}
        </button>
        <button type="button" className="lm-btn lm-btn--ghost" onClick={() => openDialog('export')}>
          <Download size={14} />
          {t('common.action.export')}
        </button>
        <IconButton
          icon={<Settings size={15} />}
          label={t('common.label.settings')}
          onClick={() => openDialog('settings')}
        />
      </div>

      <InsertMenu open={insertOpen} anchor={insertAnchorRef.current} onClose={() => setInsertOpen(false)} />

      <Popover open={themeOpen} onClose={() => setThemeOpen(false)} anchor={themeAnchor} width={230}>
        <PopoverLabel>{t('editor.inspector.themePick')}</PopoverLabel>
        {Object.values(THEMES).map((item) => (
          <PopoverRow
            key={item.id}
            active={item.id === deck.themeId}
            onClick={() => {
              deckOps.setTheme(item.id)
              setThemeOpen(false)
            }}
            icon={
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: item.colors.accent,
                  display: 'inline-block',
                  boxShadow: `inset 0 0 0 1px ${item.colors.line}`,
                }}
              />
            }
          >
            {item.name[lang]}
          </PopoverRow>
        ))}
        <PopoverSeparator />
        <PopoverRow
          onClick={() => {
            deckOps.resetThemeOverrides()
            setThemeOpen(false)
          }}
        >
          {t('editor.inspector.themeReset')}
        </PopoverRow>
      </Popover>

      <Popover open={langOpen} onClose={() => setLangOpen(false)} anchor={langAnchor} width={170}>
        {(['zh', 'en'] as Lang[]).map((item) => (
          <PopoverRow
            key={item}
            active={lang === item}
            onClick={() => {
              setLang(item)
              setLangOpen(false)
            }}
          >
            {t(`common.lang.${item}`)}
          </PopoverRow>
        ))}
      </Popover>
    </header>
  )
}
