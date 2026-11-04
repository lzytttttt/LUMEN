/**
 * plugin.js —— FocusDesk / 专注台 · LUMEN ABI v1（示例插件，单文件 ESM）
 *
 * 能力：ui:slot · ui:command · ui:keymap · ui:layout · i18n:contribute · storage · deck:read
 * 预算：包 ≤ 60 KB（本文件 ≤ 45 KB），dock 首帧 ≤ 100 ms；唯一常驻定时器 = Zen HUD 1 Hz。
 *
 * 只读承诺（05 §5.3）：manifest 不申请任何写能力（改演示 / 主题 / 素材 / 导出钩子）；
 * 本文件不调用 deck 写方法，deck 序列化前后零 diff（U-40-229 的静态依据）。
 * 改变界面的唯一通路是 `lumen.layout.apply`（shell 状态，不进 deck）。
 *
 * 口径说明：
 *   - 字数 / 阅读秒数**完全取宿主快照** `snapshot.slides[].textChars / readingSeconds`（§1.6-B），
 *     插件不复制宿主的中英阅读速度常量；
 *   - 每幕 lint 计数不在 DeckSnapshot 里（只有 deck 级 `snapshot.lint` 三色计数），
 *     所以看板的行级徽标降级为「—」，头部徽标显示 deck 级计数（缺失同样显示「—」）。
 */

const PLUGIN_ID = 'com.lumen.samples.focusdesk'
const lumen = globalThis.lumen
if (!lumen) throw new Error('LUMEN ABI v1 is required')

const el = lumen.ui.el
const t = (key, vars) => lumen.i18n.t(key, vars)

/* =============================== 1. 纯逻辑 =============================== */

/** 3 个布局预设的 apply 字段（与 manifest `contributes.layoutPresets` 同值，05 §5.4）。 */
const PRESETS = [
  {
    id: 'focus',
    name: { zh: '专注', en: 'Focus' },
    apply: { hideRail: true, hideInspector: true, showGrid: false, density: 'compact' },
  },
  {
    id: 'review',
    name: { zh: '检查', en: 'Review' },
    apply: {
      railWidth: 216,
      panelWidth: 380,
      rightMode: 'inspector',
      inspectorTab: 'lint',
      dockHeight: 240,
      showGrid: false,
    },
  },
  {
    id: 'default',
    name: { zh: '默认', en: 'Default' },
    apply: {
      railWidth: 216,
      panelWidth: 340,
      leftTab: 'slides',
      inspectorTab: 'props',
      dockHeight: 240,
      hideRail: false,
      hideInspector: false,
      showGrid: false,
    },
  },
]

const PRESET_IDS = PRESETS.map((preset) => preset.id)
const LAYOUT_LABEL_KEYS = { focus: 'layout.focus', review: 'layout.review', default: 'layout.default' }

const PREFS_KEY = 'ui.prefs'
const SESSION_LIMIT = 20
const TITLE_WIDTH = 18
const ZEN_TICK_MS = 1000

const CMD_TITLES = {
  'layout-focus': { zh: '专注布局', en: 'Focus layout' },
  'layout-review': { zh: '检查布局', en: 'Review layout' },
  'layout-default': { zh: '默认布局', en: 'Default layout' },
  'zen-toggle': { zh: '开关 Zen', en: 'Toggle Zen' },
  'dock-toggle': { zh: '开关写作看板', en: 'Toggle writing board' },
}

const DEFAULT_PREFS = { v: 1, lastLayout: 'default', dockHeight: 240, zenOnBoot: false }

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function presetById(id) {
  return PRESETS.find((preset) => preset.id === id) ?? null
}

function presetApply(id) {
  const preset = presetById(id)
  return preset ? { ...preset.apply } : null
}

function presetLabel(id, lang) {
  const preset = presetById(id)
  if (!preset) return String(id ?? '')
  return lang === 'en' ? preset.name.en : preset.name.zh
}

