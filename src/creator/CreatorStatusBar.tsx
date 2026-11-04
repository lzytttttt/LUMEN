/**
 * creator/CreatorStatusBar.tsx —— 28px 状态条（04 §2.2 / §10 aria-live 唯一区域）。
 *
 * 只播报状态与关键事件（节流 ≥1.5s），不在 token 级播报；
 * `data-creator-state` 挂在面板根，这里只做文案与 token 估算（仅真实端点显示，04 §6.4）。
 */
import { useEffect, useRef, useState } from 'react'
import { channelInfo } from '@/ai/provider'
import { useSettingsStore } from '@/state/settingsStore'
import { Button } from '@/ui/primitives'
import { useCreatorT, CREATOR_KEYS } from './i18n'
import type { CreatorMachine } from './state'
import { creatorStatusMessageKey } from './state'

const ANNOUNCE_MIN_MS = 1500

export function CreatorStatusBar({
  machine,
  promptTokens,
  onCancel,
}: {
  machine: CreatorMachine
  promptTokens: number
  onCancel: () => void
}) {
  const t = useCreatorT()
  const llm = useSettingsStore((state) => state.llm)
  const channel = channelInfo(llm)
  const [announcement, setAnnouncement] = useState('')
  const lastAt = useRef(0)
  const busy = machine.status === 'reading' || machine.status === 'proposing'

  // aria-live 唯一区域：节流 ≥1.5s（A-40-02）。
  useEffect(() => {
    const now = Date.now()
    if (now - lastAt.current < ANNOUNCE_MIN_MS) return
    lastAt.current = now
    const statusText = t(creatorStatusMessageKey(machine.status))
    if (machine.status === 'proposal-ready' && machine.proposal) {
      setAnnouncement(
        `${t(CREATOR_KEYS.liveProposalReady, { n: machine.proposal.files.length })} · ${statusText}`,
      )
    } else {
      setAnnouncement(t(CREATOR_KEYS.liveStateChanged, { state: statusText }))
    }
  }, [machine.status, machine.proposal, t])

  const failed = machine.status === 'failed'
  const classes = [
    'creator-status',
    busy ? 'creator-status--busy' : '',
    failed ? 'creator-status--failed' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} role="status" aria-live="polite" aria-atomic="true" data-creator-status={machine.status}>
      <span className="creator-status__dot" aria-hidden="true" />
      <span>{t(creatorStatusMessageKey(machine.status))}</span>
      {machine.interrupted ? <span className="creator-status__tokens">{t(CREATOR_KEYS.stateInterrupted)}</span> : null}
      <span className="creator-status__tokens" aria-hidden="true">
        {channel.id === 'openai' && promptTokens > 0 ? `≈ ${promptTokens} tokens` : channel.id}
      </span>
      {busy ? (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t(CREATOR_KEYS.cancel)}
        </Button>
      ) : null}
      <span className="creator-view__sr" hidden>
        {announcement}
      </span>
    </div>
  )
}
