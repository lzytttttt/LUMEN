/**
 * plugins/public.ts —— 宿主壳唯一 import 入口（02 §1.2 / §10.1）。
 *
 * 纪律：
 * - 宿主组件与 hooks 只从这里取；不 import `plugins/host/**`、`plugins/api/**` 内部。
 * - 本文件**不**静态 import 运行时（`./runtime`），运行时由 `bootPlugins()` / 首次使用时的
 *   `import('./runtime')` 懒加载，加载后通过 `registerPluginRuntime()` 注册门面实现（首屏 ≤0.8KB 之外的增量）。
 * - 早期状态（启用数 / 安全模式）由 `bootPlugins()` 通过 `applyPluginBootState()` 同步写入，壳层首帧即可用。
 */
import { createElement, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { Theme } from '@/schema/deck'
import { getStorageMode } from '@/persistence/kv'
import { getPluginBootState, subscribePluginBootState } from './boot'
import { ERROR_MESSAGE_KEYS, PluginError, isPluginError, pluginErrorMessageKey, redact } from './errors'
import type {
  AuditEntry,
  Capability,
  InstallOutcome,
  JSONValue,
  PluginDiagnostics,
  PluginPackagePreview,
  PluginSettingsEntry,
  PluginSlotItem,
  PluginSummary,
  PreflightResult,
  SlotId,
  StaticAsset,
} from './types'
import type { Lang } from '@/i18n/types'
import type { SafeModeSource } from './safe-mode'

/* ------------------------------ 类型再导出（其他域只认 public） ------------------------------ */

export type * from './types'
export { PluginError, isPluginError, pluginErrorMessageKey, ERROR_MESSAGE_KEYS, redact }
export { CAPABILITIES, CAPABILITY_META, isCapability, isSensitiveCapability } from './capabilities'
export { SENSITIVE_CAPABILITIES, SLOT_IDS } from './types'
export type { SafeModeSource } from './safe-mode'

/** 错误码 → i18n key（02 §5.5；`E-AUDIT-01` 无文案）。 */
export function pluginErrorKey(code: import('./types').PluginErrorCode): string {
  return pluginErrorMessageKey(code)
}

/* ------------------------------ 早期快照（boot.ts 持有） ------------------------------ */

export type { PluginBootState } from './boot'
export {
  applyPluginBootState,
  bootPlugins,
  emitPluginsChanged,
  enabledPluginIdsSnapshot,
  syncPluginsEnabledSnapshot,
  syncSafeModeSnapshot,
} from './boot'

/** 已启用插件 id 列表（响应式）。 */
export function useEnabledPluginIds(): string[] {
  return useSyncExternalStore(subscribePluginBootState, () => getPluginBootState().enabledIds, () => getPluginBootState().enabledIds)
}

/** 是否至少有一个插件启用（壳层据此决定挂载点是否渲染）。 */
export function usePluginsEnabled(): boolean {
  return useEnabledPluginIds().length > 0
}

/** 安全模式是否生效（`html[data-lumen-safe]` 的响应式版本）。 */
export function useSafeMode(): boolean {
  return useSyncExternalStore(
    subscribePluginBootState,
    () => getPluginBootState().safeMode,
    () => getPluginBootState().safeMode,
  )
}

/** 安全模式来源（`?safe=1` / Shift / 设置项；诊断/提示用）。 */
export function useSafeModeSource(): SafeModeSource | null {
  return useSyncExternalStore(
    subscribePluginBootState,
    () => getPluginBootState().safeSource,
    () => getPluginBootState().safeSource,
  )
}

/** 存储模式（内存降级提示；`E-STORE-01`）。 */
export function useStorageMode(): 'idb' | 'memory' {
  const revision = usePluginsRevision()
  void revision
  return getStorageMode()
}

/* ------------------------------ 运行时注册 ------------------------------ */

/** 插件命令面板条目（宿主渲染，命令面板分组「插件」）。 */
export interface CommandPalettePluginItem {
  id: string
  title: string
  subtitle?: string
  pluginId: string
  pluginName: string
  run: (args?: JSONValue) => void | Promise<void>
}

/** Inspector 动态页签（id 必须匹配 Lead 放宽后的 `plug:${string}`）。 */
export interface InspectorTabItem {
  id: `plug:${string}`
  title: string
  titleOf(lang: Lang): string
  pluginId: string
  icon?: string
}

/** 键位冲突（03 §3.1 / 02 §6.7）。 */
export interface KeymapConflict {
  combo: string
  owner: 'host' | string
  pluginId: string
  pluginName: string
}

/** 插件源键位（快捷键弹窗列出来源用）。 */
export interface PluginKeymapEntry {
  combo: string
  commandId: string
  pluginId: string
  pluginName: string
}

/** 安装输入（三入口：文件 / URL / 内置样例）。 */
export interface PrepareInstallInput {
  file?: File
  url?: string
  sampleId?: string
}

export interface PluginRuntimeComponents {
  TopbarSlot: ComponentType
  RailFooterSlot: ComponentType
  DockHost: ComponentType
  InspectorTabSlot: ComponentType<{ contributionId: string; title?: string }>
  StageOverlaySlot: ComponentType
  PlayOverlaySlot: ComponentType
  DialogHost: ComponentType
  SettingsSection: ComponentType
  SlotView: ComponentType<{ slot: SlotId; itemId?: string; className?: string }>
}

/** 运行时注册给门面的能力集（`src/plugins/runtime.ts` 实现并注册）。 */
export interface DraftRuntimeApi {
  /** 虚拟 registry 条目：`draft/<draftId>`，不写 plugins store / settings.enabled。 */
  startDraftTrial(draft: import('./types').PluginDraft): Promise<import('./draft').DraftTrialHandle>
  restartDraftTrial(draft: import('./types').PluginDraft): Promise<import('./draft').DraftTrialHandle>
  stopDraftTrial(draftId: string): Promise<void>
  updateDraftGrants(draftId: string, grants: Capability[]): void
  /** 试跑 deck 事务（`plugin:draft/<id>:<label>` 标签，失败整笔回滚）。 */
  runDraftTransaction<T>(draftId: string, label: string, fn: () => Promise<T> | T): Promise<T>
  isDraftTrial(draftId: string): boolean
  /** 试跑期间 deck 写入回调（creator 用来递增 `data-creator-deck-writes`）。 */
  onDeckWrite?(listener: (payload: { draftId: string; revision: number; count: number }) => void): () => void
}

export interface PluginRuntimeHandle {
  revision: number
  components: PluginRuntimeComponents
  /** 创造模式试跑接入（懒加载：首次点试跑时 runtime 已就绪）。 */
  draft?: DraftRuntimeApi
  getThemes(): Theme[]
  getSlotItems(slot: SlotId): PluginSlotItem[]
  getCommands(): CommandPalettePluginItem[]
  getInspectorTabs(): InspectorTabItem[]
  getSettingsEntries(): PluginSettingsEntry[]
  getSummaries(): PluginSummary[]
  getAudit(): AuditEntry[]
  getKeymapConflicts(): KeymapConflict[]
  getKeymapBindings(): PluginKeymapEntry[]
  resolveKeymapConflict(combo: string, decision: 'host' | 'plugin'): void
  prepareInstall(input: PrepareInstallInput): Promise<PluginPackagePreview>
  commitInstall(
    preview: PluginPackagePreview,
    opts?: { grants?: Capability[]; denied?: Capability[]; enable?: boolean; keepData?: boolean },
  ): Promise<InstallOutcome>
  enablePlugin(id: string): Promise<void>
  disablePlugin(id: string): Promise<void>
  uninstallPlugin(id: string, opts?: { keepData?: boolean }): Promise<void>
  retryPlugin(id: string): Promise<void>
  grantCapability(id: string, capability: Capability): Promise<void>
  revokeCapability(id: string, capability: Capability): Promise<void>
  resetWorkbench(): Promise<void>
  enableSafeMode(): Promise<void>
  getDiagnostics(): Promise<PluginDiagnostics>
  getAuditCount(): Promise<number>
}

let runtimeHandle: PluginRuntimeHandle | null = null
let runtimePromise: Promise<PluginRuntimeHandle> | null = null
let revision = 0
const runtimeListeners = new Set<() => void>()

function emitRuntime(): void {
  for (const listener of runtimeListeners) listener()
}

function subscribeRuntime(listener: () => void): () => void {
  runtimeListeners.add(listener)
  return () => {
    runtimeListeners.delete(listener)
  }
}

/** 运行时注册入口（只由 `src/plugins/runtime.ts` 调用）。 */
export function registerPluginRuntime(handle: PluginRuntimeHandle): void {
  runtimeHandle = handle
  revision += 1
  emitRuntime()
}

/** 运行时内部状态（启用集/贡献/主题/审计）变化时调用，驱动所有门面 hooks 重算。 */
export function bumpPluginsRevision(): void {
  revision += 1
  emitRuntime()
}

/** 运行时版本号（hooks 用它订阅；壳层不需要直接用）。 */
export function usePluginsRevision(): number {
  return useSyncExternalStore(subscribeRuntime, () => revision, () => revision)
}

/**
 * 懒加载运行时（幂等）。boot.ts 在 idle 时调用；任何门面动作在需要时也会调用。
 * 加载失败不抛给壳层（工作台照常，D-40-18）。
 */
export function loadPluginRuntime(): Promise<PluginRuntimeHandle | null> {
  if (runtimeHandle) return Promise.resolve(runtimeHandle)
  if (!runtimePromise) {
    runtimePromise = import('./runtime')
      .then((module) => module.startPluginRuntime())
      .catch((error: unknown) => {
        runtimePromise = null
        if (typeof console !== 'undefined') console.warn('[plugins] runtime failed to load', error)
        throw error
      })
  }
  return runtimePromise.catch(() => null)
}

function useRuntime(): PluginRuntimeHandle | null {
  const rev = usePluginsRevision()
  void rev
  return runtimeHandle
}

async function requireRuntime(): Promise<PluginRuntimeHandle> {
  const handle = await loadPluginRuntime()
  if (!handle) throw new PluginError('E-HOST-01', 'plugin runtime is unavailable')
  return handle
}

/* ------------------------------ 挂载组件（壳层只摆位置） ------------------------------ */

/** workspace.topbar（inline，宿主原生渲染）。 */
export function TopbarSlot(): ReactNode {
  const runtime = useRuntime()
  const Component = runtime?.components.TopbarSlot
  return Component ? createElement(Component) : null
}

/** workspace.rail.footer（inline）。 */
export function RailFooterSlot(): ReactNode {
  const runtime = useRuntime()
  const Component = runtime?.components.RailFooterSlot
  return Component ? createElement(Component) : null
}

/** workspace.dock（panel，可拖高 240–400，收起保留 1 帧）。 */
export function DockHost(): ReactNode {
  const runtime = useRuntime()
  const Component = runtime?.components.DockHost
  return Component ? createElement(Component) : null
}

/** workspace.inspector.tab 正文（按贡献 id 渲染）。 */
export function InspectorTabSlot(props: { contributionId: string; title?: string }): ReactNode {
  const runtime = useRuntime()
  const Component = runtime?.components.InspectorTabSlot
  return Component ? createElement(Component, props) : null
}

/** workspace.overlay（画布浮层，编辑态）。 */
export function StageOverlaySlot(): ReactNode {
  const runtime = useRuntime()
  const Component = runtime?.components.StageOverlaySlot
  return Component ? createElement(Component) : null
}

/** play.overlay（仅播放态）。 */
export function PlayOverlaySlot(): ReactNode {
  const runtime = useRuntime()
  const Component = runtime?.components.PlayOverlaySlot
  return Component ? createElement(Component) : null
}

/** dialog 插槽宿主（弹窗关闭即销毁帧）。 */
export function PluginDialogHost(): ReactNode {
  const runtime = useRuntime()
  const Component = runtime?.components.DialogHost
  return Component ? createElement(Component) : null
}

/** 设置弹窗「插件」分组正文（声明式设置页 + iframe 设置页 + 管理入口）。 */
export function SettingsPluginsSection(): ReactNode {
  const runtime = useRuntime()
  const Component = runtime?.components.SettingsSection
  return Component ? createElement(Component) : null
}

/** 9 插槽通用渲染（兜底；`itemId` 缺省渲染该槽全部）。 */
export function PluginSlotView(props: { slot: SlotId; itemId?: string; className?: string }): ReactNode {
  const runtime = useRuntime()
  const Component = runtime?.components.SlotView
  return Component ? createElement(Component, props) : null
}

/* ------------------------------ 数据 hooks ------------------------------ */

export function usePluginCommands(): CommandPalettePluginItem[] {
  const runtime = useRuntime()
  return runtime ? runtime.getCommands() : EMPTY_COMMANDS
}

export function useInspectorTabs(): InspectorTabItem[] {
  const runtime = useRuntime()
  return runtime ? runtime.getInspectorTabs() : EMPTY_TABS
}

export function usePluginThemes(): Theme[] {
  const runtime = useRuntime()
  return runtime ? runtime.getThemes() : EMPTY_THEMES
}

export function useKeymapConflicts(): KeymapConflict[] {
  const runtime = useRuntime()
  return runtime ? runtime.getKeymapConflicts() : EMPTY_CONFLICTS
}

/** 已启用的插件键位（快捷键弹窗「来源」列）。 */
export function usePluginKeymap(): PluginKeymapEntry[] {
  const runtime = useRuntime()
  return runtime ? runtime.getKeymapBindings() : EMPTY_KEYMAP
}

export function useInstalledPlugins(): PluginSummary[] {
  const runtime = useRuntime()
  return runtime ? runtime.getSummaries() : EMPTY_PLUGINS
}

/** 审计日志（最新在前，≤200）。 */
export function useAuditLog(): AuditEntry[] {
  const runtime = useRuntime()
  return runtime ? runtime.getAudit() : EMPTY_AUDIT
}

/** 设置弹窗「插件」分组的页签数据（声明式设置页 + 代码式设置页）。 */
export function usePluginSettingsEntries(): PluginSettingsEntry[] {
  const runtime = useRuntime()
  return runtime ? runtime.getSettingsEntries() : EMPTY_SETTINGS_ENTRIES
}

/** 当前启用的插件提供的主题（含内置 6 套的顺序化合并视图）。 */
export function useAllThemes(): Theme[] {
  return usePluginThemes()
}

const EMPTY_COMMANDS: CommandPalettePluginItem[] = []
const EMPTY_TABS: InspectorTabItem[] = []
const EMPTY_THEMES: Theme[] = []
const EMPTY_CONFLICTS: KeymapConflict[] = []
const EMPTY_KEYMAP: PluginKeymapEntry[] = []
const EMPTY_PLUGINS: PluginSummary[] = []
const EMPTY_AUDIT: AuditEntry[] = []
const EMPTY_SETTINGS_ENTRIES: PluginSettingsEntry[] = []

/* ------------------------------ 管理动作（PluginManager 用） ------------------------------ */

export async function preparePluginInstall(input: PrepareInstallInput): Promise<PluginPackagePreview> {
  return (await requireRuntime()).prepareInstall(input)
}

export async function commitPluginInstall(
  preview: PluginPackagePreview,
  opts?: { grants?: Capability[]; denied?: Capability[]; enable?: boolean; keepData?: boolean },
): Promise<InstallOutcome> {
  return (await requireRuntime()).commitInstall(preview, opts)
}

export async function installPluginFromFile(file: File, opts?: Parameters<PluginRuntimeHandle['commitInstall']>[1]): Promise<InstallOutcome> {
  const runtime = await requireRuntime()
  const preview = await runtime.prepareInstall({ file })
  return runtime.commitInstall(preview, opts)
}

export async function installPluginFromUrl(url: string, opts?: Parameters<PluginRuntimeHandle['commitInstall']>[1]): Promise<InstallOutcome> {
  const runtime = await requireRuntime()
  const preview = await runtime.prepareInstall({ url })
  return runtime.commitInstall(preview, opts)
}

/** 安装随 App 发布的内置样例（trust:'builtin' 只在此路径生效；D-40-22 默认不启用）。 */
export async function installBuiltinSample(
  sampleId: string,
  opts?: Parameters<PluginRuntimeHandle['commitInstall']>[1],
): Promise<InstallOutcome> {
  const runtime = await requireRuntime()
  const preview = await runtime.prepareInstall({ sampleId })
  return runtime.commitInstall(preview, { enable: false, ...(opts ?? {}) })
}

/** 安装三款内置样例（串行；单个失败不阻塞其余，返回逐条结果）。 */
export async function installBuiltinSamples(
  sampleIds: readonly string[] = ['brandguard', 'chartkit', 'focusdesk'],
): Promise<Array<{ sampleId: string; outcome?: InstallOutcome; error?: PluginError }>> {
  const results: Array<{ sampleId: string; outcome?: InstallOutcome; error?: PluginError }> = []
  for (const sampleId of sampleIds) {
    try {
      results.push({ sampleId, outcome: await installBuiltinSample(sampleId) })
    } catch (error) {
      results.push({ sampleId, error: error instanceof PluginError ? error : new PluginError('E-HOST-01', String(error)) })
    }
  }
  return results
}

export async function enablePlugin(id: string): Promise<void> {
  return (await requireRuntime()).enablePlugin(id)
}

export async function disablePlugin(id: string): Promise<void> {
  return (await requireRuntime()).disablePlugin(id)
}

export async function uninstallPlugin(id: string, opts?: { keepData?: boolean }): Promise<void> {
  return (await requireRuntime()).uninstallPlugin(id, opts)
}

export async function retryPlugin(id: string): Promise<void> {
  return (await requireRuntime()).retryPlugin(id)
}

export async function grantCapability(id: string, capability: Capability): Promise<void> {
  return (await requireRuntime()).grantCapability(id, capability)
}

export async function revokeCapability(id: string, capability: Capability): Promise<void> {
  return (await requireRuntime()).revokeCapability(id, capability)
}

/** 安全模式：写设置并立即镜像；完全生效需重启（03 §5.3）。 */
export async function enableSafeMode(): Promise<void> {
  return (await requireRuntime()).enableSafeMode()
}

/** 恢复默认工作台（deck 不动、不可撤销；03 §5.3）。 */
export async function resetWorkbench(): Promise<void> {
  return (await requireRuntime()).resetWorkbench()
}

export async function getPluginDiagnostics(): Promise<PluginDiagnostics> {
  return (await requireRuntime()).getDiagnostics()
}

export async function getAuditCount(): Promise<number> {
  return (await requireRuntime()).getAuditCount()
}

/**
 * 创造模式试跑接入：拿 draft 虚拟 registry（懒加载）。
 * 优先用 runtime 注册的 `handle.draft`；runtime 未装配时回退到 `./draft` 的实现（同一份代码，
 * 保证 creator 在 plugin-host 未接好前也能跑试跑状态机单测）。
 */
export async function loadDraftRuntime(): Promise<DraftRuntimeApi> {
  const handle = await loadPluginRuntime()
  if (handle?.draft) return handle.draft
  const module = await import('./draft')
  return {
    startDraftTrial: module.startDraftTrial,
    restartDraftTrial: module.restartDraftTrial,
    stopDraftTrial: module.stopDraftTrial,
    updateDraftGrants: module.updateDraftGrants,
    runDraftTransaction: module.runDraftTransaction,
    isDraftTrial: module.isDraftTrial,
    onDeckWrite: module.onDraftDeckWrite,
  }
}

/** 键位冲突决策（用户确认后写 `settings.plugins.keymapOverrides`）。 */
export function resolveKeymapConflict(combo: string, decision: 'host' | 'plugin'): void {
  runtimeHandle?.resolveKeymapConflict(combo, decision)
}

/**
 * 打开插件管理器弹窗（UI 属 shell-ui 域，门面只派发 window 事件）：
 * shell-ui 在 App 里 `window.addEventListener('lumen:open-plugin-manager', ...)`。
 */
export function openPluginManager(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('lumen:open-plugin-manager'))
}

