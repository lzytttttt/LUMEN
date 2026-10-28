/**
 * png.ts —— 逐幕位图导出（2× 默认）。
 *
 * 做法：把目标幕挂进一个离屏快照层（主题变量内联、1600×900、`mode='export'`），
 * 3D 块先用 `captureThreeFrame` 抓帧换成 `<img>`，再用 `html-to-image` 的 `toPng`
 * 以 `pixelRatio = scale` 光栅化，最后逐幕触发下载。
 *
 * 单幕失败（字体缺失 / 图片跨域 / 画布过大）只记 warning，不整体失败。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { toPng } from 'html-to-image'
import type { Deck, Slide } from '@/schema/deck'
import { slugify } from '@/schema/ids'
import { getTheme } from '@/themes'
import { t } from '@/i18n'
import { useUiStore } from '@/state/uiStore'
import { STAGE_H, STAGE_W } from '@/schema/deck'
import { triggerDownload } from './projectFile'
import { prepareSlideForSnapshot } from './threeFrames'
import { SnapshotStage } from './SnapshotStage'

export interface PngOptions {
  /** 只导出这一幕（缺省用 uiStore.activeSlideId / 全部幕）。 */
  slideId?: string
  /** 像素比，默认 2（1–4）。 */
  scale?: number
  /** panels 弹窗的范围开关：current = 只导当前幕。 */
  scope?: 'all' | 'current'
  /** 文件名主干（缺省用 deck.title）。 */
  fileName?: string
}

export interface PngResult {
  count: number
  warnings: string[]
}

const MIN_SCALE = 1
const MAX_SCALE = 4
/** 单幕等图片解码的上限：超时就按现状截图（宁可糊一点也别整幕失败）。 */
const IMAGE_WAIT_MS = 4000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampScale(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 2
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value as number))
}

/**
 * 等字体与图片解码就绪。
 * `expectedImages` 来自"换图之后的 slide"：图片是异步从资产库取的，
 * 只等 `img.complete` 会在"图还没进 DOM"时提前放行（3D 抓帧就会漏掉）。
 */
async function waitForSnapshotReady(host: HTMLElement, expectedImages: number): Promise<void> {
  try {
    await document.fonts?.ready
  } catch {
    /* 无字体接口时直接继续 */
  }
  const deadline = Date.now() + IMAGE_WAIT_MS
  while (Date.now() < deadline) {
    const images = Array.from(host.querySelectorAll('img'))
    const pending = images.filter((img) => !img.complete || img.naturalWidth === 0)
    if (images.length >= expectedImages && pending.length === 0) break
    await delay(50)
  }
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl)
  return response.blob()
}

/** 把一幕渲染成 PNG dataURL（公开给测试/其它导出器复用）。 */
export async function snapshotSlideToPng(deck: Deck, slide: Slide, scale = 2): Promise<string> {
  const prepared = await prepareSlideForSnapshot(deck, slide)
  const theme = getTheme(deck.themeId)
  const background = { ...theme.colors, ...(deck.themeOverrides ?? {}) }.bg

  const host = document.createElement('div')
  host.setAttribute('data-lumen-snapshot', '1')
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${STAGE_W}px;height:${STAGE_H}px;overflow:hidden;pointer-events:none;background:${background};`
  document.body.appendChild(host)

  const root = createRoot(host)
  try {
    root.render(createElement(SnapshotStage, { deck: prepared.deck, slide: prepared.slide }))
    const expectedImages = prepared.slide.blocks.filter((block) => block.type === 'image').length
    await waitForSnapshotReady(host, expectedImages)
    const target = (host.querySelector('[data-lumen-snapshot-frame]') ?? host) as HTMLElement
    return await toPng(target, {
      width: STAGE_W,
      height: STAGE_H,
      pixelRatio: clampScale(scale),
      backgroundColor: background,
      // 主题变量已在 SlideRenderer 根节点上内联；这里只兜住全局字体栈。
      style: { transform: 'none', margin: '0' },
    })
  } finally {
    try {
      root.unmount()
    } finally {
      host.remove()
    }
  }
}

function resolveTargets(deck: Deck, options: PngOptions, warnings: string[]): Array<{ index: number; slide: Slide }> {
  const explicit = options.slideId
  const currentOnly = options.scope === 'current'
  const wanted = explicit ?? (currentOnly ? useUiStore.getState().activeSlideId : null)
  if (!wanted) return deck.slides.map((slide, index) => ({ index, slide }))

  const index = deck.slides.findIndex((slide) => slide.id === wanted)
  if (index < 0) {
    warnings.push(t('export.warnSlideMissing'))
    return deck.slides.map((slide, i) => ({ index: i, slide }))
  }
  return [{ index, slide: deck.slides[index] }]
}

function downloadBlockedLikely(count: number): boolean {
  if (count <= 1) return false
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }).userActivation
  return activation ? activation.hasBeenActive === false : false
}

/**
 * 逐幕导出 PNG。返回成功张数与 warnings（失败不抛，交给调用方提示）。
 */
export async function exportPng(deck: Deck, options: PngOptions = {}): Promise<PngResult> {
  const warnings: string[] = []
  const scale = clampScale(options.scale)
  const targets = resolveTargets(deck, options, warnings)
  // 交互式 HTML 块是 iframe：跨文档内容无法序列化进 SVG foreignObject，位图里会是空白。
  const hasHtmlBlocks = deck.slides.some((slide) =>
    slide.blocks.some((block) => block.type === 'html' && !block.hidden),
  )
  if (hasHtmlBlocks) warnings.push(t('export.pngFallback'))
  const stem = slugify(options.fileName?.replace(/\.png$/i, '') ?? deck.title ?? 'lumen-deck')
  const files: Array<{ name: string; blob: Blob }> = []

  for (const { index, slide } of targets) {
    try {
      const dataUrl = await snapshotSlideToPng(deck, slide, scale)
      const blob = await dataUrlToBlob(dataUrl)
      if (blob.size === 0) throw new Error('empty image')
      const name = `${stem}-${String(index + 1).padStart(2, '0')}.png`
      files.push({ name, blob })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      warnings.push(t('export.pngSkipped', { index: index + 1, reason }))
      console.warn(`[export] 第 ${index + 1} 幕 PNG 失败`, error)
    }
  }

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    try {
      triggerDownload(file.blob, file.name)
    } catch (error) {
      warnings.push(t('export.pngBlocked'))
      console.warn('[export] 触发下载失败', error)
      break
    }
    // 多文件下载之间留点间隔，降低被浏览器判定为"批量下载"的概率。
    if (i < files.length - 1) await delay(260)
  }

  if (downloadBlockedLikely(files.length) && !warnings.includes(t('export.pngBlocked'))) {
    warnings.push(t('export.pngBlocked'))
  }

  return { count: files.length, warnings }
}

/** panels 的候选名兼容（exporterBridge 按名字探测）。 */
export const exportPngs = exportPng
export const exportSlidePng = exportPng
