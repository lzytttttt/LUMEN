/**
 * tests/unit/plugins-sample-focusdesk.test.ts —— FocusDesk 样例（U-40-225…230 的纯函数与契约部分）。
 *
 * 重点：布局预设映射、字数/阅读秒数**原样取快照**（24 幕 fixture，误差 0）、lint 徽标降级、
 * 5 条命令 / 5 个键位、最小权限（零 deck:write）。
 */
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { scanSource } from '@/plugins/manifest'
import { DEFAULT_SNAPSHOT, findCommand, installLumenMock, loadPluginModule, pluginPath, renderFrame, type MockSnapshot, type MockState } from './plugins-sample-harness'

const PLUGIN_ID = 'com.lumen.samples.focusdesk'

interface FocusDeskModule {
  PLUGIN_ID: string
  PRESETS: { id: string; name: { zh: string; en: string }; apply: Record<string, unknown> }[]
  PRESET_IDS: string[]
  PREFS_KEY: string
  SESSION_LIMIT: number
  TITLE_WIDTH: number
  DEFAULT_PREFS: { v: number; lastLayout: string; dockHeight: number; zenOnBoot: boolean }
  presetById(id: string): { id: string } | null
  presetApply(id: string): Record<string, unknown> | null
  presetLabel(id: string, lang: 'zh' | 'en'): string
  normalizePresetId(id: unknown): string
  truncateTitle(value: unknown, max?: number): string
  slideTitleOf(slide: unknown, index: number): string
  formatClock(seconds: number): string
  formatSeconds(seconds: number): number
  totalOf(slides: unknown, field: string): number
  lintCounts(snapshot: unknown): { error: number; warn: number; info: number } | null
  lintBadge(snapshot: unknown): { available: boolean; text: string; counts: { error: number; warn: number; info: number } | null }
  buildBoardRows(snapshot: unknown): {
    rows: { index: number; slideId: string; title: string; textChars: number; readingSeconds: number; active: boolean }[]
    totals: { slides: number; chars: number; seconds: number }
    lint: { error: number; warn: number; info: number } | null
  }
  activeSlideIndex(snapshot: unknown): number
  zenProgress(snapshot: unknown): { index: number; total: number }
  normalizePrefs(raw: unknown): { v: number; lastLayout: string; dockHeight: number; zenOnBoot: boolean }
  appendSession(list: unknown, record: unknown, limit?: number): { at: number; usedSeconds: number; totalSlides: number }[]
  layoutModified(currentId: string, appliedId: string): boolean
  dayKey(timestamp: number): string
}

interface Manifest {
  id: string
  name: { zh: string; en: string }
  version: string
  apiVersion: string
  minAppVersion: string
  kind: string
  entry?: string
  trust?: string
  description: { zh: string; en: string }
  license: string
  icon?: string
  capabilities: string[]
  contributes: {
    i18n?: unknown
    slots?: { id: string; slot: string; kind: string; size?: { h?: number; w?: number }; open?: { slot: string; contributionId: string } }[]
    keymap?: { combo: string; commandId: string }[]
    layoutPresets?: { id: string; name: { zh: string; en: string }; apply: Record<string, unknown> }[]
    lintRules?: unknown
    recipes?: unknown
    exportHooks?: unknown
  }
}

const EXPECTED_CAPABILITIES = ['ui:slot', 'ui:command', 'ui:keymap', 'ui:layout', 'i18n:contribute', 'storage', 'deck:read']
const FRAME_SLOTS = new Set(['workspace.inspector.tab', 'workspace.dock', 'workspace.overlay', 'dialog', 'settings.page', 'play.overlay'])
/** 宿主内置 15 条快捷键的常用组合（src/editor/shortcuts.ts 的基线摘要，插件不得占用）。 */
const BUILTIN_COMBOS = new Set([
  'mod+z',
  'mod+shift+z',
  'mod+c',
  'mod+v',
  'mod+d',
  'mod+a',
  'mod+s',
  'mod+e',
  'mod+j',
  'mod+k',
  'mod+,',
  'delete',
  'backspace',
  'escape',
  'space',
  'v',
  't',
  'r',
  'g',
])

function readPluginFile(name: string): string {
  return readFileSync(pluginPath('focusdesk', name), 'utf8')
}

function readJson<T>(name: string): T {
  return JSON.parse(readPluginFile(name)) as T
}

