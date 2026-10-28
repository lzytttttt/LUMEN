/** selectionStore.ts —— 选中集（与 deck 数据解耦，不进历史）。 */
import { create } from 'zustand'

interface SelectionState {
  selectedBlockIds: string[]
  hoveredBlockId: string | null
  editingBlockId: string | null
  setSelection: (ids: string[]) => void
  toggleSelection: (id: string, additive?: boolean) => void
  addToSelection: (ids: string[]) => void
  clearSelection: () => void
  setHovered: (id: string | null) => void
  setEditing: (id: string | null) => void
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedBlockIds: [],
  hoveredBlockId: null,
  editingBlockId: null,
  setSelection: (selectedBlockIds) => set({ selectedBlockIds }),
  toggleSelection: (id, additive = false) =>
    set((s) => {
      const has = s.selectedBlockIds.includes(id)
      if (!additive) return { selectedBlockIds: has ? [] : [id] }
      return {
        selectedBlockIds: has ? s.selectedBlockIds.filter((x) => x !== id) : [...s.selectedBlockIds, id],
      }
    }),
  addToSelection: (ids) =>
    set((s) => ({ selectedBlockIds: Array.from(new Set([...s.selectedBlockIds, ...ids])) })),
  clearSelection: () => set({ selectedBlockIds: [], editingBlockId: null }),
  setHovered: (hoveredBlockId) => set({ hoveredBlockId }),
  setEditing: (editingBlockId) => set({ editingBlockId }),
}))

export function useSelectedBlocks() {
  return useSelectionStore((s) => s.selectedBlockIds)
}
