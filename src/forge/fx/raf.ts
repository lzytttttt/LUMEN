/**
 * forge/fx/raf.ts —— 单例 rAF 调度器（D11：不引依赖）。
 * 只有一个循环：页面隐藏时暂停，恢复时续跑；退出造幕台时 `stop()` 保证回调归零。
 */
type Frame = (now: number, delta: number) => void

const frames = new Set<Frame>()
let handle: number | null = null
let last = 0
let paused = false

function loop(now: number): void {
  const delta = last === 0 ? 16 : Math.min(now - last, 64)
  last = now
  handle = null
  for (const frame of frames) frame(now, delta)
  if (frames.size > 0 && !paused) handle = requestAnimationFrame(loop)
}

function ensure(): void {
  if (handle !== null || paused || frames.size === 0) return
  handle = requestAnimationFrame(loop)
}

function onVisibility(): void {
  paused = document.visibilityState === 'hidden'
  if (paused) {
    if (handle !== null) cancelAnimationFrame(handle)
    handle = null
  } else {
    last = 0
    ensure()
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', onVisibility)
}

export const raf = {
  subscribe(frame: Frame): () => void {
    frames.add(frame)
    ensure()
    return () => {
      frames.delete(frame)
      if (frames.size === 0) this.stop()
    }
  },
  stop(): void {
    frames.clear()
    if (handle !== null) cancelAnimationFrame(handle)
    handle = null
    last = 0
  },
  get count(): number {
    return frames.size
  },
}

/** 单测用：直接推进一帧，不依赖浏览器。 */
export function tickForTest(now = performance.now(), delta = 16): void {
  for (const frame of frames) frame(now, delta)
}

/** 采样一帧间隔：返回 unsubscribe。 */
export function sampleFrames(onSample: (interval: number) => void): () => void {
  return raf.subscribe((_now, delta) => onSample(delta))
}
