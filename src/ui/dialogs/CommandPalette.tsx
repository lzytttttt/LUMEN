/**
 * CommandPalette.tsx —— ⌘K 命令面板。
 *
 * - 命令表见 editor/toolbar/commandRegistry.ts（模糊检索 + 上下键 + 回车执行）；
 * - 输入不是命令时，最后一行变成「用 AI 改写」，通过 lumen:intent 事件交给 AI 编排；
 * - AI 模块不在线时给 toast 提示，不静默丢弃。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { CornerDownLeft, Search, Sparkles } from 'lucide-react'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useSelectionStore } from '@/state/selectionStore'
import { useActiveSlide } from '@/state/selectors'
import { blockOps, deckOps, slideOps } from '@/state/ops'
import { THEMES } from '@/themes'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import {
  buildCommands,
  fuzzyScore,
  searchCommands,
  type CommandContext,
} from '@/editor/toolbar/commandRegistry'
import { insertBlankSvg, insertText, insertThree } from '@/editor/toolbar/insertActions'
import { sendIntent } from '@/editor/panels/studioBridge'
import { openForge } from '@/forge/ForgeHost'
import { usePluginCommands } from '@/plugins/public'
import { openCreator } from '@/creator/bridge'
import { openPluginManager } from './pluginUiStore'
import './dialogs.css'

/** 命令面板里插件分组的条目（宿主渲染，无帧；02 §6.10 command.palette）。 */
interface PluginRow {
  id: string
  title: string
  source?: string
  run: () => void
}

/** 宿主内置的创造模式入口行（04 §2.1：⌘K → 搜「创造」/ `creator.open`）。 */
interface CreatorRow {
  id: 'creator.open'
  title: string
  run: () => void
}

