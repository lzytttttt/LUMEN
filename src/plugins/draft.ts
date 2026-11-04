/**
 * plugins/draft.ts —— 创造模式草稿的**虚拟 registry**（02 §11.5 / 04 §5）。
 *
 * 纪律：
 * - 草稿没有特权：同一 ContributionBus / 同一 bootstrap / 同一能力网关；`window.lumen.creator` 不存在；
 * - 不写 `plugins` store、不改 `settings.plugins.enabled`、不写 `pluginData`；
 * - pluginId = `draft/<draftId>`，帧 id = `draft/<draftId>@<revision>`（与已安装插件同式）；
 * - 只允许 1 个草稿试跑；撤销/停止 = 销毁帧 + 反注册贡献（帧由 SlotHost 按 lifecycle/订阅销毁）。
 */
import { useDeckStore } from '@/state/deckStore'
import { registerContributions, unregisterContributions } from './contributionBus'
import { registerManifestLocalePack, unregisterLocalePack } from './i18n'
import { registerPluginThemes, unregisterPluginThemes } from './declarative/theme'
import { PluginError } from './errors'
import type { Capability, PluginDraft, PluginManifest } from './types'

export interface DraftTrialHandle {
  draftId: string
  /** 虚拟插件 id：`draft/<draftId>`。 */
  pluginId: string
  root: string
  revision: number
  /** 当前挂载的帧（`draft/<draftId>@<revision>`；0 表示还没建帧）。 */
  frameIds(): string[]
  dispose(): Promise<void>
}

export interface DraftTrialSummary {
  draftId: string
  pluginId: string
  revision: number
  status: PluginDraft['status']
  slots: number
  frames: number
}

/** 建帧所需的最小数据（plugin-host 拼 srcdoc 用）。 */
export interface DraftFrameSource {
  draftId: string
  pluginId: string
  revision: number
  manifest: PluginManifest
  files: Record<string, string>
  grants: Capability[]
  entryPath: string | null
}

interface DraftTrialState {
  draft: PluginDraft
  pluginId: string
  revision: number
  files: Record<string, string>
  grants: Capability[]
  frames: Set<string>
  listening: Array<() => void>
}

const trials = new Map<string, DraftTrialState>()
const listeners = new Set<() => void>()
const deckWriteListeners = new Set<(payload: { draftId: string; revision: number; count: number }) => void>()

/** 试跑期间 deck 写入回调（creator 用；返回取消订阅）。 */
export function onDraftDeckWrite(
  listener: (payload: { draftId: string; revision: number; count: number }) => void,
): () => void {
  deckWriteListeners.add(listener)
  return () => {
    deckWriteListeners.delete(listener)
  }
}

function emitDeckWrite(payload: { draftId: string; revision: number; count: number }): void {
  for (const listener of deckWriteListeners) {
    try {
      listener(payload)
    } catch {
      /* 监听器自身错误不影响试跑 */
    }
  }
}

export const DRAFT_PLUGIN_PREFIX = 'draft/'

export function draftPluginId(draftId: string): string {
  return `${DRAFT_PLUGIN_PREFIX}${draftId}`
}

export function draftFrameId(draftId: string, revision: number): string {
  return `${draftPluginId(draftId)}@${revision}`
}

