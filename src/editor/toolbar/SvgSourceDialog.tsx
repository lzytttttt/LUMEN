/**
 * SvgSourceDialog.tsx —— 粘贴（或改写）SVG 源码后插入画布。
 * 插入路径统一走 insertActions.insertSvgSource，因此必然经过 DOMPurify + 令牌化净化。
 */
import { useState } from 'react'
import { blankSvgSource } from '@/schema/factory'
import { useUiStore } from '@/state/uiStore'
import { useT } from '@/i18n'
import { Button, Field, Modal } from '@/ui/primitives'
import { CodeEditor } from '@/ui/code/CodeEditor'
import { insertSvgSource } from './insertActions'

export function SvgSourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const pushToast = useUiStore((s) => s.pushToast)
  const [source, setSource] = useState<string>(() => blankSvgSource())

  const submit = () => {
    const issues = insertSvgSource(source)
    if (issues === null) return
    if (issues > 0) {
      pushToast({ kind: 'info', message: t('editor.insert.svgSanitized', { count: issues }) })
    }
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('editor.insert.pasteSvgTitle')}
      subtitle={t('editor.insert.pasteSvgHint')}
      size="lg"
      closeLabel={t('common.action.close')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.action.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} disabled={source.trim() === ''}>
            {t('editor.insert.insertNow')}
          </Button>
        </>
      }
    >
      <Field label={t('editor.inspector.svgSource')}>
        <CodeEditor
          value={source}
          language="svg"
          height={340}
          ariaLabel={t('editor.insert.pasteSvgTitle')}
          onChange={(next) => setSource(next)}
        />
      </Field>
    </Modal>
  )
}
