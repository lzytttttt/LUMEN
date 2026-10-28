/**
 * forge/stage/Deal.tsx —— 大纲（deal）：一屏看完的卡阵（02 §5.2 / 04 §6.1）。
 *
 * 3–12 幕 4 列 × 3 行（卡 168×224，gap 14，总 714×700）；
 * 13–20 幕 5 列 × 4 行紧凑档（卡 190×168，gap 12，总 998×708）。两档都不滚动。
 *
 * 首末锁：首幕恒 cover、末幕恒 closing——锁卡不可删、不可换类，配方环只给同类项。
 * 换卡是零网络、不计分的本地动作（03 §3.3），状态机只提供「下一张」，所以这里循环点到目标。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useT } from '@/i18n'
import type { RecipeId } from '@/schema/deck'
import { CardFace } from '../cards/CardFace'
import { RecipeRing } from '../cards/recipeRing'
import { GLYPH_RECIPES } from '../cards/glyphs'
import type { DealProps } from '../ui'

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export function Deal(props: DealProps) {
  const t = useT()
  const { slides } = props
  const compact = slides.length > 12
  const [focus, setFocus] = useState(0)
  const [ring, setRing] = useState<number | null>(null)
  const [dealing, setDealing] = useState(true)

  useEffect(() => {
    // 发牌动画只在新摊开大纲时播一次（mock：55ms×11 + 620ms）；之后换卡/换序不再重播。
    const timer = window.setTimeout(() => setDealing(false), 12 * 55 + 700)
    return () => window.clearTimeout(timer)
  }, [])
  const listRef = useRef<HTMLDivElement>(null)
  /** 只有键盘/程序导航才抢焦点，避免每次重绘把指针用户的焦点拽走。 */
  const wantFocus = useRef(true)

  const duplicates = useMemo(() => {
    const counts = new Map<RecipeId, number>()
    for (const slide of slides) counts.set(slide.recipe, (counts.get(slide.recipe) ?? 0) + 1)
    return counts
  }, [slides])

  /** 系统裁剪的 3D 幕（来自 normalizeOutline）；用户自己关开关的幕不在此列（03 §3.4）。 */
  const cropped = useMemo(() => new Set(props.cropped3d ?? []), [props.cropped3d])

  useEffect(() => {
    setFocus((value) => clamp(value, 0, Math.max(slides.length - 1, 0)))
  }, [slides.length])

  const cardOf = useCallback(
    (index: number) => listRef.current?.querySelector<HTMLElement>(`[data-card-index="${index}"]`) ?? null,
    [],
  )

  /**
   * 焦点不能掉到 body：卡阵重排/删幕会让 focus 节点卸载，
   * 一旦焦点落到 body，`.forge` 上的整个键盘层（含 Esc）就收不到事件了。
   * 所以只在「焦点已不在卡阵里」时把焦点收回当前卡。
   */
  useEffect(() => {
    const active = document.activeElement
    const inside = active instanceof HTMLElement && active.closest('[data-forge-deal]') !== null
    if (inside && !wantFocus.current) return
    wantFocus.current = false
    cardOf(focus)?.focus({ preventScroll: true })
  }, [cardOf, focus, ring, slides.length])

  const go = useCallback(
    (next: number) => {
      wantFocus.current = true
      setFocus(clamp(next, 0, Math.max(slides.length - 1, 0)))
    },
    [slides.length],
  )

  const remove = useCallback(
    (index: number) => {
      if (slides.length < 4 || index === 0 || index >= slides.length - 1) return
      wantFocus.current = true
      setFocus((value) => clamp(value > index ? value - 1 : value, 0, slides.length - 2))
      props.onRemove(index)
    },
    [props, slides.length],
  )

  /** 换位：卡阵会重排并重建节点，焦点必须跟着被移动的那张卡走（否则键盘链路断掉）。 */
  const move = useCallback(
    (index: number, delta: number) => {
      const to = clamp(index + delta, 1, slides.length - 2)
      if (to === index) return
      wantFocus.current = true
      setFocus(to)
      props.onMove(index, to)
    },
    [props, slides.length],
  )

  const onCardKeyDown = (index: number) => (event: KeyboardEvent<HTMLElement>) => {
    const alt = event.altKey
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        if (alt) move(index, 1)
        else go(index + 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        if (alt) move(index, -1)
        else go(index - 1)
        break
      case 'Home':
        event.preventDefault()
        go(0)
        break
      case 'End':
        event.preventDefault()
        go(slides.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        setRing(index)
        break
      case 'Delete':
      case 'Backspace':
        event.preventDefault()
        remove(index)
        break
      default:
        break
    }
  }

  /** 选环里的同类项：状态机只有「下一张」，所以按环序循环 dispatch 到位。 */
  const pick = (index: number, recipe: RecipeId) => {
    const from = GLYPH_RECIPES.indexOf(slides[index]?.recipe ?? 'statement')
    const to = GLYPH_RECIPES.indexOf(recipe)
    if (from < 0 || to < 0 || from === to) return
    const steps = (to - from + GLYPH_RECIPES.length) % GLYPH_RECIPES.length
    for (let i = 0; i < steps; i += 1) props.onSwap(index)
  }

  const missingCover = slides.length > 0 && slides[0].recipe !== 'cover'
  const missingClose = slides.length > 0 && slides[slides.length - 1].recipe !== 'closing'

  return (
    <section className="forge-deal" data-forge-screen="deal" data-card-tier={compact ? 'compact' : 'normal'}>
      <header className="forge-deal__head">
        <span className="forge-deal__count" data-forge-text>
          {t('forge.deal.count', { count: slides.length })}
        </span>
        {missingCover ? (
          <span className="forge-deal__note" data-deal-note="cover">
            {t('forge.deal.missingCover')}
          </span>
        ) : null}
        {missingClose ? (
          <span className="forge-deal__note" data-deal-note="close">
            {t('forge.deal.missingClose')}
          </span>
        ) : null}
        <button type="button" className="forge-ghost forge-deal__back" onClick={props.onBack}>
          {t('forge.deal.back')}
        </button>
      </header>

      <div
        ref={listRef}
        className={`forge-deal__grid${compact ? ' forge-deal__grid--compact' : ''}${dealing ? ' is-dealing' : ''}`}
        role="listbox"
        aria-label={t('forge.a11y.cards')}
        data-forge-text
        data-cols={compact ? 5 : 4}
        data-forge-deal
      >
        {slides.map((slide, index) => (
          <div
            className="forge-deal__cell"
            role="presentation"
            key={`${slide.recipe}-${index}`}
            style={{ ['--i' as string]: index }}
          >
            <CardFace
              index={index}
              total={slides.length}
              recipe={slide.recipe}
              headline={slide.headline}
              status={slide.status}
              warn={slide.warns.length > 0}
              error={slide.errors.length > 0}
              locked={index === 0 ? 'first' : index === slides.length - 1 ? 'last' : null}
              duplicate={duplicates.get(slide.recipe) ?? 1}
              compact={compact}
              selected={focus === index}
              badge={cropped.has(index) ? 'more3d' : null}
              onOpen={() => setRing(index)}
              onRemove={() => remove(index)}
              onKeyDown={onCardKeyDown(index)}
            />
            {ring === index ? (
              <RecipeRing
                current={slide.recipe}
                index={index}
                total={slides.length}
                onPick={(recipe) => pick(index, recipe)}
                onClose={() => {
                  setRing(null)
                  wantFocus.current = true
                  window.requestAnimationFrame(() => cardOf(index)?.focus({ preventScroll: true }))
                }}
              />
            ) : null}
          </div>
        ))}
      </div>

      <button type="button" className="forge-deal__add" onClick={props.onAdd} aria-label={t('forge.deal.add')}>
        <span aria-hidden="true">+</span>
      </button>
    </section>
  )
}