/* ------------------------------ 导出钩子（shell 导出弹窗用） ------------------------------ */

export interface ExportPreflightOutcome {
  results: PreflightResult[]
  warnings: string[]
  timedOut: boolean
}

/**
 * 导出前插件预检（0 参数：runtime 侧从当前 deck 现建 ctx；预算 1000ms）。
 * 无 runtime / 失败返回空结果，**不抛**（D-40-18：插件不阻断导出）。
 */
export async function runPluginExportPreflight(): Promise<ExportPreflightOutcome> {
  const handle = await loadPluginRuntime()
  if (!handle) return { results: [], warnings: [], timedOut: false }
  try {
    const runtime = await import('./runtime')
    return await runtime.runPluginExportPreflight()
  } catch {
    return { results: [], warnings: [], timedOut: false }
  }
}

/** 导出静态资产（`provideStaticAssets`；白名单 mime、总量 ≤1MB）。失败返回空。 */
export async function collectPluginStaticAssets(): Promise<{ assets: StaticAsset[]; warnings: string[] }> {
  const handle = await loadPluginRuntime()
  if (!handle) return { assets: [], warnings: [] }
  try {
    const runtime = await import('./runtime')
    return await runtime.collectPluginStaticAssets()
  } catch {
    return { assets: [], warnings: [] }
  }
}

