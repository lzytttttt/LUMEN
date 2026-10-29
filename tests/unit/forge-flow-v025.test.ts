/**
 * forge-flow-v025.test.ts —— v0.2.5 流程状态层验收（`plan/v0.2.5/02` §2 §3.1–3.4）。
 *
 * 覆盖四组：
 * 1. reducer 六条硬约束（reset 保留项 / theme 相位门 / headline·brief 截断 / steer 只改未落位幕 / 材料上限 / 既有分支零变化）；
 * 2. 三个新模块的纯函数，重点喂坏数据（kv 读回的东西不可信，只能丢不能抛）；
 * 3. `liveOutline` 真的在每幕开始前重取大纲（steering 的唯一生效路径）；
 * 4. 旧 Outline（没有 `brief`）与旧草稿（没有 themeId/audience/materials）必须照常工作。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { buildDeckFromOutline, composeOutline } from '@/ai/compose'
import { outlineRequest, slideRequest } from '@/ai/prompts'
import { ForgeDraft } from '@/forge/draft'
import {
  MATERIAL_MAX,
  MATERIAL_TEXT_MAX,
  estimateTokens,
  makeMaterial,
  materialsBrief,
  materialsSummary,
  newMaterialId,
  normalizeMaterials,
} from '@/forge/materials'
import { REUSE_MAX, dropReuse, loadReuse, normalizeReuse, pushReuse } from '@/forge/sessions'
import { forgeReducer, initialForgeState, isLanded } from '@/forge/state'
import { STEER_TEXT_MAX, makeSteerNote, pendingSteer, steerLabel } from '@/forge/steer'
import type { ForgeAction, ForgeState, ReuseEntry, SteerNote } from '@/forge/types'
import { createSampleDeck } from '@/sample/sample-deck'
import { useDeckStore } from '@/state/deckStore'
import { useSettingsStore } from '@/state/settingsStore'
import { outlineSchema, slideSchema, type Outline, type RecipeId, type Slide } from '@/schema/deck'

/* ------------------------------- fixtures ------------------------------- */

const RECIPES: RecipeId[] = ['cover', 'statement', 'split', 'grid3', 'grid4', 'timeline', 'compare', 'quote', 'data', 'gallery', 'process', 'closing']

function outlineOf(count = 6): Outline {
  const recipes = Array.from({ length: count }, (_, index) => RECIPES[index % RECIPES.length])
  recipes[0] = 'cover'
  recipes[count - 1] = 'closing'
  return outlineSchema.parse({
    title: 'v0.2.5 状态层验收',
    lang: 'zh',
    slides: recipes.map((recipe, index) => ({
      recipe,
      headline: `第 ${index + 1} 幕`,
      points: ['一', '二'],
      visual: { kind: 'none' },
    })),
  })
}

function dealt(count = 6): ForgeState {
  return forgeReducer(initialForgeState(), { type: 'outline', outline: outlineOf(count) })
}

function casting(count = 6): ForgeState {
  return forgeReducer(dealt(count), { type: 'cast' })
}

function slideOf(id: string): Slide {
  return slideSchema.parse({ id })
}

function dispatch(state: ForgeState, action: ForgeAction): ForgeState {
  return forgeReducer(state, action)
}

/** 让第 index 幕真正落位（先过检再落位，reducer 才认）。 */
function land(state: ForgeState, index: number): ForgeState {
  const gated = forgeReducer(state, { type: 'stageEvent', event: { type: 'slide:gate', index, errors: [], warns: [] } })
  return forgeReducer(gated, { type: 'stageEvent', event: { type: 'slide:landed', index, slide: slideOf(`slide-${index}`) } })
}

const material = (text: string, label = '材料') => makeMaterial({ kind: 'paste', label, text })

/* ------------------------------ 1. reducer ------------------------------ */

