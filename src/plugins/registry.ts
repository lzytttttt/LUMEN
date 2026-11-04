/**
 * plugins/registry.ts —— 插件注册表：安装 / 启停 / 隔离 / 卸载 + DB v4 持久化（02 §3 / §7）。
 *
 * 契约要点：
 * - 记录是唯一真源：`plugins` store 的 `<pluginId>` 记录；`settings.plugins.enabled` 双写；
 * - integrity 三处校验：安装解析后（package.verifyIntegrity）、每次启用重算（这里）、导出前（creator）；
 * - 隔离：启动连续失败 3 次 → `quarantined`（不再自动启动，重试清零）；
 * - 卸载清理 14 项（§3.4）：贡献/键位/主题/lint/配方/布局/设置值/pluginData（按保留策略）；
 * - 工作台永不因插件白屏：宿主层错误都在这里收敛为 PluginError + 审计。
 */
import { APP_VERSION } from '@/version'
import { kvDel, kvEntries, kvGet, kvKeys, kvSet, getStorageMode } from '@/persistence/kv'
import { useSettingsStore } from '@/state/settingsStore'
import {
  appendAudit,
  auditFromError,
  bumpErrorCount,
  getAuditCount,
  getAuditEntriesNewestFirst,
  getErrorCounts,
  loadAudit,
  setAuditPersistence,
} from './audit'
import {
  buildEnvelope,
  bytesOf,
  INTEGRITY_PATTERN,
  isInstallableUrl,
  parseEnvelope,
  readEnvelope,
  readEnvelopeFromUrl,
  serializeEnvelope,
  verifyIntegrity,
} from './package'
import { compareSemver, parseManifest } from './manifest'
import { diffGrants, normalizeCapabilities, sensitiveOf, suggestGrants } from './capabilities'
import { PluginError, toPluginError } from './errors'
import { isSafeModeBlocking } from './safe-mode'
import {
  AUDIT_LIMIT,
  type AuditEntry,
  type Capability,
  type InstallOptions,
  type InstallOutcome,
  type InstalledPluginRecord,
  type PluginDiagnostics,
  type PluginErrorCode,
  type PluginManifest,
  type PluginPackagePreview,
  type PluginState,
  type PluginSummary,
  type TrustLevel,
} from './types'
import { applyDeclarativeContributions, getDefaultSettingsValues, removeDeclarativeContributions } from './declarative'
import { contributionCounts } from './contributionBus'
import {
  bumpPluginsRevision,
  emitPluginsChanged,
  syncPluginsEnabledSnapshot,
  syncSafeModeSnapshot,
} from './public'

/* ------------------------------ 常量 ------------------------------ */

const REGISTRY_META_KEY = '__meta'
const REGISTRY_META_VERSION = 1
const AUDIT_STORE = 'plugins' as const

/** 随 App 发布的三款样例包（D-40-22；trust:'builtin' 只在此路径生效）。 */
export const SAMPLE_PACKAGE_FILES: Record<string, string> = {
  brandguard: 'brandguard-0.1.0.lumenplug',
  chartkit: 'chartkit-0.1.0.lumenplug',
  focusdesk: 'focusdesk-0.1.0.lumenplug',
}

export type RegistryInstallInput = {
  file?: File
  url?: string
  text?: string
  /** 内置样例 id（`brandguard|chartkit|focusdesk`）。 */
  sampleId?: string
}

export type RegistryLifecycleEvent =
  | {
      type: 'installed' | 'enabled' | 'disabled' | 'uninstalled' | 'quarantined' | 'grants' | 'safe-mode'
      pluginId: string
    }

/* ------------------------------ 状态 ------------------------------ */

const records = new Map<string, InstalledPluginRecord>()
const lifecycleListeners = new Set<(event: RegistryLifecycleEvent) => void>()
const revisionListeners = new Set<() => void>()
let revision = 0
let loaded = false
let loading: Promise<void> | null = null
let memoryModeAudited = false

/* ------------------------------ 订阅 / 通知 ------------------------------ */

export function subscribeRegistry(listener: () => void): () => void {
  revisionListeners.add(listener)
  return () => {
    revisionListeners.delete(listener)
  }
}

export function subscribeRegistryLifecycle(listener: (event: RegistryLifecycleEvent) => void): () => void {
  lifecycleListeners.add(listener)
  return () => {
    lifecycleListeners.delete(listener)
  }
}

