/**
 * plugins/runtime.ts —— 插件运行时的懒加载装配（02 §10.3；唯一会 `import()` 的运行时入口）。
 *
 * 启动顺序（02 §3.3）：`loadRegistry`（读 IDB + 完整性重算 + 已启用项的声明式贡献）
 * → 安装 API 端口（registry/hostUi/draft/locale）→ 注册 17 命名空间 handler
 * → 帧消息路由 + store→帧事件桥 → 声明式键位监听 → 生命周期订阅（销毁/重建帧）
 * → `registerPluginRuntime(handle)`（public.ts 门面）。
 *
 * 首屏 0 字节：本文件只在 `boot.ts` 判定有启用插件 / 首次使用插件能力时才被 `import()`。
 */
import type {
  CommandPalettePluginItem,
  DraftRuntimeApi,
  InspectorTabItem,
  KeymapConflict,
  PluginKeymapEntry,
  PluginRuntimeHandle,
} from './public'
import { registerPluginRuntime, syncPluginsEnabledSnapshot } from './public'
import * as registryApi from './registry'
import { getAuditEntriesNewestFirst, loadAudit } from './audit'
import { getRegisteredCommands, getRegisteredSlots } from './contributionBus'
import { executeDeclarativeCommand, parsePluginCommandHostId } from './declarative/commands'
import {
  getKeymapConflicts as getDeclarativeKeymapConflicts,
  getPluginKeymapBindings,
  installPluginKeymapListener,
  resolveKeymapConflict as resolveDeclarativeKeymapConflict,
  setPluginCommandRunner,
} from './declarative/keymap'
import { getMergedThemes } from './declarative/theme'
import { getDeclarativeSettingsEntries } from './declarative'
import {
  getDraftFrameSource,
  isDraftTrial,
  listDraftTrials,
  onDraftDeckWrite,
  parseDraftPluginId,
  restartDraftTrial,
  runDraftTransaction,
  startDraftTrial,
  stopDraftTrial,
  updateDraftGrants,
} from './draft'
import { useSettingsStore } from '@/state/settingsStore'
import type { Lang } from '@/i18n/types'
import type { AuditEntry, Capability, PluginSummary, SlotId } from './types'
import { installApiPorts } from './api/context'
import type { DraftFrameSource, RegistryPort } from './api/context'
import { registerUiApi } from './api/ui'
import { clearRuntimeCommands, listRuntimeCommands, registerCommandsApi } from './api/commands'
import {
  activeKeyBindings,
  clearPluginKeybindings,
  keymapConflicts,
  registerKeymapApi,
  resetKeymapForTests,
  resolveKeymapConflict as resolveRuntimeKeymapConflict,
} from './api/keymap'
import { clearPluginLayout, registerLayoutApi } from './api/layout'
import { registerDeckApi } from './api/deck'
import { registerThemeApi } from './api/theme'
import { registerStorageApi } from './api/storage'
import { allSettingsEntries, codeSettingsEntries, registerSettingsApi } from './api/settings'
import { registerI18nApi } from './api/i18n'
import { clearPluginLintRules, listCodeLintRules, registerLintApi } from './api/lint'
import { clearPluginAiState, registerAiApi, setPluginRecipeExecutor } from './api/ai'
import { clearPluginAssets, registerAssetsApi } from './api/assets'
import { clearPluginExportHooks, registerExportApi, setExportHookExecutor } from './api/export'
import { registerNotifyApi } from './api/notify'
import {
  broadcastEnv,
  debugFrameReport,
  destroyAllFrames,
  destroyPluginFrames,
  hostClosePanel,
  hostOpenDialog,
  hostOpenPanel,
  hostSetBusy,
  hostSetTitle,
  installFrameMessageRouter,
  quarantinePluginFrames,
  requestPluginAssets,
  requestPluginCommand,
  requestPluginPreflight,
  requestPluginRecipe,
  startFrameBridges,
  stopFrameBridges,
} from './host/PluginHost'
import { resetFrameUi } from './host/frameUi'
import {
  DialogHost,
  DockHost,
  InspectorTabSlot,
  PlayOverlaySlot,
  RailFooterSlot,
  SettingsSection,
  SlotView,
  StageOverlaySlot,
  TopbarSlot,
} from './host/SlotHost'

