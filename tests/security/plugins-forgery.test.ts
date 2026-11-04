/**
 * tests/security/plugins-forgery.test.ts —— 红队 S-40-07 / S-40-08 / S-40-09（06 §4.3、03 §7）。
 *
 * 覆盖：
 * - S-40-07 覆盖内置主题 / 冒充 trust:'builtin' / 保留命名空间 com.lumen.* / 商标 LUMEN 前缀；
 * - S-40-08 劫持快捷键与命令（裸键拒绝、跨插件 combo 冲突、命令 id 命名空间不可碰撞）；
 * - S-40-09 伪造/刷爆审计（环形 200、字段宿主生成、detail 脱敏、插件无写接口）。
 *
 * 纯逻辑层：不依赖真实 iframe（真实沙箱行为在 e2e 的 S-40-01/02/05/06 覆盖）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { parseManifest } from '@/plugins/manifest'
import {
  BUILTIN_COMMAND_IDS,
  BUILTIN_THEME_NAMESPACE,
  getRegisteredCommands,
  getRegisteredThemes,
  pluginCommandId,
  registerContributions,
  resetContributionsForTests,
  unregisterContributions,
} from '@/plugins/contributionBus'
import {
  appendAudit,
  auditFromError,
  flushAudit,
  getAuditCount,
  getAuditEntries,
  getErrorCounts,
  resetAuditForTests,
  setAuditPersistence,
} from '@/plugins/audit'
import { PluginError, isPluginError, redact } from '@/plugins/errors'
import { AUDIT_DETAIL_MAX, AUDIT_LIMIT, type PluginManifest } from '@/plugins/types'
import * as publicFacade from '@/plugins/public'

/* ------------------------------ 工具 ------------------------------ */

const MANIFEST_BASE: PluginManifest = {
  id: 'com.qatools.security',
  name: { zh: '安全夹具', en: 'Security Fixture' },
  version: '0.1.0',
  apiVersion: '1.0',
  minAppVersion: '0.4.0',
  kind: 'declarative',
  author: { name: 'QA' },
  description: { zh: '红队夹具。', en: 'Red-team fixture.' },
  license: 'MIT',
  capabilities: [],
  contributes: {},
}

function manifestOf(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return { ...MANIFEST_BASE, ...overrides }
}

const okFiles = { 'readme.md': '# x\n' }

function code(manifest: PluginManifest, files: Record<string, string> = okFiles): string {
  try {
    parseManifest(manifest, { files, installSource: 'file' })
  } catch (error) {
    expect(isPluginError(error), `期望 PluginError，实际 ${String(error)}`).toBe(true)
    return (error as PluginError).code
  }
  return 'OK'
}

const TEAL = { bg: '#0b0c10', fg: '#f2f4f8', muted: '#98a2b3', surface: '#141821', line: '#263041', accent: '#57e3c2', accent2: '#c8a15a' }

function theme(id: string) {
  return { id, name: { zh: '主题', en: 'Theme' }, colors: TEAL }
}

function owner(manifest: PluginManifest) {
  return {
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    manifest,
    trust: 'local' as const,
    capabilities: manifest.capabilities,
  }
}

beforeEach(() => {
  resetContributionsForTests()
  resetAuditForTests()
  setAuditPersistence(false)
})

/* ============================ S-40-07 ============================ */

