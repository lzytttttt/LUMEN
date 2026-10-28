/**
 * forge/ForgeApp.tsx —— 造幕台容器：状态机 + 编排 + 键盘/焦点 + 底部 HUD。
 *
 * 五段闭环：输入 → 大纲 → 生成（含装台与过检）→ 播放。
 * 用户屏幕上的词只有「输入 / 大纲 / 生成 / 检查 / 播放」与四个动词按钮（D13）。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { composeOutline, buildDeckFromOutline, rebuildOutlineSlide } from '@/ai/compose'
import { isAborted, isAiError, type AiErrorCode } from '@/ai/provider'
import type { Deck, Outline } from '@/schema/deck'
import { outlineSchema } from '@/schema/deck'
import { lintDeck, summarizeLint } from '@/lint/deckLint'
import { getTheme } from '@/themes'
import { useSettingsStore } from '@/state/settingsStore'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { deckOps } from '@/state/ops'
import { useT, type MessageKey } from '@/i18n'
import { kvDel, kvGet, kvSet } from '@/persistence/kv'
import { ForgeDraft, type ForgeDraftShape } from './draft'
import { initialForgeState, forgeMark, forgeReducer, doneSlides } from './state'
import { currentTier, isStillMode } from './fx/tier'
import { currentPacing } from './pacing'
import { raf } from './fx/raf'
import { playForgeSound, disposeSound } from './fx/sound'
import { recordDiagnostic } from './diagnostics'
import { markForgeStep } from '@/onboarding/events'
import { useForgeGame, type ForgeGameToast } from './game/useForgeGame'
import { Hud } from './hud/Hud'
import { Pulse } from './hud/Pulse'
import { FxToast } from './hud/FxToast'
import type { FxToastItem } from './ui'
import { Seed } from './stage/Seed'
import { Deal } from './stage/Deal'
import { Assemble } from './stage/Assemble'
import { Gate } from './stage/Gate'
import { Premiere } from './stage/Premiere'
import type { ForgeTier, ForgeStageEvent } from './types'
import './forge.css'

const ERROR_KEYS: Partial<Record<string, MessageKey>> = {
  notConfigured: 'forge.error.notConfigured',
  auth: 'forge.error.auth',
  network: 'forge.error.network',
  timeout: 'forge.error.timeout',
  badJson: 'forge.error.badJson',
  aborted: 'forge.error.aborted',
  emptyOutline: 'forge.error.emptyOutline',
  schemaFailed: 'forge.error.schemaFailed',
  storeDegraded: 'forge.error.storeDegraded',
  rateLimit: 'ai.error.rateLimit',
  quota: 'ai.error.quota',
  cors: 'ai.error.cors',
  streamBroken: 'ai.error.streamBroken',
  contextLength: 'ai.error.contextLength',
  modelNotFound: 'ai.error.modelNotFound',
}

function errorKeyOf(error: unknown): MessageKey {
  if (isAborted(error)) return 'forge.error.aborted'
  if (isAiError(error)) return ERROR_KEYS[error.code as AiErrorCode] ?? 'forge.error.badJson'
  return 'forge.error.network'
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface ForgeAppProps {
  onClose: () => void
  /** 首启引导的预填词（不自动提交，用户仍点「生成大纲」）。 */
  initialPrompt?: string
}

