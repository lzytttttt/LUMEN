/**
 * creator/StartCard.tsx —— 起手卡文案 + 3 个模板起点（04 §3.2 idle 行 / §6.6）。
 *
 * 「没有模型也能用」是本卡的承诺：3 个模板同步产文件、零 AI 调用。
 * 模板行在输入区上方**始终可见**（提案后也能换模板再起一版）；`?creator=<template>` 时该模板排第一。
 */
import { Button } from '@/ui/primitives'
import { CREATOR_KEYS, useCreatorT } from './i18n'
import { CREATOR_TEMPLATE_ORDER, TEMPLATE_LABEL_KEYS } from './templates'
import { useCreatorStore } from './store'
import type { CreatorTemplateId } from './state'

const TEMPLATE_ICON: Record<CreatorTemplateId, string> = {
  theme: '◐',
  widget: '▤',
  command: '⌘',
}

/** 示例 chip：只做提示，不自动提交（e2e 用 typing 而非点击即可）。 */
export function createSamplePromptChips(): string[] {
  return ['底部加一条字数看板', '主色 #1F6FEB 的品牌主题', '⌘⇧D 进入专注并收起右栏']
}

/** 起手卡（仅 idle 时的提示文字；模板行在 `TemplateRow`）。 */
export function StartCard({ compact = false }: { compact?: boolean }) {
  const t = useCreatorT()
  const machine = useCreatorStore((state) => state.machine)
  if (machine.status !== 'idle') return null
  return (
    <div className="creator-start" data-creator-startcard="">
      <div className="creator-hint">{t(CREATOR_KEYS.emptyNoModel)}</div>
      {compact ? null : <div className="creator-hint">{t(CREATOR_KEYS.promptHint)}</div>}
    </div>
  )
}

/** 模板行：始终可见；`?creator=<template>` 带来的模板排第一（06 CE-40-02 断言首项）。 */
export function TemplateRow() {
  const t = useCreatorT()
  const startTemplate = useCreatorStore((state) => state.startTemplate)
  const preferred = useCreatorStore((state) => state.preferredTemplate)
  const order: CreatorTemplateId[] = preferred
    ? [preferred, ...CREATOR_TEMPLATE_ORDER.filter((id) => id !== preferred)]
    : CREATOR_TEMPLATE_ORDER
  return (
    <div className="creator-start__templates" role="group" aria-label={t(CREATOR_KEYS.templates)}>
      {order.map((templateId) => (
        <Button
          key={templateId}
          variant="subtle"
          size="sm"
          className="creator-template"
          data-creator-template={templateId}
          onClick={() => startTemplate(templateId)}
          title={t(CREATOR_KEYS.templateHint)}
        >
          <span className="creator-template__icon" aria-hidden="true">
            {TEMPLATE_ICON[templateId]}
          </span>
          <span>{t(TEMPLATE_LABEL_KEYS[templateId])}</span>
        </Button>
      ))}
    </div>
  )
}
