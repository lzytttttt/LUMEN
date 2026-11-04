/**
 * plugins/host/PluginHost.tsx —— 帧生命周期 / 看门狗 / 事件桥 / 能力网关接线（02 §3.3 / §3.5 / §4）。
 *
 * 结构：
 * - `FrameManager`：模块单例（非 React context）。负责建帧 → 绑 window → 校验 → 网关 → 销毁；
 * - `PluginHost` 的 9 个挂载组件在 `SlotHost.tsx` 里消费本文件的帧状态；
 * - 懒加载：帧只在「插槽首次可见 / 弹窗打开 / 进入播放 / 命令首次执行」时创建；
 * - 失败：ready 2500ms 超时、心跳 4000ms×3、`__error`、静态预检命中 → 错误卡；
 *   `recordBootFailure` 第 3 次连续失败 → quarantine（registry 落库 `quarantined`），宿主销毁该插件全部帧。
 *
 * 安全：能力网关的判定在 `api/gateway.ts`，本文件不缓存 grants；`event.source` 是消息主判据。
 */
import { useEffect, useSyncExternalStore } from 'react'
import { APP_VERSION } from '@/version'
import { useDeckStore } from '@/state/deckStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { getTheme } from '@/themes'
import { appendAudit } from '../audit'
import { toPluginError } from '../errors'
import {
  getDraftFrameSource,
  getDraftGrants,
  hasDraftGrant,
  parseDraftPluginId,
  registerDraftFrame,
  unregisterDraftFrame,
} from '../draft'
import { getRegisteredSlots, slotHostId } from '../contributionBus'
import { verifyCodeRegistrations } from '../declarative'
import { getPluginSettingValues } from '../declarative'
import { recordBootFailure, recordBootSuccess, getRecord } from '../registry'
import type { Capability, PluginFrameDescriptor, PluginManifest, PluginSlotItem, SlotId } from '../types'
import { PluginFrame } from './PluginFrame'
import { composeBootData, collectFrameTokens, composeFrameDoc, slotKindOf } from './frameDoc'
import { composeBootstrapScript } from './inject'
import { assertSourceSafe } from '../manifest'
import {
  HostRpcChannel,
  createFrameNonce,
  type FrameSourceMeta,
} from './rpc'
import {
  BootFailureTracker,
  FrameQuota,
  FrameWatchdog,
  defaultWatchdogClock,
} from './watchdog'
import {
  closeFrameDialog,
  closeFramePanel,
  getFrameUiSnapshot,
  openFrameDialog,
  openFramePanel,
  setFrameBusy,
  setFrameTitle,
  subscribeFrameUi,
} from './frameUi'
import { dispatchApiCall } from '../api/gateway'
import type { ApiFrame } from '../api/context'
import { listCodeLintRules } from '../api/lint'
import { registeredRecipeIds } from '../api/ai'
import { registeredExportHookIds } from '../api/export'
import { appendSessionLog } from '../api/log'
import type { LogLevel } from '../api/log'
import { canReceiveEvent, EventThrottle, type LumenEventName } from '../api/events'
import { currentLocale } from '../api/context'

/* ------------------------------ 类型 ------------------------------ */

export type FrameStatus = 'booting' | 'ready' | 'error' | 'hung'

export interface FrameViewState {
  frameId: string
  pluginId: string
  slot: SlotId
  contributionId: string
  title: string
  /** 帧生命周期（**非冻结**属性 `data-plugin-frame-status`）。 */
  status: FrameStatus
  /** 插件 5 态（02 §3.2 / 06 §3.1 冻结：`data-plugin-state`）。 */
  pluginState: 'installed' | 'enabled' | 'disabled' | 'quarantined' | 'draft'
  errorCode: string | null
  errorMessage: string | null
  revision: number
  kind: 'inline' | 'panel' | 'overlay' | 'modal'
  srcDoc: string
  pluginKind: 'code'
}

interface ManagedFrame extends FrameViewState {
  channel: HostRpcChannel
  watchdog: FrameWatchdog
  window: Window | null
  nonce: string
  draftId: string | null
  quotaHeld: boolean
}

export interface FrameRequest {
  pluginId: string
  slot: SlotId
  contributionId: string
  title: string
  size?: { w?: number; h?: number }
}

/* ------------------------------ 内部状态 ------------------------------ */

const frames = new Map<string, ManagedFrame>()
const quota = new FrameQuota()
const failures = new BootFailureTracker()
const listeners = new Set<() => void>()
let frameSeq = 0
let version = 0
let messageListenerInstalled = false
let bridgesInstalled = false
const disposers: Array<() => void> = []
const bootstrapSource = composeBootstrapScript()

function emitChange(): void {
  version += 1
  for (const listener of listeners) listener()
}

