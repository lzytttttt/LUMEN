import { useEffect, useRef, useState, type RefObject } from 'react'

export interface Size {
  width: number
  height: number
}

/** 观察元素尺寸（缩放计算、缩略图、面板宽度都用它）。 */
export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, Size] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setSize((prev) =>
        Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5
          ? prev
          : { width, height },
      )
    })
    observer.observe(node)
    setSize({ width: node.clientWidth, height: node.clientHeight })
    return () => observer.disconnect()
  }, [])

  return [ref, size]
}

/** 把 1600×900 的舞台适配到容器。 */
export function fitScale(size: Size, pad = 32): number {
  if (size.width <= 0 || size.height <= 0) return 0.5
  const w = Math.max(120, size.width - pad * 2)
  const h = Math.max(80, size.height - pad * 2)
  return Math.min(w / 1600, h / 900)
}
