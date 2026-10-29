/**
 * exporterBridge.ts —— 弹窗到导出内核的可选桥。
 *
 * exporter 模块可能尚未落地（`src/export/standalone.ts` / `pdf.ts` / `png.ts`），
 * 因此用 `import.meta.glob` 做**零构建错误**的可选加载：
 * 模块不在 → missing（弹窗给出「内核尚未就绪」提示）；在 → 按约定函数名调用。
 */
import type { Deck } from '@/schema/deck'

export type ExportKind = 'standalone' | 'pdf' | 'png'

export interface ExportOutcome {
  status: 'ok' | 'missing' | 'error'
  error?: string
  /** 导出函数的返回值（PNG 导出会带 failed 清单，弹窗据此提供单页重试）。 */
  result?: unknown
}

const modules = import.meta.glob('../../export/*.ts')

/** 内核可能导出的函数名（按优先级），便于 exporter 用任意一个名字落地。 */
const CANDIDATES: Record<ExportKind, string[]> = {
  standalone: ['exportStandalone', 'buildStandalone', 'exportStandaloneHtml', 'exportHtml'],
  pdf: ['exportPdf', 'buildPdf', 'printDeckToPdf', 'printPdf'],
  png: ['exportPng', 'exportPngs', 'buildPng', 'exportSlidePng'],
}

function entryOf(kind: ExportKind): [string, () => Promise<unknown>] | undefined {
  return Object.entries(modules).find(([path]) => new RegExp(`/${kind}\\.ts$`).test(path))
}

export function exporterAvailable(kind: ExportKind): boolean {
  return entryOf(kind) !== undefined
}

export async function runExporter(
  kind: ExportKind,
  deck: Deck,
  options: Record<string, unknown> = {},
): Promise<ExportOutcome> {
  const entry = entryOf(kind)
  if (!entry) return { status: 'missing' }
  try {
    const mod = (await entry[1]()) as Record<string, unknown>
    const candidate = CANDIDATES[kind]
      .map((name) => mod[name])
      .find((value) => typeof value === 'function')
    const fn = candidate ?? (typeof mod.default === 'function' ? mod.default : undefined)
    if (typeof fn !== 'function') return { status: 'missing' }
    const result = await (fn as (deckArg: Deck, opts?: Record<string, unknown>) => unknown)(deck, options)
    return { status: 'ok', result }
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}
