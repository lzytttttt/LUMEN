/**
 * tests/unit/studio.test.ts —— svg3d-studio 的纯逻辑回归测试。
 *
 * 覆盖：
 * - 精选库 12 件（分类配比、净化零 issue、全部令牌化）
 * - SVG 文档工具（元素树 / 节点补丁 / 视图框 / 诊断 / 格式化）
 * - 颜色 ↔ 令牌双向映射
 * - 3D preset 默认值（数量、schema、克隆隔离）
 * - AI 端口注册与事件 detail 解析
 * - 插入落点（安全区居中）
 */
import { afterEach, describe, expect, it } from 'vitest'
import { getTheme } from '@/themes'
import { readViewBox, sanitizeSvgDocument } from '@/render/svg/sanitize'
import { threeDescriptorSchema } from '@/schema/deck'
import { SVG_LIBRARY, SVG_CATEGORIES, svgLibraryByCategory, svgLibraryItem } from '@/studio/library'
import {
  analyzeSvg,
  diagnoseSvgSource,
  formatSvgMarkup,
  formatViewBox,
  measureContentViewBox,
  patchSvgNode,
  patchSvgViewBox,
  readParseError,
  serializeSvg,
} from '@/studio/svg/document'
import { expandThemeTokens, nearestThemeToken, tokenizeSvgColors } from '@/studio/svg/colors'
import {
  cloneDescriptor,
  defaultThreeDescriptor,
  presetSceneDefaults,
  THREE_MATERIALS,
  THREE_MOTIONS,
  THREE_PRESETS,
  THREE_SHAPES,
  THREE_TINTS,
} from '@/studio/three/defaults'
import { getRegisteredStudioAiPort, getStudioAiPort, hasStudioAi, registerStudioAiPort } from '@/studio/ai/port'
import { parseStudioDetail } from '@/studio/StudioHost'
import { centeredRect, rectForAspect } from '@/studio/geometry'

const NOIR = getTheme('noir').colors

const SAMPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" fill="none">
  <g id="group-a">
    <rect x="0" y="0" width="100" height="100" fill="none" stroke="var(--d-line)"/>
    <circle cx="50" cy="50" r="12" fill="var(--d-accent)"/>
  </g>
  <path d="M10 90H190" stroke="var(--d-muted)" stroke-width="2"/>
