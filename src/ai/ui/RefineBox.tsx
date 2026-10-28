/**
 * RefineBox.tsx —— 自然语言微调：输入指令 → 预览 diff → 确认应用。
 *
 * 规则优先（离线可用），LLM 只做增强；应用时走 blockOps，单步撤销。
 */
import { useState } from 'react'
import { useT, type MessageKey } from '@/i18n'
import { useDeckStore } from '@/state/deckStore'
import { useSelectionStore } from '@/state/selectionStore'
import { useUiStore } from '@/state/uiStore'
import { useActiveSlide } from '@/state/selectors'
import { Button, TextArea } from '@/ui/primitives'
import { aiErrorMessage, applyRefinePlan, isAborted, refineSlide, type SlidePatchPlan } from '@/ai'

export function RefineBox() {
  const t = useT()
  const deck = useDeckStore((s) => s.deck)
  const slide = useActiveSlide()
  const selectedIds = useSelectionStore((s) => s.selectedBlockIds)
  const [instruction, setInstruction] = useState('')
  const [plan, setPlan] = useState<SlidePatchPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!deck || !slide || busy || instruction.trim() === '') return
    setBusy(true)
    setError(null)
    setPlan(null)
    try {
      const result = await refineSlide(instruction.trim(), {
        deck,
        slideId: slide.id,
        blockIds: selectedIds.length > 0 ? selectedIds : undefined,
      })
      const touched =
        result.patch.diff.added.length + result.patch.diff.removed.length + result.patch.diff.changed.length
      if (touched === 0) {
        setError(t('ai.panel.refineEmpty'))
        return
      }
      setPlan(result.patch)
    } catch (err) {
      if (!isAborted(err)) setError(aiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const confirm = () => {
    if (!plan) return
    applyRefinePlan(plan)
    useUiStore.getState().pushToast({ kind: 'success', message: t(plan.summaryKey as MessageKey) })
    setPlan(null)
    setInstruction('')
  }

  return (
    <section className="ai-block ai-refine">
      <div className="ai-block__head">
        <span>{t('ai.panel.refineTitle')}</span>
        <span className="ai-block__hint">{slide?.name ?? t('ai.panel.currentSlide')}</span>
      </div>

      <TextArea
        rows={2}
        value={instruction}
        onValueChange={setInstruction}
        placeholder={t('ai.panel.improvePlaceholder')}
        disabled={!slide || busy}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void submit()
          }
        }}
      />

      <p className="ai-note">{t('ai.panel.refineHint')}</p>

      <div className="ai-refine__actions">
        <Button
          size="sm"
          variant="primary"
          onClick={() => void submit()}
          disabled={!slide || busy || instruction.trim() === ''}
        >
          {t('ai.panel.improve')}
        </Button>
        {busy ? <span className="ai-block__hint">…</span> : null}
      </div>

      {!slide ? <p className="ai-note">{t('ai.panel.noSlide')}</p> : null}
      {error ? <p className="ai-note" style={{ color: 'var(--ui-danger)' }}>{error}</p> : null}

      {plan ? (
        <div className="ai-diff">
          <p className="ai-diff__line">
            {t('ai.panel.refinePreview', {
              added: plan.diff.added.length,
              changed: plan.diff.changed.length,
              removed: plan.diff.removed.length,
            })}
          </p>
          <div className="ai-diff__chips">
            {plan.diff.added.slice(0, 4).map((id) => (
              <span key={`add-${id}`} className="ai-chip ai-chip--add">
                +{id.slice(-4)}
              </span>
            ))}
            {plan.diff.changed.slice(0, 4).map((id) => (
              <span key={`chg-${id}`} className="ai-chip ai-chip--change">
                ~{id.slice(-4)}
              </span>
            ))}
            {plan.diff.removed.slice(0, 4).map((id) => (
              <span key={`del-${id}`} className="ai-chip ai-chip--remove">
                -{id.slice(-4)}
              </span>
            ))}
          </div>
          <div className="ai-diff__actions">
            <Button size="sm" variant="primary" onClick={confirm}>
              {t('ai.panel.refineConfirm')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPlan(null)}>
              {t('ai.panel.refineDiscard')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
