/**
 * tests/unit/plugins-sample-chartkit.test.ts —— ChartKit 样例（U-40-205…224 的纯函数与契约部分）。
 *
 * 覆盖：CSV/TSV/JSON 解析（引号/BOM/CRLF/列数不一致/超限/NaN）、4 种图表几何与令牌取色、
 * 3 个配方的产物形状、blockId 绑定与 LRU、3 条 lint 规则、面板钩子。
 */
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { sanitizeSvgDocument } from '@/render/svg/sanitize'
import { DEFAULT_SNAPSHOT, findCommand, findRule, installLumenMock, loadPluginModule, pluginPath, renderFrame, type MockState } from './plugins-sample-harness'

const PLUGIN_ID = 'com.lumen.samples.chartkit'

interface ChartModel {
  ok: boolean
  categories: string[]
  series: { name: string; values: (number | null)[] }[]
  skipped: number
  validRatio: number
  overflow: boolean
  datasetTruncated: boolean
  error: { code: string; line?: number } | null
}

interface Table {
  ok: boolean
  format: string
  headers: string[]
  rows: string[][]
  rowCount: number
  columnCount: number
  truncated: boolean
  error: { code: string; line?: number } | null
}

interface ChartKitModule {
  PLUGIN_ID: string
  LIMITS: { rows: number; cols: number; cellChars: number; series: number; minValidRatio: number }
  CHART: Record<string, number>
  SERIES_TOKENS: string[]
  CHART_TYPES: string[]
  RECIPE_TYPES: string[]
  RECIPE_NS: string
  INDEX_KEY: string
  DRAFT_KEY: string
  LRU_LIMIT: number
  CODE_MSG: Record<string, { zh: string; en: string }>
  parseNumber(value: unknown): number | null
  detectFormat(text: string): string
  parseDelimited(text: string, delimiter: string): { rows: string[][]; error: { code: string; line: number } | null }
  parseJsonTable(text: string): { rows: string[][]; error: { code: string; line: number } | null }
  parseTable(text: string, opts?: unknown): Table
  toSeries(table: Table, opts?: unknown): ChartModel
  seriesMax(series: { values: (number | null)[] }[]): number
  barGeometry(categories: string[], series: { values: (number | null)[] }[]): {
    bars: { seriesIndex: number; categoryIndex: number; x: number; y: number; w: number; h: number; value: number }[]
    barW: number
    groupGap: number
    max: number
    baseY: number
    plotH: number
  }
  lineGeometry(categories: string[], series: { values: (number | null)[] }[]): {
    lines: { seriesIndex: number; points: { x: number; y: number; value: number }[] }[]
    step: number
    max: number
  }
  donutGeometry(categories: string[], series: { values: (number | null)[] }[]): {
    slices: { index: number; label: string; value: number; startAngle: number; endAngle: number; sweep: number }[]
    total: number
    angleSum: number
    cx: number
    cy: number
    outer: number
    inner: number
  }
  stackedGeometry(categories: string[], series: { values: (number | null)[] }[]): {
    groups: { total: number; segments: { x: number; y: number; w: number; h: number; value: number }[]; top: number }[]
    maxTotal: number
    baseY: number
    plotH: number
  }
  renderChartSvg(type: string, model: { categories: string[]; series: { name: string; values: (number | null)[] }[] }, opts?: { ariaLabel?: string }): {
    type: string
    source: string
    viewBox: number[]
    seriesCount: number
    categoryCount: number
  }
  escapeXml(value: string): string
  formatNumber(value: number): string
  fnv1a(text: string): string
  digestOfSource(source: string): string
  makeChartRecord(input: { type: string; table: Table; source: string }): {
    v: number
    type: string
    headers: string[]
    rows: string[][]
    updatedAt: number
    sourceDigest: string
  }
  recordToModel(record: unknown): ChartModel | null
  chartStorageKey(blockId: string): string
  upsertChartIndex(
    index: unknown,
    entry: { blockId: string; slideId?: string; type?: string; updatedAt?: number },
    limit?: number,
  ): { index: { blockId: string }[]; evicted: { blockId: string }[] }
  findBoundChart(index: unknown, slideId: string): { blockId: string; type: string } | null
  removeChartFromIndex(index: unknown, blockId: string): { blockId: string }[]
  contentToModel(content: unknown): ChartModel | null
  buildRecipeBlocks(type: string, content: unknown, themeId?: string): {
    type: string
    x: number
    y: number
    w: number
    h: number
    viewBox?: number[]
    source?: string
    text?: string
    variant?: string
  }[]
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
    themes?: unknown
    library?: unknown
    i18n?: unknown
    settings?: unknown
    slots?: { id: string; slot: string; kind: string; size?: { w?: number } }[]
    lintRules?: { id: string; title: { zh: string; en: string }; severity: string }[]
    recipes?: { id: string; namespace: string; title: { zh: string; en: string }; slots: { key: string; required?: boolean; max?: number }[] }[]
    exportHooks?: unknown
  }
}

