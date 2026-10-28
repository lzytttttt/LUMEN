/**
 * svg/document.ts —— SVG 源码的结构化工具（字符串进 / 字符串出，不缓存 DOM）。
 *
 * 分工：
 * - 净化只有一个入口（`@/render/svg/sanitize`），本文件只在**净化产物**上做结构化编辑；
 * - 结构编辑（改 id / 隐藏 / 换色 / 变换 / 视图框）都是「解析 → 改 → 可读化序列化」，
 *   所以树里的改动会把源码规范化为净化后的形式（UI 里有明确提示）；
 * - 解析失败一律返回 null / 空结果，由调用方展示 issues，绝不猜测内容。
 */
import type { SvgIssue } from '@/render/svg/sanitize'
import { sanitizeSvgDocument } from '@/render/svg/sanitize'

export type ViewBoxTuple = [number, number, number, number]

/** 一个元素节点在文档里的稳定定位：`path` 是「从根开始逐层的元素下标链」，根是 `[]`。 */
export interface SvgNodeInfo {
  /** 文档顺序序号（从 0 开始，根为 0），也是预览里的 `data-lumen-node` 标记。 */
  index: number
  path: number[]
  depth: number
  /** 作者书写的标签名（保留 linearGradient 等大小写）。 */
  tag: string
  id?: string
  className?: string
  label: string
  hidden: boolean
  fill?: string
  stroke?: string
  opacity?: string
  transform?: string
}

export interface SvgAnalysis {
  nodes: SvgNodeInfo[]
  /** 带 `data-lumen-node` 的预览用标记（只用于工作室预览，不会写进块）。 */
  annotated: string
  viewBox: ViewBoxTuple | null
}

export interface SvgNodePatch {
  /** null / 空串 = 删除该属性。 */
  id?: string | null
  hidden?: boolean
  fill?: string | null
  stroke?: string | null
  opacity?: number | null
  transform?: string | null
}

export interface SvgDiagnosis {
  /** 净化后的源码；不可渲染时为 ''。 */
  sanitized: string
  issues: SvgIssue[]
  /** 是否有可渲染内容（应用按钮据此启用）。 */
  ok: boolean
  parseError: string | null
  viewBox: ViewBoxTuple | null
  bytes: number
}

const DEFAULT_VIEW_BOX: ViewBoxTuple = [0, 0, 1600, 900]
const NODE_ATTR = 'data-lumen-node'

/* ------------------------------- 解析 / 序列化 ------------------------------ */

function parseSvg(markup: string): Document | null {
  if (typeof DOMParser === 'undefined') return null
  if (markup.trim() === '') return null
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
  } catch {
    return null
  }
  const root = doc.documentElement
  if (!root) return null
  if (root.nodeName.toLowerCase() === 'parsererror') return null
  if (doc.getElementsByTagName('parsererror').length > 0) return null
  if (root.nodeName.toLowerCase() !== 'svg') return null
  return doc
}

/** 导出给同目录其它工具复用（颜色令牌化也要走同一套解析）。 */
export function parseSvgDocument(markup: string): Document | null {
  return parseSvg(markup)
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function directText(node: Element): string {
  let out = ''
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) out += child.textContent ?? ''
  }
  return out.trim()
}

function attrString(node: Element, annotate: boolean): string {
  let out = ''
  for (const attr of Array.from(node.attributes)) {
    if (!annotate && attr.name === NODE_ATTR) continue
    out += ` ${attr.name}="${escapeAttr(attr.value)}"`
  }
  return out
}

function writeElement(node: Element, depth: number, out: string[], annotate: boolean): void {
  const pad = '  '.repeat(depth)
  const tag = node.tagName
  const children: Element[] = Array.from(node.children)
  const text = directText(node)
  const open = `${pad}<${tag}${attrString(node, annotate)}`
  if (children.length === 0) {
    if (text === '') out.push(`${open}/>`)
    else out.push(`${open}>${escapeText(text)}</${tag}>`)
    return
  }
  out.push(`${open}>`)
  if (text !== '') out.push(`${'  '.repeat(depth + 1)}${escapeText(text)}`)
  for (const child of children) writeElement(child, depth + 1, out, annotate)
  out.push(`${pad}</${tag}>`)
}

