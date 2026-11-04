/**
 * creator/trial.ts —— 试跑会话：快照、撤销与 deck 回滚（04 §5.4 / §8）。
 *
 * 边界：
 * - 04 不另造沙箱/帧：真正挂帧与反注册贡献由 plugin-core 的 `src/plugins/draft.ts` 负责，
 *   这里只持有它的句柄（`DraftRuntime` 适配层，宿主启动时 install；未安装时 `E-HOST-02`）；
 * - deck 回滚只回滚**本标签**的 `creator-trial` / `plugin:draft/<id>:` 事务，遇到非本标签即停
 *   （用户之后编辑过 → 冲突，默认只撤销改造，不覆盖用户编辑）；
 * - 布局快照写回 `uiStore`；settings 只比对不写回（04 §8.2）。
 */
import type { Capability, LayoutSnapshot, PluginDraft, PluginTrial } from '@/plugins/types'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { useSelectionStore } from '@/state/selectionStore'
import { useSettingsStore } from '@/state/settingsStore'
import { appendCreatorTrial } from './persistence'

/* ============================ 草稿运行时适配层 ============================ */

export interface DraftTrialHandle {
  draftId: string
  /** 虚拟 registry id：`draft/<draftId>`（02 §11.5.1）。 */
  pluginId: string
  root: string
  revision: number
  /** 当前已挂帧的 frameId 列表（`draft/<id>@<rev>`，同时 ≤1 个 UI 帧）。 */
  frameIds(): string[]
  /** 销毁帧 + 反注册贡献（不写 IDB、不写 plugins store）。 */
  dispose(): Promise<void>
}

/** plugin-core `src/plugins/draft.ts` 暴露给创造模式的全部能力（02 §11.5）。 */
export interface DraftRuntime {
  startDraftTrial(draft: PluginDraft): Promise<DraftTrialHandle>
  restartDraftTrial(draft: PluginDraft): Promise<DraftTrialHandle>
  stopDraftTrial(draftId: string): Promise<void>
  updateDraftGrants(draftId: string, grants: Capability[]): void
  runDraftTransaction<T>(draftId: string, label: string, fn: () => Promise<T> | T): Promise<T>
  isDraftTrial(draftId: string): boolean
  /**
   * 可选：草稿成功写 deck 时通知宿主（04 §3.3 `trial.deckwrite` → `applied`）。
   * 网关在写事务成功后调用监听器，参数 count = 本次试跑累计写入组数。
   */
  onDeckWrite?(listener: (payload: { draftId: string; revision: number; count: number }) => void): () => void
}

let runtime: DraftRuntime | null = null

/** 宿主启动时安装（plugin-core 的 draft.ts 就绪后由 Lead/shell 接线一次）。 */
export function installDraftRuntime(next: DraftRuntime | null): void {
  runtime = next
}

export function isDraftRuntimeAvailable(): boolean {
  return runtime !== null
}

/**
 * 首次试跑时才懒加载插件运行时草稿接口（04 §8 / 02 §11.5）。
 * 走 `@/plugins/public` 的 `loadDraftRuntime()`（宿主已注册时用 runtime 版，否则回退 `plugins/draft`
 * 同实现）；creator 不 import `plugins/draft` 内部，符合 02 §1.2 分层，且首屏零 cost。
 */
export async function ensureDraftRuntime(): Promise<boolean> {
  if (runtime) return true
  try {
    const { loadDraftRuntime } = await import('@/plugins/public')
    const api = await loadDraftRuntime()
    if (api) {
      runtime = api as unknown as DraftRuntime
      return true
    }
  } catch {
    /* 运行时未就绪：按 E-HOST-02 处理（04 §11 #4） */
  }
  return runtime !== null
}

export function draftRuntime(): DraftRuntime | null {
  return runtime
}

/* ============================ 试跑快照 ============================ */