/* ------------------------------ 状态 ------------------------------ */

let started = false
let booting: Promise<void> | null = null
const disposers: Array<() => void> = []

function currentLang(): Lang {
  return useSettingsStore.getState().lang === 'en' ? 'en' : 'zh'
}

function pluginNameOf(pluginId: string): string {
  const record = registryApi.getRecord(pluginId)
  if (!record) return pluginId
  return currentLang() === 'en'
    ? record.manifest.name.en || record.manifest.name.zh
    : record.manifest.name.zh || record.manifest.name.en
}

/* ------------------------------ handle ------------------------------ */

const draftApi: DraftRuntimeApi = {
  startDraftTrial,
  restartDraftTrial,
  stopDraftTrial,
  updateDraftGrants,
  runDraftTransaction,
  isDraftTrial,
  onDeckWrite: onDraftDeckWrite,
}

const handle: PluginRuntimeHandle = {
  get revision() {
    return registryApi.registryRevision()
  },
  components: {
    TopbarSlot,
    RailFooterSlot,
    DockHost,
    InspectorTabSlot,
    StageOverlaySlot,
    PlayOverlaySlot,
    DialogHost,
    SettingsSection,
    SlotView,
  },
  draft: draftApi,
  getThemes: () => getMergedThemes(),
  getSlotItems: (slot: SlotId) => getRegisteredSlots(slot),
  getCommands: () => buildCommandPaletteItems(),
  getInspectorTabs: () => buildInspectorTabs(),
  getSettingsEntries: () => [...getDeclarativeSettingsEntries(), ...codeSettingsEntries()],
  getSummaries: (): PluginSummary[] => registryApi.listSummaries(),
  getAudit: (): AuditEntry[] => getAuditEntriesNewestFirst(),
  getKeymapConflicts: (): KeymapConflict[] => {
    const declared: KeymapConflict[] = getDeclarativeKeymapConflicts().map((conflict) => ({
      combo: conflict.combo,
      owner: 'host',
      pluginId: conflict.pluginId,
      pluginName: conflict.pluginName ?? pluginNameOf(conflict.pluginId),
    }))
    const runtime: KeymapConflict[] = keymapConflicts().map((conflict) => ({
      combo: conflict.combo,
      owner: conflict.owner,
      pluginId: conflict.pluginId,
      pluginName: conflict.pluginName,
    }))
    return [...declared, ...runtime]
  },
  getKeymapBindings: (): PluginKeymapEntry[] => buildKeymapEntries(),
  resolveKeymapConflict: (combo: string, decision: 'host' | 'plugin') => {
    resolveDeclarativeKeymapConflict(combo, decision)
    resolveRuntimeKeymapConflict(combo, decision)
  },
  prepareInstall: (input) =>
    registryApi.prepareInstall({ file: input.file, url: input.url, sampleId: input.sampleId }),
  commitInstall: (preview, opts) => registryApi.commitInstall(preview, opts),
  enablePlugin: async (id) => {
    await registryApi.enablePlugin(id)
    syncPluginsEnabledSnapshot(registryApi.getEnabledIds())
  },
  disablePlugin: async (id) => {
    await registryApi.disablePlugin(id)
    destroyPluginFrames(id)
    syncPluginsEnabledSnapshot(registryApi.getEnabledIds())
  },
  uninstallPlugin: async (id, opts) => {
    await registryApi.uninstallPlugin(id, opts)
    destroyPluginFrames(id)
    disposePluginRuntimeState(id)
    syncPluginsEnabledSnapshot(registryApi.getEnabledIds())
  },
  retryPlugin: async (id) => {
    await registryApi.retryPlugin(id)
    destroyPluginFrames(id)
    syncPluginsEnabledSnapshot(registryApi.getEnabledIds())
  },
  grantCapability: async (id, capability) => {
    await registryApi.grantCapability(id, capability)
    // 授权变化 → 重建帧，让帧内 meta.capabilities 与真实授权一致（网关仍逐方法实时判定）。
    destroyPluginFrames(id)
  },
  revokeCapability: async (id, capability) => {
    await registryApi.revokeCapability(id, capability)
    destroyPluginFrames(id)
  },
  resetWorkbench: async () => {
    await registryApi.resetWorkbench()
    destroyAllFrames()
    resetFrameUi()
    resetKeymapForTests()
    syncPluginsEnabledSnapshot(registryApi.getEnabledIds())
  },
  enableSafeMode: async () => {
    await registryApi.enableSafeMode()
    destroyAllFrames()
  },
  getDiagnostics: () => registryApi.getPluginDiagnostics(),
  getAuditCount: async () => registryApi.auditCount(),
}

