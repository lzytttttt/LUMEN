/**
 * plugins/capabilities.ts —— 15 项能力表、敏感判定与授权差集（02 §5.1 / 03 §3）。
 *
 * 授权模型：安装时授权集写进记录 `grants`；未授权的敏感能力不放行安装（仍可安装但该能力 denied）。
 * 网关每次调用按「帧 → 记录 → grants」实时判定，**不缓存**（02 §5.1）。
 */
import {
  CAPABILITY_IDS,
  SENSITIVE_CAPABILITIES,
  type Capability,
  type SensitiveCapability,
} from './types'

export interface CapabilityMeta {
  id: Capability
  sensitive: boolean
  /** `plugin.*` 命名空间的 i18n key（shell-ui 建词；文案见 03 §3.1）。 */
  labelKey: string
  /** 敏感能力的展开说明 key；非敏感为空串。 */
  detailKey: string
}

function camelOf(capability: string): string {
  return capability.replace(/[:\-]([a-z])/g, (_, char: string) => char.toUpperCase())
}

/** 15 项能力全集（顺序与 02 §5.1 表一致）。 */
export const CAPABILITIES: readonly CapabilityMeta[] = CAPABILITY_IDS.map((id) => {
  const sensitive = (SENSITIVE_CAPABILITIES as readonly string[]).includes(id)
  const name = camelOf(id)
  return {
    id,
    sensitive,
    labelKey: `plugin.capability.${name}`,
    detailKey: sensitive ? `plugin.capabilityDetail.${name}` : '',
  }
})

/** id → 元数据（O(1)）。 */
export const CAPABILITY_META: Record<Capability, CapabilityMeta> = Object.fromEntries(
  CAPABILITIES.map((meta) => [meta.id, meta]),
) as Record<Capability, CapabilityMeta>

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITY_IDS as readonly string[]).includes(value)
}

export function isSensitiveCapability(value: unknown): value is SensitiveCapability {
  return typeof value === 'string' && (SENSITIVE_CAPABILITIES as readonly string[]).includes(value)
}

/** 去重 + 按 02 §5.1 表顺序稳定排序（权限卡与差集比较用）。 */
export function normalizeCapabilities(value: readonly unknown[]): Capability[] {
  const set = new Set<Capability>()
  for (const item of value) if (isCapability(item)) set.add(item)
  return CAPABILITY_IDS.filter((id) => set.has(id))
}

/** 非敏感能力默认全授（03 §3.3 规则 1）。 */
export function defaultGrants(capabilities: readonly Capability[]): Capability[] {
  return normalizeCapabilities(capabilities.filter((id) => !isSensitiveCapability(id)))
}

/** 建议授权 = 非敏感全授 + 已由旧版授予的敏感项（升级保持既有授权）。 */
export function suggestGrants(capabilities: readonly Capability[], previousGrants: readonly Capability[] = []): Capability[] {
  const previous = new Set(previousGrants)
  return normalizeCapabilities(
    capabilities.filter((id) => !isSensitiveCapability(id) || previous.has(id)),
  )
}

export interface GrantDiff {
  added: Capability[]
  removed: Capability[]
  unchanged: Capability[]
}

/** 新旧能力/授权差集（02 §5.1 升级重新授权；03 §3.4）。 */
export function diffGrants(previous: readonly Capability[], next: readonly Capability[]): GrantDiff {
  const before = new Set(previous)
  const after = new Set(next)
  const added: Capability[] = []
  const removed: Capability[] = []
  const unchanged: Capability[] = []
  for (const id of normalizeCapabilities([...previous, ...next])) {
    if (after.has(id) && !before.has(id)) added.push(id)
    else if (before.has(id) && !after.has(id)) removed.push(id)
    else unchanged.push(id)
  }
  return { added, removed, unchanged }
}

/** 敏感能力子集（按表顺序）。 */
export function sensitiveOf(capabilities: readonly Capability[]): Capability[] {
  const set = new Set(capabilities)
  return normalizeCapabilities(CAPABILITY_IDS.filter((id) => set.has(id) && isSensitiveCapability(id)))
}

/* ------------------------------ 贡献 → 能力（02 §6.1 / 04 §4.3） ------------------------------ */

export type ContributionKey =
  | 'themes'
  | 'library'
  | 'i18n'
  | 'settings'
  | 'commands'
  | 'keymap'
  | 'layoutPresets'
  | 'slots'
  | 'lintRules'
  | 'recipes'
  | 'exportHooks'

/** 11 类贡献 → 所需能力（`settings` 声明式只需 storage；代码式 iframe 另需 ui:slot，由清单自行声明）。 */
export const CONTRIBUTION_CAPABILITY: Record<ContributionKey, Capability> = {
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

/** 行为体是代码的三类贡献：只允许 `kind:'code'`（02 §6.1）。 */
export const CODE_ONLY_CONTRIBUTIONS: readonly ContributionKey[] = ['lintRules', 'recipes', 'exportHooks']

/** 声明式 8 action → 额外能力（02 §6.6 / 04 §4.3）。 */
export function actionCapabilities(kind: string): Capability[] {
  switch (kind) {
    case 'setTheme':
      return ['theme:contribute']
    case 'applyLayoutPreset':
      return ['ui:layout']
    case 'insertLibrarySvg':
      return ['deck:write', 'library:contribute']
    case 'insertTextBlocks':
      return ['deck:write']
    case 'openPluginPanel':
      return ['ui:slot']
    case 'openSettings':
      return []
    case 'runExportPreflight':
      return ['export:hook']
    case 'toast':
      return []
    default:
      return []
  }
}
