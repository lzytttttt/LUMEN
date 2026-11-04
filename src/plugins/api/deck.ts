/**
 * plugins/api/deck.ts —— `lumen.deck`（02 §5.2 / §5.3 / §4.6）。
 *
 * 所有写操作走 `src/state/ops.ts` + `deckStore` 的 group（事务），插件层不持有可写引用：
 * - `insertBlocks/updateBlock/applyTheme` 各自一笔可撤销历史；
 * - `transaction(label, fn)` = begin → 插件侧 fn 依次 RPC → commit；失败 rollback 到事务前快照；
 * - 只接受 6 种内置块；`image` 必须是本插件 `asset:write` 产出的 assetId；
 * - 平台级字段（`id/type/provenance/schemaVersion/z/meta`）不可写。
 */
import { useDeckStore } from '@/state/deckStore'
import { blockOps, deckOps } from '@/state/ops'
import { useUiStore } from '@/state/uiStore'
import { makeBlock } from '@/schema/factory'
import { getTheme, THEME_IDS } from '@/themes'
import { lintDeck, readingSeconds, summarizeLint } from '@/lint/deckLint'
import { plainText } from '@/render/text/markdown'
import { getRegisteredThemes } from '../contributionBus'
import type { DeckSnapshot, PluginBlockInput, ReadonlySlideMeta, SlideSnapshot } from '../types'
import { hasPluginAsset } from './assets'
import { appendAudit } from '../audit'
import type { ApiCall } from './context'
import { currentLocale } from './context'
import { abiError, assertRecord, registerNamespaceApi } from './gateway'

/* ------------------------------ 事务 ------------------------------ */

interface ActiveTransaction {
  frameId: string
  pluginId: string
  label: string
  depth: number
  snapshot: ReturnType<typeof useDeckStore.getState>['deck']
  startedAt: number
}

let active: ActiveTransaction | null = null
let queue: Array<() => void> = []

function acquire(frameId: string): Promise<void> {
  if (!active) return Promise.resolve()
  return new Promise((resolve) => {
    queue.push(() => resolve())
    void frameId
  })
}

function release(): void {
  const next = queue.shift()
  if (next) next()
}

function beginTransaction(frameId: string, pluginId: string, label: string): void {
  const store = useDeckStore.getState()
  active = {
    frameId,
    pluginId,
    label: `plugin:${pluginId}:${label}`.slice(0, 60),
    depth: 1,
    snapshot: store.deck,
    startedAt: Date.now(),
  }
  store.beginGroup(active.label)
}

function endTransaction(frameId: string, mode: 'commit' | 'rollback'): void {
  if (!active) return
  if (active.frameId !== frameId) throw abiError('transaction is owned by another frame')
  active.depth -= 1
  if (active.depth > 0) return
  const store = useDeckStore.getState()
  if (mode === 'commit') store.endGroup()
  else {
    // 未提交的 group 直接丢弃，deck 回滚到事务前快照（历史不回退）。
    store.setDeck(active.snapshot, { resetHistory: false })
  }
  active = null
  release()
}

/** 帧销毁/停用时的兜底回滚（宿主生命周期调用）。 */
export function rollbackFrameTransaction(frameId: string): void {
  if (!active || active.frameId !== frameId) return
  try {
    endTransaction(frameId, 'rollback')
  } catch {
    active = null
    release()
  }
}

export function activeTransactionFrame(): string | null {
  return active?.frameId ?? null
}

export function resetDeckApiForTests(): void {
  active = null
  queue = []
}

/* ------------------------------ 快照 ------------------------------ */

function deckOf(): NonNullable<ReturnType<typeof useDeckStore.getState>['deck']> {
  const deck = useDeckStore.getState().deck
  if (!deck) throw new Error('deck is not ready')
  return deck
}

function textCharsOf(blocks: Array<{ type: string; text?: string }>): number {
  let chars = 0
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') chars += plainText(block.text).replace(/\s+/g, '').length
  }
  return chars
}

