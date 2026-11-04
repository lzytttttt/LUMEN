/**
 * creator/store.ts —— 创造模式的 zustand 容器（04 §3 / §6 / §7 / §8）。
 *
 * 职责边界：
 * - **状态**在 `state.ts` 的纯 reducer 里；本文件只做「派发事件 + 执行副作用 + 落库」；
 * - 不进 deck 历史、不写 `plugins` store、不自动安装/自动试跑（04 §3.5 / §7.3）；
 * - AI 调用走 `@/ai/provider` 的 `plugin` 任务（Mock/Replay/OpenAI 三通道行为一致）。
 */
import { create } from 'zustand'
import { createFieldStreamer } from '@/ai/streamJson'
import {
  aiErrorMessage,
  currentProvider,
  isAborted,
  type AiProvider,
} from '@/ai/provider'
import type { CreatorProposal, PluginDraft } from '@/plugins/types'
import { enabledPluginIdsSnapshot, commitPluginInstall, preparePluginInstall } from '@/plugins/public'
import { useDeckStore } from '@/state/deckStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { APP_VERSION } from '@/version'
import { getStorageMode } from '@/persistence/kv'
import { creatorAudit } from './audit'
import { creatorError, creatorHookState, creatorReducer, isTrialActive, type CreatorMachine, type CreatorEvent, type CreatorTransition, type CreatorTemplateId } from './state'
import { buildCreatorPrompt } from './prompt'
import { composeCreatorContext, estimateTokens, stableStringify } from './context'
import {
  buildFeedbackText,
  canFeedbackRound,
  isFeedbackCode,
  parseCreatorProposal,
  repairProposalPrompt,
} from './repair'
import { proposalBytes, sortCreatorFiles } from './proposal'
import { buildCreatorTemplate, type CreatorTemplateOptions } from './templates'
import { draftPluginIdOf, ulid } from './id'
import {
  buildDraftRecord,
  dropCreatorDraft,
  loadCreatorHistory,
  persistCreatorMachine,
  restoreCreatorDraft,
  saveCreatorDraft,
  saveCreatorHistory,
} from './persistence'
import { creatorSettings, patchCreatorSettings, setCreatorLastDraftId } from './settings'
import {
  beginTrialSession,
  draftRuntime,
  ensureDraftRuntime,
  isDraftRuntimeAvailable,
  pushDraftGrants,
  revertTrialDeck,
  revertTrialSession,
  stopTrialSession,
  type CreatorTrialSession,
} from './trial'
import { buildLumenplug, exportLumenplug, suggestFileName } from './publish'
import { creatorT } from './i18n'
import { isCreatorSafeMode } from './safeMode'

export type CreatorViewTab = 'files' | 'code' | 'diff' | 'history'

export interface CreatorStoreState {
  machine: CreatorMachine
  panelOpen: boolean
  view: CreatorViewTab
  /** 代码视图当前文件。 */
  codePath: string
  /** 差异视图对比的旧版本 revision（null = 上一版）。 */
  diffRevision: number | null
  /** 本次请求的 prompt token 估算（状态条「约 {n} tokens」，仅真实端点显示）。 */
  promptTokens: number
  /** URL ?creator=<template> 带来的偏好模板：模板行里排第一（06 CE-40-02）。 */
  preferredTemplate: CreatorTemplateId | null
  trialSession: CreatorTrialSession | null
  /** 撤销时发现用户改过 deck（冲突卡）。 */
  trialConflict: boolean
  installing: boolean
  installedName: string | null
  exportedFile: string | null
  restoreAttempted: boolean

