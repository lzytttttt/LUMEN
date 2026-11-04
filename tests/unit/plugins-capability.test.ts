/**
 * U-40-71…115（能力表子集）：15 能力、敏感判定、授权差集与错误码契约（02 §5.1 / §5.5）。
 */
import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  CAPABILITY_META,
  CONTRIBUTION_CAPABILITY,
  actionCapabilities,
  defaultGrants,
  diffGrants,
  isCapability,
  isSensitiveCapability,
  normalizeCapabilities,
  sensitiveOf,
  suggestGrants,
} from '@/plugins/capabilities'
import {
  ERROR_MESSAGE_KEYS,
  INTEGRITY_UNSUPPORTED,
  PluginError,
  isFeedbackErrorCode,
  isPluginError,
  pluginErrorMessageKey,
  redact,
  toPluginError,
} from '@/plugins/errors'
import {
  CAPABILITY_IDS,
  FEEDBACK_ERROR_CODES,
  PLUGIN_ERROR_CODES,
  SENSITIVE_CAPABILITIES,
  SLOT_IDS,
  SLOT_KINDS,
} from '@/plugins/types'

describe('15 项能力表（00 §7.2 冻结）', () => {
  it('数量、顺序与敏感性', () => {
    expect(CAPABILITY_IDS).toHaveLength(15)
    expect(CAPABILITIES.map((meta) => meta.id)).toEqual([...CAPABILITY_IDS])
    expect([...SENSITIVE_CAPABILITIES]).toEqual(['ai:invoke', 'deck:write', 'asset:write', 'export:hook'])
    expect(CAPABILITIES.filter((meta) => meta.sensitive)).toHaveLength(4)
  })

  it('每项能力都有 labelKey，敏感项有 detailKey', () => {
    for (const meta of CAPABILITIES) {
      expect(meta.labelKey).toBe(`plugin.capability.${meta.labelKey.split('.').pop()}`)
      expect(meta.labelKey.startsWith('plugin.capability.')).toBe(true)
      if (meta.sensitive) expect(meta.detailKey).toBe(`plugin.capabilityDetail.${meta.labelKey.split('.').pop()}`)
      else expect(meta.detailKey).toBe('')
    }
  })

  it('CAPABILITY_META 与 15 项一一对应', () => {
    expect(Object.keys(CAPABILITY_META)).toHaveLength(15)
    expect(CAPABILITY_META['deck:write'].sensitive).toBe(true)
    expect(CAPABILITY_META['ui:slot'].sensitive).toBe(false)
  })

  it('isCapability / isSensitiveCapability', () => {
    expect(isCapability('deck:read')).toBe(true)
    expect(isCapability('network:fetch')).toBe(false)
    expect(isCapability(42)).toBe(false)
    expect(isSensitiveCapability('deck:write')).toBe(true)
    expect(isSensitiveCapability('deck:read')).toBe(false)
  })
})

describe('授权集工具', () => {
  it('normalizeCapabilities 去重并按 02 §5.1 表顺序排序', () => {
    expect(normalizeCapabilities(['storage', 'ui:slot', 'storage', 'nope'])).toEqual(['ui:slot', 'storage'])
  })

  it('defaultGrants 只授非敏感项', () => {
    const grants = defaultGrants(['deck:write', 'ui:slot', 'ai:invoke', 'storage'])
    expect(grants).toEqual(['ui:slot', 'storage'])
  })

  it('suggestGrants 保留旧版已授权的敏感项（升级不降权）', () => {
    expect(suggestGrants(['ui:slot', 'deck:write'], ['deck:write'])).toEqual(['ui:slot', 'deck:write'])
    expect(suggestGrants(['ui:slot', 'deck:write'], [])).toEqual(['ui:slot'])
  })

  it('diffGrants 给出新增 / 移除 / 不变', () => {
    const diff = diffGrants(['ui:slot', 'storage'], ['ui:slot', 'deck:write'])
    expect(diff.added).toEqual(['deck:write'])
    expect(diff.removed).toEqual(['storage'])
    expect(diff.unchanged).toEqual(['ui:slot'])
  })

  it('sensitiveOf 只保留 4 项敏感能力', () => {
    expect(sensitiveOf(['ui:slot', 'deck:write', 'export:hook'])).toEqual(['deck:write', 'export:hook'])
  })
})

