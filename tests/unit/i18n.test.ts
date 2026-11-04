import { describe, expect, it } from 'vitest'
import { dictionaryOf, allMessageKeys, translate } from '@/i18n'
import { commonZh } from '@/i18n/messages/common.zh'
import { commonEn } from '@/i18n/messages/common.en'
import { editorZh } from '@/i18n/messages/editor.zh'
import { editorEn } from '@/i18n/messages/editor.en'
import { aiZh } from '@/i18n/messages/ai.zh'
import { aiEn } from '@/i18n/messages/ai.en'
import { playZh } from '@/i18n/messages/play.zh'
import { playEn } from '@/i18n/messages/play.en'
import { exportZh } from '@/i18n/messages/export.zh'
import { exportEn } from '@/i18n/messages/export.en'
import { studioZh } from '@/i18n/messages/studio.zh'
import { studioEn } from '@/i18n/messages/studio.en'
import { forgeZh } from '@/i18n/messages/forge.zh'
import { forgeEn } from '@/i18n/messages/forge.en'
import { portalZh } from '@/i18n/messages/portal.zh'
import { portalEn } from '@/i18n/messages/portal.en'
import { onboardZh } from '@/i18n/messages/onboard.zh'
import { onboardEn } from '@/i18n/messages/onboard.en'
import { pluginZh } from '@/i18n/messages/plugin.zh'
import { pluginEn } from '@/i18n/messages/plugin.en'
import { creatorZh } from '@/i18n/messages/creator.zh'
import { creatorEn } from '@/i18n/messages/creator.en'
import { pluginspageZh } from '@/i18n/messages/pluginspage.zh'
import { pluginspageEn } from '@/i18n/messages/pluginspage.en'

const pairs: [string, object, object][] = [
  ['common', commonZh, commonEn],
  ['editor', editorZh, editorEn],
  ['ai', aiZh, aiEn],
  ['play', playZh, playEn],
  ['export', exportZh, exportEn],
  ['studio', studioZh, studioEn],
  ['forge', forgeZh, forgeEn],
  ['portal', portalZh, portalEn],
  ['onboard', onboardZh, onboardEn],
  ['plugin', pluginZh, pluginEn],
  ['creator', creatorZh, creatorEn],
  ['pluginspage', pluginspageZh, pluginspageEn],
]

function flatten(node: unknown, prefix = '', out: Record<string, string> = {}) {
  if (typeof node === 'string') {
    out[prefix] = node
    return out
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      flatten(value, prefix === '' ? key : `${prefix}.${key}`, out)
    }
  }
  return out
}

describe('i18n', () => {
  it('has identical key sets in zh and en for every namespace', () => {
    for (const [name, zh, en] of pairs) {
      const zhKeys = Object.keys(flatten(zh)).sort()
      const enKeys = Object.keys(flatten(en)).sort()
      expect(enKeys, `namespace ${name}`).toEqual(zhKeys)
    }
  })

  it('has no empty strings', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const [key, value] of Object.entries(dictionaryOf(lang))) {
        expect(value.trim().length, `${lang}:${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('exposes a flat dictionary with namespaced keys', () => {
    const keys = allMessageKeys()
    expect(keys).toContain('common.app.name')
    expect(keys).toContain('editor.topbar.exportDeck')
    expect(keys.length).toBeGreaterThan(150)
  })

  it('interpolates and falls back to zh', () => {
    expect(translate('zh', 'common.label.slideCount', { count: 3 })).toContain('3')
    expect(translate('en', 'common.label.slideCount', { count: 3 })).toContain('3')
    expect(translate('en', 'editor.no.such.key')).toBe('editor.no.such.key')
  })
})
