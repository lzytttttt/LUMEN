/**
 * plugins/types.ts —— 插件系统 ABI v1 的契约类型（唯一来源：plan/v0.4.0/02 §2/§5/§6/§7）。
 *
 * 纪律：本文件只放类型与纯常量，不 import 任何运行时模块（除 schema/ai 的类型）。
 * 命名一律以 plan/v0.4.0/00 §7 冻结表为准，**不得改名**。
 */
import type {
  Block,
  ColorToken,
  Deck,
  DeckFile,
  Slide,
  TextVariant,
  Theme,
  ThemeColors,
  ThreeDescriptor,
} from '@/schema/deck'
import type { Lang } from '@/i18n/types'
import type { RecipeContent, RecipeSlotSpec } from '@/ai/types'
import type { PluginLayoutOverride } from '@/state/settingsStore'

/** 设置段类型单一来源 = `src/state/settingsStore.ts`（Lead 域，02 §7.4）。 */
export type {
  PluginCreatorSettings,
  PluginLayoutOverride,
  PluginSettings,
} from '@/state/settingsStore'

/* ============================ 基础 ============================ */

/** 可结构化克隆的纯数据（≤64KB 单条，02 §4.4）。 */
export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue }

export interface LocalizedText {
  zh: string
  en: string
}

export type PluginKind = 'declarative' | 'code'

/* ============================ 15 项能力（00 §7.2 冻结） ============================ */

export const CAPABILITY_IDS = [
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
] as const

export type Capability = (typeof CAPABILITY_IDS)[number]

/** 4 项敏感能力（02 §5.1）：安装时默认不勾选、需二次确认。 */
export const SENSITIVE_CAPABILITIES = ['ai:invoke', 'deck:write', 'asset:write', 'export:hook'] as const

export type SensitiveCapability = (typeof SENSITIVE_CAPABILITIES)[number]

/** 创造模式自限上限（04 §4.3：capabilities ≤6）。 */
export const CREATOR_MAX_CAPABILITIES = 6

/* ============================ 9 个插槽（00 §7.3 冻结） ============================ */

export const SLOT_IDS = [
  'workspace.topbar',
  'workspace.rail.footer',
  'workspace.inspector.tab',
  'workspace.dock',
  'workspace.overlay',
  'dialog',
  'settings.page',
  'play.overlay',
  'command.palette',
] as const

export type SlotId = (typeof SLOT_IDS)[number]

export type SlotKind = 'inline' | 'panel' | 'overlay' | 'modal'

/** 插槽允许的形态（02 §6.10）。 */
export const SLOT_KINDS: Record<SlotId, readonly SlotKind[]> = {
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

/** 宿主原生渲染（无 iframe）的 3 个插槽。 */
export const HOST_RENDERED_SLOTS: readonly SlotId[] = ['workspace.topbar', 'workspace.rail.footer', 'command.palette']

/* ============================ 状态机（02 §3.2） ============================ */

export type PluginState = 'installed' | 'enabled' | 'disabled' | 'quarantined' | 'draft'

export type InstallSource = 'builtin' | 'file' | 'url'

export type TrustLevel = 'builtin' | 'local'

/* ============================ 错误码（02 §5.5，45 个，只增不删） ============================ */

export const PLUGIN_ERROR_CODES = [
  'E-PKG-01',
  'E-PKG-02',
  'E-PKG-03',
  'E-PKG-04',
  'E-PKG-05',
  'E-PKG-06',
  'E-MAN-01',
  'E-MAN-02',
  'E-MAN-03',
  'E-MAN-04',
  'E-MAN-05',
  'E-MAN-06',
  'E-MAN-07',
  'E-MAN-08',
  'E-MAN-09',
  'E-MAN-10',
  'E-MAN-11',
  'E-MAN-12',
  'E-MAN-13',
  'E-MAN-14',
  'E-PERM-01',
  'E-PERM-02',
  'E-PERM-03',
  'E-STORE-01',
  'E-STORE-02',
  'E-STORE-03',
  'E-HOST-01',
  'E-HOST-02',
  'E-HOST-03',
  'E-ABI-01',
  'E-ABI-02',
  'E-ABI-03',
  'E-ABI-04',
  'E-ABI-05',
  'E-CAP-01',
  'E-CAP-02',
  'E-RUN-01',
  'E-RUN-02',
  'E-QUOTA-01',
  'E-QUOTA-02',
  'E-QUOTA-03',
  'E-QUOTA-04',
  'E-NET-01',
  'E-SAFE-01',
  'E-AUDIT-01',
] as const

export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number]

