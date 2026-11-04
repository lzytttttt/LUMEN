/**
 * plugin.js —— BrandGuard / 品牌守护 · LUMEN ABI v1（示例插件，单文件 ESM）
 *
 * 能力：ui:slot · ui:command · theme:contribute · library:contribute · i18n:contribute
 *       lint:rule · storage · deck:read · deck:write · asset:write · export:hook
 * 预算：包 ≤ 80 KB（本文件 ≤ 60 KB），首帧 ≤ 150 ms；零网络、零外链、零依赖。
 *
 * 与宿主的唯一接口是 `globalThis.lumen`（ABI v1，02 §5.3）。本文件里：
 *   - 前半部分是纯函数（kit → 主题、色板距离、规则判定），单元测试直接 import 它们；
 *   - 后半部分是渲染与 ABI 注册，入口在文件末尾（顶层 await 保证 ready 前完成注册）。
 *
 * 降级说明（Lead 2026-11-03 裁定，不改 ABI）：
 *   `deck:read` 只给结构与只读元数据（不含块正文 / SVG 源码），因此
 *   - paletteTolerance 检测的是「主题令牌 vs 品牌 kit 偏差」（含用户 themeOverrides），
 *     不是 SVG 里的硬编码色值；
 *   - taglineMissing 用首幕 textChars 启发式，不读正文；
 *   - fixPalette 只重新应用品牌主题并提示手动 token 化，不 patch block.source。
 */

const PLUGIN_ID = 'com.lumen.samples.brandguard'
const lumen = globalThis.lumen
if (!lumen) throw new Error('LUMEN ABI v1 is required')

const el = lumen.ui.el
const t = (key, vars) => lumen.i18n.t(key, vars)

/* =============================== 1. 纯逻辑 =============================== */

const KIT_KEY = 'kit.current'
const HISTORY_KEY = 'kit.history'
const LOGO_KEY = 'logo.blocks'
const HISTORY_LIMIT = 3
const TRACK_LIMIT = 200
const TAGLINE_MAX = 120

/** 品牌 logo 的安全位（舞台 1600×900，安全边距 120/96，右下留 48px 余量）。 */
const SAFE_RIGHT_X = 1432
const SAFE_BOTTOM_Y = 756
const LOGO_MIN_W = 120
const LOGO_MAX_W = 320
const LOGO_W = 240
const LOGO_H = 48
const PALETTE_TOLERANCE = 24

const FONT_SANS =
  "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
const FONT_SERIF = "'Songti SC', 'SimSun', Georgia, 'Times New Roman', serif"
const FONT_PINGFANG = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
const FONT_YAHEI = "'Microsoft YaHei', 'PingFang SC', 'Segoe UI', sans-serif"
const FONT_GEORGIA = "Georgia, 'Times New Roman', 'Songti SC', serif"
const FONT_MONO = "ui-monospace, 'SF Mono', Consolas, 'Courier New', monospace"

/** 品牌字体白名单：6 条系统栈（05 §3.4）。字体串包含其中之一即通过。 */
const FONT_WHITELIST = [
  'system-ui',
  'PingFang SC',
  'Microsoft YaHei',
  'Songti SC',
  'Georgia',
  'ui-monospace',
]

const FONT_OPTIONS = [
  { value: FONT_SANS, family: 'system-ui' },
  { value: FONT_PINGFANG, family: 'PingFang SC' },
  { value: FONT_YAHEI, family: 'Microsoft YaHei' },
  { value: FONT_SERIF, family: 'Songti SC' },
  { value: FONT_GEORGIA, family: 'Georgia' },
  { value: FONT_MONO, family: 'ui-monospace' },
]

const THEME_PRESETS = [
  { id: 'brand-blue', accent: '#1F6FEB', accent2: '#22B8CF' },
  { id: 'brand-teal', accent: '#0E9F9F', accent2: '#F2C14E' },
  { id: 'brand-graphite', accent: '#6E8BFF', accent2: '#9AA4B2' },
]

const THEME_NAMES = {
  'brand-blue': { zh: '品牌·蓝', en: 'Brand Blue' },
  'brand-teal': { zh: '品牌·青', en: 'Brand Teal' },
  'brand-graphite': { zh: '品牌·石墨', en: 'Brand Graphite' },
}

const BRAND_THEME_IDS = THEME_PRESETS.map((preset) => `${PLUGIN_ID}/${preset.id}`)

const DEFAULT_KIT = {
  v: 1,
  primary: '#1F6FEB',
  secondary: '#22B8CF',
  displayFont: FONT_SANS,
  bodyFont: FONT_SANS,
  tagline: '',
  logoAssetId: null,
  preferredTheme: 'auto',
  updatedAt: 0,
}

/** 与宿主语言包无关的规则 / 预检文案（finding 需要 zh+en 双语，见 02 §5.3）。 */
const MSG = {
  logoPlacement: { zh: 'Logo 未落在右下安全位', en: 'Logo outside the bottom-right safe area' },
  paletteTolerance: {
    zh: '色值偏离品牌色板（最近 {name}）',
    en: 'Colour outside the brand palette (closest {name})',
  },
  fontWhitelist: { zh: '字体不在品牌白名单', en: 'Font not in the brand whitelist' },
  taglineMissing: { zh: '封面缺少品牌 tagline', en: 'Cover missing the brand tagline' },
  preflightThemeOff: { zh: '当前演示未使用品牌主题', en: 'This deck does not use a brand theme' },
  preflightOk: { zh: '品牌预检通过', en: 'Brand preflight passed' },
  preflightLogo: {
    zh: '有 {count} 幕的 logo 不在右下安全位',
    en: 'Logo is outside the safe area on {count} slides',
  },
  preflightTagline: { zh: '封面缺少品牌 tagline', en: 'Cover is missing the brand tagline' },
  preflightPalette: {
    zh: '有 {count} 个颜色偏离品牌色板（最近 {name}）',
    en: '{count} colours drift from the brand palette (closest {name})',
  },
  preflightFont: { zh: '字体不在品牌白名单', en: 'Font is not in the brand whitelist' },
  preflightStrict: {
    zh: '严格模式：请确认以上警告后再导出',
    en: 'Strict mode: confirm the warnings above before exporting',
  },
}

const THEME_BY_ID = Object.fromEntries(THEME_PRESETS.map((preset) => [preset.id, preset]))