export function CommandPalette() {
  const t = useT()
  const open = useUiStore((s) => s.commandOpen)
  const setCommandOpen = useUiStore((s) => s.setCommandOpen)
  const openDialog = useUiStore((s) => s.openDialog)
  const setMode = useUiStore((s) => s.setMode)
  const setRightMode = useUiStore((s) => s.setRightMode)
  const setInspectorTab = useUiStore((s) => s.setInspectorTab)
  const toggleGrid = useUiStore((s) => s.toggleGrid)
  const pushToast = useUiStore((s) => s.pushToast)
  const setActiveSlide = useUiStore((s) => s.setActiveSlide)
  const deck = useDeckStore((s) => s.deck)
  const slide = useActiveSlide()
  const selectedIds = useSelectionStore((s) => s.selectedBlockIds)
  const setSelection = useSelectionStore((s) => s.setSelection)
  const lang = useSettingsStore((s) => s.lang)
  const setLang = useSettingsStore((s) => s.setLang)

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const rewrite = (text: string, scope: 'slide' | 'deck' | 'selection' = 'slide') => {
    void sendIntent(text, scope).then((mounted) => {
      pushToast({
        kind: 'info',
        message: mounted ? t('editor.palette.rewriteSent') : t('editor.palette.aiPending'),
      })
    })
  }

  const ctx: CommandContext = {
    t,
    deck,
    slide,
    selectedIds,
    lang,
    openDialog,
    addSlide: () => slideOps.add({ at: deck?.slides.length ?? 0 }),
    duplicateSlide: () => slideOps.duplicate(slide?.id),
    deleteSlide: () => {
      if (slide && (deck?.slides.length ?? 0) > 1) slideOps.remove(slide.id)
    },
    selectSlide: (slideId) => setActiveSlide(slideId),
    duplicateBlocks: (ids) => blockOps.duplicate(ids),
    deleteBlocks: (ids) => blockOps.remove(ids),
    selectAllBlocks: () => {
      if (slide) setSelection(slide.blocks.map((block) => block.id))
    },
    reorderBlocks: (ids, mode) => blockOps.reorderZ(ids, mode),
    insertText: () => insertText('body'),
    insertSvg: () => insertBlankSvg(),
    insertThree: () => insertThree('orbit'),
    setMode,
    setRightMode,
    setInspectorTab,
    openForge: (source) => openForge(source),
    toggleGrid,
    setLang,
    cycleTheme: () => {
      const ids = Object.keys(THEMES)
      const index = Math.max(0, ids.indexOf(deck?.themeId ?? 'noir'))
      deckOps.setTheme(ids[(index + 1) % ids.length])
    },
    rewrite,
    notify: (message) => pushToast({ kind: 'info', message }),
  }
  const commands = buildCommands(ctx)
  const hits = useMemo(
    () => searchCommands(commands, query, (command) => t(command.titleKey)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, deck, slide, selectedIds, lang, t],
  )
  // 插件命令分组（02 §6.10 / 02 §5.3）：命令面板尾部，按来源徽标标注；宿主治理入口不可被插件 invoke。
  const pluginCommands = usePluginCommands()
  const pluginRows = useMemo<PluginRow[]>(() => {
    const hostRows: PluginRow[] = [
      { id: 'plugin.open', title: t('plugin.managerTitle'), run: () => openPluginManager() },
      { id: 'plugin.safeMode', title: t('plugin.safe.pill'), run: () => openPluginManager() },
    ]
    const contributed: PluginRow[] = pluginCommands.map((command) => ({
      id: command.id,
      title: command.title,
      source: command.pluginName,
      run: () => {
        void command.run()
      },
    }))
    const rows = [...hostRows, ...contributed]
    const needle = query.trim().toLowerCase()
    if (needle === '') return rows
    return rows
      .map((row) => ({ row, score: Math.max(fuzzyScore(row.title, needle), fuzzyScore(row.id, needle)) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((item) => item.row)
  }, [pluginCommands, query, t])
  const showRewrite = query.trim() !== ''
  const creatorRows = useMemo<CreatorRow[]>(() => {
    const rows: CreatorRow[] = [
      { id: 'creator.open', title: t('creator.command.open'), run: () => openCreator('palette') },
    ]
    const needle = query.trim().toLowerCase()
    if (needle === '') return rows
    return rows
      .map((row) => ({ row, score: Math.max(fuzzyScore(row.title, needle), fuzzyScore(row.id, needle)) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((item) => item.row)
  }, [query, t])
  const total = hits.length + pluginRows.length + creatorRows.length + (showRewrite ? 1 : 0)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
  }, [open])

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    if (!open) return
    const node = listRef.current?.querySelector<HTMLElement>(`[data-command-index="${active}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  if (!open) return null

  const close = () => setCommandOpen(false)

  const runAt = (index: number) => {
    if (index < hits.length) {
      hits[index].command.run()
      close()
      return
    }
    const pluginIndex = index - hits.length
    if (pluginIndex >= 0 && pluginIndex < pluginRows.length) {
      pluginRows[pluginIndex].run()
      close()
      return
    }
    const creatorIndex = index - hits.length - pluginRows.length
    if (creatorIndex >= 0 && creatorIndex < creatorRows.length) {
      creatorRows[creatorIndex].run()
      close()
      return
    }
    if (showRewrite) {
      rewrite(query.trim())
      close()
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((value) => (total === 0 ? 0 : (value + 1) % total))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((value) => (total === 0 ? 0 : (value - 1 + total) % total))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      runAt(active)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  return createPortal(
    <div
      className="lcp__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="lcp" role="dialog" aria-modal="true" aria-label={t('editor.command.title')}>
        <div className="lcp__search">
          <Search size={15} />
          <input
            autoFocus
            value={query}
            aria-label={t('editor.command.title')}
            placeholder={t('editor.command.placeholder')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className="lcp__kbd">esc</span>
        </div>

        <div className="lcp__list lumen-scroll" ref={listRef} role="listbox" aria-label={t('editor.command.title')}>
          {hits.length === 0 && !showRewrite ? (
            <div className="lcp__empty">{t('editor.command.noResult')}</div>
          ) : null}

          {hits.map((hit, index) => (
            <button
              key={hit.command.id}
              type="button"
              role="option"
              aria-selected={active === index}
              data-command-index={index}
              className={active === index ? 'lcp__row lcp__row--active' : 'lcp__row'}
              onMouseEnter={() => setActive(index)}
              onClick={() => runAt(index)}
            >
              <span className="lcp__title">{t(hit.command.titleKey)}</span>
              <span className="lcp__cat">{t(`editor.command.categories.${hit.command.category}` as MessageKey)}</span>
              {hit.command.shortcut ? <span className="lcp__shortcut">{hit.command.shortcut}</span> : null}
            </button>
          ))}

          {/* 插件分组（分组标题「插件」；02 §6.10 / 06 §3.1 数据钩子 data-plugin-source） */}
          {pluginRows.length > 0 ? (
            <div className="lcp__group" role="presentation">
              {t('plugin.title')}
            </div>
          ) : null}
          {pluginRows.map((row, index) => {
            const rowIndex = hits.length + index
            return (
              <button
                key={row.id}
                type="button"
                role="option"
                aria-selected={active === rowIndex}
                data-command-index={rowIndex}
                data-plugin-source={row.source ?? 'host'}
                className={active === rowIndex ? 'lcp__row lcp__row--active' : 'lcp__row'}
                onMouseEnter={() => setActive(rowIndex)}
                onClick={() => runAt(rowIndex)}
              >
                <span className="lcp__title">{row.title}</span>
                <span className="lcp__cat">
                  {row.source ? t('plugin.keymap.sourcePlugin', { name: row.source }) : t('plugin.title')}
                </span>
              </button>
            )
          })}

          {/* 创造模式入口（04 §2.1；命令 id `creator.open`，不抢 ⌘K） */}
          {creatorRows.length > 0 ? (
            <>
              <div className="lcp__group" role="presentation">
                {t('creator.panel.title')}
              </div>
              {creatorRows.map((row) => {
                const rowIndex = hits.length + pluginRows.length
                return (
                  <button
                    key={row.id}
                    type="button"
                    role="option"
                    aria-selected={active === rowIndex}
                    data-command-index={rowIndex}
                    data-creator-command={row.id}
                    className={active === rowIndex ? 'lcp__row lcp__row--active' : 'lcp__row'}
                    onMouseEnter={() => setActive(rowIndex)}
                    onClick={() => runAt(rowIndex)}
                  >
                    <span className="lcp__title">{row.title}</span>
                    <span className="lcp__cat">{t('creator.entry')}</span>
                  </button>
                )
              })}
            </>
          ) : null}

          {showRewrite ? (
            <button
              type="button"
              role="option"
              aria-selected={active === hits.length}
              data-command-index={hits.length}
              className={
                active === hits.length ? 'lcp__row lcp__row--active lcp__row--ai' : 'lcp__row lcp__row--ai'
              }
              onMouseEnter={() => setActive(hits.length)}
              onClick={() => runAt(hits.length)}
            >
              <Sparkles size={13} />
              <span className="lcp__title">{t('editor.palette.rewrite', { text: query.trim() })}</span>
              <span className="lcp__cat">{t('editor.palette.rewriteHint')}</span>
            </button>
          ) : null}
        </div>

        <div className="lcp__foot">
          <span className="lcp__hint">
            <CornerDownLeft size={11} /> {t('editor.palette.footerHint')}
          </span>
          <span className="lcp__count">{total}</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
