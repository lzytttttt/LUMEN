/**
 * useReturnFocus.ts —— 弹窗关闭后把焦点还给触发元素（06 §4.7 a11y 要求）。
 *
 * 两个时序坑（都实测踩过）：
 * 1. 打开瞬间子组件的 layout effect 会把焦点移进弹窗，父组件的 effect 晚于子组件——
 *    因此「触发元素」必须在 **render 阶段**（open false→true 的那一帧）捕获，那时 commit 还没发生。
 * 2. 插件管理宿主在关闭时会被条件渲染**直接卸载**（不是以 `open=false` 复用），
 *    所以还原动作要放在 effect 的 **cleanup** 里（覆盖「关闭」与「卸载」两种路径），
 *    并用 setTimeout(0) 让它在本次 commit 的焦点副作用之后执行。
 */
import { useEffect, useRef } from 'react'

function focusBack(node: HTMLElement | null): void {
  if (!node || typeof node.focus !== 'function') return
  window.setTimeout(() => {
    if (typeof document !== 'undefined' && document.contains(node)) node.focus({ preventScroll: true })
  }, 0)
}

export function useReturnFocus(open: boolean): void {
  const previous = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)

  if (open && !wasOpen.current && typeof document !== 'undefined') {
    previous.current = document.activeElement as HTMLElement | null
  }
  wasOpen.current = open

  useEffect(() => {
    if (!open) return
    return () => {
      const node = previous.current
      previous.current = null
      focusBack(node)
    }
  }, [open])
}
