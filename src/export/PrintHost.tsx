/**
 * PrintHost.tsx —— 应用内打印宿主（零 props，由 App 挂载一次）。
 *
 * 触发条件（任一）：
 * 1. 地址栏 `?print=1` / `#print`（新窗口打印路由，`exportPdf` 的兜底路径）；
 * 2. `requestPrint()`（导出弹窗就地打印，`exportPdf` 可 await）。
 *
 * 流程：抓 3D 帧 → 换静态图 → 逐幕堆叠渲染（portal 到 body）→ 等字体/图片 → `window.print()`。
 * 打印结束后：就地打印收起打印页，路由打印保留（方便再打一次）。
 *
 * 注意：整个流程用 `jobRef` 做"这一次任务"的身份标记，而不是 effect 的 alive 标志——
 * 打印流程内部会 setPhase，effect 会因此重跑，用 alive 会把流程自己掐掉。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { useDeckStore } from '@/state/deckStore'
import { useT } from '@/i18n'
import {
  PRINT_CSS,
  finishPrint,
  isPrintRequested,
  startPrint,
  subscribePrintRequest,
  takePrintJob,
  waitForPrintReady,
} from './printRoute'
import { prepareDeckForPrint } from './threeFrames'
import { PrintLayer, PrintPages } from './PrintPages'
import type { Deck } from '@/schema/deck'

type Phase = 'idle' | 'preparing' | 'ready' | 'printing' | 'done'

/** afterprint 迟迟不来时的兜底：最多 45s 后收起打印页。 */
const CLOSE_FALLBACK_MS = 45_000

export function PrintHost(): JSX.Element | null {
  const t = useT()
  const [phase, setPhase] = useState<Phase>('idle')
  const [prepared, setPrepared] = useState<Deck | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  /** 当前打印任务的序号：换任务/卸载时自增，让旧流程自己退出。 */
  const jobRef = useRef(0)
  const busyRef = useRef(false)
  /** 这次打印是否来自"就地请求"（打印完要收起打印页）。 */
  const inPlaceRef = useRef(false)

  const begin = useCallback((fromRoute: boolean) => {
    if (busyRef.current) return
    busyRef.current = true
    jobRef.current += 1
    const jobNumber = jobRef.current
    const job = fromRoute ? null : takePrintJob()
    const source = job?.deck ?? useDeckStore.getState().deck
    inPlaceRef.current = !fromRoute
    if (!source) {
      busyRef.current = false
      setPhase('idle')
      return
    }
    setWarnings([])
    setPrepared(null)
    setPhase('preparing')
    void (async () => {
      try {
        const result = await prepareDeckForPrint(source)
        if (jobRef.current !== jobNumber) return
        setPrepared(result.deck)
        setWarnings(result.warnings)
        setPhase('ready')
      } catch (error) {
        console.error('[export] 打印准备失败', error)
        if (jobRef.current !== jobNumber) return
        // 抓帧失败不该阻断打印：直接用原 deck（3D 幕走渲染层降级）。
        setWarnings([error instanceof Error ? error.message : String(error)])
        setPrepared(source)
        setPhase('ready')
      }
    })()
  }, [])

  // 挂载：路由触发 + 订阅就地请求；卸载时取消在跑的任务
  useEffect(() => {
    const unsubscribe = subscribePrintRequest(() => begin(false))
    if (isPrintRequested()) begin(true)
    return () => {
      unsubscribe()
      jobRef.current += 1
      busyRef.current = false
      document.documentElement.classList.remove('lumen-printing')
    }
  }, [begin])

  // 打印页就绪 → 等排版 → 调起打印 → 收敛
  useEffect(() => {
    if (phase !== 'ready' || !prepared) return
    const jobNumber = jobRef.current
    document.documentElement.classList.add('lumen-printing')
    void (async () => {
      await waitForPrintReady()
      if (jobRef.current !== jobNumber) return
      setPhase('printing')
      const run = startPrint()
      await run.settled
      if (jobRef.current !== jobNumber) return
      // 打印对话框不可 await：先给调用方信号，DOM 收在对话框真正关闭之后。
      finishPrint()
      await Promise.race([
        run.closed,
        new Promise<void>((resolve) => setTimeout(resolve, CLOSE_FALLBACK_MS)),
      ])
      if (jobRef.current !== jobNumber) return
      if (inPlaceRef.current) {
        setPrepared(null)
        document.documentElement.classList.remove('lumen-printing')
      }
      setPhase('done')
      busyRef.current = false
    })()
  }, [phase, prepared])

  const closeOverlay = useCallback(() => {
    jobRef.current += 1
    busyRef.current = false
    setPrepared(null)
    setPhase('idle')
    document.documentElement.classList.remove('lumen-printing')
    finishPrint()
  }, [])

  if (phase === 'idle') return null

  return (
    <>
      <style id="lumen-print-css">{PRINT_CSS}</style>
      {phase === 'preparing' ? (
        <div className="lumen-print__state" data-print-state="preparing">
          {t('export.pdfRendering')}
        </div>
      ) : null}
      {prepared ? (
        <PrintLayer>
          <div className="lumen-print__bar" data-print-state={phase}>
            <strong>{t('export.pdfPrint')}</strong>
            <span>
              {t('export.progress')} · {prepared.slides.length}
            </span>
            {warnings.length > 0 ? <span data-print-warnings>{warnings[0]}</span> : null}
            <button type="button" onClick={() => void startPrint()}>
              {t('export.pdfPrint')}
            </button>
            <button type="button" onClick={closeOverlay}>
              {t('common.action.close')}
            </button>
            <span className="lumen-print__hint">{t('export.pdfHint')}</span>
          </div>
          <PrintPages deck={prepared} />
        </PrintLayer>
      ) : null}
    </>
  )
}
