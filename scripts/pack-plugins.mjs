#!/usr/bin/env node
/**
 * scripts/pack-plugins.mjs —— 把 `plugins/builtin/<name>/` 打成 `.lumenplug`（UTF-8 JSON 信封）。
 *
 * 契约：plan/v0.4.0/02 §2.1/§2.2/§2.4（信封字段、files 体积/路径、canonical JSON + sha256）
 *       05 §2/§7（三款样例的预算、manifest 提升、locales 内联进 contributes.i18n）
 *
 * 口径（与宿主 `src/plugins/package.ts` 一致，安装时会重算 integrity）：
 *   payload    = { format, formatVersion, createdAt, manifest, files }
 *   integrity  = 'sha256:' + lowercaseHex(sha256(utf8(canonicalJson(payload))))
 *   canonical  = 对象键按 UTF-16 code unit 升序递归、无空白、非 ASCII 原样、数字只允许安全整数、-0→0
 *
 * 用法：
 *   node scripts/pack-plugins.mjs            # 生成 public/plugins/samples 与 tests/fixtures/plugins/samples
 *   node scripts/pack-plugins.mjs --check    # 只校验「已生成产物」与源码一致（CI / prebuild 用）
 *   node scripts/pack-plugins.mjs --quiet    # 不打印逐包体积表
 *
 * 产物（07 §1）：
 *   public/plugins/samples/<name>-0.1.0.lumenplug   （权威，带版本号）
 *   public/plugins/samples/<name>.lumenplug         （最新别名，页面/说明用）
 *   tests/fixtures/plugins/samples/<name>.lumenplug （测试夹具，供 e2e/契约测试安装）
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..')
export const SOURCE_DIR = join(REPO_ROOT, 'plugins', 'builtin')
export const PUBLIC_OUT_DIR = join(REPO_ROOT, 'public', 'plugins', 'samples')
export const FIXTURE_OUT_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'plugins', 'samples')
/**
 * 插件页的体积/版本数据源（生成物，勿手改）：`src/pages/plugins/samples.ts` 直接 import 它，
 * 避免「改了 plugin.js 忘了同步页面上的 KB 常量」这类漂移。
 */
export const SIZES_JSON = join(REPO_ROOT, 'src', 'pages', 'plugins', 'pack-sizes.json')
export const ENVELOPE_FORMAT = 'lumen-plugin'
export const ENVELOPE_FORMAT_VERSION = 1
/** 固定构建锚点（可复现构建）：2026-11-03T00:00:00Z，落在 §2.1 的合法区间内。 */
export const ENVELOPE_CREATED_AT = Date.UTC(2026, 10, 3)

/** 信封硬上限（02 §2.2）。 */
export const PACKAGE_LIMITS = {
  totalBytes: 2_000_000,
  fileCount: 64,
  fileBytes: 512_000,
  entryBytes: 256_000,
  iconBytes: 64 * 1024,
}

/** 三款样例的预算与能力口径（05 §1.4/§7）。 */
export const SAMPLES = [
  {
    name: 'brandguard',
    id: 'com.lumen.samples.brandguard',
    budgetBytes: 80 * 1024,
    capabilities: 11,
    frameSlots: 2,
    sensitive: true,
    expectLintRules: 4,
    expectRecipes: 0,
    expectExportHooks: 1,
  },
  {
    name: 'chartkit',
    id: 'com.lumen.samples.chartkit',
    budgetBytes: 120 * 1024,
    capabilities: 8,
    frameSlots: 1,
    sensitive: true,
    expectLintRules: 3,
    expectRecipes: 3,
    expectExportHooks: 0,
  },
  {
    name: 'focusdesk',
    id: 'com.lumen.samples.focusdesk',
    budgetBytes: 60 * 1024,
    capabilities: 7,
    frameSlots: 2,
    sensitive: false,
    expectLintRules: 0,
    expectRecipes: 0,
    expectExportHooks: 0,
  },
]

