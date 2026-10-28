/**
 * forge/cards/recipeRing.tsx —— 12 配方选择环（02 §5.2）：选中即换 recipe，保留标题与要点。
 *
 * 首末锁只给同类项（首幕只留 cover、末幕只留 closing）；换卡是零网络、不计分动作（03 §3.3），
 * 所以环里没有任何确认步骤。`Esc` 收起、方向键换项、`Enter` 选中。
 */
import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useT, type MessageKey } from '@/i18n'
import type { RecipeId } from '@/schema/deck'
import { GLYPH_RECIPES, Glyph } from './glyphs'

export interface RecipeRingProps {
  current: RecipeId
  index: number
  total: number
  onPick: (recipe: RecipeId) => void
  onClose: () => void
}

export function RecipeRing({ current, index, total, onPick, onClose }: RecipeRingProps) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const lockedFirst = index === 0
  const lockedLast = index === total - 1
  const locked = lockedFirst || lockedLast

  useEffect(() => {
    const node = ref.current?.querySelector<HTMLElement>('[aria-checked="true"]:not([disabled])')
    node?.focus({ preventScroll: true })
  }, [])

  /**
   * 锁卡「只给同类项」：首幕只留 cover、末幕只留 closing。
   * 状态机的 `swap` 拒绝 index 0 / 末位，所以锁卡这一环只呈现当前这一张（不留点不动的死按钮）；
   * 缺封面 / 缺落幕的真实解法在 `state.ts`（Lead 所有），UI 不越权改契约。
   */
  const items = locked ? GLYPH_RECIPES.filter((recipe) => recipe === current) : GLYPH_RECIPES

  const step = (event: KeyboardEvent<HTMLDivElement>, delta: number) => {
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])
    if (nodes.length === 0) return
    const at = nodes.indexOf(document.activeElement as HTMLButtonElement)
    const next = nodes[(at + delta + nodes.length) % nodes.length]
    event.preventDefault()
    next?.focus()
  }

  return (
    <div
      ref={ref}
      className="forge-ring"
      data-forge-ring
      data-ring-locked={locked ? '1' : '0'}
      role="menu"
      aria-label={t('forge.deal.swap')}
      style={{ ['--ring-cols' as string]: Math.min(items.length, 4) }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          event.preventDefault()
          onClose()
          return
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') step(event, 1)
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') step(event, -1)
        else if (event.key === 'Tab') event.stopPropagation()
      }}
    >
      {items.map((recipe) => (
        <button
          key={recipe}
          type="button"
          role="menuitemradio"
          aria-checked={recipe === current}
          data-recipe={recipe}
          className={`forge-ring__item${recipe === current ? ' is-on' : ''}${locked ? ' is-locked' : ''}`}
          onClick={() => {
            onPick(recipe)
            onClose()
          }}
        >
          <Glyph recipe={recipe} size={40} />
          <span className="forge-ring__name">{t(`forge.card.${recipe}` as MessageKey)}</span>
        </button>
      ))}
    </div>
  )
}
