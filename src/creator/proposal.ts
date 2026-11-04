/**
 * creator/proposal.ts —— `CreatorProposal` 的解析与提案期双向校验（04 §4.3 / §5.1 / §5.2）。
 *
 * 唯一规格：00 §7.6 冻结 7 必填 + 1 可选（`trialNote?`）；字段名不扩不改。
 * 错误码只出现在提案期（04 §13.3.7）：
 * - `E-MAN-13`：提案与清单/代码不一致（能力集合不等、贡献→能力不匹配、双注册缺失、风险与能力矛盾）；
 * - `E-MAN-14`：命中不可改项 / 体积超限 / 文件路径非法；
 * - `E-MAN-09`：`settings.declare` 与 `contributes.settings` 同现（02 §5.3）。
 *
 * 依赖纪律：清单结构复用 `@/plugins/manifest` 的 `parseManifest`（单一来源）；
 * canonical/sha256 复用 `@/plugins/package`（不得另写一份）。
 */
import { z } from 'zod'
import {
  CAPABILITY_IDS,
  CREATOR_MAX_CAPABILITIES,
  SENSITIVE_CAPABILITIES,
  type Capability,
  type CreatorProposal,
  type PluginManifest,
} from '@/plugins/types'
import { parseManifest } from '@/plugins/manifest'
import { FORBIDDEN_SOURCE_PATTERNS, scanSource } from '@/plugins/manifest'
import { PluginError } from '@/plugins/errors'
import { bytesOf, canonicalJson, sha256Hex } from '@/plugins/package'

/* ============================ 上限（04 §5.1 / §6.4） ============================ */

export const CREATOR_LIMITS = {
  titleMin: 4,
  titleMax: 32,
  summaryMin: 8,
  summaryMax: 120,
  filesMin: 1,
  filesMax: 8,
  totalBytes: 24 * 1024,
  fileBytes: 16 * 1024,
  changesMin: 1,
  changesMax: 8,
  changeDetailMax: 60,
  trialNoteMax: 80,
  capabilitiesMax: CREATOR_MAX_CAPABILITIES,
} as const

/** 04 §4 的「面 id」集合（`changes[].surface` 只许这些值）。 */
export const CREATOR_SURFACES = [
  'workspace.topbar',
  'workspace.rail.footer',
  'workspace.inspector.tab',
  'workspace.dock',
  'workspace.overlay',
  'dialog',
  'settings.page',
  'play.overlay',
  'command.palette',
  'layout',
  'theme',
  'command',
  'keymap',
  'recipe',
  'lint',
  'export',
  'library',
  'i18n',
  'storage',
] as const

export type CreatorSurface = (typeof CREATOR_SURFACES)[number]

/** 文件路径白名单（04 §5.2，逐条固定；不允子目录/任意文件名）。 */
export const CREATOR_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.lumen-plugin\.json$/,
  /^plugin\.js$/,
  /^icon\.svg$/,
  /^locales\/(zh|en)\.json$/,
  /^assets\/[a-z0-9][a-z0-9._-]{0,63}\.svg$/,
]

export const MANIFEST_PATH = '.lumen-plugin.json'
export const ENTRY_PATH = 'plugin.js'

/** 贡献键 → 需要的能力（04 §4.3；i18n 数组与 settings 单对象都覆盖）。 */
export const CONTRIBUTION_CAPABILITY = {
  themes: 'theme:contribute',
  slots: 'ui:slot',
  keymap: 'ui:keymap',
  layoutPresets: 'ui:layout',
  commands: 'ui:command',
  recipes: 'ai:recipe',
  lintRules: 'lint:rule',
  exportHooks: 'export:hook',
  library: 'library:contribute',
  i18n: 'i18n:contribute',
  settings: 'storage',
} as const satisfies Record<string, Capability>

/** `kind:'declarative'` 不允许出现的代码式贡献字段（02 §2.3 / E-MAN-07）。 */
export const CODE_ONLY_CONTRIBUTIONS = ['slots', 'lintRules', 'recipes', 'exportHooks'] as const

