/**
 * tests/unit/plugins-sample-harness.ts —— 三款样例插件的单测替身（不是 ABI 实现）。
 *
 * 为什么需要它：`plugins/builtin/<name>/plugin.js` 是**单文件 ESM**，真实运行在宿主注入的
 * `window.lumen` 之下；单测在 jsdom 里放一个最小 `lumen` 替身，就能直接 import 插件源码，
 * 从而让「插件导出的纯函数」与「运行期注册的贡献」共用同一份实现（不复制逻辑）。
 *
 * 替身只实现样例用到的方法；任何未实现的方法都会抛错，避免测试悄悄通过。
 */
import { expect } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type PluginName = 'brandguard' | 'chartkit' | 'focusdesk'

export interface MockSnapshotSlide {
  id: string
  name?: string
  recipe?: string
  blockCount: number
  textChars: number
  readingSeconds: number
}

export interface MockSnapshot {
  deckId: string
  title: string
  lang: 'zh' | 'en'
  themeId: string
  revision: number
  slides: MockSnapshotSlide[]
  activeSlideId: string | null
  lint: { error: number; warn: number; info: number }
}

export interface MockRule {
  id: string
  title: { zh: string; en: string }
  severity: string
  run: (ctx: unknown) => unknown
}

export interface MockCommand {
  id: string
  title: string | { zh: string; en: string }
  run: (args?: unknown) => unknown
}

export interface MockRecipe {
  id: string
  namespace: string
  build: (content: unknown, themeId: string) => unknown
}

export interface MockPreset {
  id: string
  name: { zh: string; en: string }
  apply: Record<string, unknown>
}

export interface MockLayoutApply {
  presetId: string
  at: number
}

export interface MockState {
  locale: 'zh' | 'en'
  commands: MockCommand[]
  lintRules: MockRule[]
  recipes: MockRecipe[]
  preflights: ((ctx: unknown) => unknown)[]
  promptFragments: { id: string }[]
  presets: MockPreset[]
  layoutApplies: MockLayoutApply[]
  toasts: { kind: string; message: string }[]
  events: string[]
  invokes: { method: string; payload: unknown }[]
  titles: string[]
  renders: ((root: HTMLElement, ctx: unknown) => void)[]
  storage: Map<string, unknown>
  assets: Map<string, { name: string; mime: string; dataUrl: string }>
  themeColors: Record<string, string>
  themeVars: Record<string, string>
  themeFont: { body: string; display: string; mono: string }
  contrastRatio: number
  dialogs: string[]
  closedPanels: string[]
  busy: boolean[]
  errors: string[]
}

export interface LumenMockOptions {
  locale?: 'zh' | 'en'
  /** 插件语言包（相对键 → 文案）；缺省用键名本身，便于断言「取到了哪个键」。 */
  messages?: Record<string, string>
  snapshot?: MockSnapshot | null
  themeColors?: Record<string, string>
  themeVars?: Record<string, string>
  themeFont?: { body: string; display: string; mono: string }
  settings?: Record<string, unknown>
  storage?: Record<string, unknown>
}

const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"

export const DEFAULT_SNAPSHOT: MockSnapshot = {
  deckId: 'deck-test',
  title: '测试演示',
  lang: 'zh',
  themeId: 'noir',
  revision: 3,
  slides: [
    { id: 's1', blockCount: 3, textChars: 120, readingSeconds: 28.6 },
    { id: 's2', blockCount: 4, textChars: 240, readingSeconds: 57.1 },
  ],
  activeSlideId: 's1',
  lint: { error: 0, warn: 2, info: 1 },
}

export const DEFAULT_THEME_COLORS: Record<string, string> = {
  bg: '#0B1220',
  fg: '#E8EEF9',
  muted: '#9AA8C2',
  surface: '#121A2C',
  line: '#24304A',
  accent: '#1F6FEB',
  accent2: '#22B8CF',
}

export const DEFAULT_THEME_VARS: Record<string, string> = {
  '--d-bg': '#0B1220',
  '--d-fg': '#E8EEF9',
  '--d-accent': '#1F6FEB',
  '--d-accent2': '#22B8CF',
}