/** 预检结果的修复入口（PreflightResult.fix.commandId；宿主命令 id 口径 `plugin.<pluginId>.<localId>`）。 */
const FIX = {
  apply: { commandId: `plugin.${PLUGIN_ID}.apply` },
  insertLogo: { commandId: `plugin.${PLUGIN_ID}.insert-logo` },
  fixPalette: { commandId: `plugin.${PLUGIN_ID}.fix-palette` },
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cloneKit(kit) {
  return { ...kit }
}

/** '#rgb' / '#rrggbb' → [r,g,b]；非法返回 null。 */
function parseHexColor(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw.startsWith('#')) return null
  const body = raw.slice(1)
  if (!/^[0-9a-fA-F]{3}$/.test(body) && !/^[0-9a-fA-F]{6}$/.test(body)) return null
  const full =
    body.length === 3
      ? body
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : body
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

function rgbDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

/** 两个十六进制色的 RGB 欧氏距离（05 §3.4 的容差口径：≤24 通过）。 */
function paletteDistance(hexA, hexB) {
  const a = parseHexColor(hexA)
  const b = parseHexColor(hexB)
  if (!a || !b) return Number.POSITIVE_INFINITY
  return rgbDistance(a, b)
}

/**
 * kit.primary → 最近的品牌预设主题。
 * preferredTheme 不是 'auto' 时按用户偏好强制；matched 表示是否落在容差内。
 */
function nearestTheme(primaryHex, preferredTheme) {
  const preferred = typeof preferredTheme === 'string' ? preferredTheme : 'auto'
  if (preferred !== 'auto' && THEME_BY_ID[preferred]) {
    return {
      id: preferred,
      themeId: `${PLUGIN_ID}/${preferred}`,
      distance: paletteDistance(primaryHex, THEME_BY_ID[preferred].accent),
      matched: true,
      forced: true,
    }
  }
  const primary = parseHexColor(primaryHex) ? primaryHex : DEFAULT_KIT.primary
  let best = THEME_PRESETS[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const preset of THEME_PRESETS) {
    const distance = paletteDistance(primary, preset.accent)
    if (distance < bestDistance) {
      best = preset
      bestDistance = distance
    }
  }
  return {
    id: best.id,
    themeId: `${PLUGIN_ID}/${best.id}`,
    distance: bestDistance,
    matched: bestDistance <= PALETTE_TOLERANCE,
    forced: false,
  }
}

function kitToThemeId(kit) {
  const safe = normalizeKit(kit).kit
  return nearestTheme(safe.primary, safe.preferredTheme).themeId
}

/**
 * 把 storage / 外部输入收敛成合法 kit。
 * status：'ready'（可用）| 'corrupt'（损坏，调用方应重置并提示）| 'empty'（没设置过）。
 */
function normalizeKit(raw) {
  if (raw === undefined || raw === null) {
    return { kit: cloneKit(DEFAULT_KIT), status: 'empty' }
  }
  if (!isPlainObject(raw)) return { kit: cloneKit(DEFAULT_KIT), status: 'corrupt' }
  if (raw.v !== 1) return { kit: cloneKit(DEFAULT_KIT), status: 'corrupt' }
  if (!parseHexColor(raw.primary) || !parseHexColor(raw.secondary)) {
    return { kit: cloneKit(DEFAULT_KIT), status: 'corrupt' }
  }
  const preferredTheme =
    typeof raw.preferredTheme === 'string' && (raw.preferredTheme === 'auto' || THEME_BY_ID[raw.preferredTheme])
      ? raw.preferredTheme
      : 'auto'
  const kit = {
    v: 1,
    primary: String(raw.primary).trim(),
    secondary: String(raw.secondary).trim(),
    displayFont: typeof raw.displayFont === 'string' ? raw.displayFont.slice(0, 200) : FONT_SANS,
    bodyFont: typeof raw.bodyFont === 'string' ? raw.bodyFont.slice(0, 200) : FONT_SANS,
    tagline: typeof raw.tagline === 'string' ? raw.tagline.slice(0, TAGLINE_MAX) : '',
    logoAssetId: typeof raw.logoAssetId === 'string' && raw.logoAssetId ? raw.logoAssetId : null,
    preferredTheme,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  }
  return { kit, status: 'ready' }
}

function makeKit(patch, base) {
  const merged = { ...normalizeKit(base).kit, ...(patch || {}), v: 1, updatedAt: Date.now() }
  return normalizeKit(merged).kit
}

/** 字体串是否命中 6 条系统栈之一（大小写不敏感）。 */
function isFontAllowed(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  const lower = value.toLowerCase()
  return FONT_WHITELIST.some((family) => lower.includes(family.toLowerCase()))
}

/** kit 里与给定色最近的品牌色（用于「最近 {name}」提示与修复建议）。 */
function nearestBrandColor(hex, kit) {
  const safe = normalizeKit(kit).kit
  const candidates = [
    { token: 'accent', value: safe.primary },
    { token: 'accent2', value: safe.secondary },
  ]
  let best = candidates[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const distance = paletteDistance(hex, candidate.value)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return { token: best.token, value: best.value, distance: bestDistance }
}

/**
 * 主题令牌 vs 品牌 kit 的偏差（降级实现：ABI 1.0 不开放块正文/源码）。
 * baseColors = lumen.theme.get().colors；appliedVars = lumen.theme.cssVars()（已含用户 override）。
 * 返回 [{ token, applied, expected, distance }]，token ∈ accent / accent2。
 */
function overridePaletteIssues(baseColors, appliedVars, kit, tolerance) {
  const safe = normalizeKit(kit).kit
  const limit = Number.isFinite(tolerance) ? tolerance : PALETTE_TOLERANCE
  const vars = appliedVars && typeof appliedVars === 'object' ? appliedVars : {}
  const base = baseColors && typeof baseColors === 'object' ? baseColors : {}
  const issues = []
  const pairs = [
    { token: 'accent', cssVar: '--d-accent', expected: safe.primary },
    { token: 'accent2', cssVar: '--d-accent2', expected: safe.secondary },
  ]
  for (const pair of pairs) {
    const applied = typeof vars[pair.cssVar] === 'string' ? vars[pair.cssVar] : base[pair.token]
    if (typeof applied !== 'string') continue
    const baseValue = typeof base[pair.token] === 'string' ? base[pair.token] : applied
    const overridden = paletteDistance(applied, baseValue) > 0.5
    if (!overridden) continue
    const distance = paletteDistance(applied, pair.expected)
    if (distance > limit) {
      issues.push({ token: pair.token, applied, expected: pair.expected, distance })
    }
  }
  return issues
}

function normalizeTagline(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, '').toLowerCase() : ''
}

/**
 * 首幕 tagline 启发式（降级实现：只读 textChars，不读正文）。
 * coverTextChars = 首幕所有 text 块的 textChars 之和（ctx.slides[0].blocks）。
 */
function taglineCoverage(coverTextChars, tagline) {
  const expected = normalizeTagline(tagline).length
  const actual = Number.isFinite(coverTextChars) ? coverTextChars : 0
  return { configured: expected > 0, expected, actual, ok: expected === 0 || actual >= expected }
}

/** storage 里的插入记录 → 只取 blockId 集合。 */
function logoBlockIds(tracked) {
  const ids = new Set()
  if (!Array.isArray(tracked)) return ids
  for (const entry of tracked) {
    if (entry && typeof entry.blockId === 'string') ids.add(entry.blockId)
  }
  return ids
}

function isLogoBlock(block, trackedIds) {
  if (!block || typeof block !== 'object') return false
  if (trackedIds && trackedIds.has(block.id)) return true
  const presetId = typeof block.presetId === 'string' ? block.presetId : ''
  return presetId === `${PLUGIN_ID}/lockup` || presetId === `${PLUGIN_ID}/mark`
}

/**
 * logoPlacement 判定（05 §3.4）：只检查「本插件 logo 块」，
 * x+w ≥ 1432、y+h ≥ 756、宽 120–320；返回 [{slideId, blockId, reason}]。
 */
function logoPlacementIssues(slides, trackedIds, limits) {
  const box = limits || {}
  const rightX = Number.isFinite(box.rightX) ? box.rightX : SAFE_RIGHT_X
  const bottomY = Number.isFinite(box.bottomY) ? box.bottomY : SAFE_BOTTOM_Y
  const minW = Number.isFinite(box.minW) ? box.minW : LOGO_MIN_W
  const maxW = Number.isFinite(box.maxW) ? box.maxW : LOGO_MAX_W
  const issues = []
  if (!Array.isArray(slides)) return issues
  for (const slide of slides) {
    const blocks = Array.isArray(slide && slide.blocks) ? slide.blocks : []
    for (const block of blocks) {
      if (!isLogoBlock(block, trackedIds)) continue
      const x = Number(block.x) || 0
      const y = Number(block.y) || 0
      const w = Number(block.w) || 0
      const h = Number(block.h) || 0
      if (x + w < rightX) issues.push({ slideId: slide.id, blockId: block.id, reason: 'right' })
      else if (y + h < bottomY) issues.push({ slideId: slide.id, blockId: block.id, reason: 'bottom' })
      else if (w < minW || w > maxW) issues.push({ slideId: slide.id, blockId: block.id, reason: 'width' })
    }
  }
  return issues
}

/** kit 历史：最近 3 版（环形，最新在前，内容相同不重复入栈）。 */
function pushKitHistory(history, kit, limit) {
  const max = Number.isFinite(limit) ? limit : HISTORY_LIMIT
  const safe = normalizeKit(kit).kit
  const entry = {
    v: 1,
    primary: safe.primary,
    secondary: safe.secondary,
    displayFont: safe.displayFont,
    bodyFont: safe.bodyFont,
    tagline: safe.tagline,
    logoAssetId: safe.logoAssetId,
    preferredTheme: safe.preferredTheme,
    updatedAt: safe.updatedAt,
  }
  const list = Array.isArray(history) ? history.filter((item) => item && typeof item === 'object') : []
  const same = (item) =>
    item.primary === entry.primary &&
    item.secondary === entry.secondary &&
    item.tagline === entry.tagline &&
    item.displayFont === entry.displayFont &&
    item.bodyFont === entry.bodyFont
  const next = [entry, ...list.filter((item) => !same(item))]
  return next.slice(0, max)
}

function normalizeTracked(raw) {
  if (!Array.isArray(raw)) return []
  const list = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.blockId !== 'string') continue
    list.push({
      blockId: entry.blockId,
      slideId: typeof entry.slideId === 'string' ? entry.slideId : '',
      at: Number.isFinite(entry.at) ? entry.at : 0,
    })
  }
  return list.slice(-TRACK_LIMIT)
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/* =============================== 2. 宿主桥接 =============================== */

