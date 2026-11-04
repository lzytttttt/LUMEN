/**
 * LintTab.tsx —— 检查页签：优先用 render-core 的 lintDeck，缺失时用本地基础规则。
 * v0.4.0：并入插件代码式 lint 规则（`${pluginId}/${ruleId}`，只报不改，02 §5.3 / §4.5）。
 * 每条问题可点击跳转到对应幕与块（uiStore.setActiveSlide + selectionStore.setSelection）。
 */
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useSelectionStore } from '@/state/selectionStore'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import { Button, Section } from '@/ui/primitives'
import { runPluginLintRules, usePluginsRevision } from '@/plugins/public'
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
  const lang = useSettingsStore((s) => s.lang)
  const deck = useDeckStore((s) => s.deck)
  const setActiveSlide = useUiStore((s) => s.setActiveSlide)
  const setInspectorTab = useUiStore((s) => s.setInspectorTab)
  const setSelection = useSelectionStore((s) => s.setSelection)
  const [nonce, setNonce] = useState(0)
  const { issues, kernel } = useDeckLint(deck, nonce)
  const pluginsRevision = usePluginsRevision()
  /** 插件代码式规则结果（异步、帧内执行；超时/未启用时为空，不报错）。 */
  const [pluginIssues, setPluginIssues] = useState<DeckIssue[]>([])
  const [pluginBusy, setPluginBusy] = useState(false)

  useEffect(() => {
    if (!deck) {
      setPluginIssues([])
      return
    }
    let alive = true
    setPluginBusy(true)
    void runPluginLintRules()
      .then((findings) => {
        if (!alive) return
        setPluginIssues(
          findings.map((finding) => ({
            code: finding.code,
            severity: finding.severity,
            slideId: finding.slideId,
            blockId: finding.blockId,
            message: finding.message[lang] || finding.message.zh || finding.message.en,
            params: finding.params,
          })),
        )
      })
      .catch(() => {
        if (alive) setPluginIssues([])
      })
      .finally(() => {
        if (alive) setPluginBusy(false)
      })
    return () => {
      alive = false
    }
  }, [deck, nonce, lang, pluginsRevision])

  const allIssues = pluginIssues.length > 0 ? [...issues, ...pluginIssues] : issues

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
      <div className={allIssues.length === 0 ? 'insp-lint-summary insp-lint-summary--ok' : 'insp-lint-summary'}>
        {allIssues.length === 0
          ? t('editor.lint.ok')
          : t('editor.lint.count', { count: allIssues.length })}
        {pluginBusy ? <span className="insp-note"> · {t('plugin.preflight.checking')}</span> : null}
      </div>

      {allIssues.length > 0 ? (
        <div className="insp-lint-list">
          {allIssues.map((issue, index) => {
            const indexInDeck = slideIndexOf(issue.slideId)
            const labelKey = LINT_KEYS[issue.code]
            const label = labelKey ? t(labelKey, issue.params) : issue.message ?? issue.code
            const fromPlugin = issue.code.includes('/')
            return (
              <button
                key={`${issue.code}-${issue.blockId ?? issue.slideId ?? index}-${index}`}
                type="button"
                className="insp-lint-item"
                data-plugin-lint={fromPlugin ? issue.code : undefined}
                onClick={() => jump(issue)}
                title={t('editor.lint.jump')}
              >
                <span className={`insp-lint-dot insp-lint-dot--${issue.severity}`} />
                <span className="insp-lint-text">
                  {label}
                  {fromPlugin ? <span className="plug-badge">{t('common.plugin.badge.plugin')}</span> : null}
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
