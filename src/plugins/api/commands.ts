/**
 * plugins/api/commands.ts —— `lumen.commands`（02 §5.2 / §5.3）。
 *
 * 代码式插件的命令**只在运行期注册**（清单不声明，02 §9.7 #11）；宿主把元数据收在进程内表里，
 * 命令面板展示「插件 · <插件名> · <标题>」，执行时经帧通道 `__invoke` 回到插件 `run`。
 * `invoke` 只允许两类：① 自属已注册命令；② 7 个宿主导航白名单（只读/切视图，不改 deck）。
 */
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { deckOps } from '@/state/ops'
import { THEME_IDS } from '@/themes'
import type { LocalizedText } from '../types'
import { hostUi, registryPort, type ApiCall } from './context'
import { abiError, assertRecord, assertString, registerNamespaceApi } from './gateway'
import { titlePairOf } from './util'

/* ------------------------------ 白名单（02 §5.3） ------------------------------ */

/** 宿主导航白名单（只读/切视图；无 deck 写）。 */
export const HOST_NAV_COMMANDS: readonly string[] = [
  'view.gotoSlide',
  'view.play',
  'view.inspector',
  'view.notes',
  'view.lint',
  'view.composer',
  'deck.theme',
]

export const COMMAND_LIMIT = 24

export interface RuntimeCommand {
  /** 局部 id（`apply`）；宿主 id = `plugin.<pluginId>.<id>`。 */
  id: string
  pluginId: string
  title: LocalizedText
  registeredAt: number
}

const commands = new Map<string, RuntimeCommand>()

function hostCommandId(pluginId: string, commandId: string): string {
  return `plugin.${pluginId}.${commandId}`
}

/** 运行期命令表（命令面板/诊断用；只读快照）。 */
export function listRuntimeCommands(): RuntimeCommand[] {
  return [...commands.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId) || left.id.localeCompare(right.id))
}

export function listPluginRuntimeCommands(pluginId: string): RuntimeCommand[] {
  return listRuntimeCommands().filter((command) => command.pluginId === pluginId)
}

/** 反注册一个插件的全部运行期命令（disable/uninstall；§3.4 第 3 项）。 */
export function clearRuntimeCommands(pluginId: string): void {
  for (const [key, command] of [...commands.entries()]) {
    if (command.pluginId === pluginId) commands.delete(key)
  }
}

export function resetRuntimeCommandsForTests(): void {
  commands.clear()
}

/* ------------------------------ 方法 ------------------------------ */

export function handleCommands(method: string, payload: unknown, call: ApiCall): Promise<unknown> | unknown {
  switch (method) {
    case 'register': {
      const body = assertRecord(payload, 'payload')
      const id = assertString(body.id, 'id', { min: 1, max: 64 })
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw abiError('command id must be lowercase slug')
      const key = hostCommandId(call.frame.pluginId, id)
      // 同一插件的多个 UI 帧（页签 + 弹窗 + overlay）各自 boot 时会重复注册同名命令：
      // key 已带 pluginId，这里按「同插件幂等覆盖」处理；跨插件冲突不可能命中（key 不同）。
      if (listPluginRuntimeCommands(call.frame.pluginId).length >= COMMAND_LIMIT && !commands.has(key)) {
        throw abiError(`command limit ${COMMAND_LIMIT} reached`)
      }
      commands.set(key, {
        id,
        pluginId: call.frame.pluginId,
        title: titlePairOf(body.title),
        registeredAt: Date.now(),
      })
      return null
    }
    case 'unregister': {
      const body = assertRecord(payload, 'payload')
      const id = assertString(body.id, 'id', { min: 1, max: 64 })
      commands.delete(hostCommandId(call.frame.pluginId, id))
      return null
    }
    case 'invoke': {
      const body = assertRecord(payload, 'payload')
      const id = assertString(body.id, 'id', { min: 1, max: 72 })
      const args = body.args
      const key = hostCommandId(call.frame.pluginId, id)
      if (commands.has(key)) return hostUi().invokeCommand(call.frame, id, args)
      if (HOST_NAV_COMMANDS.includes(id)) {
        runHostNavCommand(id, args)
        return null
      }
      throw abiError(`command "${id}" is not invocable by plugins`)
    }
    default:
      throw abiError(`unknown commands method "${method}"`)
  }
}

/** 7 个宿主导航命令的实现（只读/切视图，不写 deck 内容）。 */
export function runHostNavCommand(id: string, args?: unknown): void {
  const ui = useUiStore.getState()
  const body = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  switch (id) {
    case 'view.gotoSlide': {
      const deck = useDeckStore.getState().deck
      if (!deck) return
      const slideId = typeof body.slideId === 'string' ? body.slideId : null
      const index = typeof body.index === 'number' && Number.isFinite(body.index) ? Math.trunc(body.index) : null
      const target = slideId ? deck.slides.find((slide) => slide.id === slideId) : index !== null ? deck.slides[Math.max(0, Math.min(index, deck.slides.length - 1))] : null
      if (target) {
        ui.setActiveSlide(target.id)
        ui.setMode('edit')
      }
      return
    }
    case 'view.play':
      ui.setMode('play')
      return
    case 'view.inspector':
      ui.setMode('edit')
      ui.setRightMode('inspector')
      return
    case 'view.notes':
      ui.setMode('edit')
      ui.setRightMode('inspector')
      ui.setInspectorTab('notes')
      return
    case 'view.lint':
      ui.setMode('edit')
      ui.setRightMode('inspector')
      ui.setInspectorTab('lint')
      return
    case 'view.composer':
      ui.setMode('edit')
      ui.setRightMode('composer')
      return
    case 'deck.theme': {
      const deck = useDeckStore.getState().deck
      const ids = [...THEME_IDS] as string[]
      const current = deck ? ids.indexOf(deck.themeId) : -1
      const next = ids[(current + 1 + ids.length) % ids.length]
      if (next) deckOps.setTheme(next)
      return
    }
    default:
      return
  }
}

/** 插件被停用/卸载时命令表的清理入口（由 runtime 生命周期调用）。 */
export function removePluginCommands(pluginId: string): void {
  clearRuntimeCommands(pluginId)
  // 命令属于运行期注册，不落 settings；这里只保证进程内表干净。
  void registryPort
}

export function registerCommandsApi(): void {
  registerNamespaceApi('commands', {
    register: (payload, call) => handleCommands('register', payload, call),
    unregister: (payload, call) => handleCommands('unregister', payload, call),
    invoke: (payload, call) => handleCommands('invoke', payload, call),
  })
}