const state = {
  frames: [],
  kit: cloneKit(DEFAULT_KIT),
  status: 'loading',
  settings: {},
  tracked: [],
  deck: null,
  theme: null,
  vars: null,
  issues: [],
  error: '',
  notice: '',
  announce: '',
  busy: false,
}

const timers = { refresh: 0 }

function lang() {
  const locale = lumen.meta && lumen.meta.locale
  return locale === 'en' ? 'en' : 'zh'
}

function tr(key, vars) {
  return t(key, vars)
}

function themeName(id) {
  const names = THEME_NAMES[id]
  return names ? names[lang()] : id
}

function toast(kind, key, vars) {
  lumen.notify.toast({ kind, message: tr(key, vars) })
}

async function loadKit() {
  let raw
  try {
    raw = await lumen.storage.get(KIT_KEY)
  } catch (err) {
    lumen.log.warn('brandguard: read kit failed', err && err.code)
    raw = undefined
  }
  const normalized = normalizeKit(raw)
  state.kit = normalized.kit
  state.status = normalized.status
  if (normalized.status === 'corrupt') {
    try {
      await lumen.storage.set(KIT_KEY, cloneKit(DEFAULT_KIT))
    } catch {
      /* storage 不可用时保持内存默认值 */
    }
    toast('error', 'error.kitCorrupt')
  }
}

async function loadTracked() {
  try {
    state.tracked = normalizeTracked(await lumen.storage.get(LOGO_KEY))
  } catch {
    state.tracked = []
  }
}

async function loadSettings() {
  try {
    const values = await lumen.settings.get()
    state.settings = values && typeof values === 'object' ? values : {}
  } catch {
    state.settings = {}
  }
}

async function saveKit(kit) {
  const normalized = normalizeKit(kit).kit
  state.kit = normalized
  state.status = 'saving'
  paint()
  try {
    await lumen.storage.set(KIT_KEY, normalized)
    let history = []
    try {
      history = await lumen.storage.get(HISTORY_KEY)
    } catch {
      history = []
    }
    await lumen.storage.set(HISTORY_KEY, pushKitHistory(history, normalized))
    state.status = 'ready'
    toast('success', 'toast.kitSaved')
  } catch (err) {
    state.status = 'ready'
    state.error = 'error.timeout'
    lumen.log.warn('brandguard: save kit failed', err && err.code)
    paint()
    throw err
  }
  paint()
}

async function appendTracked(entries) {
  state.tracked = normalizeTracked([...state.tracked, ...entries])
  try {
    await lumen.storage.set(LOGO_KEY, state.tracked)
  } catch {
    /* 记录失败不影响 deck 已插入的事实 */
  }
}

function codeOf(err) {
  return err && typeof err.code === 'string' ? err.code : ''
}