export function subscribeFrames(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function framesRevision(): number {
  return version
}

/** 帧快照（React `useSyncExternalStore` 用；返回本帧数组的浅拷贝）。 */
export function getFrames(): FrameViewState[] {
  return [...frames.values()].map(toView)
}

function toView(frame: ManagedFrame): FrameViewState {
  return {
    frameId: frame.frameId,
    pluginId: frame.pluginId,
    slot: frame.slot,
    contributionId: frame.contributionId,
    title: frame.title,
    status: frame.status,
    pluginState: frame.pluginState,
    errorCode: frame.errorCode,
    errorMessage: frame.errorMessage,
    revision: frame.revision,
    kind: frame.kind,
    srcDoc: frame.srcDoc,
    pluginKind: frame.pluginKind,
  }
}

/** 插件 5 态（冻结在 `data-plugin-state`）；草稿帧恒为 `draft`。 */
export function pluginStateOf(pluginId: string, draftId?: string | null): FrameViewState['pluginState'] {
  if (draftId || pluginId.startsWith('draft/')) return 'draft'
  const record = getRecord(pluginId)
  if (!record) return 'installed'
  if (record.state === 'enabled') return 'enabled'
  if (record.state === 'disabled') return 'disabled'
  if (record.state === 'quarantined') return 'quarantined'
  return 'installed'
}

export function useFrames(): FrameViewState[] {
  const revision = useSyncExternalStore(subscribeFrames, framesRevision, framesRevision)
  void revision
  return getFrames()
}

export function frameById(frameId: string): FrameViewState | undefined {
  const frame = frames.get(frameId)
  return frame ? toView(frame) : undefined
}

export function framesForSlot(slot: SlotId): FrameViewState[] {
  return getFrames().filter((frame) => frame.slot === slot)
}

/** 某个插槽贡献（`${pluginId}:${contributionId}`）对应的帧。 */
export function frameForItem(itemId: string): FrameViewState | undefined {
  return getFrames().find((frame) => slotHostId(frame.pluginId, frame.contributionId) === itemId)
}

export function frameForPlugin(pluginId: string): FrameViewState | undefined {
  return getFrames().find((frame) => frame.pluginId === pluginId && frame.status !== 'error')
}

/* ------------------------------ 环境 ------------------------------ */

interface FrameSourceData {
  manifest: PluginManifest
  files: Record<string, string>
  entryPath: string
  capabilities: Capability[]
  draftId: string | null
  revision: number
}

function resolveFrameSource(pluginId: string): FrameSourceData | null {
  const draftInfo = parseDraftPluginId(pluginId)
  if (draftInfo) {
    const source = getDraftFrameSource(draftInfo.draftId)
    if (!source) return null
    const entryPath = source.entryPath ?? source.manifest.entry ?? ''
    return {
      manifest: source.manifest,
      files: source.files,
      entryPath,
      capabilities: source.grants,
      draftId: draftInfo.draftId,
      revision: source.revision,
    }
  }
  const record = getRecord(pluginId)
  if (!record || record.state === 'disabled' || record.state === 'quarantined') return null
  const entryPath = record.manifest.entry ?? ''
  return {
    manifest: record.manifest,
    files: record.files,
    entryPath,
    capabilities: record.manifest.capabilities,
    draftId: null,
    revision: record.revision,
  }
}

function currentUiTheme(): 'dark' | 'light' {
  return useSettingsStore.getState().uiTheme === 'light' ? 'light' : 'dark'
}

function currentDensity(): 'comfortable' | 'compact' {
  return useSettingsStore.getState().plugins.layoutOverride?.density === 'compact' ? 'compact' : 'comfortable'
}

function currentDeckThemeId(): string {
  const deck = useDeckStore.getState().deck
  return deck?.themeId ?? 'noir'
}

function currentTokens(): Record<string, string> {
  const deck = useDeckStore.getState().deck
  const overrides = (deck?.themeOverrides ?? undefined) as unknown as Record<string, string> | undefined
  return collectFrameTokens(currentDeckThemeId(), overrides)
}

function themeView(): { id: string; name: { zh: string; en: string }; colors: Record<string, string> } {
  const deck = useDeckStore.getState().deck
  const theme = getTheme(deck?.themeId ?? 'noir')
  return {
    id: theme.id,
    name: theme.name,
    colors: {
      ...(theme.colors as unknown as Record<string, string>),
      ...((deck?.themeOverrides ?? {}) as unknown as Record<string, string>),
    },
  }
}

function envPayload(): Record<string, unknown> {
  return {
    locale: currentLocale(),
    lang: currentLocale(),
    uiTheme: currentUiTheme(),
    reducedMotion: useSettingsStore.getState().reducedMotion === true,
    themeId: currentDeckThemeId(),
    theme: themeView(),
    tokens: currentTokens(),
  }
}

/* ------------------------------ 建帧 ------------------------------ */

/** 建帧数据源（诊断/单测用；不含 srcDoc 拼接）。 */
export function debugFrameSource(pluginId: string) {
  return resolveFrameSource(pluginId)
}

/** 诊断：宿主侧看到的记录状态与模块 URL（排查模块重复实例）。 */
export function debugRegistryProbe(pluginId: string) {
  const record = getRecord(pluginId)
  return { found: Boolean(record), state: record?.state ?? null, moduleUrl: import.meta.url }
}

/** 诊断：返回宿主侧 `getRecord` 的函数引用（与外部 import 的 registry 比对模块实例）。 */
export function debugGetRecordRef() {
  return getRecord
}

/** 诊断：帧表快照（不暴露 srcdoc；含 window 绑定、生命周期与最近消息路由）。 */
export function debugFrameReport() {
  return {
    routerInstalled: messageListenerInstalled,
    bridgesInstalled,
    incoming: incomingTrace.slice(-20),
    frames: [...frames.values()].map((frame) => {
      const record = getRecord(frame.pluginId)
      return {
        frameId: frame.frameId,
        pluginId: frame.pluginId,
        slot: frame.slot,
        status: frame.status,
        pluginState: frame.pluginState,
        hasWindow: frame.window !== null,
        noncePrefix: frame.nonce.slice(0, 8),
        inflight: frame.channel.inflight,
        limiter: frame.channel.limiterState,
        bootFailures: failures.count(frame.pluginId),
        record: record ? { state: record.state, failureCount: record.failureCount, lastError: record.lastError } : null,
      }
    }),
  }
}

function apiFrameOf(frame: ManagedFrame): ApiFrame {
  return {
    frameId: frame.frameId,
    pluginId: frame.pluginId,
    slot: frame.slot,
    contributionId: frame.contributionId,
    nonce: frame.channel ? 'registered' : '',
    kind: frame.kind,
    pluginKind: 'code',
    draftId: frame.draftId,
  }
}

function sendEnv(frame: ManagedFrame): void {
  frame.channel.emit('env', envPayload())
}

function sendSettings(frame: ManagedFrame): void {
  if (frame.draftId) return
  frame.channel.emit('__settings', { values: getPluginSettingValues(frame.pluginId) })
}

/**
 * 设置值变化后向该插件的**所有已就绪帧**推 `__settings`（02 §5.3 `lumen.settings.subscribe`）：
 * 同一插件的多个 UI 帧（dock / overlay / 页签 / 对话）各自是独立 JS 实例，跨帧状态要靠这一刻广播。
 */
export function broadcastPluginSettings(pluginId: string): void {
  for (const frame of frames.values()) {
    if (frame.pluginId === pluginId && frame.status === 'ready') sendSettings(frame)
  }
}

/** 懒挂帧：已存在同贡献的帧 → 直接返回；否则创建（含配额 / 预检 / 超时）。 */
export function ensureFrame(request: FrameRequest): FrameViewState | null {
  const itemId = slotHostId(request.pluginId, request.contributionId)
  const existing = getFrames().find((frame) => slotHostId(frame.pluginId, frame.contributionId) === itemId && frame.slot === request.slot)
  if (existing) return existing

  const source = resolveFrameSource(request.pluginId)
  if (!source) return null
  if (source.manifest.kind !== 'code') return null
  const entrySource = source.files[source.entryPath] ?? ''
  if (!entrySource) {
    return failedView(request, 'E-MAN-06', 'entry source is missing')
  }
  // 静态预检的第二道（安装期已做；IDB 被手改时仍拦）。
  try {
    assertSourceSafe(entrySource, source.entryPath)
  } catch (error) {
    const pluginError = toPluginError(error)
    return failedView(request, pluginError.code, pluginError.message)
  }

  frameSeq += 1
  const frameId = `${request.pluginId}@${request.slot}@${request.contributionId}#${frameSeq}`
  const nonce = createFrameNonce()
  const eta = quota.acquire(frameId, request.pluginId, source.draftId ? 'draft' : 'ui')
  if (!eta.ok) {
    return failedView(request, eta.code ?? 'E-QUOTA-04', eta.reason ?? 'frame quota exceeded')
  }

  const localePack = source.manifest.contributes.i18n?.[0] ?? null
  const descriptor: PluginFrameDescriptor = {
    pluginId: request.pluginId,
    slot: request.slot,
    contributionId: request.contributionId,
    title: request.title,
    frameId,
    revision: source.revision,
    nonce,
    entryPath: source.entryPath,
    kind: 'code',
  }
  const bootTitle = request.title
  let srcDoc = ''
  try {
    srcDoc = composeFrameDoc({
      pluginId: request.pluginId,
      pluginKind: 'code',
      pluginVersion: source.manifest.version,
      apiVersion: '1.0',
      appVersion: APP_VERSION,
      slot: request.slot,
      contributionId: request.contributionId,
      title: bootTitle,
      frameNonce: nonce,
      entryPath: source.entryPath,
      entrySource,
      locale: currentLocale(),
      lang: currentLocale(),
      uiTheme: currentUiTheme(),
      reducedMotion: useSettingsStore.getState().reducedMotion === true,
      density: currentDensity(),
      capabilities: source.capabilities,
      tokens: currentTokens(),
      localePack,
      bootstrap: bootstrapSource,
      size: request.size,
    })
  } catch (error) {
    quota.release(frameId)
    const pluginError = toPluginError(error)
    return failedView(request, pluginError.code, pluginError.message)
  }
  void descriptor

  const managed: ManagedFrame = {
    frameId,
    pluginId: request.pluginId,
    slot: request.slot,
    contributionId: request.contributionId,
    title: bootTitle,
    status: 'booting',
    pluginState: pluginStateOf(request.pluginId, source.draftId),
    errorCode: null,
    errorMessage: null,
    revision: source.revision,
    kind: slotKindOf(request.slot),
    srcDoc,
    pluginKind: 'code',
    channel: null as unknown as HostRpcChannel,
    watchdog: null as unknown as FrameWatchdog,
    window: null,
    nonce,
    draftId: source.draftId,
    quotaHeld: true,
  }

  const channel = new HostRpcChannel({
    identity: { pluginId: request.pluginId, frameNonce: nonce },
    post: (message) => {
      const win = managed.window
      if (win) win.postMessage(message, '*')
    },
    onRequest: (method, payload) => {
      const frame = frames.get(frameId) ?? managed
      const apiFrame = apiFrameOf(frame)
      return dispatchApiCall(
        {
          frame: apiFrame,
          channel: {
            emit: (m: string, p?: unknown) => managed.channel.emit(m, p),
            request: (m: string, p?: unknown) => managed.channel.request(m, p),
          },
        },
        method,
        payload,
      )
    },
    onEvent: (method, payload) => handleFrameEvent(managed, method, payload),
    onRejected: (reason) => {
      appendAudit({
        action: 'plugin.frame-rejected',
        actor: 'system',
        result: 'denied',
        pluginId: request.pluginId,
        code: 'E-ABI-03',
        detail: `reason:${reason} slot:${request.slot}`,
      })
      if (managed.channel.limiterState.suspended) failFrame(managed.frameId, 'E-HOST-03', 'frame rejected too many messages')
    },
  })
  const watchdog = new FrameWatchdog({
    clock: defaultWatchdogClock,
    onReadyTimeout: () => failFrame(frameId, 'E-RUN-02', 'ready timeout after 2500ms'),
    onHung: (misses) => failFrame(frameId, 'E-HOST-03', `heartbeat missed ${misses} times`),
    onTick: () => managed.channel.emit('__ping', { at: Date.now() }),
  })
  managed.channel = channel
  managed.watchdog = watchdog
  frames.set(frameId, managed)
  watchdog.start()
  emitChange()
  return toView(managed)
}

function failedView(request: FrameRequest, code: string, message: string): FrameViewState {
  frameSeq += 1
  return {
    frameId: `failed:${request.pluginId}:${frameSeq}`,
    pluginId: request.pluginId,
    slot: request.slot,
    contributionId: request.contributionId,
    title: request.title,
    status: 'error',
    pluginState: pluginStateOf(request.pluginId),
    errorCode: code,
    errorMessage: message.slice(0, 300),
    revision: 0,
    kind: slotKindOf(request.slot),
    srcDoc: '',
    pluginKind: 'code',
  }
}

/** 该插件（或试跑草稿）是否持有某项能力：实时读 registry / draft 授权，不缓存（02 §5.1）。 */
function hasGrant(pluginId: string, capability: Capability): boolean {
  const draft = parseDraftPluginId(pluginId)
  if (draft) return hasDraftGrant(draft.draftId, capability)
  const record = getRecord(pluginId)
  if (!record) return false
  return record.grants.includes(capability) && !record.denied.includes(capability)
}

/** 该缺失的代码式注册是否必须硬失败（对应能力已被用户拒绝时降级，不算 E-MAN-13）。 */
function isRegistrationRequired(manifest: PluginManifest, pluginId: string, missingId: string): boolean {
  const lintRuleIds = (manifest.contributes.lintRules ?? []).map((rule) => rule.id)
  if (lintRuleIds.includes(missingId)) return hasGrant(pluginId, 'lint:rule')
  const recipeIds = (manifest.contributes.recipes ?? []).map((recipe) => recipe.id)
  if (recipeIds.includes(missingId)) return hasGrant(pluginId, 'ai:recipe')
  const hookIds = (manifest.contributes.exportHooks ?? []).map((hook) => hook.id)
  if (hookIds.includes(missingId)) return hasGrant(pluginId, 'export:hook')
  return true
}

/* ------------------------------ 帧事件 ------------------------------ */

function handleFrameEvent(frame: ManagedFrame, method: string, payload: unknown): void {
  switch (method) {
    case '__ready': {
      if (frame.status === 'ready') return
      frame.watchdog.markReady()
      frame.status = 'ready'
      frame.errorCode = null
      frame.errorMessage = null
      if (!frame.draftId) {
        void recordBootSuccess(frame.pluginId)
        failures.success(frame.pluginId)
        const record = getRecord(frame.pluginId)
        if (record) {
          const check = verifyCodeRegistrations(record.manifest, {
            lintRules: listCodeLintRules(frame.pluginId).map((rule) => rule.id),
            recipes: registeredRecipeIds(frame.pluginId).map((recipeId) => recipeId.split('/')[1] ?? recipeId),
            exportHooks: registeredExportHookIds(frame.pluginId),
          })
          // 用户拒绝的**敏感能力**会让对应贡献无法注册，这不是「清单撒谎」：
          // 只对已授权能力对应的贡献做「清单声明的 id 必须真的注册」硬校验（E-MAN-13）。
          const blockingMissing = check.missing.filter((id) => isRegistrationRequired(record.manifest, frame.pluginId, id))
          if (blockingMissing.length > 0 || check.extra.length > 0) {
            failFrame(
              frame.frameId,
              'E-MAN-13',
              `manifest/run-time registrations mismatch: missing ${blockingMissing.join(',') || '-'} extra ${check.extra.join(',') || '-'}`,
            )
            return
          }
        }
      } else {
        registerDraftFrame(frame.draftId, frame.frameId)
      }
      sendEnv(frame)
      sendSettings(frame)
      frame.channel.emit('app:ready', { appVersion: APP_VERSION, locale: currentLocale() })
      emitChange()
      return
    }
    case '__pong': {
      frame.watchdog.pong()
      return
    }
    case '__log': {
      const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
      const level = body.level === 'debug' || body.level === 'info' || body.level === 'warn' || body.level === 'error' ? (body.level as LogLevel) : 'info'
      appendSessionLog({ frameId: frame.frameId, pluginId: frame.pluginId }, level, typeof body.message === 'string' ? body.message : '')
      return
    }
    case '__error': {
      const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
      const code = typeof body.code === 'string' ? (body.code as FrameViewState['errorCode'] & string) : 'E-RUN-01'
      const message = typeof body.message === 'string' ? body.message.slice(0, 300) : 'plugin runtime error'
      if (frame.status !== 'ready') failFrame(frame.frameId, code, message)
      else {
        frame.status = 'error'
        frame.errorCode = code
        frame.errorMessage = message
        appendAudit({
          action: 'plugin.error',
          actor: 'plugin',
          result: 'error',
          pluginId: frame.pluginId,
          code: code as never,
          detail: message,
        })
        emitChange()
      }
      return
    }
    default:
      return
  }
}

/** 失败收口：释放配额/通道/看门狗，保留错误卡状态；非草稿计连续失败（3 次 → quarantine）。 */
function failFrame(frameId: string, code: string, message: string): void {
  const frame = frames.get(frameId)
  if (!frame || frame.status === 'error' || frame.status === 'hung') return
  frame.status = code === 'E-HOST-03' ? 'hung' : 'error'
  frame.errorCode = code
  frame.errorMessage = message.slice(0, 300)
  cleanupFrameResources(frame)
  appendAudit({
    action: 'plugin.error',
    actor: 'system',
    result: 'error',
    pluginId: frame.pluginId,
    code: code as never,
    detail: message.slice(0, 200),
  })
  if (frame.draftId) {
    unregisterDraftFrame(frame.draftId, frame.frameId)
  } else {
    const result = failures.fail(frame.pluginId)
    if (result.failureCount >= 3) {
      void recordBootFailure(frame.pluginId, code as never, message).then((outcome) => {
        if (outcome.quarantined) {
          // 保留这一帧的错误卡（刷新为 quarantined 态），销毁同插件其它帧。
          const self = frames.get(frameId)
          if (self) self.pluginState = 'quarantined'
          destroyPluginFramesExcept(frame.pluginId, frameId)
          emitChange()
        }
      })
    } else {
      void recordBootFailure(frame.pluginId, code as never, message)
    }
  }
  emitChange()
}

function cleanupFrameResources(frame: ManagedFrame): void {
  if (frame.quotaHeld) {
    quota.release(frame.frameId)
    frame.quotaHeld = false
  }
  try {
    frame.watchdog.stop()
  } catch {
    /* noop */
  }
  try {
    frame.channel.dispose()
  } catch {
    /* noop */
  }
  if (frame.window === null) return
  frame.window = null
}

/** 销毁帧（不记失败）。`disable/uninstall/quarantine` 由 registry 生命周期触发。 */
export function destroyFrame(frameId: string, reason = 'destroyed'): void {
  const frame = frames.get(frameId)
  if (!frame) return
  cleanupFrameResources(frame)
  if (frame.draftId) unregisterDraftFrame(frame.draftId, frame.frameId)
  closeFrameDialog(frame.frameId)
  closeFramePanel(frame.frameId)
  frames.delete(frameId)
  void reason
  emitChange()
}

export function destroyPluginFrames(pluginId: string): void {
  for (const frame of [...frames.values()]) {
    if (frame.pluginId === pluginId) destroyFrame(frame.frameId, 'plugin-disabled')
  }
  const released = quota.releasePlugin(pluginId)
  for (const frameId of released) {
    const frame = frames.get(frameId)
    if (frame) destroyFrame(frameId, 'plugin-disabled')
  }
}

/** 隔离时保留「最后一帧」的错误卡（供插件页/插槽显示原因），销毁其余帧并释放配额。 */
export function destroyPluginFramesExcept(pluginId: string, keepFrameId: string): void {
  for (const frame of [...frames.values()]) {
    if (frame.pluginId === pluginId && frame.frameId !== keepFrameId) destroyFrame(frame.frameId, 'plugin-quarantined')
  }
  const keep = frames.get(keepFrameId)
  if (keep && keep.quotaHeld) {
    quota.release(keepFrameId)
    keep.quotaHeld = false
  }
  quota.releasePlugin(pluginId)
}

/** registry 生命周期 `quarantined`：非错误帧全部销毁，错误卡保留并刷新为 quarantined 态。 */
export function quarantinePluginFrames(pluginId: string): void {
  for (const frame of [...frames.values()]) {
    if (frame.pluginId !== pluginId) continue
    if (frame.status === 'error' || frame.status === 'hung') {
      frame.pluginState = 'quarantined'
      continue
    }
    destroyFrame(frame.frameId, 'plugin-quarantined')
  }
  quota.releasePlugin(pluginId)
  emitChange()
}

export function destroyAllFrames(): void {
  for (const frame of [...frames.values()]) destroyFrame(frame.frameId, 'runtime-reset')
  quota.clear()
}

/** 错误卡「重试」：销毁旧帧并重建（quarantined 由 registry.retryPlugin 复位后由调用方再调 ensureFrame）。 */
export function retryFrame(frameId: string): FrameViewState | null {
  const frame = frames.get(frameId)
  if (!frame) return null
  const request: FrameRequest = {
    pluginId: frame.pluginId,
    slot: frame.slot,
    contributionId: frame.contributionId,
    title: frame.title,
  }
  destroyFrame(frameId, 'retry')
  return ensureFrame(request)
}

/* ------------------------------ 全局消息路由 ------------------------------ */

export function installFrameMessageRouter(): void {
  if (messageListenerInstalled || typeof window === 'undefined') return
  messageListenerInstalled = true
  window.addEventListener('message', onWindowMessage)
  disposers.push(() => window.removeEventListener('message', onWindowMessage))
}

function onWindowMessage(event: MessageEvent): void {
  if (!event.source) return
  const source = event.source
  for (const frame of frames.values()) {
    if (frame.window !== source) continue
    traceIncoming(event.data, 'routed', frame.frameId)
    const meta: FrameSourceMeta = { source, contentWindow: frame.window, origin: event.origin }
    frame.channel.handle(event.data, meta)
    return
  }
  // ready 握手竞态兜底：srcdoc 帧可能在 React commit 绑定 contentWindow 之前就发出第一条消息。
  // 此时按 02 §4.4 的**身份判据**（pluginId + 每次建帧重铸的 32 hex frameNonce）认领来源，
  // 认领后仍以 source === frame.contentWindow 作为后续所有消息的主判据；origin 仍只做辅助。
  const data = event.data as { v?: unknown; pluginId?: unknown; frameNonce?: unknown } | null
  if (!data || typeof data !== 'object' || data.v !== 1) {
    traceIncoming(event.data, 'unmatched')
    return
  }
  if (typeof data.pluginId !== 'string' || typeof data.frameNonce !== 'string') {
    traceIncoming(event.data, 'unmatched')
    return
  }
  for (const frame of frames.values()) {
    if (frame.window !== null) continue
    if (frame.pluginId !== data.pluginId || frame.nonce !== data.frameNonce) continue
    // `MessageEventSource` 可能是 MessagePort；只有 Window 才可能是帧内容窗口。
    if (typeof source !== 'object' || !('postMessage' in source)) return
    frame.window = source as Window
    traceIncoming(event.data, 'claimed', frame.frameId)
    frame.channel.handle(event.data, { source, contentWindow: source, origin: event.origin })
    return
  }
  traceIncoming(event.data, 'unmatched')
  // 非本帧来源：静默丢弃（S-40-02；审计由 channel 的 onRejected 负责）。
}

/* ------------------------------ 调试追踪（仅诊断，不参与业务） ------------------------------ */

interface IncomingTrace {
  at: number
  type: string | null
  method: string | null
  pluginId: string | null
  noncePrefix: string | null
  code: string | null
  message: string | null
  outcome: 'routed' | 'claimed' | 'unmatched'
  frameId: string | null
}

const incomingTrace: IncomingTrace[] = []

function traceIncoming(data: unknown, outcome: IncomingTrace['outcome'], frameId: string | null = null): void {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const payload = record.payload && typeof record.payload === 'object' ? (record.payload as Record<string, unknown>) : {}
  incomingTrace.push({
    at: Date.now(),
    type: typeof record.type === 'string' ? record.type : null,
    method: typeof record.method === 'string' ? record.method : null,
    pluginId: typeof record.pluginId === 'string' ? record.pluginId : null,
    noncePrefix: typeof record.frameNonce === 'string' ? record.frameNonce.slice(0, 8) : null,
    code: typeof payload.code === 'string' ? payload.code : typeof record.code === 'string' ? record.code : null,
    message:
      typeof payload.message === 'string'
        ? payload.message.slice(0, 80)
        : typeof record.message === 'string'
          ? record.message.slice(0, 80)
          : null,
    outcome,
    frameId,
  })
  if (incomingTrace.length > 40) incomingTrace.splice(0, incomingTrace.length - 40)
}

/** React 侧绑定 iframe window（PluginFrame ref callback，早于 load/ready 调用）。 */
export function bindFrameWindow(frameId: string, win: Window | null): void {
  const frame = frames.get(frameId)
  if (!frame) return
  frame.window = win
}

/* ------------------------------ 事件桥 ------------------------------ */

let deckThrottle: EventThrottle | null = null

function frameCanReceive(frame: ManagedFrame, name: LumenEventName): boolean {
  if (frame.status !== 'ready') return false
  if (frame.draftId) {
    const capability = name === 'deck:change' || name === 'deck:open' || name === 'slide:change' ? 'deck:read' : name === 'play:start' || name === 'play:stop' ? 'ui:slot' : name === 'export:before' || name === 'export:after' ? 'export:hook' : null
    return capability === null ? true : hasDraftGrant(frame.draftId, capability as Capability)
  }
  return canReceiveEvent({ pluginId: frame.pluginId, draftId: null }, name)
}

export function broadcastEvent(name: LumenEventName, payload: unknown): void {
  for (const frame of frames.values()) {
    if (!frameCanReceive(frame, name)) continue
    frame.channel.emit(name, payload)
  }
}

export function broadcastEnv(): void {
  for (const frame of frames.values()) {
    if (frame.status !== 'ready') continue
    sendEnv(frame)
  }
}

/** 安装 store → 帧事件桥（幂等；runtime 启动时调用一次）。 */
export function startFrameBridges(): void {
  if (bridgesInstalled) return
  bridgesInstalled = true
  deckThrottle = new EventThrottle(100, (payload) => broadcastEvent('deck:change', payload))

  const unsubDeck = useDeckStore.subscribe((state, previous) => {
    if (state.revision === previous.revision) return
    if (state.deck?.themeId !== previous.deck?.themeId) {
      broadcastEnv()
      broadcastEvent('theme:change', { themeId: state.deck?.themeId ?? 'noir' })
    }
    deckThrottle?.push({ revision: state.revision, reason: 'deck' })
  })
  const unsubUi = useUiStore.subscribe((state, previous) => {
    if (state.activeSlideId !== previous.activeSlideId) {
      const deck = useDeckStore.getState().deck
      const index = deck?.slides.findIndex((slide) => slide.id === state.activeSlideId) ?? -1
      if (state.activeSlideId) broadcastEvent('slide:change', { slideId: state.activeSlideId, index: Math.max(0, index) })
    }
    if (state.mode !== previous.mode) {
      broadcastEvent('mode:change', { mode: state.mode === 'forge' ? 'forge' : state.mode })
      if (state.mode === 'play') {
        const deck = useDeckStore.getState().deck
        const index = Math.max(0, deck?.slides.findIndex((slide) => slide.id === state.activeSlideId) ?? 0)
        const slideId = state.activeSlideId ?? deck?.slides[index]?.id ?? ''
        if (slideId) broadcastEvent('play:start', { slideId, index })
      } else if (previous.mode === 'play') {
        broadcastEvent('play:stop', { slideId: previous.activeSlideId ?? '' })
      }
    }
  })
  const unsubSettings = useSettingsStore.subscribe((state, previous) => {
    if (
      state.lang !== previous.lang ||
      state.uiTheme !== previous.uiTheme ||
      state.reducedMotion !== previous.reducedMotion ||
      state.plugins.layoutOverride?.density !== previous.plugins.layoutOverride?.density
    ) {
      broadcastEnv()
    }
  })
  disposers.push(unsubDeck, unsubUi, unsubSettings)
}

export function stopFrameBridges(): void {
  for (const dispose of disposers.splice(0)) {
    try {
      dispose()
    } catch {
      /* noop */
    }
  }
  deckThrottle?.dispose()
  deckThrottle = null
  bridgesInstalled = false
}

/* ------------------------------ 宿主动作（HostUiPort / 执行器） ------------------------------ */

function slotItemOf(pluginId: string, contributionId: string): PluginSlotItem | undefined {
  return getRegisteredSlots().find((item) => item.id === slotHostId(pluginId, contributionId))
}

export function hostOpenDialog(
  frame: ApiFrame,
  opts: { id: string; title: string; size?: 'sm' | 'md' | 'lg' },
): Promise<void> {
  const item = slotItemOf(frame.pluginId, opts.id)
  if (!item || item.slot !== 'dialog') {
    return Promise.reject(toPluginError(new Error('slot contribution is not declared')))
  }
  const view = ensureFrame({ pluginId: frame.pluginId, slot: 'dialog', contributionId: opts.id, title: opts.title || item.title.zh || item.title.en })
  if (!view) return Promise.reject(toPluginError(new Error('frame could not be created')))
  openFrameDialog({
    frameId: view.frameId,
    pluginId: frame.pluginId,
    contributionId: opts.id,
    title: opts.title || item.title.zh || item.title.en,
    size: opts.size ?? 'md',
  })
  emitChange()
  return Promise.resolve()
}

export function hostOpenPanel(frame: ApiFrame, opts: { slot: SlotId; id: string }): Promise<void> {
  const item = slotItemOf(frame.pluginId, opts.id)
  if (!item || item.slot !== opts.slot) {
    return Promise.reject(toPluginError(new Error('slot contribution is not declared')))
  }
  const view = ensureFrame({ pluginId: frame.pluginId, slot: opts.slot, contributionId: opts.id, title: item.title.zh || item.title.en })
  if (!view) return Promise.reject(toPluginError(new Error('frame could not be created')))
  if (opts.slot === 'workspace.inspector.tab') {
    useUiStore.getState().setInspectorTab(`plug:${item.id}`)
    useUiStore.getState().setMode('edit')
  } else if (opts.slot === 'workspace.dock' || opts.slot === 'workspace.overlay') {
    openFramePanel({ frameId: view.frameId, pluginId: frame.pluginId, slot: opts.slot, contributionId: opts.id, title: item.title.zh || item.title.en })
  }
  emitChange()
  return Promise.resolve()
}

export function hostClosePanel(frame: ApiFrame, opts: { slot: SlotId; id?: string }): void {
  const targetContribution = opts.id ?? frame.contributionId
  for (const view of getFrames()) {
    if (view.pluginId !== frame.pluginId) continue
    if (view.slot !== opts.slot) continue
    if (opts.id && view.contributionId !== targetContribution) continue
    destroyFrame(view.frameId, 'close-panel')
  }
  if (opts.slot === 'workspace.inspector.tab') {
    const itemId = slotHostId(frame.pluginId, targetContribution)
    if (useUiStore.getState().inspectorTab === `plug:${itemId}`) useUiStore.getState().setInspectorTab('props')
  }
  emitChange()
}

export function hostSetTitle(frame: ApiFrame, title: string): void {
  setFrameTitle(frame.frameId, title)
  const managed = frames.get(frame.frameId)
  if (managed) {
    managed.title = title.slice(0, 40)
    emitChange()
  }
}

export function hostSetBusy(frame: ApiFrame, busy: boolean, label?: string): void {
  setFrameBusy(frame.frameId, busy, label)
}

/** 宿主触发插件命令（命令面板 / 声明式键位 runner）。 */
export async function requestPluginCommand(pluginId: string, commandId: string, args?: unknown): Promise<unknown> {
  const frame = [...frames.values()].find((item) => item.pluginId === pluginId && item.status === 'ready')
  if (!frame) throw toPluginError(new Error(`plugin "${pluginId}" has no ready frame`))
  return frame.channel.request('__invoke', { id: commandId, args })
}

export async function requestPluginLintRule(pluginId: string, ruleId: string, ctx: unknown): Promise<unknown> {
  const frame = [...frames.values()].find((item) => item.pluginId === pluginId && item.status === 'ready')
  if (!frame) return []
  return frame.channel.request('__runRule', { id: ruleId, ctx })
}

export async function requestPluginRecipe(pluginId: string, recipeId: string, content: unknown, themeId: string): Promise<unknown> {
  const frame = [...frames.values()].find((item) => item.pluginId === pluginId && item.status === 'ready')
  if (!frame) throw toPluginError(new Error(`plugin "${pluginId}" has no ready frame`))
  return frame.channel.request('__runRecipe', { id: recipeId.split('/')[1] ?? recipeId, content, themeId })
}

export async function requestPluginPreflight(pluginId: string, ctx: unknown): Promise<unknown> {
  const frame = [...frames.values()].find((item) => item.pluginId === pluginId && item.status === 'ready')
  if (!frame) return []
  return frame.channel.request('__preflight', { ctx })
}

export async function requestPluginAssets(pluginId: string): Promise<unknown> {
  const frame = [...frames.values()].find((item) => item.pluginId === pluginId && item.status === 'ready')
  if (!frame) return []
  return frame.channel.request('__provideAssets', {})
}

/* ------------------------------ React 组件 ------------------------------ */

/** 帧容器（SlotHost 内部用）：按 `FrameViewState` 渲染 iframe。 */
export function FrameSlotView({ frame, style }: { frame: FrameViewState; style?: React.CSSProperties }) {
  useEffect(() => {
    installFrameMessageRouter()
  }, [])
  if (frame.status === 'error' || frame.status === 'hung') return null
  return (
    <PluginFrame
      frameId={frame.frameId}
      pluginId={frame.pluginId}
      slot={frame.slot}
      title={frame.title}
      srcDoc={frame.srcDoc}
      pluginState={frame.pluginState}
      frameStatus={frame.status}
      pluginKind="code"
      onWindow={bindFrameWindow}
      style={style}
    />
  )
}

/** 供 Test/e2e 读取的帧 UI 快照（标题/busy/弹窗）。 */
export function frameUiSnapshot() {
  return getFrameUiSnapshot()
}

export function subscribeFrameUiState(listener: () => void): () => void {
  return subscribeFrameUi(listener)
}

/** 运行时重置（恢复默认工作台）。 */
export function resetFrameHost(): void {
  destroyAllFrames()
  failures.reset()
  quota.clear()
  emitChange()
}