export function deckSnapshot(locale: 'zh' | 'en' = 'zh'): DeckSnapshot {
  const deck = deckOf()
  const issues = lintDeck(deck)
  const summary = summarizeLint(issues)
  return {
    deckId: deck.id,
    title: deck.title,
    lang: deck.lang,
    themeId: deck.themeId,
    revision: useDeckStore.getState().revision,
    slides: deck.slides.map((slide) => {
      const textChars = textCharsOf(slide.blocks as Array<{ type: string; text?: string }>)
      return {
        id: slide.id,
        name: slide.name,
        recipe: slide.recipe,
        blockCount: slide.blocks.length,
        textChars,
        readingSeconds: Math.round((textChars / (locale === 'en' ? 2.6 : 4.2)) * 10) / 10,
      }
    }),
    activeSlideId: useUiStore.getState().activeSlideId,
    lint: summary,
  }
}

function activeSlideSnapshot(): SlideSnapshot | null {
  const deck = deckOf()
  const activeSlideId = useUiStore.getState().activeSlideId
  const slide = deck.slides.find((item) => item.id === activeSlideId) ?? deck.slides[0]
  if (!slide) return null
  const textChars = textCharsOf(slide.blocks as Array<{ type: string; text?: string }>)
  return {
    id: slide.id,
    name: slide.name,
    recipe: slide.recipe,
    background: slide.background,
    transition: slide.transition,
    blockCount: slide.blocks.length,
    textChars,
    readingSeconds: Math.round((textChars / (deck.lang === 'en' ? 2.6 : 4.2)) * 10) / 10,
    blocks: slide.blocks.map((block) => ({ id: block.id, type: block.type, x: block.x, y: block.y, w: block.w, h: block.h })),
  }
}

/* ------------------------------ 块校验 ------------------------------ */

const BLOCK_TYPES = new Set(['text', 'shape', 'image', 'svg', 'three', 'html'])

const BLOCK_FIELDS: Record<string, readonly string[]> = {
  text: ['text', 'variant', 'x', 'y', 'w', 'h', 'color', 'align', 'name'],
  shape: ['kind', 'fill', 'stroke', 'strokeWidth', 'radius', 'x', 'y', 'w', 'h', 'name'],
  image: ['assetId', 'fit', 'radius', 'caption', 'alt', 'x', 'y', 'w', 'h', 'name'],
  svg: ['source', 'viewBox', 'animate', 'x', 'y', 'w', 'h', 'name'],
  three: ['descriptor', 'interactive', 'bg', 'x', 'y', 'w', 'h', 'name'],
  html: ['html', 'css', 'x', 'y', 'w', 'h', 'name'],
}

/** 过滤平台字段 + 未知字段，然后用 schema 工厂校验/生成 id（非法 → `E-ABI-02`）。 */
function buildPluginBlock(call: ApiCall, input: unknown): ReturnType<typeof makeBlock> {
  const record = assertRecord(input, 'block')
  const type = record.type
  if (typeof type !== 'string' || !BLOCK_TYPES.has(type)) throw abiError(`block type "${String(type)}" is not allowed`)
  const allowed = BLOCK_FIELDS[type]
  const patch: Record<string, unknown> = {}
  for (const key of allowed) {
    const value = record[key]
    if (value === undefined) continue
    patch[key] = value
  }
  if (type === 'image') {
    const assetId = typeof patch.assetId === 'string' ? patch.assetId : ''
    if (!assetId) throw abiError('image block requires assetId')
  }
  patch.provenance = { provider: call.frame.pluginId, at: Date.now() }
  try {
    return makeBlock(type as Parameters<typeof makeBlock>[0], patch)
  } catch (error) {
    throw abiError('block payload is invalid', error instanceof Error ? error.message : String(error))
  }
}