describe('贡献 → 能力映射（02 §6.1）', () => {
  it('11 类贡献都有对应能力', () => {
    expect(Object.keys(CONTRIBUTION_CAPABILITY)).toHaveLength(11)
    expect(CONTRIBUTION_CAPABILITY.themes).toBe('theme:contribute')
    expect(CONTRIBUTION_CAPABILITY.settings).toBe('storage')
    expect(CONTRIBUTION_CAPABILITY.lintRules).toBe('lint:rule')
    expect(CONTRIBUTION_CAPABILITY.recipes).toBe('ai:recipe')
    expect(CONTRIBUTION_CAPABILITY.exportHooks).toBe('export:hook')
  })

  it('声明式 8 action 的额外能力', () => {
    expect(actionCapabilities('setTheme')).toEqual(['theme:contribute'])
    expect(actionCapabilities('applyLayoutPreset')).toEqual(['ui:layout'])
    expect(actionCapabilities('insertLibrarySvg')).toEqual(['deck:write', 'library:contribute'])
    expect(actionCapabilities('insertTextBlocks')).toEqual(['deck:write'])
    expect(actionCapabilities('openPluginPanel')).toEqual(['ui:slot'])
    expect(actionCapabilities('openSettings')).toEqual([])
    expect(actionCapabilities('runExportPreflight')).toEqual(['export:hook'])
    expect(actionCapabilities('toast')).toEqual([])
    expect(actionCapabilities('made-up')).toEqual([])
  })
})

describe('9 插槽（00 §7.3 冻结）', () => {
  it('9 个插槽 id 与允许形态', () => {
    expect(SLOT_IDS).toHaveLength(9)
    expect(SLOT_KINDS['workspace.topbar']).toEqual(['inline'])
    expect(SLOT_KINDS['workspace.dock']).toEqual(['panel'])
    expect(SLOT_KINDS['dialog']).toEqual(['modal'])
    expect(SLOT_KINDS['play.overlay']).toEqual(['overlay'])
    expect(SLOT_KINDS['command.palette']).toEqual([])
  })
})

describe('错误码契约（02 §5.5，45 码冻结）', () => {
  it('45 个错误码且映射完整（E-AUDIT-01 无提示文案）', () => {
    expect(PLUGIN_ERROR_CODES).toHaveLength(45)
    const keys = Object.keys(ERROR_MESSAGE_KEYS)
    expect(keys.sort()).toEqual([...PLUGIN_ERROR_CODES].sort())
    for (const code of PLUGIN_ERROR_CODES) {
      const key = ERROR_MESSAGE_KEYS[code]
      if (code === 'E-AUDIT-01') expect(key).toBe('')
      else expect(key.startsWith('plugin.')).toBe(true)
    }
  })

  it('错误码 → 用户可见 key 抽样（与 02 §5.5 一致）', () => {
    expect(pluginErrorMessageKey('E-PKG-02')).toBe('plugin.error.format')
    expect(pluginErrorMessageKey('E-PKG-05')).toBe('plugin.error.integrityMismatch')
    expect(pluginErrorMessageKey('E-MAN-10')).toBe('plugin.error.trust')
    expect(pluginErrorMessageKey('E-SAFE-01')).toBe('plugin.error.safeMode')
    expect(pluginErrorMessageKey('E-QUOTA-03')).toBe('plugin.warn.exportTimeout')
    expect(pluginErrorMessageKey('E-STORE-01')).toBe('plugin.warn.memoryMode')
    expect(pluginErrorMessageKey('E-AUDIT-01')).toBe('')
  })

  it('回喂白名单只含 PKG/MAN/ABI/CAP/RUN/QUOTA', () => {
    expect(FEEDBACK_ERROR_CODES.length).toBeGreaterThan(30)
    for (const code of FEEDBACK_ERROR_CODES) expect(isFeedbackErrorCode(code)).toBe(true)
    for (const code of ['E-STORE-01', 'E-HOST-01', 'E-PERM-01', 'E-NET-01', 'E-SAFE-01', 'E-AUDIT-01'] as const) {
      expect(isFeedbackErrorCode(code)).toBe(false)
    }
  })
})

describe('PluginError 与脱敏', () => {
  it('PluginError 带 code/detail，且 detail ≤200', () => {
    const error = new PluginError('E-MAN-01', 'bad manifest', 'x'.repeat(500))
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('E-MAN-01')
    expect(error.detail?.length).toBeLessThanOrEqual(200)
    expect(isPluginError(error)).toBe(true)
    expect(isPluginError(new Error('x'))).toBe(false)
  })

  it('toPluginError 把未知错误收敛成 E-HOST-01，不泄漏堆栈/路径', () => {
    const error = toPluginError(new Error('boom at C:\\secret\\path'))
    expect(error.code).toBe('E-HOST-01')
    expect(error.message).not.toContain('secret')
    expect(error.message).not.toContain('at ')
    expect(toPluginError(new PluginError('E-PKG-05', 'x')).code).toBe('E-PKG-05')
  })

  it('redact 打码 apiKey / bearer / 查询串', () => {
    expect(redact('key sk-1234567890abcdef tail')).toContain('sk-***')
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toContain('Bearer ***')
    expect(redact('https://api.example.com/v1?token=secret&x=1')).toBe('https://api.example.com/v1?***')
  })

  it('INTEGRITY_UNSUPPORTED 标记值稳定', () => {
    expect(INTEGRITY_UNSUPPORTED).toBe('integrityUnsupported')
  })
})