function reportFailure(err, fallbackKey) {
  const code = codeOf(err)
  lumen.log.warn('brandguard: action failed', code || err)
  if (code === 'E-CAP-01' || code === 'E-CAP-02') toast('error', 'error.writeDenied')
  else if (code === 'E-QUOTA-01') toast('error', 'error.writeDenied')
  else toast('error', fallbackKey || 'error.timeout')
}

async function refresh() {
  if (!lumen.deck) return
  try {
    state.deck = await lumen.deck.getSnapshot()
  } catch (err) {
    lumen.log.warn('brandguard: snapshot failed', err && err.code)
    state.deck = null
  }
  try {
    state.theme = await lumen.theme.get()
    state.vars = await lumen.theme.cssVars()
  } catch {
    state.theme = null
    state.vars = null
  }
  state.issues = await collectIssues()
}

function coverSlideOf(snapshot) {
  const slides = snapshot && Array.isArray(snapshot.slides) ? snapshot.slides : []
  return slides.length > 0 ? slides[0] : null
}

/** 面板里能算的检查（规则本体在 lint ctx 里跑，见 §3）。 */
async function collectIssues() {
  const findings = []
  const snapshot = state.deck
  if (!snapshot) return findings
  const kit = state.kit
  if (state.status === 'empty') return findings

  // 1) 主题在岗
  if (!BRAND_THEME_IDS.includes(snapshot.themeId)) {
    findings.push({ code: 'palette-tolerance', severity: 'warn', message: tr('lint.paletteTolerance', { name: themeName(nearestTheme(kit.primary, kit.preferredTheme).id) }) })
  }

  // 2) 主题令牌偏离（降级实现：不含 SVG 硬编码色）
  if (state.theme && state.vars) {
    const drift = overridePaletteIssues(state.theme.colors, state.vars, kit, PALETTE_TOLERANCE)
    if (drift.length > 0) {
      const nearest = nearestBrandColor(drift[0].applied, kit)
      findings.push({
        code: 'palette-tolerance',
        severity: 'warn',
        message: tr('lint.paletteTolerance', { name: nearest.token === 'accent' ? kit.primary : kit.secondary }),
      })
    }
    if (!isFontAllowed(state.theme.font && state.theme.font.display)) {
      findings.push({ code: 'font-whitelist', severity: 'warn', message: tr('lint.fontWhitelist') })
    } else if (!isFontAllowed(state.theme.font && state.theme.font.body)) {
      findings.push({ code: 'font-whitelist', severity: 'warn', message: tr('lint.fontWhitelist') })
    }
  }

  // 3) tagline 启发式（首幕 textChars）
  const cover = coverSlideOf(snapshot)
  if (cover) {
    const coverage = taglineCoverage(cover.textChars, kit.tagline)
    if (!coverage.ok) {
      findings.push({
        code: 'tagline-missing',
        severity: 'warn',
        message: tr('lint.taglineMissing'),
        slideId: cover.id,
      })
    }
  }

  // 4) 已插入 logo 的跟踪记录（几何变化只能在 lint ctx 里核验）
  state.tracked.forEach((entry) => {
    findings.push({
      code: 'logo-placement',
      severity: 'info',
      message: `${tr('lint.logoPlacement')} · ${tr('issues.partial')}`,
      slideId: entry.slideId || undefined,
    })
  })
  return findings
}

/* =============================== 3. ABI 注册 =============================== */

const CMD_TITLES = {
  apply: { zh: '应用品牌主题', en: 'Apply brand theme' },
  fixPalette: { zh: '一键修复色板', en: 'Fix palette' },
  insertLogo: { zh: '插入品牌 logo', en: 'Insert brand logo' },
  openKit: { zh: '编辑品牌 kit', en: 'Edit brand kit' },
}

async function applyBrand() {
  if (state.status === 'empty') {
    toast('info', 'error.noKit')
    return
  }
  const resolved = nearestTheme(state.kit.primary, state.kit.preferredTheme)
  try {
    await lumen.deck.transaction('brandguard.apply', async () => {
      await lumen.deck.applyTheme(resolved.themeId)
    })
    state.notice = resolved.matched ? tr('toast.applied') : `${tr('toast.applied')} · ${tr('hint.nearest', { name: themeName(resolved.id) })}`
    toast('success', 'toast.applied')
    if (!resolved.matched) lumen.notify.toast({ kind: 'info', message: tr('hint.nearest', { name: themeName(resolved.id) }) })
    await refresh()
  } catch (err) {
    reportFailure(err, 'error.writeDenied')
  }
  paint()
}

async function fixPalette() {
  if (state.status === 'empty') {
    toast('info', 'error.noKit')
    return
  }
  // 降级实现：不能改块源码，只重新应用品牌主题（清掉主题/override 偏离）。
  const resolved = nearestTheme(state.kit.primary, state.kit.preferredTheme)
  try {
    await lumen.deck.transaction('brandguard.fixPalette', async () => {
      await lumen.deck.applyTheme(resolved.themeId)
    })
    toast('info', 'toast.fixed')
    await refresh()
  } catch (err) {
    reportFailure(err, 'error.writeDenied')
  }
  paint()
}

async function insertLogo() {
  const snapshot = state.deck || (await lumen.deck.getSnapshot())
  const slideId = snapshot && (snapshot.activeSlideId || (snapshot.slides[0] && snapshot.slides[0].id))
  if (!slideId) {
    toast('info', 'error.noDeck')
    return
  }
  const block = state.kit.logoAssetId
    ? {
        type: 'image',
        x: SAFE_RIGHT_X - LOGO_W,
        y: SAFE_BOTTOM_Y - LOGO_H,
        w: LOGO_W,
        h: LOGO_H,
        assetId: state.kit.logoAssetId,
        fit: 'contain',
        radius: 0,
        alt: tr('kit.logo'),
      }
    : {
        type: 'svg',
        x: SAFE_RIGHT_X - LOGO_W,
        y: SAFE_BOTTOM_Y - LOGO_H,
        w: LOGO_W,
        h: LOGO_H,
        viewBox: [0, 0, 320, 64],
        source: LOCKUP_SVG,
        animate: 'none',
      }
  try {
    const result = await lumen.deck.insertBlocks(slideId, [block])
    const blockId = result && Array.isArray(result.blockIds) ? result.blockIds[0] : ''
    if (blockId) await appendTracked([{ blockId, slideId, at: Date.now() }])
    toast('success', 'toast.logoInserted')
    await refresh()
  } catch (err) {
    reportFailure(err, 'error.writeDenied')
  }
  paint()
}

/** 空态一键创建：直接把默认品牌 kit 落盘（04 §3.5 空态引导；编辑仍走 openKit 对话框）。 */
async function createDefaultKit() {
  await saveKit(cloneKit(DEFAULT_KIT))
  await refresh()
  paint()
}

