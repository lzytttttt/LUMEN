/**
 * forge/fx/ambient.ts —— L3 台面的环境粒子 / 光晕（02 §3.3、04 §3.1、§10.1）。
 *
 * 三条硬约束：
 * 1. 只有 `tier === 'L3'` 且用户没关环境光时才 `await import('three')`——首屏永不请求 three 分块；
 *    L0 / L1 / L2 一律不创建 WebGL（连探针都不留 DOM）。
 * 2. DOM 里由本模块负责的 canvas **恰好 1 个**（`canvas[data-forge-ambient="1"]`），
 *    宿主可以重复挂载：新句柄会先清掉同宿主的旧 canvas。
 * 3. `dispose()` 释放 rAF 订阅、geometry / material / renderer 并移除 canvas；SSR / jsdom 下安全 no-op。
 *
 * v0.2.5 FX-4（`plan/v0.2.5/02` §6.1）：速度倍率随 `prog`（0–7 连续量）从 ×1.0 走到 ×2.2，
 * `slide:landed` 那一帧打一次 rip；两者都只是改闭包里的两个标量，不重建 WebGL、不重启动画。
 * 只读最终产物（`state.prog` 的等价读数），自身不产生任何进度。
 *
 * 信息呈现永远在 DOM（`SlideRenderer`），这里只负责"空气"：一层 Points + 一片加色光晕。
 */
import { useSettingsStore } from '@/state/settingsStore'
import type { ForgeStage, ForgeTier } from '../types'
import { raf } from './raf'

export interface AmbientOptions {
  tier: ForgeTier
  /** 挂载宿主（装台区）。为空时 no-op。 */
  host?: HTMLElement | null
  /** 覆盖「用户是否开着环境光」，默认读设置；单测可直接关。 */
  enabled?: boolean
  /** 像素比上限（04 §3.2：L3 给 1.5，避免 3x 屏过度绘制）。 */
  pixelRatioCap?: number
  /** 粒子数，默认 96（L3）。 */
  particleCount?: number
  /** 初始进度量（0–7）；之后用 `setProgress` 连续推，不重建 WebGL（v0.2.5 FX-4）。 */
  prog?: number
}

/** v0.2.5 §6.1 FX-4：速度倍率的两个端点（prog=0 为 1.0，prog=7 为 2.2）。 */
export const AMBIENT_SPEED_MIN = 1
export const AMBIENT_SPEED_MAX = 2.2

/** 落位 rip：一次冲击的能量在 420ms 内线性衰减回 0（不新建任何计时器）。 */
export const AMBIENT_RIP_MS = 420
/** rip 的瞬时峰值倍率：speed × (1 + AMBIENT_RIP_GAIN)。 */
export const AMBIENT_RIP_GAIN = 1.6

/** `prog ∈ [0,7]` → 速度倍率 `1.0 → 2.2`（线性，纯函数；档位不足时由调用方不创建粒子）。 */
export function ambientSpeed(prog: number): number {
  const clamped = Math.max(0, Math.min(7, Number.isFinite(prog) ? prog : 0))
  const speed = AMBIENT_SPEED_MIN + (AMBIENT_SPEED_MAX - AMBIENT_SPEED_MIN) * (clamped / 7)
  return Number(speed.toFixed(3))
}

/**
 * 装台区的进度量：与 `state.ts` 的 reducer 同一把尺子（`prog` 只由真实事件推进）。
 *
 * `AssembleProps` 里没有 `prog`（`ui.ts` 归 flow-state，本轮不动），而 `stage` / `done` /
 * `total` 就是 reducer 算 `prog` 的三个输入，所以这里按同一条公式复算，值恒等于 `state.prog`：
 *   cast → 2；stage 事件 → `STAGE_PROG`；`slide:landed` → `max(prog, 2 + 3·done/total)`。
 * 这是**读数**，不是新的进度源：没有 `slide:landed` 就没有 `done` 自增。
 */
export function deriveProg(stage: ForgeStage, done: number, total: number): number {
  const base =
    stage === 'think'
      ? 0
      : stage === 'plan'
        ? 1
        : stage === 'write'
          ? 2
          : stage === 'draw'
            ? 3
            : stage === 'set'
              ? 4
              : stage === 'check'
                ? 5
                : 6
  if (done <= 0 || total <= 0) return base
  return Math.max(base, 2 + (3 * done) / total)
}

