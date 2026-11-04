/**
 * tests/security/security-testkit.ts —— 安全层共用的小工具（只读契约、不含任何业务实现）。
 *
 * 目的：把「契约要求的注入形状」变成可在纯逻辑层断言的常量，避免测试里写魔法字符串。
 */
import type { FrameBootPayload } from '@/plugins/types'

/** `FrameBootPayload` 的键集合（02 §4.3 / 03 §4.3：帧内唯一注入形状）。 */
export const FrameBootPayloadKeysForTest = [
  'pluginId',
  'pluginVersion',
  'apiVersion',
  'appVersion',
  'locale',
  'capabilities',
  'frameNonce',
  'entryPath',
  'tokens',
] as const satisfies ReadonlyArray<keyof FrameBootPayload>

/** 宿主绝不可注入帧的字段名（逃逸/泄密面）。 */
export const FORBIDDEN_FRAME_KEYS = ['window', 'document', 'parent', 'top', 'opener', 'cryptoKey', 'apiKey', 'token', 'provider'] as const
