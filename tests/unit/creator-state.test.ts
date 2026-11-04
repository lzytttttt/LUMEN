/**
 * creator-state.test.ts —— 9 态状态机 / 7 值钩子 / 刷新恢复（04 §3，06 U-40-156…162）。
 *
 * 只喂事件序列，不碰网络；持久化用 kv 的内存降级（jsdom 无 IDB 时自动走内存）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CREATOR_STATUSES,
  MAX_CREATOR_HISTORY,
  PUBLIC_STATE_BY_STATUS,
  creatorHookState,
  creatorReducer,
  creatorStateAttrs,
  initialCreatorMachine,
  isTrialActive,
  type CreatorEvent,
  type CreatorMachine,
} from '@/creator/state'
import { buildThemeTemplate } from '@/creator/templates/theme'
import { buildWidgetTemplate } from '@/creator/templates/widget'
import { assertValidProposal } from '@/creator/proposal'
import { draftFrameIdOf, draftKeyOf, encodeRandom, encodeTime, isUlid, parseDraftFrameId, ulid } from '@/creator/id'
import {
  buildDraftRecord,
  isCreatorDraftRecord,
  loadCreatorDraft,
  restoreCreatorDraft,
  saveCreatorDraft,
  saveCreatorHistory,
  loadCreatorHistory,
  dropCreatorDraft,
  historyKeyOf,
} from '@/creator/persistence'
import { DEFAULT_PLUGINS, useSettingsStore } from '@/state/settingsStore'

const PROPOSAL = assertValidProposal(buildThemeTemplate())
const WIDGET = assertValidProposal(buildWidgetTemplate())
const DRAFT_ID = '01JQZ8Q6Z8Q6Z8Q6Z8Q6Z8Q6Z8'

function reduce(machine: CreatorMachine, event: CreatorEvent): CreatorMachine {
  return creatorReducer(machine, event).machine
}

function creatorMachineWithProposal(proposal: typeof PROPOSAL): CreatorMachine {
  return reduce(initialCreatorMachine(), { type: 'proposal.valid', proposal, revision: 1, draftId: DRAFT_ID, createdAt: 1 })
}

function deckWriteProposal() {
  const base = assertValidProposal(buildWidgetTemplate())
  const manifest = JSON.parse(base.files.find((file) => file.path === '.lumen-plugin.json')!.content)
  manifest.capabilities = ['ui:slot', 'deck:read', 'deck:write']
  return assertValidProposal({
    ...base,
    risk: 'medium',
    capabilities: ['ui:slot', 'deck:read', 'deck:write'],
    files: base.files.map((file) =>
      file.path === '.lumen-plugin.json' ? { ...file, content: JSON.stringify(manifest, null, 2) } : file,
    ),
  })
}

function readyMachine(): CreatorMachine {
  return reduce(initialCreatorMachine(), {
    type: 'proposal.valid',
    proposal: PROPOSAL,
    revision: 1,
    draftId: DRAFT_ID,
    createdAt: 1,
  })
}

beforeEach(() => {
  useSettingsStore.setState({
    plugins: { ...DEFAULT_PLUGINS, creator: { ...DEFAULT_PLUGINS.creator, lastDraftId: null } },
  })
})

describe('9 态 → 7 值钩子映射（CR-40-02）', () => {
  it('映射表逐项钉死', () => {
    expect(Object.keys(PUBLIC_STATE_BY_STATUS).sort()).toEqual([...CREATOR_STATUSES].sort())
    expect(PUBLIC_STATE_BY_STATUS.saved).toBe('applied')
    expect(PUBLIC_STATE_BY_STATUS.reverted).toBe('applied')
    expect(PUBLIC_STATE_BY_STATUS['proposal-ready']).toBe('proposal-ready')
    expect(creatorHookState({ ...initialCreatorMachine(), status: 'saved' })).toEqual({
      state: 'applied',
      outcome: 'saved',
    })
    expect(creatorHookState({ ...initialCreatorMachine(), status: 'reverted' })).toEqual({
      state: 'applied',
      outcome: 'reverted',
    })
    expect(creatorHookState({ ...initialCreatorMachine(), status: 'trialing' })).toEqual({ state: 'trialing' })
  })

  it('idle → reading → proposing → proposal-ready 主链路与副作用', () => {
    const start = initialCreatorMachine()
    const submit = creatorReducer(start, { type: 'prompt.submit', prompt: '底部加一个字数看板', draftId: DRAFT_ID })
    expect(submit.machine.status).toBe('reading')
    expect(submit.machine.prompt).toBe('底部加一个字数看板')
    expect(submit.effects).toContain('propose.request')
    expect(submit.effects).toContain('new-draft')

    const proposing = creatorReducer(submit.machine, { type: 'snapshot.ok' })
    expect(proposing.machine.status).toBe('proposing')
    expect(proposing.machine.stream).toEqual({ title: '', summary: '', tokens: 0 })

    const streamed = reduce(proposing.machine, { type: 'stream.delta', title: '底部字数', summary: '加一个看板' })
    expect(streamed.stream?.title).toBe('底部字数')
    expect(streamed.stream?.summary).toBe('加一个看板')

    const done = creatorReducer(streamed, { type: 'stream.done', text: '{"title":"x"}' })
    expect(done.machine.status).toBe('proposing')
    expect(done.effects).toContain('validate.request')

    const valid = creatorReducer(done.machine, {
      type: 'proposal.valid',
      proposal: WIDGET,
      revision: 1,
      draftId: DRAFT_ID,
      createdAt: 2,
    })
    expect(valid.machine.status).toBe('proposal-ready')
    expect(valid.machine.proposal?.title).toBe(WIDGET.title)
    expect(valid.machine.history).toHaveLength(1)
    expect(valid.effects).toEqual(expect.arrayContaining(['persist-draft', 'persist-history', 'audit-propose', 'emit-state']))
    // `data-creator-proposal` 只出现在提案卡（ProposalView），根节点不放（06 §3.1 唯一性）。
    expect(creatorStateAttrs(valid.machine)).toMatchObject({
      'data-creator-state': 'proposal-ready',
      'data-creator-draft': DRAFT_ID,
      'data-creator-revision': '1',
    })
    expect(creatorStateAttrs(valid.machine)['data-creator-proposal']).toBeUndefined()
  })

  it('空 prompt / 超长 prompt 不转移', () => {
    const start = initialCreatorMachine()
    expect(creatorReducer(start, { type: 'prompt.submit', prompt: '   ' }).machine).toBe(start)
    expect(creatorReducer(start, { type: 'prompt.submit', prompt: 'x'.repeat(401) }).machine).toBe(start)
  })

  it('失败分支：空模型输出 / 解析失败 → failed + 错误卡', () => {
    const proposing = reduce(reduce(initialCreatorMachine(), { type: 'prompt.submit', prompt: '加看板', draftId: DRAFT_ID }), {
      type: 'snapshot.ok',
    })
    const failed = creatorReducer(proposing, { type: 'stream.done', text: '   ' })
    expect(failed.machine.status).toBe('failed')
    expect(failed.machine.error?.code).toBe('E-PKG-01')

    const invalid = creatorReducer(proposing, {
      type: 'proposal.invalid',
      error: { code: 'E-MAN-13', uiKey: 'capMismatch', detail: 'capability mismatch' },
    })
    expect(invalid.machine.status).toBe('failed')
    expect(creatorStateAttrs(invalid.machine)['data-creator-error']).toBe('E-MAN-13')
  })

  it('取消：有旧提案回 proposal-ready，否则回 idle', () => {
    const fresh = reduce(initialCreatorMachine(), { type: 'prompt.submit', prompt: '加看板', draftId: DRAFT_ID })
    expect(creatorReducer(fresh, { type: 'cancel' }).machine.status).toBe('idle')

    const withProposal = reduce(readyMachine(), { type: 'prompt.submit', prompt: '继续改', draftId: DRAFT_ID })
    expect(withProposal.status).toBe('reading')
    expect(creatorReducer(withProposal, { type: 'cancel' }).machine.status).toBe('proposal-ready')
  })

  it('history.pick 只换提案、不自动试跑', () => {
    let machine = readyMachine()
    machine = reduce(machine, { type: 'proposal.valid', proposal: WIDGET, revision: 2, draftId: DRAFT_ID, createdAt: 3 })
    const picked = creatorReducer(machine, { type: 'history.pick', revision: 1 })
    expect(picked.machine.revision).toBe(1)
    expect(picked.machine.proposal?.title).toBe(PROPOSAL.title)
    expect(picked.machine.status).toBe('proposal-ready')
    expect(picked.effects).not.toContain('trial.start')
  })

  it('历史最多 10 版（CR-40-06）', () => {
    let machine = readyMachine()
    for (let revision = 2; revision <= 14; revision += 1) {
      machine = reduce(machine, {
        type: 'proposal.valid',
        proposal: PROPOSAL,
        revision,
        draftId: DRAFT_ID,
        createdAt: revision,
      })
    }
    expect(machine.history).toHaveLength(MAX_CREATOR_HISTORY)
    expect(machine.history[0].revision).toBe(5)
    expect(machine.history[machine.history.length - 1].revision).toBe(14)
  })

  it('模板起点进入 proposal-ready 并记录 template 属性', () => {
    const started = creatorReducer(initialCreatorMachine(), {
      type: 'template.start',
      templateId: 'theme',
      proposal: PROPOSAL,
      revision: 1,
      draftId: DRAFT_ID,
      createdAt: 1,
    })
    expect(started.machine.status).toBe('proposal-ready')
    // 根节点用 `data-creator-template-id` 记录当前模板；`data-creator-template` 留给模板按钮
    // （e2e 用 `[data-creator-template]` 点选，避免 strict locator 撞根节点，见 tests/e2e/creator.spec.ts）。
    expect(creatorStateAttrs(started.machine)['data-creator-template-id']).toBe('theme')
  })
})

describe('试跑授权 / 保留 / 撤销（CR-40-24…27）', () => {
  it('试跑默认只读：非敏感自动允许，deck:write 不在默认授权里', () => {
    const widget = assertValidProposal(buildWidgetTemplate())
    const started = creatorReducer(
      reduce(initialCreatorMachine(), { type: 'proposal.valid', proposal: widget, revision: 1, draftId: DRAFT_ID }),
      { type: 'trial.start', startedAt: 10 },
    )
    expect(started.machine.status).toBe('trialing')
    expect(started.machine.grantedCapabilities).toEqual(['ui:slot', 'deck:read'])
    expect(started.machine.grantedCapabilities).not.toContain('deck:write')
    expect(started.effects).toEqual(expect.arrayContaining(['trial.start', 'audit-trial', 'persist-draft']))
  })

  it('未授权 deck 写入不进入 applied；授权后首次写入进入 applied', () => {
    const started = reduce(creatorMachineWithProposal(deckWriteProposal()), { type: 'trial.start', startedAt: 10 })
    const denied = creatorReducer(started, { type: 'trial.deckwrite' })
    expect(denied.machine.status).toBe('trialing')
    expect(denied.machine.deckWrites).toBe(0)

    const granted = reduce(started, { type: 'grant.deckWrite', granted: true })
    expect(granted.grantedCapabilities).toContain('deck:write')
    const applied = creatorReducer(granted, { type: 'trial.deckwrite' })
    expect(applied.machine.status).toBe('applied')
    expect(applied.machine.deckWrites).toBe(1)
    expect(creatorStateAttrs(applied.machine)['data-creator-deck-writes']).toBe('1')
  })

  it('deck:write 开关只对含该能力的提案生效', () => {
    const themeMachine = reduce(readyMachine(), { type: 'trial.start', startedAt: 10 })
    const result = creatorReducer(themeMachine, { type: 'grant.deckWrite', granted: true })
    expect(result.machine.grantedCapabilities).not.toContain('deck:write')
  })

  it('保留成功 → saved（钩子 applied + outcome=saved）；失败不记 saved', () => {
    const kept = creatorReducer(reduce(readyMachine(), { type: 'trial.start', startedAt: 10 }), { type: 'keep' })
    // keep 本身只请求安装（异步），状态不变
    expect(kept.machine.status).toBe('trialing')
    expect(kept.effects).toContain('install.request')

    const saved = creatorReducer(kept.machine, { type: 'keep.ok' })
    expect(saved.machine.status).toBe('saved')
    expect(creatorStateAttrs(saved.machine)).toMatchObject({
      'data-creator-state': 'applied',
      'data-creator-outcome': 'saved',
    })

    const failed = creatorReducer(kept.machine, {
      type: 'keep.fail',
      error: { code: 'E-STORE-02', uiKey: 'store', detail: 'quota' },
    })
    expect(failed.machine.status).toBe('proposal-ready')
    expect(failed.machine.proposal).not.toBeNull()
  })

  it('撤销 → reverted；关闭面板有试跑先停用回 proposal-ready', () => {
    const trialing = reduce(readyMachine(), { type: 'trial.start', startedAt: 10 })
    const reverted = creatorReducer(trialing, { type: 'revert' })
    expect(reverted.machine.status).toBe('reverted')
    expect(reverted.effects).toEqual(expect.arrayContaining(['trial.revert', 'audit-revert']))
    expect(creatorStateAttrs(reverted.machine)['data-creator-outcome']).toBe('reverted')

    const closed = creatorReducer(trialing, { type: 'panel.close' })
    expect(closed.machine.status).toBe('proposal-ready')
    expect(closed.effects).toContain('trial.stop')
  })

  it('丢弃草稿回到 idle 并清空提案', () => {
    const dropped = creatorReducer(readyMachine(), { type: 'draft.discard' })
    expect(dropped.machine.status).toBe('idle')
    expect(dropped.machine.proposal).toBeNull()
    expect(dropped.machine.draftId).toBeNull()
    expect(dropped.effects).toEqual(expect.arrayContaining(['drop.draft', 'audit-revert']))
  })

  it('isTrialActive 只认 trialing/applied', () => {
    expect(isTrialActive('trialing')).toBe(true)
    expect(isTrialActive('applied')).toBe(true)
    expect(isTrialActive('saved')).toBe(false)
    expect(isTrialActive('proposal-ready')).toBe(false)
  })
})

describe('刷新恢复（CR-40-05/07 / 04 §3.5）', () => {
  it('trialing/applied 记录 → proposal-ready + interrupted，且 trials 追加一条', async () => {
    const record = await buildDraftRecord({
      draftId: DRAFT_ID,
      revision: 2,
      status: 'trialing',
      proposal: PROPOSAL,
      createdAt: Date.now(),
    })
    expect(record).not.toBeNull()
    await saveCreatorDraft(record!)
    useSettingsStore.getState().patchPlugins({ creator: { ...DEFAULT_PLUGINS.creator, lastDraftId: DRAFT_ID } })

    const restored = await restoreCreatorDraft()
    expect(restored.status).toBe('restored')
    if (restored.status !== 'restored') return
    expect(restored.interrupted).toBe(true)
    expect(restored.record.status).toBe('interrupted')
    expect(restored.record.trials.some((trial) => trial.outcome === 'interrupted')).toBe(true)

    const resumed = creatorReducer(initialCreatorMachine(), {
      type: 'resume.boot',
      record: {
        status: restored.record.status,
        draftId: restored.record.draftId,
        revision: restored.record.revision,
        proposal: restored.record.proposal,
        history: restored.history,
      },
    })
    expect(resumed.machine.status).toBe('proposal-ready')
    expect(resumed.machine.interrupted).toBe(true)
    expect(creatorStateAttrs(resumed.machine)['data-creator-restored']).toBe('1')
  })

  it('记录损坏 → 删 key + 清指针（CR-40-07）', async () => {
    useSettingsStore.getState().patchPlugins({ creator: { ...DEFAULT_PLUGINS.creator, lastDraftId: DRAFT_ID } })
    const { kvSet } = await import('@/persistence/kv')
    await kvSet('creator', draftKeyOf(DRAFT_ID), { draftId: DRAFT_ID, broken: true })
    const restored = await restoreCreatorDraft()
    expect(restored.status).toBe('corrupt')
    expect(useSettingsStore.getState().plugins.creator.lastDraftId).toBeNull()
    const { kvGet } = await import('@/persistence/kv')
    expect(await kvGet('creator', draftKeyOf(DRAFT_ID))).toBeUndefined()
  })

  it('历史落库 ≤10 版、读回顺序稳定', async () => {
    const now = Date.now()
    const entries = Array.from({ length: 12 }, (_, index) => ({
      revision: index + 1,
      proposal: PROPOSAL,
      createdAt: now - 1000 * (12 - index),
    }))
    await saveCreatorHistory(DRAFT_ID, entries)
    const loaded = await loadCreatorHistory(DRAFT_ID)
    expect(loaded).toHaveLength(10)
    expect(loaded[0].revision).toBe(3)
    expect(loaded[loaded.length - 1].revision).toBe(12)
  })

  it('丢弃草稿删两个 key', async () => {
    const record = await buildDraftRecord({ draftId: DRAFT_ID, revision: 1, status: 'proposal-ready', proposal: PROPOSAL })
    await saveCreatorDraft(record!)
    await saveCreatorHistory(DRAFT_ID, [{ revision: 1, proposal: PROPOSAL, createdAt: 1 }])
    await dropCreatorDraft(DRAFT_ID)
    expect(await loadCreatorDraft(DRAFT_ID)).toBeNull()
    const { kvGet } = await import('@/persistence/kv')
    expect(await kvGet('creator', historyKeyOf(DRAFT_ID))).toBeUndefined()
  })

  it('非法记录形状被拒（不写坏记录）', async () => {
    expect(isCreatorDraftRecord({ draftId: DRAFT_ID })).toBe(false)
    expect(isCreatorDraftRecord(null)).toBe(false)
    expect(await buildDraftRecord({ draftId: 'bad-id', revision: 1, status: 'proposal-ready', proposal: PROPOSAL })).toBeNull()
    expect(await buildDraftRecord({ draftId: DRAFT_ID, revision: 1, status: 'proposal-ready', proposal: { ...PROPOSAL, files: [] } })).toBeNull()
  })
})

describe('id / frameId（CR-40-22）', () => {
  it('ULID 26 字符 Crockford Base32，可注入时间与随机源', () => {
    const id = ulid(1700000000000, () => 0.5)
    expect(id).toHaveLength(26)
    expect(isUlid(id)).toBe(true)
    expect(isUlid('not-a-ulid')).toBe(false)
    expect(encodeTime(1700000000000)).toBe(encodeTime(1700000000000))
    expect(encodeRandom(() => 0)).toBe('0'.repeat(16))
  })

  it('draft key / frameId 通式与解析', () => {
    const id = ulid(1700000000000, () => 0.5)
    expect(draftKeyOf(id)).toBe(`draft/${id}`)
    expect(draftFrameIdOf(id, 3)).toBe(`draft/${id}@3`)
    expect(parseDraftFrameId(`draft/${id}@3`)).toEqual({ draftId: id, revision: 3 })
    expect(parseDraftFrameId('nope')).toBeNull()
  })
})
