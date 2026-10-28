import { describe, expect, it } from 'vitest'
import {
  HANDLES,
  angleDeg,
  boundsOf,
  blockSnapLines,
  clampMoveDelta,
  fitIntoSafe,
  fitSize,
  handleDef,
  hitTestBoxes,
  marqueeBoxes,
  mergeLines,
  normalizeAngle,
  normalizeRect,
  pointInBox,
  resizeRect,
  rotatePoint,
  rotateVector,
  scaleBoxes,
  snapMove,
  snapResizeEdge,
  stageSnapLines,
  unionBounds,
  type StageBox,
} from '@/editor/stage/geometry'

function box(id: string, x: number, y: number, w: number, h: number, patch: Partial<StageBox> = {}): StageBox {
  return { id, x, y, w, h, z: 1, rotation: 0, locked: false, hidden: false, ...patch }
}

describe('stage geometry · 命中测试', () => {
  it('判别未旋转块的内部/外部（含边界）', () => {
    const target = box('a', 100, 100, 200, 100)
    expect(pointInBox(target, { x: 100, y: 100 })).toBe(true)
    expect(pointInBox(target, { x: 300, y: 200 })).toBe(true)
    expect(pointInBox(target, { x: 99, y: 150 })).toBe(false)
    expect(pointInBox(target, { x: 200, y: 201 })).toBe(false)
  })

  it('旋转 90° 后命中区域跟着转', () => {
    const rotated = box('a', 100, 100, 200, 100, { rotation: 90 })
    // 原框外的点（中心上方 90px）现在落在旋转后的块里（旋转后竖直跨度 200）
    expect(pointInBox(rotated, { x: 200, y: 60 })).toBe(true)
    // 原框内的远端角落跑到外面去了
    expect(pointInBox(rotated, { x: 290, y: 190 })).toBe(false)
    const bounds = boundsOf(rotated)
    expect(bounds.x).toBeCloseTo(150)
    expect(bounds.y).toBeCloseTo(50)
    expect(bounds.w).toBeCloseTo(100)
    expect(bounds.h).toBeCloseTo(200)
  })

  it('按 z 取最上层，并跳过 hidden / locked（Alt 可穿透）', () => {
    const boxes = [
      box('low', 0, 0, 100, 100, { z: 1 }),
      box('high', 50, 50, 100, 100, { z: 3 }),
      box('hidden', 0, 0, 200, 200, { z: 9, hidden: true }),
    ]
    expect(hitTestBoxes(boxes, { x: 60, y: 60 })?.id).toBe('high')
    const withLocked = [...boxes, box('locked', 55, 55, 20, 20, { z: 5, locked: true })]
    expect(hitTestBoxes(withLocked, { x: 60, y: 60 })?.id).toBe('high')
    expect(hitTestBoxes(withLocked, { x: 60, y: 60 }, { includeLocked: true })?.id).toBe('locked')
    expect(hitTestBoxes(boxes, { x: 900, y: 900 })).toBeNull()
  })

  it('框选按"相交即选中"计算，锁定块默认跳过', () => {
    const boxes = [
      box('a', 100, 100, 100, 100),
      box('b', 400, 100, 100, 100),
      box('c', 150, 150, 50, 50, { locked: true }),
    ]
    const hits = marqueeBoxes(boxes, { x: 150, y: 150, w: 300, h: 100 })
    expect(hits.map((item) => item.id)).toEqual(['a', 'b'])
    expect(marqueeBoxes(boxes, { x: 150, y: 150, w: 300, h: 100 }, { includeLocked: true }).map((item) => item.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('外接框合并与规范化', () => {
    expect(unionBounds([])).toBeNull()
    expect(unionBounds([{ x: 10, y: 20, w: 30, h: 40 }, { x: 100, y: 0, w: 10, h: 10 }])).toEqual({
      x: 10,
      y: 0,
      w: 100,
      h: 60,
    })
    expect(normalizeRect({ x: 300, y: 200 }, { x: 100, y: 100 })).toEqual({ x: 100, y: 100, w: 200, h: 100 })
  })
})

describe('stage geometry · 吸附', () => {
  it('同级块候选线优先于网格', () => {
    const lines = mergeLines(stageSnapLines(), blockSnapLines([box('a', 0, 0, 100, 100), box('b', 400, 300, 200, 200)], new Set(['a'])))
    const snapped = snapMove({ x: 297, y: 500, w: 100, h: 100 }, lines)
    // 右边 397 → 吸到块 b 的左边 400，且给出参考线
    expect(snapped.dx).toBeCloseTo(3)
    expect(snapped.guides.some((guide) => guide.axis === 'x' && guide.pos === 400)).toBe(true)
  })

  it('没有候选线时退化到 8px 网格，不画参考线', () => {
    const blank = { x: [], y: [] }
    const snapped = snapMove({ x: 101, y: 101, w: 60, h: 60 }, blank, { grid: 8 })
    expect(snapped.dx).toBeCloseTo(3)
    expect(snapped.dy).toBeCloseTo(3)
    expect(snapped.guides).toHaveLength(0)
  })

  it('阈值外的候选线不吸', () => {
    const snapped = snapMove({ x: 100, y: 100, w: 60, h: 60 }, { x: [108], y: [] }, { grid: 0 })
    expect(snapped.dx).toBe(0)
  })

  it('缩放吸附只动被拖的那条边', () => {
    const result = snapResizeEdge({ x: 100, y: 100, w: 197, h: 100 }, handleDef('e'), { x: [300], y: [] })
    expect(result.dw).toBeCloseTo(3)
    expect(result.dx).toBe(0)
    expect(result.guides[0]).toEqual({ axis: 'x', pos: 300 })
  })

  it('整组位移被舞台出血约束住，且不破坏相对位置', () => {
    const boxes = [
      { x: 100, y: 100, w: 200, h: 100 },
      { x: 400, y: 300, w: 100, h: 100 },
    ]
    // 最靠右的块决定右边界：1600 - 24 - 400 = 1176；最高的块 h + y 决定上界
    expect(clampMoveDelta(boxes, 5000, -5000)).toEqual({ dx: 1176, dy: -176 })
  })
})

describe('stage geometry · 缩放与旋转', () => {
  it('8 向手柄定义完整', () => {
    expect(HANDLES.map((handle) => handle.id)).toEqual(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'])
  })

  it('e 手柄向右拖只变宽，左边缘不动', () => {
    const rect = resizeRect({ origin: { x: 100, y: 100, w: 200, h: 100 }, handle: 'e', delta: { x: 50, y: 0 } })
    expect(rect).toEqual({ x: 100, y: 100, w: 250, h: 100 })
  })

  it('nw 手柄向左上拖同时变大', () => {
    const rect = resizeRect({ origin: { x: 100, y: 100, w: 200, h: 100 }, handle: 'nw', delta: { x: -50, y: -20 } })
    expect(rect).toEqual({ x: 50, y: 80, w: 250, h: 120 })
  })

  it('Shift 保持宽高比', () => {
    const rect = resizeRect({ origin: { x: 100, y: 100, w: 200, h: 100 }, handle: 'se', delta: { x: 40, y: 0 }, shift: true })
    expect(rect.w).toBeCloseTo(240)
    expect(rect.h).toBeCloseTo(120)
  })

  it('Alt 以中心为锚点', () => {
    const rect = resizeRect({ origin: { x: 100, y: 100, w: 200, h: 100 }, handle: 'e', delta: { x: 20, y: 0 }, alt: true })
    expect(rect.w).toBeCloseTo(240)
    expect(rect.x + rect.w / 2).toBeCloseTo(200)
  })

  it('最小尺寸兜底', () => {
    const rect = resizeRect({ origin: { x: 100, y: 100, w: 200, h: 100 }, handle: 'e', delta: { x: -400, y: 0 } })
    expect(rect.w).toBe(8)
  })

  it('旋转块的缩放锚点在世界坐标里不动', () => {
    const origin = { x: 100, y: 100, w: 200, h: 100 }
    const rotation = 90
    const center = { x: origin.x + origin.w / 2, y: origin.y + origin.h / 2 }
    const anchorBefore = rotatePoint({ x: origin.x, y: origin.y }, center, rotation)
    const rect = resizeRect({ origin, rotation, handle: 'se', delta: { x: 0, y: 40 } })
    const centerAfter = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
    const anchorAfter = rotatePoint({ x: rect.x, y: rect.y }, centerAfter, rotation)
    expect(rect.w).toBeCloseTo(240)
    expect(rect.h).toBeCloseTo(100)
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x)
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y)
  })

  it('多选缩放在整组外接框上做比例映射', () => {
    const from = { x: 0, y: 0, w: 100, h: 100 }
    const to = { x: 0, y: 0, w: 200, h: 50 }
    const scaled = scaleBoxes([{ x: 50, y: 50, w: 20, h: 20 }], from, to)
    expect(scaled[0]).toEqual({ x: 100, y: 25, w: 40, h: 10 })
  })

  it('角度归一与向量旋转', () => {
    expect(normalizeAngle(370)).toBe(10)
    expect(normalizeAngle(-190)).toBe(170)
    expect(rotateVector({ x: 10, y: 0 }, 90)).toEqual({ x: expect.closeTo(0, 6), y: expect.closeTo(10, 6) })
    expect(angleDeg({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(90)
  })
})

describe('stage geometry · 放置', () => {
  it('安全区约束：放不下时居中', () => {
    expect(fitIntoSafe({ x: -500, y: -500, w: 300, h: 200 })).toEqual({ x: 120, y: 96, w: 300, h: 200 })
    const big = fitIntoSafe({ x: 0, y: 0, w: 1500, h: 800 })
    expect(big.x).toBe(50)
    expect(big.y).toBe(50)
  })

  it('按最大边等比缩放', () => {
    expect(fitSize(1600, 900, 720, 720)).toEqual({ w: 720, h: 405 })
    expect(fitSize(100, 300, 720, 720)).toEqual({ w: 100, h: 300 })
  })
})