export function ForgeApp({ onClose, initialPrompt }: ForgeAppProps) {
  const t = useT()
  const deck = useDeckStore((s) => s.deck)
  const lang = useSettingsStore((s) => s.lang)
  const setLang = useSettingsStore((s) => s.setLang)
  const forgeSettings = useSettingsStore((s) => s.forge)
  const providerId = useSettingsStore((s) => s.llm.provider)
  const still = useMemo(() => isStillMode(), [])
  const pacing = useMemo(() => currentPacing(still), [still])
  const [tier, setTier] = useState<ForgeTier>(() => currentTier())

  const [state, dispatch] = useReducer(forgeReducer, undefined, () =>
    initialForgeState({
      lang,
      prompt: initialPrompt ?? '',
      autoPremiere: forgeSettings.autoPremiere && !still,
    }),
  )
  const stateRef = useRef(state)
  stateRef.current = state

  const abortRef = useRef<AbortController | null>(null)
  const recastRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState<ForgeDraftShape | null>(null)
  const [toasts, setToasts] = useState<FxToastItem[]>([])
  const [announce, setAnnounce] = useState('')

  const pushToast = useCallback((item: Omit<FxToastItem, 'id'>) => {
    const id = `fx-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
    setToasts((items) => [...items.slice(-3), { ...item, id }])
    window.setTimeout(() => {
      setToasts((items) => items.filter((toast) => toast.id !== id))
    }, 4000)
  }, [])

  const onGameToast = useCallback(
    (toast: ForgeGameToast) => {
      if (toast.kind === 'combo' && toast.combo) {
        pushToast({ kind: 'combo', text: t('forge.combo.count', { count: toast.combo }) })
      } else if (toast.kind === 'xp' && toast.amount) {
        pushToast({ kind: 'xp', text: `+${toast.amount}` })
      } else if (toast.kind === 'achievement' && toast.achievement) {
        pushToast({ kind: 'achievement', text: t(`forge.ach.${toast.achievement}.name` as MessageKey) })
      } else if (toast.kind === 'level' && toast.level) {
        pushToast({ kind: 'level', text: `${t('forge.level.up')} ${t('forge.level.label', { n: toast.level })}` })
      }
    },
    [pushToast, t],
  )

  const game = useForgeGame({
    gameplay: forgeSettings.gameplay,
    deckId: deck?.id ?? null,
    onToast: onGameToast,
  })

  const fail = useCallback((error: unknown) => {
    const code = isAiError(error) ? error.code : 'network'
    recordDiagnostic(code)
    dispatch({ type: 'fail', code, key: errorKeyOf(error) })
  }, [])

  /* ------------------------------ 生命周期 ------------------------------ */

  useEffect(() => {
    const previous = useUiStore.getState().mode
    useUiStore.getState().setMode('forge')
    document.documentElement.dataset.lumenForge = '1'
    markForgeStep(1)
    return () => {
      delete document.documentElement.dataset.lumenForge
      if (useUiStore.getState().mode === 'forge') useUiStore.getState().setMode(previous === 'forge' ? 'edit' : previous)
    }
  }, [])

  useEffect(() => {
    return () => disposeSound()
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // `?still=1`：视觉基线/低端 kiosk 模式，停掉自写 rAF 调度器（D-04 的可测钩子）。
  useEffect(() => {
    if (still) raf.stop()
  }, [still])

  // 运行中只降不升：连续 2 帧 >32ms 就把 L2/L3 降到 L1（00 §6.1）。
  useEffect(() => {
    if (still || state.phase !== 'casting' || tier === 'L0' || tier === 'L1') return
    let last = 0
    let slow = 0
    let done = false
    let unsubscribe: (() => void) | null = null
    unsubscribe = raf.subscribe((now) => {
      if (done) return
      if (last > 0) {
        const delta = now - last
        if (delta > 32) slow += 1
        else slow = Math.max(0, slow - 1)
        if (slow >= 2) {
          done = true
          setTier('L1')
          unsubscribe?.()
        }
      }
      last = now
    })
    return () => {
      done = true
      unsubscribe?.()
    }
  }, [still, state.phase, tier])

  useEffect(() => {
    let alive = true
    void kvGet<unknown>('forge', 'draft').then((raw) => {
      if (!alive) return
      const parsed = ForgeDraft.parse(raw)
      if (parsed) setDraft(parsed)
    })
    return () => {
      alive = false
    }
  }, [])

  // 焦点进入：优先输入框，其次首卡/首按钮。
  useEffect(() => {
    const node = rootRef.current?.querySelector<HTMLElement>('[data-forge-autofocus], input, button')
    node?.focus({ preventScroll: true })
  }, [])

  // 草稿：大纲就绪后持续保存；完成态删除（D12 的「续上一套」只服务未完成的一套）。
  useEffect(() => {
    if (!state.outline) return
    if (state.phase === 'premiere') {
      void kvDel('forge', 'draft')
      return
    }
    void kvSet('forge', 'draft', {
      v: 1,
      prompt: state.prompt,
      lang: state.lang,
      title: state.outline.title,
      outline: state.outline,
      done: state.done,
      at: Date.now(),
    })
  }, [state.outline, state.phase, state.done, state.prompt, state.lang])

  // 读屏：只播阶段/完成/错误，节流 ≥1.5s（02 §9.2）。
  useEffect(() => {
    if (!state.live) return
    const timer = window.setTimeout(() => setAnnounce(t(state.live!.key, state.live!.vars)), 1500)
    return () => window.clearTimeout(timer)
  }, [state.live, t])

  useEffect(() => {
    if (state.error) setAnnounce(t(state.error.key))
  }, [state.error, t])

  // 关闭页面/切到后台时强制 flush 游戏进度。
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') game.close()
    }
    document.addEventListener('visibilitychange', flush)
    return () => document.removeEventListener('visibilitychange', flush)
  }, [game])

  // 五类轻音（D6：默认关，`forge.sound` 开启才发声）。
  const soundOn = forgeSettings.sound
  const prevDone = useRef(0)
  useEffect(() => {
    if (state.done > prevDone.current) playForgeSound('land', soundOn)
    prevDone.current = state.done
  }, [state.done, soundOn])
  useEffect(() => {
    if (state.outline) playForgeSound('deal', soundOn)
  }, [state.outline, soundOn])
  useEffect(() => {
    if (state.phase === 'premiere') playForgeSound('premiere', soundOn)
  }, [state.phase, soundOn])
  useEffect(() => {
    if (state.slides.some((slide) => slide.status === 'stuck')) playForgeSound('gate', soundOn)
  }, [state.slides, soundOn])
  useEffect(() => {
    if (game.combo >= 2) playForgeSound('combo', soundOn)
  }, [game.combo, soundOn])

  /* -------------------------------- 落库 -------------------------------- */

  const persistDone = useCallback(() => {
    const current = stateRef.current
    const slides = doneSlides(current)
    if (slides.length === 0 || current.saved) return
    const title = current.outline?.title ?? deck?.title ?? 'LUMEN'
    deckOps.applyOutline(title, slides, { replace: true, prompt: current.prompt })
    dispatch({ type: 'saved' })
  }, [deck?.title])

  /* ------------------------------ 演出节奏 ------------------------------ */
  /**
   * 管线只负责"生成完"，表现层按 mock 的时间线落位（`pacing.ts`）：
   * - `slide:landed` 先入队，按 `slideMs` 间隔逐幕释放（快模型也不会一屏跳完）；
   * - 最后一幕释放后再停 `gateHoldMs`，才进开演席；
   * - `?still=1` / `replay&speed=0` 时 `slideMs=0`，走原路径（e2e 不等）。
   */
  const queueRef = useRef<ForgeStageEvent[]>([])
  const deckWaitRef = useRef<Deck | null>(null)
  const warningsRef = useRef<string[]>([])
  const pumpTimerRef = useRef<number | null>(null)
  const lastReleaseRef = useRef(0)
  const pumpRef = useRef<() => void>(() => {})

  const clearPacing = useCallback(() => {
    queueRef.current = []
    deckWaitRef.current = null
    warningsRef.current = []
    if (pumpTimerRef.current !== null) window.clearTimeout(pumpTimerRef.current)
    pumpTimerRef.current = null
    lastReleaseRef.current = 0
  }, [])

  const finishDeck = useCallback(
    (nextDeck: Deck, warnings: string[]) => {
      dispatch({ type: 'deck', deck: nextDeck })
      const summary = summarizeLint(lintDeck(nextDeck))
      game.castComplete(nextDeck, warnings)
      game.gatePass(summary, nextDeck.id)
      markForgeStep(2)
    },
    [game],
  )

  pumpRef.current = () => {
    if (pacing.slideMs <= 0 || pumpTimerRef.current !== null) return
    const step = () => {
      pumpTimerRef.current = null
      const now = performance.now()
      const queue = queueRef.current
      if (queue.length > 0) {
        const wait = Math.max(0, pacing.slideMs - (now - lastReleaseRef.current))
        if (wait > 1) {
          pumpTimerRef.current = window.setTimeout(step, wait)
          return
        }
        const event = queue.shift()!
        dispatch({ type: 'stageEvent', event })
        lastReleaseRef.current = now
        if (queue.length > 0 || deckWaitRef.current) {
          pumpTimerRef.current = window.setTimeout(step, pacing.slideMs)
        }
        return
      }
      const waiting = deckWaitRef.current
      if (!waiting) return
      const wait = Math.max(0, pacing.gateHoldMs - (now - lastReleaseRef.current))
      if (wait > 1) {
        pumpTimerRef.current = window.setTimeout(step, wait)
        return
      }
      deckWaitRef.current = null
      const warnings = warningsRef.current
      warningsRef.current = []
      finishDeck(waiting, warnings)
    }
    step()
  }

  const onPipelineEvent = useCallback(
    (event: ForgeStageEvent) => {
      if (pacing.slideMs > 0 && event.type === 'slide:landed') {
        queueRef.current.push(event)
        pumpRef.current()
        return
      }
      dispatch({ type: 'stageEvent', event })
    },
    [dispatch, pacing.slideMs],
  )

  const waitAtLeast = useCallback(async (started: number, minMs: number) => {
    const wait = minMs - (performance.now() - started)
    if (wait <= 0) return
    await new Promise<void>((resolve) => window.setTimeout(resolve, wait))
  }, [])

  // 卸载时清掉排队与定时器，避免关闭后仍往已卸载的树里 dispatch。
  useEffect(() => () => clearPacing(), [clearPacing])

  // 开演席：先让弧线停够 `premiereHoldMs`，再自动进全屏播放（设置可关，`?still=1` 强制关）。
  useEffect(() => {
    if (state.phase !== 'premiere' || still || !state.autoPremiere) return
    const timer = window.setTimeout(() => {
      if (mountedRef.current && stateRef.current.phase === 'premiere') playRef.current()
    }, pacing.premiereHoldMs)
    return () => window.clearTimeout(timer)
  }, [state.phase, still, state.autoPremiere, pacing.premiereHoldMs])

  /* -------------------------------- 编排 -------------------------------- */

  const runOutline = useCallback(async () => {
    const current = stateRef.current
    const prompt = current.prompt.trim()
    if (prompt === '' || current.busy) return
    const controller = new AbortController()
    abortRef.current = controller
    const started = performance.now()
    dispatch({ type: 'submit' })
    try {
      const result = await composeOutline(
        {
          prompt,
          lang: current.lang,
          length: current.length,
          durationMin: current.durationMin,
          includeSvg: current.includeSvg,
          include3d: current.include3d,
        },
        {
          signal: controller.signal,
          onStage: onPipelineEvent,
        },
      )
      await waitAtLeast(started, pacing.seedThinkMs)
      if (!mountedRef.current || controller.signal.aborted) return
      dispatch({ type: 'outline', outline: result.outline, cropped3d: result.cropped3d })
      game.noteDeal()
      void kvDel('forge', 'draft')
    } catch (error) {
      if (!mountedRef.current) return
      fail(error)
    } finally {
      abortRef.current = null
    }
  }, [game, onPipelineEvent, pacing.seedThinkMs, waitAtLeast])

  const persistRef = useRef(persistDone)
  persistRef.current = persistDone

  const playRef = useRef<() => void>(() => {})

  const runCast = useCallback(async () => {
    const current = stateRef.current
    if (!current.outline || current.busy) return
    const controller = new AbortController()
    abortRef.current = controller
    clearPacing()
    dispatch({ type: 'cast' })
    try {
      const result = await buildDeckFromOutline(current.outline, {
        prompt: current.prompt,
        signal: controller.signal,
        persist: false,
        onStage: onPipelineEvent,
      })
      if (!mountedRef.current) return
      warningsRef.current = result.warnings
      if (pacing.slideMs <= 0) {
        finishDeck(result.deck, result.warnings)
      } else {
        deckWaitRef.current = result.deck
        pumpRef.current()
      }
    } catch (error) {
      clearPacing()
      if (!mountedRef.current) return
      if (isAborted(error)) {
        dispatch({ type: 'stop' })
        game.abort()
      } else {
        fail(error)
      }
    } finally {
      abortRef.current = null
    }
  }, [clearPacing, finishDeck, game, onPipelineEvent, pacing.slideMs])

  const recast = useCallback(
    async (index: number) => {
      const current = stateRef.current
      if (!current.outline || recastRef.current !== null) return
      recastRef.current = index
      const before = (current.slides[index]?.warns ?? []).map((code) => `#${index + 1} warn ${code}`)
      const started = performance.now()
      dispatch({ type: 'recast', index })
      try {
        const built = await rebuildOutlineSlide(current.outline, index, {
          signal: abortRef.current?.signal,
          onStage: (event) => dispatch({ type: 'stageEvent', event }),
        })
        await waitAtLeast(started, pacing.recastMs)
        if (!mountedRef.current) return
        dispatch({ type: 'recastDone', index, slide: built.slide, warnings: built.warnings })
        game.recastOk(
          index,
          before,
          built.warnings,
          stateRef.current.slides.map((slide) => slide.recipe),
        )
        pushToast({ kind: 'combo', text: t('forge.gate.pass') })
      } catch (error) {
        if (!isAborted(error) && mountedRef.current) {
          fail(error)
        }
      } finally {
        recastRef.current = null
      }
    },
    [game, pacing.recastMs, pushToast, t, waitAtLeast],
  )

  const stop = useCallback(() => {
    clearPacing()
    abortRef.current?.abort()
    abortRef.current = null
    dispatch({ type: 'stop' })
    game.abort()
  }, [clearPacing, game])

  const play = useCallback(() => {
    const current = stateRef.current
    if (doneSlides(current).length === 0) return
    persistRef.current()
    game.premiere()
    markForgeStep(3)
    useUiStore.getState().setMode('play')
    window.setTimeout(onClose, 220)
  }, [game, onClose])

  playRef.current = play

  const close = useCallback(() => {
    clearPacing()
    abortRef.current?.abort()
    abortRef.current = null
    persistRef.current()
    const current = stateRef.current
    if (current.phase === 'premiere') void kvDel('forge', 'draft')
    game.close()
    onClose()
  }, [clearPacing, game, onClose])

  const again = useCallback(() => {
    clearPacing()
    abortRef.current?.abort()
    abortRef.current = null
    void kvDel('forge', 'draft')
    dispatch({ type: 'reset' })
  }, [clearPacing])

  const resume = useCallback(() => {
    if (!draft) return
    dispatch({ type: 'prompt', value: draft.prompt })
    dispatch({ type: 'outline', outline: draft.outline })
    setDraft(null)
  }, [draft])

  /* -------------------------------- 键盘 -------------------------------- */

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        close()
        return
      }
      if (event.key === 'Tab') {
        const nodes = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
          (node) => node.offsetParent !== null || node === document.activeElement,
        )
        if (nodes.length === 0) return
        const first = nodes[0]
        const last = nodes[nodes.length - 1]
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        }
        return
      }
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true
      if (typing) return
      const current = stateRef.current
      if (event.key.toLowerCase() === 'r' && current.phase === 'casting') {
        const stuck = current.slides.find((slide) => slide.status === 'stuck')
        if (stuck) {
          event.preventDefault()
          void recast(stuck.index)
        }
      }
      if (event.key.toLowerCase() === 'n' && current.phase === 'deal') {
        event.preventDefault()
        dispatch({ type: 'add' })
      }
      if ((event.key === 'Enter' || event.key === ' ') && current.phase === 'premiere') {
        event.preventDefault()
        play()
      }
    },
    [close, play, recast],
  )

  /* -------------------------------- 渲染 -------------------------------- */

  const mark = forgeMark(state)
  const slideDeck = useMemo<Deck | null>(() => {
    const slides = doneSlides(state)
    if (!deck || slides.length === 0) return null
    return { ...deck, slides, title: state.outline?.title ?? deck.title }
  }, [deck, state.slides, state.outline?.title])

  const stuck = state.slides.find((slide) => slide.status === 'stuck')
  const issues = state.slides.flatMap((slide) => {
    if (slide.status === 'queued' || slide.status === 'drafting' || slide.status === 'art') return []
    const items: { index: number; severity: 'error' | 'warn'; codes: string[] }[] = []
    if (slide.errors.length > 0) items.push({ index: slide.index, severity: 'error', codes: slide.errors })
    if (slide.warns.length > 0) items.push({ index: slide.index, severity: 'warn', codes: slide.warns })
    return items
  })
  const label =
    state.stage === 'write' || state.stage === 'draw' || state.stage === 'set'
      ? t(`forge.cast.stage.${state.stage === 'write' ? 'copy' : state.stage === 'draw' ? 'art' : 'layout'}`)
      : state.stage === 'check'
        ? t('forge.cast.stage.lint')
        : state.stage === 'seal'
          ? t('forge.cast.stage.assemble')
          : state.stage === 'plan'
            ? t('forge.cast.stage.outline')
            : null
  const accent = getTheme(deck?.themeId).colors.accent

  return (
    <div
      ref={rootRef}
      className="forge"
      role="dialog"
      aria-modal="true"
      aria-label={t('forge.a11y.dialog')}
      data-forge={mark}
      data-forge-tier={tier}
      data-forge-combo={game.combo}
      data-forge-still={still ? '1' : undefined}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <Hud
        mark={mark}
        title={state.outline?.title ?? ''}
        done={state.done}
        total={state.total}
        combo={game.combo}
        level={game.level}
        tier={tier}
        busy={state.busy}
        canClose
        onClose={close}
        onLang={() => {
          const next = state.lang === 'zh' ? 'en' : 'zh'
          dispatch({ type: 'option', patch: { lang: next } })
          setLang(next)
        }}
        lang={state.lang}
      />

      <main className="forge__stage" data-forge-stage>
        {state.phase === 'seed' ? (
          <Seed
            prompt={state.prompt}
            lang={state.lang}
            length={state.length}
            durationMin={state.durationMin}
            includeSvg={state.includeSvg}
            include3d={state.include3d}
            offline={providerId === 'mock'}
            busy={state.busy}
            hasDraft={Boolean(draft)}
            error={state.error}
            onPrompt={(value) => dispatch({ type: 'prompt', value })}
            onOption={(patch) => dispatch({ type: 'option', patch })}
            onLang={() => {
              const next = state.lang === 'zh' ? 'en' : 'zh'
              dispatch({ type: 'option', patch: { lang: next } })
              setLang(next)
            }}
            onSubmit={() => void runOutline()}
            onResume={resume}
            onClear={() => {
              dispatch({ type: 'prompt', value: '' })
              setDraft(null)
              void kvDel('forge', 'draft')
            }}
            onErrorAction={() => {
              if (state.error?.key === 'forge.error.auth' || state.error?.key === 'forge.error.notConfigured') {
                useUiStore.getState().openDialog('settings')
              } else {
                dispatch({ type: 'clearError' })
                void runOutline()
              }
            }}
            onErrorDismiss={() => dispatch({ type: 'clearError' })}
          />
        ) : null}

        {state.phase === 'deal' ? (
          <Deal
            outline={state.outline}
            slides={state.slides}
            cropped3d={state.cropped3d}
            tier={tier}
            onSwap={(index) => dispatch({ type: 'swap', index })}
            onRemove={(index) => dispatch({ type: 'remove', index })}
            onAdd={() => dispatch({ type: 'add' })}
            onMove={(from, to) => dispatch({ type: 'move', from, to })}
            onCast={() => void runCast()}
            onBack={() => {
              dispatch({ type: 'reset' })
              setDraft(null)
            }}
          />
        ) : null}

        {state.phase === 'casting' ? (
          <>
            <Assemble
              tier={tier}
              phase={state.phase}
              slides={state.slides}
              deck={slideDeck}
              total={state.total}
              done={state.done}
              active={state.active}
              stage={state.stage}
              stopped={state.stopped}
              onRecast={(index) => void recast(index)}
              onStop={stop}
              onResume={() => void runCast()}
              onPlay={play}
            />
            <Gate slides={state.slides} active={state.active} tier={tier} onRecast={(index) => void recast(index)} />
          </>
        ) : null}

        {state.phase === 'premiere' ? (
          <Premiere
            deck={slideDeck}
            slides={state.slides}
            tier={tier}
            accent={accent}
            onPlay={play}
            onBack={close}
            onAgain={again}
          />
        ) : null}
      </main>

      <footer className="forge__dock">
        <Pulse prog={state.prog} stage={state.stage} bad={Boolean(stuck)} tier={tier} label={label} />
        <div className="forge__actions">
          {state.phase === 'casting' ? (
            <button type="button" className="forge__ghost" onClick={stop}>
              {t('forge.cast.cancel')}
            </button>
          ) : null}
          {state.phase === 'seed' ? (
            <button
              type="button"
              className="forge__cta"
              data-act="deal"
              disabled={state.busy || state.prompt.trim() === ''}
              aria-disabled={state.busy || state.prompt.trim() === ''}
              onClick={() => void runOutline()}
            >
              {t('forge.seed.start')}
            </button>
          ) : null}
          {state.phase === 'deal' ? (
            <button
              type="button"
              className="forge__cta"
              data-act="cast"
              disabled={state.slides.length === 0}
              onClick={() => void runCast()}
            >
              {t('forge.deal.cast')}
            </button>
          ) : null}
          {state.phase === 'casting' && stuck && mark !== 'gate' ? (
            <button type="button" className="forge__cta" data-act="recast" onClick={() => void recast(stuck.index)}>
              {t('forge.gate.recast')}
            </button>
          ) : null}
        </div>
      </footer>

      <FxToast items={toasts} />

      <div className="forge__live" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
      <div
        className="forge__progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={state.total}
        aria-valuenow={state.done}
        aria-label={t('forge.a11y.pulse')}
      />
    </div>
  )
}

/** 供 ForgeHost 之外的单测/调试使用：把大纲塞进状态机的最小入口。 */
export function previewOutline(outline: Outline) {
  return outlineSchema.parse(outline)
}
