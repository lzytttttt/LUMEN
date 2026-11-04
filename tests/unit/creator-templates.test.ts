/**
 * creator-templates.test.ts —— 3 个无模型模板起点（04 §6.6 / 06 U-40-187/188）。
 *
 * 断言重点：确定性（同参数同字节）、manifest id 固定、体积/路径/能力全是合法值、
 * 以及模板产物真的能过一次完整提案校验（不是「看起来像」）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildCreatorTemplate,
  CREATOR_TEMPLATE_ORDER,
  parseCreatorTemplate,
  TEMPLATE_LABEL_KEYS,
  TEMPLATE_MANIFEST_IDS,
} from '@/creator/templates'
import {
  CREATOR_LIMITS,
  proposalBytes,
  proposalDigest,
  validateCreatorProposal,
} from '@/creator/proposal'
import { syntaxPreflight } from '@/creator/repair'

describe('模板起点（3 个）', () => {
  it('三个模板都能构建并通过完整提案校验，manifest id 固定', () => {
    for (const templateId of CREATOR_TEMPLATE_ORDER) {
      const built = buildCreatorTemplate(templateId)
      expect(built.manifest.id).toBe(TEMPLATE_MANIFEST_IDS[templateId])
      expect(built.manifest.id.split('.')).not.toContain('lumen')
      expect(built.proposal.files[0].path).toBe('.lumen-plugin.json')
      expect(built.proposal.capabilities.length).toBeLessThanOrEqual(CREATOR_LIMITS.capabilitiesMax)

      const revalidated = validateCreatorProposal(built.proposal)
      expect(revalidated.ok).toBe(true)
      if (revalidated.ok) {
        expect(revalidated.manifest.id).toBe(TEMPLATE_MANIFEST_IDS[templateId])
        expect(revalidated.capabilities).toEqual(built.proposal.capabilities)
      }
    }
  })

  it('同参数同字节（确定性；无时间戳/随机 id）', async () => {
    for (const templateId of CREATOR_TEMPLATE_ORDER) {
      const first = buildCreatorTemplate(templateId)
      const second = buildCreatorTemplate(templateId)
      expect(JSON.stringify(first.proposal)).toBe(JSON.stringify(second.proposal))
      await expect(proposalDigest(first.proposal)).resolves.toBe(await proposalDigest(second.proposal))
    }
  })

  it('体积/文件数/语法预检全部在提案上限内', () => {
    for (const templateId of CREATOR_TEMPLATE_ORDER) {
      const { proposal } = buildCreatorTemplate(templateId)
      expect(proposal.files.length).toBeGreaterThanOrEqual(CREATOR_LIMITS.filesMin)
      expect(proposal.files.length).toBeLessThanOrEqual(CREATOR_LIMITS.filesMax)
      const bytes = proposalBytes(proposal.files)
      expect(bytes.total).toBeLessThanOrEqual(CREATOR_LIMITS.totalBytes)
      expect(bytes.perFile).toBeLessThanOrEqual(CREATOR_LIMITS.fileBytes)
      expect(syntaxPreflight(proposal.files)).toEqual([])
    }
  })

  it('主题皮肤：主题令牌 + 双语语言包，能力只有 theme/i18n', () => {
    const { proposal, manifest } = buildCreatorTemplate('theme', { accent: '#c4552a', density: 'compact' })
    expect(proposal.kind).toBe('declarative')
    expect(proposal.capabilities).toEqual(['theme:contribute', 'i18n:contribute'])
    expect(manifest.contributes.themes?.[0]?.colors.accent).toBe('#c4552a')
    expect(manifest.contributes.themes?.[0]?.radius).toBe(4)
    const paths = proposal.files.map((file) => file.path)
    expect(paths).toContain('locales/zh.json')
    expect(paths).toContain('locales/en.json')
    const zh = JSON.parse(proposal.files.find((file) => file.path === 'locales/zh.json')!.content)
    const en = JSON.parse(proposal.files.find((file) => file.path === 'locales/en.json')!.content)
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('主题皮肤：参数变化会改变产物（不是常量占位）', () => {
    const warm = buildCreatorTemplate('theme', { accent: '#c4552a' })
    const cool = buildCreatorTemplate('theme', { accent: '#1f6feb' })
    expect(JSON.stringify(warm.proposal)).not.toBe(JSON.stringify(cool.proposal))
    expect(warm.manifest.contributes.themes?.[0]?.colors.accent).not.toBe(
      cool.manifest.contributes.themes?.[0]?.colors.accent,
    )
  })

  it('插槽小组件：code kind + 最小能力（ui:slot / deck:read）', () => {
    const { proposal, manifest } = buildCreatorTemplate('widget', { slot: 'workspace.inspector.tab' })
    expect(proposal.kind).toBe('code')
    expect(proposal.capabilities).toEqual(['ui:slot', 'deck:read'])
    expect(manifest.entry).toBe('plugin.js')
    expect(manifest.contributes.slots?.[0]?.slot).toBe('workspace.inspector.tab')
    const code = proposal.files.find((file) => file.path === 'plugin.js')!.content
    expect(code).toContain('lumen.deck.subscribe')
    expect(code).toContain('lumen.ui.onRender')
    expect(code).not.toContain('lumen.deck.insertBlocks')
    expect(dataWidgetHook(code)).toBe(true)
  })

  it('插槽小组件：勾选项影响代码与文案', () => {
    const wordsOnly = buildCreatorTemplate('widget', { showReadingTime: false })
    const code = wordsOnly.proposal.files.find((file) => file.path === 'plugin.js')!.content
    expect(code).not.toContain('readingSeconds')
    expect(code).toContain('textChars')
  })

  it('命令与键位：纯声明式，命令/键位/预设三件套互相引用', () => {
    const { proposal, manifest } = buildCreatorTemplate('command', { combo: 'mod+alt+f' })
    expect(proposal.kind).toBe('declarative')
    expect(proposal.capabilities).toEqual(['ui:command', 'ui:keymap', 'ui:layout'])
    expect(manifest.contributes.commands?.[0]?.action.kind).toBe('applyLayoutPreset')
    expect(manifest.contributes.keymap?.[0]?.combo).toBe('mod+alt+f')
    expect(manifest.contributes.keymap?.[0]?.commandId).toBe(manifest.contributes.commands?.[0]?.id)
  })

  it('URL 参数映射：只有 theme/widget/command 是合法模板值', () => {
    expect(parseCreatorTemplate('theme')).toBe('theme')
    expect(parseCreatorTemplate('widget')).toBe('widget')
    expect(parseCreatorTemplate('command')).toBe('command')
    expect(parseCreatorTemplate('1')).toBeNull()
    expect(parseCreatorTemplate('skin')).toBeNull()
    expect(parseCreatorTemplate(null)).toBeNull()
  })

  it('模板文案键齐全（UI 用 creator.template.*）', () => {
    for (const templateId of CREATOR_TEMPLATE_ORDER) {
      expect(TEMPLATE_LABEL_KEYS[templateId]).toBe(`creator.template.${templateId}`)
    }
  })
})

function dataWidgetHook(code: string): boolean {
  return code.includes("'data-widget': 'word-count'")
}