/* ------------------------------ 命令面板 / 页签 / 键位 ------------------------------ */

function buildCommandPaletteItems(): CommandPalettePluginItem[] {
  const lang = currentLang()
  const items: CommandPalettePluginItem[] = []
  for (const entry of getRegisteredCommands()) {
    const title =
      lang === 'en'
        ? entry.command.title.en || entry.command.title.zh
        : entry.command.title.zh || entry.command.title.en
    items.push({
      id: entry.hostId,
      title,
      subtitle: pluginNameOf(entry.pluginId),
      pluginId: entry.pluginId,
      pluginName: pluginNameOf(entry.pluginId),
      run: async (args) => {
        await executeDeclarativeCommand(
          entry.pluginId,
          entry.hostId,
          (args as Record<string, unknown> | undefined) ?? undefined,
        )
      },
    })
  }
  for (const command of listRuntimeCommands()) {
    const title =
      lang === 'en' ? command.title.en || command.title.zh : command.title.zh || command.title.en
    items.push({
      id: `plugin.${command.pluginId}.${command.id}`,
      title,
      subtitle: pluginNameOf(command.pluginId),
      pluginId: command.pluginId,
      pluginName: pluginNameOf(command.pluginId),
      run: async (args) => {
        await requestPluginCommand(command.pluginId, command.id, args)
      },
    })
  }
  return items
}

function buildInspectorTabs(): InspectorTabItem[] {
  const lang = currentLang()
  return getRegisteredSlots('workspace.inspector.tab').map((item) => ({
    id: `plug:${item.id}` as const,
    title: lang === 'en' ? item.title.en || item.title.zh : item.title.zh || item.title.en,
    titleOf: (target: Lang) =>
      target === 'en' ? item.title.en || item.title.zh : item.title.zh || item.title.en,
    pluginId: item.pluginId,
    icon: item.icon,
  }))
}

function buildKeymapEntries(): PluginKeymapEntry[] {
  const entries: PluginKeymapEntry[] = getPluginKeymapBindings().map((binding) => ({
    combo: binding.combo,
    commandId: binding.commandId,
    pluginId: binding.pluginId,
    pluginName: binding.pluginName ?? pluginNameOf(binding.pluginId),
  }))
  for (const binding of activeKeyBindings()) {
    if (binding.source !== 'runtime') continue
    entries.push({
      combo: binding.combo,
      commandId: binding.hostCommandId,
      pluginId: binding.pluginId,
      pluginName: pluginNameOf(binding.pluginId),
    })
  }
  return entries
}

/* ------------------------------ 生命周期 ------------------------------ */

