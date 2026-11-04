/**
 * tests/security/plugins-residue.test.ts —— 红队 S-40-10 卸载残留（贡献注册表半边）。
 *
 * 02 §3.4 的 14 项清理里，声明式贡献（主题/素材/i18n/设置/命令/键位/布局/插槽/lint/配方/导出钩子）
 * 已可在纯逻辑层验证原子清理；DOM 节点、window 监听、定时器、blob URL、pluginData 的清理
 * 需真实宿主（registry + host）落地后由 e2e 覆盖（见文件末尾 todo 清单）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { parseManifest } from '@/plugins/manifest'
import {
  contributionCounts,
  contributionRevision,
  getRegisteredCommands,
  getRegisteredExportHooks,
  getRegisteredKeymap,
  getRegisteredLayoutPresets,
  getRegisteredLibrary,
  getRegisteredLintRules,
  getRegisteredLocalePacks,
  getRegisteredRecipes,
  getRegisteredSettings,
  getRegisteredSlots,
  getRegisteredThemes,
  registerContributions,
  resetContributionsForTests,
  unregisterContributions,
} from '@/plugins/contributionBus'
import type { PluginManifest } from '@/plugins/types'

const okFiles = { 'readme.md': '# x\n' }

const COLORS = {
  bg: '#0b0c10',
  fg: '#f2f4f8',
  muted: '#98a2b3',
  surface: '#141821',
  line: '#263041',
  accent: '#57e3c2',
  accent2: '#c8a15a',
}

function declarativeManifest(): PluginManifest {
  return {
    id: 'com.qatools.residue-decl',
    name: { zh: '卸载声明式', en: 'Residue declarative' },
    version: '0.1.0',
    apiVersion: '1.0',
    minAppVersion: '0.4.0',
    kind: 'declarative',
    author: { name: 'QA' },
    description: { zh: '残留测试。', en: 'Residue test.' },
    license: 'MIT',
    capabilities: ['theme:contribute', 'library:contribute', 'i18n:contribute', 'storage', 'ui:command', 'ui:keymap', 'ui:layout'],
    contributes: {
      themes: [{ id: 'res-theme', name: { zh: '残留主题', en: 'Residue theme' }, colors: COLORS }],
      library: [
        {
          id: 'res-mark',
          name: { zh: '残留素材', en: 'Residue mark' },
          category: 'geometric',
          viewBox: [0, 0, 24, 24],
          source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>',
        },
      ],
      i18n: [{ zh: { hello: '你好' }, en: { hello: 'Hello' } }],
      settings: {
        id: 'prefs',
        title: { zh: '偏好', en: 'Prefs' },
        fields: [{ key: 'enabled', type: 'switch', label: { zh: '开', en: 'On' }, default: true }],
      },
      commands: [{ id: 'say-hi', title: { zh: '嗨', en: 'Hi' }, category: 'plugin', action: { kind: 'toast', message: { zh: '嗨', en: 'Hi' } } }],
      keymap: [{ combo: 'mod+shift+j', commandId: 'say-hi' }],
      layoutPresets: [{ id: 'res-layout', name: { zh: '残留布局', en: 'Residue layout' }, apply: { density: 'compact' } }],
    },
  }
}

function codeManifest(): PluginManifest {
  return {
    id: 'com.qatools.residue-code',
    name: { zh: '卸载代码式', en: 'Residue code' },
    version: '0.1.0',
    apiVersion: '1.0',
    minAppVersion: '0.4.0',
    kind: 'code',
    entry: 'plugin.js',
    author: { name: 'QA' },
    description: { zh: '残留测试。', en: 'Residue test.' },
    license: 'MIT',
    capabilities: ['ui:slot', 'lint:rule', 'ai:recipe', 'export:hook'],
    contributes: {
      slots: [{ id: 'res-dock', slot: 'workspace.dock', title: { zh: '残留看板', en: 'Residue board' }, kind: 'panel' }],
      lintRules: [{ id: 'res-rule', title: { zh: '残留规则', en: 'Residue rule' }, severity: 'warn' }],
      recipes: [{ id: 'res-recipe', namespace: 'resq', title: { zh: '残留配方', en: 'Residue recipe' }, slots: [{ key: 'headline' }] }],
      exportHooks: [{ id: 'res-hook', title: { zh: '残留钩子', en: 'Residue hook' }, kind: 'preflight' }],
    },
  }
}

function owner(manifest: PluginManifest) {
  return { pluginId: manifest.id, pluginVersion: manifest.version, manifest, trust: 'local' as const, capabilities: manifest.capabilities }
}

function countAll(): number {
  return (
    getRegisteredThemes().length +
    getRegisteredLibrary().length +
    getRegisteredSettings().length +
    getRegisteredCommands().length +
    getRegisteredKeymap().length +
    getRegisteredLayoutPresets().length +
    getRegisteredSlots().length +
    getRegisteredLintRules().length +
    getRegisteredRecipes().length +
    getRegisteredExportHooks().length +
    getRegisteredLocalePacks().length
  )
}

beforeEach(() => {
  resetContributionsForTests()
})

describe('S-40-10 卸载残留：贡献注册表原子清理', () => {
  it('两插件（声明式 + 代码式）共 11 类贡献注册后卸载一个，另一个完全不受影响', () => {
    const decl = parseManifest(declarativeManifest(), { files: okFiles, installSource: 'file' })
    const codeManifestParsed = parseManifest(codeManifest(), { files: { 'plugin.js': 'const l = window.lumen\nl.meta.ready({})\n' }, installSource: 'file' })
    registerContributions(owner(decl), decl)
    registerContributions(owner(codeManifestParsed), codeManifestParsed)

    expect(contributionCounts(decl.id).themes).toBe(1)
    expect(contributionCounts(codeManifestParsed.id).slots).toBe(1)
    const totalBefore = countAll()
    expect(totalBefore).toBeGreaterThanOrEqual(11)

    unregisterContributions(decl.id)
    expect(Object.values(contributionCounts(decl.id)).every((count) => count === 0), '反注册后该插件计数应全 0').toBe(true)
    expect(getRegisteredThemes()).toHaveLength(0)
    expect(getRegisteredLibrary()).toHaveLength(0)
    expect(getRegisteredLocalePacks()).toHaveLength(0)
    expect(getRegisteredSettings()).toHaveLength(0)
    expect(getRegisteredCommands()).toHaveLength(0)
    expect(getRegisteredKeymap()).toHaveLength(0)
    expect(getRegisteredLayoutPresets()).toHaveLength(0)
    // 另一个插件仍在
    expect(getRegisteredSlots()).toHaveLength(1)
    expect(getRegisteredLintRules()).toHaveLength(1)
    expect(getRegisteredRecipes()).toHaveLength(1)
    expect(getRegisteredExportHooks()).toHaveLength(1)
    expect(countAll()).toBeLessThan(totalBefore)
  })

  it('卸载通知订阅者（UI 重渲染钩子）且不重复反注册', () => {
    const decl = parseManifest(declarativeManifest(), { files: okFiles, installSource: 'file' })
    registerContributions(owner(decl), decl)
    const revisionAfterRegister = contributionRevision()
    unregisterContributions(decl.id)
    const revisionAfterUnregister = contributionRevision()
    expect(revisionAfterUnregister).toBeGreaterThan(revisionAfterRegister)
    unregisterContributions(decl.id) // 幂等
    expect(getRegisteredThemes()).toHaveLength(0)
    expect(contributionRevision()).toBeGreaterThanOrEqual(revisionAfterUnregister)
  })
})

describe.todo('S-40-10 真实宿主残留（待 registry/host 落地 + e2e）')
// 待补断言（02 §3.4 的 14 项）：
// 1) DOM：`[data-plugin-id]` / `[data-plugin-frame]` / `[data-slot]` 空壳保留但帧节点消失；
// 2) window 监听器数量回到基线（addEventListener/removeEventListener 计数桩）；
// 3) 定时器/心跳/看门狗全部停止（fake timers 或页内 __timerCount）；
// 4) blob URL 全部 revoke；5) pluginData 按策略清理（默认清，keepData 显式保留）；
// 6) deck 里引用插件主题/配方不报错（回落 noir/statement）。