describe('forgeReducer · v0.2.5 六条硬约束', () => {
  it('约束 1：reset 保留偏好（含材料），清空 steer / prompt / outline / reuse', () => {
    let state = dealt(6)
    state = dispatch(state, { type: 'prompt', value: '一句话' })
    state = dispatch(state, { type: 'audience', value: 'exec' })
    state = dispatch(state, { type: 'theme', themeId: 'signal' })
    state = dispatch(state, { type: 'material:add', material: material('用户原话一') })
    state = dispatch(state, { type: 'brief', index: 1, value: '这一页讲取舍' })
    const note = makeSteerNote('后面几幕更短', 2)
    expect(note).not.toBeNull()
    state = dispatch(state, { type: 'steer', note: note! })

    const after = dispatch(state, { type: 'reset' })
    expect(after.phase).toBe('seed')
    expect(after.prompt).toBe('')
    expect(after.outline).toBeNull()
    expect(after.steer).toEqual([])
    expect(after.reuse).toEqual([])
    expect(after.audience).toBe('exec')
    expect(after.themeId).toBe('signal')
    expect(after.materials.map((item) => item.text)).toEqual(['用户原话一'])
    expect(after.lang).toBe(state.lang)
    expect(after.durationMin).toBe(state.durationMin)
    expect(after.autoPremiere).toBe(state.autoPremiere)
  })

  it('约束 2：theme 只在 seed / deal 有效，casting / premiere 一律返回原 state', () => {
    const seed = initialForgeState()
    expect(dispatch(seed, { type: 'theme', themeId: 'paper' }).themeId).toBe('paper')

    const deal = dealt(6)
    expect(dispatch(deal, { type: 'theme', themeId: 'paper' }).themeId).toBe('paper')

    const cast = casting(6)
    expect(dispatch(cast, { type: 'theme', themeId: 'paper' })).toBe(cast)

    const premiere: ForgeState = { ...deal, phase: 'premiere', deck: null }
    expect(dispatch(premiere, { type: 'theme', themeId: 'paper' })).toBe(premiere)
  })

  it('约束 3：headline 空串忽略、截 120；brief 截 200 且空串移除键', () => {
    const state = dealt(6)
    expect(dispatch(state, { type: 'headline', index: 1, value: '   ' })).toBe(state)
    expect(dispatch(state, { type: 'headline', index: 99, value: '越界' })).toBe(state)

    const renamed = dispatch(state, { type: 'headline', index: 1, value: '  换一个标题  ' })
    expect(renamed.slides[1].headline).toBe('换一个标题')
    expect(renamed.outline?.slides[1].headline).toBe('换一个标题')
    // 其余幕不受影响。
    expect(renamed.slides[2].headline).toBe(state.slides[2].headline)

    const long = dispatch(state, { type: 'headline', index: 1, value: '长'.repeat(200) })
    expect(long.slides[1].headline).toHaveLength(120)

    const briefed = dispatch(state, { type: 'brief', index: 2, value: '讲'.repeat(300) })
    expect(briefed.outline?.slides[2].brief).toHaveLength(200)
    expect(dispatch(briefed, { type: 'brief', index: 2, value: '  ' }).outline?.slides[2]).not.toHaveProperty('brief')
    expect(dispatch(state, { type: 'brief', index: 99, value: '越界' })).toBe(state)
  })

  it('约束 4：steer 越界不入队；只改 fromIndex 之后的未落位幕，已落位幕不动', () => {
    const state = land(casting(6), 1)
    expect(isLanded(state.slides[1].status)).toBe(true)

    const invalid = makeSteerNote('后面几幕更短', 9)
    expect(invalid).not.toBeNull()
    expect(dispatch(state, { type: 'steer', note: invalid! })).toBe(state)
    expect(dispatch(state, { type: 'steer', note: { ...invalid!, fromIndex: -1 } })).toBe(state)

    const note = makeSteerNote('后面几幕更短', 1)!
    const next = dispatch(state, { type: 'steer', note })
    expect(next.steer).toHaveLength(1)
    // 已落位的第 2 幕（index 1）不追溯改写。
    expect(next.outline?.slides[1]).not.toHaveProperty('brief')
    expect(next.outline?.slides[0]).not.toHaveProperty('brief')
    // fromIndex 之后、未落位的幕全部带上这句要求。
    expect(next.outline?.slides[2].brief).toBe('后面几幕更短')
    expect(next.outline?.slides[5].brief).toBe('后面几幕更短')

    // 第二条用「；」追加；累计超过 200 字后截断。
    const again = dispatch(next, { type: 'steer', note: makeSteerNote('要点更短', 2)! })
    expect(again.outline?.slides[3].brief).toBe('后面几幕更短；要点更短')
    expect(again.outline?.slides[2].brief).toBe('后面几幕更短；要点更短')

    let capped = state
    for (let i = 0; i < 4; i += 1) capped = dispatch(capped, { type: 'steer', note: makeSteerNote('十'.repeat(60), 0)! })
    expect(capped.outline?.slides[5].brief?.length).toBe(200)
  })

  it('约束 4b：steer:remove 摘掉那句要求，且能撤到 brief 彻底消失', () => {
    const state = casting(6)
    const note = makeSteerNote('别再用形容词', 2)!
    const applied = dispatch(state, { type: 'steer', note })
    expect(applied.outline?.slides[2].brief).toBe('别再用形容词')

    const undone = dispatch(applied, { type: 'steer:remove', id: note.id })
    expect(undone.steer).toEqual([])
    expect(undone.outline?.slides[2]).not.toHaveProperty('brief')
    // 不存在的 id 原样返回，连点安全。
    expect(dispatch(undone, { type: 'steer:remove', id: 'st-nope' })).toBe(undone)

    // 中间位置也能精确摘掉（前面还有别的要求时不留悬空「；」）。
    let stacked = dispatch(state, { type: 'steer', note: makeSteerNote('第一条要求', 2)! })
    stacked = dispatch(stacked, { type: 'steer', note })
    const middle = dispatch(stacked, { type: 'steer:remove', id: note.id })
    expect(middle.outline?.slides[2].brief).toBe('第一条要求')
  })

  it('约束 5：材料上限 5，第 6 条返回原 state', () => {
    let state = initialForgeState()
    for (let i = 0; i < MATERIAL_MAX; i += 1) {
      state = dispatch(state, { type: 'material:add', material: material(`材料 ${i}`) })
    }
    expect(state.materials).toHaveLength(MATERIAL_MAX)
    expect(dispatch(state, { type: 'material:add', material: material('第六条') })).toBe(state)

    const removed = dispatch(state, { type: 'material:remove', id: state.materials[0].id })
    expect(removed.materials).toHaveLength(MATERIAL_MAX - 1)
    // 删掉一条之后又能加回来。
    expect(dispatch(removed, { type: 'material:add', material: material('补位') }).materials).toHaveLength(MATERIAL_MAX)
  })

  it('约束 6：既有分支不被新字段干扰（option / swap / cast 行为不变）', () => {
    let state = dealt(9)
    state = dispatch(state, { type: 'material:add', material: material('不影响卡阵') })
    const swapped = dispatch(state, { type: 'swap', index: 1 })
    expect(swapped.slides[1].recipe).toBe('split')
    expect(swapped.outline?.slides[1].recipe).toBe('split')
    expect(swapped.materials).toEqual(state.materials)

    // 首末锁照旧。
    expect(dispatch(state, { type: 'swap', index: 0 })).toBe(state)
    expect(dispatch(state, { type: 'swap', index: 8 })).toBe(state)

    const cast = dispatch(swapped, { type: 'cast' })
    expect(cast.phase).toBe('casting')
    expect(cast.materials).toEqual(state.materials)
    expect(cast.steer).toEqual([])

    const optioned = dispatch(state, { type: 'option', patch: { length: 'deep' } })
    expect(optioned.length).toBe('deep')
    expect(optioned.materials).toEqual(state.materials)
  })

  it('add 之后大纲每一幕都完整（缺 visual/points 会在生成期炸成「网络断了」）', () => {
    let state = dealt(9)
    for (let i = 0; i < 3; i += 1) state = dispatch(state, { type: 'add' })
    expect(state.slides).toHaveLength(12)
    expect(state.outline?.slides).toHaveLength(12)
    for (const [index, slide] of (state.outline?.slides ?? []).entries()) {
      expect(slide.visual, `第 ${index + 1} 幕 visual`).toBeTruthy()
      expect(Array.isArray(slide.points), `第 ${index + 1} 幕 points`).toBe(true)
      expect(slide.headline.length, `第 ${index + 1} 幕 headline`).toBeGreaterThan(0)
    }
    // 整份大纲仍然过 schema（残缺项的第一道红灯）。
    expect(outlineSchema.safeParse(state.outline).success).toBe(true)
    // 卡片与大纲逐项对齐：recipe / headline 一致。
    expect(state.outline?.slides.map((slide) => slide.recipe)).toEqual(state.slides.map((slide) => slide.recipe))
  })
})

