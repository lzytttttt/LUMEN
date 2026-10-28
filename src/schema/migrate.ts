/**
 * migrate.ts —— 导入/读取时的校验与迁移。
 * v1 只有 schemaVersion=1；此处预留迁移链，未来版本在此逐级升级再校验。
 */
import type { z } from 'zod'
import {
  SCHEMA_VERSION,
  deckFileSchema,
  deckSchema,
  type Deck,
  type DeckFile,
} from './deck'

export interface ParseOutcome<T> {
  ok: boolean
  value?: T
  issues: string[]
}

export function formatIssues(error: z.ZodError, limit = 8): string[] {
  return error.issues.slice(0, limit).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 迁移链：把任意历史版本就地升级到当前版本。 */
function upgrade(raw: Record<string, unknown>): Record<string, unknown> {
  const next = { ...raw }
  if (typeof next.schemaVersion !== 'number') next.schemaVersion = SCHEMA_VERSION
  // v0 → v1（历史草案）：补齐 meta / themeId
  if (!next.meta) {
    const now = Date.now()
    next.meta = { createdAt: now, updatedAt: now, origin: 'import' }
  }
  if (typeof next.themeId !== 'string') next.themeId = 'noir'
  if (typeof next.lang !== 'string') next.lang = 'zh'
  if (next.schemaVersion === 0) next.schemaVersion = SCHEMA_VERSION
  return next
}

export function parseDeck(input: unknown): ParseOutcome<Deck> {
  if (!isRecord(input)) return { ok: false, issues: ['文件内容不是对象'] }
  const upgraded = upgrade(input)
  const result = deckSchema.safeParse(upgraded)
  if (!result.success) return { ok: false, issues: formatIssues(result.error) }
  return { ok: true, value: result.data, issues: [] }
}

export function parseDeckFile(input: unknown): ParseOutcome<DeckFile> {
  if (!isRecord(input)) return { ok: false, issues: ['文件内容不是对象'] }
  // 允许直接导入裸 deck（没有 kind 包装）
  if (!('deck' in input) && 'slides' in input) {
    const deckOutcome = parseDeck(input)
    if (!deckOutcome.ok || !deckOutcome.value) return { ok: false, issues: deckOutcome.issues }
    return {
      ok: true,
      issues: [],
      value: {
        kind: 'lumen.deck',
        schemaVersion: SCHEMA_VERSION,
        exportedAt: Date.now(),
        deck: deckOutcome.value,
        assets: {},
      },
    }
  }
  const payload = { ...input }
  if (!('kind' in payload)) payload.kind = 'lumen.deck'
  if (isRecord(payload.deck)) payload.deck = upgrade(payload.deck as Record<string, unknown>)
  const result = deckFileSchema.safeParse(payload)
  if (!result.success) return { ok: false, issues: formatIssues(result.error) }
  return { ok: true, value: result.data, issues: [] }
}

/** 从文件名猜标题。 */
export function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.(lumen\.)?json$/i, '')
    .replace(/\.html?$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .slice(0, 120) || '未命名演示'
}
