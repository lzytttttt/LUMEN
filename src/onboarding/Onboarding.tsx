/**
 * onboarding/Onboarding.tsx —— 首启三步（01 §8：3 步内出成果，不写引导长文）。
 *
 * 不阻塞画布：右下角一张小卡，三步只奖励真实动作——
 * 1 打开台面（forge 挂载）、2 生成一套（deck done）、3 播放（进全屏）。
 * 三步完成或点「跳过」把 `settings.onboarded` 写 true；`?onboard=1/0` 可强制显示/隐藏。
 */
import { useEffect, useState } from 'react'
import { useT } from '@/i18n'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { openForge } from '@/forge/ForgeHost'
import { FORGE_STEP_EVENT, onForgeStep, type ForgeStep } from './events'
import './onboarding.css'

export { markForgeStep, FORGE_STEP_EVENT } from './events'
export type { ForgeStep } from './events'

const STEPS: ForgeStep[] = [1, 2, 3]

export function Onboarding() {
  const t = useT()
  const onboarded = useSettingsStore((s) => s.onboarded)
  const setOnboarded = useSettingsStore((s) => s.setOnboarded)
  const mode = useUiStore((s) => s.mode)
  const [done, setDone] = useState<ForgeStep[]>([])

  const force = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('onboard') : null
  const visible = force === '1' || (force !== '0' && !onboarded)

  useEffect(() => {
    return onForgeStep((step) => {
      setDone((current) => (current.includes(step) ? current : ([...current, step].sort() as ForgeStep[])))
    })
  }, [])

  useEffect(() => {
    if (done.length < STEPS.length || onboarded) return
    const timer = window.setTimeout(() => setOnboarded(true), 900)
    return () => window.clearTimeout(timer)
  }, [done.length, onboarded, setOnboarded])

  if (!visible || mode === 'forge' || mode === 'play') return null

  const complete = done.length >= STEPS.length
  const start = () => openForge('empty', t('forge.seed.sample1'))

  return (
    <aside className="onboard" data-onboard="1" data-complete={complete ? '1' : '0'}>
      <header className="onboard__head">
        <strong>{t('onboard.title')}</strong>
        <button type="button" className="onboard__skip" onClick={() => setOnboarded(true)}>
          {t('onboard.skip')}
        </button>
      </header>

      <ol className="onboard__list">
        {STEPS.map((step) => (
          <li key={step} data-done={done.includes(step) ? '1' : '0'}>
            <span className="onboard__dot" aria-hidden="true">
              {done.includes(step) ? '✓' : step}
            </span>
            <span className="onboard__text">
              <b>{t(`onboard.step${step}` as 'onboard.step1')}</b>
              <small>{t(`onboard.hint${step}` as 'onboard.hint1')}</small>
            </span>
          </li>
        ))}
      </ol>

      {complete ? (
        <span className="onboard__done">{t('onboard.done')}</span>
      ) : (
        <button type="button" className="onboard__cta" onClick={start}>
          {t('onboard.start')}
        </button>
      )}
    </aside>
  )
}
