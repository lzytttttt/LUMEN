/**
 * creator/CreatorPanel.tsx —— 420px 右侧面板（04 §2.2 同屏布局）。
 *
 * 结构：状态条 28px → 会话流（flex）→ 提案卡 → 视图页签 → 权限条 44px。
 * 三个钩子面：`data-creator-state`（根）、`data-creator-proposal`（提案卡）、`data-creator-*` 附加属性。
 */
import { useEffect, useRef, useState } from 'react'
import { Button, TextArea } from '@/ui/primitives'
import type { CreatorMachine } from './state'
import { useCreatorStore } from './store'
import { createSamplePromptChips, StartCard, TemplateRow } from './StartCard'
import { CreatorStatusBar } from './CreatorStatusBar'
import { ProposalView } from './ProposalView'
import { creatorT, CREATOR_KEYS, useCreatorT } from './i18n'
import { isFeedbackCode } from './repair'
import { feedbackDiagnosticsOf } from './diagnostics'

export function CreatorPanel({ panelWidth }: { panelWidth: number }) {
  const t = useCreatorT()
  const machine = useCreatorStore((state) => state.machine)
  const view = useCreatorStore((state) => state.view)
  const promptTokens = useCreatorStore((state) => state.promptTokens)
  const prompt = useCreatorStore((state) => state.machine.prompt)
  const submitPrompt = useCreatorStore((state) => state.submitPrompt)
  const cancel = useCreatorStore((state) => state.cancel)
  const retry = useCreatorStore((state) => state.retry)
  const discardDraft = useCreatorStore((state) => state.discardDraft)
  const feedBackError = useCreatorStore((state) => state.feedBackError)
  const startTrial = useCreatorStore((state) => state.startTrial)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (machine.status === 'idle') inputRef.current?.focus()
  }, [machine.status])

  const busy = machine.status === 'reading' || machine.status === 'proposing'
  const showProposal = machine.proposal !== null && machine.status !== 'idle'
  const canSubmit = !busy && draft.trim() !== ''

  return (
    <section
      className="creator-panel"
      style={{ width: panelWidth }}
      role="complementary"
      aria-label={t(CREATOR_KEYS.a11yPanel)}
    >
      <header className="creator-head">
        <div>
          <div className="creator-head__title">{t(CREATOR_KEYS.panelTitle)}</div>
          <div className="creator-head__sub">{t(CREATOR_KEYS.panelSubtitle)}</div>
        </div>
        <span className="creator-head__spacer" />
        <Button
          size="sm"
          variant="ghost"
          aria-label={t(CREATOR_KEYS.a11yClose)}
          onClick={() => void useCreatorStore.getState().close()}
        >
          {t(CREATOR_KEYS.close)}
        </Button>
      </header>

      <CreatorStatusBar
        machine={machine}
        promptTokens={promptTokens}
        onCancel={() => void cancel()}
      />

      <div className="creator-body">
        <div className="creator-flow">
          {prompt && machine.status !== 'idle' ? <div className="creator-said">{prompt}</div> : null}
          {machine.stream && (machine.stream.title || machine.stream.summary) ? (
            <div className="creator-ai">
              {machine.stream.title ? <div className="creator-ai__title">{machine.stream.title}</div> : null}
              {machine.stream.summary ? <div className="creator-ai__summary">{machine.stream.summary}</div> : null}
            </div>
          ) : null}
          {machine.status === 'idle' ? <StartCard /> : null}
          {machine.status === 'reading' || machine.status === 'proposing' ? (
            <div className="creator-hint">
              {t(machine.status === 'reading' ? CREATOR_KEYS.stateReading : CREATOR_KEYS.stateProposing)}
            </div>
          ) : null}
          {machine.restored && machine.interrupted ? (
            <div className="creator-hint">{t(CREATOR_KEYS.stateInterrupted)}</div>
          ) : null}
        </div>

        {machine.error && machine.status === 'failed' ? (
          <ErrorCard
            machine={machine}
            onRetry={() => void retry()}
            onDisable={() => void discardDraft()}
            onFeedback={() => void feedBackError()}
          />
        ) : null}

        {showProposal && machine.proposal ? (
          <ProposalView
            machine={machine}
            proposal={machine.proposal}
            history={machine.history}
            draftId={machine.draftId}
          />
        ) : null}
      </div>

      <PromptComposer
        draft={draft}
        setDraft={setDraft}
        busy={busy}
        canSubmit={canSubmit}
        onCancel={() => void cancel()}
        onSubmit={() => {
          if (!canSubmit) return
          const value = draft
          setDraft('')
          void submitPrompt(value)
        }}
        prompt={prompt}
      />
    </section>
  )
}