/** 布局预设是否合法（只允许 3 个自属预设，避免拿 slug 之外的 id 调 apply）。 */
function normalizePresetId(id) {
  return PRESET_IDS.includes(id) ? id : 'default'
}

/** LRM 幕标题截断（按码点计数，避免切坏 emoji/CJK）。 */
function truncateTitle(value, max) {
  const limit = Number.isFinite(max) ? max : TITLE_WIDTH
  const chars = Array.from(String(value ?? '').trim())
  if (chars.length <= limit) return chars.join('')
  return `${chars.slice(0, limit).join('')}…`
}

function slideTitleOf(slide, index) {
  const name = slide && typeof slide.name === 'string' ? slide.name.trim() : ''
  if (name !== '') return name
  return `《${index + 1}》`
}

/** 秒 → 'MM:SS'（时钟口径，U-40-226 的展示层）。 */
function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

function formatSeconds(seconds) {
  return Math.max(0, Math.round(Number(seconds) || 0))
}

function totalOf(slides, field) {
  if (!Array.isArray(slides)) return 0
  return slides.reduce((sum, slide) => sum + (Number.isFinite(slide && slide[field]) ? slide[field] : 0), 0)
}

/** deck 级 lint 三色计数；结构缺失/非法 → null（UI 显示「—」，U-40-227）。 */
function lintCounts(snapshot) {
  const lint = snapshot && snapshot.lint
  if (!isPlainObject(lint)) return null
  const counts = { error: Number(lint.error), warn: Number(lint.warn), info: Number(lint.info) }
  if (!Number.isFinite(counts.error) || !Number.isFinite(counts.warn) || !Number.isFinite(counts.info)) return null
  return { error: Math.max(0, counts.error), warn: Math.max(0, counts.warn), info: Math.max(0, counts.info) }
}

/**
 * 看板行模型：字数 / 秒数**原样取自快照**（不重算、不四舍五入，U-40-226 误差 0）。
 * 快照缺失 → 空行集（不抛错）。
 */
function buildBoardRows(snapshot) {
  const slides = snapshot && Array.isArray(snapshot.slides) ? snapshot.slides : []
  const activeSlideId = (snapshot && snapshot.activeSlideId) || null
  const rows = slides.map((slide, index) => {
    const name = slideTitleOf(slide, index)
    return {
      index,
      slideId: slide && typeof slide.id === 'string' ? slide.id : `#${index + 1}`,
      title: truncateTitle(name),
      fullTitle: name,
      textChars: Number.isFinite(slide && slide.textChars) ? slide.textChars : 0,
      readingSeconds: Number.isFinite(slide && slide.readingSeconds) ? slide.readingSeconds : 0,
      active: !!slide && slide.id === activeSlideId,
    }
  })
  return {
    rows,
    totals: {
      slides: rows.length,
      chars: totalOf(slides, 'textChars'),
      seconds: totalOf(slides, 'readingSeconds'),
    },
    lint: lintCounts(snapshot),
  }
}

function lintBadge(snapshot) {
  const counts = lintCounts(snapshot)
  if (!counts) return { available: false, text: '—', counts: null }
  return { available: true, text: `${counts.warn}/${counts.error}`, counts }
}

/** 当前幕在快照里的序号（-1 = 不在快照里）。 */
function activeSlideIndex(snapshot) {
  const slides = snapshot && Array.isArray(snapshot.slides) ? snapshot.slides : []
  const activeId = snapshot && snapshot.activeSlideId
  return slides.findIndex((slide) => slide && slide.id === activeId)
}

/** Zen 进度：{index,total}，index 从 1 起；无快照 → 0/0。 */
function zenProgress(snapshot) {
  const rows = buildBoardRows(snapshot)
  const index = activeSlideIndex(snapshot)
  return { index: index >= 0 ? index + 1 : 0, total: rows.rows.length }
}