/** 与宿主一致的 `lumen.ui.el` 语义（02 §5.3：text=textContent、data/aria 透传、布尔属性）。 */
function makeEl(tag: string, props?: Record<string, unknown> | null, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag)
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'text') {
        node.textContent = String(value)
        continue
      }
      if (key === 'value') {
        ;(node as HTMLInputElement).value = String(value)
        continue
      }
      if (value === true) {
        node.setAttribute(key, '')
        continue
      }
      node.setAttribute(key, String(value))
    }
  }
  for (const child of children) node.append(child)
  return node
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_all, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : `{${name}}`,
  )
}

export function installLumenMock(options: LumenMockOptions = {}): { lumen: Record<string, unknown>; state: MockState } {
  const locale = options.locale ?? 'zh'
  const snapshot = options.snapshot === undefined ? DEFAULT_SNAPSHOT : options.snapshot
  const themeColors = { ...DEFAULT_THEME_COLORS, ...(options.themeColors ?? {}) }
  const themeVars = { ...DEFAULT_THEME_VARS, ...(options.themeVars ?? {}) }
  const themeFont = options.themeFont ?? { body: FONT_STACK, display: FONT_STACK, mono: 'ui-monospace, monospace' }

  const state: MockState = {
    locale,
    commands: [],
    lintRules: [],
    recipes: [],
    preflights: [],
    promptFragments: [],
    presets: [],
    layoutApplies: [],
    toasts: [],
    events: [],
    invokes: [],
    titles: [],
    renders: [],
    storage: new Map(Object.entries(options.storage ?? {})),
    assets: new Map(),
    themeColors,
    themeVars,
    themeFont,
    contrastRatio: 7,
    dialogs: [],
    closedPanels: [],
    busy: [],
    errors: [],
  }

  let assetSeq = 0

  const lumen: Record<string, unknown> = {
    meta: {
      pluginId: 'test.plugin',
      pluginVersion: '0.1.0',
      apiVersion: '1.0',
      locale,
      capabilities: [],
      appVersion: '0.4.0',
    },
    ui: {
      el: makeEl,
      css: () => undefined,
      onRender: (fn: (root: HTMLElement, ctx: unknown) => void) => {
        state.renders.push(fn)
        return () => undefined
      },
      setTitle: (title: string) => {
        state.titles.push(title)
      },
      setBusy: (busy: boolean) => {
        state.busy.push(busy)
      },
      openDialog: async (opts: { id: string }) => {
        state.dialogs.push(opts.id)
      },
      openPanel: async (opts: { id: string }) => {
        state.dialogs.push(opts.id)
      },
      closePanel: (opts: { slot: string; id?: string }) => {
        state.closedPanels.push(opts.id ?? opts.slot)
      },
    },
    commands: {
      register: (cmd: MockCommand) => {
        state.commands.push(cmd)
        return () => undefined
      },
      unregister: () => undefined,
      invoke: async (id: string, payload?: unknown) => {
        state.invokes.push({ method: id, payload })
      },
    },
    keymap: {
      bind: async () => ({ ok: true }),
      unbind: () => undefined,
    },
    layout: {
      registerPreset: (preset: MockPreset) => {
        state.presets.push(preset)
        return () => undefined
      },
      apply: async (presetId: string) => {
        state.layoutApplies.push({ presetId, at: Date.now() })
      },
      current: async () => (state.layoutApplies.at(-1)?.presetId ?? 'default'),
    },
    deck: {
      getSnapshot: async () => (snapshot ? JSON.parse(JSON.stringify(snapshot)) : null),
      getActiveSlide: async () => null,
      subscribe: () => () => undefined,
      insertBlocks: async (_slideId: string, blocks: unknown[]) => ({
        blockIds: blocks.map(() => `b${++assetSeq}`),
      }),
      updateBlock: async (blockId: string) => {
        state.invokes.push({ method: 'deck.updateBlock', payload: blockId })
      },
      transaction: async (_label: string, fn: () => Promise<void>) => {
        state.invokes.push({ method: 'deck.transaction', payload: _label })
        await fn()
      },
      applyTheme: async (themeId: string) => {
        state.invokes.push({ method: 'deck.applyTheme', payload: themeId })
      },
    },
    theme: {
      get: async () => ({
        id: 'brand-blue',
        name: { zh: '品牌·蓝', en: 'Brand Blue' },
        colors: state.themeColors,
        font: state.themeFont,
      }),
      cssVars: async () => ({ ...state.themeVars }),
      subscribe: () => () => undefined,
    },
    storage: {
      get: async (key: string) => state.storage.get(key),
      set: async (key: string, value: unknown) => {
        state.storage.set(key, value)
      },
      remove: async (key: string) => {
        state.storage.delete(key)
      },
      keys: async () => [...state.storage.keys()],
      clear: async () => {
        state.storage.clear()
      },
    },
    settings: {
      declare: async () => undefined,
      get: async () => options.settings ?? {},
      patch: async () => undefined,
      reset: async () => undefined,
      subscribe: () => () => undefined,
    },
    i18n: {
      t: (key: string, vars?: Record<string, string | number>) => {
        const messages = options.messages ?? {}
        const template = Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : key
        return interpolate(template, vars)
      },
      locale,
      register: async () => undefined,
    },
    lint: {
      helpers: {
        plainText: (text: string) => String(text ?? ''),
        contrastRatio: () => state.contrastRatio,
        aaThreshold: () => 4.5,
        estimateTextLayout: () => ({ lines: 1, height: 20 }),
        readingSeconds: (text: string) => String(text ?? '').length / 4.2,
      },
      registerRule: (rule: MockRule) => {
        state.lintRules.push(rule)
        return () => undefined
      },
      report: async () => undefined,
    },
    ai: {
      complete: async () => ({ text: '' }),
      registerRecipe: (recipe: MockRecipe) => {
        state.recipes.push(recipe)
        return () => undefined
      },
      registerPromptFragment: (fragment: { id: string }) => {
        state.promptFragments.push(fragment)
        return () => undefined
      },
    },
    assets: {
      put: async (input: { name: string; mime: string; dataUrl: string }) => {
        const assetId = `asset-${++assetSeq}`
        state.assets.set(assetId, input)
        return { assetId }
      },
      getUrl: async (assetId: string) => {
        const asset = state.assets.get(assetId)
        return asset ? asset.dataUrl : 'data:image/png;base64,AAAA'
      },
      remove: async (assetId: string) => {
        state.assets.delete(assetId)
      },
      list: async () => [...state.assets.keys()].map((assetId) => ({ assetId, name: assetId, bytes: 1, createdAt: 0 })),
    },
    export: {
      onPreflight: (fn: (ctx: unknown) => unknown) => {
        state.preflights.push(fn)
        return () => undefined
      },
      provideStaticAssets: () => () => undefined,
    },
    events: {
      on: (name: string) => {
        state.events.push(name)
        return () => undefined
      },
      off: () => undefined,
    },
    notify: {
      toast: (opts: { kind: string; message: string }) => {
        state.toasts.push({ kind: opts.kind, message: opts.message })
      },
    },
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => {
        state.errors.push(args.map(String).join(' '))
      },
      error: (...args: unknown[]) => {
        state.errors.push(args.map(String).join(' '))
      },
    },
  }

  ;(globalThis as unknown as { lumen?: unknown }).lumen = lumen
  return { lumen, state }
}