/** 可回喂给创造模式模型的错误码白名单（02 §5.5 脚注）。 */
export const FEEDBACK_ERROR_CODES: readonly PluginErrorCode[] = [
  ...PLUGIN_ERROR_CODES.filter((code) => /^E-(PKG|MAN|ABI|CAP|RUN|QUOTA)-/.test(code)),
]

/* ============================ 清单（00 §7.1 / 02 §2.3） ============================ */

export interface PluginManifest {
  id: string
  name: LocalizedText
  version: string
  apiVersion: string
  minAppVersion: string
  kind: PluginKind
  entry?: string
  trust?: 'builtin'
  author: { name: string; url?: string }
  description: LocalizedText
  license: string
  icon?: string
  capabilities: Capability[]
  contributes: Contributions
}

export interface Contributions {
  themes?: ThemeContribution[]
  library?: LibraryContribution[]
  i18n?: LocalePackContribution[]
  settings?: SettingsPageContribution
  commands?: DeclarativeCommand[]
  keymap?: KeymapBinding[]
  layoutPresets?: LayoutPresetContribution[]
  slots?: SlotContribution[]
  lintRules?: LintRuleDeclaration[]
  recipes?: RecipeDeclaration[]
  exportHooks?: ExportHookDeclaration[]
}

/** contributions 内各数组上限（02 §2.3 / §6.1）。 */
export const CONTRIBUTION_LIMITS = {
  themes: 6,
  library: 32,
  i18n: 1,
  settings: 1,
  commands: 24,
  keymap: 24,
  layoutPresets: 4,
  slots: 6,
  /** 带 iframe 的 slots 上限（02 §2.3）。 */
  slotFrames: 2,
  lintRules: 8,
  recipes: 6,
  exportHooks: 2,
} as const

/* ---------------------------- 主题贡献（02 §6.2） ---------------------------- */

export interface ThemeContribution {
  id: string
  name: LocalizedText
  vibe?: LocalizedText
  colors: ThemeColors
  font?: Partial<{ body: string; display: string; mono: string }>
  typeScale?: number
  radius?: number
  motion?: { ease: string; ms: number }
  texture?: { kind: 'none' | 'grain' | 'grid' | 'scan' | 'dots'; opacity: number }
  glow?: number
  elevation?: 'flat' | 'raised' | 'layered'
}

/* ---------------------------- 素材贡献（02 §6.3） ---------------------------- */

export type LibraryCategory = 'geometric' | 'line' | 'iso' | 'chart' | 'brand'

export interface LibraryContribution {
  id: string
  name: LocalizedText
  category: LibraryCategory
  viewBox: [number, number, number, number]
  source: string
}

/* ---------------------------- 语言包贡献（02 §6.4 / §8.2） ---------------------------- */

export interface LocalePackContribution {
  zh: Record<string, string>
  en: Record<string, string>
}

/* ---------------------------- 设置页贡献（02 §6.5） ---------------------------- */

export type SettingsField =
  | { key: string; type: 'text'; label: LocalizedText; placeholder?: string; maxLength?: number }
  | { key: string; type: 'textarea'; label: LocalizedText; maxLength?: number }
  | { key: string; type: 'switch'; label: LocalizedText; default?: boolean }
  | { key: string; type: 'number'; label: LocalizedText; min?: number; max?: number; step?: number; default?: number }
  | { key: string; type: 'slider'; label: LocalizedText; min: number; max: number; step?: number; default?: number }
  | {
      key: string
      type: 'select'
      label: LocalizedText
      options: { value: string; label: LocalizedText }[]
    }

export interface SettingsPageContribution {
  id: string
  title: LocalizedText
  fields: SettingsField[]
}

/* ---------------------------- 声明式命令（02 §6.6，封闭 8 项） ---------------------------- */

export type DeclarativeCommandAction =
  | { kind: 'setTheme'; themeId: string }
  | { kind: 'applyLayoutPreset'; presetId: string }
  | { kind: 'insertLibrarySvg'; libraryId: string; slideId?: string }
  | {
      kind: 'insertTextBlocks'
      blocks: Array<{ text: string; variant?: TextVariant; x?: number; y?: number; w?: number; h?: number }>
    }
  | { kind: 'openPluginPanel'; slot: SlotId; contributionId: string }
  | { kind: 'openSettings' }
  | { kind: 'runExportPreflight' }
  | { kind: 'toast'; message: LocalizedText }