export interface AmbientHandle {
  /** three 已真正绘制过（canvas 在 DOM 里）时为 true。 */
  readonly active: boolean
  /** 连续推进速度倍率（0–7）；不重建 WebGL、不重启动画（FX-4）。 */
  setProgress: (prog: number) => void
  /** `slide:landed` 那一帧的一次冲击；之后能量自行衰减到 0。 */
  rip: () => void
  dispose: () => void
}

const NOOP: AmbientHandle = { active: false, setProgress: () => {}, rip: () => {}, dispose: () => {} }

export const AMBIENT_CANVAS_ATTR = 'data-forge-ambient'

/** 用户是否允许环境光：设置项（可选）+ 减少动效 + 省流量。 */
export function ambientEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return false
    }
    const nav = navigator as unknown as { connection?: { saveData?: boolean } }
    if (nav.connection?.saveData === true) return false
    // `settingsStore` 由 Lead 所有：`ambient` 是可选字段（没有就视为开）。
    const forge = useSettingsStore.getState().forge as { ambient?: boolean }
    return forge.ambient !== false
  } catch {
    return false
  }
}

function canUseWebgl2(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2')
    if (!gl) return false
    ;(gl as WebGL2RenderingContext).getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

function cssColor(host: HTMLElement, name: string, fallback: string): string {
  try {
    const value = window.getComputedStyle(host).getPropertyValue(name).trim()
    return /^(#|rgb|hsl)/i.test(value) ? value : fallback
  } catch {
    return fallback
  }
}

/**
 * 启动环境粒子。同步返回句柄；three 分块与 WebGL 上下文都在异步里建，
 * 因此首屏请求与主线程都不受影响（04 §11.1）。
 */
export function startAmbient(options: AmbientOptions): AmbientHandle {
  const { tier, host } = options
  if (tier !== 'L3') return NOOP
  if (typeof window === 'undefined' || typeof document === 'undefined') return NOOP
  if (!host) return NOOP
  if (!(options.enabled ?? ambientEnabled())) return NOOP
  if (!canUseWebgl2()) return NOOP

  let disposed = false
  let live = false
  let canvas: HTMLCanvasElement | null = null
  let stopFrames: (() => void) | null = null
  const disposables: { dispose: () => void }[] = []
  let renderer: import('three').WebGLRenderer | null = null
  /** FX-4：速度倍率由 `prog` 连续推；只在下一帧被读，不重启动画。 */
  let speed = ambientSpeed(options.prog ?? 0)
  /** FX-4：落位 rip 的剩余能量（1 → 0，按 420ms 线性衰减）。 */
  let ripEnergy = 0

  const handle: AmbientHandle = {
    get active() {
      return live
    },
    setProgress: (prog: number) => {
      if (disposed) return
      speed = ambientSpeed(prog)
    },
    rip: () => {
      if (disposed) return
      ripEnergy = 1
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      live = false
      stopFrames?.()
      stopFrames = null
      for (const item of disposables.splice(0)) {
        try {
          item.dispose()
        } catch {
          /* 释放失败不影响卸载 */
        }
      }
      try {
        renderer?.dispose()
        renderer?.forceContextLoss()
      } catch {
        /* ignore */
      }
      renderer = null
      ripEnergy = 0
      if (canvas) {
        canvas.remove()
        canvas = null
      }
    },
  }

  void (async () => {
    let THREE: typeof import('three')
    try {
      THREE = await import('three')
    } catch {
      return
    }
    if (disposed || !host.isConnected) return

    // 同一宿主只允许一个环境 canvas（React StrictMode 重复挂载 / 热更新）。
    for (const stale of Array.from(host.querySelectorAll(`canvas[${AMBIENT_CANVAS_ATTR}]`))) stale.remove()

    const el = document.createElement('canvas')
    el.setAttribute(AMBIENT_CANVAS_ATTR, '1')
    el.setAttribute('aria-hidden', 'true')
    el.dataset.forgeAmbient = '1'
    el.style.position = 'absolute'
    el.style.inset = '0'
    el.style.width = '100%'
    el.style.height = '100%'
    el.style.pointerEvents = 'none'
    el.style.opacity = '0'
    el.style.transition = 'opacity 320ms linear'

    try {
      renderer = new THREE.WebGLRenderer({
        canvas: el,
        alpha: true,
        antialias: false,
        powerPreference: 'low-power',
        premultipliedAlpha: true,
      })
    } catch {
      renderer = null
      return
    }
    if (disposed) {
      renderer.dispose()
      renderer = null
      return
    }

    const pixelCap = Math.min(options.pixelRatioCap ?? 1.5, window.devicePixelRatio || 1)
    renderer.setPixelRatio(Math.max(0.5, pixelCap))
    renderer.setClearColor(0x000000, 0)
    const sizeOf = (value: number) => Math.max(1, Math.round(value))
    renderer.setSize(sizeOf(host.clientWidth), sizeOf(host.clientHeight), false)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, Math.max(0.2, 16 / 9), 0.1, 24)
    camera.position.set(0, 0, 4.2)

    const accent = cssColor(host, '--ui-accent', '#c8a15a')
    const cool = cssColor(host, '--ui-accent-2', '#57e3c2')

    // 光晕：一片加色平面，不写文字、不承载信息（02 §3.3）。
    const haloGeometry = new THREE.PlaneGeometry(6.6, 3.8, 1, 1)
    const haloMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(accent),
      transparent: true,
      opacity: 0.06,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const halo = new THREE.Mesh(haloGeometry, haloMaterial)
    halo.position.set(0, 0, -2.4)
    scene.add(halo)
    disposables.push(haloGeometry, haloMaterial)

    // 粒子：两层（暖金 + 冷青），只为景深，不做信息呈现。
    const count = Math.max(24, Math.min(options.particleCount ?? 96, 240))
    const layers = [
      { color: accent, size: 0.02, spread: 1, count: Math.round(count * 0.65) },
      { color: cool, size: 0.014, spread: 1.35, count: Math.round(count * 0.35) },
    ]
    const pointsList: import('three').Points[] = []
    for (const layer of layers) {
      const positions = new Float32Array(layer.count * 3)
      for (let i = 0; i < layer.count; i += 1) {
        positions[i * 3] = (Math.random() * 2 - 1) * 3.2 * layer.spread
        positions[i * 3 + 1] = (Math.random() * 2 - 1) * 1.8 * layer.spread
        positions[i * 3 + 2] = (Math.random() * 2 - 1) * 1.6 - 0.4
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      const material = new THREE.PointsMaterial({
        color: new THREE.Color(layer.color),
        size: layer.size,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      })
      const points = new THREE.Points(geometry, material)
      points.rotation.z = (Math.random() - 0.5) * 0.4
      scene.add(points)
      pointsList.push(points)
      disposables.push(geometry, material)
    }

    host.appendChild(el)
    canvas = el
    live = true
    window.requestAnimationFrame(() => {
      if (!disposed && el.isConnected) el.style.opacity = '0.55'
    })

    let width = sizeOf(host.clientWidth)
    let height = sizeOf(host.clientHeight)

    stopFrames = raf.subscribe((now, delta) => {
      if (disposed || !renderer) return
      const nextWidth = sizeOf(host.clientWidth)
      const nextHeight = sizeOf(host.clientHeight)
      if (nextWidth !== width || nextHeight !== height) {
        width = nextWidth
        height = nextHeight
        renderer.setSize(width, height, false)
        camera.aspect = width / Math.max(1, height)
        camera.updateProjectionMatrix()
      }
      const step = Math.min(delta, 64) / 1000
      /*
       * FX-4：粒子速度 = 基准 × speed(prog) × (1 + rip)。rip 由 `slide:landed` 打一次，
       * 之后按 AMBIENT_RIP_MS 线性衰减——这里没有 setTimeout，衰减只发生在 rAF 自己的 delta 上。
       */
      if (ripEnergy > 0) ripEnergy = Math.max(0, ripEnergy - (Math.min(delta, 64) / AMBIENT_RIP_MS))
      const rate = speed * (1 + AMBIENT_RIP_GAIN * ripEnergy)
      for (let i = 0; i < pointsList.length; i += 1) {
        const points = pointsList[i]
        points.rotation.z += step * (i === 0 ? 0.012 : -0.008) * rate
        points.rotation.y = Math.sin(now * 0.00004 * rate) * 0.06
      }
      haloMaterial.opacity = 0.05 + Math.sin(now * 0.00035 * rate) * 0.015 + 0.05 * ripEnergy
      renderer.render(scene, camera)
    })
  })()

  return handle
}

/** 单测 / 调试用：宿主里由本模块创建的 canvas 数量（正常为 0 或 1）。 */
export function ambientCanvasCount(host: HTMLElement | null | undefined): number {
  if (!host) return 0
  return host.querySelectorAll(`canvas[${AMBIENT_CANVAS_ATTR}="1"]`).length
}
