/**
 * HtmlEditorDialog.tsx —— HTML 块的源码编辑弹窗。
 * 草稿态编辑、应用时一次提交（一步撤销）；CodeMirror 负责高亮与缩进。
 */
import { useEffect, useState } from 'react'
import type { HtmlBlock } from '@/schema/deck'
import { blockOps } from '@/state/ops'
import { useUiStore } from '@/state/uiStore'
import { useT } from '@/i18n'
import { Button, Field, Modal } from '@/ui/primitives'
import { CodeEditor } from '@/ui/code/CodeEditor'

export function HtmlEditorDialog({
  block,
  open,
  onClose,
}: {
  block: HtmlBlock
  open: boolean
  onClose: () => void
}) {
  const t = useT()
  const pushToast = useUiStore((s) => s.pushToast)
  const [html, setHtml] = useState(block.html)
  const [css, setCss] = useState(block.css ?? '')

  useEffect(() => {
    if (!open) return
    setHtml(block.html)
    setCss(block.css ?? '')
  }, [open, block.id, block.html, block.css])

  const apply = () => {
    blockOps.updateOfType(
      block.id,
      'html',
      (draft) => {
        draft.html = html
        draft.css = css.trim() === '' ? undefined : css
      },
      { label: 'edit-html' },
    )
    pushToast({ kind: 'success', message: t('editor.toast.saved') })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('editor.inspector.htmlEditorTitle')}
      subtitle={t('editor.inspector.htmlEditorHint')}
      size="lg"
      closeLabel={t('common.action.close')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.action.cancel')}
          </Button>
          <Button variant="primary" onClick={apply}>
            {t('common.action.apply')}
          </Button>
        </>
      }
    >
      <Field label={t('editor.inspector.htmlSource')}>
        <CodeEditor
          value={html}
          language="html"
          height={260}
          ariaLabel={t('editor.inspector.htmlSource')}
          onChange={(next) => setHtml(next)}
        />
      </Field>
      <Field label={t('editor.inspector.htmlCss')}>
        <CodeEditor
          value={css}
          language="css"
          height={170}
          ariaLabel={t('editor.inspector.htmlCss')}
          onChange={(next) => setCss(next)}
        />
      </Field>
    </Modal>
  )
}
