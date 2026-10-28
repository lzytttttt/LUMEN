/** onboarding/events.ts —— 首启三步的事件契约（无依赖，避免 ForgeApp ↔ ForgeHost 循环）。 */
export const FORGE_STEP_EVENT = 'lumen:forge-step'

export type ForgeStep = 1 | 2 | 3

export function markForgeStep(step: ForgeStep): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<{ step: ForgeStep }>(FORGE_STEP_EVENT, { detail: { step } }))
}

export function onForgeStep(handler: (step: ForgeStep) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const listener = (event: Event) => {
    const step = (event as CustomEvent<{ step?: ForgeStep }>).detail?.step
    if (step === 1 || step === 2 || step === 3) handler(step)
  }
  window.addEventListener(FORGE_STEP_EVENT, listener)
  return () => window.removeEventListener(FORGE_STEP_EVENT, listener)
}
