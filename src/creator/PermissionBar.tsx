/**
 * creator/PermissionBar.tsx —— 权限条 44px（04 §2.2 / §7.2）。
 *
 * 三条硬规则：
 * - 默认只读：非敏感能力默认允许（chips 明示），`deck:write` 必须显式开关 + 确认气泡；
 * - `deck:write` 只在提案含该能力时出现，`[data-permission="deck:write"][data-granted]` 钩子；
 * - 保留/撤销都有确认气泡（不是系统弹窗），保留 = 走正式安装管线（04 §3.3 keep）。
 */
import { useState } from 'react'
import type { CreatorProposal } from '@/plugins/types'
import { SENSITIVE_CAPABILITIES } from '@/plugins/types'
import { Button } from '@/ui/primitives'
import { useCreatorT, CREATOR_KEYS } from './i18n'
import { useCreatorStore } from './store'
import { isTrialActive, type CreatorMachine } from './state'
import { useCreatorSafeMode } from './safeMode'

export function PermissionBar({ machine, proposal }: { machine: CreatorMachine; proposal: CreatorProposal }) {
  const t = useCreatorT()
  const [confirm, setConfirm] = useState<'keep' | 'revert' | null>(null)
  const [showGrant, setShowGrant] = useState(false)
  const startTrial = useCreatorStore((state) => state.startTrial)
  const keep = useCreatorStore((state) => state.keep)
  const revert = useCreatorStore((state) => state.revert)
  const exportPlugin = useCreatorStore((state) => state.exportPlugin)
  const discardDraft = useCreatorStore((state) => state.discardDraft)
  const grantDeckWrite = useCreatorStore((state) => state.grantDeckWrite)
  const installing = useCreatorStore((state) => state.installing)
  const trialSession = useCreatorStore((state) => state.trialSession)

  const status = machine.status
  const active = isTrialActive(status)
  const deckWriteAvailable = proposal.capabilities.includes('deck:write')
  const deckGranted = machine.grantedCapabilities.includes('deck:write')
  const safeMode = useCreatorSafeMode()
  const trialRunning = active && trialSession !== null

  return (
    <>
      <div className="creator-perms" role="group" aria-label={t(CREATOR_KEYS.permissionTitle)}>
        <div className="creator-perms__label">
          <span>{trialRunning ? t(CREATOR_KEYS.trialRunning) : t(CREATOR_KEYS.permissionReadOnly)}</span>
          <span className="creator-perms__hint">
            {trialRunning ? t(CREATOR_KEYS.trialHint) : t(CREATOR_KEYS.permissionReadOnlyHint)}
          </span>
        </div>
        {deckWriteAvailable ? (
          <span
            className={deckGranted ? 'creator-badge creator-badge--sensitive' : 'creator-badge'}
            data-permission="deck:write"
            data-granted={deckGranted ? 'true' : 'false'}
          >
            {deckGranted ? t(CREATOR_KEYS.permissionGranted) : t(CREATOR_KEYS.permissionDenied)} · deck:write
          </span>
        ) : null}
        <span className="creator-perms__spacer" />
        <div className="creator-perms__actions">
          {active ? (
            <>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  // 无敏感能力：一步保留（走正式安装管线）；有敏感能力才弹二次确认（04 §7.2）。
                  if (proposal.capabilities.some((capability) => (SENSITIVE_CAPABILITIES as readonly string[]).includes(capability))) {
                    setConfirm('keep')
                  } else {
                    void keep()
                  }
                }}
                disabled={installing || safeMode}
                title={safeMode ? t(CREATOR_KEYS.errorSafeMode) : undefined}
              >
                {t(CREATOR_KEYS.keep)}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirm('revert')}>
                {t(CREATOR_KEYS.revert)}
              </Button>
              {deckWriteAvailable ? (
                <Button size="sm" variant="ghost" onClick={() => setShowGrant((value) => !value)}>
                  {t(CREATOR_KEYS.permissionTitle)}
                </Button>
              ) : null}
            </>
          ) : null}
          {status === 'proposal-ready' ? (
            <>
              <Button size="sm" variant="primary" onClick={() => void startTrial()} disabled={safeMode} title={safeMode ? t(CREATOR_KEYS.errorSafeMode) : undefined}>
                {t(CREATOR_KEYS.try)}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void exportPlugin()}>
                {t(CREATOR_KEYS.exportPlugin)}
              </Button>
            </>
          ) : null}
          {status === 'saved' || status === 'reverted' ? (
            <>
              <Button size="sm" variant="primary" onClick={() => void exportPlugin()}>
                {t(CREATOR_KEYS.exportPlugin)}
              </Button>
              <Button size="sm" variant="subtle" onClick={() => void discardDraft()}>
                {t(CREATOR_KEYS.new)}
              </Button>
            </>
          ) : null}
          {status === 'failed' ? (
            <Button size="sm" variant="subtle" onClick={() => void discardDraft()}>
              {t(CREATOR_KEYS.trialStop)}
            </Button>
          ) : null}
        </div>
      </div>

      {showGrant && deckWriteAvailable ? (
        <div className="creator-grant" data-creator-grant="">
          <div className="creator-grant__row">
            <strong>{t(CREATOR_KEYS.permissionAllowDeck)}</strong>
            <span className={deckGranted ? 'creator-grant__danger' : ''}>
              {deckGranted ? t(CREATOR_KEYS.permissionGranted) : t(CREATOR_KEYS.permissionDenied)}
            </span>
          </div>
          <div>{t(CREATOR_KEYS.permissionAllowDeckHint)}</div>
          <div className="creator-grant__row">
            <span className="creator-perms__hint">
              {deckGranted ? t(CREATOR_KEYS.confirmRevertBody) : t(CREATOR_KEYS.permissionSensitive)}
            </span>
            <span className="creator-perms__spacer" />
            <Button
              size="sm"
              variant={deckGranted ? 'danger' : 'primary'}
              data-permission-action="deck:write"
              onClick={() => {
                grantDeckWrite(!deckGranted)
                setShowGrant(false)
              }}
            >
              {deckGranted ? t(CREATOR_KEYS.permissionDenied) : t(CREATOR_KEYS.permissionAllowDeck)}
            </Button>
          </div>
        </div>
      ) : null}

      {confirm === 'keep' ? (
        <ConfirmBubble
          title={t(CREATOR_KEYS.confirmKeepTitle)}
          body={t(CREATOR_KEYS.confirmKeepBody, { name: proposal.title })}
          sensitive={proposal.capabilities.filter((capability) => capability === 'deck:write' || capability === 'ai:invoke' || capability === 'asset:write' || capability === 'export:hook')}
          confirmLabel={t(CREATOR_KEYS.keep)}
          cancelLabel={t(CREATOR_KEYS.cancel)}
          sensitiveLabel={t(CREATOR_KEYS.permissionSensitive)}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null)
            void keep()
          }}
        />
      ) : null}

      {confirm === 'revert' ? (
        <ConfirmBubble
          title={t(CREATOR_KEYS.revert)}
          body={t(CREATOR_KEYS.confirmRevertBody)}
          confirmLabel={t(CREATOR_KEYS.revert)}
          cancelLabel={t(CREATOR_KEYS.cancel)}
          dangerous
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null)
            void revert()
          }}
        />
      ) : null}
    </>
  )
}

function ConfirmBubble({
  title,
  body,
  sensitive,
  sensitiveLabel,
  confirmLabel,
  cancelLabel,
  dangerous,
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  sensitive?: string[]
  sensitiveLabel?: string
  confirmLabel: string
  cancelLabel: string
  dangerous?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="creator-grant" role="dialog" aria-label={title} data-creator-confirm={dangerous ? 'revert' : 'keep'}>
      <strong>{title}</strong>
      <div>{body}</div>
      {sensitive && sensitive.length > 0 && sensitiveLabel ? (
        <div className="creator-badges">
          <span className="creator-badge creator-badge--sensitive">{sensitiveLabel}</span>
          {sensitive.map((capability) => (
            <span key={capability} className="creator-badge">
              {capability}
            </span>
          ))}
        </div>
      ) : null}
      <div className="creator-actions">
        <Button size="sm" variant={dangerous ? 'danger' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </div>
  )
}
