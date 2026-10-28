/**
 * svg/draw.ts —— `animate='draw'` 的描边生长。
 *
 * 只在 `mode='play'` 且 `prefers-reduced-motion` 未开启时运行：
 * 对每条 <path> 用 getTotalLength() 拿长度，配 stroke-dasharray/dashoffset 从"未画出"推到"画完"。
 * 动画结束或卸载时把原始属性原样还原，避免污染 deck 内容。
 */

export interface DrawAnimationOptions {
  /** 单条路径的时长（毫秒），默认 ~900ms。 */
  durationMs?: number
  /** 相邻路径的错峰（毫秒）。 */
  staggerMs?: number
}

const DEFAULT_DURATION = 900
const MAX_STAGGER_TOTAL = 420

/** 运行描边生长；返回清理函数（幂等）。 */
export function runSvgDrawAnimation(host: Element, options: DrawAnimationOptions = {}): () => void {
  const svg = host.querySelector('svg')
  if (!svg) return () => {}

  const paths = Array.from(svg.querySelectorAll('path'))
  if (paths.length === 0) return () => {}

  const duration = Math.max(120, options.durationMs ?? DEFAULT_DURATION)
  const stagger =
    options.staggerMs ?? (paths.length > 1 ? Math.min(120, MAX_STAGGER_TOTAL / (paths.length - 1)) : 0)

  const restores: Array<() => void> = []
  const animations: Animation[] = []

  paths.forEach((path, index) => {
    let length = 0
    try {
      length = path.getTotalLength()
    } catch {
      length = 0
    }
    if (!Number.isFinite(length) || length <= 0) return

    const previousDash = path.getAttribute('stroke-dasharray')
    const previousOffset = path.getAttribute('stroke-dashoffset')
    restores.push(() => {
      if (previousDash === null) path.removeAttribute('stroke-dasharray')
      else path.setAttribute('stroke-dasharray', previousDash)
      if (previousOffset === null) path.removeAttribute('stroke-dashoffset')
      else path.setAttribute('stroke-dashoffset', previousOffset)
    })

    path.setAttribute('stroke-dasharray', `${length} ${length}`)
    path.setAttribute('stroke-dashoffset', String(length))

    if (typeof path.animate !== 'function') {
      // jsdom / 老浏览器：直接显示最终状态
      path.setAttribute('stroke-dashoffset', '0')
      return
    }
    try {
      animations.push(
        path.animate(
          [{ strokeDashoffset: `${length}` }, { strokeDashoffset: '0' }],
          {
            duration,
            delay: Math.round(index * stagger),
            easing: 'cubic-bezier(.32,.72,0,1)',
            fill: 'both',
          },
        ),
      )
    } catch {
      path.setAttribute('stroke-dashoffset', '0')
    }
  })

  let finished = 0
  const settle = (): void => {
    finished += 1
    if (finished < animations.length) return
    // 画完之后把作者原本的虚线设置还回去，避免残留 dasharray
    for (const restore of restores) restore()
  }
  for (const animation of animations) {
    animation.onfinish = settle
    animation.oncancel = settle
  }
  if (animations.length === 0) settle()

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const animation of animations) {
      try {
        animation.onfinish = null
        animation.oncancel = null
        animation.cancel()
      } catch {
        /* ignore */
      }
    }
    for (const restore of restores) restore()
  }
}
