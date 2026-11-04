/**
 * creator/bridge.ts —— 创造面板的对外开关桥（04 §2.1）。
 *
 * 宿主壳只依赖本文件（TopBar / App / CommandPalette / URL）：
 * ```ts
 * openCreator('topbar')            // 打开；source 进 data-creator-source
 * toggleCreator('shortcut')        // ⌘⇧K
 * openCreator('url', 'widget')     // ?creator=<template> 直达模板
 * isCreatorOpen() / useCreatorOpen()
 * ```
 * **性能纪律（05 §10.3 / P-40-01）**：本文件只 import 轻量 `panelState`，
 * 绝不 import `store` / 面板组件；重量级模块由 `CreatorHost` 懒加载。
 *
 * 事件纪律（2026-11-03 修栈溢出）：
 * - `lumen:open-creator` 是**外部请求打开**的入站通道（测试/插件页 dispatch），本桥不派发；
 * - 开/关状态由重量级面板派发 `lumen:creator-state`（06 §3.2）。
 */
import {
  requestCloseCreator,
  requestOpenCreator,
  useCreatorPanelOpen,
  useCreatorPanelStore,
} from './panelState'
import type { CreatorEntrySource, CreatorTemplateId } from './state'

export type { CreatorEntrySource, CreatorTemplateId }

export const CREATOR_OPEN_EVENT = 'lumen:open-creator'
export const CREATOR_TEMPLATE_VALUES = ['theme', 'widget', 'command'] as const

export interface CreatorOpenDetail {
  source: CreatorEntrySource
  templateId?: CreatorTemplateId
}

/** `?creator=<template>` → 模板 id（非法返回 null，调用方按 `1` 处理）。 */
export function parseCreatorTemplateValue(value: string | null | undefined): CreatorTemplateId | null {
  if (value === 'theme' || value === 'widget' || value === 'command') return value
  return null
}

/** 打开面板；`templateId` 合法时直达模板起点（无 AI 调用）。 */
export function openCreator(source: CreatorEntrySource = 'topbar', templateId?: string | null): void {
  if (typeof window === 'undefined') return
  requestOpenCreator(source, parseCreatorTemplateValue(templateId ?? null))
}

/** 开关面板（⌘⇧K / 顶栏按钮）。 */
export function toggleCreator(source: CreatorEntrySource = 'shortcut'): void {
  if (isCreatorOpen()) closeCreator()
  else openCreator(source)
}

export function closeCreator(): void {
  requestCloseCreator()
}

export function isCreatorOpen(): boolean {
  return useCreatorPanelStore.getState().open
}

/** React 订阅：`aria-expanded` 等随面板状态更新。 */
export function useCreatorOpen(): boolean {
  return useCreatorPanelOpen()
}
