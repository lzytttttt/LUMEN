/**
 * NotesTab.tsx —— 讲者备注：大文本域 + 字数 + 同步说明。
 */
import type { Slide } from '@/schema/deck'
import { slideOps } from '@/state/ops'
import { useT } from '@/i18n'
import { Field, Section, TextArea } from '@/ui/primitives'

export function NotesTab({ slide }: { slide: Slide }) {
  const t = useT()
  const notes = slide.notes ?? ''
  return (
    <Section title={t('common.label.notes')}>
      <Field label={t('editor.inspector.tabs.notes')} hint={t('editor.inspector.notesSync')}>
        <TextArea
          value={notes}
          rows={12}
          placeholder={t('editor.inspector.notesPlaceholder')}
          onValueChange={(value) => slideOps.setNotes(value)}
        />
      </Field>
      <p className="insp-char">{t('editor.inspector.words', { count: notes.length })}</p>
    </Section>
  )
}
