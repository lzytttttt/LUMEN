/**
 * U-40-136…155：注册表状态机、DB v4 读写、安装管线、隔离、卸载清理、诊断与安全模式（02 §3/§7）。
 * 最小垂直切片：声明式主题包 prepareInstall → commitInstall → enable → 主题出现 → disable 消失。
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { webcrypto } from 'node:crypto'
import { buildEnvelope, canonicalJson } from '@/plugins/package'
import { PluginError } from '@/plugins/errors'
import {
  commitInstall,
  disablePlugin,
  enablePlugin,
  getEnabledIds,
  getGrants,
  getPluginDiagnostics,
  getRecord,
  hasGrant,
  listRecords,
  listSummaries,
  loadRegistry,
  makeRecordFromFiles,
  prepareInstall,
  quarantinePlugin,
  recordBootFailure,
  recordBootSuccess,
  resetRegistryForTests,
  resetWorkbench,
  retryPlugin,
  revokeCapability,
  seedRecordForTests,
  uninstallPlugin,
} from '@/plugins/registry'
import {
  getRegisteredThemes,
  applyDeclarativeContributions,
  getMergedThemes,
  resetContributionStateForTests,
} from '@/plugins/declarative'
import { DEFAULT_PLUGINS, useSettingsStore } from '@/state/settingsStore'
import { kvDel, kvKeys } from '@/persistence/kv'
import { useDeckStore } from '@/state/deckStore'
import { emptyDeck } from '@/schema/factory'
import type { PluginManifest } from '@/plugins/types'
import {
  getDraftFrameSource,
  getDraftTrial,
  isDraftTrial,
  listDraftTrials,
  onDraftDeckWrite,
  parseDraftPluginId,
  resetDraftTrialsForTests,
  runDraftTransaction,
  startDraftTrial,
  stopDraftTrial,
  updateDraftGrants,
} from '@/plugins/draft'
import type { PluginDraft } from '@/plugins/types'

beforeAll(() => {
  const current = globalThis.crypto as Crypto | undefined
  if (!current || !current.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
})

async function clearStores(): Promise<void> {
  for (const store of ['plugins', 'pluginData', 'creator'] as const) {
    for (const key of await kvKeys(store)) await kvDel(store, key)
  }
}

beforeEach(async () => {
  resetRegistryForTests()
  resetContributionStateForTests()
  await clearStores()
  useSettingsStore.getState().patchPlugins(JSON.parse(JSON.stringify(DEFAULT_PLUGINS)) as typeof DEFAULT_PLUGINS)
  useDeckStore.getState().setDeck(emptyDeck('测试演示'))
  if (typeof document !== 'undefined') delete document.documentElement.dataset.lumenPlugins
})

const THEME_MANIFEST: PluginManifest = {
  id: 'com.example.theme-pack',
  name: { zh: '主题包', en: 'Theme Pack' },
  version: '1.0.0',
  apiVersion: '1.0',
  minAppVersion: '0.4.0',
  kind: 'declarative',
  author: { name: 'Example' },
  description: { zh: '一个声明式主题包', en: 'A declarative theme package' },
  license: 'MIT',
  capabilities: ['theme:contribute', 'ui:command'],
  contributes: {
    themes: [
      {
        id: 'sepia',
        name: { zh: '棕褐', en: 'Sepia' },
        colors: {
          bg: '#201a12',
          fg: '#f3e9d2',
          muted: '#a99a7c',
          surface: '#2c241a',
          line: '#4a3d2c',
          accent: '#d8a657',
          accent2: '#7fa7a0',
        },
      },
    ],
    commands: [
      {
        id: 'apply',
        title: { zh: '应用', en: 'Apply' },
        category: 'plugin',
        action: { kind: 'setTheme', themeId: 'sepia' },
      },
    ],
  },
}

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="currentColor"/></svg>'

async function envelopeText(manifest: PluginManifest = THEME_MANIFEST, files: Record<string, string> = { 'icon.svg': ICON }): Promise<string> {
  const envelope = await buildEnvelope({ manifest: { ...manifest, icon: 'icon.svg' }, files, createdAt: 1_700_000_000_000 })
  return canonicalJson(envelope)
}

async function installDefault(options: { enable?: boolean } = {}) {
  const preview = await prepareInstall({ text: await envelopeText() })
  const outcome = await commitInstall(preview, { grants: preview.suggestedGrants, ...options })
  return { preview, outcome }
}

async function expectError(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation()
  } catch (error) {
    expect(error).toBeInstanceOf(PluginError)
    expect((error as PluginError).code, (error as Error).message).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

describe('最小垂直切片：声明式主题包 install → enable → disable', () => {
  it('prepareInstall 产出权限卡数据（能力/敏感/新增）', async () => {
    const preview = await prepareInstall({ text: await envelopeText() })
    expect(preview.manifest.id).toBe('com.example.theme-pack')
    expect(preview.trust).toBe('local')
    expect(preview.installSource).toBe('file')
    expect(preview.suggestedGrants).toEqual(['ui:command', 'theme:contribute'])
    expect(preview.sensitive).toEqual([])
    expect(preview.addedCapabilities).toEqual(['ui:command', 'theme:contribute'])
    expect(preview.bytes).toBeGreaterThan(0)
    expect(preview.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('commitInstall → enabled，主题/命令出现在注册表，data-lumen-plugins=1', async () => {
    const { outcome } = await installDefault()
    expect(outcome.enabled).toBe(true)
    expect(outcome.record.state).toBe('enabled')
    expect(getEnabledIds()).toEqual(['com.example.theme-pack'])
    expect(getRegisteredThemes().map((entry) => entry.theme.id)).toEqual(['com.example.theme-pack/sepia'])
    expect(getMergedThemes().length).toBe(7)
    expect(document.documentElement.dataset.lumenPlugins).toBe('1')
    expect(listSummaries()[0].counts.themes).toBe(1)
  })

  it('disable → 主题消失、启用集归零；再 enable → 主题回来', async () => {
    await installDefault()
    await disablePlugin('com.example.theme-pack')
    expect(getEnabledIds()).toEqual([])
    expect(getRegisteredThemes()).toEqual([])
    expect(getMergedThemes().length).toBe(6)
    expect(document.documentElement.dataset.lumenPlugins).toBe('0')
    await enablePlugin('com.example.theme-pack')
    expect(getEnabledIds()).toEqual(['com.example.theme-pack'])
    expect(getRegisteredThemes()).toHaveLength(1)
  })

  it('uninstall → 记录删除 + 贡献摘除', async () => {
    await installDefault()
    await uninstallPlugin('com.example.theme-pack')
    expect(getRecord('com.example.theme-pack')).toBeUndefined()
    expect(getRegisteredThemes()).toEqual([])
    expect(getEnabledIds()).toEqual([])
  })

  it('loadRegistry 在重启后恢复 enabled 记录的声明式贡献（02 §3.3）', async () => {
    await installDefault()
    // 模拟重启：只清内存，不清 IDB（测试里 kvSet 落内存桶）
    resetRegistryForTests()
    resetContributionStateForTests()
    await loadRegistry()
    expect(listRecords()).toHaveLength(1)
    expect(getRegisteredThemes()).toHaveLength(1)
  })
})

describe('内置样例三款的配方命名空间（回归：同一插件多条配方共享 namespace）', () => {
  it('同一插件多条 recipe 共享 namespace 合法；跨插件同 namespace 冲突', async () => {
    const codeManifest: PluginManifest = {
      ...THEME_MANIFEST,
      id: 'com.example.chart',
      kind: 'code',
      entry: 'plugin.js',
      capabilities: ['ai:recipe'],
      contributes: {
        recipes: [
          { id: 'bar', namespace: 'chartkit', title: { zh: '柱', en: 'Bar' }, slots: [{ key: 'headline' }] },
          { id: 'donut', namespace: 'chartkit', title: { zh: '环', en: 'Donut' }, slots: [{ key: 'headline' }] },
          { id: 'line', namespace: 'chartkit', title: { zh: '线', en: 'Line' }, slots: [{ key: 'headline' }] },
        ],
      },
    }
    const record = await makeRecordFromFiles(codeManifest, { 'plugin.js': 'const x = 1\n' }, {
      state: 'enabled',
      grants: codeManifest.capabilities,
    })
    applyDeclarativeContributions(record)
    const { getRegisteredRecipes } = await import('@/plugins/contributionBus')
    expect(getRegisteredRecipes().map((entry) => entry.recipeId)).toEqual([
      'chartkit/bar',
      'chartkit/donut',
      'chartkit/line',
    ])
    const other = { ...codeManifest, id: 'com.example.chart2' }
    const otherRecord = await makeRecordFromFiles(other, { 'plugin.js': 'const y = 1\n' }, {
      state: 'enabled',
      grants: other.capabilities,
    })
    try {
      applyDeclarativeContributions(otherRecord)
    } catch (error) {
      expect((error as PluginError).code).toBe('E-MAN-09')
      return
    }
    throw new Error('expected E-MAN-09')
  })
})

describe('安装管线错误码', () => {
  it('integrity 被篡改 → E-PKG-05', async () => {
    const text = await envelopeText()
    const tampered = text.replace('"version":"1.0.0"', '"version":"1.0.1"')
    await expectError(() => prepareInstall({ text: tampered }), 'E-PKG-05')
  })

  it('manifest 非法 → E-MAN-*；坏 JSON → E-PKG-01', async () => {
    await expectError(() => prepareInstall({ text: '{' }), 'E-PKG-01')
    const bad = { ...THEME_MANIFEST, version: '1.0' } as unknown as PluginManifest
    const envelope = await buildEnvelope({ manifest: bad, files: { 'icon.svg': ICON }, createdAt: 1_700_000_000_000 })
    await expectError(() => prepareInstall({ text: canonicalJson(envelope) }), 'E-MAN-03')
  })

  it('授权超出清单申请 → E-PERM-02', async () => {
    const preview = await prepareInstall({ text: await envelopeText() })
    await expectError(() => commitInstall(preview, { grants: ['deck:write'] }), 'E-PERM-02')
  })

  it('同版本重装 → 告警 plugin.warn.alreadyInstalled；低版本 → downgrade', async () => {
    await installDefault()
    const again = await prepareInstall({ text: await envelopeText() })
    expect(again.warnings).toContain('plugin.warn.alreadyInstalled')
    const lowerManifest = { ...THEME_MANIFEST, version: '0.9.0' }
    const lower = await prepareInstall({ text: await envelopeText(lowerManifest) })
    expect(lower.warnings).toContain('plugin.warn.downgrade')
    expect(lower.removedCapabilities).toEqual([])
  })

  it('记录字段只来自宿主白名单（state/enabled 正确）', async () => {
    const preview = await prepareInstall({ text: await envelopeText() })
    const outcome = await commitInstall(preview, { grants: preview.suggestedGrants })
    expect(outcome.record.state).toBe('enabled')
    expect(outcome.record.grants).toEqual(['ui:command', 'theme:contribute'])
  })
})

describe('启用时的完整性重算（02 §2.4 ②）', () => {
  it('IDB 记录被手改 → 启用失败 + quarantined', async () => {
    const record = await makeRecordFromFiles(THEME_MANIFEST, { 'icon.svg': ICON }, { state: 'disabled' })
    record.files = { 'icon.svg': ICON, 'extra.txt': 'tampered' }
    seedRecordForTests(record)
    await expectError(() => enablePlugin(THEME_MANIFEST.id), 'E-PKG-05')
    expect(getRecord(THEME_MANIFEST.id)?.state).toBe('quarantined')
  })
})

describe('隔离（02 §3.5）', () => {
  it('连续 3 次启动失败 → quarantined；retry 清零并重新启用', async () => {
    await installDefault()
    const first = await recordBootFailure(THEME_MANIFEST.id, 'E-RUN-02', 'boot timeout')
    expect(first).toEqual({ failureCount: 1, quarantined: false })
    await recordBootFailure(THEME_MANIFEST.id, 'E-RUN-02')
    const third = await recordBootFailure(THEME_MANIFEST.id, 'E-RUN-02')
    expect(third.quarantined).toBe(true)
    expect(getRecord(THEME_MANIFEST.id)?.state).toBe('quarantined')
    expect(getEnabledIds()).toEqual([])
    await retryPlugin(THEME_MANIFEST.id)
    expect(getRecord(THEME_MANIFEST.id)?.state).toBe('enabled')
    expect(getRecord(THEME_MANIFEST.id)?.failureCount).toBe(0)
  })

  it('recordBootSuccess 清零连续失败计数', async () => {
    await installDefault()
    await recordBootFailure(THEME_MANIFEST.id, 'E-RUN-02')
    await recordBootSuccess(THEME_MANIFEST.id)
    expect(getRecord(THEME_MANIFEST.id)?.failureCount).toBe(0)
    expect(getRecord(THEME_MANIFEST.id)?.lastError).toBeNull()
  })

  it('手动隔离 → 停用 + 审计 plugin.quarantine', async () => {
    await installDefault()
    await quarantinePlugin(THEME_MANIFEST.id, 'E-HOST-03', 'heartbeat lost')
    const record = getRecord(THEME_MANIFEST.id)
    expect(record?.state).toBe('quarantined')
    expect(record?.lastError?.code).toBe('E-HOST-03')
  })
})

describe('授权回收（03 §3.5）', () => {
  it('revoke 后 grants 移除、denied 增加，运行中自动停用', async () => {
    await installDefault()
    await revokeCapability(THEME_MANIFEST.id, 'deck:write')
    const record = getRecord(THEME_MANIFEST.id)
    expect(record?.grants).not.toContain('deck:write')
    expect(record?.denied).toContain('deck:write')
    expect(hasGrant(THEME_MANIFEST.id, 'deck:write')).toBe(false)
    expect(getGrants(THEME_MANIFEST.id)).not.toContain('deck:write')
  })

  it('权限撤销导致自动停用', async () => {
    await installDefault()
    await revokeCapability(THEME_MANIFEST.id, 'ui:command')
    expect(getRecord(THEME_MANIFEST.id)?.state).toBe('disabled')
    expect(getEnabledIds()).toEqual([])
  })
})

describe('卸载清理（02 §3.4 / §7.5）', () => {
  it('默认删除 pluginData；keepData 保留', async () => {
    await installDefault()
    const { kvSet } = await import('@/persistence/kv')
    await kvSet('pluginData', `${THEME_MANIFEST.id}:data:key`, { value: 1 })
    await uninstallPlugin(THEME_MANIFEST.id)
    expect(await kvKeys('pluginData')).toEqual([])
  })

  it('keepData 保留插件数据', async () => {
    await installDefault()
    const { kvSet } = await import('@/persistence/kv')
    await kvSet('pluginData', `${THEME_MANIFEST.id}:data:key`, { value: 1 })
    await uninstallPlugin(THEME_MANIFEST.id, { keepData: true })
    expect(await kvKeys('pluginData')).toContain(`${THEME_MANIFEST.id}:data:key`)
  })

  it('卸载清 settings.values/enabled/keymapOverrides 中的该插件项', async () => {
    await installDefault()
    const settings = useSettingsStore.getState()
    settings.patchPlugins({
      values: { [THEME_MANIFEST.id]: { a: 1 } },
      keymapOverrides: { 'mod+k': `plugin.${THEME_MANIFEST.id}.apply` },
    })
    await uninstallPlugin(THEME_MANIFEST.id)
    const plugins = useSettingsStore.getState().plugins
    expect(plugins.enabled[THEME_MANIFEST.id]).toBeUndefined()
    expect(plugins.values[THEME_MANIFEST.id]).toBeUndefined()
    expect(plugins.keymapOverrides['mod+k']).toBeUndefined()
  })
})

describe('诊断 / 安全模式 / 恢复默认', () => {
  it('诊断 JSON 8 字段且不含插件正文', async () => {
    await installDefault()
    const diagnostics = await getPluginDiagnostics()
    expect(Object.keys(diagnostics).sort()).toEqual(
      ['installed', 'enabled', 'disabled', 'quarantined', 'errorCounts', 'storageMode', 'safeMode', 'auditCount'].sort(),
    )
    expect(diagnostics.installed).toEqual(['com.example.theme-pack'])
    expect(diagnostics.enabled).toEqual(['com.example.theme-pack'])
    expect(diagnostics.storageMode).toBe('memory')
    expect(JSON.stringify(diagnostics)).not.toContain('descrip')
  })

  it('安全模式：不读 plugins store、启用集为空', async () => {
    await installDefault()
    useSettingsStore.getState().patchPlugins({ safeMode: true })
    resetRegistryForTests()
    await loadRegistry()
    expect(listRecords()).toEqual([])
    expect(getEnabledIds()).toEqual([])
  })

  it('resetWorkbench：记录清空、设置覆盖清空、deck 不动', async () => {
    await installDefault()
    const deckBefore = useDeckStore.getState().deck
    await resetWorkbench()
    expect(listRecords()).toEqual([])
    expect(useSettingsStore.getState().plugins.enabled).toEqual({})
    expect(useSettingsStore.getState().plugins.values).toEqual({})
    expect(useDeckStore.getState().deck).toBe(deckBefore)
  })
})

describe('记录摘要', () => {
  it('toPluginSummary 映射 state/enabled/counts', async () => {
    await installDefault()
    const [{ record }] = [{ record: getRecord(THEME_MANIFEST.id)! }]
    const summaries = listSummaries()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: THEME_MANIFEST.id,
      state: 'enabled',
      enabled: true,
      trust: 'local',
      installSource: 'file',
    })
    expect(summaries[0].counts.themes).toBe(1)
    expect(record.state).toBe('enabled')
  })

  it('手动注入的记录也能 applyDeclarativeContributions（重启注册路径）', async () => {
    const record = await makeRecordFromFiles(THEME_MANIFEST, { 'icon.svg': ICON }, { state: 'enabled' })
    seedRecordForTests(record)
    applyDeclarativeContributions(record)
    expect(getRegisteredThemes()).toHaveLength(1)
  })
})

/** 草稿虚拟 registry（02 §11.5）：creator 试跑用。 */
function makeDraft(id = 'draft-0001'): PluginDraft {
  return {
    draftId: id,
    root: `draft/${id}`,
    revision: 1,
    status: 'proposal-ready',
    proposal: {
      title: '测试提案',
      summary: '给工作台加一个主题',
      kind: 'declarative',
      risk: 'low',
      capabilities: ['theme:contribute'],
      files: [{ path: '.lumen-plugin.json', content: '{}' }],
      changes: [{ surface: 'theme', detail: '新增棕褐主题' }],
    },
    files: [
      { path: '.lumen-plugin.json', content: '{}' },
      { path: 'icon.svg', content: ICON },
    ],
    manifest: { ...THEME_MANIFEST, id: 'local.creator.theme' },
    trials: [],
    grantedCapabilities: ['theme:contribute'],
    proposalDigest: 'sha256:deadbeef',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

describe('草稿虚拟 registry（02 §11.5）', () => {
  beforeEach(async () => {
    await resetDraftTrialsForTests()
  })

  it('开始试跑 → 虚拟 pluginId、贡献进 bus、帧数据可建、不写 plugins store', async () => {
    const draft = makeDraft()
    const handle = await startDraftTrial(draft)
    expect(handle.pluginId).toBe('draft/draft-0001')
    expect(parseDraftPluginId(handle.pluginId)).toEqual({ draftId: 'draft-0001' })
    expect(isDraftTrial('draft-0001')).toBe(true)
    expect(listDraftTrials()).toHaveLength(1)
    expect(getRegisteredThemes().map((entry) => entry.theme.id)).toEqual(['draft/draft-0001/sepia'])
    const frame = getDraftFrameSource('draft-0001')
    expect(frame).toMatchObject({ revision: 1, entryPath: null, grants: ['theme:contribute'] })
    expect(frame?.files['icon.svg']).toContain('<svg')
    expect(frame?.files['.lumen-plugin.json']).toBeUndefined()
    expect(getRecord('draft/draft-0001')).toBeUndefined()
    expect(listRecords()).toEqual([])
  })

  it('只允许一个草稿试跑；停止后贡献摘除', async () => {
    await startDraftTrial(makeDraft())
    await expect(startDraftTrial(makeDraft('draft-0002'))).rejects.toMatchObject({ code: 'E-QUOTA-04' })
    await stopDraftTrial('draft-0001')
    expect(isDraftTrial('draft-0001')).toBe(false)
    expect(getRegisteredThemes()).toEqual([])
    expect(getDraftTrial('draft-0001')).toBeUndefined()
  })

  it('试跑授权默认含 deck:write 由 creator 显式控制；updateDraftGrants 生效', async () => {
    await startDraftTrial(makeDraft())
    expect(getDraftFrameSource('draft-0001')?.grants).toEqual(['theme:contribute'])
    updateDraftGrants('draft-0001', ['theme:contribute', 'deck:write'])
    expect(getDraftFrameSource('draft-0001')?.grants).toContain('deck:write')
  })

  it('runDraftTransaction 成功=一个历史条目；失败整笔回滚', async () => {
    await startDraftTrial(makeDraft())
    const before = useDeckStore.getState().deck.slides[0].blocks.length
    await runDraftTransaction('draft-0001', 'insert', () => {
      useDeckStore.getState().update('x', (deck) => {
        deck.slides[0].blocks.push({ id: 'b1', type: 'text', text: 'hi', x: 0, y: 0, w: 100, h: 50 } as never)
      })
    })
    expect(useDeckStore.getState().deck.slides[0].blocks.length).toBe(before + 1)
    expect(useDeckStore.getState().past.at(-1)?.label).toBe('plugin:draft/draft-0001:insert')
    await expect(
      runDraftTransaction('draft-0001', 'boom', () => {
        useDeckStore.getState().update('y', (deck) => {
          deck.slides[0].blocks.push({ id: 'b2', type: 'text', text: 'x', x: 0, y: 0, w: 10, h: 10 } as never)
        })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(useDeckStore.getState().deck.slides[0].blocks.length).toBe(before + 1)
  })

  it('onDraftDeckWrite 在成功事务后回调（失败事务不回调）', async () => {
    await startDraftTrial(makeDraft())
    const writes: Array<{ draftId: string; revision: number; count: number }> = []
    const off = onDraftDeckWrite((payload) => writes.push(payload))
    await runDraftTransaction('draft-0001', 'ok', () => {
      useDeckStore.getState().update('x', (deck) => {
        deck.title = '试跑后标题'
      })
    })
    expect(writes).toEqual([{ draftId: 'draft-0001', revision: 1, count: 1 }])
    await expect(
      runDraftTransaction('draft-0001', 'fail', () => {
        useDeckStore.getState().update('y', (deck) => {
          deck.title = 'should rollback'
        })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(writes).toHaveLength(1)
    off()
  })

  it('rebuild 草稿（revision++）走热替换：先停旧再起新', async () => {
    const draft = makeDraft()
    await startDraftTrial(draft)
    const next = { ...draft, revision: 2 }
    await stopDraftTrial(draft.draftId)
    const handle = await startDraftTrial(next)
    expect(handle.revision).toBe(2)
    expect(getDraftFrameSource(draft.draftId)?.revision).toBe(2)
  })
})
