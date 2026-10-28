/**
 * ops.ts —— 演示数据的全部写操作（唯一 API）。
 *
 * 规则：组件、AI、导出、面板都只通过 ops 改 deck；
 * 需要原子性的复合操作自己包 `transaction`。
 */
import type {
  Block,
  BlockType,
  ColorToken,
  Deck,
  Outline,
  RecipeId,
  Slide,
  ThemeColors,
  TransitionKind,
} from '@/schema/deck'
import { nextZ } from '@/schema/deck'
import { alignRects, distributeRects, roundRect, type AlignMode, type Rect } from '@/schema/geometry'
import { newId } from '@/schema/ids'
import { useDeckStore } from './deckStore'
import { useSelectionStore } from './selectionStore'
import { useUiStore } from './uiStore'
import { activeSlideIdOf } from './selectors'

const store = useDeckStore
const update = (label: string, recipe: (draft: Deck) => void, coalesceKey?: string) =>
  store.getState().update(label, recipe, coalesceKey ? { coalesceKey } : undefined)

function currentDeck(): Deck {
  return store.getState().deck
}

export function resolveSlideId(slideId?: string | null): string | null {
  const deck = currentDeck()
  if (!deck) return null
  return activeSlideIdOf(deck, slideId ?? useUiStore.getState().activeSlideId)
}

export function resolveSlide(slideId?: string | null): Slide | undefined {
  const deck = currentDeck()
  if (!deck) return undefined
  const id = resolveSlideId(slideId)
  return deck.slides.find((s) => s.id === id)
}

/* ------------------------------- 演示级 ------------------------------- */

export const deckOps = {
  setTitle(title: string) {
    update('set-title', (d) => {
      d.title = title.slice(0, 160)
    }, 'title')
  },

  setLang(lang: 'zh' | 'en') {
    update('set-lang', (d) => {
      d.lang = lang
    })
  },

  setTheme(themeId: string) {
    update('set-theme', (d) => {
      d.themeId = themeId
    })
  },

  setThemeOverride(patch: Partial<ThemeColors>) {
    update('theme-override', (d) => {
      d.themeOverrides = { ...(d.themeOverrides ?? {}), ...patch }
    }, 'theme-override')
  },

  resetThemeOverrides() {
    update('theme-reset', (d) => {
      d.themeOverrides = undefined
    })
  },

  setMetaPrompt(prompt: string) {
    update('set-prompt', (d) => {
      d.meta.prompt = prompt
    }, 'meta-prompt')
  },

  /** 整盘替换（导入、AI 生成整套、切换演示文件）。 */
  replaceDeck(deck: Deck, opts?: { resetHistory?: boolean }) {
    store.getState().setDeck(deck, opts)
    useUiStore.getState().setActiveSlide(deck.slides[0]?.id ?? null)
    useSelectionStore.getState().clearSelection()
  },

  /** 把大纲一次性落成 deck（AI 成稿用，单步撤销）。 */
  applyOutline(title: string, slides: Slide[], opts?: { replace?: boolean; prompt?: string }) {
    store.getState().transaction('ai-apply-outline', () => {
      update('ai-apply-outline', (d) => {
        d.title = title.slice(0, 160)
        if (opts?.prompt !== undefined) d.meta.prompt = opts.prompt
        d.meta.origin = 'ai'
        if (opts?.replace) d.slides = slides
        else d.slides = [...d.slides, ...slides]
      })
      const first = opts?.replace ? slides[0] : currentDeck().slides[0]
      if (first) useUiStore.getState().setActiveSlide(first.id)
      useSelectionStore.getState().clearSelection()
    })
  },
}

/* -------------------------------- 幕 -------------------------------- */

