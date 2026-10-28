/**
 * deck.ts —— LUMEN 演示数据模型的唯一契约。
 * 规范：《03-数据模型与DSL》。任何 AI 产物、导入文件、持久化数据都必须先过这里。
 *
 * 坐标系：舞台固定 1600×900 设计像素（16:9），安全边距 x=120 / y=96。
 * 所有几何量都以设计像素为单位；渲染层只做整体缩放，不做二次换算。
 */
import { z } from 'zod'

export const STAGE_W = 1600
export const STAGE_H = 900
export const SAFE_X = 120
export const SAFE_Y = 96
export const SCHEMA_VERSION = 1

/* ------------------------------- 基础枚举 ------------------------------- */

export const colorTokenSchema = z.enum(['bg', 'fg', 'muted', 'surface', 'line', 'accent', 'accent2'])
export type ColorToken = z.infer<typeof colorTokenSchema>

export const textVariantSchema = z.enum(['display', 'h1', 'h2', 'lead', 'body', 'caption', 'mono'])
export type TextVariant = z.infer<typeof textVariantSchema>

export const recipeIdSchema = z.enum([
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
])
export type RecipeId = z.infer<typeof recipeIdSchema>

export const transitionKindSchema = z.enum(['none', 'fade', 'push', 'wipe', 'flip3d'])
export type TransitionKind = z.infer<typeof transitionKindSchema>

/* ------------------------------- 主题令牌 ------------------------------- */

const typeStyleSchema = z.object({
  size: z.number().min(8).max(240),
  weight: z.number().min(100).max(900),
  lineHeight: z.number().min(0.8).max(2.4),
  tracking: z.number().min(-0.12).max(0.4),
})
export type TypeStyle = z.infer<typeof typeStyleSchema>

export const themeSchema = z.object({
  id: z.string(),
  name: z.object({ zh: z.string(), en: z.string() }),
  vibe: z.object({ zh: z.string(), en: z.string() }).optional(),
  colors: z.object({
    bg: z.string(),
    fg: z.string(),
    muted: z.string(),
    surface: z.string(),
    line: z.string(),
    accent: z.string(),
    accent2: z.string(),
  }),
  font: z.object({
    body: z.string(),
    display: z.string(),
    mono: z.string(),
  }),
  typeScale: z.number().min(0.8).max(1.25).default(1),
  typeOverrides: z.record(textVariantSchema, typeStyleSchema.partial()).optional(),
  radius: z.number().min(0).max(64).default(8),
  motion: z.object({ ease: z.string(), ms: z.number().min(80).max(1600) }).default({
    ease: 'cubic-bezier(.32,.72,0,1)',
    ms: 420,
  }),
})
export type Theme = z.infer<typeof themeSchema>
export type ThemeColors = Theme['colors']

export function typeScaleOf(theme: Theme): Record<TextVariant, TypeStyle> {
  const out = {} as Record<TextVariant, TypeStyle>
  for (const [variant, style] of Object.entries(BASE_TYPE)) {
    const override = theme.typeOverrides?.[variant as TextVariant]
    const merged = { ...style, ...override }
    out[variant as TextVariant] = {
      ...merged,
      size: Math.round(merged.size * theme.typeScale * 10) / 10,
    }
  }
  return out
}

/** 基准字号阶（未乘主题 typeScale）。 */
export const BASE_TYPE: Record<TextVariant, TypeStyle> = {
  display: { size: 104, weight: 600, lineHeight: 1.02, tracking: -0.03 },
  h1: { size: 64, weight: 600, lineHeight: 1.08, tracking: -0.02 },
  h2: { size: 40, weight: 600, lineHeight: 1.16, tracking: -0.01 },
  lead: { size: 28, weight: 400, lineHeight: 1.5, tracking: 0 },
  body: { size: 22, weight: 400, lineHeight: 1.62, tracking: 0 },
  caption: { size: 15, weight: 500, lineHeight: 1.4, tracking: 0.08 },
  mono: { size: 18, weight: 500, lineHeight: 1.5, tracking: 0 },
}

/* ------------------------------- 溯源信息 ------------------------------- */

export const provenanceSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  recipeId: z.string().optional(),
  promptDigest: z.string().optional(),
  at: z.number(),
  note: z.string().optional(),
})
export type Provenance = z.infer<typeof provenanceSchema>

/* ------------------------------- three.js ------------------------------- */

export const threeShapeSchema = z.enum(['box', 'sphere', 'torus', 'torusKnot', 'cone', 'cylinder', 'octa', 'plane', 'icosa'])
export type ThreeShape = z.infer<typeof threeShapeSchema>

export const threePresetSchema = z.enum([
  'orbit',
  'showcase',
  'wave-field',
  'particle-cloud',
  'torus',
  'stack',
  'globe',
])
export type ThreePreset = z.infer<typeof threePresetSchema>

const vec3 = z.tuple([z.number(), z.number(), z.number()])

