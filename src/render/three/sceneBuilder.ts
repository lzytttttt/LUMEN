/**
 * sceneBuilder.ts —— ThreeDescriptor → three.js 场景的纯映射层。
 *
 * 职责边界：
 * - 这里只负责「数据 → 场景图 + 每帧更新函数」，不碰 renderer 生命周期（runtime.ts 负责）。
 * - 允许传入 renderer，仅用于生成 physical 材质需要的 PMREM/IBL 环境贴图。
 * - 所有 geometry / material / texture / renderTarget 都登记进 ResourceBag，dispose 时统一释放。
 *
 * 约定：
 * - 预设（preset）只在 `objects` 为空时生成默认构图；`objects` 非空时以其为准。
 * - 构图会被自动居中并缩放到相机视野内，避免 AI 给出的坐标把主体切出画面。
 * - 主包不得静态包含 three：本文件只 `import type`，入口由 runtime.ts 动态 import。
 */
import type * as THREE from 'three'
import type { ThemeColors, ThreeDescriptor, ThreeObject, ThreePreset, ThreeShape } from '@/schema/deck'

export type ThreeModule = typeof import('three')

/** 调色板：palette 决定取哪几个主题色，objects 的 tint 再映射到具体色值。 */
export interface PaletteColors {
  primary: string
  secondary: string
  accent: string
  ink: string
}

export interface BuildSceneInput {
  three: ThreeModule
  descriptor: ThreeDescriptor
  colors: ThemeColors
  /** 传入时才会生成 PMREM 环境贴图（physical 材质的 IBL）。 */
  renderer?: THREE.WebGLRenderer | null
  aspect?: number
}

export interface BuiltScene {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** 每帧推进（秒）。导出/截图传 0 得到稳定构图。 */
  update(elapsed: number): void
  /** renderer.setClearColor 需要的背景色 + alpha。 */
  background: { color: string; alpha: number }
  /** 主题色快照（BlockView 降级视图也用同一份调色板）。 */
  palette: PaletteColors
  dispose(): void
}

/* ------------------------------- 资源登记 ------------------------------- */

interface Disposable {
  dispose(): void
}

class ResourceBag {
  private items: Disposable[] = []

  track<T extends Disposable>(item: T): T {
    this.items.push(item)
    return item
  }

  dispose(): void {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      try {
        this.items[i].dispose()
      } catch {
        /* 释放失败不影响其余资源 */
      }
    }
    this.items = []
  }
}

/* ------------------------------- 调色板 -------------------------------- */