function disposePluginRuntimeState(pluginId: string): void {
  clearRuntimeCommands(pluginId)
  clearPluginKeybindings(pluginId)
  clearPluginLayout(pluginId)
  clearPluginLintRules(pluginId)
  clearPluginAiState(pluginId)
  clearPluginExportHooks(pluginId)
  void clearPluginAssets(pluginId, false)
}

function onLifecycle(event: { type: string; pluginId: string }): void {
  const pluginId = event.pluginId
  switch (event.type) {
    case 'disabled':
    case 'uninstalled':
      destroyPluginFrames(pluginId)
      disposePluginRuntimeState(pluginId)
      break
    case 'quarantined':
      // 保留错误卡（展示隔离原因 + 重试入口），只销毁能运行的帧。
      quarantinePluginFrames(pluginId)
      disposePluginRuntimeState(pluginId)
      break
    case 'grants':
      destroyPluginFrames(pluginId)
      break
    case 'enabled':
    case 'installed':
      broadcastEnv()
      break
    case 'safe-mode':
      destroyAllFrames()
      break
    default:
      break
  }
  syncPluginsEnabledSnapshot(registryApi.getEnabledIds())
}

/* ------------------------------ 端口安装 ------------------------------ */

function installPorts(): void {
  const registryPort: RegistryPort = {
    getRecord: (pluginId) => registryApi.getRecord(pluginId),
    listRecords: () => registryApi.listRecords(),
    getEnabledIds: () => registryApi.getEnabledIds(),
    isEnabled: (pluginId) => registryApi.isEnabled(pluginId),
    hasGrant: (pluginId, capability) => registryApi.hasGrant(pluginId, capability),
    isDenied: (pluginId, capability) => registryApi.isDenied(pluginId, capability),
  }
  const draftPort = {
    getFrameSource: (pluginId: string): DraftFrameSource | null => {
      const parsed = parseDraftPluginId(pluginId)
      if (!parsed) return null
      const source = getDraftFrameSource(parsed.draftId)
      if (!source) return null
      return {
        draftId: parsed.draftId,
        manifest: source.manifest,
        files: source.files,
        grants: [...source.grants],
        revision: source.revision,
      }
    },
    isDraftId: (pluginId: string) => pluginId.startsWith('draft/'),
  }
  installApiPorts({
    registry: registryPort,
    hostUi: {
      setTitle: (frame, title) => hostSetTitle(frame, title),
      setBusy: (frame, busy, label) => hostSetBusy(frame, busy, label),
      openDialog: (frame, opts) => hostOpenDialog(frame, opts),
      openPanel: (frame, opts) => hostOpenPanel(frame, opts),
      closePanel: (frame, opts) => hostClosePanel(frame, opts),
      invokeCommand: (frame, commandId, args) => requestPluginCommand(frame.pluginId, commandId, args),
    },
    draft: draftPort,
    locale: currentLang,
  })
}

function installApiNamespaces(): void {
  registerUiApi()
  registerCommandsApi()
  registerKeymapApi()
  registerLayoutApi()
  registerDeckApi()
  registerThemeApi()
  registerStorageApi()
  registerSettingsApi()
  registerI18nApi()
  registerLintApi()
  registerAiApi()
  registerAssetsApi()
  registerExportApi()
  registerNotifyApi()
}

function installExecutors(): void {
  setPluginRecipeExecutor((pluginId, recipeId, content, themeId) =>
    requestPluginRecipe(pluginId, recipeId, content, themeId),
  )
  setExportHookExecutor((pluginId, kind, ctx) =>
    kind === 'preflight' ? requestPluginPreflight(pluginId, ctx) : requestPluginAssets(pluginId),
  )
  setPluginCommandRunner(async (hostCommandId: string) => {
    const parsed = parsePluginCommandHostId(hostCommandId)
    if (!parsed) return
    const declarative = getRegisteredCommands().find((entry) => entry.hostId === hostCommandId)
    if (declarative) {
      await executeDeclarativeCommand(parsed.pluginId, hostCommandId)
      return
    }
    await requestPluginCommand(parsed.pluginId, parsed.localId)
  })
  installPluginKeymapListener()
}

