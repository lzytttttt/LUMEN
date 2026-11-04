/**
 * creator-proposal.test.ts —— 提案 zod / 双向一致性 / 体积路径 / repair ≤2 / 回喂（04 §4.3 / §5.1 / §5.2 / §6.5 / §7.4）。
 *
 * 覆盖 06 §4.1：U-40-163…169（提案 161…166 + 管线 167…171 的 repair 部分）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { CreatorProposal } from '@/plugins/types'
import {
  assertValidProposal,
  capabilitiesUsedInCode,
  charLength,
  CREATOR_LIMITS,
  isPureFileName,
  normalizeCapabilities,
  proposalDigest,
  sortCreatorFiles,
  validateCreatorProposal,
} from '@/creator/proposal'
import {
  buildFeedbackText,
  canFeedbackRound,
  checkBalanced,
  isFeedbackCode,
  MAX_REPAIR_ROUNDS,
  parseCreatorProposal,
  preflightFile,
  repairProposalPrompt,
  syntaxPreflight,
} from '@/creator/repair'
import { buildWidgetTemplate } from '@/creator/templates/widget'
import { buildThemeTemplate } from '@/creator/templates/theme'

/* ------------------------------- helpers ------------------------------- */

function themeProposal(overrides: Partial<CreatorProposal> = {}): CreatorProposal {
  return { ...buildThemeTemplate(), ...overrides }
}

function expectCode(raw: unknown, code: string): void {
  const result = validateCreatorProposal(raw)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe(code)
}

function manifestOf(proposal: CreatorProposal): Record<string, unknown> {
  return JSON.parse(proposal.files.find((file) => file.path === '.lumen-plugin.json')!.content)
}

function replaceManifest(proposal: CreatorProposal, mutate: (manifest: Record<string, unknown>) => void): CreatorProposal {
  const manifest = manifestOf(proposal)
  mutate(manifest)
  return {
    ...proposal,
    files: proposal.files.map((file) =>
      file.path === '.lumen-plugin.json' ? { ...file, content: JSON.stringify(manifest, null, 2) } : file,
    ),
  }
}

/* ------------------------------- zod 正反例 ------------------------------- */

describe('CreatorProposal zod', () => {
  it('模板提案是合法正例，能力被去重排序后回填', () => {
    const result = validateCreatorProposal(themeProposal())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.proposal.title).toBe('品牌主题皮肤')
      expect(result.proposal.capabilities).toEqual(['theme:contribute', 'i18n:contribute'])
      expect(result.manifest.id).toBe('local.creator.template.skin')
    }
  })

  it('多余字段被 .strict() 拒绝', () => {
    expectCode({ ...themeProposal(), extra: 1 }, 'E-MAN-13')
  })

  it('title 长度 / 纯文件名', () => {
    expect(charLength('品牌')).toBe(2)
    expect(isPureFileName('theme.json')).toBe(true)
    expect(isPureFileName('品牌主题皮肤')).toBe(false)
    expectCode(themeProposal({ title: '皮肤' }), 'E-MAN-13')
    expectCode(themeProposal({ title: '这一行标题显然太长了'.repeat(4) }), 'E-MAN-13')
    expectCode(themeProposal({ title: 'theme.json' }), 'E-MAN-13')
  })

  it('summary 长度 / trialNote 上限', () => {
    expectCode(themeProposal({ summary: '太短' }), 'E-MAN-13')
    expectCode(themeProposal({ trialNote: '看'.repeat(81) }), 'E-MAN-13')
  })

  it('changes 数量 / surface / detail', () => {
    expectCode(themeProposal({ changes: [] }), 'E-MAN-13')
    expectCode(
      themeProposal({ changes: [{ surface: 'not-a-surface' as never, detail: 'x' }] }),
      'E-MAN-13',
    )
    expectCode(themeProposal({ changes: [{ surface: 'theme', detail: '看 https://example.com' }] }), 'E-MAN-13')
    expectCode(themeProposal({ changes: [{ surface: 'theme', detail: '带 **加粗** 的说明' }] }), 'E-MAN-13')
    expect(themeProposal({ changes: [{ surface: 'theme', detail: '圆角改为 4' }] }).changes[0].detail).toContain('圆角')
  })
})

/* ------------------------------- 体积与路径 ------------------------------- */

