/**
 * creator/DiffView.tsx —— 行级差异视图（04 §5.3 / 06 U-40-185/186）。
 *
 * 对比基准 = 当前 revision ↔ 选中历史版；首次提案显示「第一版，没有可对比的差异」；
 * 超限时显示整文件替换 + `creator.view.tooLarge`（由 text-diff 的 tooLarge 标记驱动）。
 */
import type { CreatorProposal } from '@/plugins/types'
import { diffLines, defaultCodePath, hunkHeader } from './text-diff'
import { useCreatorT, CREATOR_KEYS } from './i18n'
import { useCreatorStore } from './store'
import type { CreatorHistoryEntry } from './state'

export function DiffView({
  proposal,
  history,
  baselineRevision,
}: {
  proposal: CreatorProposal
  history: CreatorHistoryEntry[]
  baselineRevision: number | null
}) {
  const t = useCreatorT()
  const setDiffRevision = useCreatorStore((state) => state.setDiffRevision)
  const currentPath = useCreatorStore((state) => state.codePath) || defaultCodePath(proposal.files)

  const versions = [...history].sort((a, b) => a.revision - b.revision)
  const currentRevision = versions.length > 0 ? versions[versions.length - 1].revision : 0
  const baseline =
    baselineRevision !== null
      ? versions.find((entry) => entry.revision === baselineRevision)
      : versions[versions.length - 2]
  const activePath = currentPath

  const beforeFile = baseline?.proposal.files.find((file) => file.path === activePath)
  const afterFile = proposal.files.find((file) => file.path === activePath)

  return (
    <div data-creator-diff="" role="region" aria-label={t(CREATOR_KEYS.a11yDiff)}>
      <div className="creator-badges" style={{ paddingBottom: 6 }}>
        <select
          className="lm-select"
          value={String(baseline?.revision ?? '')}
          onChange={(event) => setDiffRevision(event.target.value === '' ? null : Number(event.target.value))}
          aria-label={t(CREATOR_KEYS.history)}
        >
          {versions
            .filter((entry) => entry.revision !== currentRevision)
            .map((entry) => (
              <option key={entry.revision} value={entry.revision}>
                v{entry.revision} ↔ v{currentRevision}
              </option>
            ))}
          {baseline ? null : <option value="">—</option>}
        </select>
        <span className="creator-history__meta">
          {activePath} ↔ v{baseline?.revision ?? '?'}
        </span>
      </div>

      {!beforeFile || !afterFile ? (
        <div className="creator-empty">{t(CREATOR_KEYS.diffEmpty)}</div>
      ) : (
        <DiffBody
          before={beforeFile.content}
          after={afterFile.content}
          tooLargeLabel={t(CREATOR_KEYS.tooLarge, { n: 1200 })}
        />
      )}
    </div>
  )
}

function DiffBody({ before, after, tooLargeLabel }: { before: string; after: string; tooLargeLabel: string }) {
  const result = diffLines(before, after)
  if (result.tooLarge) {
    return (
      <div>
        <div className="creator-code-status">{tooLargeLabel}</div>
        <pre className="creator-diff">
          {result.hunks.map((hunk) => (
            <span key={`${hunk.oldStart}-${hunk.newStart}`}>
              <span className="creator-diff__hunk">{hunkHeader(hunk)}</span>
              {hunk.lines.map((line, index) => (
                <span
                  key={index}
                  className={
                    line.kind === 'add'
                      ? 'creator-diff__line creator-diff__line--add'
                      : line.kind === 'remove'
                        ? 'creator-diff__line creator-diff__line--remove'
                        : 'creator-diff__line'
                  }
                >
                  <span className="creator-diff__num">{line.oldLine ?? ''}</span>
                  <span className="creator-diff__num">{line.newLine ?? ''}</span>
                  <span className="creator-diff__sign">
                    {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                  </span>
                  {line.text}
                </span>
              ))}
            </span>
          ))}
        </pre>
      </div>
    )
  }
  if (result.hunks.length === 0) {
    return <div className="creator-empty">—</div>
  }
  return (
    <pre className="creator-diff">
      {result.hunks.map((hunk) => (
        <span key={`${hunk.oldStart}-${hunk.newStart}`}>
          <span className="creator-diff__hunk">{hunkHeader(hunk)}</span>
          {hunk.lines.map((line, index) => (
            <span
              key={index}
              className={
                line.kind === 'add'
                  ? 'creator-diff__line creator-diff__line--add'
                  : line.kind === 'remove'
                    ? 'creator-diff__line creator-diff__line--remove'
                    : 'creator-diff__line'
              }
            >
              <span className="creator-diff__num">{line.oldLine ?? ''}</span>
              <span className="creator-diff__num">{line.newLine ?? ''}</span>
              <span className="creator-diff__sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}</span>
              {line.text}
            </span>
          ))}
        </span>
      ))}
    </pre>
  )
}