</svg>`

afterEach(() => {
  registerStudioAiPort(null)
})

/* -------------------------------- 精选库 -------------------------------- */

describe('studio/library', () => {
  it('12 件，分类配比 4/4/2/2，id 唯一', () => {
    expect(SVG_LIBRARY).toHaveLength(12)
    expect(new Set(SVG_LIBRARY.map((item) => item.id)).size).toBe(12)
    expect(svgLibraryByCategory('geometric')).toHaveLength(4)
    expect(svgLibraryByCategory('line')).toHaveLength(4)
    expect(svgLibraryByCategory('iso')).toHaveLength(2)
    expect(svgLibraryByCategory('chart')).toHaveLength(2)
    for (const item of SVG_LIBRARY) {
      expect(SVG_CATEGORIES).toContain(item.category)
      expect(svgLibraryItem(item.id)).toBe(item)
      expect(item.name.zh.length).toBeGreaterThan(0)
      expect(item.name.en.length).toBeGreaterThan(0)
    }
  })

  it('每件都能直接被净化器接受（零 issue），viewBox 与声明一致', () => {
    for (const item of SVG_LIBRARY) {
      const result = sanitizeSvgDocument(item.source)
      expect(result.svg, item.id).not.toBe('')
      expect(result.issues, `${item.id}: ${result.issues.map((issue) => issue.message).join(' / ')}`).toEqual([])
      expect(readViewBox(result.svg), item.id).toEqual(item.viewBox)
    }
  })

  it('颜色全部令牌化，且没有脚本/内联样式', () => {
    const paintRe = /^(none|currentColor|transparent|var\(--d-[a-z0-9-]+\)|url\(#[\w:.-]+\))$/i
    for (const item of SVG_LIBRARY) {
      const doc = new DOMParser().parseFromString(item.source, 'image/svg+xml')
      expect(doc.documentElement.nodeName).toBe('svg')
      expect(item.source).not.toMatch(/<script/i)
      expect(item.source).not.toMatch(/\sstyle=/i)
      for (const node of Array.from(doc.getElementsByTagName('*'))) {
        for (const attr of ['fill', 'stroke', 'stop-color']) {
          const value = node.getAttribute(attr)
          if (value === null) continue
          expect(paintRe.test(value.trim()), `${item.id} ${node.nodeName} ${attr}="${value}"`).toBe(true)
        }
      }
    }
  })

  it('体量远小于 512KB 上限', () => {
    for (const item of SVG_LIBRARY) {
      expect(new Blob([item.source]).size).toBeLessThan(24 * 1024)
    }
  })
})

/* ------------------------------ SVG 文档工具 ------------------------------ */

describe('studio/svg/document', () => {
  it('元素树按文档顺序展开，根在最前，路径可用于回取', () => {
    const analysis = analyzeSvg(SAMPLE)
    const labels = analysis.nodes.map((node) => node.tag)
    expect(labels[0]).toBe('svg')
    expect(labels).toEqual(['svg', 'g', 'rect', 'circle', 'path'])
    expect(analysis.nodes[0].path).toEqual([])
    expect(analysis.nodes[1].path).toEqual([0])
    expect(analysis.nodes[2].path).toEqual([0, 0])
    expect(analysis.nodes[1].id).toBe('group-a')
    expect(analysis.nodes[1].label).toBe('g#group-a')
    expect(analysis.viewBox).toEqual([0, 0, 200, 100])
    // 预览标记只存在于 annotated，不污染可应用源码
    expect(analysis.annotated).toContain('data-lumen-node="4"')
  })

  it('节点补丁：改 id / 隐藏 / 换色 / 变换，且只影响目标节点', () => {
    const circle = analyzeSvg(SAMPLE).nodes.find((node) => node.tag === 'circle')
    expect(circle).toBeTruthy()
    if (!circle) return

    const renamed = patchSvgNode(SAMPLE, circle.path, { id: 'dot-1' })
    expect(renamed).not.toBeNull()
    expect(renamed as string).toContain('id="dot-1"')
    expect(((renamed as string).match(/id="dot-1"/g) ?? []).length).toBe(1)
    expect((renamed as string).match(/<circle/g)).toHaveLength(1)

    const hidden = patchSvgNode(SAMPLE, circle.path, { hidden: true })
    expect(hidden).toContain('display="none"')

    const painted = patchSvgNode(SAMPLE, circle.path, { fill: 'var(--d-accent2)', opacity: 0.4 })
    expect(painted).toContain('fill="var(--d-accent2)"')
    expect(painted).toContain('opacity="0.4"')

    const transformed = patchSvgNode(SAMPLE, circle.path, { transform: 'rotate(90 100 50)' })
    expect(transformed).toContain('transform="rotate(90 100 50)"')

    const cleared = patchSvgNode(transformed as string, circle.path, { transform: null, fill: null })
    expect(cleared).not.toContain('transform=')
    expect(cleared).not.toContain('fill="var(--d-accent2)"')

    // id 只允许安全字符
    const dirty = patchSvgNode(SAMPLE, circle.path, { id: 'bad id<"&>' })
    expect(dirty).toContain('id="badid"')
  })

  it('不存在的路径 / 非法源码返回 null（调用方保持原文）', () => {
    expect(patchSvgNode(SAMPLE, [9, 9], { hidden: true })).toBeNull()
    expect(patchSvgNode('not an svg', [], { hidden: true })).toBeNull()
  })

  it('视图框可重写并被重新读出', () => {
    const patched = patchSvgViewBox(SAMPLE, [0, 0, 640, 360])
    expect(patched).not.toBeNull()
    expect(readViewBox(patched as string)).toEqual([0, 0, 640, 360])
    expect(formatViewBox([0, 0, 640.5, 360])).toBe('0 0 640.50 360')
  })

  it('格式化：产物可再次解析，结构与原稿等价（自闭合标签补齐）', () => {
    const formatted = formatSvgMarkup(SAMPLE)
    expect(formatted).not.toBeNull()
    if (!formatted) return
    expect(formatted.markup).toContain('\n  <g')
    const again = analyzeSvg(formatted.markup)
    expect(again.nodes.map((node) => node.tag)).toEqual(analyzeSvg(SAMPLE).nodes.map((node) => node.tag))
  })

  it('序列化默认丢掉预览标记', () => {
    const doc = new DOMParser().parseFromString(SAMPLE, 'image/svg+xml')
    doc.documentElement.setAttribute('data-lumen-node', '0')
    const plain = serializeSvg(doc.documentElement)
    expect(plain).not.toContain('data-lumen-node')
    const annotated = serializeSvg(doc.documentElement, { annotate: true })
    expect(annotated).toContain('data-lumen-node="0"')
  })

  it('诊断：合法源码 ok；被净化内容记 issue；垃圾输入不可用', () => {
    const good = diagnoseSvgSource(SAMPLE)
    expect(good.ok).toBe(true)
    expect(good.issues).toEqual([])
    expect(good.parseError).toBeNull()
    expect(good.viewBox).toEqual([0, 0, 200, 100])
    expect(good.bytes).toBeGreaterThan(0)

    const dirty = diagnoseSvgSource(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" fill="tomato"/></svg>',
    )
    expect(dirty.ok).toBe(true)
    expect(dirty.issues.length).toBeGreaterThan(0)
    expect(dirty.issues.some((issue) => issue.level === 'color')).toBe(true)
    expect(dirty.sanitized).not.toContain('<script')

    const garbage = diagnoseSvgSource('这不是 SVG')
    expect(garbage.ok).toBe(false)
    expect(garbage.sanitized).toBe('')
    expect(garbage.issues.length).toBeGreaterThan(0)

    const unclosed = diagnoseSvgSource('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>')
    expect(unclosed.parseError).not.toBeNull()

    const empty = diagnoseSvgSource('   ')
    expect(empty.ok).toBe(false)
  })

  it('纯 XML 解析错误能被读出来（无错误返回 null）', () => {
    expect(readParseError(SAMPLE)).toBeNull()
    const broken = readParseError('<svg><g></svg>')
    expect(broken).not.toBeNull()
    expect(typeof broken).toBe('string')
  })

  it('无布局环境（jsdom）下测量返回 null 而不是抛错', () => {
    expect(() => measureContentViewBox(SAMPLE)).not.toThrow()
    expect(measureContentViewBox(SAMPLE)).toBeNull()
    expect(measureContentViewBox('')).toBeNull()
  })
})

/* -------------------------------- 颜色令牌 -------------------------------- */

describe('studio/svg/colors', () => {
  const plain = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none">
  <rect width="10" height="10" fill="#c8a15a"/>
  <circle r="4" stroke="rgb(200, 161, 90)"/>
  <path d="M0 0h10" stroke="none" fill="url(#grad)"/>
</svg>`

  it('就近映射到主题令牌，并保留 none / url() 引用', () => {
    const result = tokenizeSvgColors(plain, NOIR)
    expect(result.count).toBe(2)
    expect(result.markup).toContain('fill="var(--d-accent)"')
    expect(result.markup).toContain('stroke="var(--d-accent)"')
    expect(result.markup).toContain('stroke="none"')
    expect(result.markup).toContain('url(#grad)')
    expect(result.mappings.map((mapping) => mapping.from)).toContain('#c8a15a')
  })

  it('已经是令牌或近乎全透明时不做改写', () => {
    const already = tokenizeSvgColors('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="var(--d-fg)"/></svg>', NOIR)
    expect(already.count).toBe(0)
    const transparent = tokenizeSvgColors(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="rgba(0,0,0,0)"/></svg>',
      NOIR,
    )
    expect(transparent.count).toBe(0)
    expect(nearestThemeToken('rgba(0,0,0,0)', NOIR)).toBeNull()
  })

  it('令牌可以反向展开成具体色值（导出用）', () => {
    const expanded = expandThemeTokens(SAMPLE, NOIR)
    expect(expanded.count).toBeGreaterThan(0)
    expect(expanded.markup).toContain(NOIR.accent)
    expect(expanded.markup).not.toContain('var(--d-accent)')
    expect(expanded.markup).toContain(NOIR.line)
  })

  it('令牌化 → 展开 回到原色值', () => {
    const tokenized = tokenizeSvgColors(plain, NOIR)
    const expanded = expandThemeTokens(tokenized.markup, NOIR)
    expect(expanded.markup.toLowerCase()).toContain(NOIR.accent.toLowerCase())
  })
})