export function parseDraftPluginId(pluginId: string): { draftId: string } | null {
  if (!pluginId.startsWith(DRAFT_PLUGIN_PREFIX)) return null
  const draftId = pluginId.slice(DRAFT_PLUGIN_PREFIX.length)
  return draftId ? { draftId } : null
}

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeDraftTrials(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function listDraftTrials(): DraftTrialSummary[] {
  return [...trials.values()].map((trial) => ({
    draftId: trial.draft.draftId,
    pluginId: trial.pluginId,
    revision: trial.revision,
    status: trial.draft.status,
    slots: (trial.draft.manifest.contributes.slots ?? []).length,
    frames: trial.frames.size,
  }))
}

export function isDraftTrial(draftId: string): boolean {
  return trials.has(draftId)
}

export function getDraftTrial(draftId: string): DraftTrialSummary | undefined {
  return listDraftTrials().find((trial) => trial.draftId === draftId)
}

/** 建帧数据（含 manifest / 入口源码 / 授权集 / revision）。 */
export function getDraftFrameSource(draftId: string): DraftFrameSource | null {
  const trial = trials.get(draftId)
  if (!trial) return null
  return {
    draftId: trial.draft.draftId,
    pluginId: trial.pluginId,
    revision: trial.revision,
    manifest: trial.draft.manifest,
    files: { ...trial.files },
    grants: [...trial.grants],
    entryPath: trial.draft.manifest.entry ?? null,
  }
}

/** 记录某帧挂载（SlotHost 建帧后调用，配额 ≤1 由调用方断言）。 */
export function registerDraftFrame(draftId: string, frameId: string): void {
  const trial = trials.get(draftId)
  if (!trial) return
  trial.frames.add(frameId)
  emit()
}

export function unregisterDraftFrame(draftId: string, frameId: string): void {
  const trial = trials.get(draftId)
  if (!trial) return
  trial.frames.delete(frameId)
  emit()
}

function filesOf(draft: PluginDraft): Record<string, string> {
  const files: Record<string, string> = {}
  for (const file of draft.files) {
    if (file.path === '.lumen-plugin.json') continue
    files[file.path] = file.content
  }
  return files
}

/** 开始试跑（虚拟 registry 条目：state='draft'，不落 IDB）。 */
export async function startDraftTrial(draft: PluginDraft): Promise<DraftTrialHandle> {
  if (trials.size > 0 && !trials.has(draft.draftId)) {
    throw new PluginError('E-QUOTA-04', 'only one draft trial is allowed at a time')
  }
  const existing = trials.get(draft.draftId)
  if (existing) await stopDraftTrial(draft.draftId)

  const pluginId = draftPluginId(draft.draftId)
  const files = filesOf(draft)
  // 草稿同样走完整性校验（与已安装插件同一函数）
  const integrity = draft.proposalDigest
  if (!integrity) throw new PluginError('E-MAN-14', 'draft is missing proposalDigest')
  const grants = normalizeGrants(draft.grantedCapabilities)

  const manifest = draft.manifest
  const owner = {
    pluginId,
    pluginVersion: manifest.version,
    manifest,
    trust: 'draft' as const,
    capabilities: grants,
  }
  const warnings: string[] = []
  try {
    registerContributions(owner, manifest)
    if (manifest.contributes.themes?.length) warnings.push(...registerPluginThemes(pluginId, manifest.contributes.themes))
    const locale = manifest.contributes.i18n?.[0]
    if (locale) registerManifestLocalePack(pluginId, locale)
  } catch (error) {
    unregisterContributions(pluginId)
    unregisterPluginThemes(pluginId)
    unregisterLocalePack(pluginId)
    throw error
  }
  void warnings

  const state: DraftTrialState = {
    draft: { ...draft, status: 'trialing', updatedAt: Date.now() },
    pluginId,
    revision: draft.revision,
    files,
    grants,
    frames: new Set(),
    listening: [],
  }
  trials.set(draft.draftId, state)
  emit()
  dispatchTrialEvent(draft.draftId, draft.revision)
  return {
    draftId: draft.draftId,
    pluginId,
    root: draft.root,
    revision: draft.revision,
    frameIds: () => [...state.frames],
    dispose: () => stopDraftTrial(draft.draftId),
  }
}

/** 热替换：revision++ 后销毁旧帧、同一 bootstrap 重建（02 §3.6）。 */
export async function restartDraftTrial(draft: PluginDraft): Promise<DraftTrialHandle> {
  await stopDraftTrial(draft.draftId)
  return startDraftTrial(draft)
}

/** 停止试跑：反注册贡献 + 清帧登记；草稿记录由 creator 保留。 */
export async function stopDraftTrial(draftId: string): Promise<void> {
  const trial = trials.get(draftId)
  if (!trial) return
  for (const dispose of trial.listening.splice(0)) dispose()
  unregisterContributions(trial.pluginId)
  unregisterPluginThemes(trial.pluginId)
  unregisterLocalePack(trial.pluginId)
  trial.frames.clear()
  trials.delete(draftId)
  emit()
  dispatchTrialEvent(draftId, trial.revision, true)
}

/** 试跑能力开关（`deck:write` 默认关，显式授权后生效；网关实时读，不缓存）。 */
export function updateDraftGrants(draftId: string, grants: Capability[]): void {
  const trial = trials.get(draftId)
  if (!trial) return
  trial.grants = normalizeGrants(grants)
  emit()
}

export function getDraftGrants(draftId: string): Capability[] {
  return [...(trials.get(draftId)?.grants ?? [])]
}

export function hasDraftGrant(draftId: string, capability: Capability): boolean {
  return trials.get(draftId)?.grants.includes(capability) === true
}

/** 试跑期间的 deck 写：一次 transaction = 一个历史条目；失败整笔回滚。 */
export async function runDraftTransaction<T>(
  draftId: string,
  label: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const trial = trials.get(draftId)
  if (!trial) throw new PluginError('E-ABI-01', `draft "${draftId}" is not trialing`)
  const store = useDeckStore.getState()
  const historyLabel = `plugin:${draftPluginId(draftId)}:${label}`.slice(0, 120)
  const pastBefore = store.past.length
  store.beginGroup(historyLabel)
  let failed = false
  try {
    const result = await fn()
    return result
  } catch (error) {
    failed = true
    throw error
  } finally {
    useDeckStore.getState().endGroup()
    if (failed) {
      // 整笔回滚：刚提交的这一条历史立刻撤销。
      useDeckStore.getState().undo()
    } else {
      const added = Math.max(0, useDeckStore.getState().past.length - pastBefore)
      if (added > 0) {
        emitDeckWrite({
          draftId,
          revision: trial.revision,
          count: added,
        })
      }
    }
  }
}

/** 试跑期间的事务标签（creator 撤销时按前缀识别，04 §5.4）。 */
export function isDraftHistoryLabel(label: string, draftId?: string): boolean {
  if (!label.startsWith(`plugin:${DRAFT_PLUGIN_PREFIX}`)) return false
  return draftId ? label.startsWith(`plugin:${draftPluginId(draftId)}:`) : true
}

function normalizeGrants(grants: readonly Capability[]): Capability[] {
  const unique: Capability[] = []
  for (const capability of grants) if (!unique.includes(capability)) unique.push(capability)
  return unique
}

function dispatchTrialEvent(draftId: string, revision: number, stopped = false): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('lumen:plugin-trial', {
      detail: { draftId, revision, stopped },
    }),
  )
}

/** 仅测试用：清空全部试跑。 */
export async function resetDraftTrialsForTests(): Promise<void> {
  for (const draftId of [...trials.keys()]) await stopDraftTrial(draftId)
  listeners.clear()
}