/* ---------------------------- 2. 纯函数与坏数据 ---------------------------- */

describe('forge/materials', () => {
  it('estimateTokens 按 ceil(len/2.2) 估算', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcde')).toBe(3)
    expect(estimateTokens('a'.repeat(22))).toBe(10)
  })

  it('makeMaterial 截断正文、算 tokens、label 兜底截 24 字符', () => {
    const long = makeMaterial({ kind: 'paste', label: '', text: 'x'.repeat(MATERIAL_TEXT_MAX + 500) })
    expect(long.text).toHaveLength(MATERIAL_TEXT_MAX)
    expect(long.tokens).toBe(estimateTokens(long.text))
    expect(long.status).toBe('ready')
    expect(long.label).toHaveLength(24)

    const labelled = makeMaterial({ kind: 'url', label: '定价页摘录', text: '一段原文' })
    expect(labelled.label).toBe('定价页摘录')
    expect(labelled.kind).toBe('url')
    expect(labelled.at).toBeGreaterThan(0)
  })

  it('newMaterialId 形状稳定且不重复', () => {
    const a = newMaterialId()
    const b = newMaterialId()
    expect(a).toMatch(/^mat-\d+-[a-z0-9]{4}$/)
    expect(a).not.toBe(b)
  })

  it('normalizeMaterials 吞掉一切坏数据，绝不抛', () => {
    expect(normalizeMaterials(null)).toEqual([])
    expect(normalizeMaterials('nope')).toEqual([])
    expect(normalizeMaterials({})).toEqual([])
    expect(normalizeMaterials([null, 1, 'x', [], { id: '' }])).toEqual([])

    const ok = makeMaterial({ kind: 'file', label: '纪要', text: '正文' })
    const dirty = [
      { ...ok, id: 'mat-1-aaaa', kind: 'pdf' },
      { ...ok, id: 'mat-2-bbbb', status: 'whatever' },
      { ...ok, id: 'mat-3-cccc', text: 'Y'.repeat(MATERIAL_TEXT_MAX + 10) },
      'garbage',
      { ...ok, id: 'mat-4-dddd' },
    ]
    const normalized = normalizeMaterials(dirty)
    expect(normalized.map((item) => item.id)).toEqual(['mat-2-bbbb', 'mat-3-cccc', 'mat-4-dddd'])
    expect(normalized[0].status).toBe('ready')
    expect(normalized[1].text).toHaveLength(MATERIAL_TEXT_MAX)
    expect(normalized[2].tokens).toBe(estimateTokens('正文'))

    // 超过上限只留前 5 条。
    const many = Array.from({ length: MATERIAL_MAX + 3 }, (_, i) => ({ ...ok, id: `mat-${i}-zzzz` }))
    expect(normalizeMaterials(many)).toHaveLength(MATERIAL_MAX)
  })

  it('materialsBrief / materialsSummary 守 5 条 × 200 字预算', () => {
    expect(materialsBrief([], 'zh')).toBe('')
    const materials = Array.from({ length: MATERIAL_MAX + 2 }, (_, i) => material('文'.repeat(300), `料${i}`))
    const zh = materialsBrief(materials, 'zh')
    expect(zh.startsWith('材料（原文节选）：')).toBe(true)
    expect(zh.split('\n')).toHaveLength(1 + MATERIAL_MAX)
    for (const line of zh.split('\n').slice(1)) {
      expect(line.length).toBeLessThanOrEqual(200 + '料0'.length + 8)
    }
    expect(materialsBrief(materials, 'en').startsWith('Sources')).toBe(true)
    expect(materialsSummary(materials.slice(0, 2))).toBe(`materials 2/${MATERIAL_MAX} · 600 chars`)
  })
})

