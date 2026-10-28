/**
 * toolStore.ts —— 画布工具态（选择 / 文本 / 矩形）。
 *
 * 故意不进 `uiStore`：它只服务画布交互，属于 stage-editor 的私有状态。
 * `T` / `R` 切工具后，在画布上按下即落一个新块，然后自动切回选择工具。
 */
import { create } from 'zustand'

export type StageTool = 'select' | 'text' | 'rect'

interface StageToolState {
  tool: StageTool
  setTool: (tool: StageTool) => void
}

export const useStageToolStore = create<StageToolState>((set) => ({
  tool: 'select',
  setTool: (tool) => set({ tool }),
}))

export function currentStageTool(): StageTool {
  return useStageToolStore.getState().tool
}

export function resetStageTool(): void {
  useStageToolStore.getState().setTool('select')
}
