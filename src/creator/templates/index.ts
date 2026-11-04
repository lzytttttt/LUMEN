/**
 * creator/templates/index.ts —— 3 个无模型模板的统一入口（04 §6.6）。
 *
 * 模板是「没有模型也能用」的起点：同步产文件、走同一套提案校验、无 AI 调用（CR-40-187/188）。
 */
import type { CreatorProposal, PluginManifest } from '@/plugins/types'
import type { CreatorTemplateId } from '../state'
import { assertValidProposal } from '../proposal'
import { buildCommandTemplate, type CommandTemplateOptions } from './command'
import { buildThemeTemplate, type ThemeTemplateOptions } from './theme'
import { buildWidgetTemplate, type WidgetTemplateOptions } from './widget'

export const TEMPLATE_NAMES: Record<CreatorTemplateId, { zh: string; en: string }> = {
  theme: { zh: '主题皮肤', en: 'Theme skin' },
  widget: { zh: '插槽小组件', en: 'Slot widget' },
  command: { zh: '命令与键位', en: 'Command & keys' },
}

/** 模板 → 固定 manifest id（04 §6.6；保留时按 local 信任安装）。 */
export const TEMPLATE_MANIFEST_IDS: Record<CreatorTemplateId, string> = {
  theme: 'local.creator.template.skin',
  widget: 'local.creator.template.dock',
  command: 'local.creator.template.keys',
}

/** 模板 → i18n 文案键（`creator.template.*`）。 */
export const TEMPLATE_LABEL_KEYS: Record<CreatorTemplateId, string> = {
  theme: 'creator.template.theme',
  widget: 'creator.template.widget',
  command: 'creator.template.command',
}

export interface CreatorTemplateBuild {
  proposal: CreatorProposal
  manifest: PluginManifest
}

export type CreatorTemplateOptions = ThemeTemplateOptions & WidgetTemplateOptions & CommandTemplateOptions

/** 同步构建并校验模板提案；校验失败抛 `CreatorValidationError`（模板自身 bug 即单测红）。 */
export function buildCreatorTemplate(
  templateId: CreatorTemplateId,
  options: CreatorTemplateOptions = {},
): CreatorTemplateBuild {
  const raw =
    templateId === 'theme'
      ? buildThemeTemplate(options)
      : templateId === 'widget'
        ? buildWidgetTemplate(options)
        : buildCommandTemplate(options)
  const proposal = assertValidProposal(raw)
  // 校验器已解析过清单；这里再取一次给调用方（避免重复 JSON.parse 的代价可忽略）。
  const manifest = JSON.parse(
    proposal.files.find((file) => file.path === '.lumen-plugin.json')?.content ?? '{}',
  ) as PluginManifest
  return { proposal, manifest }
}

/** 模板起点列表（UI 起手卡渲染顺序固定）。 */
export const CREATOR_TEMPLATE_ORDER: CreatorTemplateId[] = ['theme', 'widget', 'command']

/** URL `?creator=<template>` → 模板 id（非法返回 null；04 §2.1）。 */
export function parseCreatorTemplate(value: string | null | undefined): CreatorTemplateId | null {
  if (value === 'theme' || value === 'widget' || value === 'command') return value
  return null
}

export * from './theme'
export * from './widget'
export * from './command'