const HEX_RE = /^#([0-9a-f]{3,8})$/i
const FUNC_COLOR_RE = /^(rgb|hsl)a?\(/i

/** 主题色可能是任意 CSS 色值；非法色值直接退回 fallback，避免 three 打警告。 */
export function safeColorValue(value: string | undefined | null, fallback: string): string {
  if (!value) return fallback
  const trimmed = value.trim()
  return HEX_RE.test(trimmed) || FUNC_COLOR_RE.test(trimmed) ? trimmed : fallback
}

/**
 * palette → 四色语义：
 * - accent：主题强调色 + 次强调色，字色做高光；
 * - mono：只用字色/弱化色，强调色降为线色；
 * - duotone：强调色 + 次强调色的双色对撞。
 */
export function resolvePalette(palette: ThreeDescriptor['palette'], colors: ThemeColors): PaletteColors {
  const fg = safeColorValue(colors.fg, '#f3f0e9')
  const muted = safeColorValue(colors.muted, '#8f8b83')
  const surface = safeColorValue(colors.surface, '#17171c')
  const line = safeColorValue(colors.line, '#2a2a32')
  const accent = safeColorValue(colors.accent, '#c8a15a')
  const accent2 = safeColorValue(colors.accent2, '#7ea0b8')

  switch (palette) {
    case 'mono':
      return { primary: fg, secondary: muted, accent: line, ink: surface }
    case 'duotone':
      // 双色对撞：只在两个强调色之间取值，结构件压到暗面，避免整块糊成一片
      return { primary: accent, secondary: accent2, accent: accent2, ink: surface }
    case 'accent':
    default:
      return { primary: accent, secondary: accent2, accent: accent2, ink: muted }
  }
}

/** 对象 tint 令牌 → 实际色值（受 palette 影响，保证整块 3D 同一套色）。 */
export function tintColor(
  tint: ThreeObject['tint'],
  colors: ThemeColors,
  palette: ThreeDescriptor['palette'],
): string {
  const base = safeColorValue(colors[tint], '#c8a15a')
  if (palette === 'accent') return base
  if (palette === 'mono') {
    if (tint === 'accent') return safeColorValue(colors.fg, '#f3f0e9')
    if (tint === 'accent2') return safeColorValue(colors.muted, '#8f8b83')
    if (tint === 'surface') return safeColorValue(colors.line, '#2a2a32')
    return base
  }
  // duotone：只保留两个强调色，其余令牌折回它们
  if (tint === 'fg' || tint === 'surface') return safeColorValue(colors.accent, '#c8a15a')
  if (tint === 'muted') return safeColorValue(colors.accent2, '#7ea0b8')
  return base
}

/* ------------------------------- 材质工厂 ------------------------------- */

type MaterialKind = ThreeObject['material']

interface MaterialOptions {
  metalness?: number
  roughness?: number
  flatShading?: boolean
  /** 线框材质的透明度（结构骨架用很低的透明度）。 */
  opacity?: number
}

interface MaterialFactory {
  gradientMap: THREE.DataTexture
  make(kind: MaterialKind, color: string, opts?: MaterialOptions): THREE.Material
}

function makeToonGradient(three: ThreeModule, bag: ResourceBag): THREE.DataTexture {
  const steps = new Uint8Array([72, 158, 255])
  const texture = new three.DataTexture(steps, steps.length, 1, three.RedFormat)
  texture.minFilter = three.NearestFilter
  texture.magFilter = three.NearestFilter
  texture.generateMipmaps = false
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  return bag.track(texture)
}

function createMaterialFactory(three: ThreeModule, bag: ResourceBag): MaterialFactory {
  const gradientMap = makeToonGradient(three, bag)
  return {
    gradientMap,
    make(kind, color, opts = {}) {
      const metalness = opts.metalness ?? 0.42
      const roughness = opts.roughness ?? 0.34
      switch (kind) {
        case 'physical':
          return bag.track(
            new three.MeshPhysicalMaterial({
              color,
              metalness: opts.metalness ?? 0.55,
              roughness: opts.roughness ?? 0.16,
              clearcoat: 0.85,
              clearcoatRoughness: 0.18,
              envMapIntensity: 1.15,
            }),
          )
        case 'toon':
          return bag.track(new three.MeshToonMaterial({ color, gradientMap }))
        case 'wireframe':
          return bag.track(
            new three.MeshBasicMaterial({
              color,
              wireframe: true,
              transparent: true,
              opacity: opts.opacity ?? 0.86,
              depthWrite: false,
            }),
          )
        case 'standard':
        default:
          return bag.track(
            new three.MeshStandardMaterial({
              color,
              metalness,
              roughness,
              flatShading: opts.flatShading ?? false,
            }),
          )
      }
    },
  }
}

/* -------------------------------- 几何 -------------------------------- */

function makeShapeGeometry(
  three: ThreeModule,
  bag: ResourceBag,
  shape: ThreeShape,
  wireframe: boolean,
): THREE.BufferGeometry {
  switch (shape) {
    case 'sphere':
      return bag.track(new three.SphereGeometry(0.6, 40, 28))
    case 'torus':
      return bag.track(new three.TorusGeometry(0.52, 0.19, 28, 96))
    case 'torusKnot':
      return bag.track(new three.TorusKnotGeometry(0.44, 0.13, 128, 24))
    case 'cone':
      return bag.track(new three.ConeGeometry(0.52, 1, 40))
    case 'cylinder':
      return bag.track(new three.CylinderGeometry(0.46, 0.46, 1, 40))
    case 'octa':
      return bag.track(new three.OctahedronGeometry(0.62, 0))
    case 'plane':
      return bag.track(new three.PlaneGeometry(1, 1, wireframe ? 10 : 1, wireframe ? 10 : 1))
    case 'icosa':
      return bag.track(new three.IcosahedronGeometry(0.62, 0))
    case 'box':
    default:
      return bag.track(new three.BoxGeometry(1, 1, 1))
  }
}

const FLAT_SHAPES = new Set<ThreeShape>(['icosa', 'octa', 'cone'])

/* ------------------------------- 场景上下文 ------------------------------ */

interface PresetContext {
  three: ThreeModule
  /** 构图容器：整体居中/缩放在这里做。 */
  content: THREE.Group
  palette: PaletteColors
  colors: ThemeColors
  materials: MaterialFactory
  bag: ResourceBag
  /** 每个动画回调拿到 (elapsed 秒, speed 0~2)。 */
  animators: Array<(elapsed: number, speed: number) => void>
}

function addMesh(
  ctx: PresetContext,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  transform: { pos?: [number, number, number]; rot?: [number, number, number]; scale?: number | [number, number, number] } = {},
): THREE.Mesh {
  const mesh = new ctx.three.Mesh(geometry, material)
  if (transform.pos) mesh.position.set(transform.pos[0], transform.pos[1], transform.pos[2])
  if (transform.rot) mesh.rotation.set(transform.rot[0], transform.rot[1], transform.rot[2])
  if (typeof transform.scale === 'number') mesh.scale.setScalar(transform.scale)
  else if (Array.isArray(transform.scale)) mesh.scale.set(transform.scale[0], transform.scale[1], transform.scale[2])
  return mesh
}

/* ------------------------------- 7 个预设 ------------------------------- */

/** orbit：主环 + 内核 + 三颗轨道卫星。 */
function presetOrbit(ctx: PresetContext): void {
  const { three, content, palette, materials, bag, animators } = ctx

  const ring = addMesh(ctx, bag.track(new three.TorusGeometry(1.72, 0.045, 18, 180)), materials.make('standard', palette.primary, { metalness: 0.9, roughness: 0.18 }), {
    rot: [Math.PI * 0.42, 0.18, 0],
  })
  content.add(ring)

  const halo = addMesh(ctx, bag.track(new three.TorusGeometry(2.02, 0.008, 8, 180)), materials.make('wireframe', palette.accent), {
    rot: [Math.PI * 0.48, 0.1, Math.PI * 0.06],
  })
  content.add(halo)

  const core = addMesh(ctx, bag.track(new three.IcosahedronGeometry(0.6, 1)), materials.make('physical', palette.secondary, { metalness: 0.45, roughness: 0.2 }))
  content.add(core)

  const satelliteGeometry = bag.track(new three.SphereGeometry(0.14, 24, 18))
  const satellites = [0, 1, 2].map((index) => {
    const material = materials.make('standard', index === 0 ? palette.primary : palette.ink, { metalness: 0.3, roughness: 0.5 })
    const mesh = new three.Mesh(satelliteGeometry, material)
    content.add(mesh)
    return {
      mesh,
      phase: (index / 3) * Math.PI * 2,
      radius: 1.95 + index * 0.12,
      tilt: 0.22 + index * 0.16,
    }
  })

  animators.push((elapsed, speed) => {
    const clock = elapsed * speed
    core.rotation.y = clock * 0.8
    core.rotation.x = Math.sin(clock * 0.7) * 0.22
    ring.rotation.z = clock * 0.2
    for (const [index, satellite] of satellites.entries()) {
      const angle = satellite.phase + clock * (0.9 + index * 0.12)
      satellite.mesh.position.set(
        Math.cos(angle) * satellite.radius,
        Math.sin(angle * 1.4 + satellite.phase) * satellite.tilt,
        Math.sin(angle) * satellite.radius,
      )
    }
  })
}

/** showcase：展台平面 + 主体 + 光环。 */
function presetShowcase(ctx: PresetContext): void {
  const { three, content, palette, materials, bag, animators } = ctx

  const plinth = addMesh(ctx, bag.track(new three.CylinderGeometry(1.62, 1.78, 0.16, 72)), materials.make('standard', palette.ink, { metalness: 0.28, roughness: 0.72 }), {
    pos: [0, -1.18, 0],
  })
  content.add(plinth)

  const body = addMesh(ctx, bag.track(new three.TorusKnotGeometry(0.56, 0.16, 160, 28)), materials.make('physical', palette.primary, { metalness: 0.6, roughness: 0.14 }))
  content.add(body)

  const halo = addMesh(ctx, bag.track(new three.TorusGeometry(1.34, 0.012, 8, 160)), materials.make('wireframe', palette.accent), {
    rot: [Math.PI * 0.5, 0, 0],
    pos: [0, -1.08, 0],
  })
  content.add(halo)

  animators.push((elapsed, speed) => {
    const clock = elapsed * speed
    body.rotation.y = clock * 0.55
    body.rotation.x = 0.35 + Math.sin(clock * 0.5) * 0.12
    body.position.y = Math.sin(clock * 0.9) * 0.12 + 0.05
    halo.rotation.z = clock * 0.35
  })
}

/** wave-field：网格方块 sin 波动。 */
function presetWaveField(ctx: PresetContext): void {
  const { three, content, palette, materials, bag, animators } = ctx
  const size = 9
  const spacing = 0.44
  const geometry = bag.track(new three.BoxGeometry(0.28, 0.28, 0.28))
  const materialsByColumn = Array.from({ length: size }, (_, column) => {
    const color = column >= size - 3 ? palette.secondary : column <= 1 ? palette.accent : palette.primary
    return materials.make('standard', color, { metalness: 0.42, roughness: 0.36 })
  })

  const cells: Array<{ mesh: THREE.Mesh; x: number; z: number; phase: number }> = []
  for (let column = 0; column < size; column += 1) {
    for (let row = 0; row < size; row += 1) {
      const x = (column - (size - 1) / 2) * spacing
      const z = (row - (size - 1) / 2) * spacing
      const mesh = new three.Mesh(geometry, materialsByColumn[column])
      mesh.position.set(x, 0, z)
      content.add(mesh)
      cells.push({ mesh, x, z, phase: (column + row) * 0.42 })
    }
  }

  animators.push((elapsed, speed) => {
    const clock = elapsed * speed
    for (const cell of cells) {
      const wave = Math.sin(cell.x * 1.55 + clock * 1.5) + Math.cos(cell.z * 1.25 - clock * 1.15)
      cell.mesh.position.y = wave * 0.15
      cell.mesh.rotation.y = cell.phase + clock * 0.25
      cell.mesh.scale.y = 1 + Math.abs(wave) * 0.55
    }
  })
}

/** particle-cloud：Points 粒子云 + 极淡的球壳骨架。 */
function presetParticleCloud(ctx: PresetContext): void {
  const { three, content, palette, materials, bag, animators } = ctx

  const COUNT = 1600
  const positions = new Float32Array(COUNT * 3)
  const random = seeded(0x9e3779b9)
  for (let index = 0; index < COUNT; index += 1) {
    const radius = 0.9 + Math.pow(random(), 0.6) * 1.5
    const theta = random() * Math.PI * 2
    const phi = Math.acos(2 * random() - 1)
    const sinPhi = Math.sin(phi)
    positions[index * 3] = radius * sinPhi * Math.cos(theta)
    positions[index * 3 + 1] = radius * Math.cos(phi) * 0.82
    positions[index * 3 + 2] = radius * sinPhi * Math.sin(theta)
  }
  const geometry = new three.BufferGeometry()
  geometry.setAttribute('position', new three.BufferAttribute(positions, 3))
  bag.track(geometry)

  const pointMaterial = bag.track(
    new three.PointsMaterial({
      color: palette.primary,
      size: 0.036,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      blending: three.AdditiveBlending,
    }),
  )
  const points = new three.Points(geometry, pointMaterial)
  content.add(points)

  const shell = addMesh(ctx, bag.track(new three.SphereGeometry(1.62, 24, 16)), materials.make('wireframe', palette.secondary, { opacity: 0.14 }), {
    pos: [0, 0, 0],
  })
  content.add(shell)

  animators.push((elapsed, speed) => {
    const clock = elapsed * speed
    points.rotation.y = clock * 0.32
    points.rotation.x = Math.sin(clock * 0.24) * 0.18
    shell.rotation.y = -clock * 0.1
    pointMaterial.size = 0.032 + Math.sin(clock * 0.9) * 0.006
  })
}

/** torus：单主体环 + 两道细环 + 一颗珠子。 */
function presetTorus(ctx: PresetContext): void {
  const { three, content, palette, materials, bag, animators } = ctx

  const main = addMesh(ctx, bag.track(new three.TorusGeometry(1.2, 0.32, 40, 140)), materials.make('physical', palette.primary, { metalness: 0.62, roughness: 0.18 }), {
    rot: [0.62, 0.2, 0],
  })
  content.add(main)

  const inner = addMesh(ctx, bag.track(new three.TorusGeometry(0.72, 0.07, 24, 120)), materials.make('standard', palette.secondary, { metalness: 0.35, roughness: 0.4 }), {
    rot: [1.28, 0.4, 0.3],
  })
  content.add(inner)

  const outer = addMesh(ctx, bag.track(new three.TorusGeometry(1.78, 0.012, 8, 160)), materials.make('wireframe', palette.accent), {
    rot: [1.34, -0.2, 0],
  })
  content.add(outer)

  const bead = addMesh(ctx, bag.track(new three.SphereGeometry(0.11, 24, 18)), materials.make('standard', palette.accent, { metalness: 0.2, roughness: 0.3 }), {
    pos: [1.78, 0, 0],
  })
  content.add(bead)

  animators.push((elapsed, speed) => {
    const clock = elapsed * speed
    main.rotation.y = clock * 0.5
    main.rotation.x = 0.62 + Math.sin(clock * 0.6) * 0.16
    inner.rotation.z = clock * 0.75
    outer.rotation.y = -clock * 0.2
    bead.position.set(Math.cos(clock * 0.9) * 1.78, Math.sin(clock * 0.9) * 0.3, Math.sin(clock * 0.9) * 1.78)
  })
}

/** stack：错位体块堆叠。 */
function presetStack(ctx: PresetContext): void {
  const { three, content, palette, materials, bag, animators } = ctx
  const geometry = bag.track(new three.BoxGeometry(1, 1, 1))
  const layers = [
    { scale: [2.1, 0.26, 1.5] as [number, number, number], y: -1.08, x: 0, z: 0, rot: 0.1, material: 'standard' as const, color: palette.ink },
    { scale: [1.56, 0.34, 1.2] as [number, number, number], y: -0.68, x: 0.16, z: -0.1, rot: -0.22, material: 'standard' as const, color: palette.secondary },
    { scale: [1.06, 0.42, 0.94] as [number, number, number], y: -0.24, x: -0.12, z: 0.12, rot: 0.4, material: 'physical' as const, color: palette.primary },
    { scale: [0.68, 0.52, 0.68] as [number, number, number], y: 0.3, x: 0.1, z: -0.08, rot: -0.55, material: 'standard' as const, color: palette.secondary },
    { scale: [0.4, 0.64, 0.4] as [number, number, number], y: 0.94, x: -0.04, z: 0.02, rot: 0.18, material: 'toon' as const, color: palette.accent },
  ]

  const blocks = layers.map((layer) => {
    const mesh = addMesh(ctx, geometry, materials.make(layer.material, layer.color, { metalness: 0.4, roughness: 0.44 }), {
      pos: [layer.x, layer.y, layer.z],
      rot: [0, layer.rot, 0],
      scale: layer.scale,
    })
    content.add(mesh)
    return { mesh, baseY: layer.y }
  })

  animators.push((elapsed, speed) => {
    const clock = elapsed * speed
    blocks.forEach((block, index) => {
      block.mesh.position.y = block.baseY + Math.sin(clock * 0.7 + index * 0.8) * 0.035
    })
    blocks[blocks.length - 1].mesh.rotation.y = clock * 0.6
  })
}

/** globe：球面线框 + 点云 + 轨道标记。 */
function presetGlobe(ctx: PresetContext): void {
  const { three, content, palette, materials, bag, animators } = ctx

  const wire = addMesh(ctx, bag.track(new three.SphereGeometry(1.28, 36, 24)), materials.make('wireframe', palette.secondary, { opacity: 0.3 }), {})
  content.add(wire)

  const COUNT = 900
  const positions = new Float32Array(COUNT * 3)
  const random = seeded(0x51ed270b)
  for (let index = 0; index < COUNT; index += 1) {
    const theta = random() * Math.PI * 2
    const phi = Math.acos(2 * random() - 1)
    const radius = 1.3
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta)
    positions[index * 3 + 1] = radius * Math.cos(phi)
    positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
  }
  const pointsGeometry = new three.BufferGeometry()
  pointsGeometry.setAttribute('position', new three.BufferAttribute(positions, 3))
  bag.track(pointsGeometry)
  const pointsMaterial = bag.track(
    new three.PointsMaterial({
      color: palette.primary,
      size: 0.03,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: three.AdditiveBlending,
    }),
  )
  const points = new three.Points(pointsGeometry, pointsMaterial)
  content.add(points)

  const equator = addMesh(ctx, bag.track(new three.TorusGeometry(1.62, 0.008, 8, 180)), materials.make('wireframe', palette.accent), {
    rot: [Math.PI * 0.5, 0, 0],
  })
  content.add(equator)

  const marker = addMesh(ctx, bag.track(new three.SphereGeometry(0.1, 24, 18)), materials.make('physical', palette.secondary, { metalness: 0.4, roughness: 0.2 }), {})
  content.add(marker)

  animators.push((elapsed, speed) => {
    const clock = elapsed * speed
    content.rotation.y = clock * 0.36
    points.rotation.y = clock * 0.06
    equator.rotation.z = clock * 0.16
    const latitude = 0.42
    marker.position.set(
      Math.cos(clock * 1.1) * Math.cos(latitude) * 1.32,
      Math.sin(latitude) * 1.32,
      Math.sin(clock * 1.1) * Math.cos(latitude) * 1.32,
    )
  })
}