/** 可读化序列化（2 空格缩进、空元素自闭合）。`annotate` 时保留预览标记。 */
export function serializeSvg(root: Element, opts: { annotate?: boolean } = {}): string {
  const lines: string[] = []
  writeElement(root, 0, lines, opts.annotate === true)
  return `${lines.join('\n')}\n`
}

/* --------------------------------- 节点定位 -------------------------------- */

function nodeAt(doc: Document, path: number[]): Element | null {
  let node: Element | null = doc.documentElement
  for (const index of path) {
    if (!node) return null
    const children: Element[] = Array.from(node.children)
    node = children[index] ?? null
  }
  return node
}

function labelOf(node: Element, index: number, path: number[]): string {
  const id = node.getAttribute('id')
  if (id) return `${node.tagName}#${id}`
  const className = node.getAttribute('class')
  if (className) return `${node.tagName}.${className.split(/\s+/).filter(Boolean).join('.')}`
  return `${node.tagName} ${path.length === 0 ? 'root' : `#${index}`}`
}

function readViewBoxOf(root: Element): ViewBoxTuple | null {
  const raw = root.getAttribute('viewBox')
  if (!raw) return null
  const parts = raw.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null
  if (parts[2] <= 0 || parts[3] <= 0) return null
  return [parts[0], parts[1], parts[2], parts[3]]
}

/** 解析成元素清单（文档顺序），同时产出带预览标记的源码。 */
export function analyzeSvg(markup: string): SvgAnalysis {
  const empty: SvgAnalysis = { nodes: [], annotated: '', viewBox: null }
  const doc = parseSvg(markup)
  if (!doc) return empty

  const root = doc.documentElement
  const nodes: SvgNodeInfo[] = []
  let counter = 0

  const visit = (node: Element, path: number[], depth: number): void => {
    const index = counter
    counter += 1
    node.setAttribute(NODE_ATTR, String(index))
    nodes.push({
      index,
      path,
      depth,
      tag: node.tagName,
      id: node.getAttribute('id') ?? undefined,
      className: node.getAttribute('class') ?? undefined,
      label: labelOf(node, index, path),
      hidden: node.getAttribute('display') === 'none' || node.getAttribute('visibility') === 'hidden',
      fill: node.getAttribute('fill') ?? undefined,
      stroke: node.getAttribute('stroke') ?? undefined,
      opacity: node.getAttribute('opacity') ?? undefined,
      transform: node.getAttribute('transform') ?? undefined,
    })
    Array.from(node.children).forEach((child, childIndex) => {
      visit(child, [...path, childIndex], depth + 1)
    })
  }

  visit(root, [], 0)
  return { nodes, annotated: serializeSvg(root, { annotate: true }), viewBox: readViewBoxOf(root) }
}

/* --------------------------------- 节点编辑 -------------------------------- */

function sanitizeId(value: string): string {
  return value.replace(/[^\w:.-]/g, '').slice(0, 64)
}

function applyNodePatch(node: Element, patch: SvgNodePatch): void {
  if (patch.id !== undefined) {
    const next = patch.id === null ? '' : sanitizeId(patch.id)
    if (next === '') node.removeAttribute('id')
    else node.setAttribute('id', next)
  }
  if (patch.hidden !== undefined) {
    if (patch.hidden) node.setAttribute('display', 'none')
    else if (node.getAttribute('display') === 'none') node.removeAttribute('display')
  }
  if (patch.fill !== undefined) {
    if (patch.fill === null || patch.fill.trim() === '') node.removeAttribute('fill')
    else node.setAttribute('fill', patch.fill.trim())
  }
  if (patch.stroke !== undefined) {
    if (patch.stroke === null || patch.stroke.trim() === '') node.removeAttribute('stroke')
    else node.setAttribute('stroke', patch.stroke.trim())
  }
  if (patch.opacity !== undefined) {
    if (patch.opacity === null || !Number.isFinite(patch.opacity)) node.removeAttribute('opacity')
    else node.setAttribute('opacity', String(Math.max(0, Math.min(1, Math.round(patch.opacity * 100) / 100))))
  }
  if (patch.transform !== undefined) {
    if (patch.transform === null || patch.transform.trim() === '') node.removeAttribute('transform')
    else node.setAttribute('transform', patch.transform.trim())
  }
}

/** 改一个节点；解析失败返回 null（调用方保持原文不动）。 */
export function patchSvgNode(markup: string, path: number[], patch: SvgNodePatch): string | null {
  const doc = parseSvg(markup)
  if (!doc) return null
  const node = nodeAt(doc, path)
  if (!node) return null
  applyNodePatch(node, patch)
  return serializeSvg(doc.documentElement)
}

