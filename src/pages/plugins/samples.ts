/**
 * src/pages/plugins/samples.ts —— 插件页的三款内置样例元数据（05 §1.4/§7 的静态事实）。
 *
 * 体积 / 版本**不再手写**：`pack-sizes.json` 由 `scripts/pack-plugins.mjs` 生成（prebuild 会跑），
 * 页面据此向上取整显示 KB，`tests/unit/plugins-sample-pack.test.ts` 会与真实信封对拍。
 * 页面不 fetch 任何清单：离线可用、零请求（07 §1）。
 */
import packSizesJson from './pack-sizes.json'

export type SampleId = 'brandguard' | 'chartkit' | 'focusdesk'

export const SAMPLE_IDS: SampleId[] = ['brandguard', 'chartkit', 'focusdesk']

interface PackSizeEntry {
  version: string
  envelopeBytes: number
  entryBytes: number
  integrity: string
}

const PACK_SIZES = (packSizesJson as unknown as { samples: Record<SampleId, PackSizeEntry> }).samples

/** 发布包体积（KB，向上取整）：唯一来源是打包产物的 envelopeBytes。 */
export function sampleSizeKb(id: SampleId): number {
  return Math.ceil(PACK_SIZES[id].envelopeBytes / 1024)
}

export interface SampleEntry {
  id: SampleId
  /** manifest id（与插件管理页、e2e 的 `[data-plugin-id]` 一致）。 */
  pluginId: string
  version: string
  /** 发布包体积（KB，向上取整），与打包脚本对拍。 */
  sizeKb: number
  /** 能力清单（顺序与 manifest 一致，页面只做展示）。 */
  capabilities: string[]
}

export const SAMPLE_CATALOG: SampleEntry[] = [
  {
    id: 'brandguard',
    pluginId: 'com.lumen.samples.brandguard',
    version: PACK_SIZES.brandguard.version,
    sizeKb: sampleSizeKb('brandguard'),
    capabilities: [
      'ui:slot',
      'ui:command',
      'theme:contribute',
      'library:contribute',
      'i18n:contribute',
      'lint:rule',
      'storage',
      'deck:read',
      'deck:write',
      'asset:write',
      'export:hook',
    ],
  },
  {
    id: 'chartkit',
    pluginId: 'com.lumen.samples.chartkit',
    version: PACK_SIZES.chartkit.version,
    sizeKb: sampleSizeKb('chartkit'),
    capabilities: ['ui:slot', 'ui:command', 'i18n:contribute', 'lint:rule', 'ai:recipe', 'storage', 'deck:read', 'deck:write'],
  },
  {
    id: 'focusdesk',
    pluginId: 'com.lumen.samples.focusdesk',
    version: PACK_SIZES.focusdesk.version,
    sizeKb: sampleSizeKb('focusdesk'),
    capabilities: ['ui:slot', 'ui:command', 'ui:keymap', 'ui:layout', 'i18n:contribute', 'storage', 'deck:read'],
  },
]

/** 敏感能力（03 §3.2）：安装时默认不勾选、折叠展开。 */
export const SENSITIVE_CAPABILITIES = ['ai:invoke', 'deck:write', 'asset:write', 'export:hook'] as const

export function sampleById(id: SampleId): SampleEntry {
  const sample = SAMPLE_CATALOG.find((item) => item.id === id)
  if (!sample) throw new Error(`unknown sample: ${id}`)
  return sample
}

/** 发布包相对路径（public/plugins/samples 下，版本号为权威名；无版本号 alias 仅作备用）。 */
export function samplePackagePath(id: SampleId): string {
  const sample = sampleById(id)
  return `./plugins/samples/${id}-${sample.version}.lumenplug`
}

export function isSensitiveCapability(capability: string): boolean {
  return (SENSITIVE_CAPABILITIES as readonly string[]).includes(capability)
}

/** 能力 → 宿主 i18n 的 `plugin.capability.*` 键尾（03 §3.1 的人话文案）。 */
export const CAPABILITY_I18N_KEY: Record<string, string> = {
  'ui:slot': 'uiSlot',
  'ui:command': 'uiCommand',
  'ui:keymap': 'uiKeymap',
  'ui:layout': 'uiLayout',
  'theme:contribute': 'themeContribute',
  'library:contribute': 'libraryContribute',
  'i18n:contribute': 'i18nContribute',
  'lint:rule': 'lintRule',
  'ai:recipe': 'aiRecipe',
  storage: 'storage',
  'ai:invoke': 'aiInvoke',
  'deck:read': 'deckRead',
  'deck:write': 'deckWrite',
  'asset:write': 'assetWrite',
  'export:hook': 'exportHook',
}

export const GITHUB_URL = 'https://github.com/lzytttttt/LUMEN'
export const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues`
export const DEV_DOC_PATH = 'doc/12-插件系统.md'
export const DEV_DOC_URL = `${GITHUB_URL}/blob/main/${DEV_DOC_PATH}`