/** 04 §8.2 的 settings/layout/deck/registry 快照。 */
export interface CreatorTrialSnapshot {
  lang: string
  uiTheme: string
  reducedMotion: boolean
  pluginsEnabledSnapshot: Record<string, boolean>
  layout: LayoutSnapshot
  deckRevision: number
  activeSlideId: string | null
  selection: string[]
  /** 试跑开始前 `deckStore.past.length`（撤销到此为止）。 */
  deckUndoCount: number
  /** 试跑开始前已启用插件 id（只告警用）。 */
  registryIds: string[]
}

/** 捕获试跑前快照（纯读，不写任何 store）。 */
export function captureTrialSnapshot(): CreatorTrialSnapshot {
  const deck = useDeckStore.getState()
  const ui = useUiStore.getState()
  const settings = useSettingsStore.getState()
  return {
    lang: settings.lang,
    uiTheme: settings.uiTheme,
    reducedMotion: settings.reducedMotion,
    pluginsEnabledSnapshot: { ...(settings.plugins?.enabled ?? {}) },
    layout: {
      railWidth: ui.railWidth,
      panelWidth: ui.panelWidth,
      rightMode: ui.rightMode === 'composer' ? 'composer' : 'inspector',
      leftTab: ui.leftTab,
      dockHeight: 280,
      density: 'comfortable',
    },
    deckRevision: deck.revision,
    activeSlideId: ui.activeSlideId,
    selection: useSelectionStore.getState().selectedBlockIds ?? [],
    deckUndoCount: deck.past.length,
    registryIds: Object.entries(settings.plugins?.enabled ?? {})
      .filter(([, enabled]) => enabled)
      .map(([id]) => id),
  }
}

/* ============================ deck 回滚 ============================ */

export const CREATOR_TRIAL_LABEL_PREFIX = 'creator-trial'
export const CREATOR_TRIAL_PLUGIN_LABEL_PREFIX = 'plugin:draft/'

/** 本试跑写下的事务标签（两种前缀都算）：`creator-trial` / `plugin:draft/<draftId>:`。 */
export function isTrialHistoryLabel(label: string, draftId?: string): boolean {
  if (label.startsWith(CREATOR_TRIAL_LABEL_PREFIX)) return true
  if (!label.startsWith(CREATOR_TRIAL_PLUGIN_LABEL_PREFIX)) return false
  if (!draftId) return true
  return label.startsWith(`${CREATOR_TRIAL_PLUGIN_LABEL_PREFIX}${draftId}:`)
}

export interface DeckRevertResult {
  /** 撤销了几条本试跑事务。 */
  undone: number
  /** true = 试跑之后用户又编辑过，无法安全回滚（UI 给冲突卡，默认只撤销改造）。 */
  conflict: boolean
}

/**
 * 逐条 undo，遇到非本标签即停（04 §5.4）。
 * 不 `replaceDeck`、不动用户后续编辑；冲突时返回 conflict=true 且不撤销。
 */
export function revertTrialDeck(snapshot: CreatorTrialSnapshot, draftId?: string): DeckRevertResult {
  let undone = 0
  let guard = 0
  while (useDeckStore.getState().past.length > snapshot.deckUndoCount) {
    const past = useDeckStore.getState().past
    const top = past[past.length - 1]
    if (!top || !isTrialHistoryLabel(top.label, draftId)) return { undone, conflict: true }
    useDeckStore.getState().undo()
    undone += 1
    guard += 1
    if (guard > 200) return { undone, conflict: true }
  }
  // `applied` 但历史被清空/折叠时无法回滚：按冲突处理，绝不 replaceDeck（04 §5.4）。
  if (useDeckStore.getState().past.length < snapshot.deckUndoCount) {
    return { undone, conflict: true }
  }
  return { undone, conflict: false }
}

/** 恢复布局快照（04 §5.4 ③）。 */
export function restoreTrialLayout(snapshot: CreatorTrialSnapshot): void {
  const ui = useUiStore.getState()
  ui.setRailWidth(snapshot.layout.railWidth)
  ui.setPanelWidth(snapshot.layout.panelWidth)
  ui.setRightMode(useUiStore.getState().rightMode === 'creator' ? 'creator' : snapshot.layout.rightMode)
  ui.setLeftTab(snapshot.layout.leftTab)
  if (snapshot.activeSlideId) ui.setActiveSlide(snapshot.activeSlideId)
}

