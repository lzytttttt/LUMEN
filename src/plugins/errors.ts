/**
 * plugins/errors.ts —— 插件错误码契约（02 §5.5，45 个）与错误对象。
 *
 * 纪律：错误码只增不删、语义不变；宿主内部错误在跨帧边界一律伪装 `E-HOST-01`（不泄漏堆栈/路径）。
 * 用户可见文案 key 冻结在 02 §5.5 的「用户可见 key」列；本文件只给映射，不引 i18n（插件层不依赖宿主词典）。
 */
import type { PluginErrorCode } from './types'

/** 错误码 → i18n key（02 §5.5 冻结；`E-AUDIT-01` 不提示）。 */
export const ERROR_MESSAGE_KEYS: Record<PluginErrorCode, string> = {
  'E-PKG-01': 'plugin.error.badPackage',
  'E-PKG-02': 'plugin.error.format',
  'E-PKG-03': 'plugin.error.badPackage',
  'E-PKG-04': 'plugin.error.tooLarge',
  'E-PKG-05': 'plugin.error.integrityMismatch',
  'E-PKG-06': 'plugin.error.badPackage',
  'E-MAN-01': 'plugin.error.manifest',
  'E-MAN-02': 'plugin.error.id',
  'E-MAN-03': 'plugin.error.version',
  'E-MAN-04': 'plugin.error.apiVersion',
  'E-MAN-05': 'plugin.error.minApp',
  'E-MAN-06': 'plugin.error.entry',
  'E-MAN-07': 'plugin.error.kindMismatch',
  'E-MAN-08': 'plugin.error.capability',
  'E-MAN-09': 'plugin.error.conflict',
  'E-MAN-10': 'plugin.error.trust',
  'E-MAN-11': 'plugin.error.icon',
  'E-MAN-12': 'plugin.error.forbiddenApi',
  'E-MAN-13': 'plugin.error.proposalMismatch',
  'E-MAN-14': 'plugin.error.proposalInvalid',
  'E-PERM-01': 'plugin.error.denied',
  'E-PERM-02': 'plugin.error.needConfirm',
  'E-PERM-03': 'plugin.error.revoked',
  'E-STORE-01': 'plugin.warn.memoryMode',
  'E-STORE-02': 'plugin.error.store',
  'E-STORE-03': 'plugin.error.store',
  'E-HOST-01': 'plugin.error.host',
  'E-HOST-02': 'plugin.error.frame',
  'E-HOST-03': 'plugin.error.hung',
  'E-ABI-01': 'plugin.error.abi',
  'E-ABI-02': 'plugin.error.abi',
  'E-ABI-03': 'plugin.error.abi',
  'E-ABI-04': 'plugin.error.rateLimit',
  'E-ABI-05': 'plugin.error.timeout',
  'E-CAP-01': 'plugin.error.capability',
  'E-CAP-02': 'plugin.error.revoked',
  'E-RUN-01': 'plugin.error.runtime',
  'E-RUN-02': 'plugin.error.boot',
  'E-QUOTA-01': 'plugin.error.quota',
  'E-QUOTA-02': 'plugin.error.quota',
  'E-QUOTA-03': 'plugin.warn.exportTimeout',
  'E-QUOTA-04': 'plugin.error.frameQuota',
  'E-NET-01': 'plugin.error.fetchFailed',
  'E-SAFE-01': 'plugin.error.safeMode',
  'E-AUDIT-01': '',
}

/** crypto.subtle 不可用时的 detail 标记（02 §2.4：非安全上下文拒绝安装，不做弱校验）。 */
export const INTEGRITY_UNSUPPORTED = 'integrityUnsupported'

export class PluginError extends Error {
  readonly code: PluginErrorCode
  /** ≤200 字符、已脱敏的补充说明（可空）。 */
  readonly detail?: string

  constructor(code: PluginErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'PluginError'
    this.code = code
    if (detail !== undefined) this.detail = redact(detail).slice(0, 200)
  }
}

export function isPluginError(value: unknown): value is PluginError {
  return value instanceof PluginError
}

/** 用户可见 i18n key；未知码不提示（返回空串）。 */
export function pluginErrorMessageKey(code: PluginErrorCode): string {
  return ERROR_MESSAGE_KEYS[code] ?? ''
}

/**
 * 宿主内部错误伪装：任何非 PluginError 都收敛成 `E-HOST-01`。
 * 02 §4.4：宿主内部错误一律伪装、**不泄漏堆栈/路径/内部消息**（跨帧边界只回固定文案）。
 */
export function toPluginError(error: unknown, fallback: PluginErrorCode = 'E-HOST-01'): PluginError {
  if (isPluginError(error)) return error
  if (fallback !== 'E-HOST-01') {
    const message = error instanceof Error ? error.message : String(error)
    return new PluginError(fallback, redact(message).slice(0, 300))
  }
  return new PluginError('E-HOST-01', 'plugin host internal error')
}

/** 脱敏：apiKey / bearer / URL 查询串 / sk- 形态（与 src/ai/provider 的 redact 思路一致）。 */
export function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer ***')
    .replace(/([?&](?:key|token|api_key|apikey|access_token|sig|signature)=)[^&\s]+/gi, '$1***')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?***')
}

/** 错误码前缀判定（回喂白名单用）。 */
export function isFeedbackErrorCode(code: PluginErrorCode): boolean {
  return /^E-(PKG|MAN|ABI|CAP|RUN|QUOTA)-/.test(code)
}