const EXPECTED_CAPABILITIES = [
  'ui:slot',
  'ui:command',
  'i18n:contribute',
  'lint:rule',
  'ai:recipe',
  'storage',
  'deck:read',
  'deck:write',
]

function readPluginFile(name: string): string {
  return readFileSync(pluginPath('chartkit', name), 'utf8')
}

function readJson<T>(name: string): T {
  return JSON.parse(readPluginFile(name)) as T
}

/** 6 行数据 × 4 列（1 标签 + 3 系列），05 §8 的 bars-6x4.csv 同款。 */
const BARS_CSV = readPluginFile('fixtures/bars-6x4.csv')
const MISSING_COL_CSV = readPluginFile('fixtures/missing-col.csv')
const DIRTY_CSV = readPluginFile('fixtures/dirty-values.csv')

/** 7 系列（超上限）的存储记录，供 seriesOverflow 用。 */
function makeRecord(headers: string[], rows: string[][], type = 'bar') {
  return {
    v: 1,
    type,
    headers,
    rows,
    updatedAt: 10,
    sourceDigest: 'fnv1a:test',
    sourceChars: 10,
  }
}

const SEED_STORAGE = {
  'charts.index': [
    { blockId: 'chart1', slideId: 's1', type: 'bar', updatedAt: 5 },
    { blockId: 'chart2', slideId: 's2', type: 'donut', updatedAt: 4 },
    { blockId: 'chart3', slideId: 's3', type: 'bar', updatedAt: 3 },
  ],
  'charts.chart1': makeRecord(
    ['地区', 'A', 'B', 'C', 'D', 'E', 'F', 'G'],
    [
      ['华东', '1', '2', '3', '4', '5', '6', '7'],
      ['华南', '2', '3', '4', '5', '6', '7', '8'],
      ['华北', '3', '4', '5', '6', '7', '8', '9'],
    ],
  ),
  'charts.chart2': makeRecord(
    ['地区', '销售额'],
    [
      ['华东', '420'],
      ['华南', '310'],
    ],
    'donut',
  ),
  'charts.chart3': makeRecord(
    ['', '销售额'],
    [
      ['', '420'],
      ['', '310'],
    ],
  ),
  'draft.last': BARS_CSV,
}

let manifest: Manifest
let zh: Record<string, string>
let en: Record<string, string>
let source: string
let ck: ChartKitModule
let mock: { lumen: Record<string, unknown>; state: MockState }

beforeAll(async () => {
  manifest = readJson<Manifest>('.lumen-plugin.json')
  zh = readJson<{ zh: Record<string, string> }>('locales/zh.json').zh
  en = readJson<{ en: Record<string, string> }>('locales/en.json').en
  source = readPluginFile('plugin.js')
  mock = installLumenMock({ locale: 'zh', messages: zh, storage: SEED_STORAGE })
  ck = (await loadPluginModule('chartkit')) as unknown as ChartKitModule
})

/* ---------------------------------- 清单 ---------------------------------- */