async function openKit() {
  try {
    await lumen.ui.openDialog({ id: 'kit-dialog', title: tr('dialog.title'), size: 'lg' })
  } catch (err) {
    lumen.log.warn('brandguard: open dialog failed', err && err.code)
  }
}

async function checkKitAndTrack() {
  await loadKit()
  await loadTracked()
  await loadSettings()
  await refresh()
}

/* ---- lint 规则（只报不改；code 由宿主补 `${pluginId}/` 前缀） ---- */

async function ruleLogoPlacement(ctx) {
  await ensureKit()
  const slides = ctx && Array.isArray(ctx.slides) ? ctx.slides : []
  return logoPlacementIssues(slides, logoBlockIds(state.tracked)).map((issue) => ({
    slideId: issue.slideId,
    blockId: issue.blockId,
    message: MSG.logoPlacement,
    params: { reason: issue.reason },
  }))
}

async function rulePaletteTolerance() {
  await ensureKit()
  if (state.status === 'empty') return []
  let theme
  let vars
  try {
    theme = await lumen.theme.get()
    vars = await lumen.theme.cssVars()
  } catch {
    return []
  }
  const drift = overridePaletteIssues(theme.colors, vars, state.kit, PALETTE_TOLERANCE)
  return drift.map((issue) => {
    const nearest = nearestBrandColor(issue.applied, state.kit)
    return {
      message: MSG.paletteTolerance,
      params: { name: nearest.token === 'accent' ? state.kit.primary : state.kit.secondary, distance: Math.round(issue.distance) },
    }
  })
}

async function ruleFontWhitelist() {
  await ensureKit()
  let theme
  try {
    theme = await lumen.theme.get()
  } catch {
    return []
  }
  const fonts = [theme.font && theme.font.display, theme.font && theme.font.body, theme.font && theme.font.mono]
  const bad = fonts.some((font) => !isFontAllowed(font))
  return bad ? [{ message: MSG.fontWhitelist }] : []
}

async function ruleTaglineMissing(ctx) {
  await ensureKit()
  if (!normalizeTagline(state.kit.tagline)) return []
  const slides = ctx && Array.isArray(ctx.slides) ? ctx.slides : []
  const cover = slides[0]
  if (!cover) return [{ message: MSG.taglineMissing }]
  const chars = Array.isArray(cover.blocks)
    ? cover.blocks.reduce((sum, block) => sum + (Number.isFinite(block.textChars) ? block.textChars : 0), 0)
    : 0
  const coverage = taglineCoverage(chars, state.kit.tagline)
  return coverage.ok ? [] : [{ slideId: cover.id, message: MSG.taglineMissing, params: { chars, expected: coverage.expected } }]
}

async function onPreflight(ctx) {
  await ensureKit()
  const results = []
  const snapshot = (ctx && ctx.deck) || state.deck
  const themeId = (ctx && ctx.themeId) || (snapshot && snapshot.themeId) || ''
  const slides = ctx && Array.isArray(ctx.slides) ? ctx.slides : []
  const strict = state.settings && state.settings.strict === true

  if (state.status === 'empty') {
    results.push({ level: 'info', message: MSG.preflightThemeOff, fix: FIX.apply })
    return results
  }
  if (!BRAND_THEME_IDS.includes(themeId)) results.push({ level: 'warn', message: MSG.preflightThemeOff, fix: FIX.apply })

  const logoIssues = logoPlacementIssues(slides, logoBlockIds(state.tracked))
  if (logoIssues.length > 0) {
    results.push({ level: 'warn', message: MSG.preflightLogo, slideId: logoIssues[0].slideId, fix: FIX.insertLogo })
  }

  const cover = slides[0]
  if (cover) {
    const chars = Array.isArray(cover.blocks)
      ? cover.blocks.reduce((sum, block) => sum + (Number.isFinite(block.textChars) ? block.textChars : 0), 0)
      : 0
    const coverage = taglineCoverage(chars, state.kit.tagline)
    if (!coverage.ok) results.push({ level: 'warn', message: MSG.preflightTagline, slideId: cover.id })
  }

  let theme = state.theme
  let vars = state.vars
  if (!theme || !vars) {
    try {
      theme = await lumen.theme.get()
      vars = await lumen.theme.cssVars()
    } catch {
      theme = null
      vars = null
    }
  }
  if (theme && vars) {
    const drift = overridePaletteIssues(theme.colors, vars, state.kit, PALETTE_TOLERANCE)
    if (drift.length > 0) {
      const nearest = nearestBrandColor(drift[0].applied, state.kit)
      results.push({
        level: 'warn',
        message: MSG.preflightPalette,
        params: { count: drift.length, name: nearest.token === 'accent' ? state.kit.primary : state.kit.secondary },
        fix: FIX.fixPalette,
      })
    }
    if (!isFontAllowed(theme.font && theme.font.display) || !isFontAllowed(theme.font && theme.font.body)) {
      results.push({ level: 'warn', message: MSG.preflightFont, fix: FIX.apply })
    }
  }

  if (results.length === 0) results.push({ level: 'info', message: MSG.preflightOk })
  if (strict) results.push({ level: 'info', message: MSG.preflightStrict })
  return results
}

async function ensureKit() {
  if (state.status === 'loading') {
    await loadKit()
  }
  return state.kit
}

/* ---- 顶层注册（ready 前完成，02 §6.9） ----
 * 纪律：注册调用全部**同步发出**（无顶层 await）——宿主 bootstrap 在 `DOMContentLoaded` 用
 * 「求值完成哨兵」判断启动失败，顶层 await 会让 DCL/load 与求值完成赛跑（02 §4.3 的 ready 口径）。
 * 注册请求本身是同步 postMessage（inject 客户端），FIFO 保证宿主先收到注册、后收到 `__ready`。
 */

function registerSafely(label, fn) {
  try {
    fn()
  } catch (err) {
    lumen.log.warn(`brandguard: register ${label} failed`, err && err.code ? err.code : err)
  }
}