export function registryRevision(): number {
  return revision
}

function emitLifecycle(event: RegistryLifecycleEvent): void {
  for (const listener of lifecycleListeners) {
    try {
      listener(event)
    } catch {
      /* 宿主监听器自身错误不影响注册表 */
    }
  }
}

function notifyChange(): void {
  revision += 1
  for (const listener of revisionListeners) listener()
  syncPluginsEnabledSnapshot(getEnabledIds())
  bumpPluginsRevision()
  emitPluginsChanged()
}

/* ------------------------------ 设置段 ------------------------------ */

type PluginsSettingsPatch = Partial<ReturnType<typeof useSettingsStore.getState>['plugins']>

function settingsPlugins() {
  return useSettingsStore.getState().plugins
}

function patchPlugins(patch: PluginsSettingsPatch): void {
  useSettingsStore.getState().patchPlugins(patch)
}

function isEnabledInSettings(pluginId: string): boolean {
  return settingsPlugins().enabled[pluginId] === true
}

function syncEnabledSnapshot(): void {
  syncPluginsEnabledSnapshot(getEnabledIds())
}

/* ------------------------------ 启动加载（02 §3.3） ------------------------------ */

/**
 * 启动事件顺序第 2–3 步：`registry:load`（读 plugins store + 完整性重算）→
 * `contributions:register`（对 state==='enabled' 的记录注册声明式贡献）。
 * 安全模式下**不读** plugins store（03 §5.3 #1）。
 */
export function loadRegistry(): Promise<void> {
  if (loaded) return Promise.resolve()
  if (loading) return loading
  loading = doLoadRegistry()
  return loading
}

async function doLoadRegistry(): Promise<void> {
  if (isSafeModeBlocking()) {
    loaded = true
    setAuditPersistence(false)
    return
  }
  setAuditPersistence(true)
  await loadAudit()
  try {
    const entries = await kvEntries<unknown>(AUDIT_STORE)
    for (const [key, value] of entries) {
      if (key.startsWith('__')) continue
      const record = sanitizeRecord(key, value)
      if (record) records.set(record.manifest.id, record)
    }
  } catch (error) {
    bumpErrorCount('E-STORE-01')
    appendAudit({
      action: 'plugin.error',
      actor: 'system',
      result: 'error',
      code: 'E-STORE-01',
      detail: auditFromError(error).detail,
    })
  }
  // 对 state==='enabled' 的记录注册声明式贡献；失败 → 整包停用（02 §6.1）
  for (const record of [...records.values()]) {
    if (record.state !== 'enabled') continue
    try {
      applyDeclarativeContributions(record)
      if (!isEnabledInSettings(record.manifest.id)) {
        patchPlugins({ enabled: { ...settingsPlugins().enabled, [record.manifest.id]: true } })
      }
    } catch (error) {
      const pluginError = toPluginError(error, 'E-MAN-09')
      record.state = 'disabled'
      record.lastError = { code: pluginError.code, at: Date.now() }
      await persistRecord(record)
      appendAudit({
        action: 'plugin.error',
        actor: 'system',
        result: 'error',
        pluginId: record.manifest.id,
        code: pluginError.code,
        detail: pluginError.message,
      })
    }
  }
  await persistMeta()
  loaded = true
  syncEnabledSnapshot()
  bumpPluginsRevision()
}

async function persistMeta(): Promise<void> {
  try {
    await kvSet(AUDIT_STORE, REGISTRY_META_KEY, { schemaVersion: REGISTRY_META_VERSION, updatedAt: Date.now() })
  } catch {
    /* 注册表元数据写失败不影响运行 */
  }
}

function sanitizeRecord(key: string, value: unknown): InstalledPluginRecord | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<InstalledPluginRecord>
  const manifest = candidate.manifest as PluginManifest | undefined
  if (!manifest || typeof manifest.id !== 'string' || manifest.id !== key) return null
  if (typeof candidate.integrity !== 'string' || !INTEGRITY_PATTERN.test(candidate.integrity)) return null
  if (!candidate.files || typeof candidate.files !== 'object') return null
  if (typeof candidate.createdAt !== 'number') return null
  const state = candidate.state
  if (!state || !['installed', 'enabled', 'disabled', 'quarantined'].includes(state)) return null
  return {
    manifest,
    integrity: candidate.integrity,
    files: candidate.files as Record<string, string>,
    createdAt: candidate.createdAt,
    state: state as Exclude<PluginState, 'draft'>,
    trust: (candidate.trust === 'builtin' ? 'builtin' : 'local') as TrustLevel,
    installSource: candidate.installSource ?? 'file',
    grants: normalizeCapabilities(candidate.grants ?? []),
    denied: normalizeCapabilities(candidate.denied ?? []),
    installedAt: typeof candidate.installedAt === 'number' ? candidate.installedAt : Date.now(),
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
    failureCount: typeof candidate.failureCount === 'number' ? candidate.failureCount : 0,
    lastError: candidate.lastError ?? null,
    revision: typeof candidate.revision === 'number' ? candidate.revision : 1,
    ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
  }
}