/** 标准化 ui.prefs（损坏 → 默认值，不抛错；05 §5.8 第 5 条）。 */
function normalizePrefs(raw) {
  if (!isPlainObject(raw) || raw.v !== 1) return { ...DEFAULT_PREFS }
  return {
    v: 1,
    lastLayout: normalizePresetId(raw.lastLayout),
    dockHeight: Number.isFinite(raw.dockHeight) ? Math.min(400, Math.max(240, raw.dockHeight)) : DEFAULT_PREFS.dockHeight,
    zenOnBoot: raw.zenOnBoot === true,
  }
}

/** 排练记录环形（最近 20 条），最新在前。 */
function appendSession(list, record, limit) {
  const max = Number.isFinite(limit) ? limit : SESSION_LIMIT
  const history = Array.isArray(list) ? list.filter((item) => isPlainObject(item)) : []
  const entry = {
    at: Number.isFinite(record && record.at) ? record.at : Date.now(),
    usedSeconds: Math.max(0, Math.round(Number(record && record.usedSeconds) || 0)),
    totalSlides: Math.max(0, Math.round(Number(record && record.totalSlides) || 0)),
  }
  return [entry, ...history].slice(0, max)
}

/** 「已修改」判定：当前布局 id 与最近应用 id 不同即视为手动改过（无 ABI 读更多时唯一信号）。 */
function layoutModified(currentId, appliedId) {
  const current = normalizePresetId(currentId)
  const applied = normalizePresetId(appliedId)
  return current !== applied
}

function dayKey(timestamp) {
  const date = new Date(Number(timestamp) || Date.now())
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/* =============================== 2. 宿主桥接 =============================== */

const state = {
  frames: [],
  snapshot: null,
  prefs: { ...DEFAULT_PREFS },
  currentLayout: 'default',
  appliedLayout: 'default',
  zenOn: false,
  zenStartedAt: 0,
  zenElapsed: 0,
  mode: 'edit',
  dockOpen: false,
  announceAt: 0,
  ready: false,
  goal: null,
}

let zenTimer = 0
let refreshTimer = 0

function lang() {
  return lumen.meta && lumen.meta.locale === 'en' ? 'en' : 'zh'
}

function toast(kind, key, vars) {
  lumen.notify.toast({ kind, message: t(key, vars) })
}

function codeOf(err) {
  return err && typeof err.code === 'string' ? err.code : ''
}

async function loadPrefs() {
  try {
    state.prefs = normalizePrefs(await lumen.storage.get(PREFS_KEY))
  } catch {
    state.prefs = { ...DEFAULT_PREFS }
  }
  state.appliedLayout = state.prefs.lastLayout
  state.zenOn = state.prefs.zenOnBoot === true
  // 跨帧同步：dock 帧与 Zen overlay 帧各自是独立 JS 实例，zen 开关以宿主 settings 为真源。
  try {
    const values = await lumen.settings.get()
    if (values && typeof values.zenOn === 'boolean') state.zenOn = values.zenOn
  } catch {
    /* settings 不可用时退回本地 prefs */
  }
}

async function savePrefs() {
  state.prefs = { ...state.prefs, lastLayout: state.appliedLayout, zenOnBoot: state.zenOn }
  try {
    await lumen.storage.set(PREFS_KEY, state.prefs)
  } catch (err) {
    lumen.log.warn('focusdesk: save prefs failed', codeOf(err))
  }
}

async function loadGoal() {
  const deckId = state.snapshot && state.snapshot.deckId
  if (!deckId) return
  try {
    const raw = await lumen.storage.get(`goal.${deckId}`)
    state.goal = isPlainObject(raw) ? raw : null
  } catch {
    state.goal = null
  }
}

async function saveSession() {
  const deckId = state.snapshot && state.snapshot.deckId
  if (!deckId || state.zenElapsed <= 0) return
  try {
    const key = `sessions.${deckId}`
    const history = await lumen.storage.get(key)
    const next = appendSession(history, {
      at: Date.now(),
      usedSeconds: state.zenElapsed,
      totalSlides: state.snapshot.slides ? state.snapshot.slides.length : 0,
    })
    await lumen.storage.set(key, next)
  } catch (err) {
    lumen.log.warn('focusdesk: save session failed', codeOf(err))
  }
}

async function refresh() {
  try {
    state.snapshot = await lumen.deck.getSnapshot()
  } catch (err) {
    lumen.log.warn('focusdesk: snapshot failed', codeOf(err))
    state.snapshot = null
  }
  try {
    const current = await lumen.layout.current()
    state.currentLayout = normalizePresetId(current)
  } catch {
    state.currentLayout = state.appliedLayout
  }
  await loadGoal()
  state.ready = true
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = 0
    void refresh().then(() => paint())
  }, 250)
}