const PRESETS: Record<ThreePreset, (ctx: PresetContext) => void> = {
  orbit: presetOrbit,
  showcase: presetShowcase,
  'wave-field': presetWaveField,
  'particle-cloud': presetParticleCloud,
  torus: presetTorus,
  stack: presetStack,
  globe: presetGlobe,
}

/* --------------------------------- 灯光 --------------------------------- */

/** 4 套灯光：光源位置随相机距离缩放，保证不同 distance 下曝光一致。 */
function addLights(three: ThreeModule, scene: THREE.Scene, descriptor: ThreeDescriptor, palette: PaletteColors, bag: ResourceBag): void {
  const scale = descriptor.camera.distance / 7
  const p = (x: number, y: number, z: number): [number, number, number] => [x * scale, y * scale, z * scale]
  const track = <T extends Disposable>(item: T): T => bag.track(item)

  switch (descriptor.light) {
    case 'sunset': {
      const hemisphere = track(new three.HemisphereLight(0xffc7a1, 0x2a1620, 0.55))
      scene.add(hemisphere)
      const key = track(new three.DirectionalLight(0xff9a52, 3.1))
      key.position.set(...p(-4.4, 2.6, 4.8))
      scene.add(key)
      const fill = track(new three.DirectionalLight(0x6f7dff, 1.1))
      fill.position.set(...p(4.6, 0.6, -3.2))
      scene.add(fill)
      const rim = track(new three.DirectionalLight(0xffd0a0, 0.8))
      rim.position.set(...p(0, -2.4, -4))
      scene.add(rim)
      break
    }
    case 'neon': {
      scene.add(track(new three.AmbientLight(0x1a2340, 1.1)))
      const key = track(new three.PointLight(palette.primary, 34 * scale * scale, 0, 2))
      key.position.set(...p(2.9, 1.9, 2.6))
      scene.add(key)
      const secondary = track(new three.PointLight(palette.secondary, 26 * scale * scale, 0, 2))
      secondary.position.set(...p(-3.1, -1.4, 2.2))
      scene.add(secondary)
      const rim = track(new three.DirectionalLight(0xffffff, 0.42))
      rim.position.set(...p(0, 3.2, -3.6))
      scene.add(rim)
      break
    }
    case 'soft': {
      scene.add(track(new three.HemisphereLight(0xffffff, 0x9aa0aa, 1.05)))
      const key = track(new three.DirectionalLight(0xffffff, 1.15))
      key.position.set(...p(2.4, 4.6, 4.2))
      scene.add(key)
      scene.add(track(new three.AmbientLight(0xffffff, 0.42)))
      break
    }
    case 'studio':
    default: {
      scene.add(track(new three.HemisphereLight(0xffffff, 0x14141a, 0.62)))
      const key = track(new three.DirectionalLight(0xffffff, 2.35))
      key.position.set(...p(4.2, 5.4, 5.6))
      scene.add(key)
      const fill = track(new three.DirectionalLight(palette.secondary, 1.05))
      fill.position.set(...p(-5.4, 1.6, 2.4))
      scene.add(fill)
      const rim = track(new three.DirectionalLight(palette.primary, 1.4))
      rim.position.set(...p(0.4, -3.2, -4.6))
      scene.add(rim)
      break
    }
  }
}