export const DECLARATIVE_ACTIONS = [
  'setTheme',
  'applyLayoutPreset',
  'insertLibrarySvg',
  'insertTextBlocks',
  'openPluginPanel',
  'openSettings',
  'runExportPreflight',
  'toast',
] as const

export interface DeclarativeCommand {
  id: string
  title: LocalizedText
  category: 'plugin'
  icon?: string
  action: DeclarativeCommandAction
}

/* ---------------------------- 键位（02 §6.7） ---------------------------- */

export interface KeymapBinding {
  combo: string
  commandId: string
}

/* ---------------------------- 布局预设（02 §6.8） ---------------------------- */

export type LayoutPresetApply = PluginLayoutOverride

export interface LayoutPresetContribution {
  id: string
  name: LocalizedText
  apply: PluginLayoutOverride
}

export type LayoutPresetId = string

/** 当前布局快照（撤销布局预设时还原）。 */
export interface LayoutSnapshot {
  railWidth: number
  panelWidth: number
  rightMode: 'inspector' | 'composer'
  leftTab: 'slides' | 'outline'
  dockHeight: number
  density: 'comfortable' | 'compact'
}

/* ---------------------------- 插槽贡献（02 §6.10） ---------------------------- */

export interface SlotOpenRef {
  slot: SlotId
  contributionId: string
  kind?: 'panel' | 'modal'
}

export interface SlotContribution {
  id: string
  slot: SlotId
  title: LocalizedText
  icon?: string
  kind: SlotKind
  size?: { w?: number; h?: number }
  order?: number
  open?: SlotOpenRef
}

/* ---------------------------- 代码式贡献声明（02 §6.9） ---------------------------- */

export interface LintRuleDeclaration {
  id: string
  title: LocalizedText
  severity: 'info' | 'warn' | 'error'
  description?: LocalizedText
}

export interface RecipeDeclaration {
  id: string
  namespace: string
  title: LocalizedText
  slots: RecipeSlotSpec[]
  preview?: string
}

export interface ExportHookDeclaration {
  id: string
  title: LocalizedText
  kind: 'preflight' | 'assets'
  maxBytes?: number
}

/* ============================ 信封（02 §2.1） ============================ */

export interface PluginEnvelope {
  format: 'lumen-plugin'
  formatVersion: 1
  createdAt: number
  integrity: string
  manifest: PluginManifest
  files: Record<string, string>
}

/** 信封里参与 integrity 的 payload（不含 integrity 自身，02 §2.4 规则 6）。 */
export interface PluginEnvelopePayload {
  format: 'lumen-plugin'
  formatVersion: 1
  createdAt: number
  manifest: PluginManifest
  files: Record<string, string>
}

/* ============================ 安装记录 / 摘要（02 §7.3） ============================ */

export interface InstalledPluginRecord {
  manifest: PluginManifest
  integrity: string
  files: Record<string, string>
  /** 信封 createdAt（02 §2.4 的 integrity payload 参与字段；启用时重算必需）。 */
  createdAt: number
  state: Exclude<PluginState, 'draft'>
  trust: TrustLevel
  installSource: InstallSource
  grants: Capability[]
  denied: Capability[]
  installedAt: number
  updatedAt: number
  failureCount: number
  lastError: { code: string; at: number } | null
  revision: number
  sourceUrl?: string
}

/** 注册表 `__meta` 锚点（02 §7.2）。 */
export interface PluginRegistryMeta {
  schemaVersion: 1
  updatedAt: number
}

/** 插件页/管理器展示用摘要（public 门面）。 */
export interface PluginSummary {
  id: string
  name: LocalizedText
  version: string
  kind: PluginKind
  description: LocalizedText
  author: { name: string; url?: string }
  license: string
  trust: TrustLevel
  installSource: InstallSource
  state: PluginState
  enabled: boolean
  failureCount: number
  lastError: { code: string; at: number } | null
  capabilities: Capability[]
  grants: Capability[]
  denied: Capability[]
  counts: {
    themes: number
    library: number
    commands: number
    keymap: number
    layoutPresets: number
    slots: number
    lintRules: number
    recipes: number
    exportHooks: number
  }
  installedAt: number
  updatedAt: number
  sourceUrl?: string
}

