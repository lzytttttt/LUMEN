/**
 * plugins/api/gateway.ts —— 能力网关（02 §5.2「方法 → 能力」的唯一判据）。
 *
 * 每个请求：
 * 1. 方法必须存在于 `METHOD_CAPABILITIES` 与已注册 handler 表 → 否则 `E-ABI-01`；
 * 2. 需要能力时，**每次**实时 `hasGrant()`（不缓存）；未授权 → 审计 `plugin.denied` + `E-CAP-01`；
 * 3. 参数校验由各命名空间 zod/手工校验完成，失败 → `E-ABI-02`；
 * 4. 任何非 `PluginError` 一律伪装 `E-HOST-01`（不泄漏堆栈/路径，02 §4.4）。
 */
import { appendAudit } from '../audit'
import { PluginError, toPluginError } from '../errors'
import type { Capability } from '../types'
import { apiPorts, registryPort, type ApiCall } from './context'

/* ------------------------------ 命名空间 handler ------------------------------ */

export type ApiHandler = (payload: unknown, call: ApiCall) => Promise<unknown> | unknown
export type ApiNamespaceHandlers = Record<string, ApiHandler>

const namespaces = new Map<string, ApiNamespaceHandlers>()

export function registerNamespaceApi(name: string, handlers: ApiNamespaceHandlers): void {
  namespaces.set(name, handlers)
}

export function registeredNamespaceNames(): string[] {
  return [...namespaces.keys()].sort()
}

/** 测试用：清空命名空间表（不重置 METHOD_CAPABILITIES）。 */
export function resetNamespaceApisForTests(): void {
  namespaces.clear()
}

/* ------------------------------ 方法 → 能力 ------------------------------ */

/** 02 §5.2 冻结映射；`null` = 无需能力（仍逐方法校验）。 */
export const METHOD_CAPABILITIES: Readonly<Record<string, Capability | null>> = {
  // meta：只读冻结对象，无 RPC 方法
  // ui
  'ui.setTitle': 'ui:slot',
  'ui.setBusy': 'ui:slot',
  'ui.openDialog': 'ui:slot',
  'ui.openPanel': 'ui:slot',
  'ui.closePanel': 'ui:slot',
  // commands
  'commands.register': 'ui:command',
  'commands.unregister': 'ui:command',
  'commands.invoke': 'ui:command',
  // keymap
  'keymap.bind': 'ui:keymap',
  'keymap.unbind': 'ui:keymap',
  // layout
  'layout.registerPreset': 'ui:layout',
  'layout.apply': 'ui:layout',
  'layout.current': 'ui:layout',
  // deck
  'deck.getSnapshot': 'deck:read',
  'deck.getActiveSlide': 'deck:read',
  'deck.subscribe': 'deck:read',
  'deck.insertBlocks': 'deck:write',
  'deck.updateBlock': 'deck:write',
  'deck.transaction': 'deck:write',
  'deck.applyTheme': 'deck:write',
  // theme：只读，无能力
  'theme.get': null,
  'theme.cssVars': null,
  'theme.subscribe': null,
  // storage / settings
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.remove': 'storage',
  'storage.keys': 'storage',
  'storage.clear': 'storage',
  'settings.declare': 'storage',
  'settings.get': 'storage',
  'settings.patch': 'storage',
  'settings.reset': 'storage',
  'settings.subscribe': 'storage',
  // i18n
  'i18n.t': null,
  'i18n.register': 'i18n:contribute',
  // lint
  'lint.registerRule': 'lint:rule',
  'lint.report': 'lint:rule',
  // ai
  'ai.complete': 'ai:invoke',
  'ai.registerRecipe': 'ai:recipe',
  'ai.registerPromptFragment': 'ai:recipe',
  // assets
  'assets.put': 'asset:write',
  'assets.getUrl': 'asset:write',
  'assets.remove': 'asset:write',
  'assets.list': 'asset:write',
  // export
  'export.onPreflight': 'export:hook',
  'export.provideStaticAssets': 'export:hook',
  // events：订阅是帧内本地行为，宿主按事件能力过滤推送（见 api/events.ts）
  // notify / log：无能力
  'notify.toast': null,
}