/* ------------------------------ 查询（只读、深拷贝） ------------------------------ */

export function listRecords(): InstalledPluginRecord[] {
  return [...records.values()]
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
    .map(cloneRecord)
}

export function getRecord(pluginId: string): InstalledPluginRecord | undefined {
  const record = records.get(pluginId)
  return record ? cloneRecord(record) : undefined
}

function cloneRecord(record: InstalledPluginRecord): InstalledPluginRecord {
  return {
    ...record,
    manifest: JSON.parse(JSON.stringify(record.manifest)) as PluginManifest,
    files: { ...record.files },
    grants: [...record.grants],
    denied: [...record.denied],
    lastError: record.lastError ? { ...record.lastError } : null,
  }
}

export function isEnabled(pluginId: string): boolean {
  return records.get(pluginId)?.state === 'enabled' && !isSafeModeBlocking()
}

export function getEnabledIds(): string[] {
  if (isSafeModeBlocking()) return []
  return [...records.values()]
    .filter((record) => record.state === 'enabled' && isEnabledInSettings(record.manifest.id))
    .map((record) => record.manifest.id)
    .sort()
}

export function getGrants(pluginId: string): Capability[] {
  return [...(records.get(pluginId)?.grants ?? [])]
}

export function hasGrant(pluginId: string, capability: Capability): boolean {
  return records.get(pluginId)?.grants.includes(capability) === true
}

export function isDenied(pluginId: string, capability: Capability): boolean {
  return records.get(pluginId)?.denied.includes(capability) === true
}

export function getRecordCounts(): { installed: number; enabled: number; disabled: number; quarantined: number } {
  let enabled = 0
  let disabled = 0
  let quarantined = 0
  for (const record of records.values()) {
    if (record.state === 'enabled') enabled += 1
    else if (record.state === 'quarantined') quarantined += 1
    else disabled += 1
  }
  return { installed: records.size, enabled, disabled, quarantined }
}

/** 记录 → 插件页摘要（plugin-host 的 `getSummaries()` 直接用）。 */
export function toPluginSummary(record: InstalledPluginRecord): PluginSummary {
  const counts = contributionCounts(record.manifest.id)
  return {
    id: record.manifest.id,
    name: record.manifest.name,
    version: record.manifest.version,
    kind: record.manifest.kind,
    description: record.manifest.description,
    author: record.manifest.author,
    license: record.manifest.license,
    trust: record.trust,
    installSource: record.installSource,
    state: record.state,
    enabled: record.state === 'enabled' && isEnabledInSettings(record.manifest.id) && !isSafeModeBlocking(),
    failureCount: record.failureCount,
    lastError: record.lastError,
    capabilities: [...record.manifest.capabilities],
    grants: [...record.grants],
    denied: [...record.denied],
    counts: {
      themes: counts.themes ?? 0,
      library: counts.library ?? 0,
      commands: counts.commands ?? 0,
      keymap: counts.keymap ?? 0,
      layoutPresets: counts.layoutPresets ?? 0,
      slots: counts.slots ?? 0,
      lintRules: counts.lintRules ?? 0,
      recipes: counts.recipes ?? 0,
      exportHooks: counts.exportHooks ?? 0,
    },
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
  }
}

export function listSummaries(): PluginSummary[] {
  return listRecords().map(toPluginSummary)
}

/* ------------------------------ 持久化 ------------------------------ */

async function persistRecord(record: InstalledPluginRecord): Promise<void> {
  const ok = await kvSet(AUDIT_STORE, record.manifest.id, record)
  if (!ok && !memoryModeAudited && getStorageMode() === 'memory') {
    memoryModeAudited = true
    appendAudit({ action: 'plugin.error', actor: 'system', result: 'error', code: 'E-STORE-01', detail: 'memory-mode' })
  }
}

