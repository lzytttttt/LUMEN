/**
 * creator-publish.test.ts —— `.lumenplug` 打包（04 §5.2 / 06 U-40-189/190）。
 *
 * 断言：清单被剥离并提升为信封 manifest、integrity = sha256(canonical(payload)) 可复算、
 * 篡改后 verifyIntegrity 抛 E-PKG-05、文件名/体积正确。canonical/sha256 全部来自
 * `@/plugins/package`（不得另写一份）。
 */
import { describe, expect, it } from 'vitest'
import { buildLumenplug, suggestFileName } from '@/creator/publish'
import { assertValidProposal } from '@/creator/proposal'
import { buildThemeTemplate } from '@/creator/templates/theme'
import { buildWidgetTemplate } from '@/creator/templates/widget'
import { canonicalJson, integrityOf, payloadOf, verifyIntegrity, bytesOf } from '@/plugins/package'
import { PluginError } from '@/plugins/errors'
import type { PluginEnvelope } from '@/plugins/types'

const THEME = assertValidProposal(buildThemeTemplate())
const WIDGET = assertValidProposal(buildWidgetTemplate())

describe('buildLumenplug', () => {
  it('剥离 .lumen-plugin.json 并提升为信封 manifest', async () => {
    const built = await buildLumenplug(THEME, { createdAt: 1_700_000_000_000 })
    expect(built.envelope.format).toBe('lumen-plugin')
    expect(built.envelope.formatVersion).toBe(1)
    expect(built.envelope.manifest.id).toBe('local.creator.template.skin')
    expect(Object.keys(built.envelope.files)).not.toContain('.lumen-plugin.json')
    expect(Object.keys(built.envelope.files).sort()).toEqual(['locales/en.json', 'locales/zh.json'])
    expect(built.bytes).toBe(bytesOf(built.json))
  })

  it('integrity 是可复算的 sha256(canonical(payload))，且 verifyIntegrity 通过', async () => {
    const built = await buildLumenplug(WIDGET)
    expect(built.envelope.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(built.envelope.integrity).toBe(await integrityOf(payloadOf(built.envelope)))
    await expect(verifyIntegrity(built.envelope)).resolves.toBeUndefined()

    // canonical JSON 键序稳定：同内容不同插入顺序 → 字节相同。
    const a = canonicalJson({ b: 1, a: 2 })
    const b = canonicalJson({ a: 2, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":2,"b":1}')
  })

  it('篡改 files 后 verifyIntegrity 抛 E-PKG-05', async () => {
    const built = await buildLumenplug(WIDGET)
    const tampered: PluginEnvelope = {
      ...built.envelope,
      files: { ...built.envelope.files, 'plugin.js': `${built.envelope.files['plugin.js']}\n// tampered\n` },
    }
    await expect(verifyIntegrity(tampered)).rejects.toMatchObject({ code: 'E-PKG-05' })
    await expect(verifyIntegrity(tampered)).rejects.toBeInstanceOf(PluginError)
  })

  it('导出物不超过插件包体积上限', async () => {
    for (const proposal of [THEME, WIDGET]) {
      const built = await buildLumenplug(proposal)
      expect(built.bytes).toBeLessThan(2_000_000)
      expect(built.json).not.toContain('.lumen-plugin.json')
      // 信封里应含完整 manifest 字段（提升成功）。
      expect(JSON.parse(built.json).manifest.kind).toBe(proposal.kind)
    }
  })

  it('文件名按 manifest id 末段 + 版本', async () => {
    const built = await buildLumenplug(THEME)
    expect(suggestFileName(built.envelope.manifest)).toBe('skin-0.1.0.lumenplug')
  })

  it('清单无法解析时抛 CreatorPublishError（不产出半成品）', async () => {
    const broken = { ...THEME, files: THEME.files.filter((file) => file.path !== '.lumen-plugin.json') }
    await expect(buildLumenplug(broken)).rejects.toMatchObject({ name: 'CreatorPublishError' })
  })
})