/* ============================ 设置段（02 §7.4） ============================ */
/* `PluginSettings` / `PluginCreatorSettings` / `PluginLayoutOverride` 由 Lead 在
   `src/state/settingsStore.ts` 定义，本文件在文件头做类型再导出（单一来源）。 */

/** 诊断 JSON 的 plugins 段（8 字段冻结，02 §7.7 / 03 §5.2）。 */
export interface PluginDiagnostics {
  installed: string[]
  enabled: string[]
  disabled: string[]
  quarantined: string[]
  errorCounts: Record<string, number>
  storageMode: 'idb' | 'memory'
  safeMode: boolean
  auditCount: number
}

/* ============================ 审计（02 §7.7） ============================ */

export interface AuditEntry {
  seq: number
  at: number
  action: string
  actor: 'user' | 'system' | 'plugin' | 'creator'
  pluginId?: string
  draftId?: string
  result: 'ok' | 'denied' | 'error' | 'cancelled'
  code?: PluginErrorCode
  detail?: string
}

export const AUDIT_ACTIONS = [
  'plugin.install',
  'plugin.enable',
  'plugin.disable',
  'plugin.uninstall',
  'plugin.denied',
  'plugin.error',
  'plugin.quarantine',
  'plugin.retry',
  'plugin.permission-grant',
  'plugin.permission-revoke',
  'plugin.frame-rejected',
  'plugin.safe-mode-on',
  'plugin.reset',
  'creator.propose',
  'creator.trial',
  'creator.keep',
  'creator.revert',
  'creator.export',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

/** 审计环容量（02 §4.5：200 条）。 */
export const AUDIT_LIMIT = 200

export const AUDIT_DETAIL_MAX = 200

/* ============================ 安装 / 预览（02 §3.1） ============================ */

export type InstallInputSource = 'file' | 'url' | 'builtin'

export interface InstallInput {
  /** 文件安装。 */
  file?: File
  /** 文本安装（已读出的 JSON / 测试夹具）。 */
  text?: string
  /** URL 安装（https only，用户二次确认后调用）。 */
  url?: string
  /** 来源标记；缺省按输入推断。 */
  source?: InstallInputSource
}

export interface PluginPackagePreview {
  manifest: PluginManifest
  integrity: string
  files: Record<string, string>
  /** 信封 createdAt（integrity 重算与启用校验用）。 */
  createdAt: number
  trust: TrustLevel
  installSource: InstallInputSource
  /** 信封 UTF-8 字节数（体积卡展示用）。 */
  bytes: number
  /** 非致命告警（trust 剥离 / 升级降级 / 图标净化等）。 */
  warnings: string[]
  /** 建议默认授权（非敏感全授；敏感项不在内，等待用户勾选）。 */
  suggestedGrants: Capability[]
  sensitive: Capability[]
  /** 与已安装版本的差集（首次安装 = 全部）。 */
  addedCapabilities: Capability[]
  removedCapabilities: Capability[]
  /** 同名 id 的既有记录（升级/重装场景）。 */
  existing: InstalledPluginRecord | null
  sourceUrl?: string
}

export interface InstallOptions {
  grants?: Capability[]
  denied?: Capability[]
  /** 安装后是否启用（默认 true；builtin 样例默认 false）。 */
  enable?: boolean
  /** 卸载时是否保留插件数据（仅更新/重装语义用）。 */
  keepData?: boolean
}

export interface InstallOutcome {
  record: InstalledPluginRecord
  enabled: boolean
  warnings: string[]
}

export interface UninstallOptions {
  keepData?: boolean
}

/* ============================ 创造模式草稿（02 §11.5 / 04 §5） ============================ */

export interface CreatorProposalChange {
  surface: string
  detail: string
}

/** 00 §7.6 冻结（04 §5.1 逐字段约束）。 */
export interface CreatorProposal {
  title: string
  summary: string
  kind: PluginKind
  risk: 'low' | 'medium' | 'high'
  capabilities: Capability[]
  files: { path: string; content: string }[]
  changes: CreatorProposalChange[]
  trialNote?: string
}

export type PluginDraftStatus =
  | 'proposal-ready'
  | 'trialing'
  | 'applied'
  | 'failed'
  | 'saved'
  | 'reverted'
  | 'interrupted'

export interface PluginTrial {
  revision: number
  at: number
  outcome: 'trialing' | 'kept' | 'reverted' | 'interrupted' | 'failed'
  /** 快照字段（04 §5.4）：撤销时按这些还原 / 回滚。 */
  deckRevisionBefore?: number
  activeSlideId?: string | null
  layout?: LayoutSnapshot
  trialUndoCount?: number
}

/** `PluginDraft`（02 §11.5 冻结；04 只填不扩名）。 */
export interface PluginDraft {
  draftId: string
  /** `draft/<draftId>`（虚拟根）。 */
  root: string
  revision: number
  status: PluginDraftStatus
  proposal: CreatorProposal
  /** 文件树；含 `.lumen-plugin.json`（打包时剥离提升为信封 manifest）。 */
  files: { path: string; content: string }[]
  /** 由 files 派生的清单（虚 registry / 建帧用）。 */
  manifest: PluginManifest
  trials: PluginTrial[]
  /** 试跑授权（04 §7.1；`deck:write` 默认关）。 */
  grantedCapabilities: Capability[]
  proposalDigest: string
  /** 触发这次提案的一句话（≤400；不进 history）。 */
  request?: string
  createdAt: number
  updatedAt: number
}

/* ============================ 代码式插件 ABI 数据形状（02 §5.3） ============================ */

export interface LumenMeta {
  pluginId: string
  pluginVersion: string
  apiVersion: '1.0'
  locale: Lang
  capabilities: Capability[]
  appVersion: string
}

export interface RenderCtx {
  width: number
  height: number
  themeId: string
  theme: { id: string; name: LocalizedText; colors: Record<string, string> }
  locale: Lang
  signal: AbortSignal
}

export interface DeckSnapshot {
  deckId: string
  title: string
  lang: Lang
  themeId: string
  revision: number
  slides: Array<{
    id: string
    name?: string
    recipe?: string
    blockCount: number
    textChars: number
    readingSeconds: number
  }>
  activeSlideId: string | null
  lint: { error: number; warn: number; info: number }
}

export interface SlideSnapshot {
  id: string
  name?: string
  recipe?: string
  background: Slide['background']
  transition: Slide['transition']
  blockCount: number
  textChars: number
  readingSeconds: number
  blocks: Array<{ id: string; type: Block['type']; x: number; y: number; w: number; h: number }>
}

export interface PreflightResult {
  level: 'info' | 'warn'
  message: LocalizedText
  slideId?: string
  fix?: { commandId: string }
}

export interface LintFinding {
  slideId?: string
  blockId?: string
  message: LocalizedText
  params?: Record<string, string | number>
}

export interface ReadonlySlideMeta {
  id: string
  blocks: Array<{
    id: string
    type: Block['type']
    x: number
    y: number
    w: number
    h: number
    presetId?: string
    textChars?: number
    sourceDigest?: string
  }>
}

export interface LintRuleCtx {
  deck: DeckSnapshot
  slides: ReadonlySlideMeta[]
}

export interface StaticAsset {
  path: string
  mime: string
  dataUrl: string
}

export interface LumenEventPayloads {
  'app:ready': { appVersion: string; locale: Lang }
  'deck:open': { deckId: string; title: string; slideCount: number }
  'deck:change': { revision: number; reason: 'deck' | 'slide' | 'theme' }
  'slide:change': { slideId: string; index: number }
  'theme:change': { themeId: string }
  'mode:change': { mode: 'edit' | 'preview' | 'play' | 'forge' }
  'play:start': { slideId: string; index: number }
  'play:stop': { slideId: string }
  'export:before': { scope: 'all' | 'current' }
  'export:after': { bytes: number; ok: boolean }
}

export type LumenEventName = keyof LumenEventPayloads

/** 插件可插入的 6 种内置块（02 §5.3，gateway 用 zod 再校验）。 */
export type PluginBlockInput =
  | {
      type: 'text'
      text: string
      variant?: TextVariant
      x?: number
      y?: number
      w?: number
      h?: number
      color?: ColorToken
      align?: 'left' | 'center' | 'right'
      name?: string
    }
  | {
      type: 'shape'
      kind?: 'rect' | 'ellipse' | 'line' | 'triangle' | 'rule'
      fill?: ColorToken
      stroke?: ColorToken
      strokeWidth?: number
      radius?: number
      x?: number
      y?: number
      w?: number
      h?: number
      name?: string
    }
  | { type: 'image'; assetId: string; fit?: 'cover' | 'contain'; radius?: number; caption?: string; alt?: string; x?: number; y?: number; w?: number; h?: number; name?: string }
  | { type: 'svg'; source: string; viewBox?: [number, number, number, number]; animate?: 'none' | 'float' | 'pulse' | 'spinSlow' | 'draw'; x?: number; y?: number; w?: number; h?: number; name?: string }
  | { type: 'three'; descriptor: ThreeDescriptor; interactive?: boolean; bg?: 'transparent' | 'theme' | 'void'; x?: number; y?: number; w?: number; h?: number; name?: string }
  | { type: 'html'; html: string; css?: string; x?: number; y?: number; w?: number; h?: number; name?: string }

/** 插件主题注册后的宿主视图（`THEMES` 副本中的一项）。 */
export interface RegisteredTheme {
  theme: Theme
  pluginId: string
}

/** 素材库注册项（与 studio `SvgLibraryItem` 同形，避免跨域 import）。 */
export interface RegisteredLibraryItem {
  id: string
  name: LocalizedText
  category: LibraryCategory
  viewBox: [number, number, number, number]
  source: string
  pluginId: string
}

/* ============================ 帧协议（02 §4.4） ============================ */

export const FRAME_PROTOCOL_VERSION = 1
export const FRAME_MESSAGE_MAX_BYTES = 64 * 1024
export const FRAME_MESSAGE_MAX_DEPTH = 8
export const FRAME_REQUEST_TIMEOUT_MS = 8000
export const FRAME_INFLIGHT_MAX = 32
export const FRAME_READY_TIMEOUT_MS = 2500
export const FRAME_HEARTBEAT_MS = 4000
export const FRAME_HEARTBEAT_MISS_LIMIT = 3
export const FRAME_GLOBAL_LIMIT = 8
export const FRAME_PER_PLUGIN_LIMIT = 2
export const FRAME_DRAFT_LIMIT = 1
export const FRAME_RATE_PER_SECOND = 120
export const FRAME_RATE_BURST = 240
export const FRAME_THROUGHPUT_BYTES_PER_SECOND = 256 * 1024
export const FRAME_REJECT_LIMIT_PER_MINUTE = 10

export interface FrameMessage {
  v: 1
  id: string
  type: 'req' | 'res' | 'evt' | 'err'
  pluginId: string
  frameNonce: string
  method?: string
  payload?: unknown
  code?: PluginErrorCode
  message?: string
}

export interface FrameBootPayload {
  pluginId: string
  pluginVersion: string
  apiVersion: '1.0'
  appVersion: string
  locale: Lang
  capabilities: Capability[]
  frameNonce: string
  entryPath: string | null
  tokens: Record<string, string>
}

/** 插件键位（声明式/代码式清单里的 keymap，宿主补命令前缀）。 */
export interface PluginKeymapBinding {
  combo: string
  commandId: string
  pluginId: string
  pluginName: string
}

/** 键位冲突（03 §3.1 / 02 §6.7）。 */
export interface KeymapConflictInfo {
  combo: string
  owner: 'host' | string
  pluginId: string
  pluginName: string
}

/* ============================ 门面展示用（public.ts） ============================ */

export interface PluginSlotItem {
  /** 宿主注册 id：`${pluginId}:${contributionId}`。 */
  id: string
  pluginId: string
  /** 插件显示名（zh；UI 用 i18n 再取 en）。 */
  pluginName?: string
  slot: SlotId
  kind: SlotKind
  title: LocalizedText
  icon?: string
  order: number
  open?: SlotOpenRef
  size?: { w?: number; h?: number }
}

export interface PluginCommandItem {
  id: string
  pluginId: string
  title: string
  subtitle?: string
  run: (args?: JSONValue) => void | Promise<void>
}

export interface PluginSettingsEntry {
  pluginId: string
  pageId: string
  title: LocalizedText
  /** `declarative`：宿主原生渲染 fields；`frame`：代码式 iframe 设置页。 */
  form: 'declarative' | 'frame'
  fields?: SettingsField[]
}

export interface PluginFrameDescriptor {
  pluginId: string
  slot: SlotId
  contributionId: string
  title: string
  frameId: string
  revision: number
  nonce: string
  entryPath: string | null
  kind: PluginKind
}

export interface PluginInstallEvents {
  type: 'lumen:plugin-install'
  detail: { file: File }
}

/* ============================ 类型工具（实现文件共用） ============================ */

export type PluginFileMap = Record<string, string>

export type DocDeck = Deck
export type DocDeckFile = DeckFile
export type DocTheme = Theme
export type DocRecipeContent = RecipeContent
