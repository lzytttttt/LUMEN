/**
 * insertActions.ts —— 插入元素的统一动作（插入菜单、命令面板、快捷操作共用）。
 *
 * 落点规则统一走 insertGeometry（安全区中心）；插入后由 blockOps.add 负责 z 与选中。
 * 返回 false/null 表示用户取消或校验失败（已经 toast 过原因）。
 */
import type { ThreePreset, TextVariant } from '@/schema/deck'
import {
  blankHtmlSource,
  blankSvgSource,
  makeHtml,
  makeImage,
  makeShape,
  makeSvg,
  makeText,
  makeThree,
} from '@/schema/factory'
import { threeDescriptorSchema } from '@/schema/deck'
import { blockOps } from '@/state/ops'
import { useDeckStore } from '@/state/deckStore'
import { useUiStore } from '@/state/uiStore'
import { importImageFile } from '@/assets/assetStore'
import { readViewBox, sanitizeSvgDocument } from '@/render/svg/sanitize'
import type { SvgLibraryItem } from '@/studio/library'
import { openFilePicker } from '@/export/projectFile'
import { t } from '@/i18n'
import { centeredRect, rectForAspect } from '@/editor/panels/insertGeometry'

const TEXT_SAMPLES = {
  zh: {
    display: '一页只说一件事',
    h1: '一句话标题',
    h2: '小标题',
    lead: '副标题：用一句话说清这一段要证明什么。',
    body: '正文：双击这段文字即可直接改写；右侧检查器可以调整字阶、颜色与字距。',
    caption: '图注 / 小字',
    mono: 'const idea = "code"',
  },
  en: {
    display: 'One page, one idea',
    h1: 'A single-line title',
    h2: 'Subheading',
    lead: 'Lead: what this slide is proving, in one sentence.',
    body: 'Body: double-click to rewrite. The inspector on the right tunes scale, colour and tracking.',
    caption: 'Caption / small print',
    mono: 'const idea = "code"',
  },
} as const

type SampleVariant = keyof (typeof TEXT_SAMPLES)['zh']

const TEXT_SIZES: Record<SampleVariant, { w: number; h: number }> = {
  display: { w: 960, h: 240 },
  h1: { w: 900, h: 200 },
  h2: { w: 760, h: 140 },
  lead: { w: 760, h: 130 },
  body: { w: 720, h: 180 },
  caption: { w: 520, h: 60 },
  mono: { w: 640, h: 100 },
}

function langOf(): 'zh' | 'en' {
  return useDeckStore.getState().deck?.lang ?? 'zh'
}

function toast(kind: 'info' | 'success' | 'error', message: string) {
  if (message === '') return
  useUiStore.getState().pushToast({ kind, message })
}

/* --------------------------------- 文本 --------------------------------- */

export function insertText(variant: TextVariant = 'body'): void {
  const key: SampleVariant = variant in TEXT_SIZES ? (variant as SampleVariant) : 'body'
  const size = TEXT_SIZES[key]
  blockOps.add(
    makeText({
      ...centeredRect(size.w, size.h),
      text: TEXT_SAMPLES[langOf()][key],
      variant,
    }),
  )
}

/* --------------------------------- 形状 --------------------------------- */

export function insertShape(kind: 'rect' | 'ellipse' | 'line' | 'triangle' | 'rule' = 'rect'): void {
  const size = kind === 'line' || kind === 'rule' ? { w: 520, h: 8 } : { w: 480, h: 320 }
  blockOps.add(
    makeShape({
      ...centeredRect(size.w, size.h),
      kind,
      fill: kind === 'line' || kind === 'rule' ? 'accent' : 'surface',
      radius: kind === 'rect' ? 12 : undefined,
    }),
  )
}

/* --------------------------------- 图片 --------------------------------- */

export async function insertImageFromFile(file: File): Promise<boolean> {
  try {
    const meta = await importImageFile(file)
    const aspect = meta.w > 0 ? meta.h / meta.w : 9 / 16
    blockOps.add(
      makeImage({
        ...rectForAspect(720, aspect),
        assetId: meta.id,
        alt: file.name,
      }),
    )
    toast('success', t('editor.toast.imageInserted'))
    return true
  } catch (error) {
    toast('error', error instanceof Error ? error.message : String(error))
    return false
  }
}

/** 打开文件选择器插入图片；用户取消返回 false。 */
export async function pickAndInsertImage(): Promise<boolean> {
  const file = await openFilePicker('image/*')
  if (!file) return false
  return insertImageFromFile(file)
}

/* ---------------------------------- SVG --------------------------------- */

const VB_BLANK: [number, number, number, number] = [0, 0, 1600, 900]

export function insertBlankSvg(): void {
  blockOps.add(
    makeSvg({
      ...centeredRect(800, 450),
      source: blankSvgSource(),
      viewBox: VB_BLANK,
    }),
  )
  toast('success', t('editor.toast.svgInserted'))
}

export function insertLibrarySvg(item: SvgLibraryItem): void {
  const [, , vbW, vbH] = item.viewBox
  blockOps.add(
    makeSvg({
      ...rectForAspect(760, vbH / vbW),
      source: item.source,
      viewBox: item.viewBox,
      presetId: item.id,
    }),
  )
  toast('success', t('editor.toast.svgInserted'))
}

/**
 * 粘贴/上传的 SVG 源码：先净化再建块。
 * 返回被清理的问题数；`null` 表示无法渲染（已 toast）。
 */
export function insertSvgSource(source: string): number | null {
  const result = sanitizeSvgDocument(source)
  if (!result.svg) {
    toast('error', t('editor.insert.svgInvalid'))
    return null
  }
  const viewBox = readViewBox(result.svg) ?? VB_BLANK
  blockOps.add(
    makeSvg({
      ...rectForAspect(760, viewBox[3] / viewBox[2]),
      source: result.svg,
      viewBox,
    }),
  )
  toast('success', t('editor.toast.svgInserted'))
  return result.issues.length
}

/* --------------------------------- three -------------------------------- */

export function insertThree(preset: ThreePreset): void {
  blockOps.add(
    makeThree({
      ...centeredRect(760, 520),
      descriptor: threeDescriptorSchema.parse({ preset }),
    }),
  )
  toast('success', t('editor.toast.threeInserted'))
}

/* --------------------------------- html --------------------------------- */

export function insertHtml(): void {
  blockOps.add(
    makeHtml({
      ...centeredRect(760, 460),
      html: blankHtmlSource(),
    }),
  )
  toast('success', t('editor.toast.htmlInserted'))
}