/* ------------------------------ 安装管线（02 §3.1） ------------------------------ */

/** 样例包 URL（只允许三款内置样例；同源相对路径）。 */
export function installSampleUrl(sampleId: string): string | null {
  const file = SAMPLE_PACKAGE_FILES[sampleId]
  if (!file) return null
  if (typeof location !== 'undefined') return new URL(`/plugins/samples/${file}`, location.origin).toString()
  return `/plugins/samples/${file}`
}

/**
 * 安装 9 步的 1–5 步：读包 → 解析 → integrity → manifest → 能力差集（权限卡数据）。
 */
export async function prepareInstall(input: RegistryInstallInput): Promise<PluginPackagePreview> {
  await loadRegistry()
  if (isSafeModeBlocking()) throw new PluginError('E-SAFE-01', 'safe mode blocks installation')

  let installSource: 'builtin' | 'file' | 'url' = 'file'
  let sourceUrl: string | undefined
  let envelope
  if (input.sampleId) {
    const url = installSampleUrl(input.sampleId)
    if (!url) throw new PluginError('E-PKG-03', `unknown sample "${input.sampleId}"`)
    if (!isInstallableUrl(url)) throw new PluginError('E-NET-01', 'sample URL is not installable')
    envelope = await readEnvelopeFromUrl(url)
    installSource = 'builtin'
    sourceUrl = url
  } else if (input.url) {
    envelope = await readEnvelopeFromUrl(input.url)
    installSource = 'url'
    sourceUrl = input.url
  } else if (input.text !== undefined) {
    envelope = parseEnvelope(input.text)
  } else if (input.file) {
    envelope = await readEnvelope(input.file)
  } else {
    throw new PluginError('E-PKG-03', 'no package input')
  }

  const bytes = bytesOf(serializeEnvelope(envelope))
  await verifyIntegrity(envelope)
  const warnings: string[] = []
  const manifest = parseManifest(envelope.manifest, {
    files: envelope.files,
    installSource,
    appVersion: APP_VERSION,
    onWarning: (code, detail) => {
      warnings.push(code)
      bumpErrorCount(code)
      appendAudit({ action: 'plugin.denied', actor: 'system', result: 'denied', code, detail })
    },
  })
  const files = { ...envelope.files }
  // 图标在 manifest 校验阶段已过 `sanitizeSvgDocument`（02 §2.2，E-MAN-11）；
  // 这里**不改写** files：files 参与 integrity，落库后启用时还要逐字节重算。
  // 展示侧（插件页/卡片）自己用 sanitizeSvgDocument 渲染净化版。
  const existing = records.get(manifest.id) ?? null
  const previousCaps = existing?.manifest.capabilities ?? []
  const diff = diffGrants(previousCaps, manifest.capabilities)
  const trust: TrustLevel = manifest.trust === 'builtin' && installSource === 'builtin' ? 'builtin' : 'local'
  // builtin 信任级跳过权限卡（03 §2 / D-40-22）：随 App 发布的样例按清单声明全量授权；
  // 第三方（local）仍只默认非敏感能力，敏感 4 项必须用户在权限卡上显式勾选。
  const suggested =
    trust === 'builtin'
      ? normalizeCapabilities(manifest.capabilities)
      : suggestGrants(manifest.capabilities, existing?.grants ?? [])
  if (existing) {
    const order = compareSemver(manifest.version, existing.manifest.version)
    if (order === 0) warnings.push('plugin.warn.alreadyInstalled')
    else if (order < 0) warnings.push('plugin.warn.downgrade')
  }
  return {
    manifest,
    integrity: envelope.integrity,
    files,
    createdAt: envelope.createdAt,
    trust,
    installSource,
    bytes,
    warnings,
    suggestedGrants: suggested,
    sensitive: sensitiveOf(manifest.capabilities),
    addedCapabilities: diff.added,
    removedCapabilities: diff.removed,
    existing,
    ...(sourceUrl ? { sourceUrl } : {}),
  }
}

