/**
 * plugins/manifest.ts —— PluginManifest 的 zod 级校验（02 §2.3）、版本三件套（§2.5）、
 * 命名空间规则（§2.6）、贡献形状（§6）与入口源码静态预检（03 §6.3，`E-MAN-12`）。
 *
 * 全部对象 `.strict()`：未知字段一律拒绝（静默忽略 = 插件以为有、实际没有）。
 * 超限一律 `E-MAN-09`，不截断（截断会让作者以为装上了）。
 */
import { z } from 'zod'
import { APP_VERSION } from '@/version'
import { sanitizeSvgDocument } from '@/render/svg/sanitize'
import { parseColor } from '@/lint/color'
import { PluginError } from './errors'
import { isCapability, isSensitiveCapability, actionCapabilities } from './capabilities'
import { CAPABILITY_IDS, CONTRIBUTION_LIMITS, SLOT_IDS, SLOT_KINDS } from './types'
import type {
  Capability,
  Contributions,
  InstallSource,
  PluginErrorCode,
  PluginManifest,
} from './types'

/* ------------------------------ 版本常量（00 §7 / D-40-14） ------------------------------ */

export const HOST_ABI_VERSION = '1.0' as const
export const HOST_ABI_MAJOR = 1
export const HOST_ABI_MINOR = 0
export const API_VERSION_PATTERN = /^1\.\d{1,2}$/
export const SEMVER_PATTERN = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.-]{1,32})?$/
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}(?:\.[a-z][a-z0-9-]{1,31}){1,4}$/
export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,23}$/
export const RECIPE_NS_PATTERN = /^[a-z][a-z0-9-]{1,15}$/
export const SETTINGS_KEY_PATTERN = /^[a-z][a-zA-Z0-9._-]{0,63}$/
export const ICON_MAX_BYTES = 64 * 1024
export const CONTRIBUTION_TITLE_MAX = 24

export const BUILTIN_THEME_IDS = ['noir', 'paper', 'aurora', 'signal', 'museum', 'terminal'] as const

/* ------------------------------ 小工具 ------------------------------ */

export interface ManifestContext {
  installSource?: InstallSource
  appVersion?: string
  /** 信封 files（用于校验 entry/icon/library 源码体积与存在性）。 */
  files?: Record<string, string>
  /** 非致命告警（例如伪造 trust 被剥离 → 审计 `E-MAN-10`）。 */
  onWarning?: (code: 'E-MAN-10', detail: string) => void
  /** 已安装的同 id 记录（升级差集由 registry 计算；这里只用于「重装同版本」提示，不拒绝）。 */
  existingIds?: readonly string[]
}

function fail(code: PluginErrorCode, message: string, detail?: string): never {
  throw new PluginError(code, message, detail)
}

function bytesOfText(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length
  return new Blob([text]).size
}

export function parseSemver(value: string): [number, number, number] | null {
  const match = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})(?:-([0-9A-Za-z.-]{1,32}))?$/.exec(value)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** semver 比较（忽略预发布段；-1 / 0 / 1）。 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return 0
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

export function isApiVersionSupported(apiVersion: string): boolean {
  if (!API_VERSION_PATTERN.test(apiVersion)) return false
  const [major, minor] = apiVersion.split('.').map(Number)
  return major === HOST_ABI_MAJOR && minor <= HOST_ABI_MINOR
}

/* ------------------------------ zod 基元 ------------------------------ */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

const localizedText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL_CHARS.test(value), 'control characters are not allowed')

const localized = (max: number) =>
  z
    .object({
      zh: localizedText(max),
      en: localizedText(max),
    })
    .strict()

const slugSchema = z.string().regex(SLUG_PATTERN)
const hexColor = z.string().min(1).max(64)