/** 15 项能力（00 §7.2）。 */
export const CAPABILITIES = [
  'ui:slot',
  'ui:command',
  'ui:keymap',
  'ui:layout',
  'theme:contribute',
  'library:contribute',
  'i18n:contribute',
  'lint:rule',
  'ai:recipe',
  'storage',
  'ai:invoke',
  'deck:read',
  'deck:write',
  'asset:write',
  'export:hook',
]
export const SENSITIVE_CAPABILITIES = ['ai:invoke', 'deck:write', 'asset:write', 'export:hook']

/** 插槽 → 允许的 kind（02 §6.10）。 */
const SLOT_KINDS = {
  'workspace.topbar': ['inline'],
  'workspace.rail.footer': ['inline'],
  'workspace.inspector.tab': ['panel'],
  'workspace.dock': ['panel'],
  'workspace.overlay': ['overlay'],
  dialog: ['modal'],
  'settings.page': ['panel'],
  'play.overlay': ['overlay'],
  'command.palette': [],
}
const FRAME_SLOTS = new Set(['workspace.inspector.tab', 'workspace.dock', 'workspace.overlay', 'dialog', 'settings.page', 'play.overlay'])
const ALLOWED_EXTENSIONS = new Set(['.js', '.mjs', '.json', '.svg', '.css', '.md', '.txt'])
const FILE_PATH_RE = /^(?:[a-z0-9][a-z0-9._-]*\/){0,2}[a-z0-9][a-z0-9._-]*$/

/**
 * 源码静态预检的禁用 API（与 `src/plugins/manifest.ts#FORBIDDEN_SOURCE_PATTERNS` 同步；
 * 这里保留一份是为了让本脚本不依赖 TS 运行时，安装期仍以宿主 scanSource 为准）。
 */
export const FORBIDDEN_SOURCE_PATTERNS = [
  [/^\s*import\b/m, 'import-statement'],
  [/\bimport\s*\(/, 'dynamic-import'],
  [/\brequire\s*\(/, 'require'],
  [/\bnew\s+Function\b/, 'new-function'],
  [/\beval\s*\(/, 'eval'],
  [/\bfetch\s*\(/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'xmlhttprequest'],
  [/\bWebSocket\b/, 'websocket'],
  [/\bsendBeacon\b/, 'sendbeacon'],
  [/\blocalStorage\b/, 'localstorage'],
  [/\bdocument\s*\.\s*cookie\b/, 'document-cookie'],
  [/\bdocument\s*\.\s*domain\b/, 'document-domain'],
  [/\btop\s*\.\s*location\b/, 'top-location'],
  [/\bwindow\s*\.\s*open\b/, 'window-open'],
  [/\bnew\s+Worker\b/, 'worker'],
  [/\bserviceWorker\b/, 'service-worker'],
  [/\bindexedDB\b/, 'indexeddb'],
  [/\bBroadcastChannel\b/, 'broadcast-channel'],
  [/\bWebAssembly\b/, 'wasm'],
  [/<script\b/i, 'script-tag'],
]

export class PackError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PackError'
  }
}

function fail(message) {
  throw new PackError(message)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

/* ------------------------- canonical JSON + sha256 ------------------------- */

/**
 * canonicalJson(value) —— 02 §2.4 六条规则的 Node 侧实现，**逐字节对齐宿主**
 * `src/plugins/package.ts#canonicalJson`（安装时重算 integrity，两边必须一致）：
 *   - 对象键按 UTF-16 code unit 升序递归排序，数组保持原序；
 *   - 无任何空白；字符串走 JSON.stringify（转义最小集，非 ASCII 原样）；
 *   - 数字：-0 归一 0、拒绝 NaN/Infinity/非安全整数，有限浮点按 JS 最短往返表示（theme 的 glow/opacity 需要）；
 *   - undefined/函数/symbol/BigInt/非纯对象一律拒绝；深度 ≤64。
 */
const MAX_CANONICAL_DEPTH = 64

export function canonicalJson(value, path = '$') {
  return encodeValue(value, 0, path)
}

function encodeValue(value, depth, path) {
  if (depth > MAX_CANONICAL_DEPTH) fail(`canonicalJson: 嵌套超过 ${MAX_CANONICAL_DEPTH} 层 @ ${path}`)
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'string') return encodeString(value)
  if (type === 'number') return encodeNumber(value, path)
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    fail(`canonicalJson: 不支持的类型 ${type} @ ${path}`)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => encodeValue(item, depth + 1, `${path}[${index}]`)).join(',')}]`
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(`canonicalJson: 非纯对象 @ ${path}`)
  const keys = Object.keys(value).sort()
  const parts = []
  for (const key of keys) {
    const item = value[key]
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
      fail(`canonicalJson: undefined/函数不允许 @ ${path}.${key}`)
    }
    parts.push(`${encodeString(key)}:${encodeValue(item, depth + 1, `${path}.${key}`)}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * 字符串最小转义，逐字节对齐宿主 `package.ts#encodeString`：
 * 只转义 `"`、`\` 与 U+0000–U+001F（一律 `\uXXXX`，包括换行/制表），其余（含中文）原样。
 */
function encodeString(value) {
  let out = '"'
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const code = value.charCodeAt(index)
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += char + value[index + 1]
        index += 1
      } else out += `\\u${code.toString(16)}`
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += `\\u${code.toString(16)}`
    } else out += char
  }
  return `${out}"`
}

