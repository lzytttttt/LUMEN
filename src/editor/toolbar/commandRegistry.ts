/**
 * commandRegistry.ts —— 命令面板的命令表与模糊检索。
 *
 * 设计：
 * - 命令只描述「做什么」，所有副作用由调用方（CommandPalette）注入的 ctx 承担，
 *   因此这张表可以在单测里用假 ctx 完整跑一遍。
 * - titleKey 走 i18n；检索同时匹配「本地化标题 + 命令 id」，中英文都能搜到。
 */
import type { Deck, Slide } from '@/schema/deck'
import type { MessageKey, Lang } from '@/i18n'
import type { DialogId, InspectorTab, RightPanelMode, WorkbenchMode } from '@/state/uiStore'

export type CommandCategory = 'deck' | 'slide' | 'block' | 'view' | 'ai' | 'export'

export interface Command {
  id: string
  titleKey: MessageKey
  category: CommandCategory
  shortcut?: string
  run: () => void
}

export interface CommandContext {
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
  deck: Deck | null
  slide: Slide | null
  selectedIds: string[]
  lang: Lang
  openDialog: (id: DialogId) => void
  addSlide: () => void
  duplicateSlide: () => void
  deleteSlide: () => void
  selectSlide: (slideId: string) => void
  duplicateBlocks: (ids: string[]) => void
  deleteBlocks: (ids: string[]) => void
  selectAllBlocks: () => void
  reorderBlocks: (ids: string[], mode: 'front' | 'back') => void
  insertText: () => void
  insertSvg: () => void
  insertThree: () => void
  setMode: (mode: WorkbenchMode) => void
  setRightMode: (mode: RightPanelMode) => void
  setInspectorTab: (tab: InspectorTab) => void
  toggleGrid: () => void
  setLang: (lang: Lang) => void
  cycleTheme: () => void
  rewrite: (text: string, scope: 'slide' | 'deck' | 'selection') => void
  notify: (message: string) => void
}

