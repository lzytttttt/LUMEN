/**
 * PropsTab.tsx —— 检查器「属性」页签。
 * 单块：类型信息 / 类型专属编辑区 / 几何 / 层级与状态；多块：批量操作。
 */
import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Copy, Eye, EyeOff, Lock, Trash2, Unlock } from 'lucide-react'
import type { Block } from '@/schema/deck'
import { blockOps } from '@/state/ops'
import { useSelectionStore } from '@/state/selectionStore'
import { useT } from '@/i18n'
import {
  Button,
  Field,
  IconButton,
  NumberInput,
  Row,
  Section,
  TextInput,
} from '@/ui/primitives'
import { blockLabelOf } from '../blockLabels'
import { ProvenanceBadge } from '../ProvenanceBadge'
import { HtmlSection, ImageSection, ShapeSection, SvgSection, TextSection, ThreeSection } from '../BlockSections'

export function PropsTab({ selected }: { selected: Block[] }) {
  const t = useT()

  if (selected.length === 0) {
    return (
      <div className="panel__empty">
        <div style={{ color: 'var(--ui-fg-dim)', marginBottom: 6 }}>{t('editor.inspector.noSelection')}</div>
        {t('editor.inspector.noSelectionHint')}
      </div>
    )
  }

  if (selected.length > 1) return <MultiProps blocks={selected} />

  const block = selected[0]
  return (
    <>
      <Section title={t('editor.inspector.sectionInfo')}>
        <Field label={t('editor.inspector.blockType')}>
          <div className="insp-type">
            <span className="insp-type__chip">{block.type}</span>
            <span>{blockLabelOf(block, t)}</span>
          </div>
        </Field>
        <Field label={t('editor.inspector.blockName')}>
          <TextInput
            value={block.name ?? ''}
            placeholder={blockLabelOf(block, t)}
            onValueChange={(name) => blockOps.setName(block.id, name)}
          />
        </Field>
        <ProvenanceBadge block={block} />
      </Section>

      {block.type === 'text' ? <TextSection block={block} /> : null}
      {block.type === 'shape' ? <ShapeSection block={block} /> : null}
      {block.type === 'image' ? <ImageSection block={block} /> : null}
      {block.type === 'svg' ? <SvgSection block={block} /> : null}
      {block.type === 'three' ? <ThreeSection block={block} /> : null}
      {block.type === 'html' ? <HtmlSection block={block} /> : null}

      <GeometrySection block={block} />
      <LayerOrderSection blocks={[block]} />
    </>
  )
}

