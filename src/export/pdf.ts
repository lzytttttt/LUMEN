/**
 * pdf.ts —— PDF 导出（其实是一次"打印到 PDF"）。
 *
 * 两条路，优先第一条：
 * 1. **就地打印**：`PrintHost` 已挂载时，把打印视图挂在当前页上，`window.print()` 后收起。
 *    好处：用的是 store 里的当前 deck（含未保存改动），不需要开新窗口。
 * 2. **打印路由**：`PrintHost` 不在时（或显式要求），开 `?print=1` 新窗口，由那边自己打印。
 *
 * 打印对话框不可 await，所以 Promise 在 `afterprint` 或 2s 兜底时 resolve（见 printRoute）。
 */
import type { Deck } from '@/schema/deck'
import { t } from '@/i18n'
import {
  buildPrintUrl,
  finishPrint,
  hasPrintHost,
  requestPrint,
  takePrintJob,
  waitForPrintDone,
} from './printRoute'

export interface PdfOptions {
  /** 跳过就地打印，直接用新窗口打开打印路由。 */
  preferWindow?: boolean
  /** 等待上限（毫秒），默认 180s：抓 3D 帧 + 用户操作打印对话框都算在内。 */
  timeoutMs?: number
}

/**
 * 打开打印视图（调用方可以 await）。
 * resolve 的含义是"打印流程已发起/结束"，不是"用户点了保存"——浏览器的打印对话框不回调结果。
 */
export async function exportPdf(deck: Deck, options: PdfOptions = {}): Promise<void> {
  if (typeof window === 'undefined') throw new Error('exportPdf 只能在浏览器里运行')

  const useInPlace = !options.preferWindow && hasPrintHost()
  if (useInPlace) {
    // 先挂等待者再发请求，避免极快的 finishPrint() 被漏掉。
    const done = waitForPrintDone(options.timeoutMs ?? 180_000)
    requestPrint({ deck })
    await done
    return
  }

  const url = buildPrintUrl()
  const opened = window.open(url, '_blank', 'noopener=no')
  if (!opened) {
    // 弹窗被拦：清掉可能残留的任务，给出可读错误（panels 会显示 export.failed）。
    takePrintJob()
    finishPrint()
    throw new Error(t('export.pdfBlocked'))
  }
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    try {
      opened.addEventListener('load', () => window.setTimeout(finish, 1200), { once: true })
    } catch {
      /* 跨窗口监听失败就靠下面的兜底 */
    }
    window.setTimeout(finish, 6000)
  })
}

/** panels 的候选名兼容（exporterBridge 按名字探测）。 */
export const printDeckToPdf = exportPdf
export const printPdf = exportPdf
