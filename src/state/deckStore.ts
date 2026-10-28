/**
 * deckStore.ts —— 演示数据的唯一可写入口。
 *
 * 设计：
 * - 所有修改走 `update(label, recipe)`，immer produceWithPatches 产出补丁；
 * - 历史是「补丁对」栈（100% 可撤销，内存与改动量成正比）；
 * - 一次拖拽/AI 批量插入用 `transaction()` 合并为一步；
 * - 资产不进 deck（见 assets/assetStore.ts），避免历史膨胀；
 * - 只读 deck、只写 ops：组件不要直接改对象。
 */
import { create } from 'zustand'
import { applyPatches, enablePatches, produceWithPatches, setAutoFreeze, type Patch } from 'immer'
import type { Deck } from '@/schema/deck'

enablePatches()
// 允许草稿外的地方持有引用而不炸；约束靠 ops 与类型，而不是运行时冻结。
setAutoFreeze(false)

const HISTORY_LIMIT = 200
const COALESCE_MS = 650

export interface HistoryEntry {
  label: string
  patches: Patch[]
  inverse: Patch[]
  at: number
  coalesceKey?: string
}

export interface DeckStoreState {
  deck: Deck
  past: HistoryEntry[]
  future: HistoryEntry[]
  group: HistoryEntry | null
  revision: number
  setDeck: (deck: Deck, opts?: { resetHistory?: boolean }) => void
  update: (label: string, recipe: (draft: Deck) => void, opts?: { coalesceKey?: string }) => void
  beginGroup: (label: string) => void
  endGroup: () => void
  transaction: (label: string, fn: () => void) => void
  undo: () => void
  redo: () => void
  clearHistory: () => void
}

export const useDeckStore = create<DeckStoreState>((set, get) => ({
  deck: null as unknown as Deck,
  past: [],
  future: [],
  group: null,
  revision: 0,

  setDeck: (deck, opts) =>
    set((state) => ({
      deck,
      past: opts?.resetHistory === false ? state.past : [],
      future: opts?.resetHistory === false ? state.future : [],
      group: null,
      revision: state.revision + 1,
    })),

  update: (label, recipe, opts) => {
    const state = get()
    if (!state.deck) return
    const [next, patches, inverse] = produceWithPatches(state.deck, (draft) => {
      recipe(draft)
      draft.meta.updatedAt = Date.now()
    })
    if (patches.length === 0) return

    const at = Date.now()
    const coalesceKey = opts?.coalesceKey

    if (state.group) {
      const group: HistoryEntry = {
        ...state.group,
        patches: [...state.group.patches, ...patches],
        // 逆补丁要倒着来：后发生的改动先撤销。
        inverse: [...inverse, ...state.group.inverse],
        at,
      }
      set({ deck: next, group, revision: state.revision + 1 })
      return
    }

    const last = state.past[state.past.length - 1]
    if (coalesceKey && last && last.coalesceKey === coalesceKey && at - last.at < COALESCE_MS) {
      const merged: HistoryEntry = {
        ...last,
        patches: [...last.patches, ...patches],
        inverse: [...inverse, ...last.inverse],
        at,
      }
      set({
        deck: next,
        past: [...state.past.slice(0, -1), merged],
        future: [],
        revision: state.revision + 1,
      })
      return
    }

    const entry: HistoryEntry = { label, patches, inverse, at, coalesceKey }
    set({
      deck: next,
      past: [...state.past, entry].slice(-HISTORY_LIMIT),
      future: [],
      revision: state.revision + 1,
    })
  },

  beginGroup: (label) => {
    if (get().group) return
    set({ group: { label, patches: [], inverse: [], at: Date.now() } })
  },

  endGroup: () => {
    const { group, past, future } = get()
    if (!group) return
    if (group.patches.length === 0) {
      set({ group: null })
      return
    }
    set({ group: null, past: [...past, group].slice(-HISTORY_LIMIT), future: [] })
  },

  transaction: (label, fn) => {
    const store = get()
    store.beginGroup(label)
    try {
      fn()
    } finally {
      get().endGroup()
    }
  },

  undo: () => {
    const { past, future, deck } = get()
    if (past.length === 0) return
    const entry = past[past.length - 1]
    const nextDeck = applyPatches(deck, entry.inverse)
    set({
      deck: nextDeck,
      past: past.slice(0, -1),
      future: [...future, entry],
      revision: get().revision + 1,
    })
  },

  redo: () => {
    const { past, future, deck } = get()
    if (future.length === 0) return
    const entry = future[future.length - 1]
    const nextDeck = applyPatches(deck, entry.patches)
    set({
      deck: nextDeck,
      past: [...past, entry],
      future: future.slice(0, -1),
      revision: get().revision + 1,
    })
  },

  clearHistory: () => set({ past: [], future: [], group: null }),
}))

export const canUndo = (s: DeckStoreState) => s.past.length > 0
export const canRedo = (s: DeckStoreState) => s.future.length > 0