/* ---- 命令动作 ---- */

async function applyLayout(id) {
  const presetId = normalizePresetId(id)
  if (state.mode === 'play') {
    toast('info', 'error.layout')
    return
  }
  try {
    await lumen.layout.apply(presetId)
    state.appliedLayout = presetId
    state.currentLayout = presetId
    await savePrefs()
    toast('success', 'layout.applied', { name: presetLabel(presetId, lang()) })
  } catch (err) {
    lumen.log.warn('focusdesk: apply layout failed', codeOf(err))
    toast('error', 'error.layout')
  }
  await refresh()
  paint()
}

function startZenTimer() {
  if (zenTimer) return
  zenTimer = setInterval(() => {
    if (!state.zenOn) return
    state.zenElapsed += 1
    updateZenTimerText()
  }, ZEN_TICK_MS)
}

function stopZenTimer() {
  if (!zenTimer) return
  clearInterval(zenTimer)
  zenTimer = 0
}

async function toggleZen() {
  if (state.mode === 'play') {
    toast('info', 'error.layout')
    return
  }
  state.zenOn = !state.zenOn
  if (state.zenOn) {
    state.zenStartedAt = Date.now()
    state.zenElapsed = 0
    state.announceAt = 0
    startZenTimer()
  } else {
    stopZenTimer()
    await saveSession()
  }
  // 跨帧同步：写宿主 settings（同一插件的其它帧会收到 subscribe 回调）。
  try {
    await lumen.settings.patch({ zenOn: state.zenOn })
  } catch (err) {
    lumen.log.warn('focusdesk: sync zen failed', codeOf(err))
  }
  await savePrefs()
  await refresh()
  paint()
}

async function toggleDock() {
  try {
    if (state.dockOpen) {
      lumen.ui.closePanel({ slot: 'workspace.dock', id: 'board' })
      state.dockOpen = false
    } else {
      await lumen.ui.openPanel({ slot: 'workspace.dock', id: 'board' })
      state.dockOpen = true
    }
  } catch (err) {
    lumen.log.warn('focusdesk: toggle dock failed', codeOf(err))
  }
}

async function gotoSlide(payload) {
  try {
    await lumen.commands.invoke('view.gotoSlide', payload)
  } catch (err) {
    lumen.log.warn('focusdesk: goto failed', codeOf(err))
    toast('info', 'error.goto')
  }
}

async function gotoRelative(delta) {
  const progress = zenProgress(state.snapshot)
  if (progress.total === 0) return
  const next = Math.min(progress.total, Math.max(1, progress.index + delta))
  await gotoSlide({ index: next - 1 })
}

/* =============================== 3. ABI 注册 =============================== */

/* ---- 顶层注册（ready 前完成，02 §6.9） ----
 * 全部**同步发出**（无顶层 await）：宿主 bootstrap 在 DOMContentLoaded 用求值哨兵判断启动失败，
 * 顶层 await 会与 DCL/load 赛跑（02 §4.3）；注册请求是同步 postMessage，FIFO 保证先注册后 ready。
 */