/** 查看方法所需能力（诊断/测试用）。 */
export function capabilityOfMethod(method: string): Capability | null | undefined {
  return METHOD_CAPABILITIES[method]
}

/**
 * 网关唯一入口：返回 handler 结果或抛 `PluginError`。
 * 调用方（RPC 通道）只负责把错误编码成 `err` 帧。
 */
export async function dispatchApiCall(call: ApiCall, method: string, payload: unknown): Promise<unknown> {
  const capability = METHOD_CAPABILITIES[method]
  if (capability === undefined) throw new PluginError('E-ABI-01', `unknown method "${method}"`)

  const { pluginId } = call.frame
  // 能力：逐方法实时判定，绝不缓存。
  if (capability !== null) {
    const registry = registryPort()
    const record = registry.getRecord(pluginId)
    if (!record) {
      if (call.frame.draftId) {
        // 草稿帧的授权来自 draft（runtime 安装的 draft 端口），registry 无记录时回落到 draft grants。
        const draft = apiPorts().draft?.getFrameSource(pluginId)
        const granted = draft?.grants.includes(capability) === true
        if (!granted) {
          auditDenied(call, capability)
          throw new PluginError('E-CAP-01', `capability "${capability}" is not granted`)
        }
      } else {
        throw new PluginError('E-HOST-01', 'plugin record is unavailable')
      }
    } else if (!registry.hasGrant(pluginId, capability)) {
      auditDenied(call, capability)
      throw new PluginError('E-CAP-01', `capability "${capability}" is not granted`)
    }
  }

  const separator = method.indexOf('.')
  const namespace = separator > 0 ? method.slice(0, separator) : method
  const action = separator > 0 ? method.slice(separator + 1) : ''
  const handler = namespaces.get(namespace)?.[action]
  if (!handler) throw new PluginError('E-ABI-01', `method "${method}" is not implemented`)

  try {
    return await handler(payload, call)
  } catch (error) {
    throw toPluginError(error)
  }
}

function auditDenied(call: ApiCall, capability: Capability): void {
  appendAudit({
    action: 'plugin.denied',
    actor: 'plugin',
    result: 'denied',
    pluginId: call.frame.pluginId,
    code: 'E-CAP-01',
    detail: `capability:${capability} slot:${call.frame.slot} contribution:${call.frame.contributionId}`,
  })
}

/* ------------------------------ 参数校验小工具 ------------------------------ */

export function abiError(message: string, detail?: string): PluginError {
  return new PluginError('E-ABI-02', message, detail)
}

export function assertString(value: unknown, field: string, opts: { min?: number; max?: number } = {}): string {
  if (typeof value !== 'string') throw abiError(`${field} must be a string`)
  const min = opts.min ?? 0
  const max = opts.max ?? 2000
  const text = value
  if (text.length < min) throw abiError(`${field} is too short`)
  if (text.length > max) throw abiError(`${field} is too long`)
  return text
}

export function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw abiError(`${field} must be an object`)
  return value as Record<string, unknown>
}

export function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw abiError(`${field} must be a boolean`)
  return value
}

export function clampNumber(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw abiError(`${field} must be a number`)
  return Math.min(max, Math.max(min, value))
}

/** 只保留 JSON 可序列化值（拒绝函数/symbol/undefined 字段）。 */
export function assertJsonValue(value: unknown, field: string, depth = 0): unknown {
  if (depth > 8) throw abiError(`${field} is nested too deep`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw abiError(`${field} must be a finite number`)
    return value
  }
  if (Array.isArray(value)) return value.map((item) => assertJsonValue(item, field, depth + 1))
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined || typeof child === 'function' || typeof child === 'symbol') {
        throw abiError(`${field}.${key} is not JSON-serializable`)
      }
      output[key] = assertJsonValue(child, `${field}.${key}`, depth + 1)
    }
    return output
  }
  throw abiError(`${field} is not JSON-serializable`)
}
