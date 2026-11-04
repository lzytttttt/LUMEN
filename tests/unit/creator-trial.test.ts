/**
 * creator-trial.test.ts —— 试跑快照 / 帧句柄 / 撤销精确口径（04 §5.4 / §8，06 U-40-177…182）。
 *
 * 用假 draft runtime（jsdom 无真实 iframe，06 §5 的唯一放宽），验证我们自己的边界：
 * 快照捕获、句柄销毁、只回滚本标签事务、用户改过 deck 时冲突且不覆盖。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { PluginDraft } from '@/plugins/types'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { createSampleDeck } from '@/sample/sample-deck'
import {
  beginTrialSession,
  captureTrialSnapshot,
  installDraftRuntime,
  isDraftRuntimeAvailable,
  isTrialHistoryLabel,
  pushDraftGrants,
  revertTrialDeck,
  revertTrialSession,
  stopTrialSession,
  withTrialTransaction,
  type DraftRuntime,
  type DraftTrialHandle,
} from '@/creator/trial'
import { buildDraftRecord } from '@/creator/persistence'
import { creatorReducer, initialCreatorMachine } from '@/creator/state'
import { buildWidgetTemplate } from '@/creator/templates/widget'

const DRAFT_ID = '01JQZ8Q6Z8Q6Z8Q6Z8Q6Z8Q6Z8'

function fakeDraft(): PluginDraft {
  const proposal = JSON.parse(JSON.stringify(buildWidgetTemplate()))
  return {
    draftId: DRAFT_ID,
    root: `draft/${DRAFT_ID}`,
    revision: 2,
    status: 'trialing',
    proposal,
    files: proposal.files,
    manifest: JSON.parse(proposal.files[0].content),
    trials: [],
    grantedCapabilities: ['ui:slot', 'deck:read'],
    proposalDigest: 'x'.repeat(64),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

interface FakeRuntime extends DraftRuntime {
  calls: string[]
  disposed: number
  grants: string[][]
}

function installFakeRuntime(): FakeRuntime {
  const fake: FakeRuntime = {
    calls: [],
    disposed: 0,
    grants: [],
    async startDraftTrial(draft) {
      fake.calls.push(`start:${draft.draftId}`)
      const handle: DraftTrialHandle = {
        draftId: draft.draftId,
        pluginId: `draft/${draft.draftId}`,
        root: draft.root,
        revision: draft.revision,
        frameIds: () => [`draft/${draft.draftId}@${draft.revision}`],
        dispose: async () => {
          fake.disposed += 1
        },
      }
      return handle
    },
    async restartDraftTrial(draft) {
      fake.calls.push(`restart:${draft.draftId}`)
      return this.startDraftTrial(draft)
    },
    async stopDraftTrial(draftId) {
      fake.calls.push(`stop:${draftId}`)
    },
    updateDraftGrants(draftId, grants) {
      fake.calls.push(`grants:${draftId}`)
      fake.grants.push([...grants])
    },
    async runDraftTransaction(draftId, label, fn) {
      fake.calls.push(`tx:${draftId}:${label}`)
      return fn()
    },
    isDraftTrial(draftId) {
      return draftId === DRAFT_ID
    },
  }
  installDraftRuntime(fake)
  return fake
}

function seedDeck(): void {
  const deck = createSampleDeck('zh')
  useDeckStore.getState().setDeck(deck, { resetHistory: true })
  useUiStore.getState().setActiveSlide(deck.slides[0].id)
}

function trialUpdate(label: string, title: string): void {
  useDeckStore.getState().transaction(label, () => {
    useDeckStore.getState().update(`${label}#update`, (draft) => {
      draft.title = title
    })
  })
}

beforeEach(() => {
  seedDeck()
  installDraftRuntime(null)
})

describe('试跑会话（CR-40-27 / §8.2）', () => {
  it('未接运行时 → E-HOST-02（沙箱没启动，不自动重试）', async () => {
    const result = await beginTrialSession(fakeDraft())
    expect(result.ok).toBe(false)
    expect(result.code).toBe('E-HOST-02')
    expect(isDraftRuntimeAvailable()).toBe(false)
  })

  it('快照捕获 layout/deck 版本/选中幕，开始试跑后句柄可销毁', async () => {
    const fake = installFakeRuntime()
    const snapshot = captureTrialSnapshot()
    expect(snapshot.layout.railWidth).toBeGreaterThan(0)
    expect(snapshot.deckUndoCount).toBe(0)

    const begun = await beginTrialSession(fakeDraft())
    expect(begun.ok).toBe(true)
    expect(begun.session?.handle?.frameIds()).toEqual([`draft/${DRAFT_ID}@2`])
    expect(fake.calls.some((call) => call.startsWith('start:'))).toBe(true)
    expect(fake.grants[fake.grants.length - 1]).toEqual(['ui:slot', 'deck:read'])

    await stopTrialSession(begun.session ?? null)
    expect(fake.disposed).toBe(1)
    expect(fake.calls).toContain(`stop:${DRAFT_ID}`)
  })

  it('授权下发给网关（deck:write 开关生效）', () => {
    const fake = installFakeRuntime()
    pushDraftGrants(DRAFT_ID, ['ui:slot', 'deck:read', 'deck:write'])
    expect(fake.grants[fake.grants.length - 1]).toContain('deck:write')
  })

  it('试跑事务拿得到 runtime（标签约定 plugin:draft/<id>:<label>）', async () => {
    const fake = installFakeRuntime()
    const value = await withTrialTransaction(DRAFT_ID, 'insert', async () => 42)
    expect(value).toBe(42)
    expect(fake.calls).toContain(`tx:${DRAFT_ID}:insert`)
  })
})

describe('撤销精确口径（CR-40-30/31 / §5.4）', () => {
  it('只回滚本试跑标签的事务，deck 回到试跑前', () => {
    const before = useDeckStore.getState().deck.title
    trialUpdate(`plugin:draft/${DRAFT_ID}:insert`, '试跑改过的标题')
    trialUpdate(`plugin:draft/${DRAFT_ID}:theme`, '试跑又改一次')
    expect(useDeckStore.getState().deck.title).not.toBe(before)

    const snapshot = { ...captureTrialSnapshot(), deckUndoCount: 0 }
    const result = revertTrialDeck(snapshot, DRAFT_ID)
    expect(result).toEqual({ undone: 2, conflict: false })
    expect(useDeckStore.getState().deck.title).toBe(before)
  })

  it('用户之后编辑过 → 冲突，默认不覆盖用户编辑', () => {
    trialUpdate(`plugin:draft/${DRAFT_ID}:insert`, '试跑改的标题')
    trialUpdate('manual-edit', '用户自己改的标题')

    const snapshot = { ...captureTrialSnapshot(), deckUndoCount: 0 }
    const result = revertTrialDeck(snapshot, DRAFT_ID)
    expect(result.conflict).toBe(true)
    expect(result.undone).toBe(0)
    expect(useDeckStore.getState().deck.title).toBe('用户自己改的标题')
  })

  it('isTrialHistoryLabel 只认 creator-trial / 本 draft 前缀', () => {
    expect(isTrialHistoryLabel('creator-trial')).toBe(true)
    expect(isTrialHistoryLabel(`plugin:draft/${DRAFT_ID}:x`, DRAFT_ID)).toBe(true)
    expect(isTrialHistoryLabel('plugin:draft/other:x', DRAFT_ID)).toBe(false)
    expect(isTrialHistoryLabel('manual-edit')).toBe(false)
  })

  it('完整撤销：销毁帧 + 恢复布局 + deck 回滚', async () => {
    const fake = installFakeRuntime()
    useUiStore.getState().setRailWidth(240)
    const begun = await beginTrialSession(fakeDraft())
    expect(begun.ok).toBe(true)

    useUiStore.getState().setRailWidth(300)
    trialUpdate(`plugin:draft/${DRAFT_ID}:insert`, '试跑标题')
    const before = useDeckStore.getState().deck.title === '试跑标题'

    const result = await revertTrialSession(begun.session ?? null, DRAFT_ID)
    expect(result.restoredLayout).toBe(true)
    expect(useUiStore.getState().railWidth).toBe(240)
    expect(result.undone).toBe(1)
    expect(useDeckStore.getState().deck.title).not.toBe('试跑标题')
    expect(before).toBe(true)
    expect(fake.disposed).toBe(1)
  })
})

describe('撤销后再试跑（04 §3.2 结果卡「再试一次」）', () => {
  it('reverted 终态可以直接 trial.start → trialing，并清掉 outcome', () => {
    const reverted = creatorReducer({ ...initialCreatorMachine(), status: 'reverted', draftId: DRAFT_ID, revision: 1, proposal: fakeDraft().proposal }, { type: 'revert' })
    expect(reverted.machine.status).toBe('reverted')
    const next = creatorReducer(reverted.machine, { type: 'trial.start', startedAt: 2 })
    expect(next.machine.status).toBe('trialing')
    expect(next.machine.proposal).not.toBeNull()
  })
})

describe('草稿记录（trials[] 快照）', () => {
  it('buildDraftRecord 保留 trials / granted / manifest', async () => {
    const draft = fakeDraft()
    const record = await buildDraftRecord({
      draftId: DRAFT_ID,
      revision: 2,
      status: 'trialing',
      proposal: draft.proposal,
      trials: [{ revision: 2, at: 1, outcome: 'trialing' }],
      grantedCapabilities: ['ui:slot'],
    })
    expect(record?.trials).toHaveLength(1)
    expect(record?.manifest.kind).toBe('code')
    expect(record?.root).toBe(`draft/${DRAFT_ID}`)
  })
})
