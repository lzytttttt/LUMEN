/**
 * plugins/host/PluginFrame.tsx —— 沙箱 iframe（属性逐项冻结，02 §4.1）。
 *
 * ```html
 * <iframe sandbox="allow-scripts" srcdoc="<宿主拼装，见 frameDoc.ts>"
 *   referrerpolicy="no-referrer" loading="lazy" title="<插件名>"
 *   data-plugin-frame data-plugin-id="com.example.foo" data-slot="workspace.dock"
 *   style="border:0;width:100%;height:100%;background:transparent;color-scheme:dark light">
 * ```
 * 纪律：**只加 allow-scripts**（无 allow-same-origin / forms / popups / modals / top-navigation /
 * downloads / pointer-lock / presentation / orientation-lock），`allow` 为空（Permissions Policy 全拒）。
 */
import { useCallback, useRef } from 'react'
import type { SlotId } from '../types'

export interface PluginFrameProps {
  frameId: string
  pluginId: string
  slot: SlotId
  title: string
  srcDoc: string
  /** 插件在 registry 的 5 态（`installed|enabled|disabled|quarantined|draft`，02 §3.2 / 06 §3.1 冻结）。 */
  pluginState: string
  /** 帧生命周期（非冻结属性 `data-plugin-frame-status`：booting/ready/error/hung）。 */
  frameStatus: 'booting' | 'ready' | 'error' | 'hung'
  pluginKind: 'declarative' | 'code'
  /** 新窗口可用/丢失时回调（宿主用它登记 `event.source` 主判据）。 */
  onWindow: (frameId: string, win: Window | null) => void
  /** iframe load（仅用于诊断；ready 以帧内 `__ready` 为准）。 */
  onLoad?: () => void
  className?: string
  style?: React.CSSProperties
}

export function PluginFrame(props: PluginFrameProps) {
  const ref = useRef<HTMLIFrameElement | null>(null)
  const { onWindow, frameId } = props

  // 关键：用 ref callback 在 commit 阶段就登记 contentWindow（早于 iframe load / `__ready`），
  // 不能用 useEffect —— srcdoc 帧可能在 effect 之前就发出 ready，宿主会丢掉第一条握手。
  const bindRef = useCallback(
    (node: HTMLIFrameElement | null) => {
      ref.current = node
      onWindow(frameId, node?.contentWindow ?? null)
    },
    [onWindow, frameId],
  )

  return (
    <iframe
      ref={bindRef}
      className={props.className}
      title={props.title}
      sandbox="allow-scripts"
      srcDoc={props.srcDoc}
      referrerPolicy="no-referrer"
      loading="lazy"
      allow=""
      data-plugin-frame=""
      data-plugin-id={props.pluginId}
      data-plugin-kind={props.pluginKind}
      data-plugin-state={props.pluginState}
      data-plugin-frame-state={props.frameStatus}
      data-plugin-slot={props.slot}
      data-frame-id={props.frameId}
      style={{
        border: 0,
        width: '100%',
        height: '100%',
        background: 'transparent',
        colorScheme: 'dark light',
        display: 'block',
        ...props.style,
      }}
      onLoad={props.onLoad}
    />
  )
}
