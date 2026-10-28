/**
 * printRoute.ts —— 打印路由与打印请求总线（PDF 导出与独立 HTML 共用）。
 *
 * 两种触发方式，最终都落到同一套「逐幕堆叠 + window.print()」：
 * 1. 地址栏路由：`?print=1` 或 `#print`（新窗口/独立 HTML 里直接打开）；
 * 2. 应用内请求：`requestPrint()` 由导出弹窗调用，PrintHost 已挂载时就地渲染并打印。
 *
 * 打印对话框本身不可 await，所以这里给出两档 Promise：
 * - `settled`：`afterprint` 或 2s 兜底（调用方据此汇报"已发起打印"）；
 * - `closed`：`afterprint` 真正触发（可能永远不来，用于卸载打印 DOM）。
 */
import type { Deck } from '@/schema/deck'

/* -------------------------------- 打印样式 -------------------------------- */

/** 打印样式表：页面尺寸 = 舞台尺寸，底色强制打印，工作台 UI 一律隐藏。 */
export const PRINT_CSS = `
@page { size: 1600px 900px; margin: 0; }

html.lumen-printing,
html.lumen-printing body {
  background: #ffffff !important;
  height: auto !important;
  overflow: visible !important;
}

/* 打印层：屏幕上是全屏预览，打印时回到普通文档流（绝对定位会打断分页）。 */
.lumen-print-layer {
  position: fixed;
  inset: 0;
  z-index: 9000;
  background: #ffffff;
}

.lumen-print {
  position: absolute;
  inset: 0;
  overflow: auto;
  background: #ffffff;
}

.lumen-print__page {
  position: relative;
  width: 1600px;
  height: 900px;
  overflow: hidden;
  background: #ffffff;
  break-after: page;
  page-break-after: always;
  break-inside: avoid;
  page-break-inside: avoid;
}
.lumen-print__page:last-child {
  break-after: auto;
  page-break-after: auto;
}

/*
 * 3D 廊报是带透明通道的 PNG：图片容器自带的 surface 底色会在页面上形成一块可见的"板"，
 * 与编辑器里透明 canvas 的观感不一致。打印层内统一去掉这个底色（只作用于打印页）。
 */
.lumen-print .lumen-image {
  background: transparent !important;
}

.lumen-print__bar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  font: 12px/1.4 var(--ui-font, system-ui, sans-serif);
  color: #d8dce4;
  background: #14161c;
}
.lumen-print__bar button {
  font: inherit;
  color: inherit;
  padding: 4px 10px;
  border: 1px solid #3a4050;
  border-radius: 6px;
  background: #1d2029;
  cursor: pointer;
}
.lumen-print__bar button:hover {
  background: #262b36;
}
.lumen-print__hint {
  opacity: 0.6;
  margin-left: auto;
}
.lumen-print__state {
  position: fixed;
  inset: 0;
  z-index: 9100;
  display: flex;
  align-items: center;
  justify-content: center;
  font: 13px/1.6 var(--ui-font, system-ui, sans-serif);
  color: #8b93a5;
  background: #ffffff;
}

@media print {
  html,
  body {
    background: #ffffff !important;
    height: auto !important;
    overflow: visible !important;
  }

  /* 工作台 UI 直接不参与布局（打印层已 portal 到 body，是 body 的直接子节点） */
  body > *:not(.lumen-print-layer) {
    display: none !important;
  }

  .lumen-print-layer {
    position: static !important;
    inset: auto !important;
    z-index: auto !important;
    display: block !important;
    background: #ffffff !important;
  }

  .lumen-print {
    position: static !important;
    inset: auto !important;
    overflow: visible !important;
    background: #ffffff !important;
  }

  .lumen-print__bar,
  .lumen-print__state {
    display: none !important;
  }

  /* 打印必须出底色：3D 海报、主题底色、形状填充都不能被浏览器省掉 */
  *,
  *::before,
  *::after {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
}
`

/** 把打印样式挂到文档上（幂等；独立 HTML 里已在 <head> 内联，这里只是兜底）。 */
export function ensurePrintCss(doc: Document = document): void {
  if (doc.getElementById('lumen-print-css')) return
  const style = doc.createElement('style')
  style.id = 'lumen-print-css'
  style.textContent = PRINT_CSS
  doc.head.appendChild(style)
}

/* ------------------------------- 路由判定 -------------------------------- */

/** 纯函数：给定 URL（可只给 search/hash 片段），判断是否要走打印视图。 */
export function isPrintRequested(url?: string): boolean {
  const raw =
    url ??
    (typeof location === 'undefined'
      ? ''
      : `${location.pathname}${location.search}${location.hash}`)
  if (!raw) return false
  let parsed: URL
  try {
    parsed = new URL(raw, 'http://lumen.local/')
  } catch {
    return false
  }
  if (parsed.hash === '#print' || parsed.hash === '#/print') return true
  const flag = parsed.searchParams.get('print')
  return flag === '1' || flag === 'true' || flag === ''
}

