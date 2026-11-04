/**
 * plugins/declarative/commands.ts —— 声明式 8 项 action 的执行（02 §6.6，封闭枚举）。
 *
 * 约束：
 * - 只服务 `kind:'declarative'`；代码式插件命令由运行期 `lumen.commands.register` 注册（不双声明）；
 * - 涉及 deck 的 action 一律包 `transaction('plugin:<pluginId>:cmd:<id>')`（单步撤销）；
 * - `openPluginPanel` / `openSettings` / `runExportPreflight` 不直接渲染，派发 window 事件交给宿主壳；
 * - 文案 toast 用清单里的 zh/en，按当前语言取（不污染宿主词典）。
 */
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { deckOps, blockOps, historyOps, resolveSlideId } from '@/state/ops'
import { makeSvg, makeText } from '@/schema/factory'
import { translate } from '@/i18n'
import type { Lang } from '@/i18n/types'
import { getRegisteredCommands, getRegisteredLibrary, getRegisteredLayoutPresets, getRegisteredThemes } from '../contributionBus'
import { actionCapabilities } from '../capabilities'
import { appendAudit } from '../audit'
import { applyLayoutPreset } from './layout'
import { pluginTranslate } from '../i18n'
import type { Capability, DeclarativeCommandAction, LocalizedText } from '../types'

export const PLUGIN_COMMAND_LABEL_PREFIX = 'plugin:'

/**
 * 能力闸门（02 §5.1 / §6.6）：声明式命令在宿主侧直接执行，因此**必须**在动手前逐项确认授权。
 * runtime 启动时可注入 registry 的 `hasGrant`；未注入时回退为「动态读 registry 记录」：
 * 有安装记录 → 必须 `grants` 命中；无记录（单测/离线草稿路径）→ 放行。
 */
export type DeclarativeCapabilityGate = (pluginId: string, capability: Capability) => boolean | Promise<boolean>

let capabilityGate: DeclarativeCapabilityGate | null = null

export function setDeclarativeCapabilityGate(gate: DeclarativeCapabilityGate | null): void {
  capabilityGate = gate
}

async function fallbackGranted(pluginId: string, capability: Capability): Promise<boolean> {
  try {
    const registry = await import('../registry')
    if (!registry.getRecord(pluginId)) return true
    return registry.hasGrant(pluginId, capability)
  } catch {
    return true
  }
}

async function isActionAuthorized(pluginId: string, action: DeclarativeCommandAction): Promise<boolean> {
  const required = actionCapabilities(action.kind)
  for (const capability of required) {
    const granted = capabilityGate ? await capabilityGate(pluginId, capability) : await fallbackGranted(pluginId, capability)
    if (!granted) return false
  }
  return true
}

/** 越权：审计 `plugin.denied` + toast（03 §3.3 规则 6：不崩溃、不重复弹卡）。 */
function reportDenied(pluginId: string, action: DeclarativeCommandAction): void {
  const lang: Lang = useSettingsStore.getState().lang === 'en' ? 'en' : 'zh'
  appendAudit({
    action: 'plugin.denied',
    actor: 'system',
    result: 'denied',
    pluginId,
    code: 'E-CAP-01',
    detail: `capability-not-granted:${action.kind}`,
  })
  const translated = translate(lang, 'plugin.error.capability')
  const message =
    translated === 'plugin.error.capability'
      ? lang === 'en'
        ? 'This action is not authorized.'
        : '此操作未获授权'
      : translated
  useUiStore.getState().pushToast({ kind: 'error', message })
}

/** `plugin.<pluginId>.<localId>` → 局部 id；非插件命令返回 null。 */
export function parsePluginCommandHostId(hostId: string): { pluginId: string; localId: string } | null {
  if (!hostId.startsWith('plugin.')) return null
  const rest = hostId.slice('plugin.'.length)
  const separator = rest.indexOf('.')
  if (separator <= 0) return null
  return { pluginId: rest.slice(0, separator), localId: rest.slice(separator + 1) }
}

function pickLocalized(value: LocalizedText): string {
  const lang = useSettingsStore.getState().lang
  return (value[lang] ?? value.zh).slice(0, 160)
}

function currentThemeIdFor(pluginId: string): string[] {
  return getRegisteredThemes()
    .filter((entry) => entry.pluginId === pluginId)
    .map((entry) => entry.theme.id)
}

