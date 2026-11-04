/**
 * plugins/api/meta.ts —— `lumen.meta`（冻结对象，不是方法；02 §5.2 / §5.3）。
 *
 * 客户端 `meta` 由 bootstrap 在帧内从 `window.__LUMEN_BOOT__` 构造并冻结，宿主侧没有 RPC 方法；
 * 本文件仅保留命名空间占位与「客户端 meta 形状」的单一构造点，供 frameDoc/inject/测试引用。
 */
import type { Capability, SlotId } from '../types'
import type { Lang } from '@/i18n/types'

export interface ClientMeta {
  pluginId: string
  pluginVersion: string
  apiVersion: '1.0'
  locale: Lang
  capabilities: Capability[]
  appVersion: string
}

export interface ClientMetaInput {
  pluginId: string
  pluginVersion: string
  apiVersion: '1.0'
  locale: Lang
  capabilities: readonly Capability[]
  appVersion: string
}

/** 构造客户端可见的只读 meta（**不含** grants/密钥/端点，S-40-04）。 */
export function buildClientMeta(input: ClientMetaInput): ClientMeta {
  return {
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    apiVersion: '1.0',
    locale: input.locale === 'en' ? 'en' : 'zh',
    capabilities: [...input.capabilities],
    appVersion: input.appVersion,
  }
}

/** meta 命名空间没有 RPC 方法（网关表里也不登记 `meta.*`）。 */
export const META_METHODS: readonly string[] = []

/** 帧 slot 的类型再导出（meta 展示用；避免调用方 import 两个模块）。 */
export type MetaSlot = SlotId
