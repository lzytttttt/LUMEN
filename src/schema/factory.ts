/**
 * factory.ts —— 默认值的唯一出处。
 * 所有"新建元素/新建幕/空演示"都走这里，保证字段默认值与 zod 默认值一致。
 */
import type { z } from 'zod'
import {
  SCHEMA_VERSION,
  blockSchema,
  deckSchema,
  htmlBlockSchema,
  imageBlockSchema,
  shapeBlockSchema,
  slideSchema,
  svgBlockSchema,
  textBlockSchema,
  threeBlockSchema,
  type Block,
  type BlockType,
  type Deck,
  type HtmlBlock,
  type ImageBlock,
  type ShapeBlock,
  type Slide,
  type SvgBlock,
  type TextBlock,
  type ThreeBlock,
} from './deck'
import { newId } from './ids'

const schemaByType: Record<BlockType, z.ZodTypeAny> = {
  text: textBlockSchema,
  shape: shapeBlockSchema,
  image: imageBlockSchema,
  svg: svgBlockSchema,
  three: threeBlockSchema,
  html: htmlBlockSchema,
}

export function makeBlock(type: BlockType, patch: Record<string, unknown> = {}): Block {
  const schema = schemaByType[type]
  const parsed = schema.parse({
    id: newId(type),
    x: 120,
    y: 96,
    w: 520,
    h: 180,
    ...patch,
    type,
  })
  return parsed as Block
}

export function makeText(patch: Partial<TextBlock> = {}): TextBlock {
  return makeBlock('text', patch) as TextBlock
}

export function makeShape(patch: Partial<ShapeBlock> = {}): ShapeBlock {
  return makeBlock('shape', patch) as ShapeBlock
}

export function makeImage(patch: Partial<ImageBlock> = {}): ImageBlock {
  return makeBlock('image', patch) as ImageBlock
}

export function makeSvg(patch: Partial<SvgBlock> = {}): SvgBlock {
  return makeBlock('svg', patch) as SvgBlock
}

export function makeThree(patch: Partial<ThreeBlock> = {}): ThreeBlock {
  return makeBlock('three', patch) as ThreeBlock
}

export function makeHtml(patch: Partial<HtmlBlock> = {}): HtmlBlock {
  return makeBlock('html', patch) as HtmlBlock
}

export function makeSlide(patch: Record<string, unknown> = {}): Slide {
  return slideSchema.parse({
    id: newId('slide'),
    blocks: [],
    ...patch,
  }) as Slide
}

export function emptyDeck(title = '未命名演示', lang: 'zh' | 'en' = 'zh'): Deck {
  return deckSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: newId('deck'),
    title,
    lang,
    themeId: 'noir',
    slides: [makeSlide({ name: lang === 'zh' ? '封面' : 'Cover' })],
    meta: { createdAt: Date.now(), updatedAt: Date.now(), origin: 'manual' },
  }) as Deck
}

/** 空白 SVG 骨架（插入菜单用）。 */
export function blankSvgSource(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" fill="none">
  <circle cx="800" cy="450" r="240" stroke="var(--d-accent)" stroke-width="2"/>
  <path d="M560 450 H1040" stroke="var(--d-accent2)" stroke-width="2"/>
</svg>`
}

/** 空白 HTML 块内容（插入菜单用）。 */
export function blankHtmlSource(): string {
  return `<div class="card">
  <h3>Hello, HTML</h3>
  <p>这一段在沙箱 iframe 里运行，可以写任意标记、样式与内联脚本。</p>
</div>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #0f1115; color: #e8eaef; }
  .card { padding: 32px 36px; border: 1px solid rgba(255,255,255,.14); border-radius: 14px; }
  h3 { margin: 0 0 10px; font-size: 28px; letter-spacing: -.01em; }
  p { margin: 0; opacity: .72; line-height: 1.6; }
</style>`
}
