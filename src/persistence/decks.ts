/** decks.ts —— 演示与设置的用户态持久化（只做存取，不碰 React）。 */
import { deckSchema, type Deck } from '@/schema/deck'
import { DEFAULT_SETTINGS, type SettingsSnapshot } from '@/state/settingsStore'
import { kvDel, kvEntries, kvGet, kvKeys, kvSet } from './kv'

const SETTINGS_KEY = 'app-settings'

export interface DeckSummary {
  id: string
  title: string
  slides: number
  themeId: string
  updatedAt: number
  createdAt: number
}

export async function saveDeck(deck: Deck): Promise<boolean> {
  return kvSet('decks', deck.id, deck)
}

export async function loadDeck(id: string): Promise<Deck | null> {
  const raw = await kvGet<unknown>('decks', id)
  if (!raw) return null
  const parsed = deckSchema.safeParse(raw)
  if (!parsed.success) {
    console.warn('[decks] 本地数据不符合当前 schema，已忽略', parsed.error.issues.slice(0, 3))
    return null
  }
  return parsed.data
}

export async function deleteDeck(id: string): Promise<void> {
  await kvDel('decks', id)
}

export async function listDeckSummaries(): Promise<DeckSummary[]> {
  const all = await kvEntries<unknown>('decks')
  const out: DeckSummary[] = []
  for (const [id, value] of all) {
    const parsed = deckSchema.safeParse(value)
    if (!parsed.success) continue
    const deck = parsed.data
    out.push({
      id: deck.id ?? id,
      title: deck.title,
      slides: deck.slides.length,
      themeId: deck.themeId,
      updatedAt: deck.meta.updatedAt,
      createdAt: deck.meta.createdAt,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deckExists(id: string): Promise<boolean> {
  return (await kvKeys('decks')).includes(id)
}

export async function saveSettings(snapshot: SettingsSnapshot): Promise<boolean> {
  return kvSet('settings', SETTINGS_KEY, snapshot)
}

export async function loadSettings(): Promise<SettingsSnapshot> {
  const raw = await kvGet<Partial<SettingsSnapshot>>('settings', SETTINGS_KEY)
  if (!raw) return { ...DEFAULT_SETTINGS }
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    llm: { ...DEFAULT_SETTINGS.llm, ...(raw.llm ?? {}) },
  }
}
