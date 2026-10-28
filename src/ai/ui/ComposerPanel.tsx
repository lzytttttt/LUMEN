/**
 * ComposerPanel.tsx —— 右栏 AI 编排面板（零 props）。
 *
 * 结构：通道徽标 → 提示词 → 选项 → 生成大纲 → 可编辑大纲 → 逐幕成稿进度 → 完成提示 → 微调。
 * 约束：
 * - 生成中禁止重复提交；AbortController 取消；
 * - 不阻塞主线程：所有生成都是 async，画布仍可操作；
 * - 所有错误都收敛成可读文案 + 重试，不把异常抛到 React 之外。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Outline } from '@/schema/deck'
import { THEMES, THEME_IDS } from '@/themes'
import { deckOps } from '@/state/ops'
import { useDeckStore } from '@/state/deckStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { useT } from '@/i18n'
import { Button, Field, Row, Segmented, Select, Switch, TextArea, TextInput } from '@/ui/primitives'
import type { MessageKey } from '@/i18n'
import {
  AiError,
  aiErrorMessage,
  applySlideRebuild,
  buildDeckFromOutline,
  channelInfo,
  composeOutline,
  installIntentListener,
  isAborted,
  rebuildOutlineSlide,
  type AiErrorCode,
  type ComposeInput,
} from '@/ai'
import { OutlineEditor } from './OutlineEditor'
import { GenerationProgress } from './GenerationProgress'
import { RefineBox } from './RefineBox'
import './composer.css'

type Phase = 'idle' | 'outlining' | 'outline' | 'building' | 'done'

const LENGTHS: ComposeInput['length'][] = ['short', 'normal', 'deep']
const DURATIONS = [5, 10, 20]

/**
 * 错误码 → 中文短句（`05` §6）：只给 ≤ 6 字的结论，原始 detail 收进折叠区。
 * `auth` 没有专属短句 key，回落到 `aiErrorMessage`（原始片段）。
 */
const SHORT_ERROR_KEYS: Partial<Record<AiErrorCode, MessageKey>> = {
  network: 'ai.error.network',
  timeout: 'ai.error.timeout',
  badJson: 'ai.error.badJson',
  notConfigured: 'ai.error.notConfigured',
  rateLimit: 'ai.error.rateLimit',
  quota: 'ai.error.quota',
  contextLength: 'ai.error.contextLength',
  modelNotFound: 'ai.error.modelNotFound',
  streamBroken: 'ai.error.streamBroken',
  cors: 'ai.error.cors',
}

