/**
 * creator/templates/command.ts —— 命令与键位模板（04 §6.6 / CR-40-187）。
 *
 * 纯声明式（只有 `.lumen-plugin.json`）：命令 + 键位 + 布局预设三件套；
 * 命令 action 用封闭 8 项枚举里的 `applyLayoutPreset`，不写代码、不需要帧。
 */
import type { CreatorProposal } from '@/plugins/types'

export interface CommandTemplateOptions {
  /** 命令名（双语；缺省「进入专注 / Focus mode」）。 */
  titleZh?: string
  titleEn?: string
  /** 组合键（必须带修饰键；缺省 `mod+shift+d`）。 */
  combo?: string
  /** 预设是否收起右栏（默认 true）。 */
  hideInspector?: boolean
}

export const COMMAND_TEMPLATE_ID = 'local.creator.template.keys'
export const COMMAND_TEMPLATE_COMMAND_ID = 'focus-mode'
export const COMMAND_TEMPLATE_PRESET_ID = 'focus'
export const COMMAND_TEMPLATE_KEYMAP = 'mod+shift+d'

function manifestOf(options: CommandTemplateOptions): Record<string, unknown> {
  const titleZh = options.titleZh?.trim() || '进入专注'
  const titleEn = options.titleEn?.trim() || 'Focus mode'
  const combo = (options.combo ?? COMMAND_TEMPLATE_KEYMAP).trim().toLowerCase()
  return {
    id: COMMAND_TEMPLATE_ID,
    name: { zh: '专注快捷键', en: 'Focus shortcut' },
    version: '0.1.0',
    apiVersion: '1.0',
    minAppVersion: '0.4.0',
    kind: 'declarative',
    author: { name: 'LUMEN Creator' },
    description: {
      zh: '新增一个专注布局预设、一个命令和一个未占用的组合键。',
      en: 'Adds a focus layout preset, a command, and an unclaimed key combo.',
    },
    license: 'CC-BY-4.0',
    capabilities: ['ui:command', 'ui:keymap', 'ui:layout'],
    contributes: {
      layoutPresets: [
        {
          id: COMMAND_TEMPLATE_PRESET_ID,
          name: { zh: '专注', en: 'Focus' },
          apply: {
            hideInspector: options.hideInspector !== false,
            railWidth: 216,
            ...(options.hideInspector !== false ? {} : { panelWidth: 360 }),
          },
        },
      ],
      commands: [
        {
          id: COMMAND_TEMPLATE_COMMAND_ID,
          title: { zh: titleZh, en: titleEn },
          category: 'plugin',
          action: { kind: 'applyLayoutPreset', presetId: COMMAND_TEMPLATE_PRESET_ID },
        },
      ],
      keymap: [{ combo, commandId: COMMAND_TEMPLATE_COMMAND_ID }],
    },
  }
}

/** 命令与键位模板 → 提案（未走校验；入口在 `templates/index.ts`）。 */
export function buildCommandTemplate(options: CommandTemplateOptions = {}): CreatorProposal {
  const combo = (options.combo ?? COMMAND_TEMPLATE_KEYMAP).trim().toLowerCase()
  const titleZh = options.titleZh?.trim() || '进入专注'
  return {
    title: '专注命令与键位',
    summary: `新增命令「${titleZh}」、组合键 ${combo} 与专注布局预设`,
    kind: 'declarative',
    risk: 'low',
    capabilities: ['ui:command', 'ui:keymap', 'ui:layout'],
    files: [{ path: '.lumen-plugin.json', content: JSON.stringify(manifestOf(options), null, 2) }],
    changes: [
      { surface: 'command', detail: `命令面板新增「${titleZh}」` },
      { surface: 'keymap', detail: `绑定 ${combo}（冲突需你确认）` },
      { surface: 'layout', detail: options.hideInspector !== false ? '应用「专注」预设：收起右栏' : '应用「专注」预设：保留右栏' },
    ],
    trialNote: '按一下你刚设的键',
  }
}
