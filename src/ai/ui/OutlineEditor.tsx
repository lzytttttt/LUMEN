/**
 * OutlineEditor.tsx —— 大纲可编辑列表：拖动排序 / 删除 / 加一幕 / 改标题与要点。
 *
 * 大纲是 AI 与人的第一个交界面（P1 提示优先、P2 输出是结构）：
 * 这里改的每一个字，都会在「逐幕成稿」时被原样用上。
 */
import { useState } from 'react'
import type { Outline, OutlineSlide, RecipeId } from '@/schema/deck'
import { useT } from '@/i18n'
import { Button, Select, TextArea, TextInput } from '@/ui/primitives'
import { RECIPES } from '@/ai/recipes'

const RECIPE_IDS = Object.keys(RECIPES) as RecipeId[]

export interface OutlineEditorProps {
  outline: Outline
  disabled?: boolean
  onChange: (outline: Outline) => void
}

export function OutlineEditor({ outline, disabled, onChange }: OutlineEditorProps) {
  const t = useT()
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  const patchSlide = (index: number, patch: Partial<OutlineSlide>) => {
    const slides = outline.slides.map((slide, i) => (i === index ? { ...slide, ...patch } : slide))
    onChange({ ...outline, slides })
  }

  const move = (from: number, to: number) => {
    if (from === to) return
    const slides = [...outline.slides]
    const [moved] = slides.splice(from, 1)
    slides.splice(Math.max(0, Math.min(to, slides.length)), 0, moved)
    onChange({ ...outline, slides })
  }

  const remove = (index: number) => {
    if (outline.slides.length <= 1) return
    onChange({ ...outline, slides: outline.slides.filter((_, i) => i !== index) })
  }

  const add = () => {
    const slide: OutlineSlide = {
      recipe: 'statement',
      headline: outline.lang === 'zh' ? '新的一幕' : 'New slide',
      points: [],
      visual: { kind: 'none' },
    }
    onChange({ ...outline, slides: [...outline.slides, slide] })
  }

  return (
    <div className="ai-outline">
      <TextInput
        value={outline.title}
        onValueChange={(title) => onChange({ ...outline, title })}
        aria-label={t('ai.panel.headlineLabel')}
        placeholder={t('ai.panel.headlineLabel')}
        disabled={disabled}
      />

      <ol className="ai-outline__list">
        {outline.slides.map((slide, index) => (
          <li
            key={index}
            className="ai-outline__row"
            data-drag={dragIndex === index}
            draggable={!disabled}
            onDragStart={() => setDragIndex(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              if (dragIndex !== null) move(dragIndex, index)
              setDragIndex(null)
            }}
            onDragEnd={() => setDragIndex(null)}
          >
            <div className="ai-outline__bar">
              <span className="ai-outline__grip" title={t('ai.panel.dragHint')} aria-hidden="true">
                ⋮⋮
              </span>
              <span className="ai-outline__index">{t('ai.panel.slideLabel', { n: index + 1 })}</span>
              <Select
                value={slide.recipe}
                onValueChange={(recipe) => patchSlide(index, { recipe })}
                options={RECIPE_IDS.map((id) => ({ value: id, label: id }))}
                disabled={disabled}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove(index)}
                disabled={disabled || outline.slides.length <= 1}
                title={t('ai.panel.removeSlide')}
                aria-label={t('ai.panel.removeSlide')}
              >
                ✕
              </Button>
            </div>

            <TextInput
              value={slide.headline}
              onValueChange={(headline) => patchSlide(index, { headline })}
              aria-label={t('ai.panel.headlineLabel')}
              placeholder={t('ai.panel.headlineLabel')}
              disabled={disabled}
            />

            <TextArea
              rows={Math.min(5, Math.max(2, (slide.points ?? []).length + 1))}
              value={(slide.points ?? []).join('\n')}
              onValueChange={(text) => patchSlide(index, { points: text.split('\n') })}
              placeholder={t('ai.panel.pointsLabel')}
              disabled={disabled}
            />
          </li>
        ))}
      </ol>

      <Button variant="outline" size="sm" block onClick={add} disabled={disabled}>
        {t('ai.panel.addSlideToOutline')}
      </Button>
    </div>
  )
}
