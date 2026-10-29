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
import { useSettingsStore } from '@/state/settingsStore'
import { THEME_IDS, getTheme } from '@/themes'
import type { RecipeId } from '@/schema/deck'
import { CardFace } from '../cards/CardFace'
import { RecipeRing } from '../cards/recipeRing'
import { GLYPH_RECIPES } from '../cards/glyphs'
import type { DealProps } from '../ui'

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/** 标题硬上限与 reducer 对齐（§2 硬约束 3：headline 截 120）。 */
const HEADLINE_MAX = 120
/** 「这一幕想讲什么」上限与 `outlineSlideSchema.brief` 对齐（截 200）。 */
const BRIEF_MAX = 200

export function Deal(props: DealProps) {
  const t = useT()
  const lang = useSettingsStore((s) => s.lang)
  const { slides } = props
  const compact = slides.length > 12
  const [focus, setFocus] = useState(0)
  const [ring, setRing] = useState<number | null>(null)
  const [dealing, setDealing] = useState(true)
  /** 卡内标题的内联编辑（v0.2.5 §1 动作 3）：同一时刻只开一张。 */
  const [editing, setEditing] = useState<number | null>(null)
  const [headlineDraft, setHeadlineDraft] = useState('')
  const closingRef = useRef(false)

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

  /**
   * 卡内改标题（v0.2.5 §1 动作 3）：同一时刻只开一张，开的时候顺手收起配方环。
   * 焦点回收由 `wantFocus` 控制：输入期间一律不许把光标拽回卡片。
   */
  const openEdit = useCallback(
    (index: number) => {
      const slide = slides[index]
      if (!slide) return
      closingRef.current = false
      setRing(null)
      setFocus(index)
      setEditing(index)
      setHeadlineDraft(slide.headline)
    },
    [slides],
  )

  /** Enter / 失焦提交，Esc 取消；无论哪条路都把焦点还给这张卡，键盘链路不断。 */
  const closeEdit = useCallback(
    (commit: boolean) => {
      const index = editing
      if (index === null) return
      if (commit) {
        const value = headlineDraft.trim().slice(0, HEADLINE_MAX)
        if (value !== '' && value !== (slides[index]?.headline ?? '')) props.onHeadline(index, value)
      }
      setEditing(null)
      wantFocus.current = true
      window.requestAnimationFrame(() => cardOf(index)?.focus({ preventScroll: true }))
    },
    [cardOf, editing, headlineDraft, props, slides],
  )

  /** 要点（brief）：唯一的用户 → 生成侧指令通道（§1 动作 3），失焦即提交。 */
  const commitBrief = useCallback(
    (index: number, value: string) => {
      const next = value.trim().slice(0, BRIEF_MAX)
      if (next === (props.outline?.slides[index]?.brief ?? '')) return
      props.onBrief(index, next)
    },
    [props],
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
      case 'F2':
        // 只改标题，不动卡型：Enter 仍然是「换一张」（零网络、不计分）。
        event.preventDefault()
        openEdit(index)
        break
      default:
        if ((event.key === 'e' || event.key === 'E') && !alt && !event.ctrlKey && !event.metaKey) {
          event.preventDefault()
          openEdit(index)
        }
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
        {/* v0.2.5 §1 动作 2：大纲页头也能换设计预设（只在 seed/deal 有效，§2 硬约束 2）。 */}
        <span
          className="forge-deal__theme"
          data-deal-theme={props.themeId}
          role="radiogroup"
          aria-label={t('forge.deal.theme')}
        >
          <span className="forge-deal__theme-label">{t('forge.deal.theme')}</span>
          {THEME_IDS.map((id) => {
            const theme = getTheme(id)
            const on = props.themeId === id
            const name = theme.name[lang]
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                className={on ? 'forge-deal__dot is-on' : 'forge-deal__dot'}
                data-theme-id={id}
                data-theme-accent={theme.colors.accent}
                aria-label={name}
                title={name}
                onClick={() => props.onTheme(id)}
              >
                <span aria-hidden="true" style={{ background: theme.colors.accent }} />
              </button>
            )
          })}
        </span>
      </header>

      {/*
       * 要点编辑区（v0.2.5 §4 的 `data-brief-editor`）：跟着当前卡走，一屏只出现一个。
       * 失焦提交、Enter 提交、Esc 放弃；Esc 必须 stopPropagation，否则整台造幕台会关掉。
       */}
      <div className="forge-deal__brief" data-brief-editor={focus}>
        <span className="forge-deal__brief-label">{t('forge.deal.brief')}</span>
        <textarea
          key={`brief-${focus}`}
          className="forge-deal__brief-field"
          data-brief-field={focus}
          defaultValue={props.outline?.slides[focus]?.brief ?? ''}
          maxLength={BRIEF_MAX}
          rows={1}
          spellCheck={false}
          placeholder={t('forge.deal.briefHint')}
          aria-label={t('forge.deal.briefHint')}
          onBlur={(event) => commitBrief(focus, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              event.preventDefault()
              event.currentTarget.value = props.outline?.slides[focus]?.brief ?? ''
              event.currentTarget.blur()
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              event.stopPropagation()
              commitBrief(focus, event.currentTarget.value)
              event.currentTarget.blur()
            }
          }}
        />
      </div>

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
            onDoubleClick={() => openEdit(index)}
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
              onOpen={() => {
                setFocus(index)
                setRing(index)
              }}
              onRemove={() => remove(index)}
              onKeyDown={onCardKeyDown(index)}
            />

            {/* 改标题：点击铅笔、双击卡面、或按 F2 / E（Enter 仍是「换一张」）。 */}
            {editing !== index ? (
              <button
                type="button"
                className="forge-deal__pencil"
                data-deal-edit={index}
                tabIndex={-1}
                aria-label={slide.headline}
                title={slide.headline}
                onClick={(event) => {
                  event.stopPropagation()
                  openEdit(index)
                }}
              >
                <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true" focusable="false">
                  <path
                    d="M1.4 10.6l.5-2.3 5.6-5.6 1.8 1.8-5.6 5.6-2.3.5z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}

            {editing === index ? (
              <input
                className="forge-deal__edit"
                data-deal-edit-field={index}
                type="text"
                value={headlineDraft}
                maxLength={HEADLINE_MAX}
                spellCheck={false}
                autoComplete="off"
                autoFocus
                aria-label={slides[index].headline}
                onChange={(event) => setHeadlineDraft(event.target.value)}
                onBlur={() => {
                  // Enter / Esc 已经关过这一次编辑：卸载引起的 blur 不再提交一遍。
                  if (closingRef.current) {
                    closingRef.current = false
                    return
                  }
                  closeEdit(true)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    event.preventDefault()
                    closingRef.current = true
                    closeEdit(false)
                    return
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation()
                    closingRef.current = true
                    closeEdit(true)
                  }
                }}
              />
            ) : null}

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