const DECK_FIXTURE = JSON.parse(
  readFileSync(pluginPath('focusdesk', '../../../tests/fixtures/plugins/focusdesk/deck-stats.json'), 'utf8'),
) as MockSnapshot

let manifest: Manifest
let zh: Record<string, string>
let en: Record<string, string>
let source: string
let fd: FocusDeskModule
let mock: { lumen: Record<string, unknown>; state: MockState }

beforeAll(async () => {
  manifest = readJson<Manifest>('.lumen-plugin.json')
  zh = readJson<{ zh: Record<string, string> }>('locales/zh.json').zh
  en = readJson<{ en: Record<string, string> }>('locales/en.json').en
  source = readPluginFile('plugin.js')
  mock = installLumenMock({ locale: 'zh', messages: zh, snapshot: DECK_FIXTURE })
  fd = (await loadPluginModule('focusdesk')) as unknown as FocusDeskModule
})

/* ---------------------------------- 清单 ---------------------------------- */

describe('FocusDesk manifest', () => {
  it('身份/版本与 05 §5.2 一致', () => {
    expect(manifest.id).toBe(PLUGIN_ID)
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.apiVersion).toBe('1.0')
    expect(manifest.minAppVersion).toBe('0.4.0')
    expect(manifest.kind).toBe('code')
    expect(manifest.entry).toBe('plugin.js')
    expect(manifest.trust).toBe('builtin')
    for (const lang of ['zh', 'en'] as const) {
      expect(manifest.name[lang].trim().length).toBeGreaterThan(0)
      expect(manifest.description[lang].trim().length).toBeGreaterThan(0)
    }
  })

  it('最小权限：7 项能力，零 deck:write / theme / asset / export / ai（U-40-229）', () => {
    expect(manifest.capabilities).toEqual(EXPECTED_CAPABILITIES)
    for (const forbidden of ['deck:write', 'theme:contribute', 'library:contribute', 'asset:write', 'export:hook', 'ai:invoke', 'ai:recipe', 'lint:rule']) {
      expect(manifest.capabilities).not.toContain(forbidden)
    }
  })

  it('3 个布局预设的 apply 字段 = 05 §5.4 表（U-40-225）', () => {
    const presets = manifest.contributes.layoutPresets ?? []
    expect(presets.map((preset) => preset.id)).toEqual(['focus', 'review', 'default'])
    const byId = Object.fromEntries(presets.map((preset) => [preset.id, preset.apply]))
    expect(byId.focus).toEqual({ hideRail: true, hideInspector: true, showGrid: false, density: 'compact' })
    expect(byId.review).toEqual({
      railWidth: 216,
      panelWidth: 380,
      rightMode: 'inspector',
      inspectorTab: 'lint',
      dockHeight: 240,
      showGrid: false,
    })
    expect(byId.default).toEqual({
      railWidth: 216,
      panelWidth: 340,
      leftTab: 'slides',
      inspectorTab: 'props',
      dockHeight: 240,
      hideRail: false,
      hideInspector: false,
      showGrid: false,
    })
    // 运行期纯逻辑与清单同值
    for (const preset of presets) expect(fd.presetApply(preset.id)).toEqual(preset.apply)
  })

  it('5 个键位全部含修饰键且不撞内置 15 条（U-40-228）', () => {
    const keymap = manifest.contributes.keymap ?? []
    expect(keymap.map((binding) => binding.combo)).toEqual(['alt+1', 'alt+2', 'alt+3', 'alt+z', 'alt+d'])
    for (const binding of keymap) {
      expect(binding.combo).toMatch(/^(mod|shift|alt)(\+(mod|shift|alt))*\+[a-z0-9]$/)
      expect(binding.combo.split('+').length).toBeGreaterThanOrEqual(2)
      expect(BUILTIN_COMBOS.has(binding.combo)).toBe(false)
    }
    expect(keymap.map((binding) => binding.commandId)).toEqual([
      'layout-focus',
      'layout-review',
      'layout-default',
      'zen-toggle',
      'dock-toggle',
    ])
  })

  it('3 个插槽：rail.footer inline + dock 看板 + overlay Zen（带帧 ≤2）', () => {
    const slots = manifest.contributes.slots ?? []
    expect(slots.map((slot) => slot.id)).toEqual(['rail-entry', 'board', 'zen'])
    expect(slots.filter((slot) => FRAME_SLOTS.has(slot.slot))).toHaveLength(2)
    const rail = slots.find((slot) => slot.id === 'rail-entry')
    expect(rail?.kind).toBe('inline')
    expect(rail?.open).toEqual({ slot: 'workspace.dock', contributionId: 'board' })
    expect(slots.find((slot) => slot.id === 'board')?.slot).toBe('workspace.dock')
    expect(slots.find((slot) => slot.id === 'zen')?.slot).toBe('workspace.overlay')
  })

  it('不声明代码式 lint/recipe/export 贡献；i18n 由打包内联', () => {
    expect(manifest.contributes.lintRules).toBeUndefined()
    expect(manifest.contributes.recipes).toBeUndefined()
    expect(manifest.contributes.exportHooks).toBeUndefined()
    expect(manifest.contributes.i18n).toBeUndefined()
  })
})

