/**
 * ExportDialog.tsx —— 导出弹窗（独立 HTML / PDF / PNG / 工程文件）。
 *
 * 「工程文件」页真实可用（@/export/projectFile 已实现，含导入）；
 * 其余三页通过 exporterBridge 动态探测导出内核，缺失时给出明确提示而不是崩溃。
 */
import { useEffect, useState } from 'react'
import { Download, FileJson, Upload } from 'lucide-react'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { deckOps } from '@/state/ops'
import { slugify } from '@/schema/ids'
import { exportProjectFile, openFilePicker, readProjectFileText } from '@/export/projectFile'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { Button, Field, Modal, Segmented, Switch } from '@/ui/primitives'
import { exporterAvailable, runExporter, type ExportKind } from './exporterBridge'
import './dialogs.css'

type Tab = 'standalone' | 'pdf' | 'png' | 'file'

const TABS: { id: Tab; key: MessageKey }[] = [
  { id: 'standalone', key: 'export.tabStandalone' },
  { id: 'pdf', key: 'export.tabPdf' },
  { id: 'png', key: 'export.tabPng' },
  { id: 'file', key: 'export.tabFile' },
]

interface Status {
  kind: 'ok' | 'warn' | 'error'
  text: string
}

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const deck = useDeckStore((s) => s.deck)
  const pushToast = useUiStore((s) => s.pushToast)
  const [tab, setTab] = useState<Tab>('standalone')
  const [busy, setBusy] = useState<Tab | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [includeAssets, setIncludeAssets] = useState(true)
  const [includeNotes, setIncludeNotes] = useState(false)
  const [scope, setScope] = useState<'all' | 'current'>('all')

  useEffect(() => {
    if (!open) return
    setStatus(null)
    setBusy(null)
  }, [open, tab])

  const fileStem = deck ? slugify(deck.title || 'lumen-deck') : 'lumen-deck'

  const runKernel = async (kind: ExportKind) => {
    if (!deck) return
    setBusy(kind)
    const outcome = await runExporter(kind, deck, {
      includeAssets,
      includeNotes,
      scope,
      scale: 2,
      fileName: fileStem,
    })
    setBusy(null)
    if (outcome.status === 'ok') {
      setStatus({ kind: 'ok', text: t('export.done') })
      pushToast({ kind: 'success', message: t('export.done') })
      return
    }
    if (outcome.status === 'missing') {
      setStatus({ kind: 'warn', text: t('editor.dialog.exportMissing') })
      pushToast({ kind: 'info', message: t('editor.dialog.exportMissing') })
      return
    }
    const text = t('export.failed', { reason: outcome.error ?? '' })
    setStatus({ kind: 'error', text })
    pushToast({ kind: 'error', message: text })
  }

  const exportProject = async () => {
    if (!deck) return
    setBusy('file')
    try {
      await exportProjectFile(deck)
      pushToast({ kind: 'success', message: t('export.done') })
      setStatus({ kind: 'ok', text: t('export.done') })
    } catch (error) {
      const text = t('export.failed', { reason: error instanceof Error ? error.message : String(error) })
      pushToast({ kind: 'error', message: text })
      setStatus({ kind: 'error', text })
    } finally {
      setBusy(null)
    }
  }

  const importProject = async () => {
    const file = await openFilePicker('.json,application/json')
    if (!file) return
    setBusy('file')
    try {
      const text = await file.text()
      const result = await readProjectFileText(text)
      deckOps.replaceDeck(result.deck, { resetHistory: true })
      pushToast({ kind: 'success', message: t('export.importSuccess', { title: result.deck.title }) })
      onClose()
    } catch (error) {
      pushToast({
        kind: 'error',
        message: t('export.importError', { reason: error instanceof Error ? error.message : String(error) }),
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('export.title')}
      subtitle={t('export.subtitle')}
      closeLabel={t('common.action.close')}
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t('common.action.close')}
        </Button>
      }
    >
      <div className="ldlg-tabs" role="tablist" aria-label={t('export.title')}>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'ldlg-tab ldlg-tab--active' : 'ldlg-tab'}
            onClick={() => setTab(item.id)}
          >
            {t(item.key)}
          </button>
        ))}
      </div>

      {tab === 'standalone' ? (
        <div className="ldlg-pane">
          <p className="ldlg-hint">{t('export.standaloneHint')}</p>
          <Field label={t('export.fileName')}>
            <div className="ldlg-file">{fileStem}.html</div>
          </Field>
          <Field label={t('export.options')}>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Switch checked={includeAssets} onCheckedChange={setIncludeAssets} label={t('export.includeAssets')} />
                <span className="insp-note">{t('export.includeAssets')}</span>
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Switch checked={includeNotes} onCheckedChange={setIncludeNotes} label={t('export.includeNotes')} />
                <span className="insp-note">{t('export.includeNotes')}</span>
              </span>
            </div>
          </Field>
          <div className="ldlg-actions">
            <Button
              variant="primary"
              icon={<Download size={13} />}
              disabled={!deck || busy !== null || !exporterAvailable('standalone')}
              onClick={() => void runKernel('standalone')}
            >
              {busy === 'standalone' ? t('export.building') : t('export.build')}
            </Button>
          </div>
          {!exporterAvailable('standalone') ? (
            <div className="ldlg-status ldlg-status--warn">{t('editor.dialog.exportMissingHint')}</div>
          ) : null}
        </div>
      ) : null}

      {tab === 'pdf' ? (
        <div className="ldlg-pane">
          <p className="ldlg-hint">{t('export.pdfHint')}</p>
          <div className="ldlg-actions">
            <Button
              variant="primary"
              icon={<Download size={13} />}
              disabled={!deck || busy !== null || !exporterAvailable('pdf')}
              onClick={() => void runKernel('pdf')}
            >
              {busy === 'pdf' ? t('export.building') : t('export.pdfPrint')}
            </Button>
          </div>
          {!exporterAvailable('pdf') ? (
            <div className="ldlg-status ldlg-status--warn">{t('editor.dialog.exportMissingHint')}</div>
          ) : null}
        </div>
      ) : null}

      {tab === 'png' ? (
        <div className="ldlg-pane">
          <p className="ldlg-hint">{t('export.pngHint')}</p>
          <Field label={t('export.scope')}>
            <Segmented
              value={scope}
              block
              onValueChange={(next) => setScope(next)}
              options={[
                { value: 'all', label: t('export.scopeAll') },
                { value: 'current', label: t('export.scopeCurrent') },
              ]}
            />
          </Field>
          <div className="ldlg-actions">
            <Button
              variant="primary"
              icon={<Download size={13} />}
              disabled={!deck || busy !== null || !exporterAvailable('png')}
              onClick={() => void runKernel('png')}
            >
              {busy === 'png' ? t('export.building') : t('export.pngAll')}
            </Button>
          </div>
          {!exporterAvailable('png') ? (
            <div className="ldlg-status ldlg-status--warn">{t('editor.dialog.exportMissingHint')}</div>
          ) : null}
        </div>
      ) : null}

      {tab === 'file' ? (
        <div className="ldlg-pane">
          <p className="ldlg-hint">{t('export.fileHint')}</p>
          <div className="ldlg-file">
            <FileJson size={13} />
            {fileStem}.lumen.json
          </div>
          <div className="ldlg-actions">
            <Button
              variant="primary"
              icon={<Download size={13} />}
              disabled={!deck || busy !== null}
              onClick={() => void exportProject()}
            >
              {t('export.fileExport')}
            </Button>
            <Button variant="outline" icon={<Upload size={13} />} disabled={busy !== null} onClick={() => void importProject()}>
              {t('export.fileImport')}
            </Button>
          </div>
        </div>
      ) : null}

      {status ? <div className={`ldlg-status ldlg-status--${status.kind}`}>{status.text}</div> : null}
    </Modal>
  )
}
