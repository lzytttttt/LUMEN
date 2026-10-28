/**
 * lintBridge.ts —— 「检查」页签的数据来源。
 *
 * render-core 的 `src/lint/deckLint.ts` 可能尚未落地，因此这里用 `import.meta.glob`
 * 做**零构建错误**的可选加载：模块存在就用真检查器，不存在就退回 localLint。
 * 不用静态 import，是为了让 panels 分支随时能独立通过 tsc / vite build。
 */
import { useEffect, useMemo, useState } from 'react'
import type { Deck } from '@/schema/deck'
import { localLint, type DeckIssue } from './localLint'

export type { DeckIssue }

type DeckLintFn = (deck: Deck) => unknown

/** 约定导出：`export function lintDeck(deck: Deck): DeckIssue[]`（也兼容 default）。 */
const lintModules = import.meta.glob('../../lint/*.ts')

let cache: DeckLintFn | null | undefined

export async function loadDeckLint(): Promise<DeckLintFn | null> {
  if (cache !== undefined) return cache
  const entry = Object.entries(lintModules).find(([path]) => /deckLint/i.test(path))
  if (!entry) {
    cache = null
    return null
  }
  try {
    const mod = (await entry[1]()) as { lintDeck?: DeckLintFn; default?: DeckLintFn }
    const fn = mod.lintDeck ?? mod.default
    cache = typeof fn === 'function' ? fn : null
  } catch (error) {
    console.warn('[panels] lint 模块加载失败，使用本地基础检查', error)
    cache = null
  }
  return cache
}

/** 把外部检查器的返回结构收敛成面板可渲染的统一形状。 */
export function normalizeIssues(raw: unknown): DeckIssue[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { issues?: unknown }).issues)
      ? ((raw as { issues: unknown[] }).issues)
      : []
  const out: DeckIssue[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const code = typeof record.code === 'string' && record.code !== '' ? record.code : 'unknown'
    const severity =
      record.severity === 'error' || record.severity === 'info' || record.severity === 'warn'
        ? record.severity
        : 'warn'
    out.push({
      code,
      severity,
      slideId: typeof record.slideId === 'string' ? record.slideId : undefined,
      blockId: typeof record.blockId === 'string' ? record.blockId : undefined,
      message: typeof record.message === 'string' ? record.message : undefined,
      params:
        record.params && typeof record.params === 'object'
          ? (record.params as Record<string, string | number>)
          : undefined,
    })
  }
  return out
}

export interface DeckLintState {
  issues: DeckIssue[]
  /** module = 真检查器；local = 兜底规则；pending = 还没探测完。 */
  kernel: 'module' | 'local' | 'pending'
}

export function useDeckLint(deck: Deck | null, refreshKey = 0): DeckLintState {
  const [fn, setFn] = useState<DeckLintFn | null>(null)
  const [probed, setProbed] = useState(false)

  useEffect(() => {
    let alive = true
    void loadDeckLint().then((resolved) => {
      if (!alive) return
      setFn(() => resolved)
      setProbed(true)
    })
    return () => {
      alive = false
    }
  }, [])

  const issues = useMemo<DeckIssue[]>(() => {
    if (!deck) return []
    if (fn) {
      try {
        return normalizeIssues(fn(deck))
      } catch (error) {
        console.warn('[panels] lintDeck 抛错，回退本地检查', error)
        return localLint(deck)
      }
    }
    return localLint(deck)
  }, [deck, fn, refreshKey])

  return {
    issues,
    kernel: !probed ? 'pending' : fn ? 'module' : 'local',
  }
}
