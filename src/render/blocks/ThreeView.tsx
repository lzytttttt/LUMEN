/**
 * blocks/ThreeView.tsx —— 3D 块：真 WebGL 运行时 + 降级视图。
 *
 * 生命周期（全部在 effect 里，卸载必定释放）：
 * - `mode='thumb'`：绝不创建 WebGL，直接走静态降级视图。
 * - `mode='stage'`：创建后开循环（只是当前这一幕在跑）。
 * - `mode='play'`：随 `slideActive` 启停。
 * - `mode='print' / 'export'`：只渲染一帧后停住（截图/打印要确定画面）。
 *
 * 失败路径：WebGL 不可用 / 初始化异常 / 上下文丢失 / 预算淘汰 → 静态降级
 * （优先用运行时截下来的 poster，其次块自带的 posterAssetId，最后是主题渐变 + preset 名）。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ThemeColors, ThreeBlock } from '@/schema/deck'
import { useAssetUrl } from '@/assets/assetStore'
import { captureThreeFrame, createThreeRuntime, type ThreeRuntime } from '../three/runtime'
import { getThreePoster, setThreePoster, subscribeThreePosters } from '../three/posterCache'
import type { RenderMode } from '../types'

type ThreeState = 'idle' | 'live' | 'fallback'

export interface ThreeViewProps {
  block: ThreeBlock
  mode: RenderMode
  slideActive: boolean
  colors: ThemeColors
}

export function ThreeView({ block, mode, slideActive, colors }: ThreeViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const runtimeRef = useRef<ThreeRuntime | null>(null)
  const sizeRef = useRef({ w: block.w, h: block.h })
  const [state, setState] = useState<ThreeState>('idle')
  const [poster, setPoster] = useState<string | null>(null)
  const posterAssetUrl = useAssetUrl(block.posterAssetId)
  // 缩略图共用「这一幕渲染过的最后一帧」：thumb 不建 WebGL 也能有真实预览
  const cachedPoster = useSyncExternalStore(
    subscribeThreePosters,
    () => getThreePoster(block.id),
    () => null,
  )

  const isThumb = mode === 'thumb'
  const descriptorKey = useMemo(() => JSON.stringify(block.descriptor), [block.descriptor])
  const colorsKey = `${colors.bg}|${colors.fg}|${colors.muted}|${colors.surface}|${colors.line}|${colors.accent}|${colors.accent2}`

  // 尺寸变化只 resize，不重建上下文
  useEffect(() => {
    sizeRef.current = { w: block.w, h: block.h }
    runtimeRef.current?.resize(block.w, block.h)
  }, [block.w, block.h, state])

  // 创建 / 释放：thumb 永不进这里创建 WebGL
  useEffect(() => {
    if (isThumb) {
      setState('fallback')
      return
    }
    const host = hostRef.current
    if (!host) return

    let cancelled = false
    let runtime: ThreeRuntime | null = null

    // 每次新建都换一个干净的 canvas：复用被 forceContextLoss 过的画布拿不回上下文
    const canvas = document.createElement('canvas')
    canvas.className = 'lumen-three__canvas'
    canvas.setAttribute('aria-hidden', 'true')
    host.appendChild(canvas)

    setPoster(null)
    setState('idle')

    void createThreeRuntime({
      canvas,
      descriptor: block.descriptor,
      colors,
      key: block.id,
      width: sizeRef.current.w,
      height: sizeRef.current.h,
      onSuspend: (nextPoster) => {
        if (cancelled) return
        runtimeRef.current = null
        if (nextPoster) setThreePoster(block.id, nextPoster)
        setPoster(nextPoster)
        setState('fallback')
      },
      onError: () => {
        if (cancelled) return
        runtimeRef.current = null
        setState('fallback')
      },
    }).then((created) => {
      if (cancelled) {
        created?.dispose()
        return
      }
      if (!created) {
        setState('fallback')
        return
      }
      runtime = created
      runtimeRef.current = created
      created.resize(sizeRef.current.w, sizeRef.current.h)
      created.setActive(mode === 'play' ? slideActive : mode === 'stage')
      setState('live')
    })

    return () => {
      cancelled = true
      runtimeRef.current = null
      runtime?.dispose()
      runtime = null
      canvas.remove()
    }
    // mode/slideActive 只影响启停，不进依赖，避免切幕时重建上下文
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id, descriptorKey, colorsKey, isThumb])

  // 启停：播放态跟随 slideActive；舞台常开；打印/导出只留一帧
  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    runtime.setActive(mode === 'play' ? slideActive : mode === 'stage')
  }, [mode, slideActive, state])

  // 画面稳定后抓一帧存进缓存，供幕栏缩略图使用（只抓一次，不反复截图）
  useEffect(() => {
    if (state !== 'live' || isThumb) return
    const timer = window.setTimeout(() => {
      const shot = captureThreeFrame(block.id)
      if (shot) setThreePoster(block.id, shot)
    }, 620)
    return () => window.clearTimeout(timer)
  }, [state, block.id, isThumb])

  const fallbackSrc = poster ?? cachedPoster ?? posterAssetUrl ?? null

  return (
    <div
      className="lumen-three"
      data-three-state={state}
      data-three-preset={block.descriptor.preset}
      data-interactive={block.interactive ? 'true' : undefined}
    >
      <div ref={hostRef} className="lumen-three__canvas-host" />
      {state === 'live' ? null : (
        <div className="lumen-three__fallback" data-three-placeholder="true">
          {fallbackSrc ? (
            <img className="lumen-three__poster" src={fallbackSrc} alt="" draggable={false} />
          ) : (
            <>
              <span className="lumen-three__preset">3D · {block.descriptor.preset}</span>
              <span className="lumen-three__meta">
                {block.descriptor.palette} / {block.descriptor.light}
              </span>
            </>
          )}
        </div>
      )}
      {block.descriptor.grain > 0 ? (
        <div className="lumen-three__grain" style={{ opacity: Math.min(1, block.descriptor.grain) }} aria-hidden="true" />
      ) : null}
    </div>
  )
}