function clampGeometry(block: ReturnType<typeof makeBlock>): void {
  const stage = { w: 1600, h: 900 }
  block.x = Math.max(-100, Math.min(stage.w, Number(block.x) || 0))
  block.y = Math.max(-100, Math.min(stage.h, Number(block.y) || 0))
  block.w = Math.max(8, Math.min(stage.w, Number(block.w) || 8))
  block.h = Math.max(8, Math.min(stage.h, Number(block.h) || 8))
}

function slideContaining(blockId: string): string | null {
  const deck = deckOf()
  for (const slide of deck.slides) {
    if (slide.blocks.some((block) => block.id === blockId)) return slide.id
  }
  return null
}

/* ------------------------------ 方法 ------------------------------ */

export async function handleDeck(method: string, payload: unknown, call: ApiCall): Promise<unknown> {
  switch (method) {
    case 'getSnapshot':
      return deckSnapshot(currentLocale())
    case 'getActiveSlide':
      return activeSlideSnapshot()
    case 'subscribe':
      // 订阅是帧内本地行为；宿主按 deck:read 能力推事件（events.ts）。
      return null
    case 'insertBlocks': {
      const body = assertRecord(payload, 'payload')
      const slideId = typeof body.slideId === 'string' ? body.slideId : null
      const deck = deckOf()
      const target = slideId ? deck.slides.find((slide) => slide.id === slideId) : deck.slides.find((slide) => slide.id === useUiStore.getState().activeSlideId) ?? deck.slides[0]
      if (!target) throw abiError('target slide does not exist')
      if (!Array.isArray(body.blocks)) throw abiError('blocks must be an array')
      if (body.blocks.length === 0) return { blockIds: [] as string[] }
      if (body.blocks.length > 100) throw abiError('insertBlocks accepts at most 100 blocks')
      // image 必须是本插件 asset:write 产出的 assetId（防引用他人素材），异步校验后再落块。
      for (const input of body.blocks) {
        const record = assertRecord(input, 'block')
        if (record.type !== 'image') continue
        const assetId = typeof record.assetId === 'string' ? record.assetId : ''
        if (!assetId) throw abiError('image block requires assetId')
        if (!(await hasPluginAsset(call.frame.pluginId, assetId))) {
          throw abiError(`image asset "${assetId}" was not produced by this plugin`)
        }
      }
      const blocks = body.blocks.map((input) => {
        const block = buildPluginBlock(call, input)
        clampGeometry(block)
        return block
      })
      useDeckStore.getState().beginGroup(`plugin:${call.frame.pluginId}:insert-blocks`.slice(0, 60))
      try {
        for (const block of blocks) blockOps.add(block, target.id)
      } finally {
        useDeckStore.getState().endGroup()
      }
      appendAudit({
        action: 'plugin.install',
        actor: 'plugin',
        result: 'ok',
        pluginId: call.frame.pluginId,
        detail: `deck.insertBlocks count:${blocks.length} slide:${target.id}`,
      })
      return { blockIds: blocks.map((block) => block.id) }
    }
    case 'updateBlock': {
      const body = assertRecord(payload, 'payload')
      const blockId = typeof body.blockId === 'string' ? body.blockId : ''
      if (!blockId) throw abiError('blockId is required')
      const patch = assertRecord(body.patch, 'patch')
      const slideId = slideContaining(blockId)
      if (!slideId) throw abiError(`block "${blockId}" does not exist`)
      const deck = deckOf()
      const slide = deck.slides.find((item) => item.id === slideId)
      const block = slide?.blocks.find((item) => item.id === blockId)
      if (!block) throw abiError(`block "${blockId}" does not exist`)
      const allowed = BLOCK_FIELDS[block.type] ?? []
      blockOps.update(
        blockId,
        (draft) => {
          for (const key of allowed) {
            if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
            const value = patch[key]
            if (value === undefined) continue
            if ((key === 'x' || key === 'y' || key === 'w' || key === 'h') && (typeof value !== 'number' || !Number.isFinite(value))) {
              throw abiError(`${key} must be a finite number`)
            }
            ;(draft as unknown as Record<string, unknown>)[key] = value
          }
        },
        { label: `plugin:${call.frame.pluginId}:update-block`.slice(0, 60), slideId },
      )
      return null
    }
    case 'transaction': {
      const body = assertRecord(payload, 'payload')
      const phase = body.phase === 'begin' || body.phase === 'commit' || body.phase === 'rollback' ? body.phase : null
      if (!phase) throw abiError('transaction phase must be begin/commit/rollback')
      if (phase === 'begin') {
        if (active && active.frameId === call.frame.frameId) {
          active.depth += 1
          return { token: body.token }
        }
        if (active) await acquire(call.frame.frameId)
        const label = typeof body.label === 'string' ? body.label.replace(/[^\w.-]/g, '').slice(0, 40) : 'tx'
        beginTransaction(call.frame.frameId, call.frame.pluginId, label || 'tx')
        return { token: body.token }
      }
      if (phase === 'rollback' && (!active || active.frameId !== call.frame.frameId)) return null
      if (!active || active.frameId !== call.frame.frameId) throw abiError('no active transaction')
      endTransaction(call.frame.frameId, phase === 'commit' ? 'commit' : 'rollback')
      return null
    }
    case 'applyTheme': {
      const body = assertRecord(payload, 'payload')
      const themeId = typeof body.themeId === 'string' ? body.themeId : ''
      if (!themeId) throw abiError('themeId is required')
      const allowed = (THEME_IDS as readonly string[]).includes(themeId) || getRegisteredThemes().some((entry) => entry.theme.id === themeId)
      if (!allowed) throw abiError(`theme "${themeId}" is not a built-in or installed plugin theme`)
      deckOps.setTheme(themeId)
      return null
    }
    default:
      throw abiError(`unknown deck method "${method}"`)
  }
}