/** 安装 9 步的 6–9 步：写 IDB（单次）→ 贡献注册 → enable。 */
export async function commitInstall(preview: PluginPackagePreview, options: InstallOptions = {}): Promise<InstallOutcome> {
  await loadRegistry()
  if (isSafeModeBlocking()) throw new PluginError('E-SAFE-01', 'safe mode blocks installation')
  const manifest = preview.manifest
  const existing = records.get(manifest.id) ?? null
  const grants = normalizeCapabilities(options.grants ?? preview.suggestedGrants)
  const denied = normalizeCapabilities(options.denied ?? manifest.capabilities.filter((capability) => !grants.includes(capability)))
  if (grants.some((capability) => !manifest.capabilities.includes(capability))) {
    throw new PluginError('E-PERM-02', 'granted capability was not requested by the manifest')
  }
  // 升级新增敏感能力必须重新确认（02 §5.1 / 03 §3.4）
  if (existing && options.grants !== undefined) {
    const addedSensitive = preview.addedCapabilities.filter((capability) => sensitiveOf([capability]).length > 0)
    const confirmed = addedSensitive.every((capability) => grants.includes(capability))
    if (!confirmed) throw new PluginError('E-PERM-02', 'new sensitive capabilities require confirmation')
  }
  if (existing?.state === 'enabled') {
    removeDeclarativeContributions(manifest.id, existing.manifest)
    emitLifecycle({ type: 'disabled', pluginId: manifest.id })
  }
  const now = Date.now()
  const sourceUrl = preview.sourceUrl ?? existing?.sourceUrl
  const record: InstalledPluginRecord = {
    manifest,
    integrity: preview.integrity,
    files: { ...preview.files },
    createdAt: preview.createdAt,
    state: 'installed',
    trust: preview.trust,
    installSource: preview.installSource,
    grants,
    denied,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
    failureCount: 0,
    lastError: null,
    revision: 1,
    ...(sourceUrl ? { sourceUrl } : {}),
  }
  records.set(manifest.id, record)
  await persistRecord(record)
  // 设置值默认值（声明式设置页）
  const defaults = getDefaultSettingsValues(manifest)
  if (Object.keys(defaults).length > 0) {
    const values = { ...settingsPlugins().values, [manifest.id]: { ...defaults, ...(settingsPlugins().values[manifest.id] ?? {}) } }
    patchPlugins({ values })
  }
  appendAudit({
    action: 'plugin.install',
    actor: preview.trust === 'builtin' ? 'system' : 'user',
    result: 'ok',
    pluginId: manifest.id,
    detail: `v${manifest.version} ${preview.installSource} grants:${grants.join(',')}`,
  })
  if (grants.length > 0) {
    appendAudit({
      action: 'plugin.permission-grant',
      actor: 'user',
      result: 'ok',
      pluginId: manifest.id,
      detail: grants.join(','),
    })
  }
  emitLifecycle({ type: 'installed', pluginId: manifest.id })
  await persistMeta()
  const warnings = [...preview.warnings]
  let enabled = false
  if (options.enable !== false) {
    try {
      await enablePlugin(manifest.id)
      enabled = true
    } catch (error) {
      const pluginError = toPluginError(error)
      warnings.push(pluginError.code)
    }
  } else {
    record.state = 'installed'
    await persistRecord(record)
  }
  notifyChange()
  return { record: cloneRecord(records.get(manifest.id) ?? record), enabled, warnings }
}

/* ------------------------------ 启用 / 停用 / 卸载 ------------------------------ */

export async function enablePlugin(pluginId: string): Promise<void> {
  await loadRegistry()
  if (isSafeModeBlocking()) throw new PluginError('E-SAFE-01', 'safe mode blocks enabling plugins')
  const record = records.get(pluginId)
  if (!record) throw new PluginError('E-STORE-03', `plugin "${pluginId}" is not installed`)
  if (record.state === 'enabled') return

  // 02 §2.4：每次启用从记录重算 integrity（防 IDB 被手改）
  try {
    await verifyIntegrity({
      format: 'lumen-plugin',
      formatVersion: 1,
      createdAt: record.createdAt,
      integrity: record.integrity,
      manifest: record.manifest,
      files: record.files,
    })
  } catch (error) {
    await quarantineRecord(record, toPluginError(error))
    throw error
  }

  // 声明式贡献注册（冲突 → 整包不启用，记录保留）
  try {
    applyDeclarativeContributions(record)
  } catch (error) {
    const pluginError = toPluginError(error, 'E-MAN-09')
    record.lastError = { code: pluginError.code, at: Date.now() }
    record.state = 'disabled'
    await persistRecord(record)
    appendAudit({
      action: 'plugin.error',
      actor: 'system',
      result: 'error',
      pluginId,
      code: pluginError.code,
      detail: pluginError.message,
    })
    throw pluginError
  }

  record.state = 'enabled'
  record.updatedAt = Date.now()
  record.failureCount = 0
  record.lastError = null
  await persistRecord(record)
  patchPlugins({ enabled: { ...settingsPlugins().enabled, [pluginId]: true } })
  appendAudit({ action: 'plugin.enable', actor: 'user', result: 'ok', pluginId })
  emitLifecycle({ type: 'enabled', pluginId })
  notifyChange()
}

