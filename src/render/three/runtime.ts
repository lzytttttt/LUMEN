/**
 * runtime.ts —— three.js 真运行时（唯一创建 WebGL 的地方）。
 *
 * 设计要点：
 * - `import('three')` 动态加载：主包（编辑器首屏）不静态包含 three，首屏不为 3D 付代价。
 * - 全局预算：同时活着的 runtime ≤ 4；超出时最久未用的自动「挂起为静态海报」
 *   （先 `capture()` 出一张 PNG 交给 owner，再 `forceContextLoss()` 彻底归还上下文）。
 * - `setActive(false)` 立刻停掉 `setAnimationLoop`，并补最后一帧，保证画面完整。
 * - 任何 WebGL 不可用/上下文丢失/初始化异常 → 返回 null 或标记 failed，渲染层走降级视图。
 * - `preserveDrawingBuffer: true`（截图需要）+ `antialias: true`。
 *
 * 导出/海报取帧：`captureThreeFrame(blockId)`；释放：`disposeAllThreeRuntimes()`。
 */
import type * as THREE from 'three'
import type { ThemeColors, ThreeDescriptor } from '@/schema/deck'
import { buildThreeScene, type BuiltScene, type ThreeModule } from './sceneBuilder'

export interface ThreeRuntime {
  setActive(active: boolean): void
  resize(width: number, height: number): void
  renderOnce(): void
  /** dataURL(png)，供海报/导出取帧；失败返回 null。 */
  capture(): string | null
  dispose(): void
  readonly failed: boolean
}

export interface ThreeRuntimeOptions {
  canvas: HTMLCanvasElement
  descriptor: ThreeDescriptor
  colors: ThemeColors
  pixelRatioCap?: number
  /** 注册表键（通常用 block.id），供 `captureThreeFrame` 精确取帧。 */
  key?: string
  /** 逻辑尺寸（设计像素），缺省读 canvas.clientWidth/Height。 */
  width?: number
  height?: number
  /** 被预算淘汰时回调：给一张静态海报（可能为 null）。 */
  onSuspend?: (poster: string | null) => void
  /** 不可用/上下文丢失/初始化失败；渲染层据此切降级视图。 */
  onError?: (reason: ThreeFailureReason) => void
}

export type ThreeFailureReason = 'unsupported' | 'context-lost' | 'init-failed'

/** 同时活着的 WebGL runtime 上限。 */
export const MAX_LIVE_THREE_RUNTIMES = 4
/** 单帧后备缓冲像素上限（超了自动降 pixelRatio，避免大块 3D 拖垮缩略图滚动）。 */
const MAX_BACKING_PIXELS = 4_200_000

interface ManagedRuntime extends ThreeRuntime {
  readonly key: string
  touch(): void
  /** 挂起为静态海报：先取一帧，再彻底释放 WebGL 上下文。 */
  suspend(): void
}

interface RegistryEntry {
  key: string
  runtime: ManagedRuntime
  lastUsed: number
}

const registry = new Map<string, RegistryEntry>()
let useClock = 0
let keySeq = 0

/* ------------------------------- 能力探测 ------------------------------- */

let webglSupport: boolean | null = null

/** WebGL 是否可用（惰性探测并缓存；探测用的上下文立即归还）。 */
export function isWebGLAvailable(): boolean {
  if (webglSupport !== null) return webglSupport
  if (typeof document === 'undefined' || typeof WebGLRenderingContext === 'undefined') {
    webglSupport = false
    return false
  }
  try {
    const probe = document.createElement('canvas')
    const gl = (probe.getContext('webgl2') ?? probe.getContext('webgl')) as WebGLRenderingContext | null
    webglSupport = Boolean(gl)
    try {
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      /* 探测上下文归还失败无所谓 */
    }
  } catch {
    webglSupport = false
  }
  return webglSupport
}

/** 仅供测试/特殊环境重置探测结果。 */
export function resetWebGLSupportCache(): void {
  webglSupport = null
}

/* ------------------------------ three 动态加载 ---------------------------- */

let threePromise: Promise<ThreeModule | null> | null = null

/** 惰性加载 three（失败缓存 null，不阻塞任何 UI）。 */
export function loadThreeModule(): Promise<ThreeModule | null> {
  if (!threePromise) {
    threePromise = import('three')
      .then((mod) => mod as unknown as ThreeModule)
      .catch(() => null)
  }
  return threePromise
}