/* ============================ 校验错误 ============================ */

export class CreatorValidationError extends Error {
  readonly code: 'E-MAN-09' | 'E-MAN-13' | 'E-MAN-14'
  readonly issues: string[]

  constructor(code: 'E-MAN-09' | 'E-MAN-13' | 'E-MAN-14', issues: string[]) {
    const list = issues.length > 0 ? issues : ['提案未通过校验']
    super(list.slice(0, 8).join(' | '))
    this.name = 'CreatorValidationError'
    this.code = code
    this.issues = list
  }

  /** 装配给状态机的错误（`detail` 已脱敏截断）。 */
  toCreatorError(): { code: 'E-MAN-09' | 'E-MAN-13' | 'E-MAN-14'; detail: string } {
    return { code: this.code, detail: this.issues.slice(0, 4).join(' | ').slice(0, 300) }
  }
}

function fail(code: 'E-MAN-09' | 'E-MAN-13' | 'E-MAN-14', issues: string[]): never {
  throw new CreatorValidationError(code, issues)
}

/* ============================ zod 形状 ============================ */

const pathSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((path) => CREATOR_FILE_PATTERNS.some((pattern) => pattern.test(path)), {
    message: 'path is not in the creator whitelist',
  })

const fileSchema = z
  .object({
    path: pathSchema,
    content: z.string().max(CREATOR_LIMITS.fileBytes * 4),
  })
  .strict()