/** 只读块级元数据（`LintRuleCtx` / `onPreflight` ctx 共用；不含块正文/备注/aiSnapshot，02 §5.3）。 */
export function readonlySlideMeta(): ReadonlySlideMeta[] {
  const deck = deckOf()
  return deck.slides.map((slide) => ({
    id: slide.id,
    blocks: slide.blocks.map((block) => {
      const meta: ReadonlySlideMeta['blocks'][number] = {
        id: block.id,
        type: block.type,
        x: block.x,
        y: block.y,
        w: block.w,
        h: block.h,
      }
      if (block.type === 'text') meta.textChars = plainText(block.text).replace(/\s+/g, '').length
      const presetId = (block as { presetId?: unknown }).presetId
      if (typeof presetId === 'string') meta.presetId = presetId
      return meta
    }),
  }))
}

/** 宿主内部用：当前 deck 主题的只读快照（theme api 复用）。 */
export function currentThemeSnapshot(): { id: string; name: { zh: string; en: string }; colors: Record<string, string> } {
  const deck = deckOf()
  const theme = getTheme(deck.themeId)
  const colors: Record<string, string> = {
    ...(theme.colors as unknown as Record<string, string>),
    ...((deck.themeOverrides ?? {}) as unknown as Record<string, string>),
  }
  return { id: theme.id, name: theme.name, colors }
}

/** 宿主内部用：当前 deck 的阅读秒数（诊断/预览用）。 */
export function deckReadingSeconds(text: string, lang: 'zh' | 'en'): number {
  return readingSeconds(text, lang)
}

export function registerDeckApi(): void {
  registerNamespaceApi('deck', {
    getSnapshot: (payload, call) => handleDeck('getSnapshot', payload, call),
    getActiveSlide: (payload, call) => handleDeck('getActiveSlide', payload, call),
    subscribe: (payload, call) => handleDeck('subscribe', payload, call),
    insertBlocks: (payload, call) => handleDeck('insertBlocks', payload, call),
    updateBlock: (payload, call) => handleDeck('updateBlock', payload, call),
    transaction: (payload, call) => handleDeck('transaction', payload, call),
    applyTheme: (payload, call) => handleDeck('applyTheme', payload, call),
  })
}