/* ------------------------------ 启动 ------------------------------ */

export async function bootRuntime(): Promise<void> {
  if (booting) return booting
  booting = (async () => {
    if (typeof window === 'undefined') return
    await registryApi.loadRegistry()
    await loadAudit()
    installPorts()
    installApiNamespaces()
    installFrameMessageRouter()
    if (import.meta.env.DEV) {
      ;(globalThis as Record<string, unknown>).__LUMEN_HOST_DEBUG__ = debugFrameReport
    }
    startFrameBridges()
    installExecutors()
    disposers.push(registryApi.subscribeRegistryLifecycle(onLifecycle))
    syncPluginsEnabledSnapshot(registryApi.getEnabledIds())
    registerPluginRuntime(handle)
  })().catch((error: unknown) => {
    if (typeof console !== 'undefined') console.warn('[plugins] runtime boot failed', error)
  })
  return booting
}

/** 由 boot/门面调用；幂等（多次调用返回同一 handle）。同步返回，异步启动在后台完成。 */
export function startPluginRuntime(): PluginRuntimeHandle {
  if (!started) {
    started = true
    void bootRuntime()
  }
  return handle
}

/** 停止运行时（测试/热重载用；不删 IDB 数据）。 */
export function stopPluginRuntime(): void {
  for (const dispose of disposers.splice(0)) {
    try {
      dispose()
    } catch {
      /* noop */
    }
  }
  stopFrameBridges()
  destroyAllFrames()
  resetFrameUi()
  started = false
  booting = null
}

/** drop 一个 `.lumenplug`：prepare（权限卡由 shell 弹）→ 派发 `lumen:plugin-preview`。 */
export async function installPluginFromDrop(file: File): Promise<void> {
  try {
    const preview = await registryApi.prepareInstall({ file })
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('lumen:plugin-preview', { detail: { preview } }))
    }
  } catch (error) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('lumen:plugin-preview', { detail: { error } }))
    }
  }
}

/* ------------------------------ 供 shell/导出域用的运行时内工具（非 ABI） ------------------------------ */

/**
 * 导出前插件预检（shell 导出弹窗调用，**0 参数**）：
 * ctx 由运行时从当前 deck 现建（DeckSnapshot + themeId + ReadonlySlideMeta[]），
 * 总预算 1000ms；插件超时只给 warning，不阻断导出（D-40-18 / E-QUOTA-03）。
 */
export async function runPluginExportPreflight(): Promise<{
  results: import('./types').PreflightResult[]
  warnings: string[]
  timedOut: boolean
}> {
  try {
    const [{ runExportPreflight }, { deckSnapshot, readonlySlideMeta }] = await Promise.all([
      import('./api/export'),
      import('./api/deck'),
    ])
    const snapshot = deckSnapshot(currentLang())
    return await runExportPreflight({ deck: snapshot, themeId: snapshot.themeId, slides: readonlySlideMeta() })
  } catch {
    return { results: [], warnings: [], timedOut: false }
  }
}

/** 导出静态资产（`provideStaticAssets`；白名单 mime、单 ≤256KB、总 ≤1MB）。失败不抛。 */
export async function collectPluginStaticAssets(): Promise<{
  assets: import('./types').StaticAsset[]
  warnings: string[]
}> {
  try {
    const { collectStaticAssets } = await import('./api/export')
    return await collectStaticAssets()
  } catch {
    return { assets: [], warnings: [] }
  }
}

/** 插件代码式 lint 规则（宿主 lint 面板合并用；执行经帧通道 `__runRule`）。 */
export function listPluginLintRules(pluginId?: string) {
  return listCodeLintRules(pluginId)
}