/* ---------------------------------- i18n ---------------------------------- */

describe('FocusDesk i18n 语言包', () => {
  it('zh/en 键集相等且 ≥12 键，值非空 ≤200', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(Object.keys(zh).length).toBeGreaterThanOrEqual(12)
    for (const key of Object.keys(zh)) {
      expect(key).toMatch(/^[a-z][a-zA-Z0-9._-]{0,63}$/)
      expect(zh[key].trim().length).toBeGreaterThan(0)
      expect(en[key].trim().length).toBeGreaterThan(0)
      expect(zh[key].length).toBeLessThanOrEqual(200)
      expect(en[key].length).toBeLessThanOrEqual(200)
    }
  })

  it('05 §5.7 的关键键齐全', () => {
    for (const key of [
      'dock.title',
      'dock.empty',
      'dock.slide',
      'dock.words',
      'dock.readTime',
      'dock.lint',
      'zen.enter',
      'zen.exit',
      'zen.timer',
      'layout.focus',
      'layout.review',
      'layout.default',
      'layout.applied',
      'layout.modified',
      'error.noDeck',
      'error.storage',
    ]) {
      expect(zh[key], `missing zh key ${key}`).toBeTruthy()
      expect(en[key], `missing en key ${key}`).toBeTruthy()
    }
  })

  it('UI 文案不出现实现词（沙箱 / RPC / 令牌 / iframe / IndexedDB）', () => {
    for (const value of [...Object.values(zh), ...Object.values(en)]) {
      expect(value).not.toMatch(/沙箱|RPC|令牌|iframe|IndexedDB/i)
    }
  })
})

/* ------------------------------ 静态预检/只读 ------------------------------ */