function registerSafely(label, fn) {
  try {
    fn()
  } catch (err) {
    lumen.log.warn(`focusdesk: register ${label} failed`, err && err.code ? err.code : err)
  }
}

function registerAll() {
  for (const preset of PRESETS) {
    registerSafely(`command.layout-${preset.id}`, () =>
      lumen.commands.register({
        id: `layout-${preset.id}`,
        title: CMD_TITLES[`layout-${preset.id}`],
        run: () => applyLayout(preset.id),
      }),
    )
  }
  registerSafely('command.zen', () => lumen.commands.register({ id: 'zen-toggle', title: CMD_TITLES['zen-toggle'], run: () => toggleZen() }))
  registerSafely('command.dock', () =>
    lumen.commands.register({ id: 'dock-toggle', title: CMD_TITLES['dock-toggle'], run: () => toggleDock() }),
  )
}

/** 帧内数据装载（与 ready 并行；看板先渲染空态，数据到位后 paint）。 */
let bootPromise = null
function bootData() {
  if (!bootPromise) {
    bootPromise = (async () => {
      await loadPrefs()
      await refresh()
      paint()
    })().catch((err) => {
      lumen.log.warn('focusdesk: boot failed', err && err.code)
    })
  }
  return bootPromise
}

/* =============================== 4. 渲染 =============================== */