export async function disablePlugin(pluginId: string): Promise<void> {
  await loadRegistry()
  const record = records.get(pluginId)
  if (!record) throw new PluginError('E-STORE-03', `plugin "${pluginId}" is not installed`)
  const wasEnabled = record.state === 'enabled'
  removeDeclarativeContributions(pluginId, record.manifest)
  record.state = 'disabled'
  record.updatedAt = Date.now()
  await persistRecord(record)
  patchPlugins({ enabled: { ...settingsPlugins().enabled, [pluginId]: false } })
  if (wasEnabled) {
    appendAudit({ action: 'plugin.disable', actor: 'user', result: 'ok', pluginId })
    emitLifecycle({ type: 'disabled', pluginId })
  }
  notifyChange()
}

export async function uninstallPlugin(pluginId: string, options: { keepData?: boolean } = {}): Promise<void> {
  await loadRegistry()
  const record = records.get(pluginId)
  if (!record) return
  if (record.state === 'enabled') await disablePlugin(pluginId)
  removeDeclarativeContributions(pluginId, record.manifest)
  records.delete(pluginId)
  try {
    await kvDel(AUDIT_STORE, pluginId)
  } catch (error) {
    bumpErrorCount('E-STORE-02')
    appendAudit({ action: 'plugin.error', actor: 'system', result: 'error', pluginId, code: 'E-STORE-02', detail: auditFromError(error).detail })
  }
  // 设置段清理
  const settings = settingsPlugins()
  const enabled = { ...settings.enabled }
  delete enabled[pluginId]
  const values = { ...settings.values }
  delete values[pluginId]
  const keymapOverrides: Record<string, string> = {}
  for (const [combo, commandId] of Object.entries(settings.keymapOverrides)) {
    if (!commandId.startsWith(`plugin.${pluginId}.`)) keymapOverrides[combo] = commandId
  }
  patchPlugins({
    enabled,
    values,
    keymapOverrides,
    ...(settings.layoutOverride ? { layoutOverride: null } : {}),
  })
  if (options.keepData !== true) await purgePluginData(pluginId)
  appendAudit({
    action: 'plugin.uninstall',
    actor: 'user',
    result: 'ok',
    pluginId,
    detail: options.keepData === true ? 'keepData' : 'dataRemoved',
  })
  emitLifecycle({ type: 'uninstalled', pluginId })
  await persistMeta()
  notifyChange()
}

/** 按 `${pluginId}:` 前缀清 `pluginData`（02 §7.5）。 */
async function purgePluginData(pluginId: string): Promise<void> {
  try {
    const keys = await kvKeys('pluginData')
    for (const key of keys) {
      if (key.startsWith(`${pluginId}:`)) await kvDel('pluginData', key)
    }
  } catch (error) {
    bumpErrorCount('E-STORE-02')
    appendAudit({ action: 'plugin.error', actor: 'system', result: 'error', pluginId, code: 'E-STORE-02', detail: auditFromError(error).detail })
  }
}

/* ------------------------------ 隔离与看门狗（02 §3.5 / §5.4） ------------------------------ */

export async function recordBootFailure(
  pluginId: string,
  code: PluginErrorCode,
  message?: string,
): Promise<{ failureCount: number; quarantined: boolean }> {
  await loadRegistry()
  const record = records.get(pluginId)
  if (!record) return { failureCount: 0, quarantined: false }
  record.failureCount += 1
  record.lastError = { code, at: Date.now() }
  record.updatedAt = Date.now()
  appendAudit({
    action: 'plugin.error',
    actor: 'system',
    result: 'error',
    pluginId,
    code,
    detail: message ?? `failure ${record.failureCount}`,
  })
  if (record.failureCount >= 3) {
    await quarantineRecord(record, new PluginError(code, message ?? 'boot failed 3 times'))
    return { failureCount: record.failureCount, quarantined: true }
  }
  await persistRecord(record)
  notifyChange()
  return { failureCount: record.failureCount, quarantined: false }
}