function currentPresetFor(pluginId: string, presetId: string) {
  const hostId = `${pluginId}/${presetId}`
  return getRegisteredLayoutPresets().find((entry) => entry.hostId === hostId)
}

function libraryItemFor(pluginId: string, libraryId: string) {
  const hostId = `${pluginId}/${libraryId}`
  return getRegisteredLibrary().find((item) => item.id === hostId)
}

/** 执行一条声明式命令（命令面板/键位统一入口）。 */
export async function executeDeclarativeCommand(
  pluginId: string,
  hostCommandId: string,
  args?: Record<string, unknown>,
): Promise<void> {
  const registered = getRegisteredCommands().find(
    (entry) => entry.pluginId === pluginId && (entry.hostId === hostCommandId || entry.command.id === hostCommandId),
  )
  if (!registered) return
  const command = registered.command
  // 02 §5.1：未授权能力调用 → E-CAP-01 + 审计 + toast，deck/布局完全不变。
  if (!(await isActionAuthorized(pluginId, command.action))) {
    reportDenied(pluginId, command.action)
    return
  }
  await runAction(pluginId, command.id, command.action, args)
}

async function runAction(
  pluginId: string,
  commandLocalId: string,
  action: DeclarativeCommandAction,
  args?: Record<string, unknown>,
): Promise<void> {
  switch (action.kind) {
    case 'setTheme': {
      const themeId = `${pluginId}/${action.themeId}`
      if (!currentThemeIdFor(pluginId).includes(themeId)) return
      deckOps.setTheme(themeId)
      toast('success', pluginId, `toast.themeApplied`)
      return
    }
    case 'applyLayoutPreset': {
      const preset = currentPresetFor(pluginId, action.presetId)
      if (!preset) return
      applyLayoutPreset(preset.preset.apply)
      return
    }
    case 'insertLibrarySvg': {
      const item = libraryItemFor(pluginId, action.libraryId)
      if (!item) return
      const slideId = resolveSlideId(action.slideId ?? (args?.slideId as string | undefined))
      if (!slideId) return
      const block = makeSvg({ source: item.source, viewBox: item.viewBox, presetId: item.id })
      transaction(`plugin:${pluginId}:cmd:${commandLocalId}`, () => {
        blockOps.addMany([block], slideId, `plugin:${pluginId}:cmd:${commandLocalId}`)
      })
      return
    }
    case 'insertTextBlocks': {
      const slideId = resolveSlideId((args?.slideId as string | undefined) ?? undefined)
      if (!slideId) return
      const blocks = action.blocks.map((spec) =>
        makeText({
          text: spec.text,
          ...(spec.variant ? { variant: spec.variant } : {}),
          ...(spec.x !== undefined ? { x: spec.x } : {}),
          ...(spec.y !== undefined ? { y: spec.y } : {}),
          ...(spec.w !== undefined ? { w: spec.w } : {}),
          ...(spec.h !== undefined ? { h: spec.h } : {}),
        }),
      )
      transaction(`plugin:${pluginId}:cmd:${commandLocalId}`, () => {
        blockOps.addMany(blocks, slideId, `plugin:${pluginId}:cmd:${commandLocalId}`)
      })
      return
    }
    case 'openPluginPanel': {
      dispatchHost('lumen:open-plugin-panel', { pluginId, slot: action.slot, contributionId: action.contributionId })
      return
    }
    case 'openSettings': {
      dispatchHost('lumen:open-plugin-settings', { pluginId })
      return
    }
    case 'runExportPreflight': {
      dispatchHost('lumen:plugin-preflight', { pluginId })
      return
    }
    case 'toast': {
      useUiStore.getState().pushToast({ kind: 'info', message: pickLocalized(action.message) })
      return
    }
    default:
      return
  }
}

function transaction(label: string, fn: () => void): void {
  // 嵌套进外层事务时 deckStore 会自动合并成一步（02 §6.6「单步撤销」）。
  historyOps.transaction(label, fn)
}

function dispatchHost(name: string, detail: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

function toast(kind: 'info' | 'success' | 'error', pluginId: string, key: string): void {
  const lang = useSettingsStore.getState().lang
  const message = pluginTranslate(pluginId, lang, key)
  if (message === key) return
  useUiStore.getState().pushToast({ kind, message })
}