export async function loadPluginModule(name: PluginName): Promise<Record<string, unknown>> {
  const url = pathToFileURL(pluginPath(name, 'plugin.js')).href
  const namespace = await import(/* @vite-ignore */ url)
  return namespace as Record<string, unknown>
}

/** 样例源码的绝对路径（工作目录 = 仓库根，vitest 从这里启动）。 */
export function pluginPath(name: PluginName, file: string): string {
  return resolve(process.cwd(), 'plugins', 'builtin', name, file)
}

/** 渲染一次插槽帧（onRender 在真实宿主里由帧回调驱动；单测里手动触发）。 */
export function renderFrame(
  state: MockState,
  options: { ctx?: Record<string, unknown>; index?: number } = {},
): { root: HTMLElement; ctx: Record<string, unknown> } {
  const fn = state.renders[options.index ?? 0]
  expect(fn, 'plugin must register lumen.ui.onRender').toBeTypeOf('function')
  const root = document.createElement('div')
  const ctx = { slot: 'workspace.inspector.tab', size: { w: 340, h: 600 }, theme: 'dark', lang: 'zh', ...(options.ctx ?? {}) }
  fn(root, ctx)
  return { root, ctx }
}

export function findRule(state: MockState, id: string): MockRule {
  const rule = state.lintRules.find((item) => item.id === id)
  expect(rule, `lint rule ${id} must be registered before ready`).toBeTruthy()
  return rule as MockRule
}

export function findCommand(state: MockState, id: string): MockCommand {
  const command = state.commands.find((item) => item.id === id)
  expect(command, `command ${id} must be registered before ready`).toBeTruthy()
  return command as MockCommand
}
