/**
 * creator/HistoryList.tsx —— 版本历史（04 §5.4：最近 10 版、切版只换提案、不自动试跑）。
 */
import { useCreatorT, CREATOR_KEYS } from './i18n'
import { useCreatorStore } from './store'
import type { CreatorHistoryEntry } from './state'

export function HistoryList({ history }: { history: CreatorHistoryEntry[] }) {
  const t = useCreatorT()
  const revision = useCreatorStore((state) => state.machine.revision)
  const pickHistory = useCreatorStore((state) => state.pickHistory)
  const sorted = [...history].sort((a, b) => b.revision - a.revision)

  if (sorted.length === 0) {
    return <div className="creator-empty">{t(CREATOR_KEYS.diffEmpty)}</div>
  }

  return (
    <ul className="creator-history" aria-label={t(CREATOR_KEYS.history)}>
      {sorted.map((entry) => {
        const active = entry.revision === revision
        return (
          <li key={entry.revision}>
            <button
              type="button"
              className={
                active ? 'creator-history__item creator-history__item--active' : 'creator-history__item'
              }
              aria-current={active ? 'true' : undefined}
              onClick={() => void pickHistory(entry.revision)}
            >
              <span>{entry.proposal.title}</span>
              <span className="creator-history__meta">
                v{entry.revision} · {entry.proposal.files.length} {t(CREATOR_KEYS.files)}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