/* ------------------------------ 环境贴图 IBL ----------------------------- */

async function setupEnvironment(
  three: ThreeModule,
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  bag: ResourceBag,
): Promise<void> {
  const pmrem = new three.PMREMGenerator(renderer)
  try {
    const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js')
    const room = new RoomEnvironment()
    const target = pmrem.fromScene(room, 0.04)
    bag.track(target)
    scene.environment = target.texture
  } catch {
    /* 环境贴图失败不影响主渲染：physical 材质退化为普通高光 */
  } finally {
    pmrem.dispose()
  }
}

/* ------------------------------ objects 模式 ----------------------------- */

function buildObjects(ctx: PresetContext, objects: ThreeObject[], tintPalette: ThreeDescriptor['palette']): void {
  const { three, content, colors, materials, bag, animators } = ctx
  for (const object of objects) {
    const color = tintColor(object.tint, colors, tintPalette)
    const wireframe = object.material === 'wireframe'
    const geometry = makeShapeGeometry(three, bag, object.shape, wireframe)
    const material = materials.make(object.material, color, {
      metalness: object.metalness,
      roughness: object.roughness,
      flatShading: FLAT_SHAPES.has(object.shape),
    })
    if (object.shape === 'plane') {
      material.side = three.DoubleSide
    }
    const mesh = new three.Mesh(geometry, material)
    mesh.position.set(object.pos[0], object.pos[1], object.pos[2])
    mesh.rotation.set(object.rot[0], object.rot[1], object.rot[2])
    mesh.scale.setScalar(object.scale)
    content.add(mesh)
    animators.push((elapsed, speed) => {
      mesh.rotation.y = object.rot[1] + elapsed * speed * 0.4
    })
  }
}

