/**
 * plugins/api/i18n.ts —— `lumen.i18n.register`（02 §5.2 / §8.2）。
 *
 * `t/locale` 是帧内同步方法（bootstrap 查本地包，不需要 RPC）；`register` 走宿主校验：
 * 键必须带 `plugin.<pluginId>.` 前缀、zh/en 键集相等、值为空/超 200 字符拒绝（`E-ABI-02`）。
 */
import { registerRuntimeLocalePack } from '../i18n'
import type { ApiCall } from './context'
import { abiError, assertRecord, registerNamespaceApi } from './gateway'
import type { LocalePackContribution } from '../types'

function normalizePack(payload: unknown): LocalePackContribution {
  const body = assertRecord(payload, 'payload')
  const zh = assertRecord(body.zh, 'zh')
  const en = assertRecord(body.en, 'en')
  const zhPack: Record<string, string> = {}
  const enPack: Record<string, string> = {}
  for (const [key, value] of Object.entries(zh)) {
    if (typeof value !== 'string') throw abiError(`zh.${key} must be a string`)
    zhPack[key] = value
  }
  for (const [key, value] of Object.entries(en)) {
    if (typeof value !== 'string') throw abiError(`en.${key} must be a string`)
    enPack[key] = value
  }
  return { zh: zhPack, en: enPack }
}

export function handleI18n(method: string, payload: unknown, call: ApiCall): unknown {
  if (method !== 'register') throw abiError(`unknown i18n method "${method}"`)
  const pack = normalizePack(payload)
  registerRuntimeLocalePack(call.frame.pluginId, pack)
  return null
}

/** 帧内 `lumen.i18n.t` 是同步本地查找；宿主侧无 `i18n.t` 方法。 */
export const I18N_LOCAL_METHODS: readonly string[] = ['t', 'locale']

export function registerI18nApi(): void {
  registerNamespaceApi('i18n', {
    register: (payload, call) => handleI18n('register', payload, call),
  })
}