function GeometrySection({ block }: { block: Block }) {
  const t = useT()
  const setRect = (patch: Partial<{ x: number; y: number; w: number; h: number }>) => {
    blockOps.setGeometry(
      [{ id: block.id, x: block.x, y: block.y, w: block.w, h: block.h, ...patch }],
      { coalesceKey: 'geometry' },
    )
  }
  const setScalar = (recipe: (draft: Block) => void, coalesceKey: string) =>
    blockOps.update(block.id, recipe, { coalesceKey })

  return (
    <Section title={t('editor.inspector.geometry')}>
      <Row cols={2}>
        <Field label="X">
          <NumberInput value={block.x} onValueChange={(x) => setRect({ x })} />
        </Field>
        <Field label="Y">
          <NumberInput value={block.y} onValueChange={(y) => setRect({ y })} />
        </Field>
        <Field label="W">
          <NumberInput value={block.w} min={8} onValueChange={(w) => setRect({ w })} />
        </Field>
        <Field label="H">
          <NumberInput value={block.h} min={8} onValueChange={(h) => setRect({ h })} />
        </Field>
      </Row>

      <Row cols={2}>
        <Field label={t('editor.inspector.rotation')}>
          <NumberInput
            value={block.rotation}
            min={-360}
            max={360}
            suffix="°"
            onValueChange={(rotation) => setScalar((draft) => { draft.rotation = rotation }, `rot-${block.id}`)}
          />
        </Field>
        <Field label={t('editor.inspector.opacity')}>
          <NumberInput
            value={block.opacity}
            min={0}
            max={1}
            step={0.05}
            onValueChange={(opacity) => setScalar((draft) => { draft.opacity = opacity }, `op-${block.id}`)}
          />
        </Field>
      </Row>

      <div className="insp-actions">
        <Button
          size="sm"
          variant="subtle"
          icon={block.locked ? <Lock size={13} /> : <Unlock size={13} />}
          active={block.locked}
          onClick={() => blockOps.setFlag([block.id], 'locked')}
        >
          {t('editor.inspector.locked')}
        </Button>
        <Button
          size="sm"
          variant="subtle"
          icon={block.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          active={block.hidden}
          onClick={() => blockOps.setFlag([block.id], 'hidden')}
        >
          {t('editor.inspector.hidden')}
        </Button>
      </div>
    </Section>
  )
}

function LayerOrderSection({ blocks }: { blocks: Block[] }) {
  const t = useT()
  const ids = blocks.map((block) => block.id)
  return (
    <Section title={t('editor.inspector.layerOrder')}>
      <div className="insp-actions">
        <IconButton icon={<ChevronsUp size={14} />} label={t('editor.inspector.orderFront')} onClick={() => blockOps.reorderZ(ids, 'front')} />
        <IconButton icon={<ArrowUp size={14} />} label={t('editor.inspector.orderForward')} onClick={() => blockOps.reorderZ(ids, 'forward')} />
        <IconButton icon={<ArrowDown size={14} />} label={t('editor.inspector.orderBackward')} onClick={() => blockOps.reorderZ(ids, 'backward')} />
        <IconButton icon={<ChevronsDown size={14} />} label={t('editor.inspector.orderBack')} onClick={() => blockOps.reorderZ(ids, 'back')} />
        <span style={{ width: 8 }} />
        <IconButton icon={<Copy size={14} />} label={t('common.action.duplicate')} onClick={() => blockOps.duplicate(ids)} />
        <IconButton
          icon={<Trash2 size={14} />}
          label={t('common.action.delete')}
          tone="danger"
          onClick={() => blockOps.remove(ids)}
        />
      </div>
    </Section>
  )
}

function MultiProps({ blocks }: { blocks: Block[] }) {
  const t = useT()
  const ids = blocks.map((block) => block.id)
  const setSelection = useSelectionStore((s) => s.setSelection)
  const allLocked = blocks.every((block) => block.locked)
  const allHidden = blocks.every((block) => block.hidden)

  return (
    <div className="insp-multi">
      <Section title={t('editor.inspector.multiSelection', { count: blocks.length })}>
        <p className="insp-note">{t('editor.inspector.multiHint')}</p>
        <div className="insp-actions">
          <Button size="sm" variant="subtle" icon={<Copy size={13} />} onClick={() => blockOps.duplicate(ids)}>
            {t('common.action.duplicate')}
          </Button>
          <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => blockOps.remove(ids)}>
            {t('common.action.delete')}
          </Button>
        </div>
        <div className="insp-actions">
          <Button
            size="sm"
            variant="subtle"
            active={allLocked}
            icon={<Lock size={13} />}
            onClick={() => blockOps.setFlag(ids, 'locked', !allLocked)}
          >
            {t('editor.inspector.locked')}
          </Button>
          <Button
            size="sm"
            variant="subtle"
            active={allHidden}
            icon={<EyeOff size={13} />}
            onClick={() => blockOps.setFlag(ids, 'hidden', !allHidden)}
          >
            {t('editor.inspector.hidden')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelection([])}>
            {t('editor.inspector.clearSelection')}
          </Button>
        </div>
        <p className="insp-char">{t('editor.inspector.layerCount', { count: blocks.length })}</p>
      </Section>
      <LayerOrderSection blocks={blocks} />
    </div>
  )
}