describe('forge/steer', () => {
  it('makeSteerNote 拒绝空串与非法幕序号，文本截 60', () => {
    expect(makeSteerNote('', 0)).toBeNull()
    expect(makeSteerNote('   ', 3)).toBeNull()
    expect(makeSteerNote('有内容', -1)).toBeNull()
    expect(makeSteerNote('有内容', Number.NaN)).toBeNull()
    const note = makeSteerNote('更'.repeat(100), 2)
    expect(note?.text).toHaveLength(STEER_TEXT_MAX)
    expect(note?.fromIndex).toBe(2)
    expect(note?.id).toMatch(/^st-\d+-[a-z0-9]{4}$/)
  })

  it('pendingSteer 只留还没到边界的条目', () => {
    const notes: SteerNote[] = [
      { id: 'st-1', text: 'a', fromIndex: 1, at: 0 },
      { id: 'st-2', text: 'b', fromIndex: 3, at: 0 },
      { id: 'st-3', text: 'c', fromIndex: 5, at: 0 },
    ]
    expect(pendingSteer(notes, 0).map((note) => note.id)).toEqual(['st-1', 'st-2', 'st-3'])
    expect(pendingSteer(notes, 3).map((note) => note.id)).toEqual(['st-3'])
    expect(pendingSteer(notes, 6)).toEqual([])
  })

  it('steerLabel 只给「第 n 幕起生效」半句，过期 / 越界返回空串', () => {
    const notes: SteerNote[] = [
      { id: 'st-1', text: 'a', fromIndex: 3, at: 0 },
      { id: 'st-2', text: 'b', fromIndex: 5, at: 0 },
    ]
    expect(steerLabel([], 6, 'zh')).toBe('')
    expect(steerLabel(notes, 6, 'zh')).toBe('第 4 幕起生效')
    expect(steerLabel(notes, 6, 'en')).toBe('From slide 4')
    // 越界的条目（幕数缩小后）不再参与。
    expect(steerLabel(notes, 3, 'zh')).toBe('')
  })
})

