/**
 * creator/abi-digest.ts —— 注入给模型的 ABI 摘录（04 §6.3 / CR-40-18 的单一来源）。
 *
 * 纪律：
 * - 命名一律是 00 §7 / 02 的冻结名；本文件**只抄名字与一句话约束**，不新增 ABI；
 * - CR-40-18 机械校验：17 命名空间 / 9 插槽 / 15 能力 / 16 基元 / 提案 7 必填 + 1 可选；
 *   02 改名时这个测试先红（04 §6.3 的「把漂移变红灯」）。
 * - 按意图裁剪：theme → theme+i18n；widget → ui+events+deck+基元；command → commands+keymap+layout；
 *   auto → 全量（仍 ≤3000 token，04 §6.2）。
 */
import type { CreatorTemplateId } from './state'

/* ------------------------------ 冻结计数（CR-40-18） ------------------------------ */

export const ABI_NAMESPACES = [
  'meta',
  'ui',
  'commands',
  'keymap',
  'layout',
  'deck',
  'theme',
  'storage',
  'settings',
  'i18n',
  'lint',
  'ai',
  'assets',
  'export',
  'events',
  'notify',
  'log',
] as const

export const ABI_SLOT_IDS = [
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

export const ABI_CAPABILITY_IDS = [
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

export const ABI_PRIMITIVES = [
  'button',
  'iconButton',
  'field',
  'textInput',
  'textarea',
  'select',
  'switch',
  'slider',
  'tabs',
  'card',
  'badge',
  'toast',
  'empty',
  'spinner',
  'codeBlock',
  'table',
] as const

/** 提案字段：7 必填 + 1 可选（04 §13.3.7 P1-10）。 */
export const ABI_PROPOSAL_FIELDS = [
  'title',
  'summary',
  'kind',
  'risk',
  'capabilities',
  'files',
  'changes',
] as const
export const ABI_PROPOSAL_OPTIONAL_FIELDS = ['trialNote'] as const

/** 可改面（04 §4，提示词里的「能做什么」清单）。 */
export const ABI_SURFACE_SUMMARY = `可改面（只能碰这些；其余一律拒绝）：
- 9 插槽：${ABI_SLOT_IDS.join(' / ')}
- 布局预设 / 主题令牌 / 命令与键位 / 配方 / lint 规则 / 导出预检 / 素材与 i18n / 插件自有数据
- 不可改：壳层 DOM、编辑画布、播放器内核、弹窗层级、schema/deck.ts、内置 6 主题 id、内置 12 配方几何、内置 lint 阈值、导出 HTML/CSP、网络/外链`

/** ABI 全量摘录（≤3000 token；按意图再裁剪）。 */
export const ABI_DIGEST_FULL = `ABI v1 摘录（命名冻结，不得改名）：
命名空间（17）：${ABI_NAMESPACES.join(' ')}
插槽（9）：${ABI_SLOT_IDS.join(' ')}
能力（15）：${ABI_CAPABILITY_IDS.join(' ')}
meta: { pluginId, pluginVersion, apiVersion, locale, capabilities, appVersion }
lumen.ui(ui:slot): el(tag, props?, ...children) / css(text) / onRender((root, ctx) => void) / setTitle(t) / openDialog / openPanel / closePanel / setBusy
commands(ui:command): register({id,title,run}) / unregister / invoke
keymap(ui:keymap): bind(combo, commandId) / unbind（必须含修饰键，冲突要用户确认）
layout(ui:layout): registerPreset({id,name,apply}) / apply / current
deck: getSnapshot / getActiveSlide / subscribe（deck:read）；insertBlocks / updateBlock / transaction / applyTheme（deck:write，全部走宿主事务）
theme: get / cssVars / subscribe（只读）
storage(storage): get / set / remove / keys / clear（自属命名空间）
settings(storage): declare / get / patch / reset / subscribe（与 contributes.settings 二选一）
i18n: t / locale / register（register 需 i18n:contribute，键带插件前缀）
lint(lint:rule): registerRule / report / helpers（只报不改）
ai: complete（ai:invoke）/ registerRecipe / registerPromptFragment（ai:recipe）
assets(asset:write): put / getUrl / remove / list
export(export:hook): onPreflight / provideStaticAssets（不得改 HTML/CSP）
events: on / off（app:ready deck:open deck:change slide:change theme:change mode:change play:start play:stop export:before export:after）
notify: toast({kind,message,ttl?})；log: debug/info/warn/error
SDK 基元（16）：${ABI_PRIMITIVES.join(' ')}`

/** 按意图裁剪后的 ABI（04 §6.3：theme→theme+i18n；widget→ui+events+deck+基元；command→commands+keymap+layout）。 */
export function abiDigestFor(intent: CreatorTemplateId | 'auto'): string {
  if (intent === 'auto') return ABI_DIGEST_FULL
  if (intent === 'theme') {
    return `ABI v1 摘录（主题皮肤）：
主题贡献：contributes.themes[] = { id, name{zh,en}, vibe?, colors{bg,fg,muted,surface,line,accent,accent2}, typeScale?, radius?, motion?, texture?, glow?, elevation? }
i18n 贡献：contributes.i18n[] = { zh:{key:value}, en:{key:value} }（zh/en 键集必须相等）
能力：theme:contribute、i18n:contribute；主题 id 不得覆盖内置 6 套（noir/paper/aurora/signal/museum/terminal）
不需要 plugin.js；颜色必须是合法 #rrggbb / rgb() / hsl()`
  }
  if (intent === 'widget') {
    return `ABI v1 摘录（插槽小组件，lumen.ui / lumen.deck）：
kind:'code' + entry:'plugin.js'（单文件 ESM，禁止 import/require/TS/JSX）
contributes.slots[] = { id, slot, title{zh,en}, kind, order? }
lumen.ui(ui:slot): el(tag, props?, ...children) / css / onRender((root, ctx) => void) / setTitle
lumen.deck(deck:read): getSnapshot / getActiveSlide / subscribe；订阅回调里刷新
lumen.events: on / off；lumen.notify: toast
SDK 基元（16）：${ABI_PRIMITIVES.join(' ')}
可用插槽：${ABI_SLOT_IDS.join(' / ')}；inline 槽只放静态入口按钮（必须带 open），动态读数放 dock/overlay/inspector.tab`
  }
  return `ABI v1 摘录（命令与键位）：
kind:'declarative'（纯声明式，不需要 plugin.js）
contributes.commands[] = { id, title{zh,en}, category:'plugin', action }
声明式 action 只有 8 种：setTheme / applyLayoutPreset / insertLibrarySvg / insertTextBlocks / openPluginPanel / openSettings / runExportPreflight / toast
contributes.keymap[] = { combo, commandId }（combo 形如 mod+shift+d，必须含修饰键；冲突时用户确认）
contributes.layoutPresets[] = { id, name{zh,en}, apply{railWidth?,panelWidth?,hideRail?,hideInspector?,leftTab?,rightMode?,dockHeight?,inspectorTab?,showGrid?,density?} }
能力：ui:command、ui:keymap、ui:layout`
}
