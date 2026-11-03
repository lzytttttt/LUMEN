/**
 * forge/hud/Hud.tsx —— 顶栏只放 5 个对象：返回 / 标题 / 五段流程 / 计数·连击·等级 / 档位 / 语言（02 §3.2）。
 *
 * v0.3.0：把「我在哪一段」从各段自己的记号收回到一条五节点流程线上。
 * 流程线只读 `forgeMark()`（`steps.ts`），不引新状态、不参与任何交互 —— 它解释舞台，不抢舞台。
 * 这里的数字与控件都不带 `data-forge-text`——F-02 的系统文案预算只数 Seed 的 5 组 + 主按钮。
 */
import { useT } from '@/i18n'
import { FORGE_STEPS, stepStates } from '../steps'
import type { HudProps } from '../ui'

export function Hud(props: HudProps) {
  const t = useT()
  const { mark, title, done, total, combo, level, tier, busy, canClose } = props
  const states = stepStates(mark)
  return (
    <header className="forge-hud" data-forge-hud data-hud-mark={mark} aria-busy={busy}>
      <button
        type="button"
        className="forge-hud__back"
        data-act="close"
        aria-label={t('forge.a11y.close')}
        disabled={!canClose}
        onClick={props.onClose}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <path d="M10.4 3.2 5.6 8l4.8 4.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <span className="forge-hud__title" title={title || undefined}>
        {title}
      </span>

      {/* v0.3.0：五段流程线。只做读数，不做导航（点它换段会跨过未保存的边界）。 */}
      <ol className="forge-hud__steps" data-forge-steps aria-label={t('forge.a11y.steps')}>
        {FORGE_STEPS.map((step, index) => (
          <li
            key={step}
            className="forge-hud__step"
            data-forge-step={step}
            data-state={states[index]}
            aria-current={states[index] === 'on' ? 'step' : undefined}
          >
            <span className="forge-hud__step-mark" aria-hidden="true" />
            <span className="forge-hud__step-label">{t(`forge.steps.${step}`)}</span>
          </li>
        ))}
      </ol>

      <span className="forge-hud__meta">
        <span className="forge-hud__count" data-forge-count>
          {total > 0 ? `${done}/${total}` : '—'}
        </span>
        <span className="forge-hud__combo" data-forge-combo-chip data-on={combo >= 2 ? '1' : '0'}>
          {combo >= 2 ? t('forge.combo.count', { count: combo }) : ''}
        </span>
        <span className="forge-hud__level" data-on={level > 1 ? '1' : '0'}>
          {level > 1 ? t('forge.level.label', { n: level }) : ''}
        </span>
        <span className="forge-hud__tier" data-forge-tier-chip>
          {tier}
        </span>
      </span>

      <button
        type="button"
        className="forge-hud__lang"
        lang={props.lang === 'zh' ? 'en' : 'zh'}
        aria-label={props.lang === 'zh' ? 'EN' : '中'}
        title={props.lang === 'zh' ? 'EN' : '中'}
        onClick={props.onLang}
      >
        {props.lang === 'zh' ? 'EN' : '中'}
      </button>
    </header>
  )
}
