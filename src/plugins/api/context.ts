/**
 * plugins/api/context.ts —— 宿主 API 层的可注入端口（避免 api/** 直接 import registry/host 内部形成环）。
 *
 * - `RegistryPort`：由 runtime 用 `@/plugins/registry` 的冻结接口 1:1 适配后安装；
 * - `HostUiPort`：由 host（帧宿主）实现，负责标题/忙碌/面板/弹窗；
 * - `DraftPort`：草稿帧的清单/源码查询（creater 试跑用）。
 *
 * 纪律：能力网关每次调用都经 `registryPort().hasGrant()` 实时判定，**不缓存 grants**（02 §5.1）。
 */
import type { Capability, InstalledPluginRecord, PluginKind, SlotId } from '../types'
import type { Lang } from '@/i18n/types'

/* ------------------------------ 帧身份 ------------------------------ */

export interface ApiFrame {
  frameId: string
  pluginId: string
  slot: SlotId
  contributionId: string
  nonce: string
  kind: 'inline' | 'panel' | 'overlay' | 'modal'
  pluginKind: PluginKind
  draftId: string | null
}

/** 帧通道（宿主 → 帧的事件 / 请求；api 层只用到 emit）。 */
export interface ApiChannel {
  emit(method: string, payload?: unknown): void
  request(method: string, payload?: unknown): Promise<unknown>
}

export interface ApiCall {
  frame: ApiFrame
  channel: ApiChannel
}

/* ------------------------------ registry 端口 ------------------------------ */

export interface RegistryPort {
  getRecord(pluginId: string): InstalledPluginRecord | undefined
  listRecords(): InstalledPluginRecord[]
  getEnabledIds(): string[]
  isEnabled(pluginId: string): boolean
  /** 实时读 grants（禁止缓存）。 */
  hasGrant(pluginId: string, capability: Capability): boolean
  isDenied(pluginId: string, capability: Capability): boolean
}

/* ------------------------------ 草稿端口 ------------------------------ */

export interface DraftFrameSource {
  draftId: string
  manifest: InstalledPluginRecord['manifest']
  files: Record<string, string>
  grants: Capability[]
  revision: number
}

export interface DraftPort {
  /** `pluginId` 形如 `draft/<draftId>`；非草稿返回 null。 */
  getFrameSource(pluginId: string): DraftFrameSource | null
  isDraftId(pluginId: string): boolean
}

/* ------------------------------ 宿主 UI 端口 ------------------------------ */

export interface HostUiPort {
  setTitle(frame: ApiFrame, title: string): void
  setBusy(frame: ApiFrame, busy: boolean, label?: string): void
  openDialog(frame: ApiFrame, opts: { id: string; title: string; size?: 'sm' | 'md' | 'lg' }): Promise<void>
  openPanel(frame: ApiFrame, opts: { slot: SlotId; id: string }): Promise<void>
  closePanel(frame: ApiFrame, opts: { slot: SlotId; id?: string }): void
  /** 宿主侧触发插件自己注册的运行期命令（帧内 `run` 回调经 `__invoke` 执行）。 */
  invokeCommand(frame: ApiFrame, commandId: string, args?: unknown): Promise<unknown>
}

/* ------------------------------ 安装/读取 ------------------------------ */

export interface ApiPorts {
  registry: RegistryPort
  hostUi: HostUiPort
  draft: DraftPort | null
  locale: () => Lang
}

let ports: ApiPorts | null = null

export function installApiPorts(next: ApiPorts): void {
  ports = next
}

export function apiPorts(): ApiPorts {
  if (!ports) {
    const error = new Error('plugin api ports are not installed') as Error & { code?: string }
    error.code = 'E-HOST-01'
    throw error
  }
  return ports
}

export function registryPort(): RegistryPort {
  return apiPorts().registry
}

export function hostUi(): HostUiPort {
  return apiPorts().hostUi
}

export function draftPort(): DraftPort | null {
  return apiPorts().draft
}

export function currentLocale(): Lang {
  return apiPorts().locale()
}

/** 测试用：卸载端口。 */
export function resetApiPortsForTests(): void {
  ports = null
}