describe('S-40-07 覆盖内置主题 / 冒充 builtin / 保留命名空间', () => {
  it('主题 id 命中 6 套内置主题 → E-MAN-09（manifest 层与注册层双重拦截）', () => {
    for (const id of BUILTIN_THEME_NAMESPACE) {
      const manifest = manifestOf({ capabilities: ['theme:contribute'], contributes: { themes: [theme(id)] } })
      expect(code(manifest), `内置主题 ${id} 不应可被插件声明`).toBe('E-MAN-09')
    }
  })

  it('运行时二层：插件主题注册后只以 `<pluginId>/<slug>` 出现，内置主题命名空间不被写入', () => {
    const manifest = parseManifest(
      manifestOf({ capabilities: ['theme:contribute'], contributes: { themes: [theme('brand-blue')] } }),
      { files: okFiles, installSource: 'file' },
    )
    registerContributions(owner(manifest), manifest)
    const registered = getRegisteredThemes().map((row) => row.theme.id)
    expect(registered).toEqual([`${manifest.id}/brand-blue`])
    for (const builtin of BUILTIN_THEME_NAMESPACE) {
      expect(registered, `内置主题 ${builtin} 不应出现在插件注册表`).not.toContain(builtin)
    }
  })

  it('文件安装伪造 trust:"builtin" → 剥离 + 告警（E-MAN-10），不静默放行', () => {
    const warnings: string[] = []
    const manifest = parseManifest(manifestOf({ trust: 'builtin' }), {
      files: okFiles,
      installSource: 'file',
      onWarning: (warningCode, detail) => warnings.push(`${warningCode}:${detail}`),
    })
    expect(manifest.trust).toBeUndefined()
    expect(warnings.some((warning) => warning.startsWith('E-MAN-10'))).toBe(true)
  })

  it('com.lumen.* 保留命名空间：第三方拒绝（E-MAN-02），builtin 来源放行', () => {
    expect(code(manifestOf({ id: 'com.lumen.evil' }))).toBe('E-MAN-02')
    const builtin = parseManifest(manifestOf({ id: 'com.lumen.samples.security', trust: 'builtin' }), {
      files: okFiles,
      installSource: 'builtin',
    })
    expect(builtin.trust).toBe('builtin')
  })

  it('显示名以 LUMEN / 幕光 开头：第三方 E-MAN-01，builtin 放行（TRADEMARK 边界）', () => {
    expect(code(manifestOf({ name: { zh: 'LUMEN 官方', en: 'Fixture' } }))).toBe('E-MAN-01')
    expect(code(manifestOf({ name: { zh: '幕光助手', en: 'Fixture' } }))).toBe('E-MAN-01')
    expect(
      parseManifest(manifestOf({ id: 'com.lumen.samples.brand', trust: 'builtin', name: { zh: 'LUMEN 样例', en: 'LUMEN sample' } }), {
        files: okFiles,
        installSource: 'builtin',
      }).trust,
    ).toBe('builtin')
  })
})

/* ============================ S-40-08 ============================ */