  open: (entry?: CreatorMachine['entry'], templateId?: CreatorTemplateId | null) => void
  close: () => void
  restore: () => Promise<void>
  submitPrompt: (prompt: string) => Promise<void>
  startTemplate: (templateId: CreatorTemplateId, options?: CreatorTemplateOptions) => void
  cancel: () => Promise<void>
  retry: () => Promise<void>
  pickHistory: (revision: number) => Promise<void>
  startTrial: () => Promise<void>
  grantDeckWrite: (granted: boolean) => void
  notifyDeckWrite: (count?: number) => void
  crashTrial: (code?: 'E-RUN-01' | 'E-RUN-02' | 'E-HOST-02' | 'E-HOST-03', detail?: string) => void
  keep: () => Promise<void>
  revert: () => Promise<void>
  discardDraft: () => Promise<void>
  exportPlugin: () => Promise<void>
  /** 沙箱错误 → 回喂模型（04 §7.4；白名单 + ≤2 轮；进入新一轮 proposing）。 */
  feedBackError: () => Promise<void>
  setPreferredTemplate: (template: CreatorTemplateId | null) => void
  setView: (view: CreatorViewTab) => void
  setCodePath: (path: string) => void
  setDiffRevision: (revision: number | null) => void
  resolveTrialConflict: (mode: 'keep-edits' | 'restore-deck') => Promise<void>
  /** 测试用：重置容器。 */
  resetForTests: () => void
}

/* ------------------------------ 模块级运行态（不进快照） ------------------------------ */

let activeRun: AbortController | null = null
let activeSession: CreatorTrialSession | null = null
let feedbackRounds = 0
let deckWriteUnsubscribe: (() => void) | null = null
let previousRightMode: 'inspector' | 'composer' = 'inspector'

function toast(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  try {
    useUiStore.getState().pushToast({ kind, message })
  } catch {
    /* 测试环境或未挂 Toasts 时忽略 */
  }
}

function emitCreatorState(machine: CreatorMachine): void {
  if (typeof window === 'undefined') return
  const hook = creatorHookState(machine)
  const detail: Record<string, unknown> = { state: hook.state }
  if (hook.outcome) detail.outcome = hook.outcome
  if (machine.draftId) detail.draftId = machine.draftId
  if (machine.revision > 0) detail.revision = machine.revision
  if (machine.proposal && machine.draftId) detail.proposalId = `draft/${machine.draftId}@${machine.revision}`
  window.dispatchEvent(new CustomEvent('lumen:creator-state', { detail }))
}

function collectContext() {
  const deckState = useDeckStore.getState()
  const ui = useUiStore.getState()
  const settings = useSettingsStore.getState()
  const enabledPlugins = enabledPluginIdsSnapshot().map((id) => ({
    id,
    name: { zh: id, en: id },
    version: '',
    kind: 'declarative' as const,
  }))
  return composeCreatorContext({
    appVersion: APP_VERSION,
    locale: settings.lang,
    uiTheme: settings.uiTheme,
    deck: deckState.deck ?? null,
    deckRevision: deckState.revision,
    layout: {
      railWidth: ui.railWidth,
      panelWidth: ui.panelWidth,
      rightMode: ui.rightMode,
      leftTab: ui.leftTab,
      inspectorTab: ui.inspectorTab,
    },
    enabledPlugins,
    readDeck: creatorSettings().readDeck,
    intent: 'auto',
  })
}

/** AiError → 状态机错误（04 §11 的失败模式映射）。 */
function aiErrorToCreator(error: unknown) {
  if (isAborted(error)) return creatorError('E-HOST-01', 'aborted')
  const code = (error as { code?: string } | null)?.code
  const detail = aiErrorMessage(error)
  switch (code) {
    case 'notConfigured':
      return creatorError('E-HOST-01', `notConfigured: ${detail}`)
    case 'contextLength':
      return creatorError('E-MAN-14', `contextLength: ${detail}`)
    case 'timeout':
      return creatorError('E-HOST-03', detail)
    case 'badJson':
      return creatorError('E-PKG-01', detail)
    default:
      return creatorError('E-HOST-01', detail)
  }
}