export async function recordBootSuccess(pluginId: string): Promise<void> {
  const record = records.get(pluginId)
  if (!record) return
  if (record.failureCount === 0 && record.lastError === null) return
  record.failureCount = 0
  record.lastError = null
  record.updatedAt = Date.now()
  await persistRecord(record)
  notifyChange()
}

export async function quarantinePlugin(pluginId: string, code: PluginErrorCode, message?: string): Promise<void> {
  await loadRegistry()
  const record = records.get(pluginId)
  if (!record) return
  await quarantineRecord(record, new PluginError(code, message ?? 'quarantined'))
}

async function quarantineRecord(record: InstalledPluginRecord, error: PluginError): Promise<void> {
  removeDeclarativeContributions(record.manifest.id, record.manifest)
  record.state = 'quarantined'
  record.lastError = { code: error.code, at: Date.now() }
  record.failureCount = Math.max(3, record.failureCount)
  record.updatedAt = Date.now()
  await persistRecord(record)
  patchPlugins({ enabled: { ...settingsPlugins().enabled, [record.manifest.id]: false } })
  appendAudit({
    action: 'plugin.quarantine',
    actor: 'system',
    result: 'error',
    pluginId: record.manifest.id,
    code: error.code,
    detail: error.message,
  })
  emitLifecycle({ type: 'quarantined', pluginId: record.manifest.id })
  notifyChange()
}

export async function retryPlugin(pluginId: string): Promise<void> {
  await loadRegistry()
  const record = records.get(pluginId)
  if (!record) throw new PluginError('E-STORE-03', `plugin "${pluginId}" is not installed`)
  record.failureCount = 0
  record.lastError = null
  record.state = 'disabled'
  await persistRecord(record)
  appendAudit({ action: 'plugin.retry', actor: 'user', result: 'ok', pluginId })
  await enablePlugin(pluginId)
}

/* ------------------------------ 授权（03 §3.4 / §3.5） ------------------------------ */

export async function grantCapability(pluginId: string, capability: Capability): Promise<void> {
  await loadRegistry()
  const record = records.get(pluginId)
  if (!record) throw new PluginError('E-STORE-03', `plugin "${pluginId}" is not installed`)
  if (!record.manifest.capabilities.includes(capability)) {
    throw new PluginError('E-CAP-01', `capability "${capability}" was not requested by the manifest`)
  }
  if (!record.grants.includes(capability)) record.grants = normalizeCapabilities([...record.grants, capability])
  record.denied = record.denied.filter((item) => item !== capability)
  record.updatedAt = Date.now()
  await persistRecord(record)
  appendAudit({ action: 'plugin.permission-grant', actor: 'user', result: 'ok', pluginId, detail: capability })
  emitLifecycle({ type: 'grants', pluginId })
  notifyChange()
}

export async function revokeCapability(pluginId: string, capability: Capability): Promise<void> {
  await loadRegistry()
  const record = records.get(pluginId)
  if (!record) throw new PluginError('E-STORE-03', `plugin "${pluginId}" is not installed`)
  record.grants = record.grants.filter((item) => item !== capability)
  if (!record.denied.includes(capability)) record.denied = normalizeCapabilities([...record.denied, capability])
  record.updatedAt = Date.now()
  await persistRecord(record)
  appendAudit({ action: 'plugin.permission-revoke', actor: 'user', result: 'ok', pluginId, detail: capability })
  // 03 §3.5：运行中撤销 → 自动停用（帧销毁由 lifecycle 通知 host）
  if (record.state === 'enabled') await disablePlugin(pluginId)
  emitLifecycle({ type: 'grants', pluginId })
  notifyChange()
}

/* ------------------------------ 安全模式 / 恢复默认 ------------------------------ */

/** 安全模式：写设置并立即撤销当前会话的全部贡献（不改持久化 enabled，退出后恢复）。 */
export async function enableSafeMode(): Promise<void> {
  patchPlugins({ safeMode: true })
  setAuditPersistence(false)
  syncSafeModeSnapshot(true, 'setting')
  for (const record of records.values()) {
    if (record.state !== 'enabled') continue
    removeDeclarativeContributions(record.manifest.id, record.manifest)
    emitLifecycle({ type: 'safe-mode', pluginId: record.manifest.id })
  }
  appendAudit({ action: 'plugin.safe-mode-on', actor: 'user', result: 'ok', detail: 'source:setting' })
  notifyChange()
}