describe('forge/sessions', () => {
  const entry = (title: string): Omit<ReuseEntry, 'id' | 'at'> => ({
    title,
    prompt: '一句话',
    themeId: 'noir',
    count: 6,
    outline: outlineOf(6),
  })

  it('normalizeReuse 丢坏数据、守住上限', () => {
    expect(normalizeReuse(null)).toEqual([])
    expect(normalizeReuse('nope')).toEqual([])
    const bad = [{ id: 'r1' }, { id: 'r2', title: '有标题没大纲' }, { id: '', title: '空 id', outline: outlineOf(6) }, 7]
    expect(normalizeReuse(bad)).toEqual([])

    const good = { id: 'r-good', title: '好的一套', prompt: 'p', themeId: 'noir', count: 6, at: 1, outline: outlineOf(6) }
    const list = normalizeReuse([good, ...bad])
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('r-good')
    expect(list[0].outline.slides).toHaveLength(6)

    const many = Array.from({ length: REUSE_MAX + 3 }, (_, i) => ({ ...good, id: `r-${i}` }))
    expect(normalizeReuse(many)).toHaveLength(REUSE_MAX)
  })

  it('pushReuse / loadReuse / dropReuse 走 kv 往返，坏 id 不抛', async () => {
    const list = await pushReuse(entry('刚做完的一套'))
    const mine = list.find((item) => item.title === '刚做完的一套')
    expect(mine).toBeTruthy()
    expect(mine?.outline.slides).toHaveLength(6)
    expect(list.length).toBeLessThanOrEqual(REUSE_MAX)

    const loaded = await loadReuse()
    expect(loaded.some((item) => item.id === mine!.id)).toBe(true)

    const dropped = await dropReuse(mine!.id)
    expect(dropped.some((item) => item.id === mine!.id)).toBe(false)
    // 删不存在的 id 也不抛。
    await expect(dropReuse('reuse-nope')).resolves.toBeInstanceOf(Array)
  })
})

