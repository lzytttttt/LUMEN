/**
 * forge/steps.ts —— 五段流程的唯一读数（v0.3.0）。
 *
 * HUD 上的「输入 → 大纲 → 生成 → 检查 → 播放」不在各段自己画，
 * 而是从 `forgeMark()` 推出来：段与段之间换场时，只有这五个节点会变，
 * 用户因此始终知道自己在一条线的哪一段（而不是看左下角的七根柱子猜）。
 *
 * 纯函数、零依赖，单测可直接喂 mark 序列。
 */

/** 五个用户可见阶段（与 i18n `forge.steps.*` 一一对应）。 */
export const FORGE_STEPS = ['seed', 'deal', 'cast', 'gate', 'premiere'] as const
export type ForgeStepId = (typeof FORGE_STEPS)[number]

export type ForgeStepState = 'done' | 'on' | 'todo'

/** `forgeMark()` 的取值域；`assemble` 是铸造中的中间态，归到「生成」。 */
export type ForgeMark = ForgeStepId | 'assemble'

/** mark → 五段里的下标（assemble = 生成段进行中）。 */
export function stepIndex(mark: ForgeMark): number {
  switch (mark) {
    case 'seed':
      return 0
    case 'deal':
      return 1
    case 'cast':
    case 'assemble':
      return 2
    case 'gate':
      return 3
    case 'premiere':
      return 4
    default:
      return 0
  }
}

/** 某一段相对当前 mark 的状态：已走过 / 正在 / 未到。 */
export function stepState(mark: ForgeMark, index: number): ForgeStepState {
  const current = stepIndex(mark)
  if (index < current) return 'done'
  if (index === current) return 'on'
  return 'todo'
}

/** 五段状态快照（HUD 渲染一次取一份，不做逐段查询）。 */
export function stepStates(mark: ForgeMark): ForgeStepState[] {
  return FORGE_STEPS.map((_, index) => stepState(mark, index))
}