/* -------------------------------- 注册表 -------------------------------- */

function touchKey(key: string): void {
  const entry = registry.get(key)
  if (entry) entry.lastUsed = ++useClock
}

function unregister(key: string, runtime: ManagedRuntime): void {
  const entry = registry.get(key)
  if (entry && entry.runtime === runtime) registry.delete(key)
}

/** 最久未用的先挂起，直到腾出预算。 */
function enforceBudget(incomingKey: string): void {
  let guard = 0
  while (registry.size >= MAX_LIVE_THREE_RUNTIMES && guard < 32) {
    guard += 1
    let oldest: RegistryEntry | null = null
    for (const entry of registry.values()) {
      if (entry.key === incomingKey) continue
      if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry
    }
    if (!oldest) break
    registry.delete(oldest.key)
    oldest.runtime.suspend()
  }
}

export function getLiveThreeRuntimeCount(): number {
  return registry.size
}

/** 取帧：传 key 取对应块，不传取最近使用的那一个。 */
export function captureThreeFrame(key?: string): string | null {
  if (key) {
    const entry = registry.get(key)
    return entry ? entry.runtime.capture() : null
  }
  let latest: RegistryEntry | null = null
  for (const entry of registry.values()) {
    if (!latest || entry.lastUsed > latest.lastUsed) latest = entry
  }
  return latest ? latest.runtime.capture() : null
}

/** 主动挂起指定 runtime（切走一幕、导出结束后调用）。 */
export function suspendThreeRuntime(key: string): boolean {
  const entry = registry.get(key)
  if (!entry) return false
  registry.delete(key)
  entry.runtime.suspend()
  return true
}

/** 全部释放（卸载应用、导出前后统一回收）。 */
export function disposeAllThreeRuntimes(): void {
  const entries = Array.from(registry.values())
  registry.clear()
  for (const entry of entries) entry.runtime.dispose()
}

/* --------------------------------- 创建 --------------------------------- */

function pickPixelRatio(width: number, height: number, cap: number): number {
  const device = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
  const pixels = Math.max(1, width * height)
  const budgetRatio = Math.sqrt(MAX_BACKING_PIXELS / pixels)
  return Math.max(0.5, Math.min(device, cap, budgetRatio))
}

function measureSize(opts: ThreeRuntimeOptions): { width: number; height: number } {
  const rawWidth = opts.width ?? opts.canvas.clientWidth ?? 0
  const rawHeight = opts.height ?? opts.canvas.clientHeight ?? 0
  const width = Number.isFinite(rawWidth) && rawWidth > 0 ? Math.round(rawWidth) : 640
  const height = Number.isFinite(rawHeight) && rawHeight > 0 ? Math.round(rawHeight) : 360
  return { width, height }
}

/**
 * 创建 runtime。WebGL 不可用 / three 加载失败 / 初始化异常一律返回 null（调用方走降级视图）。
 * 返回的对象在 dispose 之后继续调用任何方法都是安全的空操作。
 */
