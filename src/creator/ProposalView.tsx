/**
 * creator/ProposalView.tsx —— 提案卡 + 视图页签（文件树 / 只读代码 / 差异 / 版本历史）。
 *
 * 钩子（06 §3.1）：`[data-creator-proposal="draft/<id>@<rev>"]` 在提案卡；
 * `[data-creator-code]`、`[data-creator-code-status]` 在代码视图；
 * 文件树 `role="tree"`、代码视图 `aria-label`（A-40-01）。
 */
import { useMemo } from 'react'
import type { CreatorProposal } from '@/plugins/types'
import { Button } from '@/ui/primitives'
import { CodeEditor } from '@/ui/code/CodeEditor'
import { CREATOR_KEYS, useCreatorT } from './i18n'
import { FileTree } from './FileTree'
import { DiffView } from './DiffView'
import { HistoryList } from './HistoryList'
import { PermissionBar } from './PermissionBar'
import { defaultCodePath } from './text-diff'
import { sortCreatorFiles } from './proposal'
import { useCreatorStore, type CreatorViewTab } from './store'
import { isTrialActive, type CreatorMachine, type CreatorHistoryEntry } from './state'

const RISK_KEYS: Record<CreatorProposal['risk'], string> = {
  low: CREATOR_KEYS.riskLow,
  medium: CREATOR_KEYS.riskMedium,
  high: CREATOR_KEYS.riskHigh,
}

const SENSITIVE = new Set(['ai:invoke', 'deck:write', 'asset:write', 'export:hook'])

