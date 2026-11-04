/**
 * plugins/api/storage.ts —— `lumen.storage`（02 §5.2 / §5.3 / §7.2）。
 *
 * 实际键 = `${pluginId}:data:${key}`（host 加前缀），存 `pluginData`；**不写 `assets` store**。
 * 配额：所有 value 的 UTF-8 序列化字节和 ≤512KB/插件（与素材共用同一插件配额，分开计也不超总额）。
 * 超限 → `E-QUOTA-01` 且**不写入**。
 */
import { kvDel, kvEntries, kvGet, kvSet } from '@/persistence/kv'
import type { ApiCall } from './context'
import { abiError, assertRecord, registerNamespaceApi } from './gateway'

export const STORAGE_QUOTA_BYTES = 512 * 1024
export const STORAGE_VALUE_MAX_BYTES = 64 * 1024
const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/

export function storagePrefix(pluginId: string): string {
  return `${pluginId}:data:`
}

export function storageHostKey(pluginId: string, key: string): string {
  return `${storagePrefix(pluginId)}${key}`
}

function utf8Length(text: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : Buffer.byteLength(text, 'utf8')
}

function serialize(value: unknown): string {
  try {
    const text = JSON.stringify(value === undefined ? null : value)
    if (typeof text !== 'string') throw new Error('value is not serializable')
    return text
  } catch {
    throw abiError('storage value must be JSON-serializable')
  }
}

/** 插件当前占用（data 条目 + asset 条目都算，§7.2 的 512KB/插件口径）。 */
export async function storageBytesOf(pluginId: string): Promise<number> {
  const prefix = `${pluginId}:`
  const entries = await kvEntries<unknown>('pluginData')
  let total = 0
  for (const [key, value] of entries) {
    if (!key.startsWith(prefix)) continue
    try {
      total += utf8Length(key) + utf8Length(JSON.stringify(value ?? null) ?? '')
    } catch {
      total += utf8Length(key)
    }
  }
  return total
}

async function assertWithinQuota(pluginId: string, nextBytes: number): Promise<void> {
  const current = await storageBytesOf(pluginId)
  if (current + nextBytes > STORAGE_QUOTA_BYTES) {
    const error = new Error('plugin storage quota exceeded') as Error & { code?: string }
    error.code = 'E-QUOTA-01'
    throw error
  }
}

export async function handleStorage(method: string, payload: unknown, call: ApiCall): Promise<unknown> {
  const { pluginId } = call.frame
  switch (method) {
    case 'get': {
      const body = assertRecord(payload, 'payload')
      const key = assertStorageKey(body.key)
      return (await kvGet<unknown>('pluginData', storageHostKey(pluginId, key))) ?? undefined
    }
    case 'set': {
      const body = assertRecord(payload, 'payload')
      const key = assertStorageKey(body.key)
      const text = serialize(body.value)
      const bytes = utf8Length(text)
      if (bytes > STORAGE_VALUE_MAX_BYTES) {
        const error = new Error('storage value exceeds 64KB') as Error & { code?: string }
        error.code = 'E-QUOTA-01'
        throw error
      }
      await assertWithinQuota(pluginId, bytes)
      await kvSet('pluginData', storageHostKey(pluginId, key), body.value)
      return null
    }
    case 'remove': {
      const body = assertRecord(payload, 'payload')
      const key = assertStorageKey(body.key)
      await kvDel('pluginData', storageHostKey(pluginId, key))
      return null
    }
    case 'keys': {
      const prefix = storagePrefix(pluginId)
      const keys = await kvEntries<unknown>('pluginData')
      return keys
        .map(([key]) => key)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .sort()
    }
    case 'clear': {
      const prefix = `${pluginId}:data:`
      const entries = await kvEntries<unknown>('pluginData')
      for (const [key] of entries) {
        if (key.startsWith(prefix)) await kvDel('pluginData', key)
      }
      return null
    }
    default:
      throw abiError(`unknown storage method "${method}"`)
  }
}

function assertStorageKey(value: unknown): string {
  if (typeof value !== 'string' || !STORAGE_KEY_PATTERN.test(value)) {
    throw abiError('storage key must match ^[a-z0-9][a-z0-9._-]{0,79}$')
  }
  return value
}

/** 卸载清理：默认删除该插件全部 data（§3.4 第 11 项；keepData 时由 registry 决定不调用）。 */
export async function clearPluginStorage(pluginId: string): Promise<void> {
  const prefix = `${pluginId}:data:`
  const entries = await kvEntries<unknown>('pluginData')
  for (const [key] of entries) {
    if (key.startsWith(prefix)) await kvDel('pluginData', key)
  }
}

export function registerStorageApi(): void {
  registerNamespaceApi('storage', {
    get: (payload, call) => handleStorage('get', payload, call),
    set: (payload, call) => handleStorage('set', payload, call),
    remove: (payload, call) => handleStorage('remove', payload, call),
    keys: (payload, call) => handleStorage('keys', payload, call),
    clear: (payload, call) => handleStorage('clear', payload, call),
  })
}