/* --------------------------------- 视图框 --------------------------------- */

export function formatViewBox(viewBox: ViewBoxTuple): string {
  return viewBox.map((value) => (Number.isInteger(value) ? String(value) : value.toFixed(2))).join(' ')
}

export function patchSvgViewBox(markup: string, viewBox: ViewBoxTuple): string | null {
  const doc = parseSvg(markup)
  if (!doc) return null
  doc.documentElement.setAttribute('viewBox', formatViewBox(viewBox))
  return serializeSvg(doc.documentElement)
}

/**
 * 按内容测量视图框（浏览器专用；jsdom / 无布局环境返回 null）。
 * 做法：把净化产物挂到一个不可见的 800×600 容器里，用 `getBBox()` 拿内容包围盒并留 4% 呼吸。
 */
export function measureContentViewBox(markup: string): ViewBoxTuple | null {
  if (typeof document === 'undefined' || markup.trim() === '') return null
  const holder = document.createElement('div')
  holder.setAttribute('aria-hidden', 'true')
  holder.style.cssText =
    'position:absolute;left:-20000px;top:0;width:800px;height:600px;overflow:hidden;visibility:hidden;pointer-events:none;'
  holder.innerHTML = markup
  document.body.appendChild(holder)
  try {
    const svg = holder.querySelector('svg') as SVGSVGElement | null
    if (!svg || typeof svg.getBBox !== 'function') return null
    const box = svg.getBBox()
    if (!box || !Number.isFinite(box.width) || !Number.isFinite(box.height)) return null
    if (box.width <= 0 || box.height <= 0) return null
    const pad = Math.max(4, Math.round(Math.max(box.width, box.height) * 0.04))
    const round = (value: number): number => Math.round(value * 100) / 100
    return [round(box.x - pad), round(box.y - pad), round(box.width + pad * 2), round(box.height + pad * 2)]
  } catch {
    return null
  } finally {
    holder.remove()
  }
}

/* ------------------------------- 净化 / 诊断 ------------------------------- */

/** 原始 XML 的解析错误（浏览器会把 parsererror 的文本放在文档里）。 */
export function readParseError(markup: string): string | null {
  if (typeof DOMParser === 'undefined' || markup.trim() === '') return null
  try {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
    const root = doc.documentElement
    if (!root) return null
    const failed = root.nodeName.toLowerCase() === 'parsererror' || doc.getElementsByTagName('parsererror').length > 0
    if (!failed) return null
    const target = root.nodeName.toLowerCase() === 'parsererror' ? root : doc.getElementsByTagName('parsererror')[0]
    const text = (target?.textContent ?? '').replace(/\s+/g, ' ').trim()
    return text === '' ? '内容不是合法 XML' : text.slice(0, 220)
  } catch {
    return null
  }
}

function byteSize(source: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(source).length
  return source.length
}

/**
 * 编辑器用的统一诊断：原文 → 解析错误 + 净化结果 + issues + viewBox。
 * 只有 `sanitized !== ''` 才允许「应用到画布」。
 */
export function diagnoseSvgSource(raw: string, opts?: { maxBytes?: number }): SvgDiagnosis {
  const bytes = byteSize(raw)
  const parseError = readParseError(raw)
  const result = sanitizeSvgDocument(raw, opts)
  const issues: SvgIssue[] = [...result.issues]
  if (parseError && result.svg !== '') {
    issues.push({ level: 'parse', message: `原文不是严格 XML，已按容错结果预览：${parseError}` })
  }
  const viewBox = result.svg ? analyzeSvg(result.svg).viewBox : null
  return {
    sanitized: result.svg,
    issues,
    ok: result.svg !== '',
    parseError,
    viewBox,
    bytes,
  }
}

/** 「格式化」按钮：净化 + 可读化序列化；失败返回 null。 */
export function formatSvgMarkup(raw: string): { markup: string; issues: SvgIssue[] } | null {
  const result = sanitizeSvgDocument(raw)
  if (!result.svg) return null
  const doc = parseSvg(result.svg)
  if (!doc) return null
  return { markup: serializeSvg(doc.documentElement), issues: result.issues }
}

export const DEFAULT_SVG_VIEW_BOX = DEFAULT_VIEW_BOX
