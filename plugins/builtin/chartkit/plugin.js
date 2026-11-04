/**
 * plugin.js —— ChartKit / 数据画报 · LUMEN ABI v1（示例插件，单文件 ESM）
 *
 * 能力：ui:slot · ui:command · i18n:contribute · lint:rule · ai:recipe · storage · deck:read · deck:write
 * 预算：包 ≤ 120 KB（本文件 ≤ 100 KB），单图生成 ≤ 8 ms；纯本地解析与字符串拼接，零网络。
 *
 * 设计要点（05 §4）：
 *   - CSV / TSV / JSON → 普通 `string[][]`；解析失败带行号，超限截断，非法数值跳过并计数；
 *   - 4 种图表（bar / line / donut / stacked）生成**原生 svg 块**源码，颜色只用 `var(--d-*)` 令牌；
 *   - 插件数据不进 deck（D-40-13）：每张图的数据按 blockId 存在插件 storage，回改时重建 source，
 *     卸载后 deck 里的 svg 块仍是普通块（可显示、不可回改）；
 *   - 配方 `chartkit/bar|line|donut` 的 build 返回块对象数组（不是 DOM），由宿主 zod 校验后落位。
 */

const PLUGIN_ID = 'com.lumen.samples.chartkit'
const lumen = globalThis.lumen
if (!lumen) throw new Error('LUMEN ABI v1 is required')

const el = lumen.ui.el
const t = (key, vars) => luminanceT(key, vars)

function luminanceT(key, vars) {
  return lumen.i18n.t(key, vars)
}

/* =============================== 1. 常量 =============================== */

/** 解析上限（05 §4.4：≤200 行 × 12 列，单元格 ≤64 字符）。 */
const LIMITS = {
  rows: 200,
  cols: 12,
  cellChars: 64,
  series: 6,
  minValidRatio: 0.5,
}

/** 图表画布（1600×900 安全区内的 svg 块 viewBox）。 */
const CHART = {
  w: 1360,
  h: 420,
  padX: 8,
  plotBaseY: 400,
  plotH: 320,
  barW: 72,
  barGap: 6,
  groupGap: 24,
  dotR: 4,
  strokeW: 2.5,
  donutCx: 300,
  donutCy: 210,
  donutOuter: 170,
  donutInner: 98,
}

/** 令牌色与透明度（多系列靠 fill-opacity 区分，不写死色值）。 */
const SERIES_TOKENS = ['var(--d-accent)', 'var(--d-accent2)', 'var(--d-fg)', 'var(--d-muted)', 'var(--d-accent)', 'var(--d-accent2)']
const SERIES_OPACITY = [0.85, 0.62, 0.46, 0.34, 0.26, 0.2]
const CHART_TYPES = ['bar', 'line', 'donut', 'stacked']
const RECIPE_TYPES = ['bar', 'line', 'donut']
const RECIPE_NS = 'chartkit'

/** 插件自有存储键（宿主实际键 `${pluginId}:data:<key>`，02 §7.2）。 */
const CHART_PREFIX = 'charts.'
const INDEX_KEY = 'charts.index'
const DRAFT_KEY = 'draft.last'
const LRU_LIMIT = 24
const DRAFT_MAX = 16 * 1024
const STORE_ROWS = 60

const CODE_MSG = {
  series: { zh: '系列数 {count} 超过上限 {max}', en: '{count} series exceed the limit of {max}' },
  axis: { zh: '类目少于 2 个或缺少轴标签', en: 'Fewer than 2 categories or missing axis labels' },
  contrast: { zh: '图表色对比不足（{ratio}:1）', en: 'Chart contrast is {ratio}:1' },
}

const RECIPE_TITLES = {
  bar: { zh: '数据柱状', en: 'Data bars' },
  line: { zh: '数据折线', en: 'Data line' },
  donut: { zh: '数据环形', en: 'Data donut' },
}

const CMD_TITLES = {
  open: { zh: '打开图表面板', en: 'Open charts panel' },
  insertBar: { zh: '用当前数据插入柱状图', en: 'Insert bar chart from current data' },
  redrawSelected: { zh: '用新数据重绘图表', en: 'Redraw chart with new data' },
}

const PROMPT_FRAGMENT = {
  id: 'chartkit-data',
  title: { zh: '数据点写法', en: 'Data point format' },
  text:
    '需要图表时，把数据点写成「标签=数值」的列表（每项一个点，2–6 项），例如「华东=420」；' +
    '标题写结论，图注写来源。/ When a chart is needed, write points as a list of "label=value" items ' +
    '(2–6 items), e.g. "East=420"; put the conclusion in the headline and the source in the caption.',
  tasks: ['slide'],
}

/* =============================== 2. 纯解析 =============================== */

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n')
}

function detectFormat(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json'
  const firstLine = trimmed.split('\n').find((line) => line.trim() !== '') ?? ''
  if (firstLine.includes('\t')) return 'tsv'
  return 'csv'
}

/**
 * 宽松数值解析：支持千分位、结尾 %、正负号与小数；NaN/∞/带单位/空 → null。
 * 返回数字或 null（调用方负责计数「跳过」）。
 */
function parseNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  if (text === '') return null
  text = text.replace(/,/g, '')
  if (text.endsWith('%')) text = text.slice(0, -1)
  if (!/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** 分隔符解析（CSV/TSV 共用）：支持引号内含分隔符/换行、`""` 转义。 */
function parseDelimited(text, delimiter) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let quoteLine = 0
  let line = 1
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    if (quoted) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        if (ch === '\n') line += 1
        field += ch
      }
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
      quoteLine = line
      continue
    }
    if (ch === delimiter) {
      pushField()
      continue
    }
    if (ch === '\n') {
      pushRow()
      line += 1
      continue
    }
    field += ch
  }
  if (quoted) return { rows: [], error: { code: 'csvQuote', line: quoteLine } }
  if (field !== '' || row.length > 0) pushRow()
  while (rows.length > 1 && rows[rows.length - 1].every((cell) => String(cell).trim() === '')) rows.pop()
  if (rows.length === 0) return { rows: [], error: { code: 'empty', line: 1 } }
  const width = rows[0].length
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].length !== width) return { rows: [], error: { code: 'csvColumns', line: index + 1 } }
  }
  return { rows, error: null }
}

function parseJsonTable(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { rows: [], error: { code: 'badJson', line: 1 } }
  }
  if (Array.isArray(data) && data.length > 0 && data.every((item) => Array.isArray(item))) {
    if (data.length < 2) return { rows: [], error: { code: 'tooFew', line: 1 } }
    return { rows: data.map((row) => row.map((cell) => String(cell))), error: null }
  }
  if (Array.isArray(data) && data.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    const keys = []
    for (const item of data) {
      for (const key of Object.keys(item)) if (!keys.includes(key)) keys.push(key)
    }
    const rows = [keys.slice()]
    for (const item of data) rows.push(keys.map((key) => (item[key] === undefined || item[key] === null ? '' : String(item[key]))))
    return { rows, error: null }
  }
  if (data && typeof data === 'object' && Array.isArray(data.rows)) {
    const rawRows = data.rows
    if (rawRows.length === 0) return { rows: [], error: { code: 'tooFew', line: 1 } }
    const headers = Array.isArray(data.headers)
      ? data.headers.map((cell) => String(cell))
      : rawRows[0] && typeof rawRows[0] === 'object' && !Array.isArray(rawRows[0])
        ? Object.keys(rawRows[0])
        : []
    if (headers.length === 0) return { rows: [], error: { code: 'badJson', line: 1 } }
    const rows = [headers]
    for (const item of rawRows) {
      rows.push(headers.map((key) => (item && item[key] !== undefined && item[key] !== null ? String(item[key]) : '')))
    }
    return { rows, error: null }
  }
  return { rows: [], error: { code: 'badJson', line: 1 } }
}

