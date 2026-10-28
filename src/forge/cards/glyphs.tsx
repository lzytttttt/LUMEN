/**
 * forge/cards/glyphs.tsx —— 12 个配方剪影（内联 SVG，编译期常量）。
 *
 * 形态词典：03 §2.2 第 9 列（每个 recipe 的块几何）；绘制语言：04 §6.3。
 * 缩略区 168×95 / 190×107 都是 16:9 量级，viewBox 固定 120×68，因此两档卡共用同一套字形，
 * 只按卡宽等比缩放，不改结构（03 §2.4）。
 *
 * 颜色只用 currentColor 与 --ui-accent：字形随卡片状态（hover / 选中 / 出错）变色，
 * 不新立色板，也不 import recipes.ts（02 §6 的性能决定）。
 */
import type { RecipeId } from '@/schema/deck'

type Rect = readonly [x: number, y: number, w: number, h: number]
type Disc = readonly [cx: number, cy: number, r: number]

interface Figure {
  /** 主条：标题 / 粗条 */
  h?: Rect[]
  /** 正文条：细线 */
  b?: Rect[]
  /** 金标：--ui-accent 的短条、色块 */
  a?: Rect[]
  /** 面板：块几何里的外框（只有描边） */
  p?: Rect[]
  /** 点 */
  d?: Disc[]
  /** 环 */
  o?: Disc[]
  /** 描边路径：细线、箭头 */
  s?: string[]
}

/** 矩形 → 闭合子路径（一条 path 里能放多个块，比 N 个 <rect> 省 markup）。 */
const rect = ([x, y, w, h]: Rect) => `M${x} ${y}h${w}v${h}h${-w}z`

/** 流程卡的小箭头：底端在 (x,34)，向右 3.4px。 */
const arrow = (x: number) => `M${x} 34h3.4m-1.6-1.7 1.6 1.7-1.6 1.7`

/** 三列/四列表格里的一列：金标 + 3 条正文（一列共 4 块）。 */
function column(x: number, top: number, label: number): { a: Rect[]; b: Rect[] } {
  return {
    a: [[x, top, 10, 3.6]],
    b: [
      [x, top + 8, label, 2.8],
      [x, top + 14, label - 5, 2.8],
      [x, top + 20, label, 2.8],
    ],
  }
}

const figures: Record<RecipeId, Figure> = {
  /* 上 1 短条 + 中部 2 条 + 下 1 短条 + 右侧 1 方块（04 §6.3：左粗条 + 下方短金线 + 右方框） */
  cover: {
    h: [[8, 10, 52, 7]],
    b: [
      [8, 26, 38, 4],
      [8, 34, 28, 4],
      [8, 50, 32, 4],
    ],
    a: [[8, 44, 22, 2.4]],
    p: [[72, 10, 40, 46]],
  },
  /* 居中 2 条 + 1 短横线（宽粗条 + 1/5 宽金线） */
  statement: {
    h: [[24, 24, 72, 8]],
    b: [[34, 38, 52, 4]],
    a: [[54, 48, 12, 2.6]],
  },
  /* 左 4 条 + 右 1 大方块 + 1 细线 */
  split: {
    b: [
      [8, 12, 44, 4],
      [8, 21, 34, 4],
      [8, 30, 44, 4],
      [8, 39, 26, 4],
    ],
    p: [[66, 10, 46, 46]],
    a: [[58, 8, 1.6, 50]],
  },
  /* 顶 2 条 + 3 列 × 4 块 */
  grid3: {
    h: [[8, 6, 58, 5]],
    b: [
      [8, 15, 34, 3],
      ...column(12, 29, 22).b,
      ...column(49, 29, 22).b,
      ...column(86, 29, 22).b,
    ],
    a: [...column(12, 29, 22).a, ...column(49, 29, 22).a, ...column(86, 29, 22).a],
    p: [
      [8, 24, 30, 36],
      [45, 24, 30, 36],
      [82, 24, 30, 36],
    ],
  },
  /* 顶 2 条 + 4 列 × 4 块 */
  grid4: {
    h: [[6, 6, 50, 5]],
    b: [
      [6, 15, 30, 3],
      ...column(10, 29, 16).b,
      ...column(38, 29, 16).b,
      ...column(66, 29, 16).b,
      ...column(94, 29, 16).b,
    ],
    a: [...column(10, 29, 16).a, ...column(38, 29, 16).a, ...column(66, 29, 16).a, ...column(94, 29, 16).a],
    p: [
      [6, 24, 24, 34],
      [34, 24, 24, 34],
      [62, 24, 24, 34],
      [90, 24, 24, 34],
    ],
  },
  /* 1 条横轴 + 5 组「点 + 3 条」 */
  timeline: {
    a: [[6, 30, 108, 1.6]],
    d: [
      [14, 30, 2.6],
      [38, 30, 2.6],
      [62, 30, 2.6],
      [86, 30, 2.6],
      [110, 30, 2.6],
    ],
  },
  /* 中缝竖线 + 两侧各 3 条 */
  compare: {
    a: [[59, 10, 1.6, 48]],
    b: [
      [10, 14, 40, 4],
      [10, 23, 32, 4],
      [10, 32, 40, 4],
      [70, 14, 40, 4],
      [70, 23, 32, 4],
      [70, 32, 40, 4],
    ],
  },
  /* 居中 1 长条 + 短横线 + 1 条（两侧细竖线 = 引号的撇） */
  quote: {
    h: [[20, 22, 80, 8]],
    a: [[52, 36, 16, 2.6]],
    b: [
      [32, 42, 56, 4],
      [12, 16, 1.6, 34],
      [106, 16, 1.6, 34],
    ],
  },
  /* 环 + 5 组「点 标签 数值」+ 右 4 条 */
  data: {
    o: [[24, 34, 16]],
    d: [
      [45, 11.4, 1.8],
      [45, 21.4, 1.8],
      [45, 31.4, 1.8],
      [45, 41.4, 1.8],
      [45, 51.4, 1.8],
    ],
    b: [
      [50, 10, 16, 2.8],
      [50, 20, 16, 2.8],
      [50, 30, 16, 2.8],
      [50, 40, 16, 2.8],
      [50, 50, 16, 2.8],
      [70, 10, 8, 2.8],
      [70, 20, 8, 2.8],
      [70, 30, 8, 2.8],
      [70, 40, 8, 2.8],
      [70, 50, 8, 2.8],
    ],
    a: [
      [84, 11, 26, 3],
      [84, 21, 20, 3],
      [84, 31, 26, 3],
      [84, 41, 16, 3],
    ],
  },
  /* 5 个方块 × 4 块 + 4 个箭头 */
  process: {
    p: [
      [3, 16, 18, 36],
      [26, 16, 18, 36],
      [49, 16, 18, 36],
      [72, 16, 18, 36],
      [95, 16, 18, 36],
    ],
    a: [
      [7, 21, 5, 5],
      [30, 21, 5, 5],
      [53, 21, 5, 5],
      [76, 21, 5, 5],
      [99, 21, 5, 5],
    ],
    b: [
      [7, 31, 11, 2.8],
      [7, 37, 8, 2.8],
      [7, 43, 11, 2.8],
      [30, 31, 11, 2.8],
      [30, 37, 8, 2.8],
      [30, 43, 11, 2.8],
      [53, 31, 11, 2.8],
      [53, 37, 8, 2.8],
      [53, 43, 11, 2.8],
      [76, 31, 11, 2.8],
      [76, 37, 8, 2.8],
      [76, 43, 11, 2.8],
      [99, 31, 11, 2.8],
      [99, 37, 8, 2.8],
      [99, 43, 11, 2.8],
    ],
    s: [arrow(22), arrow(45), arrow(68), arrow(91)],
  },
  /* 3 个方块 + 3 个方形图 + 3 条注 */
  gallery: {
    p: [
      [8, 10, 32, 26],
      [44, 10, 32, 26],
      [80, 10, 32, 26],
    ],
    b: [
      [15, 14, 18, 18],
      [51, 14, 18, 18],
      [87, 14, 18, 18],
      [8, 42, 24, 2.8],
      [44, 42, 24, 2.8],
      [80, 42, 24, 2.8],
    ],
  },
  /* 居中 2 条 + 1 条页脚 */
  closing: {
    h: [[26, 20, 68, 8]],
    b: [[38, 34, 44, 4]],
    a: [[10, 54, 100, 1.6]],
  },
}