export function buildCommands(ctx: CommandContext): Command[] {
  const { t } = ctx
  const slides = ctx.deck?.slides ?? []
  const index = ctx.slide ? slides.findIndex((slide) => slide.id === ctx.slide?.id) : -1
  const hasSelection = ctx.selectedIds.length > 0
  const canDeleteSlide = slides.length > 1

  return [
    {
      id: 'slide.new',
      titleKey: 'editor.command.newSlide',
      category: 'slide',
      shortcut: '⇧S',
      run: () => ctx.addSlide(),
    },
    {
      id: 'slide.duplicate',
      titleKey: 'editor.command.duplicateSlide',
      category: 'slide',
      run: () => ctx.duplicateSlide(),
    },
    {
      id: 'slide.delete',
      titleKey: 'editor.command.deleteSlide',
      category: 'slide',
      run: () => (canDeleteSlide ? ctx.deleteSlide() : ctx.notify(t('editor.toast.lastSlide'))),
    },
    {
      id: 'slide.prev',
      titleKey: 'editor.palette.movePrev',
      category: 'slide',
      run: () => {
        const target = slides[index - 1]
        if (target) ctx.selectSlide(target.id)
      },
    },
    {
      id: 'slide.next',
      titleKey: 'editor.palette.moveNext',
      category: 'slide',
      run: () => {
        const target = slides[index + 1]
        if (target) ctx.selectSlide(target.id)
      },
    },
    {
      id: 'block.duplicate',
      titleKey: 'editor.palette.duplicateBlock',
      category: 'block',
      shortcut: '⌘D',
      run: () => (hasSelection ? ctx.duplicateBlocks(ctx.selectedIds) : ctx.notify(t('editor.toast.noSelection'))),
    },
    {
      id: 'block.delete',
      titleKey: 'editor.palette.deleteBlock',
      category: 'block',
      shortcut: 'Del',
      run: () => (hasSelection ? ctx.deleteBlocks(ctx.selectedIds) : ctx.notify(t('editor.toast.noSelection'))),
    },
    {
      id: 'block.selectAll',
      titleKey: 'editor.palette.selectAll',
      category: 'block',
      shortcut: '⌘A',
      run: () => ctx.selectAllBlocks(),
    },
    {
      id: 'block.front',
      titleKey: 'editor.palette.bringFront',
      category: 'block',
      shortcut: ']',
      run: () => (hasSelection ? ctx.reorderBlocks(ctx.selectedIds, 'front') : ctx.notify(t('editor.toast.noSelection'))),
    },
    {
      id: 'block.back',
      titleKey: 'editor.palette.sendBack',
      category: 'block',
      shortcut: '[',
      run: () => (hasSelection ? ctx.reorderBlocks(ctx.selectedIds, 'back') : ctx.notify(t('editor.toast.noSelection'))),
    },
    {
      id: 'insert.text',
      titleKey: 'editor.palette.insertText',
      category: 'block',
      run: () => ctx.insertText(),
    },
    {
      id: 'insert.svg',
      titleKey: 'editor.palette.insertSvg',
      category: 'block',
      run: () => ctx.insertSvg(),
    },
    {
      id: 'insert.three',
      titleKey: 'editor.palette.insertThree',
      category: 'block',
      run: () => ctx.insertThree(),
    },
    {
      id: 'view.play',
      titleKey: 'editor.command.play',
      category: 'view',
      shortcut: '⌘⏎',
      run: () => ctx.setMode('play'),
    },
    {
      id: 'view.grid',
      titleKey: 'editor.palette.toggleGrid',
      category: 'view',
      shortcut: 'G',
      run: () => ctx.toggleGrid(),
    },
    {
      id: 'view.composer',
      titleKey: 'editor.palette.openComposer',
      category: 'ai',
      run: () => ctx.setRightMode('composer'),
    },
    {
      id: 'view.inspector',
      titleKey: 'editor.palette.openInspector',
      category: 'view',
      run: () => {
        ctx.setRightMode('inspector')
        ctx.setInspectorTab('props')
      },
    },
    {
      id: 'view.notes',
      titleKey: 'editor.palette.openNotes',
      category: 'view',
      run: () => {
        ctx.setRightMode('inspector')
        ctx.setInspectorTab('notes')
      },
    },
    {
      id: 'view.lint',
      titleKey: 'editor.palette.runLint',
      category: 'view',
      run: () => {
        ctx.setRightMode('inspector')
        ctx.setInspectorTab('lint')
      },
    },
    {
      id: 'deck.export',
      titleKey: 'editor.command.export',
      category: 'export',
      shortcut: '⌘E',
      run: () => ctx.openDialog('export'),
    },
    {
      id: 'deck.settings',
      titleKey: 'editor.command.settings',
      category: 'deck',
      shortcut: '⌘,',
      run: () => ctx.openDialog('settings'),
    },
    {
      id: 'deck.shortcuts',
      titleKey: 'editor.palette.shortcuts',
      category: 'deck',
      shortcut: '?',
      run: () => ctx.openDialog('shortcuts'),
    },
    {
      id: 'deck.about',
      titleKey: 'editor.palette.openAbout',
      category: 'deck',
      run: () => ctx.openDialog('about'),
    },
    {
      id: 'deck.lang',
      titleKey: 'editor.command.toggleLang',
      category: 'deck',
      run: () => ctx.setLang(ctx.lang === 'zh' ? 'en' : 'zh'),
    },
    {
      id: 'deck.theme',
      titleKey: 'editor.command.theme',
      category: 'deck',
      run: () => ctx.cycleTheme(),
    },
    {
      id: 'ai.generateSlide',
      titleKey: 'editor.command.generateSlide',
      category: 'ai',
      shortcut: '⌘J',
      run: () => ctx.rewrite(t('editor.command.generateSlide'), 'slide'),
    },
    {
      id: 'ai.generateDeck',
      titleKey: 'editor.command.generateDeck',
      category: 'ai',
      run: () => ctx.rewrite(t('editor.command.generateDeck'), 'deck'),
    },
  ]
}

/** 单个词的模糊打分：0 = 不匹配；越大越靠前（连续命中加权）。 */
export function fuzzyScore(text: string, query: string): number {
  const hay = text.toLowerCase()
  const needle = query.toLowerCase().trim()
  if (needle === '') return 1
  const direct = hay.indexOf(needle)
  if (direct >= 0) return 120 - direct
  let cursor = 0
  let score = 0
  let streak = 0
  for (const char of needle) {
    if (char === ' ') continue
    const found = hay.indexOf(char, cursor)
    if (found < 0) return 0
    streak = found === cursor ? streak + 1 : 0
    score += 2 + streak
    cursor = found + 1
  }
  return score
}

export interface CommandHit {
  command: Command
  score: number
}

/**
 * 多词检索：每个词都要命中（标题或 id），分数相加后降序。
 * `resolveTitle` 由调用方注入（依赖当前语言）。
 */
export function searchCommands(
  commands: Command[],
  query: string,
  resolveTitle: (command: Command) => string,
): CommandHit[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (terms.length === 0) return commands.map((command) => ({ command, score: 1 }))

  const hits: CommandHit[] = []
  for (const command of commands) {
    const haystack = `${resolveTitle(command)} ${command.id}`
    let total = 0
    let matched = true
    for (const term of terms) {
      const score = fuzzyScore(haystack, term)
      if (score <= 0) {
        matched = false
        break
      }
      total += score
    }
    if (matched) hits.push({ command, score: total })
  }
  return hits.sort((a, b) => b.score - a.score)
}