/* -------------------------------- 工具 --------------------------------- */

/** 确定性伪随机（LCG），保证粒子构图每次一致，截图可复现。 */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

/**
 * 把构图居中并缩放进相机视野：AI 给的坐标千奇百怪，这里保证主体不会整块切出画面。
 *
 * 层级：scene → root（motion 全局变换）→ fit（居中+缩放，只算一次）→ content（预设内容）。
 * 这样 root 的旋转/脉冲都以构图中心为原点，不会因为偏移而晃动。
 */
function fitContentToCamera(
  three: ThreeModule,
  root: THREE.Object3D,
  fit: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  aspect: number,
): void {
  root.updateMatrixWorld(true)
  const box = new three.Box3().setFromObject(root)
  if (box.isEmpty()) return
  const size = box.getSize(new three.Vector3())
  const center = box.getCenter(new three.Vector3())
  const radius = Math.max(size.x, size.y, size.z) * 0.5
  if (!Number.isFinite(radius) || radius <= 0.0001) return

  const halfHeight = Math.tan(((camera.fov * Math.PI) / 180) / 2) * camera.position.length()
  const halfWidth = halfHeight * Math.max(0.3, aspect)
  const limit = Math.min(halfWidth, halfHeight) * 0.92
  const scale = radius > limit ? limit / radius : 1

  fit.scale.setScalar(scale)
  fit.position.set(-center.x * scale, -center.y * scale, -center.z * scale)
}