/* --------------------------------- 3D 预设 -------------------------------- */

describe('studio/three/defaults', () => {
  it('7 个 preset 都生成合法 descriptor，objects 留空交给渲染侧', () => {
    expect(THREE_PRESETS).toHaveLength(7)
    for (const preset of THREE_PRESETS) {
      const descriptor = presetSceneDefaults(preset)
      expect(threeDescriptorSchema.safeParse(descriptor).success).toBe(true)
      expect(descriptor.preset).toBe(preset)
      expect(descriptor.objects).toEqual([])
      expect(descriptor.camera.distance).toBeGreaterThanOrEqual(2)
      expect(descriptor.camera.distance).toBeLessThanOrEqual(16)
      expect(descriptor.camera.elevation).toBeGreaterThanOrEqual(-0.6)
      expect(descriptor.camera.elevation).toBeLessThanOrEqual(0.9)
      expect(descriptor.camera.fov).toBeGreaterThanOrEqual(20)
      expect(descriptor.camera.fov).toBeLessThanOrEqual(70)
      expect(descriptor.motion.speed).toBeGreaterThanOrEqual(0)
      expect(descriptor.motion.speed).toBeLessThanOrEqual(2)
    }
    // 不可动的预设确实静止
    expect(presetSceneDefaults('stack').motion.kind).toBe('none')
    expect(presetSceneDefaults('stack').motion.speed).toBe(0)
  })

  it('默认场景 = orbit，克隆互相隔离', () => {
    const base = defaultThreeDescriptor()
    expect(base.preset).toBe('orbit')
    const clone = cloneDescriptor(base)
    clone.camera.distance = 3.2
    clone.motion.kind = 'none'
    expect(base.camera.distance).not.toBe(3.2)
    expect(base.motion.kind).toBe('rotate')
  })

  it('枚举表覆盖 schema 的全部取值', () => {
    expect(THREE_SHAPES).toHaveLength(9)
    expect(THREE_MATERIALS).toHaveLength(4)
    expect(THREE_TINTS).toHaveLength(5)
    expect(THREE_MOTIONS).toHaveLength(4)
  })
})