describe('体积 / 文件路径（E-MAN-14）', () => {
  it('缺 .lumen-plugin.json / 非法路径 / 重复路径', () => {
    const noManifest = themeProposal({ files: themeProposal().files.filter((file) => file.path !== '.lumen-plugin.json') })
    expectCode(noManifest, 'E-MAN-14')

    const illegal = themeProposal({
      files: [...themeProposal().files, { path: 'src/index.ts', content: 'x' }],
    })
    expectCode(illegal, 'E-MAN-14')

    const duplicate = themeProposal({ files: [...themeProposal().files, { path: 'icon.svg', content: '<svg/>' }, { path: 'icon.svg', content: '<svg/>' }] })
    expectCode(duplicate, 'E-MAN-14')
  })

  it('locales zh/en 必须成对', () => {
    const half = themeProposal({
      files: themeProposal().files.filter((file) => file.path !== 'locales/en.json'),
    })
    expectCode(half, 'E-MAN-14')
  })

  it('文件数 / 总体积 / 单文件体积上限', () => {
    const many = themeProposal({
      files: [
        ...themeProposal().files,
        ...Array.from({ length: 6 }, (_, index) => ({ path: `assets/a${index}.svg`, content: '<svg/>' })),
      ],
    })
    expectCode(many, 'E-MAN-14')

    const huge = Array.from({ length: 17 }, () => 'x').join('')
    expect(huge.length).toBe(17) // 占位，体积用下面真实字节
    const bigFile = themeProposal({
      files: [
        ...themeProposal().files,
        { path: 'icon.svg', content: `<svg>${'a'.repeat(CREATOR_LIMITS.fileBytes)}</svg>` },
      ],
    })
    expectCode(bigFile, 'E-MAN-14')

    const bigTotal = themeProposal({
      files: [
        ...themeProposal().files.slice(0, 1),
        { path: 'icon.svg', content: `<svg>${'a'.repeat(15 * 1024)}</svg>` },
        { path: 'assets/logo.svg', content: `<svg>${'b'.repeat(15 * 1024)}</svg>` },
      ],
    })
    expectCode(bigTotal, 'E-MAN-14')
  })

  it('能力数量自限 ≤6（E-MAN-14）', () => {
    const proposal = themeProposal()
    const manifest = manifestOf(proposal)
    const seven = ['ui:slot', 'ui:command', 'ui:keymap', 'ui:layout', 'theme:contribute', 'i18n:contribute', 'deck:read']
    manifest.capabilities = seven
    expectCode(
      {
        ...proposal,
        capabilities: seven,
        files: proposal.files.map((file) =>
          file.path === '.lumen-plugin.json' ? { ...file, content: JSON.stringify(manifest) } : file,
        ),
      },
      'E-MAN-14',
    )
  })
})

/* ----------------------------- 双向一致性 ----------------------------- */

