/**
 * forge/stage/Seed.tsx —— 输入（seed）：一句话 + 3 张示例卡 + 三组刻度（02 §5.1）。
 *
 * 主按钮在 ForgeApp 的 dock 上（这里不画第二枚「生成大纲」）。
 * 文字预算（02 §8）：输入 1 + 示例组 1 + 幕数组 1 + 时长组 1 + 视觉开关组 1 = 5，
 * 加上 dock 的主按钮恰好 6；续上一套 / 清空 / 离线徽标都不计入文字预算区块（D5）。
 */
import { useCallback, useEffect, useRef } from 'react'
import { useT, type MessageKey } from '@/i18n'
import { THEME_IDS, getTheme } from '@/themes'
import { Materials } from './Materials'
import type { SeedProps } from '../ui'

const SAMPLES = ['sample1', 'sample2', 'sample3'] as const
const LENGTHS = [
  { length: 'short', label: '6' },
  { length: 'normal', label: '9' },
  { length: 'deep', label: '12' },
] as const
const MINUTES = [5, 10, 20] as const

/** 受众五项（v0.2.5 §1 动作 2）：空串 = 不指定。 */
const AUDIENCES: { value: string; key: MessageKey }[] = [
  { value: 'exec', key: 'forge.seed.audienceExec' },
  { value: 'team', key: 'forge.seed.audienceTeam' },
  { value: 'client', key: 'forge.seed.audienceClient' },
  { value: 'class', key: 'forge.seed.audienceClass' },
]

/** 大字：12 字以内 64px，往后线性收到 42px（02 §5.1「56/64，随字数 42–64 自适应」）。 */
function fontOf(prompt: string, en: boolean): number {
  const width = en ? prompt.trim().length * 0.62 : prompt.trim().length
  if (width <= 12) return 64
  return Math.round(Math.max(42, 64 - (width - 12) * 1.35))
}

