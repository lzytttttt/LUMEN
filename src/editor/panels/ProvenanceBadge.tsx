/**
 * ProvenanceBadge.tsx —— AI 溯源角标。
 * 有 provenance 时显示 AI 徽标，点开看提供方/时间/配方，并可「还原 AI 版本」（aiSnapshot）。
 */
import { useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { blockSchema, type Block } from '@/schema/deck'
import { blockOps } from '@/state/ops'
import { useUiStore } from '@/state/uiStore'
import { useSettingsStore } from '@/state/settingsStore'
import { formatDate, useT } from '@/i18n'
import { Popover, PopoverRow, PopoverSeparator } from '@/ui/primitives'

export function ProvenanceBadge({ block }: { block: Block }) {
  const t = useT()
  const lang = useSettingsStore((s) => s.lang)
  const pushToast = useUiStore((s) => s.pushToast)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const provenance = block.provenance

  if (!provenance) {
    return <span className="insp-prov insp-prov--none">{t('editor.inspector.provenanceEmpty')}</span>
  }

  const restore = () => {
    if (!block.aiSnapshot) {
      pushToast({ kind: 'info', message: t('editor.inspector.provenance.noSnapshot') })
      setOpen(false)
      return
    }
    try {
      const parsed = blockSchema.parse(JSON.parse(block.aiSnapshot)) as Block
      blockOps.replace({ ...parsed, id: block.id })
      pushToast({ kind: 'success', message: t('editor.toast.aiRestored') })
    } catch (error) {
      pushToast({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
    setOpen(false)
  }

  return (
    <span className="insp-prov">
      <button
        ref={anchorRef}
        type="button"
        className="insp-prov__chip"
        aria-expanded={open}
        title={t('editor.inspector.provenance.title')}
        onClick={() => setOpen((value) => !value)}
      >
        <Sparkles size={10} />
        {t('editor.inspector.provenance.badge')}
      </button>
      <span className="insp-prov__meta">
        {provenance.provider}
        {provenance.model ? ` · ${provenance.model}` : ''}
      </span>

      <Popover open={open} onClose={() => setOpen(false)} anchor={anchorRef.current} width={272} align="end">
        <div className="insp-prov__row">
          <span>{t('editor.inspector.provenance.provider')}</span>
          <span>{provenance.provider}</span>
        </div>
        {provenance.model ? (
          <div className="insp-prov__row">
            <span>{t('editor.inspector.provenance.model')}</span>
            <span>{provenance.model}</span>
          </div>
        ) : null}
        {provenance.recipeId ? (
          <div className="insp-prov__row">
            <span>{t('editor.inspector.provenance.recipe')}</span>
            <span>{provenance.recipeId}</span>
          </div>
        ) : null}
        {provenance.promptDigest ? (
          <div className="insp-prov__row">
            <span>{t('editor.inspector.provenance.prompt')}</span>
            <span>{provenance.promptDigest.slice(0, 28)}</span>
          </div>
        ) : null}
        <div className="insp-prov__row">
          <span>{t('editor.inspector.provenance.at')}</span>
          <span>{formatDate(provenance.at, lang)}</span>
        </div>
        <PopoverSeparator />
        {block.aiSnapshot ? (
          <PopoverRow onClick={restore}>{t('editor.inspector.provenance.restore')}</PopoverRow>
        ) : (
          <div className="insp-prov__row">
            <span>{t('editor.inspector.provenance.restore')}</span>
            <span>{t('editor.inspector.provenance.noSnapshot')}</span>
          </div>
        )}
      </Popover>
    </span>
  )
}
