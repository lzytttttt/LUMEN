/**
 * forge/sessions.ts —— 「最近一套」的 kv 存取（02 §3.3）。
 *
 * 为什么只存大纲：成品 Deck 动辄几百 KB，五套就能压爆 IndexedDB 预算；
 * 而「最近一套」在体验上只需要能一键回到那次的大纲（02 §1 的续接语义）。
 * 读写都在 try/catch 里：kv 不可用（无痕窗口 / 内存兜底）时退化成「没有最近一套」，不阻断工作流。
 */
import { kvGet, kvSet } from '@/persistence/kv'
import { outlineSchema } from '@/schema/deck'
import type { ReuseEntry } from './types'

/** 最多留五套：再多也不是「最近」了。 */
export const REUSE_MAX = 5

const STORE = 'forge'
const KEY = 'reuse'

/** 标题/提示词在 kv 里也守长度，防止被手改过的数据撑爆 draft 预算。 */
const TITLE_MAX = 160
const PROMPT_MAX = 2000

function random4(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0')
}

function normalizeOne(raw: unknown): ReuseEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, TITLE_MAX) : ''
  if (id === '' || title === '') return null
  const parsed = outlineSchema.safeParse(input.outline)
  if (!parsed.success) return null
  const count = typeof input.count === 'number' && Number.isFinite(input.count) ? Math.max(0, Math.trunc(input.count)) : parsed.data.slides.length
  return {
    id,
    title,
    prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, PROMPT_MAX) : '',
    themeId: typeof input.themeId === 'string' ? input.themeId.slice(0, 60) : '',
    count,
    at: typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now(),
    outline: parsed.data,
  }
}

/** 坏数据丢弃（不抛）：单条不合格就跳过，其余照常返回。 */
export function normalizeReuse(raw: unknown): ReuseEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ReuseEntry[] = []
  for (const item of raw) {
    if (out.length >= REUSE_MAX) break
    try {
      const entry = normalizeOne(item)
      if (entry) out.push(entry)
    } catch {
      // 脏数据只丢不抛：读回失败等于「没有最近一套」，界面静默自愈。
    }
  }
  return out
}

export async function loadReuse(): Promise<ReuseEntry[]> {
  try {
    return normalizeReuse(await kvGet<unknown>(STORE, KEY))
  } catch {
    return []
  }
}

async function save(entries: ReuseEntry[]): Promise<void> {
  try {
    await kvSet(STORE, KEY, entries)
  } catch {
    // 存不下也不影响本次会话：返回给调用方的仍是内存里的最新列表。
  }
}

/** 追加一套到最前；超过 REUSE_MAX 的尾部自然掉出。 */
export async function pushReuse(entry: Omit<ReuseEntry, 'id' | 'at'>): Promise<ReuseEntry[]> {
  const next: ReuseEntry = {
    ...entry,
    title: entry.title.slice(0, TITLE_MAX),
    prompt: (entry.prompt ?? '').slice(0, PROMPT_MAX),
    id: `reuse-${Date.now()}-${random4()}`,
    at: Date.now(),
  }
  const entries = normalizeReuse([next, ...(await loadReuse())])
  await save(entries)
  return entries
}

export async function dropReuse(id: string): Promise<ReuseEntry[]> {
  const entries = (await loadReuse()).filter((entry) => entry.id !== id)
  await save(entries)
  return entries
}