export function Seed(props: SeedProps) {
  const t = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const fieldRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = inputRef.current
    if (!node) return
    node.focus({ preventScroll: true })
    // ForgeApp 的入场焦点按文档顺序查找，会先命中顶栏返回键；起念屏必须落在输入上。
    // 只在焦点仍不在本屏时补一次，不跟用户的选择抢。
    const id = window.requestAnimationFrame(() => {
      if (!node.isConnected || document.activeElement === node) return
      const active = document.activeElement
      if (active instanceof HTMLElement && active.closest('[data-forge-screen="seed"]')) return
      node.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(id)
  }, [])

  /** 空输入：输入行 1px 横抖 120ms，不出现任何文字（02 §5.1 / §11）。 */
  const shake = useCallback(() => {
    const node = fieldRef.current
    if (!node?.animate) return
    node.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-1px)' },
        { transform: 'translateX(1px)' },
        { transform: 'translateX(0)' },
      ],
      { duration: 120, easing: 'linear' },
    )
  }, [])

  const submit = () => {
    if (props.busy) return
    if (props.prompt.trim() === '') {
      shake()
      return
    }
    props.onSubmit()
  }

  const authedSettings = props.error?.key === 'forge.error.auth' || props.error?.key === 'forge.error.notConfigured'
  const excusedRetry = props.error?.key === 'forge.error.aborted'

  return (
    <section className="forge-seed" data-forge-screen="seed" data-offline={props.offline ? '1' : '0'} aria-busy={props.busy}>
      <div className="forge-seed__core">
        <div className="forge-seed__line">
          <div ref={fieldRef} className="forge-seed__field">
            <input
              ref={inputRef}
              className="forge-seed__input"
              data-forge-text
              data-forge-autofocus
              type="text"
              value={props.prompt}
              placeholder={t('forge.seed.placeholder')}
              aria-label={t('forge.seed.placeholder')}
              readOnly={props.busy}
              spellCheck={false}
              autoComplete="off"
              maxLength={400}
              style={{ fontSize: `${fontOf(props.prompt, props.lang === 'en')}px` }}
              onChange={(event) => props.onPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submit()
                }
              }}
            />
          </div>
        </div>

        <div className="forge-seed__samples" role="group" aria-label={t(`forge.seed.${SAMPLES[0]}`)} data-forge-text>
          {SAMPLES.map((sample) => (
            <button
              key={sample}
              type="button"
              className="forge-seed__sample"
              onClick={() => {
                props.onPrompt(t(`forge.seed.${sample}`))
                inputRef.current?.focus({ preventScroll: true })
              }}
            >
              {t(`forge.seed.${sample}`)}
            </button>
          ))}
        </div>
      </div>

      {/*
       * v0.2.5 §1 动作 1/2：材料先于提示词，受众与预设紧随其后。
       * 这一整段是 ghost 级（11px 小字 + 1px 线），不进文字预算区块（D5）。
       */}
      <div className="forge-seed__sources">
        <Materials
          materials={props.materials}
          busy={props.busy}
          onAdd={props.onMaterialAdd}
          onRemove={props.onMaterialRemove}
        />

        <div className="forge-seed__prefs">
          <span className="forge-pref" role="radiogroup" aria-label={t('forge.seed.audience')}>
            <span className="forge-pref__label">{t('forge.seed.audience')}</span>
            {AUDIENCES.map((item) => (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={props.audience === item.value}
                className={props.audience === item.value ? 'forge-pref__opt is-on' : 'forge-pref__opt'}
                data-audience={item.value}
                disabled={props.busy}
                onClick={() => props.onAudience(props.audience === item.value ? '' : item.value)}
              >
                {t(item.key)}
              </button>
            ))}
          </span>

          <span className="forge-pref" role="radiogroup" aria-label={t('forge.seed.theme')}>
            <span className="forge-pref__label">{t('forge.seed.theme')}</span>
            {THEME_IDS.map((id) => {
              const theme = getTheme(id)
              const on = props.themeId === id
              const name = theme.name[props.lang]
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={on ? 'forge-pref__theme is-on' : 'forge-pref__theme'}
                  data-theme-id={id}
                  data-theme-accent={theme.colors.accent}
                  aria-label={name}
                  title={name}
                  disabled={props.busy}
                  onClick={() => props.onTheme(id)}
                >
                  <span
                    className="forge-pref__dot"
                    aria-hidden="true"
                    style={{ background: theme.colors.accent }}
                  />
                  <span className="forge-pref__name">{name}</span>
                </button>
              )
            })}
          </span>

          {props.reuse.length > 0 ? (
            <span className="forge-pref" role="group" aria-label={t('forge.seed.reuse')}>
              <span className="forge-pref__label">{t('forge.seed.reuse')}</span>
              {props.reuse.slice(0, 3).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="forge-pref__reuse"
                  data-forge-reuse={entry.id}
                  title={entry.title}
                  disabled={props.busy}
                  onClick={() => props.onReuse(entry)}
                >
                  {entry.title}
                </button>
              ))}
            </span>
          ) : null}
        </div>
      </div>

      <div className="forge-seed__dials">
        {props.offline ? <span className="forge-seed__badge">{t('forge.seed.offline')}</span> : null}
        <span className="forge-seed__dial" role="radiogroup" aria-label="6 / 9 / 12" data-forge-text>
          {LENGTHS.map((item) => (
            <button
              key={item.length}
              type="button"
              role="radio"
              aria-checked={props.length === item.length}
              className={props.length === item.length ? 'forge-dial is-on' : 'forge-dial'}
              onClick={() => props.onOption({ length: item.length })}
            >
              {item.label}
            </button>
          ))}
        </span>

        <span className="forge-seed__dial" role="radiogroup" aria-label="5′ / 10′ / 20′" data-forge-text>
          {MINUTES.map((minute) => (
            <button
              key={minute}
              type="button"
              role="radio"
              aria-checked={props.durationMin === minute}
              className={props.durationMin === minute ? 'forge-dial is-on' : 'forge-dial'}
              onClick={() => props.onOption({ durationMin: minute })}
            >
              {`${minute}′`}
            </button>
          ))}
        </span>

        <span className="forge-seed__toggles" role="group" aria-label="SVG / 3D" data-forge-text>
          <button
            type="button"
            aria-pressed={props.includeSvg}
            aria-label="SVG"
            title="SVG"
            className={props.includeSvg ? 'forge-toggle is-on' : 'forge-toggle'}
            onClick={() => props.onOption({ includeSvg: !props.includeSvg })}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
              <rect x="2" y="3" width="12" height="10" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5 7.4h4.4M5 10h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            aria-pressed={props.include3d}
            aria-label="3D"
            title="3D"
            className={props.include3d ? 'forge-toggle is-on' : 'forge-toggle'}
            onClick={() => props.onOption({ include3d: !props.include3d })}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
              <path
                d="M8 2.4l5 2.9v5.4L8 13.6 3 10.7V5.3z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              <path d="M3 5.3L8 8.2l5-2.9M8 8.2v5.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          </button>
        </span>
      </div>

      <div className="forge-seed__ghost">
        {props.hasDraft ? (
          <button type="button" className="forge-ghost" onClick={props.onResume}>
            {t('forge.seed.resume')}
          </button>
        ) : null}
        {props.prompt !== '' ? (
          <button type="button" className="forge-ghost" onClick={props.onClear}>
            {t('forge.seed.clear')}
          </button>
        ) : null}
      </div>

      {props.error ? (
        <div className="forge-bubble" data-forge-error={props.error.code} role="alert">
          <span className="forge-bubble__text">{t(props.error.key)}</span>
          <button type="button" className="forge-bubble__action" onClick={props.onErrorAction}>
            {authedSettings
              ? t('forge.error.action.settings')
              : excusedRetry
                ? t('forge.error.action.back')
                : t('forge.error.action.retry')}
          </button>
          <button
            type="button"
            className="forge-bubble__close"
            aria-label={t('forge.a11y.close')}
            onClick={props.onErrorDismiss}
          >
            ×
          </button>
        </div>
      ) : null}
    </section>
  )
}
