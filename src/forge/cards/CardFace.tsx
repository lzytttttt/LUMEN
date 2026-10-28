/**
 * forge/cards/CardFace.tsx —— 幕卡正面：剪影 + 卡名 + 标题 + 序号 + 角标（02 §5.2、03 §2.3）。
 *
 * 卡面不 import recipes.ts：字形是编译期常量，零排版成本、首帧即出（02 §6）。
 * 尺寸由 forge.css 按卡档给（常档 168×224 / 紧凑档 190×168），这里只排内容。
 */
import type { CardFaceProps } from '../ui'
import { useT, type MessageKey } from '@/i18n'
import { CARD_RARITY, Glyph } from './glyphs'

/** 标题截断：常档 ≤12 字、紧凑档 ≤8 字（02 §5.2 / 03 §2.4）。 */
const TITLE_LIMIT = 12
const TITLE_LIMIT_COMPACT = 8

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

export function CardFace(props: CardFaceProps) {
  const t = useT()
  const { index, total, recipe, headline, compact, locked, duplicate, warn, error, status, badge } = props
  const name = t(`forge.card.${recipe}` as MessageKey)
  const title = clip(headline, compact ? TITLE_LIMIT_COMPACT : TITLE_LIMIT)
  const removable = index > 0 && index < total - 1 && total >= 4
  const label = [t('forge.a11y.card', { n: index + 1 }), name]
  if (error) label.push(t('forge.gate.stuck'))
  else if (warn) label.push(t('forge.gate.warn'))
  if (duplicate >= 2) label.push(t('forge.deal.dup', { count: duplicate }))

  return (
    <article
      className={`forge-card${compact ? ' forge-card--compact' : ''}${props.selected ? ' is-selected' : ''}${
        locked ? ' is-locked' : ''
      }${error ? ' is-bad' : warn ? ' is-warned' : ''}`}
      data-forge-card
      data-card-recipe={recipe}
      data-card-status={status}
      data-card-index={index}
      data-card-lock={locked ?? undefined}
      data-card-dup={duplicate >= 2 ? duplicate : undefined}
      role="option"
      aria-selected={props.selected ?? false}
      aria-label={props.labelledBy ? undefined : label.join(' ')}
      aria-labelledby={props.labelledBy}
      title={headline}
      tabIndex={props.selected ? 0 : -1}
      onClick={props.onOpen}
      onKeyDown={props.onKeyDown}
    >
      <span className="forge-card__art">
        <Glyph recipe={recipe} size={compact ? 104 : 92} />
        {locked ? (
          <span className="forge-card__lock" data-card-lock-flag={locked}>
            {locked === 'first' ? t('forge.deal.lockFirst') : t('forge.deal.lockLast')}
          </span>
        ) : null}
        {error ? (
          <span className="forge-card__mark" data-severity="error" aria-hidden="true" />
        ) : warn ? (
          <span className="forge-card__mark" data-severity="warn" aria-hidden="true" />
        ) : null}
        {badge === 'more3d' ? (
          <span className="forge-card__badge" data-forge-more3d>
            {t('forge.deal.more3d')}
          </span>
        ) : null}
      </span>

      <span className="forge-card__meta">
        <span className="forge-card__row">
          <span className="forge-card__name">{name}</span>
          {duplicate >= 2 ? (
            <span className="forge-card__dup" data-card-dup-flag>
              {t('forge.deal.dup', { count: duplicate })}
            </span>
          ) : null}
        </span>
        <span className="forge-card__title" data-card-title>
          {title}
        </span>
      </span>

      <span className="forge-card__no" aria-hidden="true">
        {String(index + 1).padStart(2, '0')}
      </span>

      {/* 稀有度点：只画点、不出字（09 §2.2 允许） */}
      <span className="forge-card__dots" data-rarity={CARD_RARITY[recipe] ?? 1} aria-hidden="true">
        {Array.from({ length: CARD_RARITY[recipe] ?? 1 }, (_, dot) => (
          <span key={dot} />
        ))}
      </span>

      {removable ? (
        <button
          type="button"
          className="forge-card__remove"
          aria-label={t('forge.a11y.remove', { n: index + 1 })}
          tabIndex={props.selected ? 0 : -1}
          onClick={(event) => {
            event.stopPropagation()
            props.onRemove?.()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Delete' || event.key === 'Backspace') event.stopPropagation()
          }}
        >
          ×
        </button>
      ) : null}
    </article>
  )
}