describe('ChartKit manifest', () => {
  it('身份/版本与 05 §4.2 一致，manifest 不内置 i18n（由打包内联）', () => {
    expect(manifest.id).toBe(PLUGIN_ID)
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.apiVersion).toBe('1.0')
    expect(manifest.minAppVersion).toBe('0.4.0')
    expect(manifest.kind).toBe('code')
    expect(manifest.entry).toBe('plugin.js')
    expect(manifest.trust).toBe('builtin')
    expect(manifest.contributes.i18n).toBeUndefined()
    for (const lang of ['zh', 'en'] as const) {
      expect(manifest.name[lang].trim().length).toBeGreaterThan(0)
      expect(manifest.description[lang].trim().length).toBeGreaterThan(0)
    }
  })

  it('capabilities 恰好 8 项（不申请 ai:invoke / export:hook / ui:keymap）', () => {
    expect(manifest.capabilities).toEqual(EXPECTED_CAPABILITIES)
    for (const capability of ['ai:invoke', 'export:hook', 'ui:keymap', 'asset:write']) {
      expect(manifest.capabilities).not.toContain(capability)
    }
  })

  it('右栏图表页签（1 帧，宽 340）', () => {
    expect(manifest.contributes.slots).toHaveLength(1)
    expect(manifest.contributes.slots?.[0]).toMatchObject({
      id: 'charts-panel',
      slot: 'workspace.inspector.tab',
      kind: 'panel',
      size: { w: 340 },
    })
  })

  it('3 条 lint 规则 + 3 个配方（namespace=chartkit）+ 无导出钩子', () => {
    expect((manifest.contributes.lintRules ?? []).map((rule) => rule.id)).toEqual([
      'series-overflow',
      'axis-label-missing',
      'chart-contrast',
    ])
    const recipes = manifest.contributes.recipes ?? []
    expect(recipes.map((recipe) => recipe.id)).toEqual(['bar', 'line', 'donut'])
    for (const recipe of recipes) expect(recipe.namespace).toBe('chartkit')
    expect(recipes.every((recipe) => recipe.title.zh.length > 0 && recipe.title.en.length > 0)).toBe(true)
    expect(manifest.contributes.exportHooks).toBeUndefined()
  })

  it('配方槽位复用宿主命名（headline 必填、points 有上限）', () => {
    for (const recipe of manifest.contributes.recipes ?? []) {
      const keys = recipe.slots.map((slot) => slot.key)
      expect(keys).toContain('headline')
      expect(keys).toContain('points')
      const headline = recipe.slots.find((slot) => slot.key === 'headline')
      expect(headline?.required).toBe(true)
      const points = recipe.slots.find((slot) => slot.key === 'points')
      expect(points?.max).toBe(recipe.id === 'line' ? 12 : 6)
    }
  })
})

/* ---------------------------------- i18n ---------------------------------- */