export const threeObjectSchema = z.object({
  shape: threeShapeSchema.default('box'),
  material: z.enum(['standard', 'physical', 'toon', 'wireframe']).default('standard'),
  tint: z.enum(['accent', 'accent2', 'fg', 'muted', 'surface']).default('accent'),
  scale: z.number().min(0.05).max(6).default(1),
  pos: vec3.default([0, 0, 0]),
  rot: vec3.default([0, 0, 0]),
  metalness: z.number().min(0).max(1).optional(),
  roughness: z.number().min(0).max(1).optional(),
})
export type ThreeObject = z.infer<typeof threeObjectSchema>
export type ThreeMaterial = ThreeObject['material']
export type ThreeTint = ThreeObject['tint']
export type ThreeLight = z.infer<typeof threeDescriptorSchema>['light']
export type ThreePalette = z.infer<typeof threeDescriptorSchema>['palette']
export type ThreeMotionKind = z.infer<typeof threeDescriptorSchema>['motion']['kind']

export const threeDescriptorSchema = z.object({
  preset: threePresetSchema.default('orbit'),
  palette: z.enum(['accent', 'mono', 'duotone']).default('accent'),
  light: z.enum(['studio', 'sunset', 'neon', 'soft']).default('studio'),
  bg: z.enum(['transparent', 'theme', 'void']).default('transparent'),
  camera: z
    .object({
      distance: z.number().min(1.6).max(24).default(7),
      elevation: z.number().min(-0.9).max(1.1).default(0.28),
      fov: z.number().min(18).max(80).default(42),
    })
    .default({ distance: 7, elevation: 0.28, fov: 42 }),
  motion: z
    .object({
      kind: z.enum(['rotate', 'float', 'pulse', 'none']).default('rotate'),
      speed: z.number().min(0).max(2).default(0.42),
    })
    .default({ kind: 'rotate', speed: 0.42 }),
  objects: z.array(threeObjectSchema).max(24).default([]),
  grain: z.number().min(0).max(1).default(0),
  orbitControls: z.boolean().default(false),
})
export type ThreeDescriptor = z.infer<typeof threeDescriptorSchema>

/* ------------------------------- 内容块 ------------------------------- */

const blockBaseFields = {
  id: z.string().min(1),
  name: z.string().max(120).optional(),
  x: z.number(),
  y: z.number(),
  w: z.number().min(1),
  h: z.number().min(1),
  z: z.number().int().default(0),
  rotation: z.number().min(-360).max(360).default(0),
  opacity: z.number().min(0).max(1).default(1),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  enter: z.enum(['none', 'fade', 'rise', 'scale']).default('none'),
  enterDelayMs: z.number().min(0).max(3000).default(0),
  provenance: provenanceSchema.optional(),
  /** 上一次 AI 生成的块快照（JSON 字符串），用于「还原 AI 版本」。 */
  aiSnapshot: z.string().max(400_000).optional(),
} as const

export const textBlockSchema = z.object({
  ...blockBaseFields,
  type: z.literal('text'),
  text: z.string().max(6000),
  variant: textVariantSchema.default('body'),
  align: z.enum(['left', 'center', 'right']).default('left'),
  color: colorTokenSchema.default('fg'),
  inline: z.boolean().default(true),
  tracking: z.number().min(-0.12).max(0.4).optional(),
  lineHeight: z.number().min(0.8).max(2.4).optional(),
  weight: z.number().min(100).max(900).optional(),
  maxWidth: z.number().optional(),
})
export type TextBlock = z.infer<typeof textBlockSchema>

export const shapeBlockSchema = z.object({
  ...blockBaseFields,
  type: z.literal('shape'),
  kind: z.enum(['rect', 'ellipse', 'line', 'triangle', 'rule']).default('rect'),
  fill: colorTokenSchema.default('surface'),
  stroke: colorTokenSchema.optional(),
  strokeWidth: z.number().min(0).max(40).default(0),
  radius: z.number().min(0).max(200).optional(),
  dash: z.boolean().default(false),
})
export type ShapeBlock = z.infer<typeof shapeBlockSchema>

export const imageBlockSchema = z.object({
  ...blockBaseFields,
  type: z.literal('image'),
  assetId: z.string().min(1),
  fit: z.enum(['cover', 'contain']).default('cover'),
  radius: z.number().min(0).max(200).default(0),
  dim: z.number().min(0).max(0.9).default(0),
  caption: z.string().max(160).optional(),
  alt: z.string().max(200).optional(),
})
export type ImageBlock = z.infer<typeof imageBlockSchema>

export const svgBlockSchema = z.object({
  ...blockBaseFields,
  type: z.literal('svg'),
  source: z.string().max(512 * 1024),
  viewBox: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]).default([0, 0, 1600, 900]),
  animate: z.enum(['none', 'float', 'pulse', 'spinSlow', 'draw']).default('none'),
  presetId: z.string().max(60).optional(),
  opacity: z.number().min(0).max(1).default(1),
})
export type SvgBlock = z.infer<typeof svgBlockSchema>

