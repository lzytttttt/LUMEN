/**
 * tests/unit/contract/decks.test.ts —— 兼容回归 C-40-01 / C-40-02（旧工程文件解析）。
 *
 * 夹具来源（真实导出，非手写）：
 *   - tests/fixtures/decks/v020/sample-v0.2.0.lumen.json：`git archive v0.2.0` 干净副本里
 *     用该版本代码 `createSampleDeck('zh')` 导出（v0.2.0 的 deckFileSchema）；
 *   - v025 / v030 同理（v0.2.5 标签、v0.3.0 = 07ed71e）。
 * 生成后只做**去随机化**（deck/slide/block id 与 meta 时间固定），不改任何业务字段；
 * 无个人信息、无外链、无密钥。
 *
 * 判据（06 §4.6）：三版文件打开/编辑/播放全通过 → 本文件覆盖「解析 + 关键字段原样」；
 * 播放/导出在 e2e 由 compat 场景覆盖（task-10）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deckFileSchema } from '@/schema/deck'
import { parseDeck, parseDeckFile } from '@/schema/migrate'

const DECKS = join(process.cwd(), 'tests', 'fixtures', 'decks')
const FIXTURES = [
  { version: 'v0.2.0', tag: '020', path: join(DECKS, 'v020', 'sample-v0.2.0.lumen.json') },
  { version: 'v0.2.5', tag: '025', path: join(DECKS, 'v025', 'sample-v0.2.5.lumen.json') },
  { version: 'v0.3.0', tag: '030', path: join(DECKS, 'v030', 'sample-v0.3.0.lumen.json') },
] as const

function load(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

describe('C-40-01/C-40-02 旧工程文件（.lumen.json）三版解析', () => {
  it.each(FIXTURES)('$version：parseDeckFile / deckFileSchema 双通过', ({ path }) => {
    const raw = load(path)
    const outcome = parseDeckFile(raw)
    expect(outcome.issues, JSON.stringify(outcome.issues)).toEqual([])
    expect(outcome.ok).toBe(true)
    expect(deckFileSchema.safeParse(raw).success, 'zod 直判也应通过').toBe(true)

    const file = outcome.value!
    expect(file.kind).toBe('lumen.deck')
    expect(file.schemaVersion).toBe(1)
    expect(file.assets).toEqual({})
    expect(file.deck.slides).toHaveLength(9)
    expect(file.deck.themeId).toBe('noir')
    expect(file.deck.lang).toBe('zh')
    expect(file.deck.aspect).toBe('16:9')
  })

  it.each(FIXTURES)('$version：关键字段原样（标题/幕名/块数与块类型/notes 不丢）', ({ path, tag }) => {
    const file = deckFileSchema.parse(load(path))
    expect(file.deck.title).toBe('演示，该换一种载体了')
    expect(file.deck.id).toBe(`deck_fixture_v${tag}`)
    expect(file.deck.meta.origin).toBe('sample')

    const slideNames = file.deck.slides.map((slide) => slide.name)
    expect(slideNames.every((name) => typeof name === 'string' && name.length > 0), JSON.stringify(slideNames)).toBe(true)

    const blockCount = file.deck.slides.reduce((sum, slide) => sum + slide.blocks.length, 0)
    expect(blockCount).toBe(89)
    const types = new Set(file.deck.slides.flatMap((slide) => slide.blocks.map((block) => block.type)))
    for (const type of ['text', 'svg', 'three'] as const) {
      expect(types, `样例演示应覆盖 ${type} 块`).toContain(type)
    }
    // 备注（v0.2.0 起就有）不丢
    expect(file.deck.slides.some((slide) => typeof slide.notes === 'string' && slide.notes.length > 0)).toBe(true)
  })

  it('三版导出物除版本标记/随机 id 外内容一致（同源示例演示，无字段回退丢失）', () => {
    const [v020, v025, v030] = FIXTURES.map(({ path }) => deckFileSchema.parse(load(path)))
    const strip = (file: typeof v020) =>
      JSON.stringify({
        ...file.deck,
        id: '',
        meta: { ...file.deck.meta, createdAt: 0, updatedAt: 0 },
        slides: file.deck.slides.map((slide) => ({
          ...slide,
          id: '',
          blocks: slide.blocks.map((block) => ({ ...block, id: '' })),
        })),
      })
    expect(strip(v025)).toBe(strip(v020))
    expect(strip(v030)).toBe(strip(v020))
  })

  it('parseDeck 允许直接导入裸 deck（无 kind 包装，v0.2.0 时代的兼容路径）', () => {
    const raw = load(FIXTURES[0].path) as { deck: unknown }
    const outcome = parseDeck(raw.deck)
    expect(outcome.ok).toBe(true)
    expect(outcome.value!.slides).toHaveLength(9)
  })

  it('损坏文件不崩：非对象 / 缺 slides / 非 JSON 文本给出 issues', () => {
    expect(parseDeckFile(null).ok).toBe(false)
    expect(parseDeckFile([]).ok).toBe(false)
    expect(parseDeckFile({ deck: { title: 'x' } }).ok).toBe(false)
    expect(() => parseDeckFile(JSON.parse('{'))).toThrow()
  })
})