/* --------------------------------- 出口 --------------------------------- */

export async function buildThreeScene(input: BuildSceneInput): Promise<BuiltScene> {
  const { three, descriptor, colors } = input
  const aspect = input.aspect && Number.isFinite(input.aspect) && input.aspect > 0 ? input.aspect : 16 / 9
  const bag = new ResourceBag()
  const palette = resolvePalette(descriptor.palette, colors)

  const scene = new three.Scene()
  const camera = new three.PerspectiveCamera(
    descriptor.camera.fov,
    aspect,
    0.1,
    400,
  )
  const distance = descriptor.camera.distance
  const elevation = descriptor.camera.elevation
  camera.position.set(0, Math.sin(elevation) * distance, Math.cos(elevation) * distance)
  camera.lookAt(0, 0, 0)

  const root = new three.Group()
  const fit = new three.Group()
  const content = new three.Group()
  root.add(fit)
  fit.add(content)
  scene.add(root)

  addLights(three, scene, descriptor, palette, bag)

  const materials = createMaterialFactory(three, bag)
  const animators: Array<(elapsed: number, speed: number) => void> = []
  const ctx: PresetContext = { three, content, palette, colors, materials, bag, animators }

  if (descriptor.objects.length > 0) {
    buildObjects(ctx, descriptor.objects, descriptor.palette)
  } else {
    const preset = PRESETS[descriptor.preset] ?? PRESETS.orbit
    preset(ctx)
  }

  if (input.renderer) {
    await setupEnvironment(three, scene, input.renderer, bag)
  }

  // 构图刚好铺满视野（在 0 时刻计算，之后的旋转都在包围球内）
  fitContentToCamera(three, root, fit, camera, aspect)

  const motion = descriptor.motion
  const update = (elapsed: number): void => {
    const speed = motion.speed
    const animate = motion.kind !== 'none' && speed > 0
    if (animate) {
      for (const animator of animators) animator(elapsed, speed)
    }
    switch (motion.kind) {
      case 'rotate':
        root.rotation.y = animate ? elapsed * speed * 0.55 : 0
        break
      case 'float':
        root.position.y = animate ? Math.sin(elapsed * (0.7 + speed)) * 0.16 : 0
        root.rotation.y = animate ? elapsed * speed * 0.22 : 0
        break
      case 'pulse':
        root.scale.setScalar(animate ? 1 + Math.sin(elapsed * (1.3 + speed)) * 0.03 : 1)
        root.rotation.y = animate ? elapsed * speed * 0.25 : 0
        break
      default:
        root.rotation.y = 0
        root.position.y = 0
        root.scale.setScalar(1)
        break
    }
  }

  const background =
    descriptor.bg === 'transparent'
      ? { color: '#000000', alpha: 0 }
      : descriptor.bg === 'void'
        ? { color: '#05060a', alpha: 1 }
        : { color: safeColorValue(colors.bg, '#0c0c0f'), alpha: 1 }

  // 先摆一个稳定姿态，捕获/导出直接用这一帧
  update(0)

  return {
    scene,
    camera,
    update,
    background,
    palette,
    dispose() {
      animators.length = 0
      bag.dispose()
      root.clear()
      scene.clear()
    },
  }
}