describe('capability 双向一致性（E-MAN-13）', () => {
  it('提案能力集合必须与清单相等（缺 / 多）', () => {
    expectCode(themeProposal({ capabilities: ['theme:contribute'] }), 'E-MAN-13')
    const manifest = manifestOf(themeProposal())
    manifest.capabilities = ['theme:contribute']
    const extra = themeProposal({
      files: themeProposal().files.map((file) =>
        file.path === '.lumen-plugin.json' ? { ...file, content: JSON.stringify(manifest) } : file,
      ),
    })
    expectCode(extra, 'E-MAN-13')
  })

  it('贡献 → 能力：声明了 themes 却没有 theme:contribute', () => {
    const broken = replaceManifest(themeProposal(), (manifest) => {
      manifest.capabilities = ['i18n:contribute']
    })
    expectCode({ ...broken, capabilities: ['i18n:contribute'] }, 'E-MAN-13')
  })

  it('能力 → 代码：用了未声明的 lumen.deck.insertBlocks', () => {
    const widget = buildWidgetTemplate()
    const code = widget.files.find((file) => file.path === 'plugin.js')!.content
    const mutated: CreatorProposal = {
      ...widget,
      files: widget.files.map((file) =>
        file.path === 'plugin.js'
          ? { ...file, content: `${code}\nlumen.deck.insertBlocks('slide-1', [])\n` }
          : file,
      ),
    }
    expectCode(mutated, 'E-MAN-13')
    expect(capabilitiesUsedInCode(code)).toEqual(['ui:slot', 'deck:read'])
  })

  it('kind 与入口一致：code 缺 plugin.js / declarative 带 plugin.js', () => {
    const widget = buildWidgetTemplate()
    const declarativeWithCode = replaceManifest(
      { ...widget, kind: 'declarative' },
      (manifest) => {
        manifest.kind = 'declarative'
        delete (manifest as { entry?: unknown }).entry
        delete (manifest as { contributes?: { slots?: unknown } }).contributes?.slots
      },
    )
    expectCode(declarativeWithCode, 'E-MAN-13')

    const codeWithoutEntry = replaceManifest(buildThemeTemplate(), (manifest) => {
      manifest.kind = 'code'
      manifest.entry = 'plugin.js'
    })
    expectCode({ ...codeWithoutEntry, kind: 'code' }, 'E-MAN-13')
  })

  it('风险与能力矛盾：deck:write 却标 low', () => {
    const widget = buildWidgetTemplate()
    const lowRisk = replaceManifest({ ...widget, risk: 'low' }, (manifest) => {
      manifest.capabilities = ['ui:slot', 'deck:read', 'deck:write']
    })
    const withWrite = { ...lowRisk, capabilities: ['ui:slot', 'deck:read', 'deck:write'] as const }
    expectCode({ ...withWrite, capabilities: [...withWrite.capabilities] }, 'E-MAN-13')
  })

  it('≥3 项敏感能力必须 high', () => {
    const caps = ['theme:contribute', 'i18n:contribute', 'deck:write', 'asset:write', 'export:hook'] as const
    const proposal = replaceManifest(themeProposal({ capabilities: [...caps] }), (manifest) => {
      manifest.capabilities = [...caps]
    })
    expectCode({ ...proposal, risk: 'medium' }, 'E-MAN-13')
    const high = { ...proposal, risk: 'high' as const }
    expect(validateCreatorProposal(high).ok).toBe(true)
  })

  it('settings.declare 与 contributes.settings 同现 → E-MAN-09', () => {
    const raw: CreatorProposal = {
      title: '设置页双注册',
      summary: '代码里 declare 与清单里的声明式设置页同时出现',
      kind: 'code',
      risk: 'low',
      capabilities: ['ui:slot', 'storage'],
      files: [
        {
          path: '.lumen-plugin.json',
          content: JSON.stringify({
            id: 'local.creator.test.settings',
            name: { zh: '双注册', en: 'Double' },
            version: '0.1.0',
            apiVersion: '1.0',
            minAppVersion: '0.4.0',
            kind: 'code',
            entry: 'plugin.js',
            author: { name: 'Test' },
            description: { zh: '测试设置页双注册', en: 'Double settings test' },
            license: 'MIT',
            capabilities: ['ui:slot', 'storage'],
            contributes: {
              slots: [{ id: 'panel', slot: 'workspace.dock', title: { zh: '面板', en: 'Panel' }, kind: 'panel' }],
              settings: {
                id: 'settings',
                title: { zh: '设置', en: 'Settings' },
                fields: [{ key: 'flag', type: 'switch', label: { zh: '开关', en: 'Flag' } }],
              },
            },
          }),
        },
        {
          path: 'plugin.js',
          content: "lumen.settings.declare([{ key: 'flag', type: 'switch', label: { zh: '开关', en: 'Flag' } }])\n",
        },
      ],
      changes: [{ surface: 'settings.page', detail: '新增设置页' }],
    }
    expectCode(raw, 'E-MAN-09')
  })
})

/* ------------------------------- 工具 / 派生 ------------------------------- */

describe('归一化与派生', () => {
  it('capabilities 去重后按冻结表顺序', () => {
    expect(normalizeCapabilities(['deck:read', 'ui:slot', 'ui:slot', 'deck:read'] as never)).toEqual([
      'ui:slot',
      'deck:read',
    ])
  })

  it('proposalDigest 稳定且随内容变化（复用 packages canonical+sha256）', async () => {
    const proposal = assertValidProposal(themeProposal())
    const first = await proposalDigest(proposal)
    const second = await proposalDigest({ ...proposal })
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).toBe(second)
    const changed = await proposalDigest({ ...proposal, summary: `${proposal.summary}（改）` })
    expect(changed).not.toBe(first)
  })

  it('文件树排序：清单 → 入口 → 图标 → 语言包 → 资产', () => {
    const sorted = sortCreatorFiles([
      { path: 'assets/logo.svg' },
      { path: 'locales/zh.json' },
      { path: 'icon.svg' },
      { path: 'plugin.js' },
      { path: '.lumen-plugin.json' },
    ])
    expect(sorted.map((file) => file.path)).toEqual([
      '.lumen-plugin.json',
      'plugin.js',
      'icon.svg',
      'locales/zh.json',
      'assets/logo.svg',
    ])
  })
})

/* ------------------------------- repair 环 ------------------------------- */