function registerAll() {
  registerSafely('command.apply', () => lumen.commands.register({ id: 'apply', title: CMD_TITLES.apply, run: () => applyBrand() }))
  registerSafely('command.fixPalette', () =>
    lumen.commands.register({ id: 'fix-palette', title: CMD_TITLES.fixPalette, run: () => fixPalette() }),
  )
  registerSafely('command.insertLogo', () =>
    lumen.commands.register({ id: 'insert-logo', title: CMD_TITLES.insertLogo, run: () => insertLogo() }),
  )
  registerSafely('command.openKit', () => lumen.commands.register({ id: 'open-kit', title: CMD_TITLES.openKit, run: () => openKit() }))
  registerSafely('lint.logoPlacement', () =>
    lumen.lint.registerRule({
      id: 'logo-placement',
      title: { zh: 'logo 位置', en: 'Logo placement' },
      severity: 'warn',
      run: ruleLogoPlacement,
    }),
  )
  registerSafely('lint.paletteTolerance', () =>
    lumen.lint.registerRule({
      id: 'palette-tolerance',
      title: { zh: '色板容差', en: 'Palette tolerance' },
      severity: 'warn',
      run: rulePaletteTolerance,
    }),
  )
  registerSafely('lint.fontWhitelist', () =>
    lumen.lint.registerRule({
      id: 'font-whitelist',
      title: { zh: '字体白名单', en: 'Font whitelist' },
      severity: 'warn',
      run: ruleFontWhitelist,
    }),
  )
  registerSafely('lint.taglineMissing', () =>
    lumen.lint.registerRule({
      id: 'tagline-missing',
      title: { zh: 'tagline 缺失', en: 'Missing tagline' },
      severity: 'warn',
      run: ruleTaglineMissing,
    }),
  )
  registerSafely('export.preflight', () => lumen.export.onPreflight(onPreflight))
}

/** 帧内数据装载（可与 ready 并行；面板先渲染骨架，数据到位后重绘）。 */
let bootPromise = null
function bootData() {
  if (!bootPromise) {
    bootPromise = checkKitAndTrack().catch((err) => {
      lumen.log.warn('brandguard: boot failed', err && err.code)
    })
  }
  return bootPromise
}

/* =============================== 4. 渲染 =============================== */

const LOCKUP_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 64' fill='none'><rect x='4' y='8' width='48' height='48' rx='12' fill='var(--d-accent)'/><path d='M21 21h10.5c6 0 9.4 3.1 9.4 7.7 0 3.1-1.7 5.5-4.7 6.5 4 .9 6.4 3.8 6.4 7.6 0 5-3.8 8.2-10.2 8.2H21V21Z' fill='var(--d-bg)'/><text x='66' y='31' font-size='19' font-weight='600' fill='var(--d-fg)'>BRAND</text><text x='66' y='50' font-size='11' fill='var(--d-accent2)'>DESIGN SYSTEM</text></svg>"