export const useCreatorStore = create<CreatorStoreState>((set, get) => {
  /* ------------------------------ 事件派发 ------------------------------ */

  function dispatch(event: CreatorEvent): CreatorTransition {
    const current = get().machine
    const transition = creatorReducer(current, event)
    if (transition.machine !== current) set({ machine: transition.machine })
    runEffects(transition, current)
    return transition
  }

  function runEffects(transition: CreatorTransition, previous: CreatorMachine): void {
    const { machine, effects } = transition
    for (const effect of effects) {
      switch (effect) {
        case 'emit-state':
          emitCreatorState(machine)
          break
        case 'persist-draft':
          void persistDraft(machine)
          break
        case 'persist-history':
          if (machine.draftId) void saveCreatorHistory(machine.draftId, machine.history)
          break
        case 'audit-propose':
          creatorAudit({
            action: 'creator.propose',
            result: machine.status === 'failed' ? 'error' : 'ok',
            draftId: machine.draftId ?? undefined,
            code: machine.error?.code,
            detail: machine.proposal?.title ?? previous.prompt.slice(0, 80),
          })
          break
        case 'audit-trial':
          creatorAudit({
            action: 'creator.trial',
            result: machine.status === 'failed' ? 'error' : 'ok',
            draftId: machine.draftId ?? undefined,
            code: machine.error?.code,
            detail: machine.deckWrites > 0 ? `deckWrites=${machine.deckWrites}` : undefined,
          })
          break
        case 'audit-keep':
          creatorAudit({
            action: 'creator.keep',
            result: machine.status === 'saved' ? 'ok' : machine.status === 'failed' ? 'error' : 'cancelled',
            draftId: machine.draftId ?? undefined,
            code: machine.error?.code,
          })
          break
        case 'audit-revert':
          creatorAudit({
            action: 'creator.revert',
            result: 'ok',
            draftId: machine.draftId ?? previous.draftId ?? undefined,
          })
          break
        case 'trial.stop':
          void stopPendingSession()
          break
        default:
          // 异步副作用（propose/validate/install/trial.start/revert）由对应 action 自己执行，
          // 这样 reducer 保持纯函数、顺序可控。
          break
      }
    }
    void previous
  }

  async function persistDraft(machine: CreatorMachine): Promise<void> {
    if (!machine.draftId || !machine.proposal) return
    const ok = await persistCreatorMachine(machine).catch(() => false)
    if (!ok && getStorageMode() === 'idb') {
      toast(creatorT('creator.error.store'), 'error')
    }
  }

  async function stopPendingSession(): Promise<void> {
    deckWriteUnsubscribe?.()
    deckWriteUnsubscribe = null
    const session = activeSession
    activeSession = null
    set({ trialSession: null })
    await stopTrialSession(session)
  }

  /* ------------------------------ AI 管线 ------------------------------ */

  async function runProposal(prompt: string, feedback?: string): Promise<void> {
    const built = buildCreatorPrompt({ prompt, context: collectContext(), feedback })
    set({ promptTokens: built.tokens.total })
    dispatch({ type: 'snapshot.ok' })

    const provider: AiProvider = currentProvider()
    const controller = new AbortController()
    activeRun = controller
    const streamer = createFieldStreamer(['title', 'summary'], () => {})
    let text = ''
    try {
      const result = await provider.complete({
        system: built.system,
        user: built.user,
        json: true,
        temperature: 0.4,
        stream: true,
        task: 'plugin',
        signal: controller.signal,
        onDelta: (delta) => {
          streamer.push(delta)
          const snapshot = streamer.snapshot()
          dispatch({ type: 'stream.delta', title: snapshot.title, summary: snapshot.summary })
        },
      })
      text = result.text
    } catch (error) {
      if (isAborted(error) || controller.signal.aborted) {
        dispatch({ type: 'cancel' })
        toast(creatorT('creator.error.cancelled'), 'info')
        return
      }
      dispatch({ type: 'proposal.invalid', error: aiErrorToCreator(error) })
      return
    } finally {
      if (activeRun === controller) activeRun = null
    }
    if (controller.signal.aborted) return

    dispatch({ type: 'stream.done', text })
    await validateAndDispatch(text, built.system, built.user, provider, controller.signal)
  }

  async function validateAndDispatch(
    text: string,
    system: string,
    user: string,
    provider: AiProvider,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await parseCreatorProposal(text, {
      maxRepair: 2,
      signal,
      repair: async (issues) => {
        try {
          const retry = await provider.complete({
            system,
            user: repairProposalPrompt(user, issues),
            json: true,
            temperature: 0.4,
            stream: false,
            task: 'plugin',
            signal,
          })
          return retry.text
        } catch {
          return null
        }
      },
    })
    const draftId = get().machine.draftId ?? undefined
    if (result.ok) {
      dispatch({
        type: 'proposal.valid',
        proposal: result.proposal,
        revision: get().machine.revision + 1,
        draftId,
        createdAt: Date.now(),
      })
      return
    }
    dispatch({
      type: 'proposal.invalid',
      error: creatorError(result.error.code, result.error.issues.join(' | ')),
    })
  }

  /* ------------------------------ 试跑 / 保留 / 撤销 ------------------------------ */

  async function buildActiveDraft(status: PluginDraft['status']): Promise<PluginDraft | null> {
    const machine = get().machine
    if (!machine.draftId || !machine.proposal) return null
    return buildDraftRecord({
      draftId: machine.draftId,
      revision: machine.revision,
      status,
      proposal: machine.proposal,
      request: machine.prompt,
      grantedCapabilities: machine.grantedCapabilities,
    })
  }

  return {
    machine: {
      status: 'idle',
      prompt: '',
      draftId: null,
      revision: 0,
      proposal: null,
      history: [],
      error: null,
      stream: null,
      trial: null,
      grantedCapabilities: [],
      deckWrites: 0,
      restored: false,
      interrupted: false,
      template: null,
      entry: null,
    },
    panelOpen: false,
    view: 'files',
    codePath: '',
    diffRevision: null,
    promptTokens: 0,
    preferredTemplate: null,
    trialSession: null,
    trialConflict: false,
    installing: false,
    installedName: null,
    exportedFile: null,
    restoreAttempted: false,

    open: (entry = 'topbar', templateId = null) => {
      if (!get().panelOpen) {
        previousRightMode = useUiStore.getState().rightMode === 'composer' ? 'composer' : 'inspector'
        useUiStore.getState().setRightMode('creator')
      }
      set({ panelOpen: true, preferredTemplate: templateId ?? null })
      dispatch({ type: 'panel.open', entry: entry ?? undefined })
      if (templateId) get().startTemplate(templateId)
    },

    close: () => {
      const machine = get().machine
      const revertNeeded = isTrialActive(machine.status)
      dispatch({ type: 'panel.close' })
      set({ panelOpen: false })
      useUiStore.getState().setRightMode(previousRightMode)
      if (revertNeeded) {
        void (async () => {
          await revertTrialSession(activeSession, machine.draftId ?? undefined)
          activeSession = null
          set({ trialSession: null })
          if (machine.draftId) await persistCreatorMachine(get().machine, { status: 'reverted' })
        })()
      }
    },

    restore: async () => {
      if (get().restoreAttempted) return
      set({ restoreAttempted: true })
      const restored = await restoreCreatorDraft()
      if (restored.status === 'corrupt') {
        toast(creatorT('creator.toastDraftUnreadable'), 'error')
        return
      }
      if (restored.status !== 'restored') return
      const { record, history } = restored
      const bootStatus = record.status
      dispatch({
        type: 'resume.boot',
        record: {
          status: bootStatus,
          draftId: record.draftId,
          revision: record.revision,
          proposal: record.proposal,
          history,
          error: record.status === 'failed' ? creatorError('E-HOST-01', '草稿上次以失败结束') : null,
        },
      })
      // 恢复后草稿仍是 proposal-ready（或终态），把状态写回指针。
      setCreatorLastDraftId(record.draftId)
      if (restored.interrupted) toast(creatorT('creator.state.interrupted'), 'info')
    },

    submitPrompt: async (prompt) => {
      const trimmed = typeof prompt === 'string' ? prompt.trim() : ''
      if (trimmed === '') {
        toast(creatorT('creator.empty.idle'), 'info')
        return
      }
      if (trimmed.length > 400) {
        toast(creatorT('creator.error.tooLarge'), 'error')
        return
      }
      const status = get().machine.status
      if (status === 'reading' || status === 'proposing') return
      feedbackRounds = 0
      const draftId = get().machine.draftId ?? ulid()
      setCreatorLastDraftId(draftId)
      const transition = dispatch({ type: 'prompt.submit', prompt: trimmed, draftId })
      if (transition.machine.status !== 'reading') return
      await runProposal(trimmed)
    },

    startTemplate: (templateId, options = {}) => {
      try {
        const built = buildCreatorTemplate(templateId, options)
        const draftId = get().machine.draftId ?? ulid()
        setCreatorLastDraftId(draftId)
        dispatch({
          type: 'template.start',
          templateId,
          proposal: built.proposal,
          revision: get().machine.revision + 1,
          draftId,
          createdAt: Date.now(),
        })
        set({
          view: 'files',
          codePath: sortCreatorFiles(built.proposal.files).find((file) => file.path === 'plugin.js')?.path ?? '',
          diffRevision: null,
        })
      } catch (error) {
        dispatch({
          type: 'proposal.invalid',
          error: creatorError('E-MAN-13', error instanceof Error ? error.message : String(error)),
        })
      }
    },

    cancel: async () => {
      activeRun?.abort()
      activeRun = null
      dispatch({ type: 'cancel' })
      toast(creatorT('creator.error.cancelled'), 'info')
    },

    retry: async () => {
      const prompt = get().machine.prompt
      if (get().machine.status !== 'failed') return
      dispatch({ type: 'retry' })
      if (prompt) await runProposal(prompt)
    },

    pickHistory: async (revision) => {
      if (get().machine.status === 'trialing' || get().machine.status === 'applied') {
        await stopPendingSession()
      }
      dispatch({ type: 'history.pick', revision })
      const proposal = get().machine.proposal
      if (proposal) {
        set({
          view: 'diff',
          diffRevision: revision,
          codePath: sortCreatorFiles(proposal.files).find((file) => file.path === 'plugin.js')?.path ?? '',
        })
      }
      const currentDraftId = get().machine.draftId
      if (currentDraftId) await loadCreatorHistory(currentDraftId)
    },

    startTrial: async () => {
      // 安全模式：草稿也是插件，不执行/不安装（04 §10 / 03 §5.3）。
      if (isCreatorSafeMode()) {
        creatorAudit({ action: 'creator.trial', result: 'denied', draftId: get().machine.draftId ?? undefined, code: 'E-SAFE-01' })
        toast(creatorT('creator.error.safeMode'), 'error')
        return
      }
      const machine = get().machine
      if (!machine.proposal || !machine.draftId) return
      if (isTrialActive(machine.status)) return
      // 首次试跑才懒加载插件运行时（拿 public 门面的草稿接口；不 import plugins/draft 内部）。
      const runtimeReady = isDraftRuntimeAvailable() || (await ensureDraftRuntime())
      if (!runtimeReady) {
        // 未接插件运行时：按 04 §11 #4 处理（沙箱没启动，不重试自动安装）。
        dispatch({ type: 'trial.crash', error: creatorError('E-HOST-02', 'draft runtime is not installed') })
        toast(creatorT('creator.error.sandbox'), 'error')
        return
      }
      const draft = await buildActiveDraft('proposal-ready')
      if (!draft) return
      dispatch({ type: 'trial.start', startedAt: Date.now() })
      const active = get().machine
      const trialDraft: PluginDraft = {
        ...draft,
        status: 'trialing',
        revision: active.revision,
        grantedCapabilities: active.grantedCapabilities,
        trials: [...draft.trials, { revision: active.revision, at: Date.now(), outcome: 'trialing' }],
      }
      await saveCreatorDraft(trialDraft)
      const begun = await beginTrialSession(trialDraft)
      if (!begun.ok) {
        dispatch({ type: 'trial.crash', error: creatorError(begun.code ?? 'E-HOST-02', begun.detail) })
        toast(creatorT('creator.error.sandbox'), 'error')
        return
      }
      activeSession = begun.session ?? null
      set({ trialSession: activeSession, view: 'files' })
      // 网关写 deck 成功 → 状态机 trial.deckwrite（applied + data-creator-deck-writes）
      const draftIdForHook = machine.draftId
      const activeRuntime = draftRuntime()
      if (activeRuntime?.onDeckWrite && draftIdForHook) {
        const off = activeRuntime.onDeckWrite((payload) => {
          if (payload.draftId !== draftIdForHook) return
          get().notifyDeckWrite(payload.count)
        })
        deckWriteUnsubscribe = off
      }
      creatorAudit({ action: 'creator.trial', result: 'ok', draftId: machine.draftId, detail: 'start' })
    },

    grantDeckWrite: (granted) => {
      dispatch({ type: 'grant.deckWrite', granted })
      const machine = get().machine
      if (!machine.draftId) return
      pushDraftGrants(machine.draftId, machine.grantedCapabilities)
      creatorAudit({
        action: 'creator.trial',
        result: granted ? 'ok' : 'denied',
        draftId: machine.draftId,
        detail: 'deck:write',
      })
      void persistDraft(machine)
    },

    notifyDeckWrite: (count) => {
      dispatch({ type: 'trial.deckwrite', deckWrites: count })
      const machine = get().machine
      if (machine.draftId) void persistCreatorMachine(machine, { status: 'applied' })
    },

    crashTrial: (code = 'E-RUN-02', detail) => {
      dispatch({ type: 'trial.crash', error: creatorError(code, detail) })
      void stopPendingSession()
      creatorAudit({ action: 'creator.trial', result: 'error', draftId: get().machine.draftId ?? undefined, code })
    },

    keep: async () => {
      if (isCreatorSafeMode()) {
        creatorAudit({ action: 'creator.keep', result: 'denied', draftId: get().machine.draftId ?? undefined, code: 'E-SAFE-01' })
        toast(creatorT('creator.error.safeMode'), 'error')
        return
      }
      const machine = get().machine
      const proposal = machine.proposal
      const draftId = machine.draftId
      if (!proposal || !draftId) return
      if (!isTrialActive(machine.status)) return
      set({ installing: true })
      try {
        const build = await buildLumenplug(proposal)
        const fileName = suggestFileName(build.envelope.manifest)
        const file = new File([build.json], fileName, { type: 'application/json' })
        const preview = await preparePluginInstall({ file })
        const outcome = await commitPluginInstall(preview, {
          grants: proposal.capabilities,
          enable: true,
        })
        set({ installedName: outcome.record.manifest.name.zh, installing: false })
        await stopPendingSession()
        dispatch({ type: 'keep.ok' })
        creatorAudit({
          action: 'creator.keep',
          result: 'ok',
          draftId,
          detail: `installed ${outcome.record.manifest.id}`,
        })
        toast(creatorT('creator.trial.keepDone'), 'success')
        await persistCreatorMachine(get().machine, { status: 'saved' })
      } catch (error) {
        set({ installing: false })
        dispatch({
          type: 'keep.fail',
          error: creatorError('E-STORE-02', error instanceof Error ? error.message : String(error)),
        })
        creatorAudit({ action: 'creator.keep', result: 'error', draftId, code: 'E-STORE-02' })
        toast(creatorT('creator.error.store'), 'error')
      }
    },

    revert: async () => {
      const machine = get().machine
      const draftId = machine.draftId
      dispatch({ type: 'revert' })
      const result = await revertTrialSession(activeSession, draftId ?? undefined)
      activeSession = null
      set({ trialSession: null, trialConflict: result.conflict })
      creatorAudit({ action: 'creator.revert', result: 'ok', draftId: draftId ?? undefined, detail: `undone=${result.undone}` })
      toast(creatorT('creator.trial.revertDone'), 'success')
      if (draftId) await persistCreatorMachine(get().machine, { status: 'reverted' })
    },

    discardDraft: async () => {
      const draftId = get().machine.draftId
      await stopPendingSession()
      dispatch({ type: 'draft.discard' })
      if (draftId) await dropCreatorDraft(draftId)
      setCreatorLastDraftId(null)
      set({ view: 'files', codePath: '', diffRevision: null, trialConflict: false })
      creatorAudit({ action: 'creator.revert', result: 'ok', draftId: draftId ?? undefined, detail: 'discard' })
      toast(creatorT('creator.toastDraftDiscarded'), 'info')
    },

    exportPlugin: async () => {
      const proposal = get().machine.proposal
      if (!proposal) return
      try {
        const result = await exportLumenplug(proposal)
        set({ exportedFile: result.fileName })
        creatorAudit({ action: 'creator.export', result: 'ok', draftId: get().machine.draftId ?? undefined })
        toast(creatorT('creator.toast.exported'), 'success')
      } catch (error) {
        creatorAudit({ action: 'creator.export', result: 'error', draftId: get().machine.draftId ?? undefined })
        toast(creatorT('creator.exportFailed'), 'error')
        void error
      }
    },

    feedBackError: async () => {
      const machine = get().machine
      if (!machine.error || !machine.proposal) return
      if (!isFeedbackCode(machine.error.code)) return
      if (!canFeedbackRound(feedbackRounds)) return
      const feedback = buildFeedbackText({
        code: machine.error.code,
        message: machine.error.detail,
        where: machine.proposal.files.some((file) => file.path === 'plugin.js') ? 'plugin.js' : undefined,
        note: '只输出修正后的 CreatorProposal JSON，不要解释。',
      })
      if (!feedback) return
      feedbackRounds += 1
      dispatch({ type: 'retry' })
      const prompt = machine.prompt || machine.proposal.title
      await runProposal(prompt, feedback)
    },

    setPreferredTemplate: (preferredTemplate) => set({ preferredTemplate }),

  setView: (view) => set({ view }),
    setCodePath: (codePath) => set({ codePath }),
    setDiffRevision: (diffRevision) => set({ diffRevision }),

    resolveTrialConflict: async (mode) => {
      const session = activeSession
      const machine = get().machine
      if (mode === 'restore-deck' && session) {
        revertTrialDeck(session.snapshot, machine.draftId ?? undefined)
      }
      set({ trialConflict: false })
      if (machine.draftId) await persistCreatorMachine(get().machine, { status: 'reverted' })
    },

    resetForTests: () => {
      activeRun?.abort()
      activeRun = null
      activeSession = null
      set({
        machine: {
          status: 'idle',
          prompt: '',
          draftId: null,
          revision: 0,
          proposal: null,
          history: [],
          error: null,
          stream: null,
          trial: null,
          grantedCapabilities: [],
          deckWrites: 0,
          restored: false,
          interrupted: false,
          template: null,
          entry: null,
        },
        panelOpen: false,
        view: 'files',
        codePath: '',
        diffRevision: null,
        promptTokens: 0,
        preferredTemplate: null,
        trialSession: null,
        trialConflict: false,
        installing: false,
        installedName: null,
        exportedFile: null,
        restoreAttempted: false,
      })
    },
  }
})

/* ------------------------------ 只读派生（UI 用） ------------------------------ */

export function creatorProposalBytes(): { total: number; perFile: number } {
  const proposal = useCreatorStore.getState().machine.proposal
  return proposal ? proposalBytes(proposal.files) : { total: 0, perFile: 0 }
}

export function creatorTokenEstimateOf(text: string): number {
  return estimateTokens(text)
}

/** 稳定序列化（导出/诊断/测试共用）。 */
export function creatorStableJson(value: unknown): string {
  return stableStringify(value)
}

export function creatorPluginIdOf(draftId: string): string {
  return draftPluginIdOf(draftId)
}

/** 供 UI 展示：当前草稿的 capabilities → chips。 */
export function creatorCapabilitiesOf(proposal: CreatorProposal | null): CreatorProposal['capabilities'] {
  return proposal?.capabilities ?? []
}

export { patchCreatorSettings }

/** 设置项变更后 UI 需要重渲染（readDeck/panelWidth）。 */
export function useCreatorSettings() {
  const plugins = useSettingsStore((state) => state.plugins)
  return plugins?.creator ?? creatorSettings()
}