/**
 * 文本 → 表格（结构化解析，不做数值判定）。
 * 返回 { ok, format, headers, rows, rowCount, columnCount, truncated, error }。
 */
function parseTable(input, opts) {
  const limits = { ...LIMITS, ...(opts ?? {}) }
  const raw = typeof input === 'string' ? input : ''
  const text = normalizeNewlines(stripBom(raw))
  const empty = {
    ok: false,
    format: 'csv',
    headers: [],
    rows: [],
    rowCount: 0,
    columnCount: 0,
    truncated: false,
    error: { code: 'empty', line: 1 },
  }
  if (text.trim() === '') return empty
  const format = detectFormat(text)
  const parsed = format === 'json' ? parseJsonTable(text) : parseDelimited(text, format === 'tsv' ? '\t' : ',')
  if (parsed.error) return { ...empty, format, error: parsed.error }
  const rawRows = parsed.rows
  const headerRow = rawRows[0].map((cell, index) => {
    const value = String(cell ?? '').trim()
    return value === '' ? `#${index + 1}` : value.slice(0, limits.cellChars)
  })
  let truncated = false
  const headers = []
  for (let index = 0; index < Math.min(headerRow.length, limits.cols); index += 1) headers.push(headerRow[index])
  if (rawRows[0].length > limits.cols) truncated = true
  const body = []
  for (let rowIndex = 1; rowIndex < rawRows.length; rowIndex += 1) {
    if (body.length >= limits.rows) {
      truncated = true
      break
    }
    const row = []
    for (let colIndex = 0; colIndex < headers.length; colIndex += 1) {
      let cell = String(rawRows[rowIndex][colIndex] ?? '').trim()
      if (cell.length > limits.cellChars) {
        cell = `${cell.slice(0, limits.cellChars)}…`
        truncated = true
      }
      row.push(cell)
    }
    body.push(row)
  }
  if (body.length === 0) return { ...empty, format, error: { code: 'tooFew', line: 1 } }
  return {
    ok: true,
    format,
    headers,
    rows: body,
    rowCount: body.length,
    columnCount: headers.length,
    truncated,
    error: null,
  }
}

/**
 * 表格 → 图表模型 { categories, series }。
 * 首列多数为非数值 → 作为类目标签；否则自动编号。数值列做「跳过并计数」，有效率 <50% 判失败。
 */
function toSeries(table, opts) {
  const limits = { ...LIMITS, ...(opts ?? {}) }
  const fail = (code, extra) => ({
    ok: false,
    categories: [],
    series: [],
    skipped: 0,
    validRatio: 0,
    overflow: false,
    datasetTruncated: false,
    error: { code, ...(extra ?? {}) },
  })
  if (!table || table.ok !== true) {
    const error = (table && table.error) || { code: 'empty', line: 1 }
    return fail(error.code, error.line ? { line: error.line } : undefined)
  }
  const headers = Array.isArray(table.headers) ? table.headers : []
  const rows = Array.isArray(table.rows) ? table.rows : []
  if (headers.length < 2) return fail('tooFewColumns')
  if (rows.length < 2) return fail('tooFew')
  const numericFirst = rows.filter((row) => parseNumber(row[0]) !== null).length
  const labelMode = numericFirst < Math.ceil(rows.length / 2)
  const start = labelMode ? 1 : 0
  const categories = rows.map((row, index) => {
    const label = labelMode ? String(row[0] ?? '').trim() : `#${index + 1}`
    return label === '' ? `#${index + 1}` : label
  })
  const series = []
  let validCells = 0
  let totalCells = 0
  let skipped = 0
  for (let colIndex = start; colIndex < headers.length; colIndex += 1) {
    const values = []
    let columnValid = 0
    for (const row of rows) {
      totalCells += 1
      const value = parseNumber(row[colIndex])
      if (value === null) {
        values.push(null)
        skipped += 1
      } else {
        values.push(value)
        validCells += 1
        columnValid += 1
      }
    }
    if (columnValid > 0) series.push({ name: headers[colIndex] || `#${colIndex + 1}`, values })
  }
  if (series.length === 0) return fail('validRatio')
  const validRatio = totalCells === 0 ? 0 : validCells / totalCells
  const model = {
    ok: validRatio >= limits.minValidRatio,
    categories,
    series,
    skipped,
    validRatio,
    overflow: series.length > limits.series,
    datasetTruncated: table.truncated === true,
    error: validRatio >= limits.minValidRatio ? null : { code: 'validRatio' },
  }
  return model
}

/* =============================== 3. 几何 =============================== */

