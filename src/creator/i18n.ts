/**
 * creator/i18n.ts —— 创造模式取词（04 §9.2 的 `creator.*` 词条）。
 *
 * 为什么不用 `useT()` 的 MessageKey 类型：创造模式词条由 shell-ui 建、Lead 注册，
 * 两边并行时用 `translate(lang, key)` 的字符串键可以避免编译期耦合；
 * 缺键时 i18n 层回落显示键名（开发期可见、运行时安全）。
 */
import { useCallback } from 'react'
import { translate } from '@/i18n'
import { useSettingsStore } from '@/state/settingsStore'
import type { Lang } from '@/i18n/types'

export function creatorT(key: string, vars?: Record<string, string | number>, lang?: Lang): string {
  const current = lang ?? useSettingsStore.getState().lang
  return translate(current, key, vars)
}

/** 响应式取词：语言变化时 UI 重渲染。 */
export function useCreatorT() {
  const lang = useSettingsStore((state) => state.lang)
  return useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang],
  )
}

/** 本模块实际消费的键（与 04 §9.2 / shell-ui 的 108 键对拍用）。 */
export const CREATOR_KEYS = {
  entry: 'creator.entry',
  entryTitle: 'creator.entryTitle',
  panelTitle: 'creator.panel.title',
  panelSubtitle: 'creator.panel.subtitle',
  panelCollapse: 'creator.panel.collapse',
  promptLabel: 'creator.prompt.label',
  promptPlaceholder: 'creator.prompt.placeholder',
  promptHint: 'creator.prompt.hint',
  propose: 'creator.action.propose',
  cancel: 'creator.action.cancel',
  new: 'creator.action.new',
  continue: 'creator.action.continue',
  retry: 'creator.action.retry',
  close: 'creator.action.close',
  disable: 'creator.action.disable',
  copyDiag: 'creator.action.copyDiag',
  feedBack: 'creator.action.feedBack',
  templates: 'creator.templates',
  templateHint: 'creator.template.hint',
  templateTheme: 'creator.template.theme',
  templateWidget: 'creator.template.widget',
  templateCommand: 'creator.template.command',
  stateIdle: 'creator.state.idle',
  stateReading: 'creator.state.reading',
  stateProposing: 'creator.state.proposing',
  stateProposalReady: 'creator.state.proposalReady',
  stateTrialing: 'creator.state.trialing',
  stateApplied: 'creator.state.applied',
  stateSaved: 'creator.state.saved',
  stateReverted: 'creator.state.reverted',
  stateFailed: 'creator.state.failed',
  stateInterrupted: 'creator.state.interrupted',
  permissionTitle: 'creator.permission.title',
  permissionReadOnly: 'creator.permission.readOnly',
  permissionReadOnlyHint: 'creator.permission.readOnlyHint',
  permissionAllowDeck: 'creator.permission.allowDeck',
  permissionAllowDeckHint: 'creator.permission.allowDeckHint',
  permissionSensitive: 'creator.permission.sensitive',
  permissionGranted: 'creator.permission.granted',
  permissionDenied: 'creator.permission.denied',
  proposalTitle: 'creator.proposal.title',
  riskLow: 'creator.proposal.risk.low',
  riskMedium: 'creator.proposal.risk.medium',
  riskHigh: 'creator.proposal.risk.high',
  changes: 'creator.proposal.changes',
  files: 'creator.proposal.files',
  trialNote: 'creator.proposal.trialNote',
  try: 'creator.proposal.try',
  keep: 'creator.proposal.keep',
  revert: 'creator.proposal.revert',
  exportPlugin: 'creator.proposal.export',
  viewFiles: 'creator.view.files',
  viewCode: 'creator.view.code',
  viewDiff: 'creator.view.diff',
  viewReadOnly: 'creator.view.readOnly',
  diffEmpty: 'creator.view.diffEmpty',
  tooLarge: 'creator.view.tooLarge',
  history: 'creator.view.history',
  trialRunning: 'creator.trial.running',
  trialHint: 'creator.trial.hint',
  trialStop: 'creator.trial.stop',
  confirmKeepTitle: 'creator.trial.confirmKeepTitle',
  confirmKeepBody: 'creator.trial.confirmKeepBody',
  confirmRevertBody: 'creator.trial.confirmRevertBody',
  keepDone: 'creator.trial.keepDone',
  revertDone: 'creator.trial.revertDone',
  conflictTitle: 'creator.trial.conflictTitle',
  conflictKeepEdits: 'creator.trial.conflictKeepEdits',
  conflictRestoreDeck: 'creator.trial.conflictRestoreDeck',
  errorBadJson: 'creator.error.badJson',
  errorSchema: 'creator.error.schema',
  errorCapMismatch: 'creator.error.capMismatch',
  errorSandbox: 'creator.error.sandbox',
  errorCode: 'creator.error.code',
  errorTooLarge: 'creator.error.tooLarge',
  errorTimeout: 'creator.error.timeout',
  errorCancelled: 'creator.error.cancelled',
  errorNotConfigured: 'creator.error.notConfigured',
  errorNextStep: 'creator.error.nextStep',
  errorDetails: 'creator.error.details',
  errorSafeMode: 'creator.error.safeMode',
  emptyIdle: 'creator.empty.idle',
  emptyNoModel: 'creator.empty.noModel',
  toastDraftSaved: 'creator.toast.draftSaved',
  toastExported: 'creator.toast.exported',
  toastDraftDiscarded: 'creator.toast.draftDiscarded',
  toastDraftUnreadable: 'creator.toast.draftUnreadable',
  exportDone: 'creator.export.done',
  exportFailed: 'creator.export.failed',
  a11yPanel: 'creator.a11y.panel',
  a11yState: 'creator.a11y.state',
  a11yProposal: 'creator.a11y.proposal',
  a11yDiff: 'creator.a11y.diff',
  a11yInput: 'creator.a11y.input',
  a11yEntry: 'creator.a11y.entry',
  a11yClose: 'creator.a11y.close',
  a11yKeep: 'creator.a11y.keep',
  a11yRevert: 'creator.a11y.revert',
  a11yTrialFrame: 'creator.a11y.trialFrame',
  liveStateChanged: 'creator.live.stateChanged',
  liveProposalReady: 'creator.live.proposalReady',
} as const
