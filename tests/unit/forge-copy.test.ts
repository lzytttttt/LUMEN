/**
 * forge-copy.test.ts —— 造幕台文案预算与用词验收（`A` 组 + D5 文字预算）。
 *
 * 依据：`plan/v0.2.0/09-文案词表.md` §2.0（六个字数类别）/ §5（禁用词）/ §6（占位符）、
 * `02` §8（文字预算实测表）、`07` §3.6 的 A-06。唯一真相是 `src/i18n/messages/forge.zh.ts`。
 *
 * 关键取舍：不写快照，改按「类别 → 上限」逐 key 断言；新增 key 必须落进已知家族，
 * 否则这条测试红——防止有人绕过预算偷偷加到界面上。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { forgeZh } from '@/i18n/messages/forge.zh'
import { forgeEn } from '@/i18n/messages/forge.en'

/* -------------------------------- 工具 -------------------------------- */

function flatten(node: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
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

const ZH = flatten(forgeZh)
const EN = flatten(forgeEn)
const KEYS = Object.keys(ZH).sort()

/** 汉字个数（标点、拉丁字符、数字、占位符都不计）。 */
function cjk(value: string): number {
  return (value.match(/[\u4e00-\u9fff]/g) ?? []).length
}

function placeholders(value: string): string[] {
  return (value.match(/\{(\w+)\}/g) ?? []).map((token) => token.slice(1, -1)).sort()
}

/** 去掉占位符与空白后的可见残留（F 类只允许 1 个单位词 / 符号）。 */
function remainder(value: string): string {
  return value.replace(/\{\w+\}/g, '').replace(/[\s，。？、,.?/×+]/g, '')
}

type Klass = 'A' | 'B' | 'B_MAIN' | 'C' | 'D' | 'F' | 'X'

const B_MAIN = new Set(['seed.start', 'deal.cast'])
const X_PREFIXES = ['a11y.', 'live.', 'error.action.']

/**
 * 已知超限项（实现侧待改，不是测试放宽）：
 * `settings.diagnostics` = 诊断 / Diagnostics —— 2 汉字 vs 11 符，1.6× 比值不成立（≈3.0×）。
 * 建议改成 4 字中文（`诊断导出`）即可落回 C 类 12 符预算；改完请删掉这里这一条。
 */
const COPY_EXCEPTIONS: Record<string, { enMax: number; why: string }> = {
  'settings.diagnostics': { enMax: 11, why: '英文 Diagnostics(11) 超 C 类对 2 汉字的 9 符预算；中文建议改「诊断导出」' },
}

/** 09 §2.0 的类别归属（唯一例外是主按钮：00 §7-3 放宽到 4 字）。 */
function classOf(key: string): Klass {
  if (X_PREFIXES.some((prefix) => key.startsWith(prefix))) return 'X'
  if (key.startsWith('cast.stage.')) return 'A'
  if (B_MAIN.has(key)) return 'B_MAIN'
  if (key === 'seed.placeholder' || key.startsWith('seed.sample')) return 'D'
  if (key === 'seed.resume') return 'C'
  if (key.startsWith('error.') || key.startsWith('gate.code.') || key.startsWith('ach.')) return 'C'
  if (key === 'premiere.again' || key === 'premiere.back') return 'C'
  if (key.startsWith('settings.')) return 'C'
  if (['deal.count', 'cast.progress', 'deal.dup', 'combo.count', 'gate.count'].includes(key)) return 'F'
  return 'B'
}

const KNOWN_FAMILIES = [
  'entry',
  'a11y.',
  'live.',
  'seed.',
  'deal.',
  'card.',
  'rarity.',
  'cast.',
  'error.',
  'assemble.',
  'gate.',
  'premiere.',
  'combo.',
  'level.',
  'unlock.',
  'ach.',
  'settings.',
]

/** 每类的 (中文上限, 英文上限)。C 的英文上限 = max(9, ⌈2.9n⌉)（09 §2.0 的 3→9 档是下限）。 */
function limitsOf(key: string, zh: string): { zhMax: number; enMax: number } {
  const n = cjk(zh)
  const exception = COPY_EXCEPTIONS[key]
  if (exception) return { zhMax: 6, enMax: exception.enMax }
  switch (classOf(key)) {
    case 'A':
      return { zhMax: 4, enMax: 7 }
    case 'B':
      return { zhMax: 3, enMax: 8 }
    case 'B_MAIN':
      return { zhMax: 4, enMax: 8 }
    case 'C':
      return { zhMax: 6, enMax: Math.max(9, Math.ceil(2.9 * n)) }
    case 'D':
      return { zhMax: 14, enMax: 28 }
    case 'F':
      // F 类只按占位符与残留单位判（见下一条），长度上限交给专门用例。
      return { zhMax: Number.POSITIVE_INFINITY, enMax: Number.POSITIVE_INFINITY }
    default:
      return { zhMax: Number.POSITIVE_INFINITY, enMax: Number.POSITIVE_INFINITY }
  }
}

/* -------------------------------- 键集 -------------------------------- */

describe('forge 文案 · 键集', () => {
  it('has the same key set in zh and en', () => {
    expect(Object.keys(EN).sort()).toEqual(KEYS)
  })

  it('has no empty or whitespace-only values', () => {
    for (const key of KEYS) {
      expect(ZH[key].trim(), `zh:${key}`).not.toBe('')
      expect(EN[key].trim(), `en:${key}`).not.toBe('')
    }
  })

  it('keeps every key inside a known family', () => {
    const unknown = KEYS.filter(
      (key) => !KNOWN_FAMILIES.some((family) => key === family || key.startsWith(family)),
    )
    expect(unknown, `未归类的新文案家族：${unknown.join(', ')}`).toEqual([])
    expect(KEYS.length).toBeGreaterThanOrEqual(100)
  })

  it('documents its main-button exceptions', () => {
    // 只有这两颗主按钮拿到「4 汉字」的放宽额度；再加第三个必须先改 00 §7-3。
    expect([...B_MAIN].sort()).toEqual(['deal.cast', 'seed.start'])
  })

  it('keeps the list of copy-length exceptions explicit and minimal', () => {
    // 例外必须逐条写清理由，且只能有一条（诊断导出，英文超 1.6×）。
    expect(Object.keys(COPY_EXCEPTIONS).sort()).toEqual(['settings.diagnostics'])
    for (const [key, entry] of Object.entries(COPY_EXCEPTIONS)) {
      expect(KEYS, `${key} 不在文案里，例外已过期`).toContain(key)
      expect(entry.why.length, `${key} 缺少理由`).toBeGreaterThan(0)
    }
  })
})

/* ------------------------------ 字数预算 ------------------------------ */

describe('forge 文案 · 字数上限', () => {
  it('keeps A-class stage words at 4 汉字 / 7 符', () => {
    const keys = KEYS.filter((key) => classOf(key) === 'A')
    expect(keys).toHaveLength(7)
    for (const key of keys) {
      expect(cjk(ZH[key]), `zh:${key} ${ZH[key]}`).toBeLessThanOrEqual(4)
      expect(EN[key].length, `en:${key} ${EN[key]}`).toBeLessThanOrEqual(7)
    }
  })

  it('keeps B-class buttons at 3 汉字 / 8 符', () => {
    for (const key of KEYS.filter((key) => classOf(key) === 'B')) {
      expect(cjk(ZH[key]), `zh:${key} ${ZH[key]}`).toBeLessThanOrEqual(3)
      expect(EN[key].length, `en:${key} ${EN[key]}`).toBeLessThanOrEqual(8)
    }
  })

  it('keeps the two main buttons at 4 汉字 / 8 符', () => {
    for (const key of B_MAIN) {
      expect(cjk(ZH[key]), `zh:${key} ${ZH[key]}`).toBeLessThanOrEqual(4)
      expect(EN[key].length, `en:${key} ${EN[key]}`).toBeLessThanOrEqual(8)
    }
    expect(cjk(ZH['seed.start'])).toBe(4)
    expect(cjk(ZH['deal.cast'])).toBe(4)
  })

  it('keeps C-class labels at 6 汉字 and 1.6× English', () => {
    for (const key of KEYS.filter((key) => classOf(key) === 'C')) {
      const { enMax } = limitsOf(key, ZH[key])
      expect(cjk(ZH[key]), `zh:${key} ${ZH[key]}`).toBeLessThanOrEqual(6)
      expect(EN[key].length, `en:${key} ${EN[key]} ≤ ${enMax}`).toBeLessThanOrEqual(enMax)
    }
  })

  it('keeps D-class user-content previews at 14 汉字 / 28 符', () => {
    const keys = KEYS.filter((key) => classOf(key) === 'D')
    expect(keys).toEqual(['seed.placeholder', 'seed.sample1', 'seed.sample2', 'seed.sample3'])
    for (const key of keys) {
      expect(cjk(ZH[key]), `zh:${key}`).toBeLessThanOrEqual(14)
      expect(EN[key].length, `en:${key}`).toBeLessThanOrEqual(28)
    }
  })

  it('keeps F-class counters to a number plus one unit', () => {
    for (const key of KEYS.filter((key) => classOf(key) === 'F')) {
      expect(placeholders(ZH[key]).length, `zh:${key}`).toBeLessThanOrEqual(2)
      expect(placeholders(EN[key]), `en:${key}`).toEqual(placeholders(ZH[key]))
      expect(remainder(ZH[key]).length, `zh:${key} ${ZH[key]}`).toBeLessThanOrEqual(3)
      expect(remainder(EN[key]).length, `en:${key} ${EN[key]}`).toBeLessThanOrEqual(6)
    }
  })

  it('classifies every key and never exceeds its own budget', () => {
    for (const key of KEYS) {
      const { zhMax, enMax } = limitsOf(key, ZH[key])
      expect(cjk(ZH[key]), `zh:${key} ${ZH[key]}`).toBeLessThanOrEqual(zhMax)
      expect(EN[key].length, `en:${key} ${EN[key]}`).toBeLessThanOrEqual(enMax)
    }
  })
})

/* ------------------------------ 标点与禁用词 ----------------------------- */

const BANNED_ZH = [
  '智能',
  '一键搞定',
  '一键生成',
  '即将上线',
  '敬请期待',
  '为你',
  '为您',
  '正在为你生成',
  '稍等',
  '请稍候',
  '强大的',
  '极致',
  '颠覆',
  '无缝',
  '丝滑',
  '魔法',
  '黑科技',
  'AI 驱动',
  'AI 原生',
  '轻松',
  '只需',
  '试试',
  '加载中',
  '出错了',
  '哎呀',
  '完美',
  '太棒了',
  '抱歉',
  '对不起',
  '我们',
  '我们的',
  '请检查',
  '幻灯片',
  'PPT',
  '演示文稿',
  '生成器',
  '模板库',
]

const BANNED_EN = [
  'smart',
  'one click',
  'coming soon',
  'stay tuned',
  'for you',
  'generating for you',
  'please wait',
  'powerful',
  'blazing',
  'revolutionary',
  'seamless',
  'magic',
  'ai-powered',
  'effortless',
  'just',
  'simply',
  'loading',
  'oops',
  'perfect',
  'amazing',
  'sorry',
  'we',
  'our',
  'please check',
]

describe('forge 文案 · 标点与禁用词', () => {
  it('never uses exclamation marks, ellipsis or wave dashes', () => {
    for (const key of KEYS) {
      for (const value of [ZH[key], EN[key]]) {
        expect(value, `${key} = ${value}`).not.toMatch(/[！!…～]/)
        expect(value.replace(/\{(\w+)\}/g, ''), `${key} = ${value}`).not.toContain('..')
      }
    }
  })

  it('never uses the banned Chinese words', () => {
    for (const key of KEYS) {
      for (const word of BANNED_ZH) {
        expect(ZH[key], `zh:${key} 命中禁用词「${word}」`).not.toContain(word)
      }
    }
  })

  it('never uses the banned English words as whole words', () => {
    for (const key of KEYS) {
      const value = EN[key].toLowerCase()
      for (const word of BANNED_EN) {
        const pattern = new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`)
        expect(value, `en:${key} 命中禁用词 "${word}"`).not.toMatch(pattern)
      }
    }
  })

  it('keeps placeholders identical across languages', () => {
    for (const key of KEYS) {
      expect(placeholders(EN[key]), key).toEqual(placeholders(ZH[key]))
      // 09 §6.1：占位符名只允许字母、数字、下划线。
      for (const token of placeholders(ZH[key])) expect(token).toMatch(/^\w+$/)
      expect(ZH[key]).not.toMatch(
        /\{\s|\s\}|%d|\$1|\{\{|\{count\}个|三幕|第 \{n\} 幕，共|\{\}/,
      )
    }
  })

  it('uses the 12 recipe names as the only static card labels', () => {
    const recipes = ['cover', 'statement', 'split', 'grid3', 'grid4', 'timeline', 'compare', 'quote', 'data', 'process', 'gallery', 'closing']
    for (const recipe of recipes) {
      expect(ZH[`card.${recipe}`], `card.${recipe}`).toBeTruthy()
      expect(cjk(ZH[`card.${recipe}`])).toBeLessThanOrEqual(4)
      expect(EN[`card.${recipe}`].length).toBeLessThanOrEqual(8)
    }
  })
})

/* --------------------------- 文字预算（静态钩子） -------------------------- */

function source(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), 'utf8')
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('forge 文案 · 文字预算（data-forge-text 计数）', () => {
  it('keeps the seed screen at 6 text blocks or fewer', () => {
    const seed = source('src/forge/stage/Seed.tsx')
    expect(countOf(seed, 'data-forge-text')).toBeGreaterThan(0)
    expect(countOf(seed, 'data-forge-text')).toBeLessThanOrEqual(6)
    // 输入屏只有一个自动聚焦点（02 §9.1）。
    expect(countOf(seed, 'data-forge-autofocus')).toBe(1)
    expect(countOf(seed, '<input')).toBe(1)
  })

  it('keeps the deal screen at 6 text blocks or fewer', () => {
    const deal = source('src/forge/stage/Deal.tsx')
    expect(countOf(deal, 'data-forge-text')).toBeLessThanOrEqual(6)
  })

  it('keeps the HUD at 6 text blocks or fewer', () => {
    const hud = source('src/forge/hud/Hud.tsx')
    expect(countOf(hud, 'data-forge-text')).toBeLessThanOrEqual(6)
    expect(countOf(hud, 'data-forge-tier-chip')).toBe(1)
  })

  it('exposes the frozen DOM hooks the e2e suite depends on', () => {
    const app = source('src/forge/ForgeApp.tsx')
    expect(app).toContain('data-forge={mark}')
    expect(app).toContain('data-forge-tier={tier}')
    expect(app).toContain('data-forge-combo={game.combo}')
    expect(app).toContain("document.documentElement.dataset.lumenForge = '1'")
    expect(app).toContain('delete document.documentElement.dataset.lumenForge')

    const card = source('src/forge/cards/CardFace.tsx')
    expect(card).toContain('data-forge-card')
    expect(card).toContain('data-card-recipe={recipe}')

    const gate = source('src/forge/stage/Gate.tsx')
    expect(countOf(gate, 'data-severity="error"')).toBeGreaterThan(0)
    expect(countOf(gate, 'data-severity="warn"')).toBeGreaterThan(0)

    const assemble = source('src/forge/stage/Assemble.tsx')
    expect(assemble).toContain('data-forge-slot')
    expect(assemble).toContain('data-slot-filled')
  })

  it('routes every visible action through a data-act hook', () => {
    // 主按钮一半在 dock（ForgeApp），一半在幕内（Premiere / Gate），两边一起看。
    const union = [
      source('src/forge/ForgeApp.tsx'),
      source('src/forge/stage/Premiere.tsx'),
      source('src/forge/stage/Gate.tsx'),
    ].join('\n')
    for (const act of ['deal', 'cast', 'recast', 'premiere', 'close', 'again']) {
      expect(union, `data-act="${act}"`).toContain(`data-act="${act}"`)
    }
  })
})