/* ============================ 会话 ============================ */

export interface CreatorTrialSession {
  draftId: string
  revision: number
  snapshot: CreatorTrialSnapshot
  handle: DraftTrialHandle | null
  startedAt: number
}

export interface BeginTrialResult {
  ok: boolean
  session?: CreatorTrialSession
  /** 失败原因（`E-HOST-02` = 沙箱没启动，04 §11 #4）。 */
  code?: 'E-HOST-02' | 'E-HOST-01'
  detail?: string
}

/**
 * 开始试跑：快照 → 建虚拟 registry 条目 + 帧（交给 draft runtime）。
 * draft 记录里的 `trials[]` 追加一条 `outcome:'trialing'`。
 */
export async function beginTrialSession(draft: PluginDraft): Promise<BeginTrialResult> {
  const snapshot = captureTrialSnapshot()
  const trial: PluginTrial = {
    revision: draft.revision,
    at: Date.now(),
    outcome: 'trialing',
    deckRevisionBefore: snapshot.deckRevision,
    activeSlideId: snapshot.activeSlideId,
    layout: snapshot.layout,
    trialUndoCount: snapshot.deckUndoCount,
  }
  await appendCreatorTrial(draft.draftId, trial)
  if (!runtime) {
    return { ok: false, code: 'E-HOST-02', detail: 'draft runtime is not installed' }
  }
  try {
    const handle = await runtime.startDraftTrial(draft)
    runtime.updateDraftGrants(draft.draftId, draft.grantedCapabilities)
    return {
      ok: true,
      session: {
        draftId: draft.draftId,
        revision: draft.revision,
        snapshot,
        handle,
        startedAt: Date.now(),
      },
    }
  } catch (error) {
    return {
      ok: false,
      code: 'E-HOST-02',
      detail: error instanceof Error ? error.message.slice(0, 300) : String(error),
    }
  }
}

/** 停用草稿（销毁帧 + 反注册贡献，保留草稿记录；不撤销布局/deck）。 */
export async function stopTrialSession(session: CreatorTrialSession | null): Promise<void> {
  if (!session) return
  if (session.handle) {
    try {
      await session.handle.dispose()
    } catch {
      /* 销毁失败不阻断状态机（帧由 runtime 自行兜底） */
    }
  }
  if (runtime) {
    try {
      await runtime.stopDraftTrial(session.draftId)
    } catch {
      /* 反注册失败同上 */
    }
  }
}

export interface RevertTrialResult extends DeckRevertResult {
  restoredLayout: boolean
}

/**
 * 撤销试跑：停帧 → 恢复布局 → 回滚本试跑 deck 事务（04 §5.4 ①②③）。
 * 不写 `plugins` store、不删草稿（保留 `status='reverted'` 由状态机负责）。
 */
export async function revertTrialSession(
  session: CreatorTrialSession | null,
  draftId?: string,
): Promise<RevertTrialResult> {
  await stopTrialSession(session)
  if (!session) return { undone: 0, conflict: false, restoredLayout: false }
  restoreTrialLayout(session.snapshot)
  const result = revertTrialDeck(session.snapshot, draftId ?? session.draftId)
  return { ...result, restoredLayout: true }
}

/** 授权变更（`deck:write` 开关）：实时下发网关，不缓存（02 §11.5.5）。 */
export function pushDraftGrants(draftId: string, grants: Capability[]): void {
  runtime?.updateDraftGrants(draftId, grants)
}

/** 草稿试跑事务（插件代码经网关调用时最终落到这里；标签固定带 draftId）。 */
export async function withTrialTransaction<T>(
  draftId: string,
  label: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!runtime) throw new Error('draft runtime is not installed')
  return runtime.runDraftTransaction(draftId, label, fn)
}