describe('S-40-08 劫持快捷键 / 命令来源', () => {
  it('裸键（无修饰键）与非法 combo → E-MAN-09，不静默绑定', () => {
    for (const combo of ['z', '1', 'escape', 'shift+', 'ctrl+ctrl']) {
      const manifest = manifestOf({
        capabilities: ['ui:keymap', 'ui:command'],
        contributes: {
          commands: [{ id: 'hi', title: { zh: '嗨', en: 'Hi' }, category: 'plugin', action: { kind: 'openSettings' } }],
          keymap: [{ combo, commandId: 'hi' }],
        },
      })
      expect(code(manifest), `combo ${combo} 应被拒绝`).toBe('E-MAN-09')
    }
  })

  it('跨插件占用同一组合键 → E-MAN-09，且第二个插件不留下部分注册（原子性）', () => {
    const first = parseManifest(
      manifestOf({
        id: 'com.qatools.first',
        capabilities: ['ui:keymap', 'ui:command', 'theme:contribute'],
        contributes: {
          themes: [theme('first')],
          commands: [{ id: 'hi', title: { zh: '嗨', en: 'Hi' }, category: 'plugin', action: { kind: 'openSettings' } }],
          keymap: [{ combo: 'mod+shift+k', commandId: 'hi' }],
        },
      }),
      { files: okFiles, installSource: 'file' },
    )
    registerContributions(owner(first), first)
    expect(getRegisteredThemes()).toHaveLength(1)

    const second = parseManifest(
      manifestOf({
        id: 'com.qatools.second',
        capabilities: ['ui:keymap', 'ui:command', 'theme:contribute'],
        contributes: {
          themes: [theme('second')],
          commands: [{ id: 'hi', title: { zh: '嗨', en: 'Hi' }, category: 'plugin', action: { kind: 'openSettings' } }],
          keymap: [{ combo: 'mod+shift+k', commandId: 'hi' }],
        },
      }),
      { files: okFiles, installSource: 'file' },
    )
    expect(() => registerContributions(owner(second), second)).toThrowError(PluginError)
    // 原子性：第二个插件的主题不能被半注册
    expect(getRegisteredThemes().map((row) => row.theme.id)).toEqual(['com.qatools.first/first'])
  })

  it('插件命令 id 恒带 `plugin.<pluginId>.` 前缀，不可能与 29 个内置命令 id 相撞', () => {
    const manifest = parseManifest(
      manifestOf({
        capabilities: ['ui:command'],
        contributes: {
          commands: [
            { id: 'deck-export', title: { zh: '导出', en: 'Export' }, category: 'plugin', action: { kind: 'openSettings' } },
            { id: 'zz', title: { zh: 'Z', en: 'Z' }, category: 'plugin', action: { kind: 'toast', message: { zh: 'z', en: 'z' } } },
          ],
        },
      }),
      { files: okFiles, installSource: 'file' },
    )
    registerContributions(owner(manifest), manifest)
    for (const row of getRegisteredCommands()) {
      expect(row.hostId.startsWith(`plugin.${manifest.id}.`), row.hostId).toBe(true)
      expect(BUILTIN_COMMAND_IDS as readonly string[], `命令 ${row.hostId} 不应占用内置 id`).not.toContain(row.hostId)
    }
    // 文档级：内置命令 id 命名空间不受插件影响
    expect(pluginCommandId(manifest.id, 'deck-export')).toBe(`plugin.${manifest.id}.deck-export`)
  })

  // 03 §7 S-40-08：未授权 action 安装即 E-MAN-08。plugin-core 2026-11-04 已在 manifest 增加
  // 「action 所需能力必须在 capabilities 声明」校验 + declarative commands 能力闸门，故改为正向断言。
  it('声明式 action 未声明所需能力（insertTextBlocks 缺 deck:write）→ 安装期 E-MAN-08', () => {
    const result = code(
      manifestOf({
        capabilities: ['ui:command'],
        contributes: {
          commands: [
            {
              id: 'inject',
              title: { zh: '注入', en: 'Inject' },
              category: 'plugin',
              action: { kind: 'insertTextBlocks', blocks: [{ text: 'x' }] },
            },
          ],
        },
      }),
    )
    expect(result).toBe('E-MAN-08')
  })
})

/* ============================ S-40-09 ============================ */