function encodeNumber(value, path) {
  if (!Number.isFinite(value)) fail(`canonicalJson: NaN/Infinity 不允许 @ ${path}`)
  if (Object.is(value, -0)) return '0'
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) fail(`canonicalJson: 整数超出安全范围 @ ${path}`)
  return JSON.stringify(value)
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** integrity = 'sha256:' + sha256(utf8(canonicalJson(payload)))（02 §2.4 顶层交付形态）。 */
export function computeIntegrity(manifest, files, createdAt = ENVELOPE_CREATED_AT) {
  const payload = { format: ENVELOPE_FORMAT, formatVersion: ENVELOPE_FORMAT_VERSION, createdAt, manifest, files }
  return {
    payload,
    integrity: `sha256:${sha256Hex(canonicalJson(payload))}`,
  }
}

/* ------------------------------ 读取与校验 ------------------------------ */

function readJsonFile(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    fail(`读不到 ${path}`)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    fail(`${path} 不是合法 JSON：${String(err)}`)
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function collectPackageFiles(pluginDir) {
  const entryPath = join(pluginDir, 'plugin.js')
  assert(existsSync(entryPath), `${pluginDir} 缺少 plugin.js`)
  const iconPath = join(pluginDir, 'icon.svg')
  assert(existsSync(iconPath), `${pluginDir} 缺少 icon.svg`)
  const localesDir = join(pluginDir, 'locales')
  assert(existsSync(localesDir), `${pluginDir} 缺少 locales/`)
  const localeFiles = readdirSync(localesDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
  assert(localeFiles.length === 2, `${pluginDir}/locales 应恰好有 zh.json / en.json`)
  const files = { 'plugin.js': readFileSync(entryPath, 'utf8'), 'icon.svg': readFileSync(iconPath, 'utf8') }
  for (const name of localeFiles) files[`locales/${name}`] = readFileSync(join(localesDir, name), 'utf8')
  return files
}

function loadLocales(pluginDir) {
  const zh = readJsonFile(join(pluginDir, 'locales', 'zh.json')).zh
  const en = readJsonFile(join(pluginDir, 'locales', 'en.json')).en
  assert(isPlainObject(zh) && isPlainObject(en), 'locales/zh.json 与 en.json 必须是 { zh: {...} } / { en: {...} } 结构')
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert(
    zhKeys.length === enKeys.length && zhKeys.every((key, index) => key === enKeys[index]),
    `locales 键集不相等（zh ${zhKeys.length} / en ${enKeys.length}）`,
  )
  assert(zhKeys.length >= 12, `语言包至少要 12 个键，当前 ${zhKeys.length}`)
  for (const key of zhKeys) {
    assert(/^[a-z][a-zA-Z0-9._-]{0,63}$/.test(key), `非法语言包键名: ${key}`)
    for (const value of [zh[key], en[key]]) {
      assert(typeof value === 'string' && value.trim() !== '', `语言包键 ${key} 的值不能为空`)
      assert(value.length <= 200, `语言包键 ${key} 的值超过 200 字符`)
    }
  }
  return { zh, en }
}

/** manifest 注入 contributes.i18n（源 manifest 不内置，05 §2）并做逐项校验。 */
export function buildManifest(sample) {
  const pluginDir = join(SOURCE_DIR, sample.name)
  assert(existsSync(pluginDir), `找不到样例目录 ${pluginDir}`)
  const manifest = readJsonFile(join(pluginDir, '.lumen-plugin.json'))
  const locales = loadLocales(pluginDir)

  assert(manifest.id === sample.id, `${sample.name}: manifest.id 必须是 ${sample.id}，收到 ${manifest.id}`)
  assert(manifest.version === '0.1.0', `${sample.name}: version 必须是 0.1.0`)
  assert(manifest.apiVersion === '1.0', `${sample.name}: apiVersion 必须是 1.0`)
  assert(manifest.minAppVersion === '0.4.0', `${sample.name}: minAppVersion 必须是 0.4.0`)
  assert(manifest.kind === 'code', `${sample.name}: kind 必须是 code`)
  assert(manifest.entry === 'plugin.js', `${sample.name}: entry 必须是 plugin.js`)
  assert(manifest.trust === 'builtin', `${sample.name}: 样例必须是 trust:'builtin'`)
  assert(typeof manifest.license === 'string' && manifest.license.length > 0, `${sample.name}: 缺少 license`)
  assert(manifest.icon === 'icon.svg', `${sample.name}: icon 必须是 icon.svg`)
  for (const lang of ['zh', 'en']) {
    assert(isPlainObject(manifest.name) && manifest.name[lang], `${sample.name}: name.${lang} 缺失`)
    assert(isPlainObject(manifest.description) && manifest.description[lang], `${sample.name}: description.${lang} 缺失`)
    assert(manifest.name[lang].length <= 24, `${sample.name}: name.${lang} 超过 24 字符`)
    assert(manifest.description[lang].length <= 160, `${sample.name}: description.${lang} 超过 160 字符`)
  }
  assert(manifest.author && manifest.author.name, `${sample.name}: 缺少 author.name`)

  // 能力：数量 / 去重 / 枚举 / 敏感能力口径
  assert(Array.isArray(manifest.capabilities), `${sample.name}: capabilities 必须是数组`)
  assert(
    new Set(manifest.capabilities).size === manifest.capabilities.length,
    `${sample.name}: capabilities 有重复项`,
  )
  for (const capability of manifest.capabilities) {
    assert(CAPABILITIES.includes(capability), `${sample.name}: 未知能力 ${capability}`)
  }
  assert(
    manifest.capabilities.length === sample.capabilities,
    `${sample.name}: 能力数应为 ${sample.capabilities}，收到 ${manifest.capabilities.length}`,
  )
  const sensitive = manifest.capabilities.filter((capability) => SENSITIVE_CAPABILITIES.includes(capability))
  if (sample.sensitive === false) assert(sensitive.length === 0, `${sample.name}: 不应申请敏感能力（${sensitive.join(', ')}）`)

  const contributes = manifest.contributes
  assert(isPlainObject(contributes), `${sample.name}: 缺少 contributes`)
  assert(contributes.i18n === undefined, `${sample.name}: 源 manifest 不该内置 i18n（由打包脚本内联）`)

  // 插槽：kind 与 slot 兼容、带帧插槽 ≤2、inline 必须给 open
  const slots = contributes.slots ?? []
  assert(Array.isArray(slots) && slots.length > 0, `${sample.name}: 缺少 contributes.slots`)
  let frameSlots = 0
  for (const slot of slots) {
    const allowed = SLOT_KINDS[slot.slot]
    assert(allowed, `${sample.name}: 未知插槽 ${slot.slot}`)
    assert(allowed.includes(slot.kind), `${sample.name}: 插槽 ${slot.id} 的 kind=${slot.kind} 与 ${slot.slot} 不匹配`)
    if (FRAME_SLOTS.has(slot.slot)) frameSlots += 1
    if (slot.kind === 'inline') {
      assert(slot.open && slot.open.slot && slot.open.contributionId, `${sample.name}: inline 插槽 ${slot.id} 必须声明 open`)
    }
  }
  assert(frameSlots <= 2, `${sample.name}: 带帧插槽 ${frameSlots} 超过每插件 2 帧上限`)
  assert(frameSlots === sample.frameSlots, `${sample.name}: 带帧插槽应为 ${sample.frameSlots}，收到 ${frameSlots}`)

  // 代码式贡献：清单声明（运行期双注册由宿主校验）
  const lintRules = contributes.lintRules ?? []
  const recipes = contributes.recipes ?? []
  const exportHooks = contributes.exportHooks ?? []
  assert(lintRules.length === sample.expectLintRules, `${sample.name}: lintRules 应为 ${sample.expectLintRules}`)
  assert(recipes.length === sample.expectRecipes, `${sample.name}: recipes 应为 ${sample.expectRecipes}`)
  assert(exportHooks.length === sample.expectExportHooks, `${sample.name}: exportHooks 应为 ${sample.expectExportHooks}`)
  for (const recipe of recipes) {
    assert(recipe.namespace === 'chartkit', `${sample.name}: 配方 namespace 必须是 chartkit`)
  }

  // 布局预设 / 键位（FocusDesk）
  for (const preset of contributes.layoutPresets ?? []) {
    assert(/^[a-z][a-z0-9-]{1,23}$/.test(preset.id), `${sample.name}: 非法布局预设 id ${preset.id}`)
    assert(isPlainObject(preset.apply), `${sample.name}: 布局预设 ${preset.id} 缺少 apply`)
  }
  for (const binding of contributes.keymap ?? []) {
    assert(/^(?:(?:mod|shift|alt)\+)+[a-z0-9]$/.test(binding.combo), `${sample.name}: 键位 ${binding.combo} 非法（必须含修饰键）`)
    assert(typeof binding.commandId === 'string' && binding.commandId.length > 0, `${sample.name}: 键位 ${binding.combo} 缺少 commandId`)
  }

  const packaged = JSON.parse(JSON.stringify(manifest))
  packaged.contributes.i18n = [{ zh: locales.zh, en: locales.en }]
  return packaged
}

/** 路径/体积/扩展名/静态预检（02 §2.2、§4.3）。返回体积统计。 */
export function assertPackageFiles(sample, files) {
  const names = Object.keys(files)
  assert(names.length > 0, `${sample.name}: files 为空`)
  assert(names.length <= PACKAGE_LIMITS.fileCount, `${sample.name}: 文件数 ${names.length} 超过 64`)
  assert(!names.includes('.lumen-plugin.json'), `${sample.name}: files 里不能有 .lumen-plugin.json（manifest 已提升到顶层）`)
  let totalBytes = 0
  for (const name of names) {
    assert(FILE_PATH_RE.test(name), `${sample.name}: 非法文件路径 ${name}（路径段必须小写字母/数字开头，禁止 .. / 反斜杠 / 大写）`)
    assert(name === name.toLowerCase(), `${sample.name}: 文件路径必须全小写 ${name}`)
    const extension = name.slice(name.lastIndexOf('.'))
    assert(ALLOWED_EXTENSIONS.has(extension), `${sample.name}: 不允许的扩展名 ${name}`)
    assert(typeof files[name] === 'string', `${sample.name}: 文件 ${name} 必须是 UTF-8 字符串`)
    const bytes = Buffer.byteLength(files[name], 'utf8')
    assert(bytes <= PACKAGE_LIMITS.fileBytes, `${sample.name}: 文件 ${name} 超过 512 KB`)
    totalBytes += bytes
    if (extension === '.js' || extension === '.mjs') {
      const hits = FORBIDDEN_SOURCE_PATTERNS.filter(([pattern]) => pattern.test(files[name])).map(([, label]) => label)
      assert(hits.length === 0, `${sample.name}: 源码 ${name} 命中禁用 API（${hits.join(', ')}）`)
    }
  }
  assert(files['plugin.js'], `${sample.name}: files 缺少 plugin.js`)
  const entryBytes = Buffer.byteLength(files['plugin.js'], 'utf8')
  assert(entryBytes <= PACKAGE_LIMITS.entryBytes, `${sample.name}: 入口 ${entryBytes}B 超过 256 KB`)
  assert(files['icon.svg'], `${sample.name}: files 缺少 icon.svg`)
  const iconBytes = Buffer.byteLength(files['icon.svg'], 'utf8')
  assert(iconBytes <= PACKAGE_LIMITS.iconBytes, `${sample.name}: 图标 ${iconBytes}B 超过 64 KB`)
  return { totalBytes, entryBytes, iconBytes, fileCount: names.length }
}

/** 构建单个信封（纯内存，不写盘）。 */
export function buildEnvelope(sampleName) {
  const sample = SAMPLES.find((item) => item.name === sampleName)
  assert(sample, `未知样例 ${sampleName}（可选：${SAMPLES.map((item) => item.name).join(' / ')}）`)
  const pluginDir = join(SOURCE_DIR, sample.name)
  const manifest = buildManifest(sample)
  const files = collectPackageFiles(pluginDir)
  const stats = assertPackageFiles(sample, files)
  const { payload, integrity } = computeIntegrity(manifest, files)
  assert(/^sha256:[0-9a-f]{64}$/.test(integrity), `${sample.name}: integrity 形状非法`)
  const envelope = {
    format: ENVELOPE_FORMAT,
    formatVersion: ENVELOPE_FORMAT_VERSION,
    createdAt: ENVELOPE_CREATED_AT,
    integrity,
    manifest,
    files,
  }
  const serialized = JSON.stringify(envelope)
  const envelopeBytes = Buffer.byteLength(serialized, 'utf8')
  assert(envelopeBytes <= PACKAGE_LIMITS.totalBytes, `${sample.name}: 信封 ${envelopeBytes}B 超过 2 MB`)
  assert(
    envelopeBytes <= sample.budgetBytes,
    `${sample.name}: 信封 ${envelopeBytes}B 超过体积预算 ${sample.budgetBytes}B（05 §2）`,
  )
  return {
    sample,
    envelope,
    serialized,
    integrity,
    envelopeBytes,
    stats,
    versionedName: `${sample.name}-${manifest.version}.lumenplug`,
    aliasName: `${sample.name}.lumenplug`,
  }
}

export function buildAll() {
  return SAMPLES.map((sample) => buildEnvelope(sample.name))
}

/** 重新计算信封 integrity（安装/校验路径同口径，U-40-01…30 的 Node 侧对照）。 */
export function verifyEnvelope(envelope) {
  assert(isPlainObject(envelope), 'envelope 必须是对象')
  assert(envelope.format === ENVELOPE_FORMAT, `format 必须是 ${ENVELOPE_FORMAT}`)
  assert(envelope.formatVersion === ENVELOPE_FORMAT_VERSION, `formatVersion 必须是 ${ENVELOPE_FORMAT_VERSION}`)
  assert(Number.isSafeInteger(envelope.createdAt), 'createdAt 必须是安全整数')
  assert(isPlainObject(envelope.manifest), 'manifest 缺失')
  assert(isPlainObject(envelope.files), 'files 缺失')
  const { integrity } = computeIntegrity(envelope.manifest, envelope.files, envelope.createdAt)
  return { ok: integrity === envelope.integrity, expected: integrity, actual: envelope.integrity }
}

/* -------------------------------- 写盘 / CLI -------------------------------- */

/** 页面体积表（`src/pages/plugins/pack-sizes.json`）：envelopeBytes 是唯一口径，KB 由页面向上取整。 */
export function sizesJsonFor(results) {
  const samples = {}
  for (const result of results) {
    samples[result.sample.name] = {
      version: result.envelope.manifest.version,
      envelopeBytes: result.envelopeBytes,
      entryBytes: result.stats.entryBytes,
      integrity: result.integrity,
    }
  }
  return {
    $comment: '由 scripts/pack-plugins.mjs 生成，勿手改；插件页据此显示体积与版本。',
    formatVersion: 1,
    samples,
  }
}

function serializeSizes(sizes) {
  return `${JSON.stringify(sizes, null, 2)}\n`
}

function writeOutputs(results, { check, quiet }) {
  const sizesText = serializeSizes(sizesJsonFor(results))
  if (check) {
    let mismatched = 0
    const expected = []
    for (const result of results) {
      expected.push([join(PUBLIC_OUT_DIR, result.versionedName), result.serialized])
      expected.push([join(PUBLIC_OUT_DIR, result.aliasName), result.serialized])
      expected.push([join(FIXTURE_OUT_DIR, result.aliasName), result.serialized])
    }
    expected.push([SIZES_JSON, sizesText])
    for (const [path, text] of expected) {
      if (!existsSync(path)) {
        mismatched += 1
        console.error(`[缺少] ${path}`)
        continue
      }
      if (readFileSync(path, 'utf8') !== text) {
        mismatched += 1
        console.error(`[过期] ${path}`)
      }
    }
    if (mismatched > 0) {
      console.error(`pack-plugins --check 失败：${mismatched} 个产物缺失或过期，请运行 node scripts/pack-plugins.mjs`)
      process.exitCode = 1
      return
    }
    if (!quiet) console.log(`pack-plugins --check: ${expected.length} 个产物与源码一致`)
    return
  }

  mkdirSync(PUBLIC_OUT_DIR, { recursive: true })
  mkdirSync(FIXTURE_OUT_DIR, { recursive: true })
  mkdirSync(dirname(SIZES_JSON), { recursive: true })
  for (const result of results) {
    writeFileSync(join(PUBLIC_OUT_DIR, result.versionedName), result.serialized, 'utf8')
    writeFileSync(join(PUBLIC_OUT_DIR, result.aliasName), result.serialized, 'utf8')
    writeFileSync(join(FIXTURE_OUT_DIR, result.aliasName), result.serialized, 'utf8')
  }
  writeFileSync(SIZES_JSON, sizesText, 'utf8')
  if (quiet) return

  const rows = results.map((result) => ({
    样例: result.sample.name,
    '信封 KB': (result.envelopeBytes / 1024).toFixed(1),
    '预算 KB': (result.sample.budgetBytes / 1024).toFixed(0),
    文件: String(result.stats.fileCount),
    入口KB: (result.stats.entryBytes / 1024).toFixed(1),
    integrity: result.integrity.slice(7, 15),
  }))
  console.log('pack-plugins: 三款 .lumenplug 已生成')
  console.table(rows)
  console.log(`输出：${PUBLIC_OUT_DIR}`)
  console.log(`夹具：${FIXTURE_OUT_DIR}`)
  console.log(`体积表：${SIZES_JSON}`)
}

function main() {
  const check = process.argv.includes('--check')
  const quiet = process.argv.includes('--quiet')
  const results = buildAll()
  writeOutputs(results, { check, quiet })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
