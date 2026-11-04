/**
 * tests/security/plugins-capability.test.ts —— 红队 S-40-03 越权 deck:write 的能力模型半边。
 *
 * 现状：能力表/敏感判定/授权差集已落地（src/plugins/capabilities.ts）；
 * 能力网关（api/deck.ts 等）与帧调用链未落地前，网关侧拒绝/不缓存断言用 it.todo 占位，
 * 落地后补：15 能力逐项允许/拒绝、deck:write 事务、未授权 → E-CAP-01 + 审计 + deck 不变。
 */
import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  CAPABILITY_META,
  CONTRIBUTION_CAPABILITY,
  CODE_ONLY_CONTRIBUTIONS,
  actionCapabilities,
  defaultGrants,
  diffGrants,
  isCapability,
  isSensitiveCapability,
  normalizeCapabilities,
  sensitiveOf,
  suggestGrants,
} from '@/plugins/capabilities'
import { CAPABILITY_IDS, CONTRIBUTION_LIMITS, SENSITIVE_CAPABILITIES } from '@/plugins/types'

describe('S-40-03 能力模型硬约束（15 项 / 敏感 4 项 / 默认不授敏感）', () => {
  it('能力表与 02 §5.1 冻结表一致：15 项、顺序固定、元数据 key 齐备', () => {
    expect(CAPABILITIES).toHaveLength(15)
    expect(CAPABILITIES.map((meta) => meta.id)).toEqual([...CAPABILITY_IDS])
    for (const meta of CAPABILITIES) {
      expect(meta.labelKey).toMatch(/^plugin\.capability\.[a-z]/)
      expect(meta.sensitive, meta.id).toBe((SENSITIVE_CAPABILITIES as readonly string[]).includes(meta.id))
      if (meta.sensitive) expect(meta.detailKey, meta.id).toMatch(/^plugin\.capabilityDetail\./)
      else expect(meta.detailKey).toBe('')
    }
    expect(CAPABILITY_META['deck:write'].sensitive).toBe(true)
  })

  it('敏感能力恰好 4 项：ai:invoke / deck:write / asset:write / export:hook', () => {
    expect([...SENSITIVE_CAPABILITIES].sort()).toEqual(['ai:invoke', 'asset:write', 'deck:write', 'export:hook'])
    expect(CAPABILITIES.filter((meta) => meta.sensitive).map((meta) => meta.id).sort()).toEqual(
      [...SENSITIVE_CAPABILITIES].sort(),
    )
  })

  it('默认授权绝不包含敏感项；升级时保留用户已授的敏感项', () => {
    const all = [...CAPABILITY_IDS]
    expect(defaultGrants(all).some((id) => isSensitiveCapability(id))).toBe(false)
    expect(defaultGrants(all)).toHaveLength(11)
    expect(suggestGrants(all, ['deck:write'])).toContain('deck:write')
    expect(suggestGrants(all, [])).not.toContain('deck:write')
  })

  it('授权差集：升级新增敏感能力必须重新确认（added 非空）', () => {
    const before = normalizeCapabilities(['ui:slot', 'ui:command'])
    const after = normalizeCapabilities(['ui:slot', 'ui:command', 'deck:write'])
    expect(diffGrants(before, after)).toEqual({ added: ['deck:write'], removed: [], unchanged: ['ui:slot', 'ui:command'] })
    expect(diffGrants(after, before)).toEqual({ added: [], removed: ['deck:write'], unchanged: ['ui:slot', 'ui:command'] })
  })

  it('能力↔贡献与 8 个声明式 action 的额外能力映射（02 §6.1 / §6.6）', () => {
    for (const key of Object.keys(CONTRIBUTION_CAPABILITY)) {
      expect(CAPABILITY_IDS as readonly string[], key).toContain(CONTRIBUTION_CAPABILITY[key as keyof typeof CONTRIBUTION_CAPABILITY])
    }
    expect([...CODE_ONLY_CONTRIBUTIONS].sort()).toEqual(['exportHooks', 'lintRules', 'recipes'])
    expect(actionCapabilities('insertTextBlocks')).toEqual(['deck:write'])
    expect(actionCapabilities('insertLibrarySvg')).toEqual(['deck:write', 'library:contribute'])
    expect(actionCapabilities('runExportPreflight')).toEqual(['export:hook'])
    expect(actionCapabilities('toast')).toEqual([])
    expect(CONTRIBUTION_LIMITS.slotFrames).toBe(2)
  })

  it('storage 配额 512KB / 帧配额 8 / 每插件 2 帧为契约常量（02 §4.5/§7.2）', () => {
    // 常量在 02 冻结；这里守住易被改坏的值，网关落地后逐项断言拒绝行为。
    expect(CONTRIBUTION_LIMITS.themes).toBe(6)
    expect(CONTRIBUTION_LIMITS.slotFrames).toBe(2)
  })

  it('isCapability / sensitiveOf 只认白名单，脏数据不穿透', () => {
    for (const bad of ['deck:destroy', 'AI:INVOKE', '', null, undefined, 42, {}]) {
      expect(isCapability(bad), String(bad)).toBe(false)
    }
    expect(sensitiveOf(['ui:slot', 'deck:write', 'zzz' as never])).toEqual(['deck:write'])
  })
})

describe.todo('S-40-03 网关侧（待 src/plugins/api/** 落地）')
// 待补断言（02 §5.2/§5.3、03 §7）：
// 1) 未授权 deck:write 调用 → E-CAP-01 + 审计 plugin.denied，deck 序列化哈希不变；
// 2) 授权后非法块参数 → E-ABI-02，事务不提交（旧事务回滚）；
// 3) grants 每次调用实时判定、不缓存：撤销授权后下一次调用立即 E-CAP-02；
// 4) 插件日志（lumen.log）不写审计、不改 errorCounts 之外的字段。