export default function ComposerPanel() {
  const t = useT()
  const llm = useSettingsStore((s) => s.llm)
  const lang = useSettingsStore((s) => s.lang)
  const deck = useDeckStore((s) => s.deck)
  const setRightMode = useUiStore((s) => s.setRightMode)

  const [prompt, setPrompt] = useState('')
  const [audience, setAudience] = useState('')
  const [length, setLength] = useState<ComposeInput['length']>('normal')
  const [durationMin, setDurationMin] = useState(10)
  const [themeId, setThemeId] = useState(deck?.themeId ?? 'noir')
  const [includeSvg, setIncludeSvg] = useState(true)
  const [include3d, setInclude3d] = useState(true)

  const [phase, setPhase] = useState<Phase>('idle')
  const [outline, setOutline] = useState<Outline | null>(null)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  /** 原始 detail：只出现在折叠区，不进主气泡（§6.1）。 */
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const busy = phase === 'outlining' || phase === 'building'
  const channel = channelInfo(llm)

  // 挂载：注册「AI 编排在线」标记与意图监听（幂等，Lead 在 App 里再调一次也安全）。
  useEffect(() => {
    document.documentElement.dataset.lumenAi = '1'
    const uninstall = installIntentListener()
    return () => {
      uninstall()
      delete document.documentElement.dataset.lumenAi
    }
  }, [])

  // 主题跟随 deck（用户在检查器里换主题时同步）。
  useEffect(() => {
    if (deck?.themeId) setThemeId(deck.themeId)
  }, [deck?.themeId])

  const reasonOf = useCallback(
    (err: unknown): string => {
      if (err instanceof AiError) {
        // 真取消才说「已取消」；超时是「太慢了」（§6.1 的第一个修正）。
        if (isAborted(err)) return t('ai.error.aborted')
        const key = SHORT_ERROR_KEYS[err.code]
        if (key) return t(key)
        return aiErrorMessage(err)
      }
      return aiErrorMessage(err)
    },
    [t],
  )

  /** 一处收敛：短句进气泡、detail 进折叠区。 */
  const fail = useCallback(
    (err: unknown) => {
      setError(reasonOf(err))
      setErrorDetail(err instanceof AiError ? err.detail.trim() : null)
    },
    [reasonOf],
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setPhase(outline ? 'outline' : 'idle')
    useUiStore.getState().pushToast({ kind: 'info', message: t('ai.panel.cancelled') })
  }, [outline, t])

  const generate = useCallback(async () => {
    if (busy || prompt.trim() === '') return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setErrorDetail(null)
    setWarnings([])
    setProgress({ done: 0, total: 0 })
    setPhase('outlining')
    try {
      const result = await composeOutline(
        {
          prompt: prompt.trim(),
          lang,
          audience: audience.trim() === '' ? undefined : audience.trim(),
          length,
          include3d,
          includeSvg,
          themeId,
          durationMin,
        },
        { signal: controller.signal },
      )
      setOutline(result.outline)
      setPhase('outline')
    } catch (err) {
      if (isAborted(err)) {
        setPhase(outline ? 'outline' : 'idle')
        return
      }
      fail(err)
      setPhase('idle')
    } finally {
      abortRef.current = null
    }
  }, [audience, busy, fail, include3d, includeSvg, lang, length, outline, prompt, themeId, durationMin])

  const build = useCallback(async () => {
    if (!outline || busy) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setErrorDetail(null)
    setWarnings([])
    setProgress({ done: 0, total: outline.slides.length })
    setPhase('building')
    try {
      const result = await buildDeckFromOutline(outline, {
        themeId,
        prompt: prompt.trim() || outline.title,
        signal: controller.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      })
      setWarnings(result.warnings)
      setPhase('done')
      useUiStore.getState().pushToast({
        kind: 'success',
        message: t('ai.panel.buildDone', { count: result.deck.slides.length }),
      })
    } catch (err) {
      if (isAborted(err)) {
        setPhase('outline')
        return
      }
      fail(err)
      setPhase('outline')
    } finally {
      abortRef.current = null
    }
  }, [busy, fail, outline, prompt, t, themeId])

  /**
   * 通道文案（`05` §14.5）：`replay` 走独立分支，**不显示**「离线示例模式」；
   * 只有真正的 mock 兜底才挂 mockBadge（下面徽标那一行按 `channel.ready` 决定）。
   */
  const channelLabel =
    channel.channel === 'replay'
      ? t('ai.panel.channelEndpoint', { host: 'replay', model: channel.model || 'fixture' })
      : channel.channel === 'openai'
        ? t('ai.panel.channelEndpoint', {
            host: channel.host || 'endpoint',
            model: channel.model || 'model',
          })
        : llm.provider === 'openai'
          ? t('ai.panel.channelNotConfigured')
          : t('ai.panel.providerMock')

  /** 单幕重试：只重建这一幕并写回（单步撤销），用于"部分失败"。 */
  const retrySlide = useCallback(
    async (index: number) => {
      if (!outline || retrying !== null) return
      setRetrying(index)
      setError(null)
      try {
        const result = await rebuildOutlineSlide(outline, index, {
          themeId,
          prompt: prompt.trim() || outline.title,
        })
        if (!applySlideRebuild(index, result.slide)) {
          setError(t('ai.panel.noSlide'))
          return
        }
        setWarnings((prev) => prev.filter((warning) => !warning.startsWith(`#${index + 1} `)))
        useUiStore.getState().pushToast({ kind: 'success', message: t('ai.panel.buildDone', { count: 1 }) })
      } catch (err) {
        if (!isAborted(err)) fail(err)
      } finally {
        setRetrying(null)
      }
    },
    [fail, outline, prompt, retrying, t, themeId],
  )

  return (
    <div className="ai-panel">
      <div className="ai-panel__head">
        <div className="ai-panel__titles">
          <span className="ai-panel__title">{t('ai.panel.title')}</span>
          <span className="ai-panel__subtitle">{t('ai.panel.subtitle')}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setRightMode('inspector')}>
          {t('ai.panel.close')}
        </Button>
      </div>

      <div className={channel.ready ? 'ai-channel ai-channel--live' : 'ai-channel'} title={channelLabel}>
        <span className="ai-channel__dot" aria-hidden="true" />
        <span className="ai-channel__name">
          {channel.ready ? channelLabel : `${t('ai.panel.mockBadge')} · ${channelLabel}`}
        </span>
        <button
          type="button"
          className="ai-channel__link"
          onClick={() => useUiStore.getState().openDialog('settings')}
        >
          {t('ai.panel.configure')}
        </button>
      </div>

      {!channel.ready ? <p className="ai-note">{t('ai.panel.mockHint')}</p> : null}

      <section className="ai-block">
        <div className="ai-block__head">
          <span>{t('ai.panel.promptLabel')}</span>
          <span className="ai-block__hint">{t('ai.panel.promptHint')}</span>
        </div>
        <TextArea
          rows={4}
          value={prompt}
          onValueChange={setPrompt}
          placeholder={t('ai.panel.placeholder')}
          disabled={busy}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void generate()
            }
          }}
        />
        <p className="ai-note">{t('ai.panel.hint')}</p>
      </section>

      <section className="ai-block">
        <Field label={t('ai.panel.audience')}>
          <TextInput
            value={audience}
            onValueChange={setAudience}
            placeholder={t('ai.panel.audiencePlaceholder')}
            disabled={busy}
          />
        </Field>

        <Field label={t('ai.panel.length')}>
          <Segmented
            block
            value={length}
            onValueChange={(value) => setLength(value as ComposeInput['length'])}
            options={LENGTHS.map((value) => ({
              value,
              label:
                value === 'short'
                  ? t('ai.panel.lengthShort')
                  : value === 'deep'
                    ? t('ai.panel.lengthDeep')
                    : t('ai.panel.lengthNormal'),
            }))}
          />
        </Field>

        <Row cols={2}>
          <Field label={t('ai.panel.duration')}>
            <Select
              value={String(durationMin)}
              onValueChange={(value) => setDurationMin(Number(value))}
              options={DURATIONS.map((minutes) => ({
                value: String(minutes),
                label: t('ai.panel.durationMinutes', { n: minutes }),
              }))}
              disabled={busy}
            />
          </Field>
          <Field label={t('ai.panel.themeLabel')}>
            <Select
              value={themeId}
              onValueChange={(value) => {
                setThemeId(value)
                deckOps.setTheme(value)
              }}
              options={THEME_IDS.map((id) => ({ value: id, label: THEMES[id].name[lang] }))}
              disabled={busy}
            />
          </Field>
        </Row>

        <div className="ai-switches">
          <label>
            <Switch checked={includeSvg} onCheckedChange={setIncludeSvg} label={t('ai.panel.includeSvg')} />
            <span>{t('ai.panel.includeSvg')}</span>
          </label>
          <label>
            <Switch checked={include3d} onCheckedChange={setInclude3d} label={t('ai.panel.include3d')} />
            <span>{t('ai.panel.include3d')}</span>
          </label>
        </div>
      </section>

      <Button variant="primary" block onClick={() => void generate()} disabled={busy || prompt.trim() === ''}>
        {outline ? t('ai.panel.regenerating') : t('ai.panel.generate')}
      </Button>

      {phase === 'outlining' ? (
        <div className="ai-progress" role="status" aria-live="polite">
          <div className="ai-progress__bar">
            <span className="ai-progress__fill" style={{ width: '35%' }} />
          </div>
          <div className="ai-progress__row">
            <span>{t('ai.progress.outline')}</span>
            <Button size="sm" variant="ghost" onClick={cancel}>
              {t('ai.panel.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="ai-error" role="alert">
          <strong>{t('ai.panel.errorTitle')}</strong>
          <span>{error}</span>
          {errorDetail ? (
            <details className="ai-error__more" style={{ maxWidth: '100%' }}>
              {/* 折叠的「…」：i18n 尚未给出 detail 标签的 key（i18n 由 Lead 锁定），先只留符号。 */}
              <summary>…</summary>
              <pre
                style={{
                  margin: 0,
                  maxWidth: '100%',
                  maxHeight: 120,
                  overflow: 'auto',
                  fontSize: 10.5,
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  opacity: 0.8,
                }}
              >
                {errorDetail}
              </pre>
            </details>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void generate()} disabled={busy}>
            {t('ai.panel.retry')}
          </Button>
        </div>
      ) : null}

      {outline ? (
        <section className="ai-block">
          <div className="ai-block__head">
            <span>{t('ai.panel.outline')}</span>
            <span className="ai-block__hint">{t('ai.panel.slideCount', { count: outline.slides.length })}</span>
          </div>
          <p className="ai-note">{t('ai.panel.outlineHint')}</p>

          <OutlineEditor outline={outline} onChange={setOutline} disabled={busy} />

          <Button
            variant="primary"
            block
            onClick={() => void build()}
            disabled={busy || outline.slides.length === 0}
          >
            {phase === 'building'
              ? t('ai.panel.building', { done: progress.done, total: progress.total })
              : t('ai.panel.buildSlides')}
          </Button>
          <p className="ai-note">{t('ai.panel.buildHint')}</p>

          {phase === 'building' ? (
            <GenerationProgress done={progress.done} total={progress.total} onCancel={cancel} />
          ) : null}

          {phase === 'done' ? (
            <div className="ai-done">
              <span>{t('ai.panel.buildDone', { count: outline.slides.length })}</span>
              {warnings.length > 0 ? (
                <details>
                  <summary>{t('ai.panel.warnings', { count: warnings.length })}</summary>
                  <ul>
                    {warnings.map((warning, position) => {
                      const match = /^#(\d+)\b/.exec(warning)
                      const slideIndex = match ? Number(match[1]) - 1 : -1
                      return (
                        <li key={`${position}-${warning}`}>
                          <span>{warning}</span>
                          {slideIndex >= 0 ? (
                            <button
                              type="button"
                              className="ai-link"
                              disabled={retrying !== null || busy}
                              onClick={() => void retrySlide(slideIndex)}
                            >
                              {retrying === slideIndex ? t('ai.panel.building', { done: 1, total: 1 }) : t('ai.panel.retry')}
                            </button>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <RefineBox />
    </div>
  )
}
