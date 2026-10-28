/**
 * threeFrames.ts —— 3D 幕的"抓帧 → 换成静态图"流程（打印与 PNG 共用）。
 *
 * 为什么必须换：打印与位图导出都不能指望 WebGL canvas 被浏览器正确捕获
 * （`window.print()` 面对 WebGL canvas 会掉成空白，`html-to-image` 对 canvas 也不稳定）。
 * 所以统一走《05-SVG与3D渲染》§2.11 的约定：
 *   1. 把目标幕以 `mode='export'` 挂载，等 `data-three-state="live"`；
 *   2. `captureThreeFrame(blockId)` 取 PNG；
 *   3. 用一张 `image` 块替换 `three` 块（几何/z/旋转/透明度/圆角全部保留）。
 *
 * 关键细节：抓帧时**改写 block id**（加 `lumenPrint_` 前缀），
 * 这样 three 运行时的注册表键与舞台上真实那一幕不冲突——否则会抢占并释放
 * 编辑器舞台上正在跑的 WebGL 上下文，导出后舞台会变空白。
 */
import { createRoot, type Root } from 'react-dom/client'
import { putAssetFromDataUrl } from '@/assets/assetStore'
import { makeImage } from '@/schema/factory'
import type { Block, Deck, ImageBlock, Slide, ThreeBlock } from '@/schema/deck'
import { getTheme } from '@/themes'
import { t } from '@/i18n'
import { SlideRenderer } from '@/render/SlideRenderer'
import { captureThreeFrame } from '@/render/three/runtime'

/** 抓帧专用的 id 前缀：与舞台上的 runtime 键隔离。 */
export const CAPTURE_ID_PREFIX = 'lumenPrint_'
/** 换图后写进资产库的 id 前缀（存的是 dataURL 对应的 Blob）。 */
export const POSTER_ASSET_PREFIX = 'lumenShot_'
/** 单幕抓帧的等待上限：超时就当这一块没有帧（走降级占位）。 */
export const FRAME_TIMEOUT_MS = 6000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isThreeBlock(block: Block): block is ThreeBlock {
  return block.type === 'three'
}

export function threeBlocksOf(slide: Slide): ThreeBlock[] {
  return slide.blocks.filter(isThreeBlock)
}

export function hasThreeBlocks(deck: Deck): boolean {
  return deck.slides.some((slide) => threeBlocksOf(slide).length > 0)
}

export function hasThreeInSlide(slide: Slide): boolean {
  return threeBlocksOf(slide).length > 0
}

/** 抓帧副本：id 换成 `lumenPrint_<id>`，其它字段原样。 */
export function toCaptureSlide(slide: Slide): { slide: Slide; keyById: Record<string, string> } {
  const keyById: Record<string, string> = {}
  const blocks = slide.blocks.map((block) => {
    if (!isThreeBlock(block)) return block
    const key = `${CAPTURE_ID_PREFIX}${block.id}`
    keyById[block.id] = key
    return { ...block, id: key }
  })
  return { slide: { ...slide, blocks }, keyById }
}

function threeStatesOf(host: HTMLElement): Array<{ id: string | null; state: string }> {
  return Array.from(host.querySelectorAll('.lumen-three')).map((node) => ({
    id: node.closest('.lumen-block')?.getAttribute('data-block-id') ?? null,
    state: node.getAttribute('data-three-state') ?? 'idle',
  }))
}

/** 等这一幕里所有 3D 块进入终态（live / fallback）。 */
async function waitForThreeSettled(host: HTMLElement, expected: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const states = threeStatesOf(host)
    if (states.length >= expected && states.every((s) => s.state === 'live' || s.state === 'fallback')) {
      return
    }
    await delay(50)
  }
}

interface CaptureResult {
  /** 原始 blockId → dataURL */
  frames: Record<string, string>
  warnings: string[]
}

/**
 * 逐幕抓一帧 3D 画面。一次只挂一幕，绝不同时创建多份 WebGL 上下文。
 */