export const slideOps = {
  add(opts?: { at?: number; slide?: Slide; select?: boolean }): string {
    const slide = opts?.slide ?? emptySlideShape()
    update('add-slide', (d) => {
      const at = opts?.at ?? d.slides.length
      d.slides.splice(Math.max(0, Math.min(at, d.slides.length)), 0, slide)
    })
    if (opts?.select !== false) useUiStore.getState().setActiveSlide(slide.id)
    useSelectionStore.getState().clearSelection()
    return slide.id
  },

  insertAt(slide: Slide, at: number, select = true) {
    update('insert-slide', (d) => {
      d.slides.splice(Math.max(0, Math.min(at, d.slides.length)), 0, slide)
    })
    if (select) useUiStore.getState().setActiveSlide(slide.id)
  },

  duplicate(slideId?: string | null): string | undefined {
    const id = resolveSlideId(slideId)
    if (!id) return undefined
    let copyId: string | undefined
    update('duplicate-slide', (d) => {
      const index = d.slides.findIndex((s) => s.id === id)
      if (index < 0) return
      const source = d.slides[index]
      const copy: Slide = {
        ...structuredCloneSafe(source),
        id: newId('slide'),
        name: source.name,
      }
      copy.blocks = copy.blocks.map((b) => ({ ...b, id: newId(b.type) }))
      copyId = copy.id
      d.slides.splice(index + 1, 0, copy)
    })
    if (copyId) useUiStore.getState().setActiveSlide(copyId)
    return copyId
  },

  remove(slideId?: string | null) {
    const id = resolveSlideId(slideId)
    if (!id) return
    update('delete-slide', (d) => {
      if (d.slides.length <= 1) return
      const index = d.slides.findIndex((s) => s.id === id)
      if (index < 0) return
      d.slides.splice(index, 1)
      const nextSlide = d.slides[Math.max(0, index - 1)] ?? d.slides[0]
      if (nextSlide) useUiStore.getState().setActiveSlide(nextSlide.id)
    })
    useSelectionStore.getState().clearSelection()
  },

  move(from: number, to: number) {
    update('move-slide', (d) => {
      if (from === to || from < 0 || from >= d.slides.length) return
      const [moved] = d.slides.splice(from, 1)
      d.slides.splice(Math.max(0, Math.min(to, d.slides.length)), 0, moved)
    })
  },

  update(slideId: string | null | undefined, recipe: (slide: Slide) => void, label = 'update-slide') {
    const id = resolveSlideId(slideId)
    if (!id) return
    update(label, (d) => {
      const slide = d.slides.find((s) => s.id === id)
      if (slide) recipe(slide)
    })
  },

  setName(name: string) {
    slideOps.update(null, (s) => {
      s.name = name.slice(0, 120) || undefined
    }, 'slide-name')
  },

  setNotes(notes: string) {
    slideOps.update(null, (s) => {
      s.notes = notes || undefined
    }, 'slide-notes')
  },

  setTransition(kind: TransitionKind, ms?: number) {
    slideOps.update(null, (s) => {
      s.transition = { kind, ms: ms ?? s.transition.ms }
    }, 'slide-transition')
  },

  setBackground(kind: 'theme' | 'solid', color?: ColorToken) {
    slideOps.update(null, (s) => {
      s.background = { kind, color }
    })
  },

  setDuration(ms: number | undefined) {
    slideOps.update(null, (s) => {
      s.durationMs = ms
    }, 'slide-duration')
  },

  setRecipe(recipe: RecipeId | undefined) {
    slideOps.update(null, (s) => {
      s.recipe = recipe
    })
  },
}

function emptySlideShape(): Slide {
  return {
    id: newId('slide'),
    blocks: [],
    background: { kind: 'theme' },
    transition: { kind: 'fade', ms: 420 },
  }
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      /* fallthrough */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T
}

/* -------------------------------- 元素 -------------------------------- */