/* ------------------------------ 代码式 lint 规则（shell 检查面板合并用） ------------------------------ */

export interface PluginLintFindingView {
  pluginId: string
  /** `${pluginId}/${ruleId}`（02 §2.6 lint code 命名空间）。 */
  code: string
  ruleId: string
  severity: 'info' | 'warn' | 'error'
  slideId?: string
  blockId?: string
  message: { zh: string; en: string }
  params?: Record<string, string | number>
}

/**
 * 执行所有已注册的代码式 lint 规则（帧内 `__runRule`；50ms/条、300ms 总预算，超时跳过+审计）。
 * 0 参数；无 runtime / 失败返回空数组，**不抛**（D-40-18）。
 */
export async function runPluginLintRules(): Promise<PluginLintFindingView[]> {
  const handle = await loadPluginRuntime()
  if (!handle) return []
  try {
    const runtime = await import('./runtime')
    return await runtime.runPluginLintRules()
  } catch {
    return []
  }
}

/* ------------------------------ 启动（App/bootstrap 调用一次；实现见 boot.ts） ------------------------------ */

/** 供 react 组件在安全模式/启用集变化后强制重渲染（内部用）。 */
export function usePluginBootState(): import('./boot').PluginBootState {
  return useSyncExternalStore(subscribePluginBootState, () => getPluginBootState(), () => getPluginBootState())
}
