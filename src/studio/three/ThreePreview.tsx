/**
 * three/ThreePreview.tsx —— 工作室里的实时 3D 预览。
 *
 * 生命周期纪律（与渲染层同一套约定）：
 * - 复用 `@/render/three` 的 `createThreeRuntime`，画布由本组件自己造/自己删；
 * - 参数改动 → **防抖 400ms 后重建** runtime（绝不每帧重建、也不在 render 里建）；
 * - 重建期间用上一帧海报顶着，避免闪烁；
 * - 卸载/关闭工作室立即 dispose（同时 forceContextLoss），不留残留 canvas；
 * - WebGL 不可用 / three 加载失败 → 明确降级提示，不白屏。
 */
import { useEffect, useRef, useState } from 'react'
import type { ThemeColors } from '@/schema/deck'
import type { ThreeDescriptor } from '@/schema/deck'
import { createThreeRuntime, isWebGLAvailable, type ThreeRuntime } from '@/render/three'
import { useT } from '@/i18n'

/** 参数变化到重建之间的静默期。 */
const REBUILD_DEBOUNCE_MS = 400
/** 预算内只允许一个预览 runtime；用固定 key 让「同键重建」也走 runtime 的清理路径。 */
const PREVIEW_KEY = 'studio-three-preview'

export type ThreePreviewStatus = 'loading' | 'live' | 'failed'

export interface ThreePreviewProps {
  descriptor: ThreeDescriptor
  colors: ThemeColors
  /** 把当前 runtime 交给上层（抓帧用）；重建/卸载时回传 null。 */
  onRuntime?: (runtime: ThreeRuntime | null) => void
  onStatus?: (status: ThreePreviewStatus) => void
  fallbackLabel?: string
}

export function ThreePreview({ descriptor, colors, onRuntime, onStatus, fallbackLabel }: ThreePreviewProps) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const runtimeRef = useRef<ThreeRuntime | null>(null)
  const [status, setStatus] = useState<ThreePreviewStatus>('loading')
  const [poster, setPoster] = useState<string | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  const descriptorKey = JSON.stringify(descriptor)
  const colorsKey = `${colors.bg}|${colors.fg}|${colors.muted}|${colors.surface}|${colors.line}|${colors.accent}|${colors.accent2}`

  // 容器尺寸（用于 runtime 逻辑尺寸与后续 resize）
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => setSize({ w: host.clientWidth, h: host.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  // 创建 / 重建：descriptor 或主题色变化时（防抖）重建；卸载必须 dispose
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    if (!isWebGLAvailable()) {
      setStatus('failed')
      onRuntime?.(null)
      return
    }

    let cancelled = false
    let runtime: ThreeRuntime | null = null
    let canvas: HTMLCanvasElement | null = null

    setStatus('loading')

    const start = () => {
      if (cancelled) return
      const width = host.clientWidth > 0 ? host.clientWidth : 960
      const height = host.clientHeight > 0 ? host.clientHeight : 540
      const element = document.createElement('canvas')
      element.className = 'st-three__canvas'
      element.setAttribute('aria-hidden', 'true')
      canvas = element
      host.appendChild(element)

      void createThreeRuntime({
        canvas: element,
        descriptor,
        colors,
        key: PREVIEW_KEY,
        width,
        height,
        onError: () => {
          if (cancelled) return
          cancelAnimationLoop(runtime)
          runtime = null
          runtimeRef.current = null
          onRuntime?.(null)
          setStatus('failed')
        },
      }).then((created) => {
        if (cancelled || !created) {
          created?.dispose()
          if (cancelled) return
          setStatus('failed')
          onRuntime?.(null)
          return
        }
        runtime = created
        runtimeRef.current = created
        created.setActive(true)
        onRuntime?.(created)
        setStatus('live')
        // 抓一帧当占位：下次重建的 400ms 里画面不会空
        const shot = created.capture()
        if (shot) setPoster(shot)
      })
    }

    const delay = REBUILD_DEBOUNCE_MS
    const timer = window.setTimeout(start, delay)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      onRuntime?.(null)
      runtimeRef.current = null
      cancelAnimationLoop(runtime)
      runtime = null
      canvas?.remove()
      canvas = null
    }
    // descriptor/colors 以序列化后的键参与依赖：避免对象身份变化引起的无意义重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descriptorKey, colorsKey])

  // 尺寸变化只 resize，不重建上下文
  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || size.w <= 0 || size.h <= 0) return
    runtime.resize(size.w, size.h)
  }, [size.w, size.h])

  useEffect(() => {
    onStatus?.(status)
  }, [status, onStatus])

  return (
    <div className="st-three__stage" data-status={status}>
      <div ref={hostRef} className="st-three__canvas-host" />
      {poster && status !== 'live' ? <img className="st-three__poster" src={poster} alt="" draggable={false} /> : null}
      {status === 'loading' ? (
        <div className="st-three__hint">
          <span className="st-three__dot" />
          {t('studio.three.preview')}
        </div>
      ) : null}
      {status === 'failed' ? (
        <div className="st-three__hint st-three__hint--failed">{fallbackLabel ?? t('studio.three.webglMissing')}</div>
      ) : null}
    </div>
  )
}

function cancelAnimationLoop(runtime: ThreeRuntime | null): void {
  if (!runtime) return
  try {
    runtime.setActive(false)
  } catch {
    /* 释放路径不允许抛错 */
  }
  try {
    runtime.dispose()
  } catch {
    /* 同上 */
  }
}