export async function captureDeckThreeFrames(deck: Deck): Promise<CaptureResult> {
  const frames: Record<string, string> = {}
  const warnings: string[] = []
  if (typeof document === 'undefined' || !hasThreeBlocks(deck)) return { frames, warnings }

  for (const slide of deck.slides) {
    const blocks = threeBlocksOf(slide)
    if (blocks.length === 0) continue
    const { slide: captureSlide, keyById } = toCaptureSlide(slide)

    const host = document.createElement('div')
    host.setAttribute('data-lumen-capture', '1')
    host.style.cssText =
      'position:fixed;left:-20000px;top:0;width:1600px;height:900px;overflow:hidden;pointer-events:none;opacity:0.001;z-index:-1;'
    document.body.appendChild(host)

    let root: Root | null = null
    try {
      root = createRoot(host)
      root.render(<SlideRenderer deck={deck} slide={captureSlide} mode="export" active={false} />)
      await waitForThreeSettled(host, blocks.length, FRAME_TIMEOUT_MS)
      for (const block of blocks) {
        const key = keyById[block.id]
        const shot = key ? captureThreeFrame(key) : null
        if (shot) frames[block.id] = shot
      }
    } catch (error) {
      console.warn('[export] 3D 抓帧失败', error)
    } finally {
      try {
        root?.unmount()
      } catch {
        /* 卸载失败不阻塞后续幕 */
      }
      host.remove()
    }

    // 让这一幕的 runtime 有机会归还上下文，再开下一幕。
    await delay(40)
  }

  const missing = deck.slides
    .flatMap((slide) => threeBlocksOf(slide))
    .filter((block) => !frames[block.id])
  if (missing.length > 0) warnings.push(t('export.warnThreePoster'))
  return { frames, warnings }
}

/** 把抓到的帧登记进资产库，返回 blockId → assetId。 */
export async function registerThreePosters(frames: Record<string, string>): Promise<Record<string, string>> {
  const assetIdByBlock: Record<string, string> = {}
  await Promise.all(
    Object.entries(frames).map(async ([blockId, dataUrl]) => {
      const assetId = `${POSTER_ASSET_PREFIX}${blockId}`
      try {
        await putAssetFromDataUrl(assetId, dataUrl)
        assetIdByBlock[blockId] = assetId
      } catch (error) {
        console.warn('[export] 3D 帧写入资产库失败', error)
      }
    }),
  )
  return assetIdByBlock
}

/** three 块 → image 块：几何、层级、旋转、透明度、圆角全部照抄。 */
export function threeToImageBlock(block: ThreeBlock, assetId: string, radius: number): ImageBlock {
  return makeImage({
    id: block.id,
    ...(block.name ? { name: block.name } : {}),
    x: block.x,
    y: block.y,
    w: block.w,
    h: block.h,
    z: block.z,
    rotation: block.rotation,
    opacity: block.opacity,
    locked: block.locked,
    hidden: block.hidden,
    enter: block.enter,
    enterDelayMs: block.enterDelayMs,
    ...(block.provenance ? { provenance: block.provenance } : {}),
    assetId,
    fit: 'cover',
    radius,
    dim: 0,
    alt: `3D · ${block.descriptor.preset}`,
  })
}

/** 用抓到的帧替换一幕里的 3D 块；没有帧的块原样保留（交给渲染层降级）。 */
export function swapSlideThreeBlocks(
  slide: Slide,
  assetIdByBlock: Record<string, string>,
  radius: number,
): Slide {
  if (threeBlocksOf(slide).length === 0) return slide
  let changed = false
  const blocks = slide.blocks.map((block) => {
    if (!isThreeBlock(block)) return block
    const assetId = assetIdByBlock[block.id]
    if (!assetId) return block
    changed = true
    return threeToImageBlock(block, assetId, radius)
  })
  return changed ? { ...slide, blocks } : slide
}

export interface PreparedDeck {
  deck: Deck
  /** 被换掉的 3D 块数量（0 表示这一套没有 3D，或全部抓帧失败）。 */
  replaced: number
  warnings: string[]
}

/**
 * 打印/位图导出的统一入口：抓帧 → 登记资产 → 换成静态图。
 * 返回的是 **deck 副本**，原 deck 一个字段都不动。
 */
export async function prepareDeckForPrint(deck: Deck): Promise<PreparedDeck> {
  if (!hasThreeBlocks(deck)) return { deck, replaced: 0, warnings: [] }
  const { frames, warnings } = await captureDeckThreeFrames(deck)
  const assetIdByBlock = await registerThreePosters(frames)
  const radius = getTheme(deck.themeId).radius
  let replaced = 0
  const slides = deck.slides.map((slide) => {
    const next = swapSlideThreeBlocks(slide, assetIdByBlock, radius)
    if (next !== slide) replaced += threeBlocksOf(slide).length
    return next
  })
  return { deck: { ...deck, slides }, replaced, warnings }
}

/** 单幕版本（PNG 逐幕导出用）。 */
export async function prepareSlideForSnapshot(
  deck: Deck,
  slide: Slide,
): Promise<{ deck: Deck; slide: Slide; warnings: string[] }> {
  if (!hasThreeInSlide(slide)) return { deck, slide, warnings: [] }
  const oneSlideDeck: Deck = { ...deck, slides: [slide] }
  const { deck: preparedDeck } = await prepareDeckForPrint(oneSlideDeck)
  return {
    deck: preparedDeck,
    slide: preparedDeck.slides[0] ?? slide,
    warnings: [],
  }
}
