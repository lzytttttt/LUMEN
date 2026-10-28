/**
 * MotionTab.tsx —— 动效页签：幕转场、块入场、一键套用到全部幕。
 */
import type { Block, Slide } from '@/schema/deck'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { blockOps, slideOps } from '@/state/ops'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { Button, Field, NumberInput, Section, Select } from '@/ui/primitives'

const TRANSITIONS: Slide['transition']['kind'][] = ['none', 'fade', 'push', 'wipe', 'flip3d']
const ENTERS: Block['enter'][] = ['none', 'fade', 'rise', 'scale']

export function MotionTab({ slide, selected }: { slide: Slide; selected: Block[] }) {
  const t = useT()
  const deck = useDeckStore((s) => s.deck)
  const pushToast = useUiStore((s) => s.pushToast)
  const ids = selected.map((block) => block.id)
  const first = selected[0]

  const applyToAllSlides = () => {
    const { kind, ms } = slide.transition
    useDeckStore.getState().transaction('apply-transition', () => {
      for (const item of deck.slides) {
        slideOps.update(item.id, (draft) => {
          draft.transition = { kind, ms }
        }, 'apply-transition')
      }
    })
    pushToast({ kind: 'success', message: t('editor.toast.transitionApplied') })
  }

  return (
    <>
      <Section title={t('editor.inspector.transition')}>
        <Field>
          <Select
            value={slide.transition.kind}
            onValueChange={(kind) => slideOps.setTransition(kind)}
            options={TRANSITIONS.map((kind) => ({
              value: kind,
              label: t(`editor.inspector.transitionKinds.${kind}` as MessageKey),
            }))}
          />
        </Field>
        <Field label={t('editor.inspector.transitionDuration')}>
          <NumberInput
            value={slide.transition.ms}
            min={0}
            max={2000}
            step={20}
            suffix="ms"
            onValueChange={(ms) => slideOps.setTransition(slide.transition.kind, ms)}
          />
        </Field>
        <Button size="sm" variant="outline" block onClick={applyToAllSlides}>
          {t('editor.inspector.applyToAll')}
        </Button>
      </Section>

      <Section title={t('editor.inspector.enter')}>
        {first ? (
          <>
            <Field hint={t('editor.inspector.enterHint')}>
              <Select
                value={first.enter}
                onValueChange={(enter) => blockOps.updateMany(ids, (block) => { block.enter = enter })}
                options={ENTERS.map((enter) => ({
                  value: enter,
                  label: t(`editor.inspector.enterKinds.${enter}` as MessageKey),
                }))}
              />
            </Field>
            <Field label={t('editor.inspector.enterDelay')}>
              <NumberInput
                value={first.enterDelayMs}
                min={0}
                max={3000}
                step={50}
                suffix="ms"
                onValueChange={(enterDelayMs) =>
                  blockOps.updateMany(ids, (block) => { block.enterDelayMs = enterDelayMs }, { coalesceKey: 'enter-delay' })
                }
              />
            </Field>
          </>
        ) : (
          <p className="insp-note">{t('editor.inspector.noSelectionHint')}</p>
        )}
      </Section>
    </>
  )
}