export const blockOps = {
  add(block: Block, slideId?: string | null) {
    const id = resolveSlideId(slideId)
    if (!id) return
    update('add-block', (d) => {
      const slide = d.slides.find((s) => s.id === id)
      if (!slide) return
      slide.blocks.push({ ...block, z: nextZ(slide.blocks) } as Block)
    })
    useSelectionStore.getState().setSelection([block.id])
  },

  addMany(blocks: Block[], slideId?: string | null, label = 'add-blocks') {
    const id = resolveSlideId(slideId)
    if (!id) return
    store.getState().transaction(label, () => {
      update(label, (d) => {
        const slide = d.slides.find((s) => s.id === id)
        if (!slide) return
        let z = nextZ(slide.blocks)
        for (const block of blocks) {
          slide.blocks.push({ ...block, z: z++ } as Block)
        }
      })
    })
    useSelectionStore.getState().setSelection(blocks.map((b) => b.id))
  },

  update(
    blockId: string,
    recipe: (block: Block) => void,
    opts?: { coalesceKey?: string; label?: string; slideId?: string | null },
  ) {
    const id = resolveSlideId(opts?.slideId)
    if (!id) return
    update(opts?.label ?? 'update-block', (d) => {
      const slide = d.slides.find((s) => s.id === id)
      const block = slide?.blocks.find((b) => b.id === blockId)
      if (block) recipe(block)
    }, opts?.coalesceKey)
  },

  updateOfType<T extends BlockType>(
    blockId: string,
    type: T,
    recipe: (block: Extract<Block, { type: T }>) => void,
    opts?: { coalesceKey?: string; label?: string; slideId?: string | null },
  ) {
    blockOps.update(
      blockId,
      (block) => {
        if (block.type === type) recipe(block as Extract<Block, { type: T }>)
      },
      opts,
    )
  },

  updateMany(
    blockIds: string[],
    recipe: (block: Block) => void,
    opts?: { coalesceKey?: string; label?: string; slideId?: string | null },
  ) {
    const id = resolveSlideId(opts?.slideId)
    if (!id) return
    const set = new Set(blockIds)
    update(opts?.label ?? 'update-blocks', (d) => {
      const slide = d.slides.find((s) => s.id === id)
      if (!slide) return
      for (const block of slide.blocks) if (set.has(block.id)) recipe(block)
    }, opts?.coalesceKey)
  },

  replace(block: Block, slideId?: string | null) {
    const id = resolveSlideId(slideId)
    if (!id) return
    update('replace-block', (d) => {
      const slide = d.slides.find((s) => s.id === id)
      if (!slide) return
      const index = slide.blocks.findIndex((b) => b.id === block.id)
      if (index >= 0) slide.blocks[index] = block
      else slide.blocks.push(block)
    })
  },

  remove(blockIds: string[], slideId?: string | null) {
    const id = resolveSlideId(slideId)
    if (!id) return
    const set = new Set(blockIds)
    update('delete-blocks', (d) => {
      const slide = d.slides.find((s) => s.id === id)
      if (!slide) return
      slide.blocks = slide.blocks.filter((b) => !set.has(b.id))
    })
    useSelectionStore.getState().clearSelection()
  },

  duplicate(blockIds: string[], slideId?: string | null) {
    const id = resolveSlideId(slideId)
    if (!id) return
    const set = new Set(blockIds)
    const created: string[] = []
    store.getState().transaction('duplicate-blocks', () => {
      update('duplicate-blocks', (d) => {
        const slide = d.slides.find((s) => s.id === id)
        if (!slide) return
        let z = nextZ(slide.blocks)
        const copies = slide.blocks
          .filter((b) => set.has(b.id))
          .map((b) => {
            const copy = { ...structuredCloneSafe(b), id: newId(b.type), x: b.x + 24, y: b.y + 24, z: z++ }
            created.push(copy.id)
            return copy as Block
          })
        slide.blocks.push(...copies)
      })
    })
    useSelectionStore.getState().setSelection(created)
  },

  setGeometry(updates: Array<{ id: string } & Rect>, opts?: { coalesceKey?: string; slideId?: string | null }) {
    const id = resolveSlideId(opts?.slideId)
    if (!id) return
    const map = new Map(updates.map((u) => [u.id, roundRect(u)]))
    update('move-resize', (d) => {
      const slide = d.slides.find((s) => s.id === id)
      if (!slide) return
      for (const block of slide.blocks) {
        const rect = map.get(block.id)
        if (!rect) continue
        block.x = rect.x
        block.y = rect.y
        block.w = rect.w
        block.h = rect.h
      }
    }, opts?.coalesceKey ?? 'geometry')
  },

  nudge(blockIds: string[], dx: number, dy: number, slideId?: string | null) {
    const id = resolveSlideId(slideId)
    if (!id) return
    const set = new Set(blockIds)
    update('nudge', (d) => {
      const slide = d.slides.find((s) => s.id === id)
      if (!slide) return
      for (const block of slide.blocks) {
        if (!set.has(block.id) || block.locked) continue
        block.x += dx
        block.y += dy
      }
    }, 'nudge')
  },

  reorderZ(blockIds: string[], mode: 'front' | 'back' | 'forward' | 'backward', slideId?: string | null) {
    const id = resolveSlideId(slideId)
    if (!id) return
    const set = new Set(blockIds)
    update('reorder-z', (d) => {
      const slide = d.slides.find((s) => s.id === id)
      if (!slide) return
      const sorted = [...slide.blocks].sort((a, b) => a.z - b.z)
      const moving = sorted.filter((b) => set.has(b.id))
      const rest = sorted.filter((b) => !set.has(b.id))
      let ordered: Block[]
      if (mode === 'front') ordered = [...rest, ...moving]
      else if (mode === 'back') ordered = [...moving, ...rest]
      else if (mode === 'forward') {
        ordered = [...sorted]
        for (let i = ordered.length - 2; i >= 0; i--) {
          if (set.has(ordered[i].id) && !set.has(ordered[i + 1].id)) {
            ;[ordered[i], ordered[i + 1]] = [ordered[i + 1], ordered[i]]
          }
        }
      } else {
        ordered = [...sorted]
        for (let i = 1; i < ordered.length; i++) {
          if (set.has(ordered[i].id) && !set.has(ordered[i - 1].id)) {
            ;[ordered[i], ordered[i - 1]] = [ordered[i - 1], ordered[i]]
          }
        }
      }
      ordered.forEach((block, index) => {
        block.z = index + 1
      })
      slide.blocks = ordered
    })
  },

  setFlag(blockIds: string[], flag: 'locked' | 'hidden', value?: boolean, slideId?: string | null) {
    const id = resolveSlideId(slideId)
    if (!id) return
    const set = new Set(blockIds)
    update('set-flag', (d) => {
      const slide = d.slides.find((s) => s.id === id)
      if (!slide) return
      for (const block of slide.blocks) {
        if (!set.has(block.id)) continue
        block[flag] = value ?? !block[flag]
      }
    })
  },

  setName(blockId: string, name: string) {
    blockOps.update(blockId, (block) => {
      block.name = name.slice(0, 120) || undefined
    }, { coalesceKey: 'block-name' })
  },

  align(blockIds: string[], mode: AlignMode, slideId?: string | null) {
    const id = resolveSlideId(slideId)
    if (!id) return
    const set = new Set(blockIds)
    update('align', (d) => {
      const slide = d.slides.find((s) => s.id === id)
      if (!slide) return
      const selected = slide.blocks.filter((b) => set.has(b.id))
      if (selected.length < 2) return
      const reference = selected[0]
      const rest = selected.slice(1)
      const aligned = alignRects(reference, rest, mode)
      rest.forEach((block, i) => {
        block.x = Math.round(aligned[i].x)
        block.y = Math.round(aligned[i].y)
      })
    })
  },

  distribute(blockIds: string[], axis: 'x' | 'y', slideId?: string | null) {
    const id = resolveSlideId(slideId)
    if (!id) return
    const set = new Set(blockIds)
    update('distribute', (d) => {
      const slide = d.slides.find((s) => s.id === id)
      if (!slide) return
      const selected = slide.blocks.filter((b) => set.has(b.id))
      if (selected.length < 3) return
      const placed = distributeRects(selected, axis)
      selected.forEach((block, i) => {
        if (axis === 'x') block.x = placed[i].x
        else block.y = placed[i].y
      })
    })
  },

  updateOptions(blockId: string, recipe: (block: Block) => void) {
    blockOps.update(blockId, recipe, { coalesceKey: `opts-${blockId}` })
  },
}

/* -------------------------------- 便捷 -------------------------------- */

export const historyOps = {
  undo() {
    store.getState().undo()
  },
  redo() {
    store.getState().redo()
  },
  transaction(label: string, fn: () => void) {
    store.getState().transaction(label, fn)
  },
}

export function applyOutlineSlides(outline: Outline, slides: Slide[], prompt?: string) {
  deckOps.applyOutline(outline.title, slides, { replace: true, prompt })
}

/** 读当前选中块（用于面板）。 */
export function selectedBlocks(): Block[] {
  const deck = currentDeck()
  const slide = deck.slides.find((s) => s.id === activeSlideIdOf(deck, useUiStore.getState().activeSlideId))
  const ids = new Set(useSelectionStore.getState().selectedBlockIds)
  return slide ? slide.blocks.filter((b) => ids.has(b.id)) : []
}