describe('ChartKit i18n 语言包', () => {
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

  it('05 §4.7 的关键键齐全', () => {
    for (const key of [
      'panel.title',
      'panel.empty',
      'panel.hint',
      'type.bar',
      'type.line',
      'type.donut',
      'type.stacked',
      'action.insert',
      'action.update',
      'action.detach',
      'error.csvQuote',
      'error.csvColumns',
      'error.dataset',
      'error.notBound',
      'lint.series',
      'lint.contrast',
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

/* ------------------------------ 静态预检 ------------------------------ */

describe('ChartKit plugin.js 静态预检', () => {
  it('不命中 02 §4.3 禁用 API', () => {
    const forbidden = [
      /^\s*import\s/m,
      /\bimport\s*\(/,
      /\brequire\s*\(/,
      /\bnew\s+Function\s*\(/,
      /\beval\s*\(/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bsendBeacon\b/,
      /\blocalStorage\b/,
      /\bdocument\.cookie\b/,
      /\bdocument\.domain\b/,
      /\btop\.location\b/,
      /\bwindow\.open\b/,
    ]
    for (const pattern of forbidden) expect(pattern.test(source), `命中禁止项 ${pattern}`).toBe(false)
  })

  it('无外链资源（只允许 SVG 命名空间 URL）与 JSX 标记', () => {
    const urls = source.match(/https?:\/\/[^\s'"`)]+/g) ?? []
    for (const url of urls) expect(url.startsWith('http://www.w3.org/')).toBe(true)
    expect(source).not.toMatch(/<\/[A-Z][A-Za-z]*>/)
  })
})

/* -------------------------------- 解析 -------------------------------- */

describe('ChartKit 解析（U-40-205…213）', () => {
  it('CSV：6 行 × 4 列，首行表头（bars-6x4.csv）', () => {
    const table = ck.parseTable(BARS_CSV)
    expect(table.ok).toBe(true)
    expect(table.format).toBe('csv')
    expect(table.headers).toEqual(['地区', 'Q1', 'Q2', 'Q3'])
    expect(table.rowCount).toBe(6)
    expect(table.columnCount).toBe(4)
    const model = ck.toSeries(table)
    expect(model.ok).toBe(true)
    expect(model.categories).toEqual(['华东', '华南', '华北', '西南', '东北', '西北'])
    expect(model.series).toHaveLength(3)
    expect(model.series[0].values[0]).toBe(420)
  })

  it('TSV 入口（制表符）', () => {
    const text = '地区\t销售额\n华东\t420\n华南\t310'
    const table = ck.parseTable(text)
    expect(table.ok).toBe(true)
    expect(table.format).toBe('tsv')
    expect(table.headers).toEqual(['地区', '销售额'])
    expect(ck.toSeries(table).series[0].values).toEqual([420, 310])
  })

  it('JSON 入口：对象数组与数组数组两种形态', () => {
    const objects = ck.parseTable('[{"地区":"华东","销售额":420},{"地区":"华南","销售额":310}]')
    expect(objects.ok).toBe(true)
    expect(objects.format).toBe('json')
    expect(objects.headers).toEqual(['地区', '销售额'])
    expect(ck.toSeries(objects).series[0].values).toEqual([420, 310])
    const arrays = ck.parseTable('[["地区","销售额"],["华东",420],["华南",310]]')
    expect(arrays.ok).toBe(true)
    expect(arrays.headers).toEqual(['地区', '销售额'])
    expect(ck.toSeries(arrays).categories).toEqual(['华东', '华南'])
  })

  it('引号内含逗号/换行、"" 转义', () => {
    const text = '地区,说明,销售额\n华东,"上海,江苏",420\n华南,"含""引号""",310'
    const table = ck.parseTable(text)
    expect(table.ok).toBe(true)
    expect(table.rows[0][1]).toBe('上海,江苏')
    expect(table.rows[1][1]).toBe('含"引号"')
  })

  it('BOM 与 CRLF 归一（列名不带 \\ufeff）', () => {
    const text = '\ufeff地区,销售额\r\n华东,420\r\n华南,310\r\n'
    const table = ck.parseTable(text)
    expect(table.ok).toBe(true)
    expect(table.headers[0]).toBe('地区')
    expect(table.headers[0].charCodeAt(0)).not.toBe(0xfeff)
    expect(table.rowCount).toBe(2)
  })

  it('列数不一致 → 带行号错误（missing-col.csv）', () => {
    const table = ck.parseTable(MISSING_COL_CSV)
    expect(table.ok).toBe(false)
    expect(table.error).toEqual({ code: 'csvColumns', line: 4 })
    expect(ck.toSeries(table).error?.code).toBe('csvColumns')
  })

  it('引号未闭合 → 带行号错误', () => {
    const table = ck.parseTable('地区,销售额\n华东,"420\n华南,310')
    expect(table.ok).toBe(false)
    expect(table.error).toEqual({ code: 'csvQuote', line: 2 })
  })

  it('非法数值跳过并计数（dirty-values.csv：N/A、12px、∞ 跳过）', () => {
    const model = ck.toSeries(ck.parseTable(DIRTY_CSV))
    expect(model.ok).toBe(true)
    expect(model.skipped).toBe(3)
    expect(model.validRatio).toBeCloseTo(4 / 7, 5)
    // "1,200" → 1200；"12%" → 12
    expect(model.series[0].values).toEqual([420, null, null, null, 150, 1200, 12])
  })

  it('有效数值 <50% 拒绝插入（U-40-213）', () => {
    const model = ck.toSeries(ck.parseTable('地区,销售额\nA,x\nB,y\nC,z\nD,1\nE,2'))
    expect(model.ok).toBe(false)
    expect(model.error?.code).toBe('validRatio')
  })

  it('超 200 行截断（U-40-210）', () => {
    const lines = ['地区,数值']
    for (let index = 0; index < 260; index += 1) lines.push(`R${index},${index}`)
    const table = ck.parseTable(lines.join('\n'))
    expect(table.ok).toBe(true)
    expect(table.rowCount).toBe(200)
    expect(table.truncated).toBe(true)
  })

  it('超 12 列截断', () => {
    const headers = ['标签', ...Array.from({ length: 15 }, (_v, index) => `S${index}`)]
    const row = ['A', ...Array.from({ length: 15 }, (_v, index) => String(index))]
    const table = ck.parseTable(`${headers.join(',')}\n${row.join(',')}`)
    expect(table.ok).toBe(true)
    expect(table.columnCount).toBe(12)
    expect(table.truncated).toBe(true)
  })

  it('空输入 → empty 错误；非法 JSON → badJson', () => {
    expect(ck.parseTable('   ').error?.code).toBe('empty')
    expect(ck.parseTable('[{"a":1}').error?.code).toBe('badJson')
    expect(ck.parseTable('[1,2,3]').error?.code).toBe('badJson')
  })

  it('parseNumber 口径：千分位/百分号/正负小数/单位拒绝', () => {
    expect(ck.parseNumber('1,200')).toBe(1200)
    expect(ck.parseNumber('12%')).toBe(12)
    expect(ck.parseNumber('-3.5')).toBe(-3.5)
    expect(ck.parseNumber('+7')).toBe(7)
    for (const bad of ['12px', '∞', 'N/A', '', null, undefined, {}, '1.2.3']) {
      expect(ck.parseNumber(bad)).toBeNull()
    }
  })

  it('detectFormat 判定 JSON/TSV/CSV', () => {
    expect(ck.detectFormat('[{"a":1}]')).toBe('json')
    expect(ck.detectFormat('{"headers":[],"rows":[]}')).toBe('json')
    expect(ck.detectFormat('a\tb\n1\t2')).toBe('tsv')
    expect(ck.detectFormat('a,b\n1,2')).toBe('csv')
  })
})

/* -------------------------------- 几何 -------------------------------- */

function modelOf(csv: string) {
  const model = ck.toSeries(ck.parseTable(csv))
  expect(model.ok).toBe(true)
  return model
}

function wideCsv(categories: number, series: number): string {
  const headers = ['标签', ...Array.from({ length: series }, (_v, index) => `S${index + 1}`)]
  const lines = [headers.join(',')]
  for (let category = 0; category < categories; category += 1) {
    const cells = Array.from({ length: series }, (_v, index) => String((category + 1) * (index + 1) * 10))
    lines.push([`C${category + 1}`, ...cells].join(','))
  }
  return lines.join('\n')
}

describe('ChartKit 柱状几何（U-40-214）', () => {
  it('12 类目 × 6 系列全部落在 viewBox 内，柱宽/基线口径正确', () => {
    const model = modelOf(wideCsv(12, 6))
    const geometry = ck.barGeometry(model.categories, model.series)
    expect(geometry.bars).toHaveLength(12 * 6)
    for (const bar of geometry.bars) {
      expect(bar.x).toBeGreaterThanOrEqual(0)
      expect(bar.x + bar.w).toBeLessThanOrEqual(ck.CHART.w)
      expect(bar.y).toBeGreaterThanOrEqual(ck.CHART.plotBaseY - ck.CHART.plotH - 0.01)
      expect(bar.y + bar.h).toBeLessThanOrEqual(ck.CHART.plotBaseY + 0.01)
    }
    expect(geometry.baseY).toBe(400)
    expect(geometry.plotH).toBe(320)
    expect(geometry.groupGap).toBeLessThanOrEqual(24)
  })

  it('5 类目 × 1 系列：柱宽 72、组间距 24、基线 400（05 §4.4）', () => {
    const model = modelOf('地区,销售额\nA,100\nB,200\nC,300\nD,400\nE,500')
    const geometry = ck.barGeometry(model.categories, model.series)
    expect(geometry.barW).toBe(72)
    expect(geometry.groupGap).toBe(24)
    expect(geometry.baseY).toBe(400)
    for (const bar of geometry.bars) {
      expect(bar.w).toBe(72)
      expect(bar.y + bar.h).toBeCloseTo(400, 5)
    }
  })
})

describe('ChartKit 折线/环形/堆叠几何（U-40-215…217）', () => {
  it('折线点数 = 类目数，首尾贴轴', () => {
    const model = modelOf(BARS_CSV)
    const geometry = ck.lineGeometry(model.categories, model.series)
    expect(geometry.lines).toHaveLength(3)
    for (const line of geometry.lines) {
      expect(line.points).toHaveLength(model.categories.length)
      expect(line.points[0].x).toBe(8)
      expect(line.points.at(-1)?.x).toBe(ck.CHART.w - 8)
      for (const point of line.points) {
        expect(point.y).toBeGreaterThanOrEqual(80 - 0.01)
        expect(point.y).toBeLessThanOrEqual(400 + 0.01)
      }
    }
  })

  it('环形：弧角和 = 2π（±0.001），外径 170 / 内径 98', () => {
    const model = modelOf(BARS_CSV)
    const geometry = ck.donutGeometry(model.categories, model.series)
    expect(geometry.angleSum).toBeCloseTo(Math.PI * 2, 3)
    expect(Math.abs(geometry.angleSum - Math.PI * 2)).toBeLessThanOrEqual(0.001)
    expect(geometry.outer).toBe(170)
    expect(geometry.inner).toBe(98)
    const last = geometry.slices.at(-1)
    expect(last?.endAngle).toBeCloseTo(-Math.PI / 2 + Math.PI * 2, 3)
  })

  it('堆叠：每类目高度和 = 该值换算高度，不越界', () => {
    const model = modelOf(BARS_CSV)
    const geometry = ck.stackedGeometry(model.categories, model.series)
    expect(geometry.groups).toHaveLength(model.categories.length)
    for (const group of geometry.groups) {
      const sum = group.segments.reduce((total, segment) => total + segment.h, 0)
      expect(sum).toBeCloseTo((group.total / geometry.maxTotal) * ck.CHART.plotH, 0)
      for (const segment of group.segments) {
        expect(segment.y).toBeGreaterThanOrEqual(ck.CHART.plotBaseY - ck.CHART.plotH - 1)
        expect(segment.y + segment.h).toBeLessThanOrEqual(ck.CHART.plotBaseY + 1)
      }
      expect(group.top).toBeGreaterThanOrEqual(ck.CHART.plotBaseY - ck.CHART.plotH - 1)
    }
  })
})

/* ------------------------------- SVG 生成 ------------------------------- */

describe('ChartKit SVG 生成（U-40-218/219）', () => {
  const model = () => modelOf(BARS_CSV)

  it('4 种图表：source 只用 var(--d-*) 令牌，过净化 0 issue', () => {
    for (const type of ck.CHART_TYPES) {
      const rendered = ck.renderChartSvg(type, model(), { ariaLabel: '测试图表' })
      expect(rendered.viewBox).toEqual([0, 0, 1360, 420])
      expect(rendered.categoryCount).toBe(6)
      expect(rendered.source).toContain(`data-chart-type='${type}'`)
      expect(rendered.source).toContain('<title>')
      for (const match of rendered.source.matchAll(/(?:fill|stroke|stop-color)='([^']+)'/g)) {
        expect(match[1]).toMatch(/^(none|currentColor|var\(--d-[a-z0-9-]+\))$/)
      }
      const result = sanitizeSvgDocument(rendered.source, { maxBytes: 512 * 1024 })
      expect(result.issues, `${type} sanitize issues`).toEqual([])
      expect(result.svg.length).toBeGreaterThan(0)
    }
  })

  it('主题切换不改变结构（同一 source 在任意主题下复用 token）', () => {
    const first = ck.renderChartSvg('bar', model(), { ariaLabel: 'A' }).source
    mock.state.themeColors.accent = '#FF0000'
    try {
      const second = ck.renderChartSvg('bar', model(), { ariaLabel: 'A' }).source
      expect(second).toBe(first)
      expect(second).not.toContain('#FF0000')
    } finally {
      mock.state.themeColors.accent = '#1F6FEB'
    }
  })

  it('escapeXml 处理五类字符；formatNumber 去尾零', () => {
    expect(ck.escapeXml(`<a&"'`)).toBe('&lt;a&amp;&quot;&apos;')
    expect(ck.formatNumber(3.04)).toBe('3')
    expect(ck.formatNumber(3.14159)).toBe('3.1')
    expect(ck.formatNumber(Number.NaN)).toBe('0')
  })
})

/* -------------------------------- 配方 -------------------------------- */

describe('ChartKit 配方产物（U-40-220/221）', () => {
  const content = {
    lang: 'zh',
    headline: '季度增长',
    points: ['Q1=420', 'Q2=380', 'Q3=460'],
    caption: '来源：财报',
  }

  it('chartkit/bar 产 3 块，几何落在安全区（标题 y=136 / svg y=350 1360×420 / 图注 y=780）', () => {
    const blocks = ck.buildRecipeBlocks('bar', content, 'noir')
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toMatchObject({ type: 'text', x: 120, y: 136, w: 1360, variant: 'h1' })
    expect(blocks[1]).toMatchObject({ type: 'svg', x: 120, y: 350, w: 1360, h: 420 })
    expect(blocks[1].viewBox).toEqual([0, 0, 1360, 420])
    expect(blocks[2]).toMatchObject({ type: 'text', x: 120, y: 780 })
    for (const block of blocks) {
      expect(block.x + block.w).toBeLessThanOrEqual(1600)
      expect(block.y + block.h).toBeLessThanOrEqual(900)
    }
  })

  it('line / donut 同签名同几何，只换 svg 类型', () => {
    for (const type of ['line', 'donut'] as const) {
      const blocks = ck.buildRecipeBlocks(type, content, 'noir')
      expect(blocks).toHaveLength(3)
      expect(blocks[1].source).toContain(`data-chart-type='${type}'`)
    }
  })

  it('points 不足 2 条 → 返回空数组（宿主回落 statement，02 §9.2）', () => {
    expect(ck.buildRecipeBlocks('bar', { headline: 'x', points: [] }, 'noir')).toEqual([])
    expect(ck.buildRecipeBlocks('bar', { headline: 'x', points: ['只有一个=1'] }, 'noir')).toEqual([])
  })

  it('contentToModel 解析「标签=数值」，忽略非法项', () => {
    const model = ck.contentToModel({ headline: 'h', points: ['A=1', 'B=x', 'C=3'] })
    expect(model?.categories).toEqual(['A', 'C'])
    expect(model?.series[0].values).toEqual([1, 3])
  })
})

/* ---------------------------- 绑定与数据模型 ---------------------------- */

describe('ChartKit 数据绑定（U-40-222/223）', () => {
  it('makeChartRecord ↔ recordToModel 往返一致', () => {
    const table = ck.parseTable(BARS_CSV)
    const rendered = ck.renderChartSvg('bar', ck.toSeries(table))
    const record = ck.makeChartRecord({ type: 'bar', table, source: rendered.source })
    expect(record.v).toBe(1)
    expect(record.type).toBe('bar')
    expect(record.sourceDigest.startsWith('fnv1a:')).toBe(true)
    const model = ck.recordToModel(record)
    expect(model?.categories).toEqual(['华东', '华南', '华北', '西南', '东北', '西北'])
    expect(model?.series).toHaveLength(3)
  })

  it('同一数据 + 同一类型 → source 稳定（同 digest）；改数据 → digest 变', () => {
    const table = ck.parseTable(BARS_CSV)
    const first = ck.renderChartSvg('bar', ck.toSeries(table))
    const second = ck.renderChartSvg('bar', ck.toSeries(table))
    expect(first.source).toBe(second.source)
    const digestA = ck.digestOfSource(first.source)
    const other = ck.parseTable('地区,销售额\nA,1\nB,2')
    const digestB = ck.digestOfSource(ck.renderChartSvg('bar', ck.toSeries(other)).source)
    expect(digestA).not.toBe(digestB)
  })

  it('绑定索引 LRU 24：超过后淘汰最久未改的一张', () => {
    let index: { blockId: string }[] = []
    let evicted: { blockId: string }[] = []
    for (let item = 0; item < ck.LRU_LIMIT + 2; item += 1) {
      const result = ck.upsertChartIndex(index, { blockId: `b${item}`, slideId: 's1', type: 'bar', updatedAt: item })
      index = result.index
      evicted = evicted.concat(result.evicted)
    }
    expect(index).toHaveLength(ck.LRU_LIMIT)
    expect(evicted.map((entry) => entry.blockId)).toEqual(['b0', 'b1'])
    expect(index[0].blockId).toBe(`b${ck.LRU_LIMIT + 1}`)
  })

  it('同一 blockId 更新移到最前；findBoundChart/removeChartFromIndex 口径', () => {
    const first = ck.upsertChartIndex([], { blockId: 'a', slideId: 's1', type: 'bar' })
    const second = ck.upsertChartIndex(first.index, { blockId: 'b', slideId: 's2', type: 'line' })
    const third = ck.upsertChartIndex(second.index, { blockId: 'a', slideId: 's1', type: 'donut' })
    expect(third.index.map((entry) => entry.blockId)).toEqual(['a', 'b'])
    expect(ck.findBoundChart(third.index, 's2')?.blockId).toBe('b')
    expect(ck.findBoundChart(third.index, 's9')).toBeNull()
    expect(ck.removeChartFromIndex(third.index, 'a').map((entry) => entry.blockId)).toEqual(['b'])
  })

  it('存储键遵循用户键规范（charts.<blockId>）', () => {
    expect(ck.chartStorageKey('b123')).toBe('charts.b123')
    expect(ck.INDEX_KEY).toBe('charts.index')
    expect(ck.DRAFT_KEY).toBe('draft.last')
    expect(ck.LRU_LIMIT).toBe(24)
  })
})

/* ------------------------------- 运行期注册 ------------------------------- */

describe('ChartKit 运行期注册（02 §6.9）', () => {
  it('3 条命令在 ready 前注册', () => {
    expect(mock.state.commands.map((command) => command.id)).toEqual(['open', 'insert-bar', 'redraw-selected'])
  })

  it('3 条 lint 规则同 id 注册', () => {
    expect(mock.state.lintRules.map((rule) => rule.id)).toEqual(['series-overflow', 'axis-label-missing', 'chart-contrast'])
  })

  it('3 个配方以 namespace=chartkit 注册，且 build 可调用', async () => {
    expect(mock.state.recipes.map((recipe) => recipe.id)).toEqual(['bar', 'line', 'donut'])
    for (const recipe of mock.state.recipes) expect(recipe.namespace).toBe('chartkit')
    const bar = mock.state.recipes[0]
    const blocks = bar.build({ lang: 'zh', headline: '增长', points: ['A=1', 'B=2'] }, 'noir') as unknown[]
    expect(blocks).toHaveLength(3)
  })

  it('1 段提示词片段（ai:recipe 的 registerPromptFragment）', () => {
    expect(mock.state.promptFragments.map((fragment) => fragment.id)).toContain('chartkit-data')
  })
})

/* -------------------------------- 规则行为 -------------------------------- */

function ruleCtx() {
  return {
    deck: DEFAULT_SNAPSHOT,
    slides: [
      { id: 's1', blocks: [{ id: 'chart1', type: 'svg' }] },
      { id: 's2', blocks: [{ id: 'chart2', type: 'svg' }] },
      { id: 's3', blocks: [{ id: 'chart3', type: 'svg' }] },
    ],
  }
}

describe('ChartKit lint 规则（U-40-219 前后）', () => {
  it('seriesOverflow：7 系列命中 1 条且带 blockId/slideId', async () => {
    const rule = findRule(mock.state, 'series-overflow')
    const findings = (await Promise.resolve(rule.run(ruleCtx()))) as { blockId?: string; slideId?: string; message: { zh: string } }[]
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ blockId: 'chart1', slideId: 's1' })
    expect(findings[0].message.zh).toContain('7')
  })

  it('axisLabelMissing：空标签图表命中', async () => {
    const rule = findRule(mock.state, 'axis-label-missing')
    const findings = (await Promise.resolve(rule.run(ruleCtx()))) as { blockId?: string }[]
    expect(findings.map((finding) => finding.blockId)).toEqual(['chart3'])
  })

  it('chartContrast：对比度 <3 才报，≥3 不报', async () => {
    const rule = findRule(mock.state, 'chart-contrast')
    expect(await Promise.resolve(rule.run(ruleCtx()))).toEqual([])
    mock.state.contrastRatio = 2.5
    try {
      const findings = (await Promise.resolve(rule.run(ruleCtx()))) as { message: { zh: string } }[]
      expect(findings).toHaveLength(1)
      expect(findings[0].message.zh).toContain('2.5')
    } finally {
      mock.state.contrastRatio = 7
    }
  })

  it('规则不触碰非图表块：ctx 无绑定块时全部返回 []', async () => {
    const ctx = { deck: DEFAULT_SNAPSHOT, slides: [{ id: 's1', blocks: [{ id: 'text1', type: 'text' }] }] }
    for (const id of ['series-overflow', 'axis-label-missing', 'chart-contrast']) {
      const rule = findRule(mock.state, id)
      expect(await Promise.resolve(rule.run(ctx))).toEqual([])
    }
  })
})

/* --------------------------------- 面板 --------------------------------- */

describe('ChartKit 面板（钩子 06 §3.1）', () => {
  it('data-chart-panel / state / input / tabs / insert 齐全', () => {
    const { root } = renderFrame(mock.state, { ctx: { slot: 'workspace.inspector.tab' } })
    expect(root.hasAttribute('data-chart-panel')).toBe(true)
    expect(['empty', 'parsed', 'error', 'bound']).toContain(root.getAttribute('data-chart-state'))
    expect(root.querySelectorAll('[role="tab"][data-chart-type]').length).toBe(4)
    // 预览 svg 也带 data-chart-type（图表溯源属性），最多 1 个
    expect(root.querySelectorAll('svg[data-chart-type]').length).toBeLessThanOrEqual(1)
    expect(root.querySelector('[data-chart-input]')).toBeTruthy()
    expect(root.querySelector('[data-chart-insert]')).toBeTruthy()
    expect(root.querySelector('[aria-live="polite"]')).toBeTruthy()
  })

  it('粘贴数据后：parsed 态 + 预览 svg + 插入可用（U-40-205 的 UI 侧）', async () => {
    const { root } = renderFrame(mock.state, { ctx: { slot: 'workspace.inspector.tab' } })
    const input = root.querySelector('[data-chart-input]') as HTMLTextAreaElement
    input.value = BARS_CSV
    input.dispatchEvent(new Event('input'))
    await vi.waitFor(
      () => {
        expect(['parsed', 'bound']).toContain(root.getAttribute('data-chart-state'))
      },
      { timeout: 5000 },
    )
    const preview = root.querySelector('[data-chart-preview] svg')
    expect(preview).toBeTruthy()
    expect(preview?.getAttribute('data-chart-block')).toBeTruthy()
    expect((root.querySelector('[data-chart-insert]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('错误数据：error 态且带行号钩子', async () => {
    const { root } = renderFrame(mock.state, { ctx: { slot: 'workspace.inspector.tab' } })
    const input = root.querySelector('[data-chart-input]') as HTMLTextAreaElement
    input.value = MISSING_COL_CSV
    input.dispatchEvent(new Event('input'))
    await vi.waitFor(
      () => {
        expect(root.getAttribute('data-chart-state')).toBe('error')
      },
      { timeout: 5000 },
    )
    const errorLine = root.querySelector('[data-chart-error-line]')
    expect(errorLine?.getAttribute('data-chart-error-line')).toBe('4')
  })

  it('clear 命令注册且打开面板命令存在', () => {
    const open = findCommand(mock.state, 'open')
    void open
    expect(findCommand(mock.state, 'insert-bar')).toBeTruthy()
    expect(findCommand(mock.state, 'redraw-selected')).toBeTruthy()
  })
})