describe('S-40-09 伪造 / 刷爆审计', () => {
  it('审计环固定 200 条（超量丢最旧），seq 单调宿主生成', () => {
    for (let i = 0; i < AUDIT_LIMIT + 50; i += 1) {
      appendAudit({ action: 'plugin.error', actor: 'system', result: 'error', pluginId: 'com.qatools.x' })
    }
    const entries = getAuditEntries()
    expect(getAuditCount()).toBe(AUDIT_LIMIT)
    expect(entries).toHaveLength(AUDIT_LIMIT)
    expect(entries[entries.length - 1].seq).toBeGreaterThan(entries[0].seq)
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i].seq, 'seq 必须单调递增').toBeGreaterThan(entries[i - 1].seq)
    }
  })

  it('插件无法伪造 seq/detail：seq 宿主自增、detail 截断并脱敏', () => {
    const forged = {
      action: 'plugin.error',
      actor: 'plugin' as const,
      result: 'error' as const,
      pluginId: 'com.qatools.x',
      seq: 999_999,
      detail: `sk-abcdefgh12345678 Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig https://evil.example/x?token=secret ${'D'.repeat(300)}`,
    }
    const entry = appendAudit(forged as never)
    expect(entry.seq, 'seq 必须是宿主自增，不是传入值').not.toBe(999_999)
    expect(entry.detail!.length).toBeLessThanOrEqual(AUDIT_DETAIL_MAX)
    expect(entry.detail).not.toContain('sk-abcdefgh12345678')
    expect(entry.detail).not.toContain('secret')
    expect(entry.detail).toContain('sk-***')
  })

  it('页面侧拿不到审计写接口：public 门面不导出 appendAudit / flushAudit / loadAudit', () => {
    const exported = Object.keys(publicFacade)
    for (const forbidden of ['appendAudit', 'flushAudit', 'loadAudit', 'getAuditEntries', 'resetAuditForTests']) {
      expect(exported, `public 门面不应导出 ${forbidden}`).not.toContain(forbidden)
    }
    // 只读 hook 允许
    expect(exported).toContain('useAuditLog')
  })

  it('返回的是副本：UI 改动返回值不会污染审计环', () => {
    appendAudit({ action: 'plugin.install', actor: 'user', result: 'ok', pluginId: 'com.qatools.x', detail: 'v0.1.0' })
    const snapshot = getAuditEntries()
    snapshot[0].detail = 'tampered'
    snapshot.push({ seq: -1, at: 0, action: 'fake', actor: 'plugin', result: 'ok' })
    const fresh = getAuditEntries()
    expect(fresh).toHaveLength(1)
    expect(fresh[0].detail).toBe('v0.1.0')
  })

  it('错误按 code 聚合计数（诊断 errorCounts），不按条数刷屏', () => {
    for (const code of ['E-RUN-01', 'E-RUN-01', 'E-CAP-01']) {
      appendAudit({ action: 'plugin.error', actor: 'system', result: 'error', pluginId: 'com.qatools.x', code: code as never })
    }
    expect(getErrorCounts()).toEqual({ 'E-CAP-01': 1, 'E-RUN-01': 2 })
  })

  it('auditFromError：PluginError 保码，未知错误收敛 E-HOST-01 且脱敏', () => {
    const known = auditFromError(new PluginError('E-CAP-01', 'denied'))
    expect(known.code).toBe('E-CAP-01')
    const unknown = auditFromError(new Error('boom Bearer abcdefgh.ijklmnop https://x.test/?key=secret'))
    expect(unknown.code).toBe('E-HOST-01')
    expect(unknown.detail).not.toContain('secret')
  })

  it('安全模式：审计持久化关闭（只留内存环）', async () => {
    setAuditPersistence(false)
    appendAudit({ action: 'plugin.safe-mode-on', actor: 'system', result: 'ok', detail: 'source:url' })
    await flushAudit()
    expect(getAuditCount()).toBe(1)
  })

  it('redact()：sk- / Bearer / URL query 统一脱敏（S-40-04 的共用防线）', () => {
    const text = redact('key=sk-abcdefgh12345678 Authorization: Bearer abcdefgh.ijklmnop https://api.test/v1?api_key=abc&x=1')
    expect(text).toContain('sk-***')
    expect(text).toContain('Bearer ***')
    // URL 查询串整段归一为 ?***（先于 api_key=*** 规则命中）
    expect(text).toContain('?***')
    expect(text).not.toContain('abcdefgh12345678')
    expect(text).not.toContain('api_key=abc')
  })
})

/* ============================ 卸载后的贡献残留 ============================ */

describe('S-40-10（纯逻辑半边）反注册清理', () => {
  it('unregisterContributions 清空该插件的全部贡献，其他插件不受影响', () => {
    const first = parseManifest(
      manifestOf({
        id: 'com.qatools.cleanup-a',
        capabilities: ['ui:command', 'theme:contribute', 'i18n:contribute', 'storage'],
        contributes: {
          themes: [theme('alpha')],
          commands: [{ id: 'hi', title: { zh: '嗨', en: 'Hi' }, category: 'plugin', action: { kind: 'openSettings' } }],
          i18n: [{ zh: { k: '值' }, en: { k: 'V' } }],
          settings: { id: 'prefs', title: { zh: '偏好', en: 'Prefs' }, fields: [{ key: 'x', type: 'switch', label: { zh: '开', en: 'On' } }] },
        },
      }),
      { files: okFiles, installSource: 'file' },
    )
    registerContributions(owner(first), first)
    expect(getRegisteredThemes()).toHaveLength(1)
    expect(getRegisteredCommands()).toHaveLength(1)

    unregisterContributions(first.id)
    expect(getRegisteredThemes()).toHaveLength(0)
    expect(getRegisteredCommands()).toHaveLength(0)
  })
})