const themeContributionSchema = z
  .object({
    id: slugSchema,
    name: localized(CONTRIBUTION_TITLE_MAX),
    vibe: localized(40).optional(),
    colors: z
      .object({
        bg: hexColor,
        fg: hexColor,
        muted: hexColor,
        surface: hexColor,
        line: hexColor,
        accent: hexColor,
        accent2: hexColor,
      })
      .strict(),
    font: z
      .object({
        body: z.string().min(1).max(400).optional(),
        display: z.string().min(1).max(400).optional(),
        mono: z.string().min(1).max(400).optional(),
      })
      .strict()
      .optional(),
    typeScale: z.number().min(0.8).max(1.25).optional(),
    radius: z.number().min(0).max(64).optional(),
    motion: z
      .object({ ease: z.string().min(1).max(160), ms: z.number().min(80).max(1600) })
      .strict()
      .optional(),
    texture: z
      .object({
        kind: z.enum(['none', 'grain', 'grid', 'scan', 'dots']),
        opacity: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    glow: z.number().min(0).max(1).optional(),
    elevation: z.enum(['flat', 'raised', 'layered']).optional(),
  })
  .strict()

const libraryContributionSchema = z
  .object({
    id: slugSchema,
    name: localized(CONTRIBUTION_TITLE_MAX),
    category: z.enum(['geometric', 'line', 'iso', 'chart', 'brand']),
    viewBox: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]),
    source: z.string().min(1).max(64 * 1024),
  })
  .strict()

const localePackSchema = z
  .object({
    zh: z.record(z.string().max(200)),
    en: z.record(z.string().max(200)),
  })
  .strict()

const settingsFieldSchema = z.discriminatedUnion('type', [
  z
    .object({
      key: z.string().regex(SETTINGS_KEY_PATTERN),
      type: z.literal('text'),
      label: localized(CONTRIBUTION_TITLE_MAX),
      placeholder: z.string().max(80).optional(),
      maxLength: z.number().int().min(1).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      key: z.string().regex(SETTINGS_KEY_PATTERN),
      type: z.literal('textarea'),
      label: localized(CONTRIBUTION_TITLE_MAX),
      maxLength: z.number().int().min(1).max(4000).optional(),
    })
    .strict(),
  z
    .object({
      key: z.string().regex(SETTINGS_KEY_PATTERN),
      type: z.literal('switch'),
      label: localized(CONTRIBUTION_TITLE_MAX),
      default: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      key: z.string().regex(SETTINGS_KEY_PATTERN),
      type: z.literal('number'),
      label: localized(CONTRIBUTION_TITLE_MAX),
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().positive().optional(),
      default: z.number().optional(),
    })
    .strict(),
  z
    .object({
      key: z.string().regex(SETTINGS_KEY_PATTERN),
      type: z.literal('slider'),
      label: localized(CONTRIBUTION_TITLE_MAX),
      min: z.number(),
      max: z.number(),
      step: z.number().positive().optional(),
      default: z.number().optional(),
    })
    .strict(),
  z
    .object({
      key: z.string().regex(SETTINGS_KEY_PATTERN),
      type: z.literal('select'),
      label: localized(CONTRIBUTION_TITLE_MAX),
      options: z
        .array(z.object({ value: z.string().min(1).max(120), label: localized(CONTRIBUTION_TITLE_MAX) }).strict())
        .min(1)
        .max(24),
    })
    .strict(),
])

const settingsPageSchema = z
  .object({
    id: slugSchema,
    title: localized(CONTRIBUTION_TITLE_MAX),
    fields: z.array(settingsFieldSchema).min(1).max(12),
  })
  .strict()

const declarativeActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('setTheme'), themeId: slugSchema }).strict(),
  z.object({ kind: z.literal('applyLayoutPreset'), presetId: slugSchema }).strict(),
  z
    .object({
      kind: z.literal('insertLibrarySvg'),
      libraryId: slugSchema,
      slideId: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('insertTextBlocks'),
      blocks: z
        .array(
          z
            .object({
              text: z.string().min(1).max(6000),
              variant: z.enum(['display', 'h1', 'h2', 'lead', 'body', 'caption', 'mono']).optional(),
              x: z.number().optional(),
              y: z.number().optional(),
              w: z.number().positive().optional(),
              h: z.number().positive().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(24),
    })
    .strict(),
  z
    .object({
      kind: z.literal('openPluginPanel'),
      slot: z.enum(SLOT_IDS),
      contributionId: slugSchema,
    })
    .strict(),
  z.object({ kind: z.literal('openSettings') }).strict(),
  z.object({ kind: z.literal('runExportPreflight') }).strict(),
  z.object({ kind: z.literal('toast'), message: localized(160) }).strict(),
])

const declarativeCommandSchema = z
  .object({
    id: slugSchema,
    title: localized(CONTRIBUTION_TITLE_MAX),
    category: z.literal('plugin'),
    icon: z.string().min(1).max(160).optional(),
    action: declarativeActionSchema,
  })
  .strict()

const keymapBindingSchema = z
  .object({
    combo: z.string().min(1).max(64),
    commandId: slugSchema,
  })
  .strict()

const layoutPresetSchema = z
  .object({
    id: slugSchema,
    name: localized(CONTRIBUTION_TITLE_MAX),
    apply: z
      .object({
        railWidth: z.number().min(180).max(280).optional(),
        panelWidth: z.number().min(300).max(420).optional(),
        hideRail: z.boolean().optional(),
        hideInspector: z.boolean().optional(),
        leftTab: z.enum(['slides', 'outline']).optional(),
        rightMode: z.enum(['inspector', 'composer']).optional(),
        dockHeight: z.number().min(240).max(400).optional(),
        inspectorTab: z.enum(['props', 'layers', 'motion', 'notes', 'theme', 'lint']).optional(),
        showGrid: z.boolean().optional(),
        density: z.enum(['comfortable', 'compact']).optional(),
      })
      .strict(),
  })
  .strict()

const slotContributionSchema = z
  .object({
    id: slugSchema,
    slot: z.enum(SLOT_IDS),
    title: localized(CONTRIBUTION_TITLE_MAX),
    icon: z.string().min(1).max(160).optional(),
    kind: z.enum(['inline', 'panel', 'overlay', 'modal']),
    size: z
      .object({ w: z.number().positive().max(4000).optional(), h: z.number().positive().max(4000).optional() })
      .strict()
      .optional(),
    order: z.number().int().min(0).max(99).optional(),
    open: z
      .object({
        slot: z.enum(SLOT_IDS),
        contributionId: slugSchema,
        kind: z.enum(['panel', 'modal']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const lintRuleDeclarationSchema = z
  .object({
    id: slugSchema,
    title: localized(40),
    severity: z.enum(['info', 'warn', 'error']),
    description: localized(120).optional(),
  })
  .strict()

const recipeDeclarationSchema = z
  .object({
    id: slugSchema,
    namespace: z.string().regex(RECIPE_NS_PATTERN),
    title: localized(40),
    slots: z
      .array(
        z
          .object({
            key: z.enum(['headline', 'lead', 'points', 'visual', 'caption']),
            required: z.boolean().optional(),
            max: z.number().int().min(1).max(24).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    preview: z.string().min(1).max(160).optional(),
  })
  .strict()

const exportHookDeclarationSchema = z
  .object({
    id: slugSchema,
    title: localized(CONTRIBUTION_TITLE_MAX),
    kind: z.enum(['preflight', 'assets']),
    maxBytes: z.number().int().min(1).max(1024 * 1024).optional(),
  })
  .strict()

const contributionsSchema = z
  .object({
    themes: z.array(themeContributionSchema).optional(),
    library: z.array(libraryContributionSchema).optional(),
    i18n: z.array(localePackSchema).optional(),
    settings: settingsPageSchema.optional(),
    commands: z.array(declarativeCommandSchema).optional(),
    keymap: z.array(keymapBindingSchema).optional(),
    layoutPresets: z.array(layoutPresetSchema).optional(),
    slots: z.array(slotContributionSchema).optional(),
    lintRules: z.array(lintRuleDeclarationSchema).optional(),
    recipes: z.array(recipeDeclarationSchema).optional(),
    exportHooks: z.array(exportHookDeclarationSchema).optional(),
  })
  .strict()

const manifestSchema = z
  .object({
    id: z.string().min(3).max(96).regex(PLUGIN_ID_PATTERN),
    name: localized(CONTRIBUTION_TITLE_MAX),
    version: z.string().regex(SEMVER_PATTERN),
    apiVersion: z.string().regex(API_VERSION_PATTERN),
    minAppVersion: z.string().regex(SEMVER_PATTERN),
    kind: z.enum(['declarative', 'code']),
    entry: z.string().min(1).max(160).optional(),
    trust: z.literal('builtin').optional(),
    author: z
      .object({
        name: z.string().trim().min(1).max(64),
        url: z
          .string()
          .max(200)
          .regex(/^https?:\/\//)
          .optional(),
      })
      .strict(),
    description: localized(160),
    license: z.string().trim().min(1).max(64),
    icon: z.string().min(1).max(160).optional(),
    capabilities: z.array(z.string()).max(15),
    contributes: contributionsSchema,
  })
  .strict()

/* ------------------------------ 入口源码静态预检（03 §6.3） ------------------------------ */

export interface ForbiddenHit {
  /** 命中规则名（例如 `fetch`）；`pattern` 为同一值的别名（兼容两种读法）。 */
  name: string
  pattern: string
  line: number
  column: number
  snippet: string
}

/** 禁用 API 正则表（03 §6.3，宁可误伤：命中即 E-MAN-12）。 */
export const FORBIDDEN_SOURCE_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'import-statement', pattern: /^\s*import\b/m },
  { name: 'dynamic-import', pattern: /\bimport\s*\(/ },
  { name: 'require', pattern: /\brequire\s*\(/ },
  { name: 'new-function', pattern: /\bnew\s+Function\b/ },
  { name: 'eval', pattern: /\beval\s*\(/ },
  { name: 'fetch', pattern: /\bfetch\s*\(/ },
  { name: 'xmlhttprequest', pattern: /\bXMLHttpRequest\b/ },
  { name: 'websocket', pattern: /\bWebSocket\b/ },
  { name: 'sendbeacon', pattern: /\bsendBeacon\b/ },
  { name: 'localstorage', pattern: /\blocalStorage\b/ },
  { name: 'document-cookie', pattern: /\bdocument\s*\.\s*cookie\b/ },
  { name: 'document-domain', pattern: /\bdocument\s*\.\s*domain\b/ },
  { name: 'top-location', pattern: /\btop\s*\.\s*location\b/ },
  { name: 'window-open', pattern: /\bwindow\s*\.\s*open\b/ },
  { name: 'worker', pattern: /\bnew\s+Worker\b/ },
  { name: 'service-worker', pattern: /\bserviceWorker\b/ },
  { name: 'indexeddb', pattern: /\bindexedDB\b/ },
  { name: 'broadcast-channel', pattern: /\bBroadcastChannel\b/ },
  { name: 'wasm', pattern: /\bWebAssembly\b/ },
  { name: 'script-tag', pattern: /<script\b/i },
]

/** 扫描入口源码；返回命中列表（空 = 通过）。 */
export function scanSource(source: string): ForbiddenHit[] {
  const lines = source.split(/\r?\n/)
  const hits: ForbiddenHit[] = []
  for (const { name, pattern } of FORBIDDEN_SOURCE_PATTERNS) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const match = pattern.exec(line)
      if (!match) continue
      hits.push({
        name,
        pattern: name,
        line: index + 1,
        column: (match.index ?? 0) + 1,
        snippet: line.trim().slice(0, 80),
      })
      break
    }
  }
  return hits
}

/** 预检入口源码，命中 → `E-MAN-12`（带行号，可回喂）。 */
export function assertSourceSafe(source: string, entry: string): void {
  const hits = scanSource(source)
  if (hits.length === 0) return
  const first = hits[0]
  fail(
    'E-MAN-12',
    `forbidden API "${first.pattern}" at ${entry}:${first.line}:${first.column}`,
    hits.slice(0, 5).map((hit) => `${hit.pattern}@${hit.line}`).join(', '),
  )
}

/* ------------------------------ 主入口 ------------------------------ */

const CONTRIBUTION_ARRAY_KEYS = [
  'themes',
  'library',
  'i18n',
  'commands',
  'keymap',
  'layoutPresets',
  'slots',
  'lintRules',
  'recipes',
  'exportHooks',
] as const

const CONTRIBUTION_TO_CAPABILITY: Record<(typeof CONTRIBUTION_ARRAY_KEYS)[number] | 'settings', Capability> = {
  themes: 'theme:contribute',
  library: 'library:contribute',
  i18n: 'i18n:contribute',
  settings: 'storage',
  commands: 'ui:command',
  keymap: 'ui:keymap',
  layoutPresets: 'ui:layout',
  slots: 'ui:slot',
  lintRules: 'lint:rule',
  recipes: 'ai:recipe',
  exportHooks: 'export:hook',
}

/** zod 字段失败 → 02 §2.3 的专属错误码（其余字段统一 `E-MAN-01`）。 */
const FIELD_ERROR_CODES: Record<string, PluginErrorCode> = {
  id: 'E-MAN-02',
  version: 'E-MAN-03',
  apiVersion: 'E-MAN-04',
  minAppVersion: 'E-MAN-05',
  capabilities: 'E-MAN-08',
}

/**
 * manifest 全量校验（安装管线步骤 4，02 §3.1）。
 * 返回**已规整**的清单：能力去重排序、伪造的 `trust` 被剥离（回调发 `E-MAN-10`）。
 */
export function parseManifest(input: unknown, ctx: ManifestContext = {}): PluginManifest {
  const result = manifestSchema.safeParse(input)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    const field = typeof issue.path[0] === 'string' ? issue.path[0] : ''
    const code = FIELD_ERROR_CODES[field] ?? 'E-MAN-01'
    fail(code, `${path}: ${issue.message}`, issue.code)
  }
  const raw = result.data
  const appVersion = ctx.appVersion ?? APP_VERSION

  /* --- 1. id 命名空间（02 §2.3 / §2.6） --- */
  const segments = raw.id.split('.')
  if (segments.includes('lumen') || (segments[0] === 'com' && segments[1] === 'lumen')) {
    const builtin = raw.trust === 'builtin' && (ctx.installSource ?? 'file') === 'builtin'
    if (!builtin) fail('E-MAN-02', `plugin id "${raw.id}" uses the reserved "lumen" namespace`)
  }

  /* --- 2. 版本三件套（02 §2.5） --- */
  if (!isApiVersionSupported(raw.apiVersion)) {
    fail('E-MAN-04', `apiVersion "${raw.apiVersion}" is not supported (host ABI ${HOST_ABI_VERSION})`)
  }
  if (compareSemver(raw.minAppVersion, appVersion) > 0) {
    fail('E-MAN-05', `minAppVersion ${raw.minAppVersion} is newer than app ${appVersion}`)
  }

  /* --- 3. trust：只认 installSource==='builtin'（02 §2.3 / 03 §2） --- */
  let trust = raw.trust
  if (trust === 'builtin' && (ctx.installSource ?? 'file') !== 'builtin') {
    trust = undefined
    ctx.onWarning?.('E-MAN-10', `stripped forged trust:"builtin" from ${raw.id}`)
  }

  /* --- 4. 商标边界（03 §8.3） --- */
  if (!trust) {
    for (const [lang, value] of [['zh', raw.name.zh], ['en', raw.name.en]] as const) {
      if (/^(?:lumen|幕光)/i.test(value.trim())) {
        fail('E-MAN-01', `name.${lang} must not start with LUMEN/幕光 for third-party plugins`)
      }
    }
  }

  /* --- 5. kind 与贡献形态（02 §2.3 E-MAN-06/07、§6.1/§6.6/§6.9） --- */
  const contributes = raw.contributes as Contributions
  const files = ctx.files
  if (raw.kind === 'code') {
    if (!raw.entry) fail('E-MAN-06', 'kind:"code" requires an entry file')
    if (files && !Object.prototype.hasOwnProperty.call(files, raw.entry)) {
      fail('E-MAN-06', `entry "${raw.entry}" is not present in files`)
    }
    if (!/\.(?:js|mjs)$/i.test(raw.entry)) fail('E-MAN-06', 'entry must be a .js/.mjs file')
    if (contributes.commands !== undefined) {
      fail('E-MAN-07', 'kind:"code" must not declare contributes.commands (register at runtime)')
    }
  } else {
    if (raw.entry !== undefined) fail('E-MAN-07', 'kind:"declarative" must not declare entry')
    if (contributes.slots !== undefined) fail('E-MAN-07', 'kind:"declarative" must not declare contributes.slots')
    for (const key of ['lintRules', 'recipes', 'exportHooks'] as const) {
      if (contributes[key] !== undefined) {
        fail('E-MAN-07', `kind:"declarative" must not declare contributes.${key}`)
      }
    }
  }

  /* --- 6. 贡献数组上限（02 §2.3 E-MAN-09） --- */
  for (const key of CONTRIBUTION_ARRAY_KEYS) {
    const list = contributes[key]
    if (!list) continue
    const limit = CONTRIBUTION_LIMITS[key]
    if (list.length > limit) {
      fail('E-MAN-09', `contributes.${key} has ${list.length} items (limit ${limit})`)
    }
  }
  const slotFrames = (contributes.slots ?? []).filter((slot) => slot.kind !== 'inline').length
  if (slotFrames > CONTRIBUTION_LIMITS.slotFrames) {
    fail('E-MAN-09', `contributes.slots has ${slotFrames} framed slots (limit ${CONTRIBUTION_LIMITS.slotFrames})`)
  }
  if (contributes.i18n && contributes.i18n.length > 1) fail('E-MAN-09', 'only one locale pack is allowed')

  /* --- 7. 能力（02 §2.3 E-MAN-08） --- */
  const capabilities: Capability[] = []
  for (const capability of raw.capabilities) {
    if (!isCapability(capability)) fail('E-MAN-08', `unknown capability "${capability}"`)
    if (!capabilities.includes(capability)) capabilities.push(capability)
  }
  for (const key of [...CONTRIBUTION_ARRAY_KEYS, 'settings'] as const) {
    const present = key === 'settings' ? contributes.settings !== undefined : contributes[key] !== undefined
    if (!present) continue
    const needed = CONTRIBUTION_TO_CAPABILITY[key]
    if (!capabilities.includes(needed)) {
      fail('E-MAN-08', `contributes.${key} requires capability "${needed}"`)
    }
  }

  /* --- 8. 贡献内部一致性（02 §6，失败统一 E-MAN-09） --- */
  validateThemes(contributes)
  validateLibrary(contributes, files)
  validateLocale(contributes)
  validateDeclarativeCommands(contributes, capabilities)
  validateKeymap(contributes, raw.kind)
  validateSlots(contributes)
  validateIcon(raw.icon, files)
  if (raw.kind === 'code' && files && raw.entry) assertSourceSafe(files[raw.entry], raw.entry)

  const manifest: PluginManifest = {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    apiVersion: raw.apiVersion,
    minAppVersion: raw.minAppVersion,
    kind: raw.kind,
    author: raw.author,
    description: raw.description,
    license: raw.license,
    capabilities,
    contributes,
  }
  if (raw.entry !== undefined) manifest.entry = raw.entry
  if (trust === 'builtin') manifest.trust = 'builtin'
  if (raw.icon !== undefined) manifest.icon = raw.icon
  return manifest
}

/* ------------------------------ 各贡献校验 ------------------------------ */

function validateThemes(contributes: Contributions): void {
  const seen = new Set<string>()
  for (const theme of contributes.themes ?? []) {
    if (seen.has(theme.id)) fail('E-MAN-09', `duplicate theme id "${theme.id}"`)
    seen.add(theme.id)
    if ((BUILTIN_THEME_IDS as readonly string[]).includes(theme.id)) {
      fail('E-MAN-09', `theme id "${theme.id}" is reserved by a built-in theme`)
    }
    for (const [token, value] of Object.entries(theme.colors)) {
      if (!parseColor(value)) fail('E-MAN-09', `theme "${theme.id}" color ${token} is not a valid color`)
    }
  }
}

function validateLibrary(contributes: Contributions, files?: Record<string, string>): void {
  const seen = new Set<string>()
  for (const item of contributes.library ?? []) {
    if (seen.has(item.id)) fail('E-MAN-09', `duplicate library id "${item.id}"`)
    seen.add(item.id)
    if (item.viewBox[2] <= 0 || item.viewBox[3] <= 0) {
      fail('E-MAN-09', `library "${item.id}" viewBox must be positive`)
    }
    const sanitized = sanitizeSvgDocument(item.source, { maxBytes: 64 * 1024 })
    if (!sanitized.svg) {
      fail('E-MAN-09', `library "${item.id}" source failed SVG sanitization`, sanitized.issues[0]?.message)
    }
    void files
  }
}

function validateLocale(contributes: Contributions): void {
  for (const pack of contributes.i18n ?? []) {
    const zhKeys = Object.keys(pack.zh).sort()
    const enKeys = Object.keys(pack.en).sort()
    if (zhKeys.length !== enKeys.length || zhKeys.some((key, index) => key !== enKeys[index])) {
      fail('E-MAN-09', 'i18n zh/en key sets must be equal')
    }
    const keyPattern = /^[a-z][a-zA-Z0-9._-]{0,63}$/
    for (const key of zhKeys) {
      if (!keyPattern.test(key)) fail('E-MAN-09', `invalid i18n key "${key}"`)
      if (!pack.zh[key] || !pack.en[key]) fail('E-MAN-09', `i18n value for "${key}" is empty`)
    }
  }
}

function validateDeclarativeCommands(contributes: Contributions, capabilities: readonly Capability[]): void {
  const themeIds = new Set((contributes.themes ?? []).map((theme) => theme.id))
  const presetIds = new Set((contributes.layoutPresets ?? []).map((preset) => preset.id))
  const libraryIds = new Set((contributes.library ?? []).map((item) => item.id))
  const slotIds = new Set((contributes.slots ?? []).map((slot) => `${slot.slot}:${slot.id}`))
  const granted = new Set(capabilities)
  const seen = new Set<string>()
  for (const command of contributes.commands ?? []) {
    if (seen.has(command.id)) fail('E-MAN-09', `duplicate command id "${command.id}"`)
    seen.add(command.id)
    const action = command.action
    switch (action.kind) {
      case 'setTheme':
        if (!themeIds.has(action.themeId)) {
          fail('E-MAN-09', `command "${command.id}" references undeclared theme "${action.themeId}"`)
        }
        break
      case 'applyLayoutPreset':
        if (!presetIds.has(action.presetId)) {
          fail('E-MAN-09', `command "${command.id}" references undeclared preset "${action.presetId}"`)
        }
        break
      case 'insertLibrarySvg':
        if (!libraryIds.has(action.libraryId)) {
          fail('E-MAN-09', `command "${command.id}" references undeclared library item "${action.libraryId}"`)
        }
        break
      case 'openPluginPanel':
        if (!slotIds.has(`${action.slot}:${action.contributionId}`)) {
          fail('E-MAN-09', `command "${command.id}" references undeclared slot "${action.contributionId}"`)
        }
        break
      default:
        break
    }
    // 02 §2.3 E-MAN-08：action 所需能力必须在清单 capabilities 中声明（未声明即使用 → 拒绝）。
    // 放在引用校验之后，保证「引用未声明贡献」优先报 E-MAN-09（02 §6.6）。
    for (const needed of actionCapabilities(action.kind)) {
      if (!granted.has(needed)) {
        fail('E-MAN-08', `command "${command.id}" action "${action.kind}" requires capability "${needed}"`)
      }
    }
  }
}

/** combo 语法：`mod|shift|alt` + 单键；必须至少含一个修饰键（02 §6.7 / Lead 增补 #20）。 */
export const KEYMAP_COMBO_PATTERN =
  /^(?:(?:mod|ctrl|cmd|meta|shift|alt|option)\+)+(?:[a-z]|[0-9]|enter|escape|space|tab|f[1-9]|f1[0-2]|arrowup|arrowdown|arrowleft|arrowright|home|end|pageup|pagedown|delete|backspace|\[|\]|,|\.|\/|`|-|=)$/

export function isValidKeymapCombo(combo: string): boolean {
  return KEYMAP_COMBO_PATTERN.test(combo.trim().toLowerCase())
}

function validateKeymap(contributes: Contributions, kind: 'declarative' | 'code'): void {
  const commandIds = new Set((contributes.commands ?? []).map((command) => command.id))
  const seen = new Set<string>()
  for (const binding of contributes.keymap ?? []) {
    if (!isValidKeymapCombo(binding.combo)) {
      fail('E-MAN-09', `invalid or bare key combo "${binding.combo}" (a modifier is required)`)
    }
    if (seen.has(binding.combo)) fail('E-MAN-09', `duplicate key combo "${binding.combo}"`)
    seen.add(binding.combo)
    // 声明式插件：命令必须在清单中声明；代码式插件：命令由运行期 `lumen.commands.register` 注册，
    // 清单 keymap 在 ready 后按「清单是唯一真相」校验（缺失 → E-MAN-13，02 §6.9）。
    if (kind === 'declarative' && !commandIds.has(binding.commandId)) {
      fail('E-MAN-09', `keymap references undeclared command "${binding.commandId}"`)
    }
  }
}

function validateSlots(contributes: Contributions): void {
  const slots = contributes.slots ?? []
  const seen = new Set<string>()
  for (const slot of slots) {
    if (seen.has(slot.id)) fail('E-MAN-09', `duplicate slot contribution id "${slot.id}"`)
    seen.add(slot.id)
    const allowed = SLOT_KINDS[slot.slot]
    if (!allowed.includes(slot.kind)) {
      fail('E-MAN-09', `slot "${slot.id}" kind "${slot.kind}" is not valid for ${slot.slot}`)
    }
    if (slot.open) {
      const target = slots.find((item) => item.id === slot.open?.contributionId)
      if (!target) fail('E-MAN-09', `slot "${slot.id}" opens undeclared contribution "${slot.open.contributionId}"`)
      if (target.id === slot.id) fail('E-MAN-09', `slot "${slot.id}" must not open itself`)
      if (target.slot !== slot.open.slot) {
        fail('E-MAN-09', `slot "${slot.id}" open.slot does not match target contribution slot`)
      }
      if (target.kind !== 'panel' && target.kind !== 'modal') {
        fail('E-MAN-09', `slot "${slot.id}" can only open a panel/modal contribution`)
      }
      if (slot.kind !== 'inline') fail('E-MAN-09', `slot "${slot.id}" open is only allowed on inline slots`)
    }
    if (slot.kind === 'inline' && !slot.open) {
      fail('E-MAN-09', `inline slot "${slot.id}" must declare open (static entry)`)
    }
  }
}

function validateIcon(icon: string | undefined, files?: Record<string, string>): void {
  if (icon === undefined) return
  if (!/\.svg$/i.test(icon)) fail('E-MAN-11', 'icon must be an .svg file inside the package')
  if (!files) return
  const source = files[icon]
  if (typeof source !== 'string') fail('E-MAN-11', `icon "${icon}" is not present in files`)
  if (bytesOfText(source) > ICON_MAX_BYTES) fail('E-MAN-11', 'icon exceeds 64KB')
  const sanitized = sanitizeSvgDocument(source, { maxBytes: ICON_MAX_BYTES })
  if (!sanitized.svg) fail('E-MAN-11', 'icon failed SVG sanitization', sanitized.issues[0]?.message)
}

/* ------------------------------ 便利校验（注册期/造模期共用） ------------------------------ */

/** 敏感能力二次确认是否完备（02 §5.1 / 03 §3.3）；返回未确认的敏感项。 */
export function unconfirmedSensitive(capabilities: readonly string[], grants: readonly string[]): Capability[] {
  const granted = new Set(grants)
  return (capabilities as Capability[]).filter((capability) => isSensitiveCapability(capability) && !granted.has(capability))
}

/** 清单身份键（诊断/日志用，不含正文）。 */
export function manifestIdentity(manifest: PluginManifest): { id: string; version: string; kind: string; apiVersion: string } {
  return { id: manifest.id, version: manifest.version, kind: manifest.kind, apiVersion: manifest.apiVersion }
}

export { isCapability, isSensitiveCapability }
export { SLOT_IDS, CAPABILITY_IDS }