/** 当前页的打印视图地址（去掉 hash，补上 print=1）。 */
export function buildPrintUrl(href?: string): string {
  const base = href ?? (typeof location === 'undefined' ? 'http://lumen.local/' : location.href)
  const url = new URL(base)
  url.searchParams.set('print', '1')
  url.hash = ''
  return url.toString()
}

/* ------------------------------ 打印请求总线 ------------------------------ */

export interface PrintJob {
  /** 请求方给的 deck 快照（没有就用 store 里的当前 deck）。 */
  deck?: Deck
}

type Listener = () => void

/**
 * 总线状态挂在 globalThis 上：
 * 开发时同一个模块可能因 HMR 时间戳出现两份实例，打印请求不能因此丢掉。
 */
interface PrintBus {
  listeners: Set<Listener>
  queue: PrintJob[]
  waiters: Array<() => void>
}

function bus(): PrintBus {
  const scope = globalThis as { __LUMEN_PRINT_BUS__?: PrintBus }
  if (!scope.__LUMEN_PRINT_BUS__) {
    scope.__LUMEN_PRINT_BUS__ = { listeners: new Set(), queue: [], waiters: [] }
  }
  return scope.__LUMEN_PRINT_BUS__
}

/** PrintHost 是否已挂载（未挂载时 exportPdf 退回"新窗口打印路由"）。 */
export function hasPrintHost(): boolean {
  return bus().listeners.size > 0
}

export function subscribePrintRequest(listener: Listener): () => void {
  bus().listeners.add(listener)
  return () => {
    bus().listeners.delete(listener)
  }
}

/** 发起一次应用内打印（PrintHost 挂载时生效）。 */
export function requestPrint(job: PrintJob = {}): void {
  const state = bus()
  state.queue.push(job)
  for (const listener of [...state.listeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[export] print listener failed', error)
    }
  }
}

/** PrintHost 取走待处理任务（没有则 null）。 */
export function takePrintJob(): PrintJob | null {
  return bus().queue.shift() ?? null
}

/** 是否有待处理任务。 */
export function hasPendingPrintJob(): boolean {
  return bus().queue.length > 0
}

/** 注册一个"等这次打印结束"的等待者，返回 Promise。 */
export function waitForPrintDone(timeoutMs = 180_000): Promise<void> {
  const state = bus()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      state.waiters = state.waiters.filter((item) => item !== finish)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    state.waiters.push(finish)
  })
}

/** PrintHost 在一次打印流程结束后调用，唤醒所有等待者。 */
export function finishPrint(): void {
  const state = bus()
  const waiters = state.waiters
  state.waiters = []
  for (const waiter of waiters) waiter()
}

/** 测试用：清空总线状态。 */
export function resetPrintRoute(): void {
  const state = bus()
  state.listeners.clear()
  state.queue.length = 0
  finishPrint()
}

/* -------------------------------- 打印动作 -------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等字体、布局与图片解码都就绪，避免打出空白页。 */
export async function waitForPrintReady(extraMs = 160): Promise<void> {
  try {
    await document.fonts?.ready
  } catch {
    /* 字体接口缺失时直接继续 */
  }
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  const images = Array.from(document.images)
  await Promise.all(
    images.map(async (img) => {
      if (img.complete) {
        try {
          await img.decode?.()
        } catch {
          /* 解码失败就用现状打印 */
        }
        return
      }
      await new Promise<void>((resolve) => {
        const done = () => resolve()
        img.addEventListener('load', done, { once: true })
        img.addEventListener('error', done, { once: true })
        setTimeout(done, 1500)
      })
    }),
  )
  if (extraMs > 0) await delay(extraMs)
}

export interface PrintRun {
  /** afterprint 或 2s 兜底：给 await 调用方的信号。 */
  settled: Promise<void>
  /** afterprint 真正触发（打印对话框关闭）；可能永远不来。 */
  closed: Promise<void>
}

/** 调起打印对话框。 */
export function startPrint(): PrintRun {
  let settleClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    settleClosed = resolve
  })
  const settled = new Promise<void>((resolve) => {
    let done = false
    const finishSettled = () => {
      if (done) return
      done = true
      window.removeEventListener('afterprint', onAfterPrint)
      clearTimeout(timer)
      resolve()
    }
    // afterprint 才是"对话框真的关了"；2s 只是给 await 调用方的兜底信号。
    const onAfterPrint = () => {
      settleClosed()
      finishSettled()
    }
    const timer = setTimeout(finishSettled, 2000)
    window.addEventListener('afterprint', onAfterPrint)
    try {
      window.print()
    } catch (error) {
      console.error('[export] window.print failed', error)
      settleClosed()
      finishSettled()
    }
  })
  return { settled, closed }
}