export const threeBlockSchema = z.object({
  ...blockBaseFields,
  type: z.literal('three'),
  descriptor: threeDescriptorSchema,
  interactive: z.boolean().default(false),
  bg: z.enum(['transparent', 'theme', 'void']).default('transparent'),
  posterAssetId: z.string().optional(),
})
export type ThreeBlock = z.infer<typeof threeBlockSchema>

export const htmlBlockSchema = z.object({
  ...blockBaseFields,
  type: z.literal('html'),
  html: z.string().max(200 * 1024),
  css: z.string().max(100 * 1024).optional(),
  heightMode: z.enum(['block', 'content']).default('block'),
  sandboxVersion: z.literal(1).default(1),
})
export type HtmlBlock = z.infer<typeof htmlBlockSchema>

export const blockSchema = z.discriminatedUnion('type', [
  textBlockSchema,
  shapeBlockSchema,
  imageBlockSchema,
  svgBlockSchema,
  threeBlockSchema,
  htmlBlockSchema,
])
export type Block = z.infer<typeof blockSchema>
export type BlockType = Block['type']

/* -------------------------------- 幻灯片 -------------------------------- */

export const slideSchema = z.object({
  id: z.string().min(1),
  name: z.string().max(120).optional(),
  blocks: z.array(blockSchema).max(120).default([]),
  notes: z.string().max(8000).optional(),
  recipe: recipeIdSchema.optional(),
  background: z
    .object({
      kind: z.enum(['theme', 'solid']).default('theme'),
      color: colorTokenSchema.optional(),
    })
    .default({ kind: 'theme' }),
  transition: z
    .object({
      kind: transitionKindSchema.default('fade'),
      ms: z.number().min(0).max(2000).default(420),
    })
    .default({ kind: 'fade', ms: 420 }),
  durationMs: z.number().min(0).max(600_000).optional(),
  provenance: provenanceSchema.optional(),
})
export type Slide = z.infer<typeof slideSchema>

/* --------------------------------- 计划 --------------------------------- */

export const outlineSlideSchema = z.object({
  recipe: recipeIdSchema.default('statement'),
  headline: z.string().min(1).max(120),
  lead: z.string().max(220).optional(),
  points: z.array(z.string().max(120)).max(6).default([]),
  visual: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('svg'), brief: z.string().max(240) }),
      z.object({ kind: z.literal('three'), preset: threePresetSchema.optional() }),
      z.object({ kind: z.literal('none') }),
    ])
    .default({ kind: 'none' }),
  notes: z.string().max(600).optional(),
})
export type OutlineSlide = z.infer<typeof outlineSlideSchema>

export const outlineSchema = z.object({
  title: z.string().min(1).max(120),
  subtitle: z.string().max(200).optional(),
  lang: z.enum(['zh', 'en']).default('zh'),
  slides: z.array(outlineSlideSchema).min(2).max(24),
})
export type Outline = z.infer<typeof outlineSchema>

/* --------------------------------- Deck --------------------------------- */

export const deckSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  id: z.string().min(1),
  title: z.string().min(1).max(160),
  lang: z.enum(['zh', 'en']).default('zh'),
  aspect: z.literal('16:9').default('16:9'),
  themeId: z.string().default('noir'),
  themeOverrides: z
    .object({
      bg: z.string().optional(),
      fg: z.string().optional(),
      accent: z.string().optional(),
      accent2: z.string().optional(),
      surface: z.string().optional(),
      line: z.string().optional(),
      muted: z.string().optional(),
    })
    .optional(),
  slides: z.array(slideSchema).min(1),
  meta: z
    .object({
      createdAt: z.number().default(() => Date.now()),
      updatedAt: z.number().default(() => Date.now()),
      origin: z.enum(['sample', 'ai', 'manual', 'import']).default('manual'),
      prompt: z.string().max(2000).optional(),
    })
    .default({ createdAt: Date.now(), updatedAt: Date.now(), origin: 'manual' }),
})
export type Deck = z.infer<typeof deckSchema>

/* ------------------------------ 工程文件 ------------------------------ */

export const deckFileSchema = z.object({
  kind: z.literal('lumen.deck').default('lumen.deck'),
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  exportedAt: z.number().default(() => Date.now()),
  deck: deckSchema,
  /** assetId → dataURL */
  assets: z.record(z.string(), z.string()).default({}),
})
export type DeckFile = z.infer<typeof deckFileSchema>

/* -------------------------------- 工具 -------------------------------- */

export function slideSize(slide: Slide): { w: number; h: number; blocks: number } {
  return { w: STAGE_W, h: STAGE_H, blocks: slide.blocks.length }
}

export function nextZ(blocks: Block[]): number {
  return blocks.reduce((max, b) => Math.max(max, b.z), 0) + 1
}

export function descendantSafeParse<T extends z.ZodTypeAny>(schema: T, value: unknown) {
  return schema.safeParse(value)
}