describe('repair ≤2（U-40-174 / CE-40-03）', () => {
  it('合法输出 0 轮 repair（Mock 必须一次合法）', async () => {
    const text = JSON.stringify(buildThemeTemplate())
    const repair = vi.fn(async () => null)
    const result = await parseCreatorProposal(text, { repair, maxRepair: 2 })
    expect(result.ok).toBe(true)
    expect(result.repairs).toBe(0)
    expect(repair).not.toHaveBeenCalled()
  })

  it('坏 JSON → 第 1 轮 repair 成功', async () => {
    const repair = vi.fn(async () => JSON.stringify(buildThemeTemplate()))
    const result = await parseCreatorProposal('这不是 JSON', { repair, maxRepair: 2 })
    expect(result.ok).toBe(true)
    expect(result.repairs).toBe(1)
    expect(repair).toHaveBeenCalledTimes(1)
  })

  it('两轮都坏：repair 最多 2 次，返回 E-MAN-13', async () => {
    const repair = vi.fn(async () => JSON.stringify({ broken: true }))
    const result = await parseCreatorProposal('坏输出', { repair, maxRepair: MAX_REPAIR_ROUNDS })
    expect(result.ok).toBe(false)
    expect(result.repairs).toBe(2)
    expect(repair).toHaveBeenCalledTimes(2)
    if (!result.ok) expect(result.error.code).toBe('E-MAN-13')
  })

  it('repair 回调拿到的 issues 是可读的字段路径', async () => {
    const seen: string[][] = []
    const repair = async (issues: string[]) => {
      seen.push(issues)
      return null
    }
    await parseCreatorProposal('{}', { repair, maxRepair: 2 })
    expect(seen.length).toBe(1)
    expect(seen[0].length).toBeGreaterThan(0)
  })

  it('repair 提示词要求只改不合法字段、files 不变', () => {
    const prompt = repairProposalPrompt('原始需求', ['title: too short'])
    expect(prompt).toContain('files 保持不变')
    expect(prompt).toContain('title: too short')
    expect(prompt).toContain('不要 Markdown 围栏')
  })
})

/* ------------------------------- 回喂与语法预检 ------------------------------- */

describe('沙箱错误回喂（04 §7.4）', () => {
  it('白名单：E-RUN-01 可回喂，E-HOST-01 / E-STORE-02 不可', () => {
    expect(isFeedbackCode('E-RUN-01')).toBe(true)
    expect(isFeedbackCode('E-MAN-13')).toBe(true)
    expect(isFeedbackCode('E-HOST-01')).toBe(false)
    expect(isFeedbackCode('E-STORE-02')).toBe(false)
    expect(isFeedbackCode('E-PERM-02')).toBe(false)
  })

  it('回喂文本格式 + 2000 字符上限 + 脱敏', () => {
    const text = buildFeedbackText({
      code: 'E-RUN-01',
      message: `boom sk-abcdefgh12345678 ${'很长的消息'.repeat(200)}`,
      where: 'plugin.js:12',
      stack: Array.from({ length: 12 }, (_, index) => `line ${index}`),
      note: '只输出修正后的 JSON',
    })
    expect(text.startsWith('[PLUGIN_ERROR] E-RUN-01')).toBe(true)
    expect(text).toContain('where: plugin.js:12')
    expect(text).not.toContain('sk-abcdefgh')
    expect(text.length).toBeLessThanOrEqual(2000)
    expect(text.split('\n').filter((line) => line.startsWith('line '))).toHaveLength(8)
    expect(buildFeedbackText({ code: 'E-HOST-01', message: 'host' })).toBe('')
  })

  it('最多 2 轮回喂', () => {
    expect(canFeedbackRound(0)).toBe(true)
    expect(canFeedbackRound(1)).toBe(true)
    expect(canFeedbackRound(2)).toBe(false)
  })
})

describe('语法预检', () => {
  it('括号平衡检查忽略字符串/注释/模板字面量', () => {
    expect(checkBalanced('const a = { b: [1, 2] }')).toBeNull()
    expect(checkBalanced("const a = '}' // }")).toBeNull()
    expect(checkBalanced('const a = `}`')).toBeNull()
    expect(checkBalanced('const a = { b: [1, 2 }')).toContain('括号')
    expect(checkBalanced('const a = "未闭合')).toContain('字符串')
  })

  it('plugin.js 禁用 import / fetch、JSON 坏格式直接报', () => {
    expect(preflightFile('plugin.js', 'import x from "y"')[0].code).toBe('E-MAN-12')
    expect(preflightFile('plugin.js', 'fetch("/x")')[0].code).toBe('E-MAN-12')
    expect(preflightFile('plugin.js', 'lumen.ui.onRender(() => {})')).toEqual([])
    expect(preflightFile('.lumen-plugin.json', '{not json}')[0].code).toBe('E-PKG-01')
    expect(preflightFile('icon.svg', '<svg><script>alert(1)</script></svg>')[0].code).toBe('E-MAN-12')
    expect(
      syntaxPreflight([
        { path: '.lumen-plugin.json', content: '{}' },
        { path: 'icon.svg', content: '<svg onload="x()"/>' },
      ])[0].code,
    ).toBe('E-MAN-12')
  })
})