export function ProposalView({
  machine,
  proposal,
  history,
  draftId,
}: {
  machine: CreatorMachine
  proposal: CreatorProposal
  history: CreatorHistoryEntry[]
  draftId: string | null
}) {
  const t = useCreatorT()
  const view = useCreatorStore((state) => state.view)
  const setView = useCreatorStore((state) => state.setView)
  const trialConflict = useCreatorStore((state) => state.trialConflict)

  const tabs: { id: CreatorViewTab; label: string }[] = [
    { id: 'files', label: t(CREATOR_KEYS.viewFiles) },
    { id: 'code', label: t(CREATOR_KEYS.viewCode) },
    { id: 'diff', label: t(CREATOR_KEYS.viewDiff) },
    { id: 'history', label: t(CREATOR_KEYS.history) },
  ]

  return (
    <>
      <section
        className="creator-card"
        aria-label={t(CREATOR_KEYS.a11yProposal)}
        data-creator-proposal={`draft/${draftId ?? ''}@${machine.revision}`}
      >
        <div className="creator-card__title">{proposal.title}</div>
        <div className="creator-card__summary">{proposal.summary}</div>
        <div className="creator-badges">
          <span className={`creator-badge creator-badge--risk-${proposal.risk}`}>
            {t(RISK_KEYS[proposal.risk])}
          </span>
          <span className="creator-badge">
            {proposal.kind} · {proposal.files.length} {t(CREATOR_KEYS.files)}
          </span>
          {proposal.capabilities.map((capability) => (
            <span
              key={capability}
              className={
                SENSITIVE.has(capability)
                  ? 'creator-badge creator-badge--sensitive'
                  : 'creator-badge'
              }
              data-permission={capability}
              data-granted={
                machine.grantedCapabilities.includes(capability) ||
                (!SENSITIVE.has(capability) && proposal.capabilities.includes(capability))
                  ? 'true'
                  : 'false'
              }
            >
              {capability}
            </span>
          ))}
        </div>
        <ul className="creator-changes">
          {proposal.changes.map((change, index) => (
            <li key={`${change.surface}-${index}`}>
              {change.detail}
              <span className="creator-changes__surface">{change.surface}</span>
            </li>
          ))}
        </ul>
        {proposal.trialNote ? (
          <div className="creator-hint">
            {t(CREATOR_KEYS.trialNote)}：{proposal.trialNote}
          </div>
        ) : null}
        {/* 首次提案：diff 区显示「第一版」。06 CR-40-29 要求这条文案可见；后续版本用页签查看。 */}
        {history.length <= 1 ? (
          <div data-creator-diff="" className="creator-empty" role="region" aria-label={t(CREATOR_KEYS.a11yDiff)}>
            {t(CREATOR_KEYS.diffEmpty)}
          </div>
        ) : null}
      </section>

      <div className="creator-tabs" role="tablist" aria-label={t(CREATOR_KEYS.proposalTitle)}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            className={view === tab.id ? 'creator-tab creator-tab--active' : 'creator-tab'}
            onClick={() => setView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="creator-view">
        {view === 'files' ? <FileTree proposal={proposal} /> : null}
        {view === 'code' ? <CodePane proposal={proposal} /> : null}
        {view === 'diff' ? <DiffView proposal={proposal} history={history} baselineRevision={null} /> : null}
        {view === 'history' ? <HistoryList history={history} /> : null}
      </div>

      {trialConflict ? <ConflictCard /> : null}

      {isTrialActive(machine.status) || machine.status === 'saved' || machine.status === 'reverted' ? (
        <TrialResultCard machine={machine} />
      ) : null}

      <PermissionBar machine={machine} proposal={proposal} />
    </>
  )
}

/* ------------------------------ 代码视图 ------------------------------ */

function CodePane({ proposal }: { proposal: CreatorProposal }) {
  const t = useCreatorT()
  const codePath = useCreatorStore((state) => state.codePath)
  const files = useMemo(() => sortCreatorFiles(proposal.files), [proposal.files])
  const path = codePath || defaultCodePath(files)
  const file = files.find((item) => item.path === path) ?? files[0]
  if (!file) return <div className="creator-empty">{t(CREATOR_KEYS.viewReadOnly)}</div>

  const language = file.path.endsWith('.json')
    ? 'json'
    : file.path.endsWith('.svg')
      ? 'svg'
      : file.path.endsWith('.css')
        ? 'css'
        : null

  return (
    <div data-creator-code={file.path} data-creator-code-status={language ? 'ready' : 'fallback'}>
      <div className="creator-code-status">{t(CREATOR_KEYS.viewReadOnly)}</div>
      {language ? (
        <CodeEditor
          value={file.content}
          language={language}
          readOnly
          height={Math.min(420, Math.max(220, file.content.split('\n').length * 18))}
          onChange={() => {}}
          ariaLabel={file.path}
        />
      ) : (
        <pre className="creator-code" aria-label={file.path}>
          {file.content.split('\n').map((line, index) => (
            <span key={index} className="creator-code__line">
              {line}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </div>
  )
}

/* ------------------------------ 结果卡 / 冲突卡 ------------------------------ */

function TrialResultCard({ machine }: { machine: CreatorMachine }) {
  const t = useCreatorT()
  const installedName = useCreatorStore((state) => state.installedName)
  const exportPlugin = useCreatorStore((state) => state.exportPlugin)
  const discardDraft = useCreatorStore((state) => state.discardDraft)

  if (machine.status === 'saved') {
    return (
      <div className="creator-result">
        <strong>{t(CREATOR_KEYS.keepDone)}</strong>
        {installedName ? <span className="creator-hint">{installedName}</span> : null}
        <div className="creator-actions">
          <Button size="sm" variant="outline" onClick={() => void exportPlugin()}>
            {t(CREATOR_KEYS.exportPlugin)}
          </Button>
          <Button size="sm" variant="subtle" onClick={() => void discardDraft()}>
            {t(CREATOR_KEYS.new)}
          </Button>
        </div>
      </div>
    )
  }
  if (machine.status === 'reverted') {
    return (
      <div className="creator-result">
        <strong>{t(CREATOR_KEYS.revertDone)}</strong>
        <div className="creator-actions">
          <Button size="sm" variant="primary" onClick={() => void useCreatorStore.getState().startTrial()}>
            {/* 再试一次 = 重新试跑当前提案 */}
            {t(CREATOR_KEYS.try)}
          </Button>
          <Button size="sm" variant="subtle" onClick={() => void discardDraft()}>
            {t(CREATOR_KEYS.new)}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="creator-result" data-creator-trial-note="">
      <span className="creator-hint">
        {t(CREATOR_KEYS.trialRunning)} · {t(CREATOR_KEYS.trialHint)}
      </span>
    </div>
  )
}

function ConflictCard() {
  const t = useCreatorT()
  const resolve = useCreatorStore((state) => state.resolveTrialConflict)
  return (
    <div className="creator-error" role="alert" data-creator-conflict="">
      <span className="creator-error__title">{t(CREATOR_KEYS.conflictTitle)}</span>
      <div className="creator-actions">
        <Button size="sm" variant="primary" onClick={() => void resolve('keep-edits')}>
          {t(CREATOR_KEYS.conflictKeepEdits)}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void resolve('restore-deck')}>
          {t(CREATOR_KEYS.conflictRestoreDeck)}
        </Button>
      </div>
    </div>
  )
}