/** 恢复默认工作台（03 §5.3 / 02 §7.5）：禁用全部 + 删数据 + 清覆盖；deck 不动。 */
export async function resetWorkbench(): Promise<void> {
  await loadRegistry()
  let disabledCount = 0
  for (const record of [...records.values()]) {
    if (record.state === 'enabled') disabledCount += 1
    removeDeclarativeContributions(record.manifest.id, record.manifest)
    records.delete(record.manifest.id)
    try {
      await kvDel(AUDIT_STORE, record.manifest.id)
      await purgePluginData(record.manifest.id)
    } catch {
      /* 单条清理失败继续 */
    }
    emitLifecycle({ type: 'uninstalled', pluginId: record.manifest.id })
  }
  // creator 草稿（02 §7.5：删 `draft/` 与 `history/`；具体语义归 creator，这里只清存储）
  try {
    const creatorKeys = await kvKeys('creator')
    for (const key of creatorKeys) {
      if (key.startsWith('draft/') || key.startsWith('history/')) await kvDel('creator', key)
    }
  } catch {
    /* ignore */
  }
  const current = settingsPlugins()
  patchPlugins({
    enabled: {},
    keymapOverrides: {},
    layoutOverride: null,
    values: {},
    creator: { ...current.creator, lastDraftId: null },
  })
  appendAudit({ action: 'plugin.reset', actor: 'user', result: 'ok', detail: `disabled:${disabledCount}` })
  await persistMeta()
  notifyChange()
}

/* ------------------------------ 诊断（02 §7.7 / 03 §5.2） ------------------------------ */

export async function getPluginDiagnostics(): Promise<PluginDiagnostics> {
  const stored = await kvGet<AuditEntry[]>(AUDIT_STORE, '__audit').catch(() => undefined)
  return {
    installed: [...records.keys()].sort(),
    enabled: getEnabledIds(),
    disabled: [...records.values()]
      .filter((record) => record.state === 'disabled' || record.state === 'installed')
      .map((record) => record.manifest.id)
      .sort(),
    quarantined: [...records.values()]
      .filter((record) => record.state === 'quarantined')
      .map((record) => record.manifest.id)
      .sort(),
    errorCounts: getErrorCounts(),
    storageMode: getStorageMode(),
    safeMode: isSafeModeBlocking(),
    auditCount: Math.min(AUDIT_LIMIT, getAuditCount() || (Array.isArray(stored) ? stored.length : 0)),
  }
}

/** 直接读审计环（public/PluginManager 用；最新在前）。 */
export function readAuditEntries(): AuditEntry[] {
  return getAuditEntriesNewestFirst()
}

export function auditCount(): number {
  return getAuditCount()
}

/* ------------------------------ 测试辅助 ------------------------------ */

/** 仅测试用：清空内存注册表（不写 IDB）。 */
export function resetRegistryForTests(): void {
  records.clear()
  loaded = false
  loading = null
  revision = 0
  revisionListeners.clear()
  lifecycleListeners.clear()
  memoryModeAudited = false
}

/** 仅测试用：直接注入记录（跳过安装管线）。 */
export function seedRecordForTests(record: InstalledPluginRecord): void {
  records.set(record.manifest.id, record)
  loaded = true
}

/** 测试辅助：从 manifest+files 组装合法记录。 */
export async function makeRecordFromFiles(
  manifest: PluginManifest,
  files: Record<string, string>,
  opts: {
    state?: PluginState
    grants?: Capability[]
    trust?: TrustLevel
    installSource?: 'builtin' | 'file' | 'url'
  } = {},
): Promise<InstalledPluginRecord> {
  const envelope = await buildEnvelope({ manifest, files, createdAt: 1_700_000_000_000 })
  return {
    manifest,
    integrity: envelope.integrity,
    files,
    createdAt: envelope.createdAt,
    state: (opts.state === 'draft' ? 'installed' : (opts.state ?? 'installed')) as Exclude<PluginState, 'draft'>,
    trust: opts.trust ?? 'local',
    installSource: opts.installSource ?? 'file',
    grants: opts.grants ?? manifest.capabilities.filter((capability) => sensitiveOf([capability]).length === 0),
    denied: [],
    installedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    failureCount: 0,
    lastError: null,
    revision: 1,
  }
}