const CSS = `
:where([data-brand-panel], [data-brand-dialog]) {
  font: 12.5px/1.55 var(--ui-font, system-ui), sans-serif;
  color: var(--ui-fg);
  background: transparent;
  padding: 12px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 100%;
}
:where([data-brand-panel]) .bg-head { display: flex; align-items: center; gap: 8px; }
:where([data-brand-panel]) .bg-title { font-size: 13px; font-weight: 600; letter-spacing: .01em; }
:where([data-brand-panel]) .bg-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ui-fg-mute); }
:where([data-brand-panel]) .bg-dot[data-state="ready"] { background: var(--ui-ok); }
:where([data-brand-panel]) .bg-dot[data-state="corrupt"] { background: var(--ui-danger); }
:where([data-brand-panel]) .bg-sub { color: var(--ui-fg-mute); font-size: 11px; margin-left: auto; }
:where([data-brand-panel]) .bg-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
:where([data-brand-panel]) .bg-swatches { display: flex; gap: 6px; }
:where([data-brand-panel]) .bg-swatch {
  width: 34px; height: 34px; border-radius: 8px;
  border: 1px solid var(--ui-line-strong);
  background-clip: padding-box;
  cursor: default;
}
:where([data-brand-panel]) .bg-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
:where([data-brand-panel]) .bg-issue {
  display: flex; gap: 8px; align-items: flex-start;
  padding: 7px 8px; border-radius: 8px;
  border: 1px solid var(--ui-line); background: var(--ui-panel-2);
  font-size: 12px;
}
:where([data-brand-panel]) .bg-issue[data-severity="warn"] { border-color: color-mix(in srgb, var(--ui-warn) 36%, var(--ui-line)); }
:where([data-brand-panel]) .bg-issue[data-severity="info"] { opacity: .82; }
:where([data-brand-panel]) .bg-issue-text { flex: 1; min-width: 0; }
:where([data-brand-panel]) .bg-empty {
  border: 1px dashed var(--ui-line-strong); border-radius: 10px;
  padding: 14px; text-align: center; color: var(--ui-fg-dim);
  display: flex; flex-direction: column; gap: 8px; align-items: center;
}
:where([data-brand-panel]) .bg-actions { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
:where([data-brand-panel]) .bg-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
:where([data-brand-dialog]) .bg-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
:where([data-brand-dialog]) .bg-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
:where([data-brand-dialog]) .bg-field--wide { grid-column: 1 / -1; }
:where([data-brand-dialog]) .bg-label { font-size: 11px; color: var(--ui-fg-dim); }
:where([data-brand-dialog]) .bg-hex { font-family: var(--ui-font-mono, ui-monospace); font-size: 11px; color: var(--ui-fg-mute); }
:where([data-brand-dialog]) .bg-logo-row { display: flex; gap: 10px; align-items: center; }
:where([data-brand-dialog]) .bg-logo-preview {
  width: 96px; height: 32px; border-radius: 6px; border: 1px solid var(--ui-line);
  background: var(--ui-panel-2); object-fit: contain;
}
:where([data-brand-dialog]) .bg-error {
  border: 1px solid color-mix(in srgb, var(--ui-danger) 40%, var(--ui-line));
  background: var(--ui-danger-soft); color: var(--ui-fg);
  border-radius: 8px; padding: 8px 10px; font-size: 12px;
  display: flex; gap: 8px; align-items: center;
}
:where([data-brand-dialog]) .bg-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: auto; }
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
  if (options.action) node.setAttribute('data-brand-action', options.action)
  if (options.data) {
    for (const [key, value] of Object.entries(options.data)) node.setAttribute(key, String(value))
  }
  if (typeof options.onClick === 'function') node.addEventListener('click', options.onClick)
  return node
}

function frameKind(ctx) {
  if (!ctx || typeof ctx !== 'object') return 'panel'
  const slot = ctx.slot || ctx.slotId || ctx.slotName
  if (slot === 'dialog') return 'dialog'
  if (ctx.kind === 'modal' || ctx.frameKind === 'modal') return 'dialog'
  if (ctx.contributionId === 'kit-dialog' || ctx.id === 'kit-dialog') return 'dialog'
  return 'panel'
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

function renderBrandPanel(root) {
  const fragment = document.createDocumentFragment()
  const stateName = state.status === 'loading' ? 'empty' : state.status === 'corrupt' ? 'corrupt' : state.status === 'saving' ? 'saving' : state.status === 'empty' ? 'empty' : 'ready'
  root.setAttribute('data-brand-panel', '')
  root.setAttribute('data-sdk', 'v1')
  root.setAttribute('data-brand-kit-state', stateName)
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', tr('a11y.panel'))

  // 头部
  const head = h('div', { class: 'bg-head' })
  head.append(h('span', { class: 'bg-dot', 'data-state': stateName }))
  head.append(h('span', { class: 'bg-title' }, tr('panel.title')))
  head.append(h('span', { class: 'bg-sub' }, tr(`panel.status.${stateName}`)))
  head.append(button(tr('panel.edit'), { variant: 'ghost', action: 'edit-kit', onClick: () => openKit() }))
  fragment.append(head)

  // 错误条
  if (state.error) {
    const bar = h('div', { class: 'bg-error', role: 'alert' })
    bar.append(h('span', { class: 'bg-issue-text' }, tr(state.error)))
    bar.append(button(tr('kit.reset'), { variant: 'ghost', action: 'reset-kit', onClick: () => resetKit() }))
    fragment.append(bar)
  }

  if (state.status === 'empty') {
    const empty = h('div', { class: 'bg-empty' })
    empty.append(h('span', null, tr('kit.empty')))
    empty.append(button(tr('kit.create'), { variant: 'primary', action: 'create-kit', onClick: () => void createDefaultKit() }))
    fragment.append(empty)
  } else {
    // 色板
    const swatches = h('div', { class: 'bg-swatches' })
    const pairs = [
      { name: tr('kit.primary'), value: state.kit.primary },
      { name: tr('kit.secondary'), value: state.kit.secondary },
      { name: tr('panel.title'), value: (state.theme && state.theme.colors && state.theme.colors.bg) || '#0B1220' },
    ]
    for (const pair of pairs) {
      const swatch = h('span', {
        class: 'bg-swatch',
        'data-brand-swatch': pair.value,
        title: `${pair.name} ${pair.value}`,
        'aria-label': tr('a11y.swatch', { name: pair.name, value: pair.value }),
        style: `background:${pair.value}`,
      })
      swatches.append(swatch)
    }
    fragment.append(swatches)

    // 规则列表
    fragment.append(h('div', { class: 'bg-title' }, tr('issues.title')))
    const list = h('ul', { class: 'bg-list', role: 'list' })
    if (state.issues.length === 0) {
      list.append(h('li', { class: 'bg-issue', 'data-severity': 'info' }, tr('issues.none')))
    } else {
      for (const issue of state.issues) {
        const item = h('li', { class: 'bg-issue', 'data-brand-issue': issue.code, 'data-severity': issue.severity })
        item.append(h('span', { class: 'bg-issue-text' }, issue.message))
        if (issue.slideId) {
          item.append(
            button(tr('issues.locate'), {
              variant: 'ghost',
              action: 'locate',
              onClick: () => {
                void lumen.commands.invoke('view.gotoSlide', { slideId: issue.slideId }).catch(() => undefined)
              },
            }),
          )
        }
        list.append(item)
      }
    }
    fragment.append(list)

    // 动作
    const actions = h('div', { class: 'bg-actions' })
    actions.append(
      button(tr('apply'), {
        variant: 'primary',
        action: 'apply',
        data: { 'data-brand-apply': '' },
        onClick: () => void applyBrand(),
      }),
    )
    const row = h('div', { class: 'bg-row' })
    row.append(button(tr('fixPalette'), { variant: 'ghost', action: 'fix-palette', onClick: () => void fixPalette() }))
    row.append(button(tr('insertLogo'), { variant: 'ghost', action: 'insert-logo', onClick: () => void insertLogo() }))
    actions.append(row)
    fragment.append(actions)

    if (state.notice) {
      const note = h('div', { class: 'bg-error', 'data-brand-notice': '', role: 'status' })
      note.append(h('span', { class: 'bg-issue-text' }, state.notice))
      fragment.append(note)
    }
  }

  const live = h('div', { class: 'bg-live', 'aria-live': 'polite' }, state.announce || '')
  fragment.append(live)
  clearNode(root)
  root.append(fragment)
}

let dialogDraft = null

function renderKitDialog(root) {
  root.setAttribute('data-brand-dialog', '')
  root.setAttribute('data-sdk', 'v1')
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', tr('dialog.title'))
  clearNode(root)
  if (!dialogDraft) dialogDraft = cloneKit(state.kit)

  const panel = h('div', { class: 'bg-dialog' })
  const fields = h('div', { class: 'bg-fields' })

  const colorField = (label, key) => {
    const field = h('label', { class: 'bg-field' })
    field.append(h('span', { class: 'bg-label' }, label))
    const input = h('input', {
      class: 'lumen-input',
      type: 'color',
      value: dialogDraft[key],
      'data-kit-field': key,
      'aria-label': label,
    })
    const hex = h('span', { class: 'bg-hex' }, dialogDraft[key])
    input.addEventListener('input', () => {
      dialogDraft[key] = String(input.value).toUpperCase()
      hex.textContent = dialogDraft[key]
    })
    field.append(input, hex)
    return field
  }

  fields.append(colorField(tr('kit.primary'), 'primary'))
  fields.append(colorField(tr('kit.secondary'), 'secondary'))

  const taglineField = h('label', { class: 'bg-field bg-field--wide' })
  taglineField.append(h('span', { class: 'bg-label' }, tr('kit.tagline')))
  const taglineInput = h('input', { class: 'lumen-input', type: 'text', value: dialogDraft.tagline, maxlength: String(TAGLINE_MAX), 'data-kit-field': 'tagline' })
  taglineInput.addEventListener('input', () => {
    dialogDraft.tagline = String(taglineInput.value).slice(0, TAGLINE_MAX)
  })
  taglineField.append(taglineInput)
  fields.append(taglineField)

  const fontField = (label, key) => {
    const field = h('label', { class: 'bg-field' })
    field.append(h('span', { class: 'bg-label' }, label))
    const select = h('select', { class: 'lumen-select', 'data-kit-field': key })
    for (const option of FONT_OPTIONS) {
      const item = h('option', { value: option.value }, option.family)
      if (dialogDraft[key] === option.value) item.selected = true
      select.append(item)
    }
    select.addEventListener('change', () => {
      dialogDraft[key] = String(select.value)
    })
    field.append(select)
    return field
  }
  fields.append(fontField(tr('kit.displayFont'), 'displayFont'))
  fields.append(fontField(tr('kit.bodyFont'), 'bodyFont'))

  const themeField = h('label', { class: 'bg-field' })
  themeField.append(h('span', { class: 'bg-label' }, tr('kit.preferredTheme')))
  const themeSelect = h('select', { class: 'lumen-select', 'data-kit-field': 'preferredTheme' })
  const autoOption = h('option', { value: 'auto' }, lang() === 'en' ? 'Auto by primary' : '按主色自动')
  if (dialogDraft.preferredTheme === 'auto') autoOption.selected = true
  themeSelect.append(autoOption)
  for (const preset of THEME_PRESETS) {
    const option = h('option', { value: preset.id }, themeName(preset.id))
    if (dialogDraft.preferredTheme === preset.id) option.selected = true
    themeSelect.append(option)
  }
  themeSelect.addEventListener('change', () => {
    dialogDraft.preferredTheme = String(themeSelect.value)
  })
  themeField.append(themeSelect)
  fields.append(themeField)

  const logoField = h('div', { class: 'bg-field bg-field--wide' })
  logoField.append(h('span', { class: 'bg-label' }, `${tr('kit.logo')} · ${tr('kit.uploadHint')}`))
  const logoRow = h('div', { class: 'bg-logo-row' })
  const fileInput = h('input', { class: 'lumen-input', type: 'file', accept: 'image/png', 'data-brand-upload': '' })
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0]
    if (file) void uploadLogo(file)
  })
  logoRow.append(fileInput)
  if (dialogDraft.logoAssetId) {
    const preview = h('img', { class: 'bg-logo-preview', alt: tr('kit.logo') })
    loomPreview(preview, dialogDraft.logoAssetId)
    logoRow.append(preview)
    logoRow.append(
      button(tr('kit.removeLogo'), {
        variant: 'ghost',
        action: 'remove-logo',
        onClick: () => {
          dialogDraft.logoAssetId = null
          renderAll()
        },
      }),
    )
  }
  logoField.append(logoRow)
  fields.append(logoField)

  panel.append(fields)
  const actions = h('div', { class: 'bg-actions' })
  actions.append(
    button(tr('kit.reset'), {
      variant: 'ghost',
      action: 'reset-kit',
      onClick: () => {
        dialogDraft = cloneKit(DEFAULT_KIT)
        renderAll()
      },
    }),
  )
  actions.append(
    button(tr('kit.cancel'), {
      variant: 'ghost',
      action: 'cancel-kit',
      onClick: () => {
        dialogDraft = null
        void lumen.ui.closePanel({ slot: 'dialog', id: 'kit-dialog' })
      },
    }),
  )
  actions.append(
    button(tr('kit.save'), {
      variant: 'primary',
      action: 'save-kit',
      onClick: () => {
        void saveFromDialog()
      },
    }),
  )
  panel.append(actions)
  root.append(panel)
}

function loomPreview(img, assetId) {
  lumen.assets
    .getUrl(assetId)
    .then((url) => {
      if (url) img.src = url
    })
    .catch(() => undefined)
}

async function uploadLogo(file) {
  if (!file) return
  if (file.size > 256 * 1024) {
    toast('error', 'error.logoTooLarge')
    return
  }
  if (!/^image\/png$/i.test(file.type)) {
    toast('error', 'error.logoType')
    return
  }
  const dataUrl = await readFileAsDataUrl(file)
  if (!dataUrl) {
    toast('error', 'error.logoType')
    return
  }
  try {
    const result = await lumen.assets.put({ name: file.name || 'brand-logo.png', mime: 'image/png', dataUrl })
    if (result && result.assetId) {
      dialogDraft.logoAssetId = result.assetId
      renderAll()
    }
  } catch (err) {
    reportFailure(err, 'error.logoTooLarge')
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

async function saveFromDialog() {
  if (!dialogDraft) return
  try {
    await saveKit(dialogDraft)
    dialogDraft = null
    await lumen.ui.closePanel({ slot: 'dialog', id: 'kit-dialog' })
  } catch {
    /* saveKit 已经 toast */
  }
}

async function resetKit() {
  try {
    await saveKit(cloneKit(DEFAULT_KIT))
    state.error = ''
    toast('info', 'toast.reset')
  } catch {
    /* saveKit 已经 toast */
  }
}

/* =============================== 5. 启动 =============================== */

function paint() {
  for (const frame of state.frames) {
    if (frame.kind === 'dialog') renderKitDialog(frame.root)
    else renderBrandPanel(frame.root)
  }
}

function renderAll() {
  paint()
}

function scheduleRefresh() {
  if (timers.refresh) clearTimeout(timers.refresh)
  timers.refresh = setTimeout(() => {
    timers.refresh = 0
    void refresh().finally(() => paint())
  }, 300)
}

lumen.ui.css(CSS)

lumen.ui.onRender((root, ctx) => {
  const kind = frameKind(ctx)
  lumen.ui.setTitle(kind === 'dialog' ? tr('dialog.title') : tr('panel.title'))
  clearNode(root)
  state.frames = state.frames.filter((frame) => frame.root !== root)
  state.frames.push({ root, kind })
  paint()
  if (!bootPromise) {
    lumen.ui.setBusy(true, tr('panel.status.loading'))
    void bootData().finally(() => {
      lumen.ui.setBusy(false)
      paint()
    })
  }
})

try {
  lumen.events.on('deck:change', scheduleRefresh)
  lumen.events.on('theme:change', scheduleRefresh)
  lumen.events.on('deck:open', () => {
    void refresh().finally(() => paint())
  })
} catch (err) {
  lumen.log.warn('brandguard: subscribe failed', err && err.code)
}

/* 同步段：注册必须在 ready 前完成；数据装载不阻塞求值（避免与 DOMContentLoaded 赛跑）。 */
registerAll()
void bootData()

/* 供单元测试直接 import 的纯函数面（运行时不使用）。 */
export {
  PLUGIN_ID,
  KIT_KEY,
  HISTORY_KEY,
  LOGO_KEY,
  DEFAULT_KIT,
  THEME_PRESETS,
  BRAND_THEME_IDS,
  FONT_WHITELIST,
  FONT_OPTIONS,
  FONT_SANS,
  PALETTE_TOLERANCE,
  SAFE_RIGHT_X,
  SAFE_BOTTOM_Y,
  LOGO_MIN_W,
  LOGO_MAX_W,
  LOGO_W,
  LOGO_H,
  TAGLINE_MAX,
  LOCKUP_SVG,
  MSG,
  parseHexColor,
  rgbDistance,
  paletteDistance,
  nearestTheme,
  kitToThemeId,
  normalizeKit,
  makeKit,
  isFontAllowed,
  nearestBrandColor,
  overridePaletteIssues,
  normalizeTagline,
  taglineCoverage,
  logoBlockIds,
  isLogoBlock,
  logoPlacementIssues,
  pushKitHistory,
  normalizeTracked,
  clampNumber,
}