/** 单条插件 lint 规则的可见结果（shell 检查面板直接渲染 message，不查插件词典）。 */
export interface PluginLintFindingView {
  pluginId: string
  /** `${pluginId}/${ruleId}`（02 §2.6 冻结的 lint code）。 */
  code: string
  ruleId: string
  severity: 'info' | 'warn' | 'error'
  slideId?: string
  blockId?: string
  message: { zh: string; en: string }
  params?: Record<string, string | number>
}

/**
 * 执行所有已注册的代码式 lint 规则（BrandGuard 4 条 / ChartKit 3 条）：
 * 规则 `run` 在插件帧内执行（`__runRule`），单条 **50ms**、全 deck 插件规则 **300ms** 预算（02 §4.5）；
 * 超时跳过本轮并计 1 次，连续 3 次自动停用该规则（审计）。失败不抛（D-40-18）。
 */
export async function runPluginLintRules(): Promise<PluginLintFindingView[]> {
  const rules = listCodeLintRules()
  if (rules.length === 0) return []
  try {
    const [{ deckSnapshot, readonlySlideMeta }, host] = await Promise.all([
      import('./api/deck'),
      import('./host/PluginHost'),
    ])
    const { noteLintTimeout } = await import('./api/lint')
    const { appendAudit } = await import('./audit')
    const snapshot = deckSnapshot(currentLang())
    const ctx = { deck: snapshot, slides: readonlySlideMeta() }
    const findings: PluginLintFindingView[] = []
    const deadline = Date.now() + 300
    for (const rule of rules) {
      const remainingGlobal = deadline - Date.now()
      if (remainingGlobal <= 0) break
      const budget = Math.min(50, remainingGlobal)
      try {
        const value = await Promise.race([
          host.requestPluginLintRule(rule.pluginId, rule.id, ctx),
          new Promise((resolve) => setTimeout(() => resolve('__timeout__'), budget)),
        ])
        if (value === '__timeout__') {
          const disabled = noteLintTimeout(rule.pluginId, rule.id)
          appendAudit({
            action: 'plugin.error',
            actor: 'system',
            result: 'error',
            pluginId: rule.pluginId,
            code: 'E-QUOTA-02',
            detail: `lint rule ${rule.code} timed out${disabled ? ' (disabled after 3 misses)' : ''}`,
          })
          continue
        }
        if (!Array.isArray(value)) continue
        for (const item of value.slice(0, 20)) {
          if (!item || typeof item !== 'object') continue
          const record = item as Record<string, unknown>
          const rawMessage = record.message as { zh?: unknown; en?: unknown } | undefined
          const zh = typeof rawMessage?.zh === 'string' ? rawMessage.zh : ''
          const en = typeof rawMessage?.en === 'string' ? rawMessage.en : ''
          if (!zh && !en) continue
          findings.push({
            pluginId: rule.pluginId,
            code: rule.code,
            ruleId: rule.id,
            severity: rule.severity,
            slideId: typeof record.slideId === 'string' ? record.slideId : undefined,
            blockId: typeof record.blockId === 'string' ? record.blockId : undefined,
            message: { zh: zh || en, en: en || zh },
            params: record.params && typeof record.params === 'object' ? (record.params as Record<string, string | number>) : undefined,
          })
        }
      } catch {
        /* 单条规则失败不阻断其它规则 */
      }
    }
    return findings
  } catch {
    return []
  }
}

/** 插件运行期命令（诊断/测试用；命令面板走 handle.getCommands）。 */
export function listPluginRuntimeCommands() {
  return listRuntimeCommands()
}

/** 设置条目（SettingsSection 的 runtime 版；供 shell 直接取）。 */
export function pluginSettingsEntries() {
  return allSettingsEntries()
}

/** 运行时内部诊断：草稿试跑列表（creator 兜底用）。 */
export function pluginDraftTrials() {
  return listDraftTrials()
}

/** 权限能力再导出（测试用；ABI 形状不变）。 */
export type RuntimeCapability = Capability