/** 12 张卡的顺序 = state.ts 的 RECIPE_ORDER（换卡按此循环）。 */
export const GLYPH_RECIPES: RecipeId[] = [
  'cover',
  'statement',
  'split',
  'grid3',
  'grid4',
  'timeline',
  'compare',
  'quote',
  'data',
  'process',
  'gallery',
  'closing',
]

/**
 * 稀有度 = 版式复杂度的可测代理（03 §2.1：C = B + 2R + 2V）。
 * C ≤ 12 常见（1 点）· 13–24 少见（2 点）· ≥25 稀有（3 点）：5 / 4 / 3 张。
 */
export const CARD_RARITY: Record<RecipeId, 1 | 2 | 3> = {
  cover: 1, // C=8
  statement: 1, // C=3
  split: 1, // C=10
  grid3: 2, // C=17
  grid4: 2, // C=21
  timeline: 3, // C=25
  compare: 2, // C=14
  quote: 1, // C=3
  data: 3, // C=26
  process: 3, // C=29
  gallery: 2, // C=13
  closing: 1, // C=6
}

interface GlyphProps {
  recipe: RecipeId
  size?: number
}

export function Glyph({ recipe, size = 64 }: GlyphProps) {
  const fig = figures[recipe] ?? figures.statement
  return (
    <svg
      className="forge-glyph"
      data-glyph={recipe}
      viewBox="0 0 120 68"
      width={size}
      height={Math.round((size * 68) / 120)}
      aria-hidden="true"
      focusable="false"
    >
      {fig.p ? <path className="forge-glyph__p" d={fig.p.map(rect).join('')} /> : null}
      {fig.b ? <path className="forge-glyph__b" d={fig.b.map(rect).join('')} /> : null}
      {fig.h ? <path className="forge-glyph__h" d={fig.h.map(rect).join('')} /> : null}
      {fig.a ? <path className="forge-glyph__a" d={fig.a.map(rect).join('')} /> : null}
      {fig.s ? <path className="forge-glyph__s" d={fig.s.join('')} /> : null}
      {fig.d?.map(([cx, cy, r], i) => (
        <circle key={`d-${i}`} className="forge-glyph__d" cx={cx} cy={cy} r={r} />
      ))}
      {fig.o?.map(([cx, cy, r], i) => (
        <circle key={`o-${i}`} className="forge-glyph__o" cx={cx} cy={cy} r={r} />
      ))}
    </svg>
  )
}