const changeSchema = z
  .object({
    surface: z.enum(CREATOR_SURFACES),
    detail: z
      .string()
      .min(1)
      .max(CREATOR_LIMITS.changeDetailMax)
      .refine(
        (detail) =>
          !/(https?:\/\/|www\.|!?\[[^\]]*\]\(|`|<\/?[a-z][^>]*>|\*\*|__|(?:^|\s)[*_][^\s*_]+\s*[*_]?(?:\s|$))/i.test(
            detail,
          ),
        { message: 'change detail must not contain links or markup' },
      ),
  })
  .strict()

const capabilitySchema = z.enum(CAPABILITY_IDS)

/** 00 §7.6 冻结形状（.strict()：不扩名、不吞未知字段）。 */
export const creatorProposalSchema = z
  .object({
    title: z.string().min(CREATOR_LIMITS.titleMin).max(CREATOR_LIMITS.titleMax * 2),
    summary: z.string().min(CREATOR_LIMITS.summaryMin).max(CREATOR_LIMITS.summaryMax * 2),
    kind: z.enum(['declarative', 'code']),
    risk: z.enum(['low', 'medium', 'high']),
    capabilities: z.array(capabilitySchema).min(1).max(24),
    files: z.array(fileSchema).min(CREATOR_LIMITS.filesMin).max(CREATOR_LIMITS.filesMax),
    changes: z.array(changeSchema).min(CREATOR_LIMITS.changesMin).max(CREATOR_LIMITS.changesMax),
    trialNote: z.string().max(CREATOR_LIMITS.trialNoteMax * 2).optional(),
  })
  .strict()

/* ============================ 纯工具 ============================ */

/** 字符数（按 code point，不按 UTF-16 单元）。 */
export function charLength(value: string): number {
  return Array.from(value).length
}

/** 能力去重 + 按冻结表顺序排序（04 §4.3「去重排序后完全相等」）。 */
export function normalizeCapabilities(capabilities: readonly Capability[]): Capability[] {
  const set = new Set(capabilities)
  return CAPABILITY_IDS.filter((capability) => set.has(capability))
}

export function sensitiveCapabilitiesOf(capabilities: readonly Capability[]): Capability[] {
  return capabilities.filter((capability) => (SENSITIVE_CAPABILITIES as readonly string[]).includes(capability))
}

/** 提案 files → 包内 `Record<path, content>`（重复路径会在这里丢一个，前面已拒绝）。 */
export function filesToMap(files: { path: string; content: string }[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const file of files) out[file.path] = file.content
  return out
}

/** 体积统计（UTF-8 字节；04 §5.1 的 24KB/16KB 按字节算）。 */
export function proposalBytes(files: { path: string; content: string }[]): { total: number; perFile: number } {
  let total = 0
  let perFile = 0
  for (const file of files) {
    const bytes = bytesOf(file.content)
    total += bytes
    perFile = Math.max(perFile, bytes)
  }
  return { total, perFile }
}

/** `title` 不得是纯文件名（04 §5.1）。 */
export function isPureFileName(title: string): boolean {
  const trimmed = title.trim()
  if (trimmed === '') return false
  if (/[\\/]/.test(trimmed)) return true
  return /^[\w@.-]+\.(?:json|js|mjs|svg|css|md|txt|yml|yaml|toml)$/i.test(trimmed)
}

/** 从提案里解析清单（单一来源：plugins/manifest）。 */
export function parseProposalManifest(files: { path: string; content: string }[]): PluginManifest {
  const manifestFile = files.find((file) => file.path === MANIFEST_PATH)
  if (!manifestFile) fail('E-MAN-14', [`缺少 ${MANIFEST_PATH}`])
  let raw: unknown
  try {
    raw = JSON.parse(manifestFile.content)
  } catch (error) {
    fail('E-MAN-14', [`${MANIFEST_PATH} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`])
  }
  try {
    return parseManifest(raw, { files: filesToMap(files) })
  } catch (error) {
    if (error instanceof PluginError) fail(narrowManifestCode(error.code), [error.message])
    fail('E-MAN-14', [`${MANIFEST_PATH} 校验失败`])
  }
}

function narrowManifestCode(code: string): 'E-MAN-09' | 'E-MAN-13' | 'E-MAN-14' {
  // 提案期只对外暴露 E-MAN-13/14（+ E-MAN-09）；清单内部码统一收敛（04 §4.3 / §13.3.7）。
  if (code === 'E-MAN-09') return 'E-MAN-09'
  if (code === 'E-MAN-13' || code === 'E-MAN-14') return code
  if (code === 'E-MAN-12') return 'E-MAN-14'
  return 'E-MAN-13'
}

/* ============================ 能力 → 代码（启发式） ============================ */

/** `lumen.<ns>.<method>` → 需要的能力（02 §5.2 的唯一判据的静态镜像）。 */
const METHOD_CAPABILITY: Record<string, Capability> = {
  'ui.el': 'ui:slot',
  'ui.css': 'ui:slot',
  'ui.onRender': 'ui:slot',
  'ui.setTitle': 'ui:slot',
  'ui.setBusy': 'ui:slot',
  'ui.openDialog': 'ui:slot',
  'ui.openPanel': 'ui:slot',
  'ui.closePanel': 'ui:slot',
  'commands.register': 'ui:command',
  'commands.unregister': 'ui:command',
  'commands.invoke': 'ui:command',
  'keymap.bind': 'ui:keymap',
  'keymap.unbind': 'ui:keymap',
  'layout.registerPreset': 'ui:layout',
  'layout.apply': 'ui:layout',
  'layout.current': 'ui:layout',
  'deck.getSnapshot': 'deck:read',
  'deck.getActiveSlide': 'deck:read',
  'deck.subscribe': 'deck:read',
  'deck.insertBlocks': 'deck:write',
  'deck.updateBlock': 'deck:write',
  'deck.transaction': 'deck:write',
  'deck.applyTheme': 'deck:write',
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.remove': 'storage',
  'storage.keys': 'storage',
  'storage.clear': 'storage',
  'settings.declare': 'storage',
  'settings.get': 'storage',
  'settings.patch': 'storage',
  'settings.reset': 'storage',
  'settings.subscribe': 'storage',
  'i18n.register': 'i18n:contribute',
  'lint.helpers': 'lint:rule',
  'lint.registerRule': 'lint:rule',
  'lint.report': 'lint:rule',
  'ai.complete': 'ai:invoke',
  'ai.registerRecipe': 'ai:recipe',
  'ai.registerPromptFragment': 'ai:recipe',
  'assets.put': 'asset:write',
  'assets.getUrl': 'asset:write',
  'assets.remove': 'asset:write',
  'assets.list': 'asset:write',
  'export.onPreflight': 'export:hook',
  'export.provideStaticAssets': 'export:hook',
}

const LUMEN_CALL_PATTERN = /\blumen\s*\.\s*([A-Za-z]+)\s*\.\s*([A-Za-z]+)/g

/** 静态扫代码里实际用到的 `lumen.` API → 所需能力集合。 */
export function capabilitiesUsedInCode(code: string): Capability[] {
  const used = new Set<Capability>()
  for (const match of code.matchAll(LUMEN_CALL_PATTERN)) {
    const key = `${match[1]}.${match[2]}`
    const capability = METHOD_CAPABILITY[key]
    if (capability) used.add(capability)
  }
  return normalizeCapabilities([...used])
}

/** 声明式命令/贡献在代码里「双注册」缺失的启发式检查（02 §6.9）。 */
export function missingDoubleRegistration(manifest: PluginManifest, code: string): string[] {
  const issues: string[] = []
  for (const rule of manifest.contributes.lintRules ?? []) {
    if (!/lumen\s*\.\s*lint\s*\.\s*registerRule/.test(code) || !code.includes(rule.id)) {
      issues.push(`lintRules/${rule.id}: 清单已声明但代码没有 registerRule`)
    }
  }
  for (const recipe of manifest.contributes.recipes ?? []) {
    if (!/lumen\s*\.\s*ai\s*\.\s*registerRecipe/.test(code) || !code.includes(recipe.id)) {
      issues.push(`recipes/${recipe.id}: 清单已声明但代码没有 registerRecipe`)
    }
  }
  for (const hook of manifest.contributes.exportHooks ?? []) {
    const call = hook.kind === 'preflight' ? /lumen\s*\.\s*export\s*\.\s*onPreflight/ : /lumen\s*\.\s*export\s*\.\s*provideStaticAssets/
    if (!call.test(code)) issues.push(`exportHooks/${hook.id}: 清单已声明但代码没有注册钩子`)
  }
  return issues
}

/** 贡献 → 能力的缺失项（04 §4.3；返回空数组即通过）。 */
export function missingContributionCapabilities(manifest: PluginManifest): string[] {
  const issues: string[] = []
  const declared = new Set<string>(manifest.capabilities)
  const contributes = manifest.contributes as Record<string, unknown>
  for (const [key, capability] of Object.entries(CONTRIBUTION_CAPABILITY)) {
    const value = contributes[key]
    if (value === undefined) continue
    if (!declared.has(capability)) issues.push(`contributes.${key} 需要能力 ${capability}`)
  }
  return issues
}

/* ============================ 主校验 ============================ */

export interface CreatorValidationOk {
  ok: true
  proposal: CreatorProposal
  manifest: PluginManifest
  /** 归一后的能力集合（= 提案 = 清单）。 */
  capabilities: Capability[]
}

export interface CreatorValidationFail {
  ok: false
  error: CreatorValidationError
}

export type CreatorValidationResult = CreatorValidationOk | CreatorValidationFail

function zodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
}

/**
 * 校验原始模型输出 / 模板产物：zod → 路径/体积 → 清单 → 双向一致性 → 风险。
 * 成功返回**归一化**的提案（能力去重排序、files 原序保留），可直接写 draft。
 */
export function validateCreatorProposal(raw: unknown): CreatorValidationResult {
  try {
    return validateOrThrow(raw)
  } catch (error) {
    if (error instanceof CreatorValidationError) return { ok: false, error }
    return { ok: false, error: new CreatorValidationError('E-MAN-14', [`提案校验异常：${String(error)}`]) }
  }
}

function validateOrThrow(raw: unknown): CreatorValidationOk {
  // 体积/文件数先于 zod 判定：04 §4.3 要求「提案过大」统一 E-MAN-14，不因 zod 提前拒绝而变成 schema 错。
  const shape = raw as { files?: unknown; capabilities?: unknown } | null
  if (shape && typeof shape === 'object' && Array.isArray(shape.files)) {
    const files = shape.files
    if (files.length > CREATOR_LIMITS.filesMax) {
      fail('E-MAN-14', [`文件数 ${files.length} 超过上限 ${CREATOR_LIMITS.filesMax}`])
    }
    const seenPaths = new Set<string>()
    let total = 0
    let maxPerFile = 0
    let hasManifest = false
    for (const file of files) {
      const path = (file as { path?: unknown } | null)?.path
      if (typeof path === 'string') {
        if (seenPaths.has(path)) fail('E-MAN-14', [`重复文件路径：${path}`])
        seenPaths.add(path)
        if (!CREATOR_FILE_PATTERNS.some((pattern) => pattern.test(path))) {
          fail('E-MAN-14', [`路径不在白名单：${path}`])
        }
        if (path === MANIFEST_PATH) hasManifest = true
      }
      const content = (file as { content?: unknown } | null)?.content
      if (typeof content !== 'string') continue
      const bytes = bytesOf(content)
      total += bytes
      maxPerFile = Math.max(maxPerFile, bytes)
    }
    if (!hasManifest) fail('E-MAN-14', [`缺少 ${MANIFEST_PATH}`])
    if (total > CREATOR_LIMITS.totalBytes) {
      fail('E-MAN-14', [`提案总体积 ${total} 字节，超过 ${CREATOR_LIMITS.totalBytes}`])
    }
    if (maxPerFile > CREATOR_LIMITS.fileBytes) {
      fail('E-MAN-14', [`单文件最大 ${maxPerFile} 字节，超过 ${CREATOR_LIMITS.fileBytes}`])
    }
  }
  if (shape && typeof shape === 'object' && Array.isArray(shape.capabilities)) {
    const unique = new Set(shape.capabilities)
    if (unique.size > CREATOR_LIMITS.capabilitiesMax) {
      fail('E-MAN-14', [`capabilities 最多 ${CREATOR_LIMITS.capabilitiesMax} 项（当前 ${unique.size}）`])
    }
  }

  const parsed = creatorProposalSchema.safeParse(raw)
  if (!parsed.success) fail('E-MAN-13', zodIssues(parsed.error))
  const proposal = parsed.data

  /* --- 1. 文本约束（字符数按 code point；zod 的 max 留了余量，这里精确判） --- */
  const titleLength = charLength(proposal.title)
  const summaryLength = charLength(proposal.summary)
  const issues: string[] = []
  if (titleLength < CREATOR_LIMITS.titleMin || titleLength > CREATOR_LIMITS.titleMax) {
    issues.push(`title: ${CREATOR_LIMITS.titleMin}–${CREATOR_LIMITS.titleMax} 字符（当前 ${titleLength}）`)
  }
  if (isPureFileName(proposal.title)) issues.push('title: 不能是纯文件名')
  if (summaryLength < CREATOR_LIMITS.summaryMin || summaryLength > CREATOR_LIMITS.summaryMax) {
    issues.push(`summary: ${CREATOR_LIMITS.summaryMin}–${CREATOR_LIMITS.summaryMax} 字符（当前 ${summaryLength}）`)
  }
  if (proposal.trialNote !== undefined && charLength(proposal.trialNote) > CREATOR_LIMITS.trialNoteMax) {
    issues.push(`trialNote: ≤${CREATOR_LIMITS.trialNoteMax} 字符`)
  }
  if (issues.length > 0) fail('E-MAN-13', issues)

  /* --- 2. 文件路径/重复/体积（E-MAN-14） --- */
  const seen = new Set<string>()
  const fileIssues: string[] = []
  for (const file of proposal.files) {
    if (seen.has(file.path)) fileIssues.push(`重复文件路径：${file.path}`)
    seen.add(file.path)
    if (!CREATOR_FILE_PATTERNS.some((pattern) => pattern.test(file.path))) {
      fileIssues.push(`路径不在白名单：${file.path}`)
    }
  }
  if (!seen.has(MANIFEST_PATH)) fileIssues.push(`缺少 ${MANIFEST_PATH}`)
  const hasZh = seen.has('locales/zh.json')
  const hasEn = seen.has('locales/en.json')
  if (hasZh !== hasEn) fileIssues.push('locales/zh.json 与 locales/en.json 必须成对出现')
  const { total, perFile } = proposalBytes(proposal.files)
  if (total > CREATOR_LIMITS.totalBytes) {
    fileIssues.push(`提案总体积 ${total} 字节，超过 ${CREATOR_LIMITS.totalBytes}`)
  }
  if (perFile > CREATOR_LIMITS.fileBytes) {
    fileIssues.push(`单文件最大 ${perFile} 字节，超过 ${CREATOR_LIMITS.fileBytes}`)
  }
  if (fileIssues.length > 0) fail('E-MAN-14', fileIssues)

  /* --- 3. 清单（单一来源 parseManifest，错误码收窄到提案期） --- */
  const manifest = parseProposalManifest(proposal.files)

  /* --- 4. kind 与入口（E-MAN-13） --- */
  const kindIssues: string[] = []
  if (proposal.kind !== manifest.kind) kindIssues.push(`kind 与清单不一致（提案 ${proposal.kind} / 清单 ${manifest.kind}）`)
  const hasEntry = seen.has(ENTRY_PATH)
  if (proposal.kind === 'code') {
    if (!hasEntry) kindIssues.push('kind=code 必须包含 plugin.js')
    if (manifest.entry !== ENTRY_PATH) kindIssues.push(`清单 entry 必须是 ${ENTRY_PATH}`)
  } else {
    if (hasEntry) kindIssues.push('kind=declarative 不得包含 plugin.js')
    if (manifest.entry !== undefined) kindIssues.push('kind=declarative 不得声明 entry')
  }
  const contributes = manifest.contributes as Record<string, unknown>
  if (proposal.kind === 'declarative') {
    for (const key of CODE_ONLY_CONTRIBUTIONS) {
      if (contributes[key] !== undefined) kindIssues.push(`kind=declarative 不得声明 contributes.${key}`)
    }
  }
  if (kindIssues.length > 0) fail('E-MAN-13', kindIssues)

  /* --- 5. 能力集合相等（去重排序后完全相等） --- */
  const proposalCapabilities = normalizeCapabilities(proposal.capabilities as Capability[])
  const manifestCapabilities = normalizeCapabilities(manifest.capabilities)
  if (proposalCapabilities.length > CREATOR_LIMITS.capabilitiesMax) {
    fail('E-MAN-14', [`capabilities 最多 ${CREATOR_LIMITS.capabilitiesMax} 项（当前 ${proposalCapabilities.length}）`])
  }
  const capIssues: string[] = []
  const proposalSet = new Set(proposalCapabilities)
  const manifestSet = new Set(manifestCapabilities)
  const missingInProposal = manifestCapabilities.filter((capability) => !proposalSet.has(capability))
  const extraInProposal = proposalCapabilities.filter((capability) => !manifestSet.has(capability))
  if (missingInProposal.length > 0) capIssues.push(`提案缺少清单能力：${missingInProposal.join(', ')}`)
  if (extraInProposal.length > 0) capIssues.push(`提案多出清单没有的能力：${extraInProposal.join(', ')}`)

  /* --- 6. 贡献 → 能力 --- */
  capIssues.push(...missingContributionCapabilities(manifest))

  /* --- 7. 能力 → 代码（code 时静态扫 lumen. 命名空间） --- */
  const entryFile = proposal.files.find((file) => file.path === ENTRY_PATH)
  if (proposal.kind === 'code' && entryFile) {
    const used = capabilitiesUsedInCode(entryFile.content)
    const undeclared = used.filter((capability) => !manifestSet.has(capability))
    if (undeclared.length > 0) {
      capIssues.push(`代码使用了未声明的能力：${undeclared.join(', ')}`)
    }
    capIssues.push(...missingDoubleRegistration(manifest, entryFile.content))
    const forbidden = scanSource(entryFile.content)
    if (forbidden.length > 0) {
      fail('E-MAN-14', forbidden.slice(0, 4).map((hit) => `plugin.js 命中禁用 API：${hit.name}`))
    }
  }

  /* --- 8. settings 双注册（02 §5.3，E-MAN-09） --- */
  const declaresSettingsInCode = entryFile ? /lumen\s*\.\s*settings\s*\.\s*declare/.test(entryFile.content) : false
  if (declaresSettingsInCode && contributes.settings !== undefined) {
    fail('E-MAN-09', ['settings.declare 与 contributes.settings 不能同时出现'])
  }

  if (capIssues.length > 0) fail('E-MAN-13', [...new Set(capIssues)])

  /* --- 9. 风险与能力一致（E-MAN-13） --- */
  const sensitive = sensitiveCapabilitiesOf(proposalCapabilities)
  const riskIssues: string[] = []
  if (sensitive.length >= 1 && proposal.risk === 'low') {
    riskIssues.push(`含敏感能力 ${sensitive.join(', ')} 时 risk 不得为 low`)
  }
  if (sensitive.length >= 3 && proposal.risk !== 'high') {
    riskIssues.push(`含 ${sensitive.length} 项敏感能力时 risk 必须为 high`)
  }
  if (riskIssues.length > 0) fail('E-MAN-13', riskIssues)

  /* --- 10. 输出归一化提案（能力按冻结表排序） --- */
  const normalized: CreatorProposal = {
    title: proposal.title.trim(),
    summary: proposal.summary.trim(),
    kind: proposal.kind,
    risk: proposal.risk,
    capabilities: proposalCapabilities,
    files: proposal.files.map((file) => ({ path: file.path, content: file.content })),
    changes: proposal.changes.map((change) => ({
      surface: change.surface,
      detail: change.detail.trim(),
    })),
    ...(proposal.trialNote !== undefined ? { trialNote: proposal.trialNote.trim() } : {}),
  }
  return { ok: true, proposal: normalized, manifest, capabilities: proposalCapabilities }
}

/** 抛出型入口（模板/直连路径用）：失败抛 `CreatorValidationError`。 */
export function assertValidProposal(raw: unknown): CreatorProposal {
  const result = validateCreatorProposal(raw)
  if (!result.ok) throw result.error
  return result.proposal
}

/* ============================ 派生 ============================ */

/** `proposalDigest = sha256(canonical(proposal))`（04 §5.1；复用 plugins/package）。 */
export async function proposalDigest(proposal: CreatorProposal): Promise<string> {
  return sha256Hex(canonicalJson(proposal))
}

/** 提案 id / frameId：`draft/<draftId>@<revision>`（04 §5.1 / 02 §11.5.1）。 */
export function proposalIdOf(draftId: string, revision: number): string {
  return `draft/${draftId}@${revision}`
}

/** 文件树排序：清单 → 入口 → 图标 → 语言包 → 资产（04 §5.2 的展示顺序）。 */
export function sortCreatorFiles(files: { path: string }[]): { path: string; content: string }[] {
  const order = (path: string): number => {
    if (path === MANIFEST_PATH) return 0
    if (path === ENTRY_PATH) return 1
    if (path === 'icon.svg') return 2
    if (path.startsWith('locales/')) return 3
    return 4
  }
  return [...(files as { path: string; content: string }[])].sort(
    (a, b) => order(a.path) - order(b.path) || a.path.localeCompare(b.path),
  )
}

/** 禁用的 API 清单（语法预检与 UI 提示共用；02 §4.3 / 03 §6）。 */
export const FORBIDDEN_CODE_PATTERNS = FORBIDDEN_SOURCE_PATTERNS
