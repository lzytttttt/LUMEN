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
  searchCommands,
  type CommandContext,
} from '@/editor/toolbar/commandRegistry'
import { insertBlankSvg, insertText, insertThree } from '@/editor/toolbar/insertActions'
import { sendIntent } from '@/editor/panels/studioBridge'
import './dialogs.css'

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
  const showRewrite = query.trim() !== ''
  const total = hits.length + (showRewrite ? 1 : 0)

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
