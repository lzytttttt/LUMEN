/**
 * three/ThreeStudio.tsx —— 3D 工作室。
 *
 * 信息架构：
 *   顶部  一句话生成（AI 端口）
 *   左列  16:9 实时预览（复用 `createThreeRuntime`）+ 抓帧
 *   右列  7 个 preset 卡片 / 调色 / 灯光 / 背景 / 相机 / 运动 / 颗粒 / 对象列表
 *   底部  descriptor JSON 复制 / 恢复预设 / 取消 / 应用到画布
 *
 * 数据纪律：
 * - 参数改动只改本地 descriptor（深拷贝后写），不碰 deck；
 * - 切预设 = `presetSceneDefaults(preset)`（objects 清空，提示里说明清掉了几个自定义对象）；
 * - 「应用到画布」才 `blockOps.add/makeThree` 或 `blockOps.replace`，并写入 provenance；
 * - 抓帧写 asset，`posterAssetId` 落到块上（导出/降级预览用）。
 */
import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { Camera, Check, Copy, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { MessageKey } from '@/i18n'
import { useT } from '@/i18n'
import {
  threeDescriptorSchema,
  threeObjectSchema,
  type ThemeColors,
  type ThreeBlock,
  type ThreeDescriptor,
  type ThreeObject,
  type ThreePreset,
} from '@/schema/deck'
import { makeThree } from '@/schema/factory'
import { newId, shortHash } from '@/schema/ids'
import { putAssetFromDataUrl } from '@/assets/assetStore'
import type { ThreeRuntime } from '@/render/three'
import { blockOps } from '@/state/ops'
import { useActiveSlide, useDeckTheme, useThemeOverrides } from '@/state/selectors'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { themeCssVars } from '@/themes'
import { Button, Field, IconButton, NumberInput, Row, Section, Segmented, Select, Slider, Switch } from '@/ui/primitives'
import { rectForAspect } from '@/studio/geometry'
import { GenerateBar } from '../ai/GenerateBar'
import { getStudioAiPort } from '../ai/port'
import {
  cloneDescriptor,
  defaultThreeDescriptor,
  MAX_THREE_OBJECTS,
  presetSceneDefaults,
  THREE_BACKGROUNDS,
  THREE_LIGHTS,
  THREE_MATERIALS,
  THREE_MOTIONS,
  THREE_PALETTES,
  THREE_PRESETS,
  THREE_SHAPES,
  THREE_SLIDE_BUDGET,
  THREE_TINTS,
} from './defaults'
import { ThreePreview } from './ThreePreview'

const MOTION_KEYS: Record<ThreeDescriptor['motion']['kind'], MessageKey> = {
  rotate: 'studio.three.motionRotate',
  float: 'studio.three.motionFloat',
  pulse: 'studio.three.motionPulse',
  none: 'studio.three.motionNone',
}

interface Generation {
  provider: string
  model?: string
  promptDigest: string
}

export interface ThreeStudioProps {
  /** 有值 = 编辑既有块；无值 = 新建流程。 */
  blockId?: string
  onClose: () => void
}

export function ThreeStudio({ blockId, onClose }: ThreeStudioProps) {
  const t = useT()
  const slide = useActiveSlide()
  const theme = useDeckTheme()
  const overrides = useThemeOverrides()
  const deck = useDeckStore((s) => s.deck)
  const pushToast = useUiStore((s) => s.pushToast)

  const colors = useMemo<ThemeColors>(() => ({ ...theme.colors, ...(overrides ?? {}) }), [theme, overrides])
  const cssVars = useMemo(() => themeCssVars(theme, overrides), [theme, overrides])

  const existing = useMemo<ThreeBlock | null>(() => {
    if (!blockId || !slide) return null
    const found = slide.blocks.find((block) => block.id === blockId)
    return found && found.type === 'three' ? found : null
  }, [blockId, slide])

  const [descriptor, setDescriptor] = useState<ThreeDescriptor>(() =>
    existing ? cloneDescriptor(existing.descriptor) : defaultThreeDescriptor(),
  )
  const [interactive, setInteractive] = useState(existing?.interactive ?? false)
  const [posterAssetId, setPosterAssetId] = useState<string | undefined>(existing?.posterAssetId)
  const [generation, setGeneration] = useState<Generation | null>(null)
  const runtimeRef = useRef<ThreeRuntime | null>(null)

  const toast = (kind: 'info' | 'success' | 'error', message: string) => pushToast({ kind, message })

  const threeCount = useMemo(() => {
    if (!deck) return 0
    return deck.slides.reduce((sum, item) => sum + item.blocks.filter((block) => block.type === 'three').length, 0)
  }, [deck])

  /* ------------------------------- descriptor ------------------------------ */

  const patch = (recipe: (draft: ThreeDescriptor) => void) => {
    setDescriptor((current) => {
      const next = cloneDescriptor(current)
      recipe(next)
      return next
    })
  }

  const patchObject = (index: number, recipe: (object: ThreeObject) => void) => {
    patch((draft) => {
      const object = draft.objects[index]
      if (object) recipe(object)
    })
  }

  const addObject = () => {
    if (descriptor.objects.length >= MAX_THREE_OBJECTS) {
      toast('info', t('studio.three.addObjectMax'))
      return
    }
    patch((draft) => {
      draft.objects.push(threeObjectSchema.parse({}))
    })
  }

  const removeObject = (index: number) => {
    patch((draft) => {
      draft.objects.splice(index, 1)
    })
  }

  const switchPreset = (preset: ThreePreset) => {
    const cleared = descriptor.objects.length
    setDescriptor(presetSceneDefaults(preset))
    if (cleared > 0) {
      toast(
        'info',
        t('studio.three.objectsCleared', {
          preset: t(`studio.three.presets.${preset}` as MessageKey),
          count: cleared,
        }),
      )
    }
  }

  const resetPreset = () => {
    setDescriptor(presetSceneDefaults(descriptor.preset))
    toast('info', t('studio.three.resetDone'))
  }

  /* --------------------------------- 抓帧 --------------------------------- */

  const capture = async () => {
    const runtime = runtimeRef.current
    const dataUrl = runtime ? runtime.capture() : null
    if (!dataUrl) {
      toast('error', t('studio.three.captureFailed'))
      return
    }
    try {
      const assetId = newId('asset')
      await putAssetFromDataUrl(assetId, dataUrl)
      setPosterAssetId(assetId)
      toast('success', t('studio.three.captureReady'))
    } catch {
      toast('info', t('studio.three.captured'))
    }
  }

  const copyDescriptor = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ ...descriptor, orbitControls: interactive }, null, 2))
      toast('success', t('studio.three.copiedDescriptor'))
    } catch {
      toast('error', t('studio.common.copyFailed'))
    }
  }

  /* ---------------------------------- AI ---------------------------------- */

  const generate = async (prompt: string, signal: AbortSignal) => {
    const port = await getStudioAiPort()
    if (!port) throw new Error(t('studio.ai.notReady'))
    const result = await port.generateThreeScene(prompt, { signal })
    const parsed = threeDescriptorSchema.safeParse(result.descriptor)
    if (!parsed.success) throw new Error(t('studio.ai.invalidThree'))
    setDescriptor(parsed.data)
    setPosterAssetId(undefined)
    setGeneration({ provider: result.provider, model: result.model, promptDigest: shortHash(prompt) })
    toast('success', t('studio.ai.generatedThree'))
  }

  /* -------------------------------- 应用到画布 ------------------------------ */

  const apply = () => {
    const parsed = threeDescriptorSchema.safeParse({ ...descriptor, orbitControls: interactive })
    if (!parsed.success) {
      toast('error', t('studio.ai.invalidThree'))
      return
    }
    const finalDescriptor = parsed.data
    const provenance = {
      provider: generation?.provider ?? 'manual',
      model: generation?.model,
      promptDigest: generation?.promptDigest,
      at: Date.now(),
      note: generation ? 'three-studio:ai' : 'three-studio',
    }

    if (existing) {
      blockOps.replace({
        ...existing,
        descriptor: finalDescriptor,
        interactive,
        posterAssetId: posterAssetId ?? existing.posterAssetId,
        provenance,
      })
    } else {
      blockOps.add(
        makeThree({
          ...rectForAspect(880, 9 / 16),
          descriptor: finalDescriptor,
          interactive,
          posterAssetId,
          provenance,
        }),
      )
    }
    toast('success', t('studio.three.applied'))
    onClose()
  }

  const budgetOver = threeCount > THREE_SLIDE_BUDGET

  return (
    <div className="st-root st-three">
      <GenerateBar kind="three" onGenerate={generate} />

      <div className="st-three__body">
        <div className="st-three__preview">
          <div className="st-three__frame" style={cssVars as CSSProperties}>
            <ThreePreview
              descriptor={descriptor}
              colors={colors}
              fallbackLabel={t('studio.three.webglMissing')}
              onRuntime={(runtime) => {
                runtimeRef.current = runtime
              }}
            />
          </div>
          <div className="st-three__preview-foot">
            <span className="st-three__tag">{t('studio.three.preview')}</span>
            <span className="st-three__tag">{t(`studio.three.presets.${descriptor.preset}` as MessageKey)}</span>
            <span className="st-actions__spacer" />
            <Button size="sm" variant="ghost" icon={<Camera size={12} />} onClick={() => void capture()}>
              {t('studio.three.capture')}
            </Button>
          </div>
        </div>

        <div className="st-three__controls lumen-scroll">
          <Section title={t('studio.three.preset')}>
            <div className="st-presets">
              {THREE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={descriptor.preset === preset ? 'st-presets__card st-presets__card--active' : 'st-presets__card'}
                  aria-pressed={descriptor.preset === preset}
                  onClick={() => switchPreset(preset)}
                >
                  <span className="st-presets__orb" data-preset={preset} />
                  <span className="st-presets__name">{t(`studio.three.presets.${preset}` as MessageKey)}</span>
                </button>
              ))}
            </div>
          </Section>

          <Section title={t('studio.three.palette')}>
            <Segmented
              block
              value={descriptor.palette}
              onValueChange={(palette) => patch((draft) => { draft.palette = palette })}
              options={THREE_PALETTES.map((palette) => ({
                value: palette,
                label: t(`studio.three.palettes.${palette}` as MessageKey),
              }))}
            />
            <Row cols={2}>
              <Field label={t('studio.three.light')}>
                <Select
                  value={descriptor.light}
                  onValueChange={(light) => patch((draft) => { draft.light = light })}
                  options={THREE_LIGHTS.map((light) => ({
                    value: light,
                    label: t(`studio.three.lights.${light}` as MessageKey),
                  }))}
                />
              </Field>
              <Field label={t('studio.three.background')}>
                <Select
                  value={descriptor.bg}
                  onValueChange={(bg) => patch((draft) => { draft.bg = bg })}
                  options={THREE_BACKGROUNDS.map((bg) => ({
                    value: bg,
                    label: t(`studio.three.backgrounds.${bg}` as MessageKey),
                  }))}
                />
              </Field>
            </Row>
          </Section>

          <Section title={t('studio.three.camera')}>
            <Field label={`${t('studio.three.distance')} · ${descriptor.camera.distance.toFixed(1)}`}>
              <div className="st-inline">
                <Slider
                  value={descriptor.camera.distance}
                  min={2}
                  max={16}
                  step={0.1}
                  ariaLabel={t('studio.three.distance')}
                  onValueChange={(distance) => patch((draft) => { draft.camera.distance = distance })}
                />
                <NumberInput
                  value={descriptor.camera.distance}
                  min={2}
                  max={16}
                  step={0.1}
                  onValueChange={(distance) => patch((draft) => { draft.camera.distance = distance })}
                />
              </div>
            </Field>
            <Field label={`${t('studio.three.elevation')} · ${descriptor.camera.elevation.toFixed(2)}`}>
              <Slider
                value={descriptor.camera.elevation}
                min={-0.6}
                max={0.9}
                step={0.02}
                ariaLabel={t('studio.three.elevation')}
                onValueChange={(elevation) => patch((draft) => { draft.camera.elevation = elevation })}
              />
            </Field>
            <Field label={`${t('studio.three.fov')} · ${Math.round(descriptor.camera.fov)}°`}>
              <Slider
                value={descriptor.camera.fov}
                min={20}
                max={70}
                step={1}
                ariaLabel={t('studio.three.fov')}
                onValueChange={(fov) => patch((draft) => { draft.camera.fov = fov })}
              />
            </Field>
          </Section>

          <Section title={t('studio.three.motion')}>
            <Segmented
              block
              value={descriptor.motion.kind}
              onValueChange={(kind) => patch((draft) => { draft.motion.kind = kind })}
              options={THREE_MOTIONS.map((kind) => ({ value: kind, label: t(MOTION_KEYS[kind]) }))}
            />
            <Field label={`${t('studio.three.speed')} · ${descriptor.motion.speed.toFixed(2)}`}>
              <Slider
                value={descriptor.motion.speed}
                min={0}
                max={2}
                step={0.02}
                ariaLabel={t('studio.three.speed')}
                onValueChange={(speed) => patch((draft) => { draft.motion.speed = speed })}
              />
            </Field>
            <Field label={`${t('studio.three.grain')} · ${Math.round(descriptor.grain * 100)}%`}>
              <Slider
                value={descriptor.grain}
                min={0}
                max={1}
                step={0.01}
                ariaLabel={t('studio.three.grain')}
                onValueChange={(grain) => patch((draft) => { draft.grain = grain })}
              />
            </Field>
            <Field label={t('studio.three.interactive')}>
              <Switch checked={interactive} onCheckedChange={setInteractive} label={t('studio.three.interactive')} />
            </Field>
          </Section>

          <Section
            title={t('studio.three.objects')}
            actions={<span className="st-chip">{descriptor.objects.length}</span>}
          >
            {descriptor.objects.length === 0 ? <p className="st-note">{t('studio.three.objectsEmpty')}</p> : null}

            {descriptor.objects.map((object, index) => (
              <div className="st-object" key={index}>
                <div className="st-object__head">
                  <span className="st-object__index">#{index + 1}</span>
                  <IconButton
                    size="sm"
                    tone="danger"
                    icon={<Trash2 size={12} />}
                    label={t('studio.three.removeObject')}
                    onClick={() => removeObject(index)}
                  />
                </div>
                <Row cols={2}>
                  <Field label={t('studio.three.shape')}>
                    <Select
                      value={object.shape}
                      onValueChange={(shape) => patchObject(index, (draft) => { draft.shape = shape })}
                      options={THREE_SHAPES.map((shape) => ({
                        value: shape,
                        label: t(`studio.three.shapes.${shape}` as MessageKey),
                      }))}
                    />
                  </Field>
                  <Field label={t('studio.three.material')}>
                    <Select
                      value={object.material}
                      onValueChange={(material) => patchObject(index, (draft) => { draft.material = material })}
                      options={THREE_MATERIALS.map((material) => ({
                        value: material,
                        label: t(`studio.three.materials.${material}` as MessageKey),
                      }))}
                    />
                  </Field>
                </Row>
                <Row cols={2}>
                  <Field label={t('studio.three.tint')}>
                    <Select
                      value={object.tint}
                      onValueChange={(tint) => patchObject(index, (draft) => { draft.tint = tint })}
                      options={THREE_TINTS.map((tint) => ({
                        value: tint,
                        label: t(`studio.three.tints.${tint}` as MessageKey),
                      }))}
                    />
                  </Field>
                  <Field label={t('studio.three.scale')}>
                    <NumberInput
                      value={object.scale}
                      min={0.05}
                      max={6}
                      step={0.05}
                      onValueChange={(scale) => patchObject(index, (draft) => { draft.scale = scale })}
                    />
                  </Field>
                </Row>
                <Field label={`${t('studio.three.metalness')} · ${(object.metalness ?? 0.42).toFixed(2)}`}>
                  <Slider
                    value={object.metalness ?? 0.42}
                    min={0}
                    max={1}
                    step={0.01}
                    ariaLabel={t('studio.three.metalness')}
                    onValueChange={(metalness) => patchObject(index, (draft) => { draft.metalness = metalness })}
                  />
                </Field>
                <Field label={`${t('studio.three.roughness')} · ${(object.roughness ?? 0.34).toFixed(2)}`}>
                  <Slider
                    value={object.roughness ?? 0.34}
                    min={0}
                    max={1}
                    step={0.01}
                    ariaLabel={t('studio.three.roughness')}
                    onValueChange={(roughness) => patchObject(index, (draft) => { draft.roughness = roughness })}
                  />
                </Field>
              </div>
            ))}

            <Button size="sm" variant="outline" block icon={<Plus size={13} />} onClick={addObject}>
              {t('studio.three.addObject')}
            </Button>
          </Section>
        </div>
      </div>

      <div className="st-actions">
        <span className="st-actions__info lumen-truncate" data-warn={budgetOver ? 'true' : undefined}>
          {budgetOver
            ? t('studio.three.budgetWarn', { count: threeCount, limit: THREE_SLIDE_BUDGET })
            : t('studio.three.budget')}
        </span>
        <span className="st-actions__spacer" />
        <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={resetPreset}>
          {t('studio.three.reset')}
        </Button>
        <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => void copyDescriptor()}>
          {t('studio.three.copyDescriptor')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('studio.common.cancel')}
        </Button>
        <Button variant="primary" icon={<Check size={13} />} onClick={apply}>
          {existing ? t('studio.three.replace') : t('studio.three.insert')}
        </Button>
      </div>
    </div>
  )
}
