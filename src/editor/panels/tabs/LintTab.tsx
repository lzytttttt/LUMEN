/**
 * LintTab.tsx —— 检查页签：优先用 render-core 的 lintDeck，缺失时用本地基础规则。
 * 每条问题可点击跳转到对应幕与块（uiStore.setActiveSlide + selectionStore.setSelection）。
 */
import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { useSelectionStore } from '@/state/selectionStore'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { Button, Section } from '@/ui/primitives'
import { useDeckLint, type DeckIssue } from '../lintBridge'

const LINT_KEYS: Record<string, MessageKey> = {
  // render-core（src/lint/deckLint.ts）的稳定 code
  slideCount: 'editor.lint.slideCount',
  tooManyBlocks: 'editor.lint.tooManyBlocks',
  textOverflow: 'editor.lint.textOverflow',
  fontTooSmall: 'editor.lint.fontTooSmall',
  outOfBounds: 'editor.lint.outOfBounds',
  readingTime: 'editor.lint.readingTime',
  emptyBlock: 'editor.lint.emptyBlock',
  // 共用 code
  emptySlide: 'editor.lint.emptySlide',
  threeBudget: 'editor.lint.threeBudget',
  contrast: 'editor.lint.contrast',
  missingAlt: 'editor.lint.missingAlt',
  assetMissing: 'editor.lint.assetMissing',
  // 本地兜底检查的 code
  overflow: 'editor.lint.overflow',
  offstage: 'editor.lint.offstage',
  emptyText: 'editor.lint.emptyText',
  tooSmall: 'editor.lint.tooSmall',
  tinyText: 'editor.lint.tinyText',
  denseSlide: 'editor.lint.denseSlide',
  svgUnsafe: 'editor.lint.svgUnsafe',
}

export function LintTab() {
  const t = useT()
  const deck = useDeckStore((s) => s.deck)
  const setActiveSlide = useUiStore((s) => s.setActiveSlide)
  const setInspectorTab = useUiStore((s) => s.setInspectorTab)
  const setSelection = useSelectionStore((s) => s.setSelection)
  const [nonce, setNonce] = useState(0)
  const { issues, kernel } = useDeckLint(deck, nonce)

  const jump = (issue: DeckIssue) => {
    if (issue.slideId) setActiveSlide(issue.slideId)
    if (issue.blockId) {
      setSelection([issue.blockId])
      setInspectorTab('props')
    }
  }

  const slideIndexOf = (slideId: string | undefined) => {
    if (!slideId || !deck) return -1
    return deck.slides.findIndex((slide) => slide.id === slideId)
  }

  return (
    <Section
      title={t('editor.lint.title')}
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={12} />}
          onClick={() => setNonce((value) => value + 1)}
        >
          {t('editor.lint.rerun')}
        </Button>
      }
    >
      <div className={issues.length === 0 ? 'insp-lint-summary insp-lint-summary--ok' : 'insp-lint-summary'}>
        {issues.length === 0
          ? t('editor.lint.ok')
          : t('editor.lint.count', { count: issues.length })}
      </div>

      {issues.length > 0 ? (
        <div className="insp-lint-list">
          {issues.map((issue, index) => {
            const indexInDeck = slideIndexOf(issue.slideId)
            const labelKey = LINT_KEYS[issue.code]
            const label = labelKey ? t(labelKey, issue.params) : issue.message ?? issue.code
            return (
              <button
                key={`${issue.code}-${issue.blockId ?? issue.slideId ?? index}-${index}`}
                type="button"
                className="insp-lint-item"
                onClick={() => jump(issue)}
                title={t('editor.lint.jump')}
              >
                <span className={`insp-lint-dot insp-lint-dot--${issue.severity}`} />
                <span className="insp-lint-text">
                  {label}
                  {indexInDeck >= 0 ? (
                    <span className="insp-lint-where">
                      {t('common.label.page')} {String(indexInDeck + 1).padStart(2, '0')}
                      {issue.blockId ? ` · ${issue.blockId.slice(0, 10)}` : ''}
                    </span>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}

      {kernel !== 'module' ? <p className="insp-note">{t('editor.lint.modulePending')}</p> : null}
    </Section>
  )
}