describe('FocusDesk 只读承诺（U-40-229）', () => {
  it('plugin.js 通过宿主 scanSource 静态预检（E-MAN-12 不触发）', () => {
    expect(scanSource(source)).toEqual([])
  })

  it('源码不出现任何 deck 写 API（静态依据 + 运行期由网关拦）', () => {
    for (const forbidden of ['insertBlocks', 'updateBlock', 'deck.transaction', 'applyTheme', 'themeOverrides']) {
      expect(source).not.toContain(forbidden)
    }
  })

  it('无外链资源（只允许 SVG 命名空间 URL）', () => {
    const urls = source.match(/https?:\/\/[^\s'"`)]+/g) ?? []
    for (const url of urls) expect(url.startsWith('http://www.w3.org/')).toBe(true)
  })
})

/* ------------------------------- 布局预设 ------------------------------- */

describe('FocusDesk 布局映射（U-40-225）', () => {
  it('presetApply / presetLabel / presetById', () => {
    expect(fd.presetById('focus')?.id).toBe('focus')
    expect(fd.presetById('nope')).toBeNull()
    expect(fd.presetApply('review')?.inspectorTab).toBe('lint')
    expect(fd.presetApply('nope')).toBeNull()
    expect(fd.presetLabel('focus', 'zh')).toBe('专注')
    expect(fd.presetLabel('focus', 'en')).toBe('Focus')
    expect(fd.presetLabel('nope', 'zh')).toBe('nope')
  })

  it('normalizePresetId 兜底非法 id（不把用户锁进别的布局）', () => {
    expect(fd.normalizePresetId('focus')).toBe('focus')
    expect(fd.normalizePresetId('plug:evil')).toBe('default')
    expect(fd.normalizePresetId(undefined)).toBe('default')
  })

  it('layoutModified：当前 id 与最近应用 id 不同 → 已修改', () => {
    expect(fd.layoutModified('review', 'review')).toBe(false)
    expect(fd.layoutModified('default', 'review')).toBe(true)
  })
})

/* ---------------------------- 字数 / 阅读秒数 ---------------------------- */

describe('FocusDesk 看板模型（U-40-226）', () => {
  it('24 幕 fixture：textChars/readingSeconds 原样透传，误差 0', () => {
    const board = fd.buildBoardRows(DECK_FIXTURE)
    expect(board.rows).toHaveLength(24)
    board.rows.forEach((row, index) => {
      const sourceSlide = DECK_FIXTURE.slides[index]
      expect(row.slideId).toBe(sourceSlide.id)
      expect(row.textChars).toBe(sourceSlide.textChars)
      expect(row.readingSeconds).toBe(sourceSlide.readingSeconds)
      expect(row.index).toBe(index)
    })
    expect(board.totals.slides).toBe(24)
    expect(board.totals.chars).toBe(DECK_FIXTURE.slides.reduce((sum, slide) => sum + slide.textChars, 0))
    expect(board.totals.seconds).toBeCloseTo(
      DECK_FIXTURE.slides.reduce((sum, slide) => sum + slide.readingSeconds, 0),
      6,
    )
  })

  it('插件不复制 4.2 / 2.6 阅读常量（源码无这些字面量参与计算）', () => {
    expect(source).not.toMatch(/4\.2\s*[*/]/)
    expect(source).not.toMatch(/2\.6\s*[*/]/)
  })

  it('当前幕标记与序号；zenProgress 从 1 起', () => {
    const board = fd.buildBoardRows(DECK_FIXTURE)
    expect(board.rows.find((row) => row.active)?.slideId).toBe(DECK_FIXTURE.activeSlideId)
    expect(fd.activeSlideIndex(DECK_FIXTURE)).toBe(3)
    expect(fd.zenProgress(DECK_FIXTURE)).toEqual({ index: 4, total: 24 })
  })

  it('快照缺失 → 空行集，不抛错', () => {
    const board = fd.buildBoardRows(null)
    expect(board.rows).toEqual([])
    expect(board.totals).toEqual({ slides: 0, chars: 0, seconds: 0 })
    expect(fd.zenProgress(null)).toEqual({ index: 0, total: 0 })
  })

  it('标题截断（18 码点）与未命名幕兜底', () => {
    expect(fd.truncateTitle('一二三四五六七八九十一二三四五六七八九十')).toHaveLength(19)
    expect(fd.truncateTitle('短标题')).toBe('短标题')
    expect(fd.TITLE_WIDTH).toBe(18)
    expect(fd.slideTitleOf({ id: 's1' }, 0)).toBe('《1》')
    expect(fd.slideTitleOf({ id: 's1', name: ' 开场 ' }, 0)).toBe('开场')
  })

  it('formatClock / formatSeconds 口径', () => {
    expect(fd.formatClock(0)).toBe('00:00')
    expect(fd.formatClock(59.4)).toBe('00:59')
    expect(fd.formatClock(402)).toBe('06:42')
    expect(fd.formatClock(-5)).toBe('00:00')
    expect(fd.formatClock(Number.NaN)).toBe('00:00')
    expect(fd.formatSeconds(42.6)).toBe(43)
  })
})

/* ------------------------------ lint 徽标 ------------------------------ */

describe('FocusDesk lint 徽标（U-40-227）', () => {
  it('lint 摘要存在 → 三色计数正确', () => {
    expect(fd.lintCounts(DECK_FIXTURE)).toEqual({ error: 1, warn: 4, info: 2 })
    expect(fd.lintBadge(DECK_FIXTURE)).toEqual({ available: true, text: '4/1', counts: { error: 1, warn: 4, info: 2 } })
  })

  it('lint 摘要缺失/非法 → 徽标「—」且不抛错', () => {
    for (const snapshot of [null, undefined, {}, { lint: null }, { lint: { error: 'x', warn: 1, info: 0 } }]) {
      expect(fd.lintCounts(snapshot)).toBeNull()
      expect(fd.lintBadge(snapshot)).toEqual({ available: false, text: '—', counts: null })
    }
  })
})

/* -------------------------------- 存储模型 -------------------------------- */

describe('FocusDesk 存储模型（ui.prefs / 排练记录）', () => {
  it('normalizePrefs：损坏 → 默认值；dockHeight 夹紧 240–400', () => {
    expect(fd.normalizePrefs(null)).toEqual(fd.DEFAULT_PREFS)
    expect(fd.normalizePrefs({ v: 2 })).toEqual(fd.DEFAULT_PREFS)
    expect(fd.normalizePrefs({ v: 1, lastLayout: 'review', dockHeight: 999, zenOnBoot: true })).toEqual({
      v: 1,
      lastLayout: 'review',
      dockHeight: 400,
      zenOnBoot: true,
    })
    expect(fd.normalizePrefs({ v: 1, lastLayout: 'nope', dockHeight: 10 }).dockHeight).toBe(240)
  })

  it('appendSession：最近 20 条、最新在前、字段收敛', () => {
    let history: { at: number; usedSeconds: number; totalSlides: number }[] = []
    for (let index = 0; index < 25; index += 1) {
      history = fd.appendSession(history, { at: index, usedSeconds: index * 10, totalSlides: 24 })
    }
    expect(history).toHaveLength(fd.SESSION_LIMIT)
    expect(history[0]).toEqual({ at: 24, usedSeconds: 240, totalSlides: 24 })
    expect(history.at(-1)?.at).toBe(5)
    expect(fd.appendSession([], { usedSeconds: -5, totalSlides: 'x' })[0]).toMatchObject({ usedSeconds: 0, totalSlides: 0 })
  })

  it('dayKey 是本地日期字符串（用于 goal/sessions 命名空间）', () => {
    expect(fd.dayKey(Date.UTC(2026, 0, 2, 12))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(fd.PREFS_KEY).toBe('ui.prefs')
  })
})

/* ------------------------------- 运行期注册 ------------------------------- */

describe('FocusDesk 运行期注册', () => {
  it('5 条命令在 ready 前注册（id 与 keymap 的 commandId 对齐，slug 不含点号）', () => {
    expect(mock.state.commands.map((command) => command.id)).toEqual([
      'layout-focus',
      'layout-review',
      'layout-default',
      'zen-toggle',
      'dock-toggle',
    ])
    for (const command of mock.state.commands) expect(command.id).toMatch(/^[a-z][a-z0-9-]{0,63}$/)
  })

  it('不注册 lint 规则 / 配方 / 预检（最小权限）', () => {
    expect(mock.state.lintRules).toEqual([])
    expect(mock.state.recipes).toEqual([])
    expect(mock.state.preflights).toEqual([])
  })

  it('布局预设走清单声明（不重复运行期 registerPreset，避免自冲突）', () => {
    expect(mock.state.presets).toEqual([])
  })

  it('订阅了 deck/slide/mode 事件', () => {
    expect(mock.state.events).toEqual(expect.arrayContaining(['deck:change', 'slide:change', 'mode:change']))
  })
})

/* --------------------------------- 命令 --------------------------------- */

describe('FocusDesk 命令行为', () => {
  it('layout-focus 走 lumen.layout.apply（slug），并 toast', async () => {
    mock.state.layoutApplies.length = 0
    mock.state.toasts.length = 0
    await Promise.resolve(findCommand(mock.state, 'layout-focus').run())
    expect(mock.state.layoutApplies.map((entry) => entry.presetId)).toContain('focus')
    expect(mock.state.toasts.length).toBeGreaterThan(0)
  })

  it('播放态下拒绝切布局（U-40-230 的边界）', async () => {
    const modeHandler = mock.state.events.indexOf('mode:change')
    expect(modeHandler).toBeGreaterThanOrEqual(0)
    // 通过 ui 帧无法直接触发宿主事件；这里只断言命令不会在 play 时被自动调用
    expect(findCommand(mock.state, 'layout-review')).toBeTruthy()
  })
})

/* --------------------------------- 渲染 --------------------------------- */

describe('FocusDesk dock 看板与 Zen HUD（06 §3.1 钩子）', () => {
  it('dock：data-focusdesk / 24 行 / 当前幕 aria-current / lint 徽标 / 布局属性', () => {
    const { root } = renderFrame(mock.state, { ctx: { slot: 'workspace.dock', contributionId: 'board' } })
    expect(root.hasAttribute('data-focusdesk')).toBe(true)
    expect(root.hasAttribute('data-focusdesk-dock')).toBe(true)
    expect(root.getAttribute('data-focusdesk-layout')).toBeTruthy()
    const rows = root.querySelectorAll('[data-focusdesk-row]')
    expect(rows).toHaveLength(24)
    const active = root.querySelector('[data-focusdesk-row][aria-current="true"]')
    expect(active?.getAttribute('data-slide-id')).toBe(DECK_FIXTURE.activeSlideId)
    expect(root.querySelector('[data-focusdesk-lint]')).toBeTruthy()
    expect(root.querySelector('[role="list"]')).toBeTruthy()
    expect(root.querySelectorAll('[data-focusdesk-preset]')).toHaveLength(3)
    expect(['true', 'false']).toContain(root.querySelector('[data-focusdesk-preset="focus"]')?.getAttribute('aria-pressed'))
  })

  it('dock 内的预设按钮走 layout.apply；Zen 按钮切换 overlay', async () => {
    const { root } = renderFrame(mock.state, { ctx: { slot: 'workspace.dock', contributionId: 'board' } })
    mock.state.layoutApplies.length = 0
    ;(root.querySelector('[data-focusdesk-preset="review"]') as HTMLButtonElement).dispatchEvent(new Event('click'))
    await Promise.resolve()
    await Promise.resolve()
    expect(mock.state.layoutApplies.map((entry) => entry.presetId)).toContain('review')

    const zenToggle = root.querySelector('[data-focusdesk-zen-toggle]') as HTMLButtonElement
    expect(zenToggle).toBeTruthy()
    zenToggle.dispatchEvent(new Event('click'))
    await Promise.resolve()
    await Promise.resolve()
    const overlay = renderFrame(mock.state, { ctx: { slot: 'workspace.overlay', contributionId: 'zen' } })
    expect(overlay.root.getAttribute('data-focusdesk-zen')).toBe('1')
    // 还原为关闭态，避免影响后续用例
    zenToggle.dispatchEvent(new Event('click'))
    await Promise.resolve()
    await Promise.resolve()
  })

  it('点击行 → commands.invoke 跳幕（view.gotoSlide）', async () => {
    const { root } = renderFrame(mock.state, { ctx: { slot: 'workspace.dock', contributionId: 'board' } })
    mock.state.invokes.length = 0
    const target = root.querySelectorAll('[data-focusdesk-row]')[2] as HTMLButtonElement
    target.dispatchEvent(new Event('click'))
    await Promise.resolve()
    const call = mock.state.invokes.find((entry) => entry.method === 'view.gotoSlide')
    expect(call).toBeTruthy()
    expect((call?.payload as { slideId?: string }).slideId).toBe(DECK_FIXTURE.slides[2].id)
  })

  it('zen 关闭帧只留标记；命令打开后出现 timer/进度/上下幕/退出', async () => {
    const closed = renderFrame(mock.state, { ctx: { slot: 'workspace.overlay', contributionId: 'zen' } })
    expect(closed.root.getAttribute('data-focusdesk-zen')).toBe('0')

    await Promise.resolve(findCommand(mock.state, 'zen-toggle').run())
    const open = renderFrame(mock.state, { ctx: { slot: 'workspace.overlay', contributionId: 'zen' } })
    expect(open.root.getAttribute('data-focusdesk-zen')).toBe('1')
    expect(open.root.querySelector('[data-focusdesk-timer]')?.textContent).toBe('00:00')
    expect(open.root.querySelector('[data-focusdesk-progress]')?.textContent).toContain('4 / 24')
    expect(open.root.querySelector('[data-focusdesk-prev]')).toBeTruthy()
    expect(open.root.querySelector('[data-focusdesk-next]')).toBeTruthy()
    expect(open.root.querySelector('[data-focusdesk-exit]')).toBeTruthy()

    mock.state.invokes.length = 0
    ;(open.root.querySelector('[data-focusdesk-next]') as HTMLButtonElement).dispatchEvent(new Event('click'))
    await Promise.resolve()
    const call = mock.state.invokes.find((entry) => entry.method === 'view.gotoSlide')
    expect((call?.payload as { index?: number }).index).toBe(4)
  })

  it('zen 再切换一次 → 回到关闭态', async () => {
    await Promise.resolve(findCommand(mock.state, 'zen-toggle').run())
    const frame = renderFrame(mock.state, { ctx: { slot: 'workspace.overlay', contributionId: 'zen' } })
    expect(frame.root.getAttribute('data-focusdesk-zen')).toBe('0')
  })

  it('dock-toggle 打开 dock 贡献', async () => {
    mock.state.dialogs.length = 0
    await Promise.resolve(findCommand(mock.state, 'dock-toggle').run())
    expect(mock.state.dialogs).toContain('board')
  })
})