function seriesMax(series) {
  let max = 0
  for (const item of series) {
    for (const value of item.values) {
      const n = Number(value)
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return max
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function barGeometry(categories, series) {
  const nCats = Math.max(1, categories.length)
  const nSeries = Math.max(1, Math.min(series.length, LIMITS.series))
  const usable = CHART.w - CHART.padX * 2
  const groupW = usable / nCats
  const groupGap = Math.min(CHART.groupGap, groupW * 0.2)
  const barSpace = groupW - groupGap
  const barW = Math.max(2, Math.min(CHART.barW, (barSpace - (nSeries - 1) * CHART.barGap) / nSeries))
  const totalBars = nSeries * barW + (nSeries - 1) * CHART.barGap
  const max = Math.max(1, seriesMax(series))
  const bars = []
  for (let categoryIndex = 0; categoryIndex < nCats; categoryIndex += 1) {
    const groupX = CHART.padX + categoryIndex * groupW + (groupW - totalBars) / 2
    for (let seriesIndex = 0; seriesIndex < nSeries; seriesIndex += 1) {
      const item = series[seriesIndex]
      const value = item && Number.isFinite(item.values[categoryIndex]) ? item.values[categoryIndex] : 0
      const height = (Math.max(0, value) / max) * CHART.plotH
      bars.push({
        seriesIndex,
        categoryIndex,
        x: round2(groupX + seriesIndex * (barW + CHART.barGap)),
        y: round2(CHART.plotBaseY - height),
        w: round2(barW),
        h: round2(height),
        value,
      })
    }
  }
  return { bars, barW: round2(barW), groupGap: round2(groupGap), groupW: round2(groupW), max, baseY: CHART.plotBaseY, plotH: CHART.plotH }
}

function lineGeometry(categories, series) {
  const nCats = Math.max(1, categories.length)
  const step = nCats > 1 ? (CHART.w - CHART.padX * 2) / (nCats - 1) : 0
  const max = Math.max(1, seriesMax(series))
  const lines = series.slice(0, LIMITS.series).map((item, seriesIndex) => {
    const points = categories.map((_category, categoryIndex) => {
      const value = Number.isFinite(item.values[categoryIndex]) ? item.values[categoryIndex] : 0
      const height = (Math.max(0, value) / max) * CHART.plotH
      return {
        categoryIndex,
        x: round2(CHART.padX + categoryIndex * step),
        y: round2(CHART.plotBaseY - height),
        value,
      }
    })
    return { seriesIndex, name: item.name, points }
  })
  return { lines, step: round2(step), max, baseY: CHART.plotBaseY, plotH: CHART.plotH, dotR: CHART.dotR }
}

function polarPoint(cx, cy, radius, angle) {
  return [round2(cx + radius * Math.cos(angle)), round2(cy + radius * Math.sin(angle))]
}

function arcPath(startAngle, endAngle, outer, inner, cx, cy) {
  const [x1o, y1o] = polarPoint(cx, cy, outer, startAngle)
  const [x2o, y2o] = polarPoint(cx, cy, outer, endAngle)
  const [x2i, y2i] = polarPoint(cx, cy, inner, endAngle)
  const [x1i, y1i] = polarPoint(cx, cy, inner, startAngle)
  const large = Math.abs(endAngle - startAngle) > Math.PI ? 1 : 0
  return `M ${x1o} ${y1o} A ${outer} ${outer} 0 ${large} 1 ${x2o} ${y2o} L ${x2i} ${y2i} A ${inner} ${inner} 0 ${large} 0 ${x1i} ${y1i} Z`
}

function donutGeometry(categories, series) {
  const values = categories.map((_category, categoryIndex) => {
    let sum = 0
    for (const item of series) {
      const value = item.values[categoryIndex]
      if (Number.isFinite(value) && value > 0) sum += value
    }
    return round2(sum)
  })
  const total = round2(values.reduce((sum, value) => sum + value, 0))
  const slices = []
  let angle = -Math.PI / 2
  let angleSum = 0
  for (let index = 0; index < values.length; index += 1) {
    const sweep = total > 0 ? (values[index] / total) * Math.PI * 2 : 0
    const startAngle = angle
    const endAngle = startAngle + sweep
    slices.push({ index, label: categories[index], value: values[index], startAngle, endAngle, sweep })
    angle = endAngle
    angleSum += sweep
  }
  return {
    slices,
    total,
    angleSum,
    fullCircle: Math.abs(angleSum - Math.PI * 2) <= 1e-6,
    cx: CHART.donutCx,
    cy: CHART.donutCy,
    outer: CHART.donutOuter,
    inner: CHART.donutInner,
  }
}

function stackedGeometry(categories, series) {
  const usable = CHART.w - CHART.padX * 2
  const nCats = Math.max(1, categories.length)
  const groupW = usable / nCats
  const barW = Math.max(2, Math.min(CHART.barW, groupW * 0.6))
  const totals = categories.map((_category, categoryIndex) => {
    let sum = 0
    for (const item of series) {
      const value = item.values[categoryIndex]
      if (Number.isFinite(value) && value > 0) sum += value
    }
    return round2(sum)
  })
  const maxTotal = Math.max(1, ...totals)
  const groups = []
  for (let categoryIndex = 0; categoryIndex < nCats; categoryIndex += 1) {
    const x = round2(CHART.padX + categoryIndex * groupW + (groupW - barW) / 2)
    const segments = []
    let cursor = CHART.plotBaseY
    for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex += 1) {
      const item = series[seriesIndex]
      const value = Number.isFinite(item.values[categoryIndex]) ? Math.max(0, item.values[categoryIndex]) : 0
      const height = (value / maxTotal) * CHART.plotH
      if (height <= 0) continue
      segments.push({
        seriesIndex,
        x,
        y: round2(cursor - height),
        w: barW,
        h: round2(height),
        value,
      })
      cursor -= height
    }
    groups.push({ categoryIndex, x, w: barW, total: totals[categoryIndex], segments, top: round2(cursor) })
  }
  return { groups, totals, maxTotal, barW: round2(barW), baseY: CHART.plotBaseY, plotH: CHART.plotH }
}

/* =============================== 4. SVG 生成 =============================== */

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function tokenOf(seriesIndex) {
  return SERIES_TOKENS[seriesIndex % SERIES_TOKENS.length]
}

function opacityOf(seriesIndex) {
  return SERIES_OPACITY[seriesIndex % SERIES_OPACITY.length]
}

function svgOpen(ariaLabel, type) {
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${CHART.w} ${CHART.h}' ` +
    `role='img' aria-label='${escapeXml(ariaLabel)}' data-chart-type='${type}' ` +
    `font-family='var(--d-font-body, sans-serif)'>` +
    `<title>${escapeXml(ariaLabel)}</title>`
  )
}

function axisMarkup(categories, labelPlacer, yBase) {
  const parts = [`<line x1='${CHART.padX}' y1='${yBase}' x2='${CHART.w - CHART.padX}' y2='${yBase}' stroke='var(--d-line)' stroke-width='1'/>`]
  if (categories.length > 0) {
    for (let index = 0; index < categories.length; index += 1) {
      const [x] = labelPlacer(index)
      const label = categories[index]
      if (!label) continue
      parts.push(
        `<text x='${round2(x)}' y='${yBase + 16}' font-size='11' fill='var(--d-muted)' text-anchor='middle'>${escapeXml(label)}</text>`,
      )
    }
  }
  return parts.join('')
}

function barSvg(categories, series, ariaLabel) {
  const geometry = barGeometry(categories, series)
  const groups = []
  for (let index = 0; index < categories.length; index += 1) {
    const x = CHART.padX + index * geometry.groupW + geometry.groupW / 2
    groups.push([round2(x)])
  }
  const marks = geometry.bars
    .map(
      (bar) =>
        `<rect x='${bar.x}' y='${bar.y}' width='${bar.w}' height='${bar.h}' rx='3' ` +
        `fill='${tokenOf(bar.seriesIndex)}' fill-opacity='${opacityOf(bar.seriesIndex)}' data-series='${bar.seriesIndex}'/>`,
    )
    .join('')
  const valueLabels =
    series.length === 1 && categories.length <= 8
      ? geometry.bars
          .map(
            (bar) =>
              `<text x='${round2(bar.x + bar.w / 2)}' y='${round2(bar.y - 6)}' font-size='11' fill='var(--d-fg)' text-anchor='middle'>${formatNumber(bar.value)}</text>`,
          )
          .join('')
      : ''
  return svgOpen(ariaLabel, 'bar') + marks + axisMarkup(categories, (index) => groups[index] ?? [0], CHART.plotBaseY) + valueLabels + '</svg>'
}

function lineSvg(categories, series, ariaLabel) {
  const geometry = lineGeometry(categories, series)
  const groups = categories.map((_category, index) => [
    round2(CHART.padX + index * geometry.step),
  ])
  const lines = geometry.lines
    .map((line) => {
      const points = line.points.map((point) => `${point.x},${point.y}`).join(' ')
      const dots = line.points
        .map((point) => `<circle cx='${point.x}' cy='${point.y}' r='${CHART.dotR}' fill='${tokenOf(line.seriesIndex)}'/>`)
        .join('')
      return (
        `<polyline points='${points}' fill='none' stroke='${tokenOf(line.seriesIndex)}' stroke-width='${CHART.strokeW}' ` +
        `stroke-linejoin='round' stroke-linecap='round' stroke-opacity='${opacityOf(line.seriesIndex)}' data-series='${line.seriesIndex}'/>` +
        dots
      )
    })
    .join('')
  return svgOpen(ariaLabel, 'line') + lines + axisMarkup(categories, (index) => groups[index] ?? [0], CHART.plotBaseY) + '</svg>'
}

function donutSvg(categories, series, ariaLabel) {
  const geometry = donutGeometry(categories, series)
  const marks = geometry.slices
    .map((slice) => {
      if (slice.sweep <= 0) return ''
      if (slice.sweep >= Math.PI * 2 - 1e-6) {
        const mid = (geometry.outer + geometry.inner) / 2
        return `<circle cx='${geometry.cx}' cy='${geometry.cy}' r='${mid}' fill='none' stroke='${tokenOf(slice.index)}' stroke-opacity='${opacityOf(slice.index)}' stroke-width='${geometry.outer - geometry.inner}'/>`
      }
      const path = arcPath(slice.startAngle, slice.endAngle, geometry.outer, geometry.inner, geometry.cx, geometry.cy)
      return `<path d='${path}' fill='${tokenOf(slice.index)}' fill-opacity='${opacityOf(slice.index)}' data-series='${slice.index}'/>`
    })
    .join('')
  const center =
    `<text x='${geometry.cx}' y='${geometry.cy + 4}' font-size='42' font-weight='600' fill='var(--d-fg)' text-anchor='middle'>${formatNumber(geometry.total)}</text>` +
    `<text x='${geometry.cx}' y='${geometry.cy + 32}' font-size='12' fill='var(--d-muted)' text-anchor='middle'>${escapeXml('Σ')}</text>`
  const legend = geometry.slices
    .slice(0, 6)
    .map((slice, index) => {
      const y = 64 + index * 44
      return (
        `<rect x='560' y='${y}' width='14' height='14' rx='3' fill='${tokenOf(slice.index)}' fill-opacity='${opacityOf(slice.index)}'/>` +
        `<text x='584' y='${y + 12}' font-size='15' fill='var(--d-fg)'>${escapeXml(slice.label)}</text>` +
        `<text x='${CHART.w - 24}' y='${y + 12}' font-size='15' fill='var(--d-muted)' text-anchor='end'>${formatNumber(slice.value)}</text>`
      )
    })
    .join('')
  return svgOpen(ariaLabel, 'donut') + marks + center + legend + '</svg>'
}

function stackedSvg(categories, series, ariaLabel) {
  const geometry = stackedGeometry(categories, series)
  const marks = geometry.groups
    .map((group) =>
      group.segments
        .map(
          (segment, index) =>
            `<rect x='${segment.x}' y='${segment.y}' width='${segment.w}' height='${segment.h}' ` +
            `fill='${tokenOf(segment.seriesIndex)}' fill-opacity='${opacityOf(segment.seriesIndex)}' data-series='${segment.seriesIndex}'/>` +
            (index === group.segments.length - 1
              ? `<text x='${round2(segment.x + segment.w / 2)}' y='${round2(segment.y - 6)}' font-size='11' fill='var(--d-fg)' text-anchor='middle'>${formatNumber(group.total)}</text>`
              : ''),
        )
        .join(''),
    )
    .join('')
  const labels = geometry.groups.map((group) => [round2(group.x + group.w / 2)])
  return svgOpen(ariaLabel, 'stacked') + marks + axisMarkup(categories, (index) => labels[index] ?? [0], CHART.plotBaseY) + '</svg>'
}

/**
 * 生成图表 SVG（唯一入口）。颜色只用 `var(--d-*)`；返回 viewBox 与统计信息。
 */
function renderChartSvg(type, model, opts) {
  const options = opts ?? {}
  const categories = Array.isArray(model && model.categories) ? model.categories : []
  const series = Array.isArray(model && model.series) ? model.series.slice(0, LIMITS.series) : []
  const ariaLabel = options.ariaLabel ?? `${type} · ${categories.length}`
  let source = ''
  if (type === 'line') source = lineSvg(categories, series, ariaLabel)
  else if (type === 'donut') source = donutSvg(categories, series, ariaLabel)
  else if (type === 'stacked') source = stackedSvg(categories, series, ariaLabel)
  else source = barSvg(categories, series, ariaLabel)
  return {
    type: CHART_TYPES.includes(type) ? type : 'bar',
    source,
    viewBox: [0, 0, CHART.w, CHART.h],
    seriesCount: series.length,
    categoryCount: categories.length,
    max: Math.max(1, seriesMax(series)),
    total: round2(
      categories.reduce((sum, _category, index) => {
        let categorySum = 0
        for (const item of series) if (Number.isFinite(item.values[index])) categorySum += Math.max(0, item.values[index])
        return sum + categorySum
      }, 0),
    ),
  }
}

/* =============================== 5. 数据模型 =============================== */

/** FNV-1a 32 位：插件内没有 sha256，用它给 source 做稳定指纹（记录里只做「是否变化」判断）。 */
function fnv1a(text) {
  let hash = 0x811c9dc5
  const value = String(text ?? '')
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (`00000000${hash.toString(16)}`).slice(-8)
}

function digestOfSource(source) {
  return `fnv1a:${fnv1a(source)}`
}

function sanitizeStoredCell(cell) {
  return String(cell ?? '').slice(0, LIMITS.cellChars)
}

/** 图表记录（storage `charts.<blockId>`，≤12 KB/张的典型形态，见 05 §4.6）。 */
function makeChartRecord(input) {
  const source = String((input && input.source) || '')
  const table = (input && input.table) || { headers: [], rows: [] }
  return {
    v: 1,
    type: CHART_TYPES.includes(input && input.type) ? input.type : 'bar',
    headers: (Array.isArray(table.headers) ? table.headers : []).slice(0, LIMITS.cols).map(sanitizeStoredCell),
    rows: (Array.isArray(table.rows) ? table.rows : [])
      .slice(0, STORE_ROWS)
      .map((row) => (Array.isArray(row) ? row.slice(0, LIMITS.cols).map(sanitizeStoredCell) : [])),
    updatedAt: Date.now(),
    sourceDigest: digestOfSource(source),
    sourceChars: source.length,
  }
}

/** 记录 → 图表模型（回改时重建 source，不需要读块源码）。 */
function recordToModel(record) {
  if (!record || record.v !== 1) return null
  const table = { ok: true, headers: record.headers ?? [], rows: record.rows ?? [], truncated: false }
  return toSeries(table)
}

function chartStorageKey(blockId) {
  return `${CHART_PREFIX}${blockId}`
}

/**
 * 绑定索引（LRU 24）：[{ blockId, slideId, type, updatedAt }]，最新在前。
 * 超限 → 返回被淘汰的旧记录，调用方负责删除 + toast（不静默）。
 */
function upsertChartIndex(index, entry, limit) {
  const max = Number.isFinite(limit) ? limit : LRU_LIMIT
  const list = Array.isArray(index) ? index.filter((item) => item && typeof item.blockId === 'string' && item.blockId !== entry.blockId) : []
  const next = [
    {
      blockId: entry.blockId,
      slideId: entry.slideId ?? '',
      type: CHART_TYPES.includes(entry.type) ? entry.type : 'bar',
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
    },
    ...list,
  ]
  const kept = next.slice(0, max)
  const evicted = next.slice(max)
  return { index: kept, evicted }
}

function findBoundChart(index, slideId) {
  if (!Array.isArray(index)) return null
  for (const entry of index) {
    if (entry && entry.slideId === slideId) return entry
  }
  return null
}

function removeChartFromIndex(index, blockId) {
  return (Array.isArray(index) ? index : []).filter((entry) => entry && entry.blockId !== blockId)
}

/* =============================== 6. 配方构建 =============================== */

function contentToModel(content) {
  const points = Array.isArray(content && content.points) ? content.points : []
  const categories = []
  const values = []
  for (const point of points) {
    if (typeof point !== 'string') continue
    const separator = point.lastIndexOf('=')
    if (separator <= 0) continue
    const label = point.slice(0, separator).trim()
    const value = parseNumber(point.slice(separator + 1))
    if (label === '' || value === null) continue
    categories.push(label)
    values.push(value)
  }
  if (categories.length < 2) return null
  const lang = content && content.lang === 'en' ? 'en' : 'zh'
  const seriesName = (content && content.headline) || (lang === 'en' ? 'Value' : '数值')
  return {
    ok: true,
    categories,
    series: [{ name: seriesName, values }],
    skipped: 0,
    validRatio: 1,
    overflow: false,
    datasetTruncated: false,
    error: null,
  }
}

function chartTextBlocks(content) {
  const lang = content && content.lang === 'en' ? 'en' : 'zh'
  const headline = String((content && content.headline) || (lang === 'en' ? 'Data' : '数据')).slice(0, 120)
  const caption = String(
    (content && content.caption) || (lang === 'en' ? 'Source: pasted data' : '数据来源：粘贴数据'),
  ).slice(0, 160)
  return { headline, caption }
}

/**
 * 配方 build：返回 PluginBlockInput[]（3 块：标题 text + svg + 图注 text，几何见 05 §4.4）。
 * points 不足 2 条 → 返回空数组，宿主按 02 §9.2 回落 statement（不抛错）。
 */
function buildRecipeBlocks(type, content, themeId) {
  const model = contentToModel(content)
  if (!model) return []
  const texts = chartTextBlocks(content)
  const aria =
    (content && content.lang === 'en' ? `${RECIPE_TITLES[type].en}: ${texts.headline}` : `${RECIPE_TITLES[type].zh}：${texts.headline}`)
  const svg = renderChartSvg(type, model, { ariaLabel: aria })
  void themeId
  return [
    {
      type: 'text',
      x: 120,
      y: 136,
      w: 1360,
      h: 72,
      text: texts.headline,
      variant: 'h1',
      align: 'left',
      color: 'fg',
      inline: true,
    },
    {
      type: 'svg',
      x: 120,
      y: 350,
      w: 1360,
      h: 420,
      viewBox: svg.viewBox,
      source: svg.source,
      animate: 'none',
      opacity: 1,
    },
    {
      type: 'text',
      x: 120,
      y: 780,
      w: 1360,
      h: 36,
      text: texts.caption,
      variant: 'caption',
      align: 'left',
      color: 'muted',
      inline: true,
    },
  ]
}

/* =============================== 7. 宿主桥接 =============================== */

const state = {
  frames: [],
  snapshot: null,
  index: [],
  raw: '',
  table: null,
  model: null,
  type: 'bar',
  error: null,
  parsedOnce: false,
  bound: null,
  ui: null,
  announce: '',
  busy: false,
}

function lang() {
  return lumen.meta && lumen.meta.locale === 'en' ? 'en' : 'zh'
}

function toast(kind, key, vars) {
  lumen.notify.toast({ kind, message: t(key, vars) })
}

function codeOf(err) {
  return err && typeof err.code === 'string' ? err.code : ''
}

function reportFailure(err, fallbackKey) {
  const code = codeOf(err)
  lumen.log.warn('chartkit: action failed', code || err)
  if (code === 'E-CAP-01' || code === 'E-CAP-02') toast('error', 'error.writeDenied')
  else toast('error', fallbackKey || 'error.validRatio')
}

async function loadIndex() {
  try {
    const raw = await lumen.storage.get(INDEX_KEY)
    state.index = Array.isArray(raw) ? raw.filter((entry) => entry && typeof entry.blockId === 'string') : []
  } catch {
    state.index = []
  }
  return state.index
}

async function saveIndex(index) {
  state.index = index
  try {
    await lumen.storage.set(INDEX_KEY, index)
  } catch {
    /* 索引写失败不改 deck */
  }
}

async function loadRecord(blockId) {
  try {
    return await lumen.storage.get(chartStorageKey(blockId))
  } catch {
    return null
  }
}

async function removeRecord(blockId) {
  try {
    await lumen.storage.remove(chartStorageKey(blockId))
  } catch {
    /* 忽略 */
  }
}

async function saveDraft(raw) {
  const text = String(raw ?? '').slice(0, DRAFT_MAX)
  state.raw = text
  try {
    if (text === '') await lumen.storage.remove(DRAFT_KEY)
    else await lumen.storage.set(DRAFT_KEY, text)
  } catch {
    /* 草稿失败不影响解析 */
  }
}

async function loadDraft() {
  try {
    const raw = await lumen.storage.get(DRAFT_KEY)
    return typeof raw === 'string' ? raw : ''
  } catch {
    return ''
  }
}

async function refreshSnapshot() {
  try {
    state.snapshot = await lumen.deck.getSnapshot()
  } catch {
    state.snapshot = null
  }
  const activeSlideId = state.snapshot && state.snapshot.activeSlideId
  state.bound = activeSlideId ? findBoundChart(state.index, activeSlideId) : null
}

function parseAndUpdate() {
  state.table = parseTable(state.raw)
  if (!state.table.ok) {
    state.model = null
    state.error = state.table.error
    state.announce = ''
    return
  }
  state.model = toSeries(state.table)
  if (state.model.ok) {
    state.error = null
    state.announce = state.model.skipped > 0
      ? t('panel.recognizedWithSkip', {
          rows: state.table.rowCount,
          cols: state.table.columnCount,
          skipped: state.model.skipped,
        })
      : t('panel.recognized', { rows: state.table.rowCount, cols: state.table.columnCount })
  } else {
    state.error = state.model.error
    state.announce = ''
  }
}

function errorText(error) {
  if (!error) return ''
  const vars = error.line ? { line: error.line } : error.max ? { max: error.max } : {}
  const key =
    error.code === 'csvQuote'
      ? 'error.csvQuote'
      : error.code === 'csvColumns'
        ? 'error.csvColumns'
        : error.code === 'badJson'
          ? 'error.badJson'
          : error.code === 'dataset'
            ? 'error.dataset'
            : error.code === 'empty'
              ? 'error.empty'
              : error.code === 'tooFew' || error.code === 'tooFewColumns'
                ? 'error.tooFew'
                : 'error.validRatio'
  return t(key, vars)
}

/* ---- 写入路径 ---- */

async function saveChart(blockId, slideId, record) {
  try {
    await lumen.storage.set(chartStorageKey(blockId), record)
  } catch (err) {
    reportFailure(err, 'error.writeDenied')
  }
  const { index, evicted } = upsertChartIndex(state.index, { blockId, slideId, type: record.type, updatedAt: record.updatedAt })
  await saveIndex(index)
  if (evicted.length > 0) {
    for (const entry of evicted) await removeRecord(entry.blockId)
    toast('info', 'toast.evicted')
  }
}

async function insertChart(typeOverride) {
  const type = CHART_TYPES.includes(typeOverride) ? typeOverride : state.type
  if (!state.table || !state.table.ok || !state.model || !state.model.ok) {
    toast('info', 'error.empty')
    return
  }
  await refreshSnapshot()
  const slideId = state.snapshot && (state.snapshot.activeSlideId || (state.snapshot.slides[0] && state.snapshot.slides[0].id))
  if (!slideId) {
    toast('info', 'error.noDeck')
    return
  }
  const aria = t('a11y.preview', { type: t(`type.${type}`), count: state.model.categories.length })
  const svg = renderChartSvg(type, state.model, { ariaLabel: aria })
  const blocks = [
    { type: 'svg', x: 120, y: 200, w: 1360, h: 420, viewBox: svg.viewBox, source: svg.source, animate: 'none', opacity: 1 },
    {
      type: 'text',
      x: 120,
      y: 660,
      w: 1360,
      h: 36,
      text: t('panel.title'),
      variant: 'caption',
      align: 'left',
      color: 'muted',
      inline: true,
    },
  ]
  try {
    const result = await lumen.deck.insertBlocks(slideId, blocks)
    const blockId = result && Array.isArray(result.blockIds) ? result.blockIds[0] : ''
    if (blockId) {
      const record = makeChartRecord({ type, table: state.table, source: svg.source })
      await saveChart(blockId, slideId, record)
      state.bound = { blockId, slideId, type, updatedAt: record.updatedAt }
      toast('success', 'toast.inserted')
    }
  } catch (err) {
    reportFailure(err, 'error.writeDenied')
  }
  await refreshSnapshot()
  syncPanel()
}

async function updateChart() {
  if (!state.bound) {
    toast('info', 'error.notBound')
    return
  }
  if (!state.model || !state.model.ok || !state.table || !state.table.ok) {
    toast('info', 'error.empty')
    return
  }
  const type = state.bound.type
  const aria = t('a11y.preview', { type: t(`type.${type}`), count: state.model.categories.length })
  const svg = renderChartSvg(type, state.model, { ariaLabel: aria })
  try {
    await lumen.deck.updateBlock(state.bound.blockId, { source: svg.source, viewBox: svg.viewBox })
    const record = makeChartRecord({ type, table: state.table, source: svg.source })
    record.updatedAt = Date.now()
    await saveChart(state.bound.blockId, state.bound.slideId, record)
    state.bound = { ...state.bound, updatedAt: record.updatedAt }
    toast('success', 'toast.updated')
  } catch (err) {
    reportFailure(err, 'error.writeDenied')
  }
  await refreshSnapshot()
  syncPanel()
}

async function detachChart() {
  if (!state.bound) {
    toast('info', 'error.notBound')
    return
  }
  const blockId = state.bound.blockId
  await saveIndex(removeChartFromIndex(state.index, blockId))
  await removeRecord(blockId)
  state.bound = null
  toast('info', 'toast.detached')
  await refreshSnapshot()
  syncPanel()
}

/* =============================== 8. ABI 注册 =============================== */

function localized(spec, params) {
  const fill = (template) =>
    String(template).replace(/\{(\w+)\}/g, (all, key) => (params && Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : all))
  return { zh: fill(spec.zh), en: fill(spec.en) }
}

function chartEntriesForCtx(ctx) {
  const slides = ctx && Array.isArray(ctx.slides) ? ctx.slides : []
  const byId = new Map()
  for (const slide of slides) {
    for (const block of Array.isArray(slide.blocks) ? slide.blocks : []) {
      if (block && typeof block.id === 'string') byId.set(block.id, slide.id)
    }
  }
  return state.index
    .map((entry) => ({ entry, slideId: byId.get(entry.blockId) }))
    .filter((item) => item.slideId)
}

async function ruleSeriesOverflow(ctx) {
  const findings = []
  for (const { entry, slideId } of chartEntriesForCtx(ctx)) {
    const record = await loadRecord(entry.blockId)
    const model = recordToModel(record)
    if (!model) continue
    const count = model.series.length
    if (count > LIMITS.series) {
      findings.push({
        slideId,
        blockId: entry.blockId,
        message: localized(CODE_MSG.series, { count, max: LIMITS.series }),
        params: { count, max: LIMITS.series },
      })
    }
  }
  return findings
}

async function ruleAxisLabelMissing(ctx) {
  const findings = []
  for (const { entry, slideId } of chartEntriesForCtx(ctx)) {
    const record = await loadRecord(entry.blockId)
    const model = recordToModel(record)
    if (!model) continue
    const labels = model.categories
    const missing = labels.length < 2 || labels.some((label) => String(label).trim() === '' || /^#\d+$/.test(String(label)))
    if (missing) {
      findings.push({
        slideId,
        blockId: entry.blockId,
        message: localized(CODE_MSG.axis),
        params: { count: labels.length },
      })
    }
  }
  return findings
}

async function ruleChartContrast(ctx) {
  const entries = chartEntriesForCtx(ctx)
  if (entries.length === 0) return []
  let theme
  try {
    theme = await lumen.theme.get()
  } catch {
    return []
  }
  const colors = (theme && theme.colors) || {}
  const ratio = lumen.lint.helpers.contrastRatio(colors.accent, colors.bg)
  if (typeof ratio !== 'number' || ratio >= 3) return []
  const rounded = Math.round(ratio * 10) / 10
  return [
    {
      message: localized(CODE_MSG.contrast, { ratio: rounded }),
      params: { ratio: rounded },
    },
  ]
}

/* 顶层注册（ready 前完成，02 §6.9）：
 * 全部**同步发出**（无顶层 await）——宿主 bootstrap 在 DOMContentLoaded 检查求值哨兵，
 * 顶层 await 会与之赛跑（02 §4.3）；注册请求是同步 postMessage，FIFO 保证先注册后 ready。
 */
function registerSafely(label, fn) {
  try {
    fn()
  } catch (err) {
    lumen.log.warn(`chartkit: register ${label} failed`, err && err.code ? err.code : err)
  }
}

function registerRecipesSync() {
  for (const type of RECIPE_TYPES) {
    registerSafely(`recipe.${type}`, () =>
      lumen.ai.registerRecipe({
        id: type,
        namespace: RECIPE_NS,
        title: RECIPE_TITLES[type],
        build: (content, themeId) => buildRecipeBlocks(type, content, themeId),
      }),
    )
  }
  registerSafely('recipe.promptFragment', () => lumen.ai.registerPromptFragment(PROMPT_FRAGMENT))
}

function registerAll() {
  registerSafely('command.open', () => lumen.commands.register({ id: 'open', title: CMD_TITLES.open, run: () => openPanel() }))
  registerSafely('command.insertBar', () =>
    lumen.commands.register({
      id: 'insert-bar',
      title: CMD_TITLES.insertBar,
      run: () => insertChart('bar'),
    }),
  )
  registerSafely('command.redrawSelected', () =>
    lumen.commands.register({
      id: 'redraw-selected',
      title: CMD_TITLES.redrawSelected,
      run: () => updateChart(),
    }),
  )
  registerSafely('lint.seriesOverflow', () =>
    lumen.lint.registerRule({
      id: 'series-overflow',
      title: { zh: '系列过多', en: 'Too many series' },
      severity: 'warn',
      run: ruleSeriesOverflow,
    }),
  )
  registerSafely('lint.axisLabelMissing', () =>
    lumen.lint.registerRule({
      id: 'axis-label-missing',
      title: { zh: '缺轴标签', en: 'Missing axis labels' },
      severity: 'warn',
      run: ruleAxisLabelMissing,
    }),
  )
  registerSafely('lint.chartContrast', () =>
    lumen.lint.registerRule({
      id: 'chart-contrast',
      title: { zh: '图表对比度', en: 'Chart contrast' },
      severity: 'warn',
      run: ruleChartContrast,
    }),
  )
  registerRecipesSync()
}

async function openPanel() {
  try {
    await lumen.ui.openPanel({ slot: 'workspace.inspector.tab', id: 'charts-panel' })
  } catch (err) {
    lumen.log.warn('chartkit: open panel failed', err && err.code)
  }
}

/* =============================== 9. UI =============================== */

const CSS = `
:where([data-chart-panel]) {
  font: 12.5px/1.55 var(--ui-font, system-ui), sans-serif;
  color: var(--ui-fg);
  padding: 12px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 100%;
}
:where([data-chart-panel]) .ck-head { display: flex; align-items: center; gap: 8px; }
:where([data-chart-panel]) .ck-title { font-size: 13px; font-weight: 600; }
:where([data-chart-panel]) .ck-hint { font-size: 11px; color: var(--ui-fg-mute); }
:where([data-chart-panel]) .ck-input {
  width: 100%; min-height: 96px; resize: vertical;
  border-radius: 8px; border: 1px solid var(--ui-line-strong);
  background: var(--ui-panel-2); color: var(--ui-fg);
  font-family: var(--ui-font-mono, ui-monospace); font-size: 11.5px;
  padding: 8px 10px; box-sizing: border-box;
}
:where([data-chart-panel]) .ck-input:focus { outline: 2px solid var(--ui-accent-line); outline-offset: 1px; }
:where([data-chart-panel]) .ck-state { font-size: 11.5px; color: var(--ui-fg-dim); min-height: 16px; }
:where([data-chart-panel]) .ck-error {
  border: 1px solid color-mix(in srgb, var(--ui-danger) 40%, var(--ui-line));
  background: var(--ui-danger-soft); border-radius: 8px; padding: 6px 8px; font-size: 12px;
}
:where([data-chart-panel]) .ck-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
:where([data-chart-panel]) .ck-tab {
  border: 1px solid var(--ui-line); background: transparent; color: var(--ui-fg-dim);
  border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 11.5px; cursor: pointer;
}
:where([data-chart-panel]) .ck-tab[aria-selected="true"] {
  color: var(--ui-fg); border-color: var(--ui-accent-line); background: var(--ui-accent-soft);
}
:where([data-chart-panel]) .ck-preview {
  border: 1px solid var(--ui-line); border-radius: 8px; background: var(--ui-panel-2);
  padding: 8px; min-height: 110px; display: grid; place-items: center; overflow: hidden;
}
:where([data-chart-panel]) .ck-preview svg { width: 100%; height: auto; max-height: 220px; }
:where([data-chart-panel]) .ck-empty {
  border: 1px dashed var(--ui-line-strong); border-radius: 10px; padding: 14px;
  text-align: center; color: var(--ui-fg-dim); display: flex; flex-direction: column; gap: 6px; align-items: center;
}
:where([data-chart-panel]) .ck-actions { display: flex; flex-direction: column; gap: 6px; margin-top: auto; }
:where([data-chart-panel]) .ck-row { display: flex; gap: 6px; flex-wrap: wrap; }
:where([data-chart-panel]) .ck-bound {
  border: 1px solid var(--ui-line); border-radius: 8px; padding: 6px 8px; font-size: 11.5px;
  display: flex; align-items: center; gap: 6px; color: var(--ui-fg-dim);
}
:where([data-chart-panel]) .ck-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.lumen-button[disabled] { opacity: .5; }
`

function h(tag, props, ...children) {
  return el(tag, props || null, ...children)
}

function button(label, opts) {
  const options = opts || {}
  const classes = ['lumen-button']
  if (options.variant) classes.push(`lumen-button--${options.variant}`)
  const node = h('button', { type: 'button', class: classes.join(' ') }, label)
  if (options.disabled) node.disabled = true
  if (options.action) node.setAttribute('data-chart-action', options.action)
  if (options.data) {
    for (const [key, value] of Object.entries(options.data)) node.setAttribute(key, String(value))
  }
  if (typeof options.onClick === 'function') node.addEventListener('click', options.onClick)
  return node
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

function frameKind(ctx) {
  if (!ctx || typeof ctx !== 'object') return 'panel'
  const slot = ctx.slot || ctx.slotId || ctx.slotName
  if (slot === 'dialog') return 'dialog'
  return 'panel'
}

function canvasOf(root) {
  const container = h('div', { class: 'ck-canvas' })
  root.append(container)
  return container
}

function renderPanel(root) {
  root.setAttribute('data-chart-panel', '')
  root.setAttribute('data-sdk', 'v1')
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', t('a11y.panel'))
  clearNode(root)

  const head = h('div', { class: 'ck-head' })
  head.append(h('span', { class: 'ck-title' }, t('panel.title')))
  head.append(h('span', { class: 'ck-hint' }, t('panel.hint')))
  const clear = button(t('panel.clear'), { variant: 'ghost', action: 'clear' })
  head.append(clear)
  root.append(head)

  const stateName = !state.raw.trim() ? 'empty' : state.error || (state.table && !state.table.ok) ? 'error' : state.bound ? 'bound' : 'parsed'
  root.setAttribute('data-chart-state', stateName)

  if (!state.raw.trim()) {
    const empty = h('div', { class: 'ck-empty' })
    empty.append(h('span', null, t('panel.empty')))
    root.append(empty)
  }

  const error = h('div', { class: 'ck-error', 'data-chart-error-line': '' })
  error.hidden = true
  root.append(error)

  const input = h('textarea', {
    class: 'ck-input',
    'data-chart-input': '',
    'aria-label': t('a11y.input'),
    placeholder: t('panel.paste'),
    spellcheck: 'false',
  })
  input.value = state.raw
  root.append(input)

  const status = h('div', { class: 'ck-state', 'aria-live': 'polite', 'data-chart-status': '' })
  root.append(status)

  const tabs = h('div', { class: 'ck-tabs', role: 'tablist', 'aria-label': t('a11y.tabs') })
  const tabButtons = {}
  for (const type of CHART_TYPES) {
    const tab = h('button', {
      type: 'button',
      class: 'ck-tab',
      role: 'tab',
      'data-chart-type': type,
      'aria-selected': type === state.type ? 'true' : 'false',
    }, t(`type.${type}`))
    tab.addEventListener('click', () => {
      state.type = type
      for (const [key, node] of Object.entries(tabButtons)) node.setAttribute('aria-selected', key === type ? 'true' : 'false')
      syncPanel()
    })
    tabButtons[type] = tab
    tabs.append(tab)
  }
  root.append(tabs)

  const preview = h('div', { class: 'ck-preview', 'data-chart-preview': '' })
  root.append(preview)

  const actions = h('div', { class: 'ck-actions' })
  const insert = button(t('action.insert'), { variant: 'primary', action: 'insert', data: { 'data-chart-insert': '' } })
  insert.addEventListener('click', () => void insertChart())
  actions.append(insert)

  if (state.bound) {
    const boundRow = h('div', { class: 'ck-bound', 'data-chart-bound': state.bound.blockId })
    boundRow.append(h('span', null, state.bound.type))
    const update = button(t('action.update'), { variant: 'ghost', action: 'update', data: { 'data-chart-update': '' } })
    update.addEventListener('click', () => void updateChart())
    const detach = button(t('action.detach'), { variant: 'ghost', action: 'detach', data: { 'data-chart-detach': '' } })
    detach.addEventListener('click', () => void detachChart())
    boundRow.append(update, detach)
    actions.append(boundRow)
  } else {
    const unbound = h('div', { class: 'ck-bound' }, t('panel.unbound'))
    actions.append(unbound)
  }
  root.append(actions)

  clear.addEventListener('click', () => {
    state.raw = ''
    state.table = null
    state.model = null
    state.error = null
    void saveDraft('')
    renderPanel(root)
    input.focus()
  })
  input.addEventListener('input', () => {
    state.raw = String(input.value)
    scheduleParse()
  })
  state.ui = { root, input, status, preview, insert, error }

  syncPanel()
  if (!state.parsedOnce) input.focus()
}

let parseTimer = 0

function scheduleParse() {
  if (parseTimer) clearTimeout(parseTimer)
  parseTimer = setTimeout(() => {
    parseTimer = 0
    parseAndUpdate()
    void saveDraft(state.raw)
    syncPanel()
  }, 250)
}

function syncPanel() {
  const ui = state.ui
  if (!ui || !ui.root) return
  const stateName = !state.raw.trim() ? 'empty' : state.error || (state.table && !state.table.ok) ? 'error' : state.bound ? 'bound' : 'parsed'
  ui.root.setAttribute('data-chart-state', stateName)
  if (!state.raw.trim()) ui.status.textContent = ''
  else if (state.error) ui.status.textContent = errorText(state.error)
  else if (state.announce) ui.status.textContent = state.announce
  else if (state.model && state.model.ok) ui.status.textContent = t('panel.recognized', { rows: state.table.rowCount, cols: state.table.columnCount })
  else ui.status.textContent = ''

  const ready = !!(state.table && state.table.ok && state.model && state.model.ok)
  ui.insert.disabled = !ready
  if (state.model && state.model.overflow) ui.status.textContent += ` · ${t('lint.series', { count: state.model.series.length, max: LIMITS.series })}`

  clearNode(ui.preview)
  if (ready) {
    const aria = t('a11y.preview', { type: t(`type.${state.type}`), count: state.model.categories.length })
    const svg = renderChartSvg(state.type, state.model, { ariaLabel: aria })
    ui.preview.innerHTML = svg.source
    const rendered = ui.preview.querySelector('svg')
    if (rendered) {
      rendered.setAttribute('data-chart-block', state.bound ? state.bound.blockId : 'preview')
      rendered.setAttribute('aria-label', aria)
    }
  } else {
    const empty = h('div', { class: 'ck-empty' }, state.raw.trim() ? t('panel.preview') : t('panel.empty'))
    ui.preview.append(empty)
  }
  const error = ui.root.querySelector('[data-chart-error-line]')
  if (ui.error) {
    if (state.error) {
      ui.error.hidden = false
      ui.error.textContent = errorText(state.error)
      ui.error.setAttribute('data-chart-error-line', String(state.error.line ?? ''))
    } else {
      ui.error.hidden = true
      ui.error.textContent = ''
      ui.error.removeAttribute('data-chart-error-line')
    }
  }
  void error
}

/* =============================== 10. 启动 =============================== */

lumen.ui.css(CSS)

/* 帧内数据装载（可与 ready 并行；面板先渲染，数据到位后 syncPanel 刷新）。 */
let bootPromise = null
function bootData() {
  if (!bootPromise) {
    bootPromise = (async () => {
      const draft = await loadDraft()
      if (!state.raw && draft) state.raw = draft
      await refreshSnapshot()
      await loadIndex()
      await refreshSnapshot()
      parseAndUpdate()
      if (state.ui && state.ui.input) state.ui.input.value = state.raw
      syncPanel()
    })().catch((err) => {
      lumen.log.warn('chartkit: boot failed', err && err.code)
    })
  }
  return bootPromise
}

lumen.ui.onRender((root, ctx) => {
  const kind = frameKind(ctx)
  lumen.ui.setTitle(t('panel.title'))
  clearNode(root)
  state.frames = state.frames.filter((frame) => frame.root !== root)
  state.frames.push({ root, kind })
  state.ui = null
  renderPanel(root)
  void bootData()
})

try {
  lumen.events.on('deck:change', () => {
    void refreshSnapshot().then(() => syncPanel())
  })
  lumen.events.on('slide:change', () => {
    void refreshSnapshot().then(() => syncPanel())
  })
} catch (err) {
  lumen.log.warn('chartkit: subscribe failed', err && err.code)
}

/* 同步段：注册必须在 ready 前完成；数据装载不阻塞求值（避免与 DOMContentLoaded 赛跑）。 */
registerAll()
void bootData()

/* 供单元测试直接 import 的纯函数面（运行时不使用）。 */
export {
  PLUGIN_ID,
  LIMITS,
  CHART,
  SERIES_TOKENS,
  CHART_TYPES,
  RECIPE_TYPES,
  RECIPE_NS,
  INDEX_KEY,
  DRAFT_KEY,
  LRU_LIMIT,
  CODE_MSG,
  RECIPE_TITLES,
  PROMPT_FRAGMENT,
  parseNumber,
  detectFormat,
  parseDelimited,
  parseJsonTable,
  parseTable,
  toSeries,
  seriesMax,
  barGeometry,
  lineGeometry,
  donutGeometry,
  stackedGeometry,
  polarPoint,
  arcPath,
  renderChartSvg,
  escapeXml,
  formatNumber,
  fnv1a,
  digestOfSource,
  makeChartRecord,
  recordToModel,
  chartStorageKey,
  upsertChartIndex,
  findBoundChart,
  removeChartFromIndex,
  contentToModel,
  buildRecipeBlocks,
}