const CSS = `
:where([data-focusdesk]) {
  font: 12.5px/1.5 var(--ui-font, system-ui), sans-serif;
  color: var(--ui-fg);
  box-sizing: border-box;
}
:where([data-focusdesk-dock]) {
  padding: 8px 12px; height: 100%; overflow: auto;
  display: flex; flex-direction: column; gap: 6px;
}
:where([data-focusdesk-dock]) .fd-head {
  display: flex; align-items: center; gap: 10px; font-size: 11.5px; color: var(--ui-fg-dim);
}
:where([data-focusdesk-dock]) .fd-title { font-size: 12.5px; font-weight: 600; color: var(--ui-fg); }
:where([data-focusdesk-dock]) .fd-spacer { flex: 1; }
:where([data-focusdesk-dock]) .fd-badge {
  border: 1px solid var(--ui-line); border-radius: 999px; padding: 1px 8px; font-size: 11px;
}
:where([data-focusdesk-dock]) .fd-badge[data-level="warn"] { border-color: color-mix(in srgb, var(--ui-warn) 46%, var(--ui-line)); color: var(--ui-warn); }
:where([data-focusdesk-dock]) .fd-tools { display: flex; gap: 4px; flex-wrap: wrap; }
:where([data-focusdesk-dock]) .fd-tool {
  border: 1px solid var(--ui-line); background: transparent; color: var(--ui-fg-dim);
  border-radius: 999px; padding: 2px 10px; font: inherit; font-size: 11px; cursor: pointer;
}
:where([data-focusdesk-dock]) .fd-tool:hover { color: var(--ui-fg); background: var(--ui-hover); }
:where([data-focusdesk-dock]) .fd-tool[aria-pressed="true"] {
  color: var(--ui-fg); border-color: var(--ui-accent-line); background: var(--ui-accent-soft);
}
:where([data-focusdesk-dock]) .fd-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
:where([data-focusdesk-dock]) .fd-row {
  width: 100%; display: grid; grid-template-columns: 34px 1fr 72px 60px 46px;
  gap: 8px; align-items: center; text-align: left;
  border: 1px solid transparent; border-radius: 7px; background: transparent;
  color: var(--ui-fg-dim); font: inherit; padding: 3px 6px; cursor: pointer;
}
:where([data-focusdesk-dock]) .fd-row:hover { background: var(--ui-hover); color: var(--ui-fg); }
:where([data-focusdesk-dock]) .fd-row[aria-current="true"] {
  border-color: var(--ui-accent-line); background: var(--ui-accent-soft); color: var(--ui-fg);
}
:where([data-focusdesk-dock]) .fd-index { font-family: var(--ui-font-mono, ui-monospace); font-size: 11px; color: var(--ui-fg-mute); }
:where([data-focusdesk-dock]) .fd-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:where([data-focusdesk-dock]) .fd-num { text-align: right; font-variant-numeric: tabular-nums; }
:where([data-focusdesk-dock]) .fd-empty { color: var(--ui-fg-dim); padding: 14px; text-align: center; }
:where([data-focusdesk-dock]) .fd-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
:where([data-focusdesk-zen]) { display: flex; justify-content: flex-end; padding: 8px; }
:where([data-focusdesk-zen]) .fd-zen {
  width: 268px; border-radius: 12px; border: 1px solid var(--ui-line-strong);
  background: color-mix(in srgb, var(--ui-panel) 88%, transparent);
  box-shadow: var(--ui-shadow-sm); padding: 10px 12px;
  display: flex; flex-direction: column; gap: 6px; pointer-events: auto;
}
:where([data-focusdesk-zen]) .fd-zen-top { display: flex; align-items: baseline; gap: 8px; }
:where([data-focusdesk-zen]) .fd-zen-timer { font-family: var(--ui-font-mono, ui-monospace); font-size: 22px; color: var(--ui-fg); }
:where([data-focusdesk-zen]) .fd-zen-progress { margin-left: auto; font-size: 11.5px; color: var(--ui-fg-dim); }
:where([data-focusdesk-zen]) .fd-zen-meta { font-size: 11.5px; color: var(--ui-fg-mute); display: flex; gap: 10px; }
:where([data-focusdesk-zen]) .fd-zen-actions { display: flex; gap: 6px; }
[data-reduced-motion="true"] :where([data-focusdesk]) * { transition: none !important; animation: none !important; }
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
  if (options.action) node.setAttribute('data-focusdesk-action', options.action)
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
  if (!ctx || typeof ctx !== 'object') return 'dock'
  const slot = ctx.slot || ctx.slotId || ctx.slotName
  if (slot === 'workspace.overlay') return 'zen'
  if (slot === 'workspace.dock') return 'dock'
  const contribution = ctx.contributionId || ctx.id
  if (contribution === 'zen') return 'zen'
  return 'dock'
}

function renderDock(root) {
  root.setAttribute('data-focusdesk', '')
  root.setAttribute('data-focusdesk-dock', '')
  root.setAttribute('data-sdk', 'v1')
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', t('a11y.dock'))
  root.setAttribute('data-focusdesk-layout', state.currentLayout)
  clearNode(root)

  const board = buildBoardRows(state.snapshot)
  const badge = lintBadge(state.snapshot)
  const head = h('div', { class: 'fd-head' })
  head.append(h('span', { class: 'fd-title' }, t('dock.title')))
  head.append(
    h('span', { class: 'fd-badge', 'data-focusdesk-lint': badge.available ? 'on' : 'off', 'data-level': badge.counts && badge.counts.warn > 0 ? 'warn' : 'info' }, badge.text),
  )
  head.append(h('span', { class: 'fd-spacer' }))
  const minutes = Math.max(0, Math.round(board.totals.seconds / 60))
  head.append(h('span', null, t('dock.total', { slides: board.totals.slides, chars: board.totals.chars, minutes })))
  root.append(head)

  if (board.rows.length === 0) {
    root.append(h('div', { class: 'fd-empty' }, t('dock.empty')))
  }

  // 布局与 Zen 的入口：与命令/键位等价的面板内按钮（键盘路径之外的可点路径）。
  const tools = h('div', { class: 'fd-tools', role: 'group', 'aria-label': t('dock.title') })
  for (const preset of PRESETS) {
    const tool = h('button', {
      type: 'button',
      class: 'fd-tool',
      'data-focusdesk-preset': preset.id,
      'aria-pressed': state.currentLayout === preset.id ? 'true' : 'false',
    }, presetLabel(preset.id, lang()))
    tool.addEventListener('click', () => void applyLayout(preset.id))
    tools.append(tool)
  }
  const zenTool = h('button', {
    type: 'button',
    class: 'fd-tool',
    'data-focusdesk-zen-toggle': state.zenOn ? 'on' : 'off',
  }, state.zenOn ? t('zen.exit') : t('zen.enter'))
  zenTool.addEventListener('click', () => void toggleZen())
  tools.append(zenTool)
  root.append(tools)

  if (board.rows.length === 0) return

  const list = h('ul', { class: 'fd-list', role: 'list' })
  for (const row of board.rows) {
    const item = h('li', null)
    const rowButton = h('button', {
      type: 'button',
      class: 'fd-row',
      'data-focusdesk-row': '',
      'data-slide-id': row.slideId,
      'aria-current': row.active ? 'true' : 'false',
      'aria-label': t('a11y.row', { n: row.index + 1, chars: row.textChars, seconds: formatSeconds(row.readingSeconds) }),
    })
    rowButton.append(h('span', { class: 'fd-index' }, String(row.index + 1).padStart(2, '0')))
    rowButton.append(h('span', { class: 'fd-name' }, row.title))
    rowButton.append(h('span', { class: 'fd-num' }, t('dock.words', { count: row.textChars })))
    rowButton.append(h('span', { class: 'fd-num' }, t('dock.readTime', { seconds: formatSeconds(row.readingSeconds) })))
    rowButton.append(h('span', { class: 'fd-num', 'data-focusdesk-lint': '' }, t('dock.lintNone')))
    rowButton.addEventListener('click', () => {
      void gotoSlide({ slideId: row.slideId })
    })
    item.append(rowButton)
    list.append(item)
  }
  root.append(list)

  const live = h('div', { class: 'fd-live', 'aria-live': 'polite' })
  live.textContent = t('dock.total', { slides: board.totals.slides, chars: board.totals.chars, minutes })
  root.append(live)
}

function updateZenTimerText() {
  for (const frame of state.frames) {
    if (frame.kind !== 'zen') continue
    const node = frame.root.querySelector('[data-focusdesk-timer]')
    if (node) node.textContent = formatClock(state.zenElapsed)
    const live = frame.root.querySelector('[data-focusdesk-zen-live]')
    if (live && state.zenElapsed > 0 && state.zenElapsed % 60 === 0 && state.zenElapsed !== state.announceAt) {
      state.announceAt = state.zenElapsed
      live.textContent = t('zen.minute', { minutes: Math.floor(state.zenElapsed / 60) })
    }
  }
}

function renderZen(root) {
  root.setAttribute('data-focusdesk', '')
  root.setAttribute('data-focusdesk-zen', state.zenOn ? '1' : '0')
  root.setAttribute('data-sdk', 'v1')
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', t('a11y.zen'))
  root.setAttribute('data-focusdesk-layout', state.currentLayout)
  clearNode(root)
  if (!state.zenOn) return

  const progress = zenProgress(state.snapshot)
  const board = buildBoardRows(state.snapshot)
  const card = h('div', { class: 'fd-zen' })
  const top = h('div', { class: 'fd-zen-top' })
  top.append(h('span', { class: 'fd-zen-timer', 'data-focusdesk-timer': '' }, formatClock(state.zenElapsed)))
  top.append(h('span', { class: 'fd-zen-progress', 'data-focusdesk-progress': '' }, t('zen.progress', { index: progress.index, total: progress.total })))
  card.append(top)

  const current = progress.index > 0 ? board.rows[progress.index - 1] : null
  const meta = h('div', { class: 'fd-zen-meta' })
  if (current) {
    meta.append(h('span', null, t('dock.words', { count: current.textChars })))
    meta.append(h('span', null, t('zen.planned', { seconds: formatSeconds(current.readingSeconds) })))
  }
  card.append(meta)

  const actions = h('div', { class: 'fd-zen-actions' })
  const prev = button(t('zen.prev'), { variant: 'ghost', action: 'zen-prev', data: { 'data-focusdesk-prev': '' } })
  prev.addEventListener('click', () => void gotoRelative(-1))
  const next = button(t('zen.next'), { variant: 'ghost', action: 'zen-next', data: { 'data-focusdesk-next': '' } })
  next.addEventListener('click', () => void gotoRelative(1))
  const exit = button(t('zen.exit'), { variant: 'primary', action: 'zen-exit', data: { 'data-focusdesk-exit': '' } })
  exit.addEventListener('click', () => void toggleZen())
  actions.append(prev, next, exit)
  card.append(actions)

  const live = h('div', { class: 'fd-live', 'data-focusdesk-zen-live': '', 'aria-live': 'polite' })
  card.append(live)
  root.append(card)
}

function paint() {
  for (const frame of state.frames) {
    if (frame.kind === 'zen') renderZen(frame.root)
    else renderDock(frame.root)
  }
}

/* =============================== 5. 启动 =============================== */

lumen.ui.css(CSS)

lumen.ui.onRender((root, ctx) => {
  const kind = frameKind(ctx)
  lumen.ui.setTitle(kind === 'zen' ? 'Zen HUD' : t('dock.title'))
  clearNode(root)
  state.frames = state.frames.filter((frame) => frame.root !== root)
  state.frames.push({ root, kind })
  if (kind === 'zen') renderZen(root)
  else renderDock(root)
  void bootData()
})

try {
  lumen.events.on('deck:change', scheduleRefresh)
  lumen.events.on('slide:change', scheduleRefresh)
  lumen.events.on('deck:open', () => {
    void loadPrefs().then(() => refresh().then(() => paint()))
  })
  // 跨帧 zen 同步：dock 帧 toggle 后，Zen overlay 帧经宿主 settings 订阅立刻渲染。
  lumen.settings.subscribe((values) => {
    const next = values && typeof values.zenOn === 'boolean' ? values.zenOn : state.zenOn
    if (next === state.zenOn) return
    state.zenOn = next
    if (next) {
      state.zenStartedAt = Date.now()
      state.zenElapsed = 0
      state.announceAt = 0
      startZenTimer()
    } else {
      stopZenTimer()
      void saveSession()
    }
    paint()
  })
  lumen.events.on('mode:change', (payload) => {
    const mode = payload && typeof payload === 'object' && typeof payload.mode === 'string' ? payload.mode : 'edit'
    state.mode = mode
    if (mode === 'play' && state.zenOn) {
      state.zenOn = false
      stopZenTimer()
      void saveSession()
    }
    paint()
  })
} catch (err) {
  lumen.log.warn('focusdesk: subscribe failed', err && err.code)
}

/* 同步段：注册必须在 ready 前完成；数据装载不阻塞求值（避免与 DOMContentLoaded 赛跑）。 */
registerAll()
void bootData()

/* 供单元测试直接 import 的纯函数面（运行时不使用）。 */
export {
  PLUGIN_ID,
  PRESETS,
  PRESET_IDS,
  LAYOUT_LABEL_KEYS,
  PREFS_KEY,
  SESSION_LIMIT,
  TITLE_WIDTH,
  DEFAULT_PREFS,
  CMD_TITLES,
  presetById,
  presetApply,
  presetLabel,
  normalizePresetId,
  truncateTitle,
  slideTitleOf,
  formatClock,
  formatSeconds,
  totalOf,
  lintCounts,
  lintBadge,
  buildBoardRows,
  activeSlideIndex,
  zenProgress,
  normalizePrefs,
  appendSession,
  layoutModified,
  dayKey,
}