/* --------------------------------- AI 端口 -------------------------------- */

describe('studio/ai/port', () => {
  it('注册/注销端口即时生效', async () => {
    const fake = {
      generateSvgArt: async () => ({ source: SAMPLE, provider: 'fake' }),
      generateThreeScene: async () => ({ descriptor: presetSceneDefaults('torus'), provider: 'fake' }),
    }
    expect(getRegisteredStudioAiPort()).toBeNull()
    registerStudioAiPort(fake)
    expect(getRegisteredStudioAiPort()).toBe(fake)
    expect(hasStudioAi()).toBe(true)
    expect(await getStudioAiPort()).toBe(fake)

    registerStudioAiPort(null)
    expect(getRegisteredStudioAiPort()).toBeNull()
  })

  it('探测结果自洽：hasStudioAi() 与解析结论一致（ai/index.ts 落地后自动接上）', async () => {
    const port = await getStudioAiPort()
    expect(hasStudioAi()).toBe(port !== null)
    if (port) {
      // 真正的 AI 模块（或注入端口）必须提供两个生成入口
      expect(typeof port.generateSvgArt).toBe('function')
      expect(typeof port.generateThreeScene).toBe('function')
    }
  })
})

/* ------------------------------- 事件 / 落点 ------------------------------- */

describe('StudioHost 事件解析', () => {
  it('接受 svg/three，缺省或空 blockId 视为新建流程', () => {
    expect(parseStudioDetail({ kind: 'svg', blockId: 'blk_1' })).toEqual({ kind: 'svg', blockId: 'blk_1' })
    expect(parseStudioDetail({ kind: 'three' })).toEqual({ kind: 'three', blockId: undefined })
    expect(parseStudioDetail({ kind: 'svg', blockId: '   ' })).toEqual({ kind: 'svg', blockId: undefined })
  })

  it('忽略未知 kind 与非对象 detail', () => {
    expect(parseStudioDetail({ kind: 'html', blockId: 'x' })).toBeNull()
    expect(parseStudioDetail(null)).toBeNull()
    expect(parseStudioDetail('svg')).toBeNull()
    expect(parseStudioDetail(undefined)).toBeNull()
  })
})

describe('studio/geometry', () => {
  it('按比例插入并夹到安全区', () => {
    const rect = rectForAspect(760, 0.75)
    expect(rect.w).toBe(760)
    expect(rect.h).toBe(570)
    expect(rect.x).toBe(Math.round((1600 - 760) / 2))
    expect(rect.y).toBe(Math.round((900 - 570) / 2))

    const tall = rectForAspect(760, 3)
    expect(tall.h).toBe(900 - 96 * 2)
    const huge = centeredRect(5000, 5000)
    expect(huge.w).toBe(1600 - 120 * 2)
    expect(huge.h).toBe(900 - 96 * 2)
  })
})