/* ------------------------------ 3. liveOutline ------------------------------ */

describe('ai/compose · liveOutline 与材料透传', () => {
  const INPUT = {
    prompt: '给设计团队讲一次：为什么我们的演示该换成 HTML',
    lang: 'zh' as const,
    length: 'short' as const,
    includeSvg: true,
    include3d: true,
  }

  beforeEach(() => {
    useSettingsStore.getState().hydrate(null)
    useDeckStore.getState().setDeck(createSampleDeck('zh'), { resetHistory: true })
  })

  it('每幕开始前重取大纲：实时改写的那一幕进 deck', async () => {
    const outline = (await composeOutline(INPUT)).outline
    let reads = 0
    const liveOutline = (): Outline => {
      reads += 1
      return {
        ...outline,
        slides: outline.slides.map((slide, index) => (index === 1 ? { ...slide, headline: '实时改写的一幕' } : slide)),
      }
    }
    const { deck } = await buildDeckFromOutline(outline, { prompt: INPUT.prompt, persist: false, liveOutline })

    // 每一幕都重取一次（并发 2 也不影响「每幕一次」的语义）。
    expect(reads).toBeGreaterThanOrEqual(outline.slides.length)
    expect(deck.slides[1].name).toBe('实时改写的一幕')
    expect(deck.slides[2].name).toBe(outline.slides[2].headline.replace(/\n/g, ' ').slice(0, 60))
  })

  it('实时大纲缺这一幕时退回入参大纲，不缺幕也不抛', async () => {
    const outline = (await composeOutline({ ...INPUT, length: 'normal' })).outline
    const liveOutline = (): Outline => ({ ...outline, slides: outline.slides.slice(0, 2) })
    const { deck } = await buildDeckFromOutline(outline, { prompt: INPUT.prompt, persist: false, liveOutline })
    expect(deck.slides).toHaveLength(outline.slides.length)
    expect(deck.slides[4].name).toBe(outline.slides[4].headline.replace(/\n/g, ' ').slice(0, 60))
  })

  it('slideRequest 把 brief 与 materials 带进 payload（5 条 × 200 字）', () => {
    const outline = outlineOf(5)
    const oldSlide = outline.slides[0]
    expect(oldSlide).not.toHaveProperty('brief')

    const withBrief: Outline = {
      ...outline,
      slides: outline.slides.map((slide, index) => (index === 0 ? { ...slide, brief: '先给结论再给证据' } : slide)),
    }
    const payload = JSON.parse(
      slideRequest({
        outline: withBrief,
        slide: withBrief.slides[0],
        index: 0,
        lang: 'zh',
        materials: Array.from({ length: 7 }, (_, i) => ({ label: `料${i}`, text: '原'.repeat(300) })),
      }).user,
    )
    expect(payload.brief).toBe('先给结论再给证据')
    expect(payload.materials).toHaveLength(5)
    expect(payload.materials[0].text).toHaveLength(200)

    // 旧 Outline 没有 brief：兜成空串，不抛。
    const legacy = JSON.parse(slideRequest({ outline, slide: oldSlide, index: 0, lang: 'zh' }).user)
    expect(legacy.brief).toBe('')
    // 没有材料时整段不出现：默认值下 prompt 与 v0.2.0 逐字节一致。
    expect(legacy.materials).toBeUndefined()
  })

  it('outlineRequest payload 带上材料摘要（无材料时不出现该键）', () => {
    const payload = JSON.parse(
      outlineRequest({
        ...INPUT,
        materials: [{ label: '定价页', text: '基础版 99 元' }],
      }).user,
    )
    expect(payload.materials).toEqual([{ label: '定价页', text: '基础版 99 元' }])
    expect(JSON.parse(outlineRequest(INPUT).user).materials).toBeUndefined()
  })

  it('旧 Outline（无 brief）整盘生成照常，行为与默认值一致', async () => {
    const outline = (await composeOutline(INPUT)).outline
    expect(outline.slides.every((slide) => !('brief' in slide) || typeof slide.brief === 'string')).toBe(true)
    const { deck, warnings } = await buildDeckFromOutline(outline, { prompt: INPUT.prompt, persist: false })
    expect(deck.slides).toHaveLength(outline.slides.length)
    expect(warnings.filter((warning) => warning.includes('lint still'))).toEqual([])
  })

  it('连加三幕后再生成：不再抛非 AiError（e2e「再加几幕」的真实路径）', async () => {
    const outline = (await composeOutline(INPUT)).outline
    let state = forgeReducer(initialForgeState(), { type: 'outline', outline })
    for (let i = 0; i < 3; i += 1) state = dispatch(state, { type: 'add' })
    const cast = dispatch(state, { type: 'cast' })
    expect(cast.total).toBe(outline.slides.length + 3)

    // 修好之前这里会抛 TypeError（visualOf 读 undefined.kind），台面上显示成「网络断了」。
    const { deck } = await buildDeckFromOutline(cast.outline!, { prompt: INPUT.prompt, persist: false })
    expect(deck.slides).toHaveLength(cast.total)
    expect(deck.slides.every((slide) => slide.blocks.length > 0)).toBe(true)
  })
})