export async function createThreeRuntime(opts: ThreeRuntimeOptions): Promise<ThreeRuntime | null> {
  const { canvas, descriptor, colors } = opts
  if (!canvas) return null
  if (!isWebGLAvailable()) {
    opts.onError?.('unsupported')
    return null
  }

  const three = await loadThreeModule()
  if (!three || typeof three.WebGLRenderer !== 'function') {
    opts.onError?.('unsupported')
    return null
  }

  const key = opts.key ?? `three-${++keySeq}`
  // 同键重建（StrictMode 二次挂载 / 描述符变更）：先释放旧的，避免抢占上下文。
  const existing = registry.get(key)
  if (existing) {
    registry.delete(key)
    existing.runtime.dispose()
  }
  enforceBudget(key)

  let renderer: THREE.WebGLRenderer
  try {
    renderer = new three.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
  } catch {
    opts.onError?.('init-failed')
    return null
  }

  const pixelRatioCap = Math.max(1, Math.min(opts.pixelRatioCap ?? 2, 3))
  const initial = measureSize(opts)
  let width = initial.width
  let height = initial.height
  let disposed = false
  let active = false
  let failed = false
  let elapsed = 0
  let lastFrameAt = 0

  try {
    renderer.setPixelRatio(pickPixelRatio(width, height, pixelRatioCap))
    renderer.setSize(width, height, false)
    renderer.outputColorSpace = three.SRGBColorSpace
    renderer.toneMapping = three.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.06
  } catch {
    try {
      renderer.dispose()
    } catch {
      /* ignore */
    }
    opts.onError?.('init-failed')
    return null
  }

  let built: BuiltScene
  try {
    built = await buildThreeScene({
      three,
      descriptor,
      colors,
      renderer,
      aspect: width / height,
    })
  } catch {
    try {
      renderer.dispose()
      renderer.forceContextLoss()
    } catch {
      /* ignore */
    }
    opts.onError?.('init-failed')
    return null
  }

  const applyClearColor = (): void => {
    const { color, alpha } = built.background
    try {
      renderer.setClearColor(new three.Color(color), alpha)
    } catch {
      renderer.setClearColor(0x000000, alpha)
    }
  }
  applyClearColor()

  const draw = (advance: number): void => {
    if (disposed || failed) return
    elapsed += advance
    built.update(elapsed)
    renderer.render(built.scene, built.camera)
  }

  const loop = (time: number): void => {
    if (disposed || failed) return
    const seconds = time / 1000
    const delta = lastFrameAt === 0 ? 0 : Math.min(0.1, Math.max(0, seconds - lastFrameAt))
    lastFrameAt = seconds
    draw(delta)
  }

  const onContextLost = (event: Event): void => {
    event.preventDefault()
    if (disposed || failed) return
    failed = true
    active = false
    try {
      renderer.setAnimationLoop(null)
    } catch {
      /* ignore */
    }
    opts.onError?.('context-lost')
  }
  canvas.addEventListener('webglcontextlost', onContextLost, false)

  const runtime: ManagedRuntime = {
    key,
    get failed() {
      return failed
    },
    touch() {
      touchKey(key)
    },
    setActive(next: boolean) {
      if (disposed) return
      touchKey(key)
      if (failed) return
      if (next === active && next) return
      active = next
      if (next) {
        lastFrameAt = 0
        try {
          renderer.setAnimationLoop(loop)
        } catch {
          failed = true
          opts.onError?.('context-lost')
        }
      } else {
        try {
          renderer.setAnimationLoop(null)
        } catch {
          /* ignore */
        }
        // 停住时补最后一帧：导出/打印/离开这一幕时画面完整。
        lastFrameAt = 0
        draw(0)
      }
    },
    resize(nextWidth: number, nextHeight: number) {
      if (disposed) return
      const w = Math.max(1, Math.round(Number.isFinite(nextWidth) ? nextWidth : width))
      const h = Math.max(1, Math.round(Number.isFinite(nextHeight) ? nextHeight : height))
      if (w === width && h === height) return
      width = w
      height = h
      try {
        renderer.setPixelRatio(pickPixelRatio(width, height, pixelRatioCap))
        renderer.setSize(width, height, false)
      } catch {
        failed = true
        opts.onError?.('context-lost')
        return
      }
      built.camera.aspect = width / height
      built.camera.updateProjectionMatrix()
      draw(0)
    },
    renderOnce() {
      if (disposed) return
      if (failed) return
      touchKey(key)
      draw(0)
    },
    capture() {
      if (disposed || failed) return null
      try {
        draw(0)
        return canvas.toDataURL('image/png')
      } catch {
        return null
      }
    },
    suspend() {
      if (disposed) return
      const poster = (() => {
        try {
          draw(0)
          return canvas.toDataURL('image/png')
        } catch {
          return null
        }
      })()
      unregister(key, runtime)
      runtime.dispose()
      opts.onSuspend?.(poster)
    },
    dispose() {
      if (disposed) return
      disposed = true
      active = false
      unregister(key, runtime)
      canvas.removeEventListener('webglcontextlost', onContextLost, false)
      try {
        renderer.setAnimationLoop(null)
      } catch {
        /* ignore */
      }
      try {
        built.dispose()
      } catch {
        /* ignore */
      }
      try {
        renderer.dispose()
      } catch {
        /* ignore */
      }
      try {
        renderer.forceContextLoss()
      } catch {
        /* ignore */
      }
    },
  }

  registry.set(key, { key, runtime, lastUsed: ++useClock })

  // 首帧：先把画布画满，避免出现一帧空白。
  draw(0)

  return runtime
}
