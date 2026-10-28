/**
 * three/defaults.ts —— 3D 场景的「预设默认值」与枚举表。
 *
 * 渲染侧（sceneBuilder）在 `objects` 为空时按 preset 自动构图，
 * 所以这里只需要给出一份**参数合理、互相搭得上**的 descriptor：
 * 相机距离/俯角/视场、运动、灯光、调色、颗粒一起决定「看起来像不像那个预设」。
 *
 * 说明：规格里提到的 `presetSceneDefaults(preset)` 在渲染层没有导出（render-core 只导出
 * buildThreeScene / resolvePalette / safeColorValue / tintColor），因此本文件就是唯一实现。
 */
import {
  threeDescriptorSchema,
  type ThreeDescriptor,
  type ThreeLight,
  type ThreeMaterial,
  type ThreePalette,
  type ThreePreset,
  type ThreeShape,
  type ThreeTint,
} from '@/schema/deck'

export const THREE_PRESETS: ThreePreset[] = ['orbit', 'showcase', 'wave-field', 'particle-cloud', 'torus', 'stack', 'globe']
export const THREE_SHAPES: ThreeShape[] = ['box', 'sphere', 'torus', 'torusKnot', 'cone', 'cylinder', 'octa', 'plane', 'icosa']
export const THREE_MATERIALS: ThreeMaterial[] = ['standard', 'physical', 'toon', 'wireframe']
export const THREE_TINTS: ThreeTint[] = ['accent', 'accent2', 'fg', 'muted', 'surface']
export const THREE_PALETTES: ThreePalette[] = ['accent', 'mono', 'duotone']
export const THREE_LIGHTS: ThreeLight[] = ['studio', 'sunset', 'neon', 'soft']
export const THREE_BACKGROUNDS: ThreeDescriptor['bg'][] = ['transparent', 'theme', 'void']
export const THREE_MOTIONS: ThreeDescriptor['motion']['kind'][] = ['rotate', 'float', 'pulse', 'none']

/** schema 上限：单块最多 24 个对象。 */
export const MAX_THREE_OBJECTS = 24
/** 品牌纪律：每个演示不超过 2 个 3D 幕。 */
export const THREE_SLIDE_BUDGET = 2

/** 每个预设的构图参数（objects 留空，交给渲染侧自动构图）。 */
const PRESET_TUNING: Record<
  ThreePreset,
  {
    camera: { distance: number; elevation: number; fov: number }
    motion: { kind: ThreeDescriptor['motion']['kind']; speed: number }
    light: ThreeLight
    palette: ThreePalette
    bg: ThreeDescriptor['bg']
    grain: number
  }
> = {
  orbit: {
    camera: { distance: 7.2, elevation: 0.34, fov: 42 },
    motion: { kind: 'rotate', speed: 0.4 },
    light: 'studio',
    palette: 'accent',
    bg: 'transparent',
    grain: 0,
  },
  showcase: {
    camera: { distance: 6.4, elevation: 0.18, fov: 40 },
    motion: { kind: 'float', speed: 0.34 },
    light: 'soft',
    palette: 'accent',
    bg: 'transparent',
    grain: 0.04,
  },
  'wave-field': {
    camera: { distance: 8, elevation: 0.62, fov: 46 },
    motion: { kind: 'rotate', speed: 0.3 },
    light: 'studio',
    palette: 'accent',
    bg: 'theme',
    grain: 0.08,
  },
  'particle-cloud': {
    camera: { distance: 7, elevation: 0.24, fov: 44 },
    motion: { kind: 'float', speed: 0.3 },
    light: 'neon',
    palette: 'duotone',
    bg: 'void',
    grain: 0.16,
  },
  torus: {
    camera: { distance: 5.8, elevation: 0.3, fov: 38 },
    motion: { kind: 'rotate', speed: 0.5 },
    light: 'sunset',
    palette: 'accent',
    bg: 'transparent',
    grain: 0,
  },
  stack: {
    camera: { distance: 5.8, elevation: 0.5, fov: 40 },
    motion: { kind: 'none', speed: 0 },
    light: 'studio',
    palette: 'mono',
    bg: 'transparent',
    grain: 0,
  },
  globe: {
    camera: { distance: 5.9, elevation: 0.22, fov: 42 },
    motion: { kind: 'rotate', speed: 0.36 },
    light: 'neon',
    palette: 'duotone',
    bg: 'void',
    grain: 0.1,
  },
}

/** preset → 一份完整 descriptor（走 zod 归一，字段默认值与 schema 永远一致）。 */
export function presetSceneDefaults(preset: ThreePreset): ThreeDescriptor {
  const tuning = PRESET_TUNING[preset] ?? PRESET_TUNING.orbit
  return threeDescriptorSchema.parse({
    preset,
    palette: tuning.palette,
    light: tuning.light,
    bg: tuning.bg,
    camera: tuning.camera,
    motion: tuning.motion,
    objects: [],
    grain: tuning.grain,
    orbitControls: false,
  })
}

/** 工作室打开时的默认场景。 */
export function defaultThreeDescriptor(): ThreeDescriptor {
  return presetSceneDefaults('orbit')
}

/** descriptor 是纯 JSON 数据：深拷贝后再改，避免共享引用写回状态。 */
export function cloneDescriptor(descriptor: ThreeDescriptor): ThreeDescriptor {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(descriptor)
    } catch {
      /* fallthrough */
    }
  }
  return JSON.parse(JSON.stringify(descriptor)) as ThreeDescriptor
}
