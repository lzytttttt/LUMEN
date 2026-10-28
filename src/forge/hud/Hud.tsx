/**
 * forge/hud/Hud.tsx —— 顶栏只放 5 个对象：返回 / 标题 / 计数·连击·等级 / 档位 / 语言（02 §3.2）。
 *
 * 不用卡片、不描边，只有 1px 分隔线与 4% 透明底：舞台是唯一主角。
 * 这里的数字与控件都不带 `data-forge-text`——F-02 的系统文案预算只数 Seed 的 5 组 + 主按钮。
 */
import { useT } from '@/i18n'
import type { HudProps } from '../ui'

export function Hud(props: HudProps) {
  const t = useT()
  const { mark, title, done, total, combo, level, tier, busy, canClose } = props
  return (
    <header className="forge-hud" data-forge-hud data-hud-mark={mark} aria-busy={busy}>
      <button
        type="button"
        className="forge-hud__back"
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