/* -------------------------------- 4. 草稿 -------------------------------- */

describe('forge/draft · v0.2.5 草稿结构', () => {
  const legacyRaw = {
    v: 1,
    prompt: '旧草稿',
    lang: 'zh',
    title: '旧标题',
    outline: outlineOf(4),
    done: 2,
    at: 1,
  }

  it('旧草稿（只有 v/prompt/lang/title/outline/done/at）仍然 parse', () => {
    const draft = ForgeDraft.parse(legacyRaw)
    expect(draft).not.toBeNull()
    expect(draft?.title).toBe('旧标题')
    expect(draft?.done).toBe(2)
    expect(draft?.themeId).toBe('')
    expect(draft?.audience).toBe('')
    expect(draft?.materials).toEqual([])
  })

  it('新草稿带 themeId / audience / materials，坏材料静默丢弃', () => {
    const materials = [material('原文一', '料一'), material('原文二', '料二')]
    const draft = ForgeDraft.parse({
      ...legacyRaw,
      themeId: 'signal',
      audience: 'client',
      materials: [...materials, 'garbage', { id: 'mat-x', kind: 'nope', text: 'x' }],
    })
    expect(draft?.themeId).toBe('signal')
    expect(draft?.audience).toBe('client')
    expect(draft?.materials.map((item) => item.label)).toEqual(['料一', '料二'])
  })

  it('坏草稿（v 不对 / 大纲不合法 / 超大）一律 null', () => {
    expect(ForgeDraft.parse(null)).toBeNull()
    expect(ForgeDraft.parse({ ...legacyRaw, v: 2 })).toBeNull()
    expect(ForgeDraft.parse({ ...legacyRaw, outline: { title: 'x', slides: [] } })).toBeNull()
    const huge = { ...legacyRaw, prompt: 'x'.repeat(70 * 1024) }
    expect(ForgeDraft.parse(huge)).toBeNull()
  })
})
