/**
 * blocks/HtmlView.tsx —— HTML 块（沙箱 iframe）。
 *
 * 安全边界（不要放宽）：
 * - `sandbox="allow-scripts"`：无 allow-same-origin，脚本拿不到父页与 IndexedDB；
 * - 内建 CSP：默认禁止一切网络请求，只允许内联样式/脚本与 data/blob 资源；
 * - `mode='thumb'` 不加载 iframe（缩略图 9 幕滚动不为 HTML 付代价）。
 *
 * `heightMode='content'` 时用 postMessage 测高：
 * 只接受 `event.source === iframe.contentWindow` 且负载形状正确的消息，其余一律忽略。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HtmlBlock } from '@/schema/deck'
import type { RenderMode } from '../types'

/** iframe → 父页的测高消息类型。 */
export const HTML_HEIGHT_MESSAGE = 'lumen:height'

export function HtmlView({ block, mode }: { block: HtmlBlock; mode: RenderMode }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [contentHeight, setContentHeight] = useState<number | null>(null)
  const measure = mode !== 'thumb' && block.heightMode === 'content'
  const srcDoc = useMemo(() => composeHtmlDoc(block, { measure }), [block, measure])

  useEffect(() => {
    if (!measure) return
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current
      // 唯一可信来源：本块的 iframe 窗口；其余消息（包括任意父页/兄弟 iframe）全部丢弃。
      if (!frame || event.source !== frame.contentWindow) return
      const payload = event.data as unknown
      if (!payload || typeof payload !== 'object') return
      const { type, height } = payload as { type?: unknown; height?: unknown }
      if (type !== HTML_HEIGHT_MESSAGE) return
      if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return
      // 防御脚本失控：最多按块高的 4 倍收口
      const capped = Math.min(Math.round(height), Math.max(1, block.h * 4))
      setContentHeight((previous) => (previous === capped ? previous : capped))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [measure, block.h])

  useEffect(() => {
    setContentHeight(null)
  }, [block.html, block.css, block.heightMode])

  return (
    <div className="lumen-html" data-height-mode={block.heightMode}>
      {mode === 'thumb' ? (
        <div className="lumen-placeholder" data-html-thumb="true">
          <strong>HTML</strong>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          title={block.name ?? 'html-block'}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          loading="lazy"
          referrerPolicy="no-referrer"
          style={measure && contentHeight ? { height: contentHeight } : undefined}
        />
      )}
    </div>
  )
}

/**
 * HTML 块文档：内建 CSP，默认禁止一切网络请求；只允许内联样式/脚本与 data/blob 图片。
 * 沙箱无 allow-same-origin，脚本拿不到父页与 IndexedDB。
 * `measure` 为真时注入测高脚本（把 scrollHeight 通过 postMessage 报给父页）。
 */
export function composeHtmlDoc(block: HtmlBlock, opts?: { measure?: boolean }): string {
  const csp =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:"
  const measureScript = opts?.measure ? `<script>${MEASURE_SCRIPT}</script>` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
    :root { color-scheme: light dark; }
    html,body { margin:0; height:100%; }
    body { font-family: system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif; }
  </style><style>${block.css ?? ''}</style></head><body>${block.html}${measureScript}</body></html>`
}

/** 只在 content 高度模式下注入：滚动高度变化时上报（去抖 + ResizeObserver）。 */
const MEASURE_SCRIPT = `(function(){
  var last = -1;
  function report(){
    var h = Math.ceil(Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    ));
    if (!h || Math.abs(h - last) < 2) return;
    last = h;
    try { parent.postMessage({ type: '${HTML_HEIGHT_MESSAGE}', height: h }, '*'); } catch (e) {}
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('load', report);
    document.addEventListener('DOMContentLoaded', report);
    setTimeout(report, 60);
    setTimeout(report, 320);
    if (window.ResizeObserver && document.documentElement) {
      try { new ResizeObserver(report).observe(document.documentElement); } catch (e) {}
    }
  }
})();`
