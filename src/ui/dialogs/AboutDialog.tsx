/**
 * AboutDialog.tsx —— 关于：版本、技术栈、隐私承诺与当前存储策略。
 */
import { useT } from '@/i18n'
import { Button, Modal } from '@/ui/primitives'
import './dialogs.css'

const APP_VERSION = '0.1.0'

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`LUMEN · ${t('common.app.subtitle')}`}
      subtitle={t('common.app.tagline')}
      size="sm"
      closeLabel={t('common.action.close')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('common.action.close')}
        </Button>
      }
    >
      <div className="ldlg-about">
        <p className="ldlg-about__tagline">{t('editor.dialog.aboutBody')}</p>
        <div className="ldlg-about-card">
          <span className="ldlg-about-card__logo">
            LUMEN<span>.</span>
          </span>
          <span className="ldlg-about-card__meta">
            {t('editor.dialog.aboutVersion', { version: APP_VERSION })}
          </span>
        </div>
        <div>
          <div className="ins-group__title" style={{ padding: 0, marginBottom: 4 }}>
            {t('editor.dialog.aboutStack')}
          </div>
          <ul className="ldlg-about__list">
            <li>React 19 · Vite 7 · TypeScript 5.9</li>
            <li>zustand 5 · immer 11 · zod 3</li>
            <li>three.js r186 · DOMPurify 3 · CodeMirror 6</li>
          </ul>
        </div>
        <p className="ldlg-about__tagline" style={{ fontSize: 12, color: 'var(--ui-fg-mute)' }}>
          {t('editor.dialog.aboutPrivacy')}
        </p>
      </div>
    </Modal>
  )
}
