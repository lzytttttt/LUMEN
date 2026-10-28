/**
 * BlockSections.tsx —— 检查器「属性」页签里按块类型渲染的编辑区。
 * 所有写入都走 blockOps；连续输入用 coalesceKey 合并成一步撤销。
 */
import { useState } from 'react'
import {
  Code2,
  Image as ImageIcon,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'
import type {
  HtmlBlock,
  ImageBlock,
  ShapeBlock,
  SvgBlock,
  TextBlock,
  ThreeBlock,
  ThreeObject,
  ThreeShape,
  TextVariant,
} from '@/schema/deck'
import { threeObjectSchema } from '@/schema/deck'
import { importImageFile, useAssetUrl } from '@/assets/assetStore'
import { blockOps } from '@/state/ops'
import { useUiStore } from '@/state/uiStore'
import { openFilePicker } from '@/export/projectFile'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import {
  Button,
  ColorSwatches,
  Field,
  IconButton,
  NumberInput,
  Row,
  Section,
  Segmented,
  Select,
  Slider,
  Switch,
  TextArea,
  TextInput,
} from '@/ui/primitives'
import { AlignControl, OptionalNumber, TOKEN_SWATCHES } from './fields'
import { openStudio } from './studioBridge'
import { HtmlEditorDialog } from './HtmlEditorDialog'

const VARIANTS: TextVariant[] = ['display', 'h1', 'h2', 'lead', 'body', 'caption', 'mono']
const SHAPE_KINDS: ShapeBlock['kind'][] = ['rect', 'ellipse', 'line', 'triangle', 'rule']
const SVG_ANIMATES: SvgBlock['animate'][] = ['none', 'float', 'pulse', 'spinSlow', 'draw']
const THREE_SHAPES: ThreeShape[] = ['box', 'sphere', 'torus', 'torusKnot', 'cone', 'cylinder', 'octa', 'plane', 'icosa']
const THREE_MATERIALS: ThreeObject['material'][] = ['standard', 'physical', 'toon', 'wireframe']
const THREE_TINTS: ThreeObject['tint'][] = ['accent', 'accent2', 'fg', 'muted', 'surface']
const SVG_ANIMATE_KEYS: Record<SvgBlock['animate'], MessageKey> = {
  none: 'studio.svg.animateNone',
  float: 'studio.svg.animateFloat',
  pulse: 'studio.svg.animatePulse',
  spinSlow: 'studio.svg.animateSpin',
  draw: 'studio.svg.animateDraw',
}

/* --------------------------------- 文本 --------------------------------- */

export function TextSection({ block }: { block: TextBlock }) {
  const t = useT()
  const update = (recipe: (draft: TextBlock) => void, coalesceKey?: string) =>
    blockOps.updateOfType(block.id, 'text', recipe, coalesceKey ? { coalesceKey } : undefined)

  return (
    <Section title={t('editor.inspector.typography')}>
      <Field label={t('editor.inspector.contentLabel')}>
        <TextArea
          value={block.text}
          rows={5}
          placeholder={t('editor.inspector.contentLabel')}
          onValueChange={(text) => update((draft) => { draft.text = text }, `text-${block.id}`)}
        />
        <span className="insp-char">{t('editor.inspector.chars', { count: block.text.length })}</span>
      </Field>

      <Row cols={2}>
        <Field label={t('editor.inspector.variant')}>
          <Select
            value={block.variant}
            onValueChange={(variant) => update((draft) => { draft.variant = variant })}
            options={VARIANTS.map((variant) => ({
              value: variant,
              label: t(`editor.inspector.variants.${variant}` as MessageKey),
            }))}
          />
        </Field>
        <Field label={t('editor.inspector.align')}>
          <AlignControl value={block.align} onValueChange={(align) => update((draft) => { draft.align = align })} />
        </Field>
      </Row>

      <Field label={t('editor.inspector.colorToken')}>
        <ColorSwatches
          value={block.color}
          colors={TOKEN_SWATCHES}
          onValueChange={(token) => {
            if (token) update((draft) => { draft.color = token })
          }}
        />
      </Field>

      <Row cols={2}>
        <Field label={t('editor.inspector.weight')}>
          <OptionalNumber
            value={block.weight}
            fallback={400}
            min={100}
            max={900}
            step={100}
            onValueChange={(weight) => update((draft) => { draft.weight = weight }, `weight-${block.id}`)}
            onClear={() => update((draft) => { draft.weight = undefined })}
          />
        </Field>
        <Field label={t('editor.inspector.lineHeight')}>
          <OptionalNumber
            value={block.lineHeight}
            fallback={1.5}
            min={0.8}
            max={2.4}
            step={0.02}
            onValueChange={(lineHeight) => update((draft) => { draft.lineHeight = lineHeight }, `lh-${block.id}`)}
            onClear={() => update((draft) => { draft.lineHeight = undefined })}
          />
        </Field>
      </Row>

      <Row cols={2}>
        <Field label={t('editor.inspector.tracking')}>
          <OptionalNumber
            value={block.tracking}
            fallback={0}
            min={-0.12}
            max={0.4}
            step={0.005}
            onValueChange={(tracking) => update((draft) => { draft.tracking = tracking }, `tracking-${block.id}`)}
            onClear={() => update((draft) => { draft.tracking = undefined })}
          />
        </Field>
        <Field label={t('editor.inspector.maxWidth')}>
          <OptionalNumber
            value={block.maxWidth}
            fallback={block.w}
            min={120}
            max={1600}
            step={8}
            onValueChange={(maxWidth) => update((draft) => { draft.maxWidth = maxWidth }, `maxw-${block.id}`)}
            onClear={() => update((draft) => { draft.maxWidth = undefined })}
          />
        </Field>
      </Row>
    </Section>
  )
}

/* --------------------------------- 形状 --------------------------------- */

export function ShapeSection({ block }: { block: ShapeBlock }) {
  const t = useT()
  const update = (recipe: (draft: ShapeBlock) => void, coalesceKey?: string) =>
    blockOps.updateOfType(block.id, 'shape', recipe, coalesceKey ? { coalesceKey } : undefined)

  return (
    <Section title={t('editor.inspector.sectionShape')}>
      <Row cols={2}>
        <Field label={t('editor.inspector.shapeKind')}>
          <Select
            value={block.kind}
            onValueChange={(kind) => update((draft) => { draft.kind = kind })}
            options={SHAPE_KINDS.map((kind) => ({
              value: kind,
              label: t(`editor.inspector.shapeKinds.${kind}` as MessageKey),
            }))}
          />
        </Field>
        <Field label={t('editor.inspector.radius')}>
          <NumberInput
            value={block.radius ?? 0}
            min={0}
            max={200}
            step={1}
            suffix="px"
            onValueChange={(radius) => update((draft) => { draft.radius = radius }, `radius-${block.id}`)}
          />
        </Field>
      </Row>

      <Field label={t('editor.inspector.fill')}>
        <ColorSwatches
          value={block.fill}
          colors={TOKEN_SWATCHES}
          onValueChange={(token) => {
            if (token) update((draft) => { draft.fill = token })
          }}
        />
      </Field>

      <Field label={t('editor.inspector.stroke')}>
        <ColorSwatches
          value={block.stroke}
          colors={TOKEN_SWATCHES}
          allowNone
          noneLabel={t('editor.inspector.none')}
          onValueChange={(token) => update((draft) => { draft.stroke = token })}
        />
      </Field>

      <Row cols={2}>
        <Field label={t('editor.inspector.strokeWidth')}>
          <NumberInput
            value={block.strokeWidth}
            min={0}
            max={40}
            step={1}
            suffix="px"
            onValueChange={(strokeWidth) => update((draft) => { draft.strokeWidth = strokeWidth }, `sw-${block.id}`)}
          />
        </Field>
        <Field label={t('editor.inspector.dash')}>
          <Switch
            checked={block.dash}
            label={t('editor.inspector.dash')}
            onCheckedChange={(dash) => update((draft) => { draft.dash = dash })}
          />
        </Field>
      </Row>
    </Section>
  )
}

/* --------------------------------- 图片 --------------------------------- */

export function ImageSection({ block }: { block: ImageBlock }) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const url = useAssetUrl(block.assetId)
  const [busy, setBusy] = useState(false)
  const update = (recipe: (draft: ImageBlock) => void, coalesceKey?: string) =>
    blockOps.updateOfType(block.id, 'image', recipe, coalesceKey ? { coalesceKey } : undefined)

  const pickImage = async () => {
    const file = await openFilePicker('image/*')
    if (!file) return
    setBusy(true)
    try {
      const meta = await importImageFile(file)
      update((draft) => {
        draft.assetId = meta.id
        if (!draft.alt) draft.alt = file.name
      })
      pushToast({ kind: 'success', message: t('editor.toast.imageInserted') })
    } catch (error) {
      pushToast({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={t('editor.inspector.sectionImage')}>
      <div className="insp-image">
        <div className="insp-image__frame">
          {url ? <img src={url} alt="" /> : <span className="insp-image__empty">{t('editor.inspector.imageMissing')}</span>}
        </div>
        <div className="insp-image__body">
          <Button size="sm" variant="outline" icon={<ImageIcon size={13} />} onClick={pickImage} disabled={busy}>
            {t('editor.inspector.replaceImage')}
          </Button>
          <span className="insp-note">{block.assetId.slice(0, 22)}</span>
        </div>
      </div>

      <Row cols={2}>
        <Field label={t('editor.inspector.imageFit')}>
          <Segmented
            value={block.fit}
            block
            onValueChange={(fit) => update((draft) => { draft.fit = fit })}
            options={[
              { value: 'cover', label: 'cover' },
              { value: 'contain', label: 'contain' },
            ]}
          />
        </Field>
        <Field label={t('editor.inspector.radius')}>
          <NumberInput
            value={block.radius}
            min={0}
            max={200}
            suffix="px"
            onValueChange={(radius) => update((draft) => { draft.radius = radius }, `radius-${block.id}`)}
          />
        </Field>
      </Row>

      <Field label={t('editor.inspector.imageDim')}>
        <Slider
          value={block.dim}
          min={0}
          max={0.9}
          step={0.01}
          ariaLabel={t('editor.inspector.imageDim')}
          onValueChange={(dim) => update((draft) => { draft.dim = dim }, `dim-${block.id}`)}
        />
      </Field>

      <Field label={t('editor.inspector.imageCaption')}>
        <TextInput
          value={block.caption ?? ''}
          onValueChange={(caption) => update((draft) => { draft.caption = caption === '' ? undefined : caption }, `cap-${block.id}`)}
        />
      </Field>

      <Field label={t('editor.inspector.alt')} hint={t('editor.inspector.altHint')}>
        <TextInput
          value={block.alt ?? ''}
          onValueChange={(alt) => update((draft) => { draft.alt = alt === '' ? undefined : alt }, `alt-${block.id}`)}
        />
      </Field>
    </Section>
  )
}

/* ---------------------------------- SVG --------------------------------- */

export function SvgSection({ block }: { block: SvgBlock }) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const update = (recipe: (draft: SvgBlock) => void, coalesceKey?: string) =>
    blockOps.updateOfType(block.id, 'svg', recipe, coalesceKey ? { coalesceKey } : undefined)

  const setViewBox = (index: number, value: number) => {
    update((draft) => {
      const next = [...draft.viewBox] as [number, number, number, number]
      next[index] = value
      draft.viewBox = next
    }, `viewbox-${block.id}`)
  }

  return (
    <Section title={t('editor.inspector.sectionSvg')}>
      <Field label={t('editor.inspector.svgViewBox')}>
        <Row cols={4}>
          {(['x', 'y', 'w', 'h'] as const).map((key, index) => (
            <NumberInput
              key={key}
              value={block.viewBox[index]}
              min={index >= 2 ? 1 : undefined}
              onValueChange={(value) => setViewBox(index, value)}
            />
          ))}
        </Row>
      </Field>

      <Field label={t('editor.inspector.svgAnimate')}>
        <Select
          value={block.animate}
          onValueChange={(animate) => update((draft) => { draft.animate = animate })}
          options={SVG_ANIMATES.map((animate) => ({ value: animate, label: t(SVG_ANIMATE_KEYS[animate]) }))}
        />
      </Field>

      <Button
        variant="outline"
        block
        icon={<Sparkles size={13} />}
        onClick={() => {
          const mounted = openStudio({ kind: 'svg', blockId: block.id })
          if (!mounted) pushToast({ kind: 'info', message: t('editor.toast.studioPending') })
        }}
      >
        {t('editor.inspector.openSvgStudio')}
      </Button>
      <p className="insp-note">{t('editor.inspector.svgStudioHint')}</p>
    </Section>
  )
}

/* --------------------------------- three -------------------------------- */

export function ThreeSection({ block }: { block: ThreeBlock }) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const descriptor = block.descriptor

  const mutate = (
    recipe: (draft: ThreeBlock) => void,
    opts?: { coalesceKey?: string; label?: string },
  ) => blockOps.updateOfType(block.id, 'three', recipe, opts)

  const updateDescriptor = (recipe: (draft: ThreeBlock['descriptor']) => void, coalesceKey?: string) =>
    mutate((draft) => { recipe(draft.descriptor) }, coalesceKey ? { coalesceKey } : { label: 'three-structure' })

  return (
    <Section title={t('editor.inspector.sectionThree')}>
      <Field label={t('editor.inspector.threePreset')}>
        <Select
          value={descriptor.preset}
          onValueChange={(preset) => updateDescriptor((draft) => { draft.preset = preset })}
          options={(
            ['orbit', 'showcase', 'wave-field', 'particle-cloud', 'torus', 'stack', 'globe'] as const
          ).map((preset) => ({
            value: preset,
            label: t(`studio.three.presets.${preset}` as MessageKey),
          }))}
        />
      </Field>

      <Row cols={2}>
        <Field label={t('editor.inspector.threePalette')}>
          <Segmented
            value={descriptor.palette}
            block
            onValueChange={(palette) => updateDescriptor((draft) => { draft.palette = palette })}
            options={(['accent', 'mono', 'duotone'] as const).map((palette) => ({
              value: palette,
              label: t(`editor.inspector.palettes.${palette}` as MessageKey),
            }))}
          />
        </Field>
        <Field label={t('editor.inspector.threeLight')}>
          <Select
            value={descriptor.light}
            onValueChange={(light) => updateDescriptor((draft) => { draft.light = light })}
            options={(['studio', 'sunset', 'neon', 'soft'] as const).map((light) => ({
              value: light,
              label: t(`editor.inspector.lights.${light}` as MessageKey),
            }))}
          />
        </Field>
      </Row>

      <Field label={t('editor.inspector.threeDistance')}>
        <div className="insp-inline">
          <Slider
            value={descriptor.camera.distance}
            min={1.6}
            max={24}
            step={0.1}
            ariaLabel={t('editor.inspector.threeDistance')}
            onValueChange={(distance) =>
              updateDescriptor((draft) => { draft.camera.distance = distance }, `cam-d-${block.id}`)
            }
          />
          <NumberInput
            value={descriptor.camera.distance}
            min={1.6}
            max={24}
            step={0.1}
            onValueChange={(distance) =>
              updateDescriptor((draft) => { draft.camera.distance = distance }, `cam-d-${block.id}`)
            }
          />
        </div>
      </Field>

      <Field label={t('editor.inspector.threeElevation')}>
        <Slider
          value={descriptor.camera.elevation}
          min={-0.9}
          max={1.1}
          step={0.02}
          ariaLabel={t('editor.inspector.threeElevation')}
          onValueChange={(elevation) =>
            updateDescriptor((draft) => { draft.camera.elevation = elevation }, `cam-e-${block.id}`)
          }
        />
      </Field>

      <Row cols={2}>
        <Field label={t('editor.inspector.threeMotionKind')}>
          <Select
            value={descriptor.motion.kind}
            onValueChange={(kind) => updateDescriptor((draft) => { draft.motion.kind = kind })}
            options={(['rotate', 'float', 'pulse', 'none'] as const).map((kind) => ({
              value: kind,
              label: t(`editor.inspector.motions.${kind === 'none' ? 'still' : kind}` as MessageKey),
            }))}
          />
        </Field>
        <Field label={t('editor.inspector.threeSpeed')}>
          <NumberInput
            value={descriptor.motion.speed}
            min={0}
            max={2}
            step={0.02}
            onValueChange={(speed) => updateDescriptor((draft) => { draft.motion.speed = speed }, `speed-${block.id}`)}
          />
        </Field>
      </Row>

      <Field label={t('editor.inspector.threeObjects')} hint={t('editor.inspector.threeObjectsHint')}>
        <div className="insp-object__list">
          {descriptor.objects.length === 0 ? (
            <p className="insp-note">{t('editor.inspector.threeObjectEmpty')}</p>
          ) : null}
          {descriptor.objects.map((object, index) => (
            <ObjectRow
              key={index}
              object={object}
              index={index}
              onChange={(recipe, coalesce) =>
                mutate(
                  (draft) => { recipe(draft.descriptor.objects[index]) },
                  coalesce ? { coalesceKey: `obj-${block.id}-${index}` } : { label: 'three-objects' },
                )
              }
              onRemove={() =>
                mutate((draft) => { draft.descriptor.objects.splice(index, 1) }, { label: 'three-objects' })
              }
            />
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          block
          icon={<Plus size={13} />}
          onClick={() =>
            mutate((draft) => { draft.descriptor.objects.push(threeObjectSchema.parse({})) }, { label: 'three-objects' })
          }
        >
          {t('editor.inspector.threeAddObject')}
        </Button>
      </Field>

      <Button
        variant="outline"
        block
        icon={<Sparkles size={13} />}
        onClick={() => {
          const mounted = openStudio({ kind: 'three', blockId: block.id })
          if (!mounted) pushToast({ kind: 'info', message: t('editor.toast.studioPending') })
        }}
      >
        {t('editor.inspector.openThreeStudio')}
      </Button>
    </Section>
  )
}

function ObjectRow({
  object,
  index,
  onChange,
  onRemove,
}: {
  object: ThreeObject
  index: number
  onChange: (recipe: (draft: ThreeObject) => void, coalesce?: boolean) => void
  onRemove: () => void
}) {
  const t = useT()
  return (
    <div className="insp-object">
      <div className="insp-object__head">
        <span>#{index + 1}</span>
        <IconButton
          size="sm"
          tone="danger"
          icon={<Trash2 size={12} />}
          label={t('editor.inspector.threeObjectRemove')}
          onClick={onRemove}
        />
      </div>
      <Row cols={2}>
        <Field label={t('editor.inspector.threeObjectShape')}>
          <Select
            value={object.shape}
            onValueChange={(shape) => onChange((draft) => { draft.shape = shape })}
            options={THREE_SHAPES.map((shape) => ({
              value: shape,
              label: t(`editor.inspector.threeShapes.${shape}` as MessageKey),
            }))}
          />
        </Field>
        <Field label={t('editor.inspector.threeObjectMaterial')}>
          <Select
            value={object.material}
            onValueChange={(material) => onChange((draft) => { draft.material = material })}
            options={THREE_MATERIALS.map((material) => ({
              value: material,
              label: t(`editor.inspector.materials.${material}` as MessageKey),
            }))}
          />
        </Field>
      </Row>
      <Row cols={2}>
        <Field label={t('editor.inspector.threeObjectTint')}>
          <Select
            value={object.tint}
            onValueChange={(tint) => onChange((draft) => { draft.tint = tint })}
            options={THREE_TINTS.map((tint) => ({ value: tint, label: tint }))}
          />
        </Field>
        <Field label={t('editor.inspector.threeObjectScale')}>
          <NumberInput
            value={object.scale}
            min={0.05}
            max={6}
            step={0.05}
            onValueChange={(scale) => onChange((draft) => { draft.scale = scale }, true)}
          />
        </Field>
      </Row>
    </div>
  )
}

/* --------------------------------- html --------------------------------- */

export function HtmlSection({ block }: { block: HtmlBlock }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <Section title={t('editor.inspector.sectionHtml')}>
      <Button variant="outline" block icon={<Code2 size={13} />} onClick={() => setOpen(true)}>
        {t('editor.inspector.openHtmlEditor')}
      </Button>
      <p className="insp-note">{t('editor.insert.insertHtmlHint')}</p>
      <p className="insp-char">{t('editor.inspector.htmlSize', { count: block.html.length + (block.css?.length ?? 0) })}</p>
      <HtmlEditorDialog block={block} open={open} onClose={() => setOpen(false)} />
    </Section>
  )
}
