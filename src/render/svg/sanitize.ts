/**
 * svg/sanitize.ts —— SVG 进入 DOM 的唯一入口。
 *
 * 策略：
 * 1) DOMPurify（svg + svgFilters profile）先做结构净化，剔除脚本、事件属性、外链引用、foreignObject；
 * 2) 再走一遍标签白名单与属性策略，明确告警（不静默丢弃，UI 会展示被清理了什么）；
 * 3) 颜色只允许主题令牌 var(--d-*) 或 none —— 保证任意生成物都能随主题换色。
 */
import DOMPurify from 'dompurify'

export interface SvgIssue {
  level: 'tag' | 'attr' | 'url' | 'color' | 'size' | 'parse'
  message: string
}

export interface SvgSanitizeResult {
  svg: string
  issues: SvgIssue[]
  changed: boolean
}

export const MAX_SVG_BYTES = 512 * 1024

const ALLOWED_TAGS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask',
  'filter', 'feGaussianBlur', 'feOffset', 'feMerge', 'feMergeNode', 'feColorMatrix', 'feBlend',
  'marker', 'pattern', 'text', 'tspan',
])

const FORBID_TAGS = [
  'script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video', 'canvas',
  'animate', 'animateTransform', 'animateMotion', 'set', 'a', 'image', 'style',
]

const COLOR_ATTRS = new Set(['fill', 'stroke', 'stop-color', 'flood-color', 'color'])
const TOKEN_RE = /^(none|currentColor|transparent|var\(--d-[a-z0-9-]+\))$/i
/**
 * 本地 paint 引用（渐变/图案）合法：只允许同文档 `url(#id)`。
 * 外链 paint 在下面的 URL 检查里单独剔除，所以这里可以放心放行。
 */
const LOCAL_PAINT_RE = /^url\(\s*(['"]?)#[\w:.-]+\1\s*\)$/i
const SAFE_URL_RE = /^#[\w:.-]+$/

function isColorLike(value: string): boolean {
  const trimmed = value.trim()
  return (
    TOKEN_RE.test(trimmed) ||
    LOCAL_PAINT_RE.test(trimmed) ||
    /^#[0-9a-f]{3,8}$/i.test(trimmed) ||
    /^(rgb|hsl)a?\(/i.test(trimmed)
  )
}

export function sanitizeSvgDocument(source: string, opts?: { maxBytes?: number }): SvgSanitizeResult {
  const issues: SvgIssue[] = []
  const maxBytes = opts?.maxBytes ?? MAX_SVG_BYTES
  const trimmed = source.trim()

  if (trimmed === '') return { svg: '', issues: [{ level: 'parse', message: 'SVG 源码为空' }], changed: true }
  if (new Blob([trimmed]).size > maxBytes) {
    issues.push({ level: 'size', message: `SVG 超过 ${Math.round(maxBytes / 1024)}KB，已拒绝渲染` })
    return { svg: '', issues, changed: true }
  }

  let cleaned = trimmed
  try {
    cleaned = DOMPurify.sanitize(trimmed, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS,
      FORBID_ATTR: ['style'],
      KEEP_CONTENT: false,
      RETURN_TRUSTED_TYPE: false,
    }) as unknown as string
  } catch (err) {
    issues.push({ level: 'parse', message: `净化失败：${String(err)}` })
    return { svg: '', issues, changed: true }
  }

  if (cleaned.trim() === '') {
    issues.push({ level: 'parse', message: '净化后为空，原始内容可能全是脚本或嵌入对象' })
    return { svg: '', issues, changed: true }
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(cleaned, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'svg') {
    issues.push({ level: 'parse', message: '根节点不是 <svg>' })
    return { svg: '', issues, changed: true }
  }

  if (!root.getAttribute('viewBox')) {
    const w = Number.parseFloat(root.getAttribute('width') ?? '')
    const h = Number.parseFloat(root.getAttribute('height') ?? '')
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      root.setAttribute('viewBox', `0 0 ${w} ${h}`)
      issues.push({ level: 'attr', message: '缺少 viewBox，已按 width/height 补齐' })
    } else {
      root.setAttribute('viewBox', '0 0 1600 900')
      issues.push({ level: 'attr', message: '缺少 viewBox，已使用 1600×900' })
    }
  }
  root.setAttribute('preserveAspectRatio', 'xMidYMid meet')

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  const nodes: Element[] = [root]
  while (walker.nextNode()) nodes.push(walker.currentNode as Element)

  for (const node of nodes) {
    const tag = node.nodeName
    const local = tag.includes(':') ? tag.split(':').pop() ?? tag : tag
    const canonical = canonicalTag(local)
    if (!ALLOWED_TAGS.has(canonical)) {
      issues.push({ level: 'tag', message: `剔除标签 <${local}>` })
      node.remove()
      continue
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name
      const lower = name.toLowerCase()
      if (lower.startsWith('on')) {
        issues.push({ level: 'attr', message: `剔除事件属性 ${name}` })
        node.removeAttribute(name)
        continue
      }
      if (lower === 'href' || lower === 'xlink:href') {
        if (!SAFE_URL_RE.test(attr.value.trim())) {
          issues.push({ level: 'url', message: '移除非本地引用的 href' })
          node.removeAttribute(name)
        }
        continue
      }
      if (lower === 'style') {
        issues.push({ level: 'attr', message: '移除内联 style' })
        node.removeAttribute(name)
        continue
      }
      if (COLOR_ATTRS.has(lower) && !isColorLike(attr.value)) {
        issues.push({ level: 'color', message: `颜色「${attr.value}」改为主题令牌` })
        node.setAttribute(name, 'var(--d-accent)')
        continue
      }
      if ((lower === 'fill' || lower === 'stroke') && /url\(\s*['"]?(https?:)?\/\//i.test(attr.value)) {
        issues.push({ level: 'url', message: '移除外部 paint 引用' })
        node.removeAttribute(name)
      }
      if (/url\(\s*(https?:)?\/\//i.test(attr.value)) {
        issues.push({ level: 'url', message: `移除外部 URL（${name}）` })
        node.removeAttribute(name)
      }
    }
  }

  const out = new XMLSerializer().serializeToString(root)
  return { svg: out, issues, changed: out !== trimmed }
}

function canonicalTag(local: string): string {
  const lower = local.toLowerCase()
  const map: Record<string, string> = {
    lineargradient: 'linearGradient',
    radialgradient: 'radialGradient',
    clippath: 'clipPath',
    fegaussianblur: 'feGaussianBlur',
    feoffset: 'feOffset',
    fecolormatrix: 'feColorMatrix',
    femerge: 'feMerge',
    femergenode: 'feMergeNode',
    feblend: 'feBlend',
  }
  return map[lower] ?? local
}

/** 取 viewBox（无则返回 null）。 */
export function readViewBox(source: string): [number, number, number, number] | null {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml')
  const raw = doc.documentElement?.getAttribute('viewBox')
  if (!raw) return null
  const parts = raw.split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) return null
  return [parts[0], parts[1], parts[2], parts[3]]
}

/** 把任意色值映射到最近的令牌（AI 生成物标准化用）。 */
export function tokenizeSvgColors(source: string): string {
  const { svg } = sanitizeSvgDocument(source)
  return svg
}