function PromptComposer({
  draft,
  setDraft,
  busy,
  canSubmit,
  prompt,
  onSubmit,
  onCancel,
}: {
  draft: string
  setDraft: (value: string) => void
  busy: boolean
  canSubmit: boolean
  prompt: string
  onSubmit: () => void
  onCancel: () => void
}) {
  const t = useCreatorT()
  const machine = useCreatorStore((state) => state.machine)
  const chips = createSamplePromptChips()
  const status = machine.status
  return (
    <div className="creator-start" data-creator-composer="">
      <TemplateRow />
      <TextArea
        value={draft}
        onValueChange={setDraft}
        rows={2}
        placeholder={t(CREATOR_KEYS.promptPlaceholder)}
        aria-label={t(CREATOR_KEYS.promptLabel)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            onSubmit()
          }
          if (event.key === 'Escape' && busy) {
            event.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="creator-actions">
        <Button size="sm" variant="primary" onClick={onSubmit} disabled={!canSubmit || busy}>
          {t(CREATOR_KEYS.propose)}
        </Button>
        {busy ? (
          <Button size="sm" variant="subtle" onClick={onCancel}>
            {t(CREATOR_KEYS.cancel)}
          </Button>
        ) : null}

      </div>
      {status === 'idle' ? (
        <div className="creator-badges">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              className="creator-template"
              onClick={() => setDraft(chip)}
            >
              {chip}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function ErrorCard({
  machine,
  onRetry,
  onDisable,
  onFeedback,
}: {
  machine: CreatorMachine
  onRetry: () => void
  onDisable: () => void
  onFeedback: () => void
}) {
  const t = useCreatorT()
  const [expanded, setExpanded] = useState(false)
  const error = machine.error
  if (!error) return null
  const canFeedback = isFeedbackCode(error.code)
  const messageKey =
    error.uiKey === 'capMismatch'
      ? CREATOR_KEYS.errorCapMismatch
      : error.uiKey === 'badJson'
        ? CREATOR_KEYS.errorBadJson
        : error.uiKey === 'schema'
          ? CREATOR_KEYS.errorSchema
          : error.uiKey === 'sandbox'
            ? CREATOR_KEYS.errorSandbox
            : error.uiKey === 'code'
              ? CREATOR_KEYS.errorCode
              : error.uiKey === 'tooLarge'
                ? CREATOR_KEYS.errorTooLarge
                : error.uiKey === 'timeout'
                  ? CREATOR_KEYS.errorTimeout
                  : error.uiKey === 'notConfigured'
                    ? CREATOR_KEYS.errorNotConfigured
                    : CREATOR_KEYS.errorBadJson
  return (
    <div className="creator-error" role="alert" data-creator-error-card="">
      <span className="creator-error__title">
        {t(messageKey)} <span className="creator-history__meta">[{error.code}]</span>
      </span>
      <span className="creator-hint">{t(CREATOR_KEYS.errorNextStep)}</span>
      <div className="creator-actions">
        <Button size="sm" variant="primary" onClick={onRetry}>
          {t(CREATOR_KEYS.retry)}
        </Button>
        {canFeedback ? (
          <Button size="sm" variant="outline" onClick={onFeedback}>
            {t(CREATOR_KEYS.feedBack)}
          </Button>
        ) : null}
        <Button size="sm" variant="subtle" onClick={onDisable}>
          {t(CREATOR_KEYS.trialStop)}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
          {t(CREATOR_KEYS.errorDetails)}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const text = feedbackDiagnosticsOf(machine)
            void navigator.clipboard?.writeText(text).catch(() => {})
          }}
        >
          {t(CREATOR_KEYS.copyDiag)}
        </Button>
      </div>
      {expanded && error.detail ? (
        <div className="creator-error__detail">{error.detail}</div>
      ) : null}
    </div>
  )
}

export { creatorT }
