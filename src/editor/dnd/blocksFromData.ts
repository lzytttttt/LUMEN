/**
 * blocksFromData.ts —— 文件 / 剪贴板 → 块的转换（拖放与粘贴共用）。
 *
 * 规则：
 * - 图片：`importImageFile` 落库（WebP），按原比例插入，最大 720×720；
 * - `.svg`：读文本 → `sanitizeSvgDocument` → 自动带 viewBox 的 svg 块；
 * - `.html/.htm`：html 块；
 * - 剪贴板：`image/png` 等 → 图片块；`text/plain` 含 `<svg` → SVG 块；含标签 → html 块。
 *
 * 只产出"块 + 尺寸"，落点由调用方决定（stage 负责居中与安全边距）。
 */
import type { Block } from '@/schema/deck'
import { t } from '@/i18n'
import { importImageFile } from '@/assets/assetStore'
import { makeHtml, makeImage, makeSvg, makeText } from '@/schema/factory'
import { readViewBox, sanitizeSvgDocument } from '@/render/svg/sanitize'
import { fitSize } from '@/editor/stage/geometry'

export interface InsertOutcome {
  blocks: Block[]
  issues: string[]
}

/** 拖放素材的最大边长（设计像素）。 */
export const MAX_DROP_SIZE = 720
const MAX_HTML_BYTES = 200 * 1024
const HTML_TAG_RE = /<([a-z][\w:-]*)(\s[^>]*)?\/?>/i
const SVG_TAG_RE = /<svg[\s>]/i

export function hasFileDrag(data: DataTransfer | null): boolean {
  if (!data) return false
  return Array.from(data.types ?? []).includes('Files')
}

export function hasAnyDrag(data: DataTransfer | null): boolean {
  if (!data) return false
  return Array.from(data.types ?? []).length > 0
}

/** svg 源码 → svg 块（净化 + viewBox + 保比例尺寸）。 */
function svgBlockFromSource(source: string, issues: string[]): Block | null {
  const result = sanitizeSvgDocument(source)
  if (!result.svg) {
    issues.push(t('editor.stage.svgFailed'))
    return null
  }
  const viewBox = readViewBox(result.svg) ?? ([0, 0, 1600, 900] as [number, number, number, number])
  const size = fitSize(viewBox[2], viewBox[3], MAX_DROP_SIZE, MAX_DROP_SIZE)
  return makeSvg({ source: result.svg, viewBox, w: size.w, h: size.h })
}

/** 纯文本 / 源码 → 块。只识别 SVG 与 HTML 片段。 */
export function blocksFromPlainText(raw: string): InsertOutcome {
  const text = raw.trim()
  if (text === '') return { blocks: [], issues: [] }
  const issues: string[] = []
  if (SVG_TAG_RE.test(text)) {
    const block = svgBlockFromSource(text, issues)
    return { blocks: block ? [block] : [], issues }
  }
  if (HTML_TAG_RE.test(text)) {
    return {
      blocks: [makeHtml({ html: text.slice(0, MAX_HTML_BYTES), w: 720, h: 420 })],
      issues: [],
    }
  }
  return { blocks: [], issues }
}

/** 拖入的文件 → 块（异步：图片要解码 + 落库）。 */
export async function blocksFromFiles(files: readonly File[]): Promise<InsertOutcome> {
  const blocks: Block[] = []
  const issues: string[] = []

  for (const file of files) {
    const type = file.type.toLowerCase()
    const name = file.name.toLowerCase()

    if (type === 'image/svg+xml' || name.endsWith('.svg')) {
      const block = svgBlockFromSource(await file.text(), issues)
      if (block) blocks.push(block)
      continue
    }

    if (type.startsWith('image/')) {
      try {
        const meta = await importImageFile(file)
        const size = fitSize(meta.w, meta.h, MAX_DROP_SIZE, MAX_DROP_SIZE)
        blocks.push(makeImage({ assetId: meta.id, w: size.w, h: size.h, alt: file.name }))
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error))
      }
      continue
    }

    if (type === 'text/html' || name.endsWith('.html') || name.endsWith('.htm')) {
      const html = await file.text()
      blocks.push(makeHtml({ html: html.slice(0, MAX_HTML_BYTES), w: 720, h: 420 }))
      continue
    }

    if (type === 'text/plain' || name.endsWith('.txt') || name.endsWith('.md')) {
      const text = (await file.text()).slice(0, 6000)
      const outcome = blocksFromPlainText(text)
      if (outcome.blocks.length > 0) {
        blocks.push(...outcome.blocks)
        issues.push(...outcome.issues)
      } else {
        blocks.push(
          makeText({
            text,
            variant: 'body',
            w: 640,
            h: Math.min(400, 48 + Math.ceil(text.length / 48) * 40),
          }),
        )
      }
      continue
    }

    issues.push(t('editor.stage.unsupportedFile', { name: file.name }))
  }

  return { blocks, issues }
}

/** 系统剪贴板 → 块。 */
export async function blocksFromClipboardData(data: DataTransfer | null): Promise<InsertOutcome> {
  if (!data) return { blocks: [], issues: [] }

  const files: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  if (files.length > 0) return blocksFromFiles(files)

  const plain = data.getData('text/plain')
  if (plain) return blocksFromPlainText(plain)
  const html = data.getData('text/html')
  if (html) return blocksFromPlainText(html)
  return { blocks: [], issues: [] }
}
