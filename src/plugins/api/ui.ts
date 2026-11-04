/**
 * plugins/api/ui.ts —— `lumen.ui` 的宿主侧方法（02 §5.2 / §5.3）。
 *
 * 帧内方法（`el/css/onRender`）由 bootstrap 实现；这里只处理需要宿主状态的 5 个：
 * `setTitle / setBusy / openDialog / openPanel / closePanel`。
 * 约束：只能开**自属**贡献的 dialog/settings/panel，未声明 → `E-ABI-01`（02 §5.3）。
 */
import { getRegisteredSlots, slotHostId } from '../contributionBus'
import { localizeTitle, titlePairOf } from './util'
import { hostUi, type ApiCall } from './context'
import { abiError, assertRecord, assertString, registerNamespaceApi } from './gateway'
import type { SlotId } from '../types'

export type UiMethod = 'setTitle' | 'setBusy' | 'openDialog' | 'openPanel' | 'closePanel'

export function handleUi(method: UiMethod, payload: unknown, call: ApiCall): Promise<unknown> | unknown {
  switch (method) {
    case 'setTitle': {
      const body = assertRecord(payload, 'payload')
      const title = assertString(body.title, 'title', { max: 40 })
      hostUi().setTitle(call.frame, title)
      return null
    }
    case 'setBusy': {
      const body = assertRecord(payload, 'payload')
      const busy = body.busy === true
      const label = typeof body.label === 'string' ? body.label.slice(0, 40) : ''
      hostUi().setBusy(call.frame, busy, label)
      return null
    }
    case 'openDialog': {
      const body = assertRecord(payload, 'payload')
      const id = assertString(body.id, 'id', { min: 1, max: 64 })
      const title = typeof body.title === 'string' ? body.title.slice(0, 80) : ''
      const size = body.size === 'sm' || body.size === 'md' || body.size === 'lg' ? body.size : 'md'
      assertOwnContribution(call, id, 'dialog')
      return hostUi().openDialog(call.frame, { id, title, size })
    }
    case 'openPanel': {
      const body = assertRecord(payload, 'payload')
      const id = assertString(body.id, 'id', { min: 1, max: 64 })
      const slot = typeof body.slot === 'string' ? (body.slot as SlotId) : (call.frame.slot as SlotId)
      assertOwnContribution(call, id, slot)
      const contribution = getRegisteredSlots().find((item) => item.id === slotHostId(call.frame.pluginId, id))
      const title = contribution ? localizeTitle(contribution.title, call) : ''
      return hostUi().openPanel(call.frame, { slot, id })
    }
    case 'closePanel': {
      const body = assertRecord(payload, 'payload')
      const slot = typeof body.slot === 'string' ? (body.slot as SlotId) : call.frame.slot
      const id = typeof body.id === 'string' ? body.id : undefined
      hostUi().closePanel(call.frame, { slot, id })
      return null
    }
    default:
      throw abiError(`unknown ui method "${method}"`)
  }
}

/** 只能操作本插件在清单中声明的插槽贡献（02 §5.2/§5.3）。 */
function assertOwnContribution(call: ApiCall, contributionId: string, expectedSlot: SlotId): void {
  const hostId = slotHostId(call.frame.pluginId, contributionId)
  const item = getRegisteredSlots().find((slot) => slot.id === hostId)
  if (!item) throw abiError(`slot contribution "${contributionId}" is not declared by this plugin`)
  if (item.slot !== expectedSlot) {
    throw abiError(`slot contribution "${contributionId}" belongs to ${item.slot}, not ${expectedSlot}`)
  }
}

/** 标题本地化（供宿主组件复用；避免 UI 层 import i18n 细节）。 */
export function slotTitleOf(call: ApiCall, contributionId: string): string {
  const item = getRegisteredSlots().find((slot) => slot.id === slotHostId(call.frame.pluginId, contributionId))
  return item ? localizeTitle(item.title, call) : ''
}

export function registerUiApi(): void {
  registerNamespaceApi('ui', {
    setTitle: (payload, call) => handleUi('setTitle', payload, call),
    setBusy: (payload, call) => handleUi('setBusy', payload, call),
    openDialog: (payload, call) => handleUi('openDialog', payload, call),
    openPanel: (payload, call) => handleUi('openPanel', payload, call),
    closePanel: (payload, call) => handleUi('closePanel', payload, call),
  })
}

export { titlePairOf }
