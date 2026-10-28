/**
 * bootstrap.ts —— 启动流程：读设置 → 读上次演示（或示例）→ 挂自动保存。
 * 任何一步失败都要能降级到"可用的空演示"，不把白屏留给用户。
 */
import { createSampleDeck } from '@/sample/sample-deck'
import { useDeckStore } from '@/state/deckStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useUiStore } from '@/state/uiStore'
import { loadDeck, listDeckSummaries, loadSettings, saveDeck } from '@/persistence/decks'
import { startAutosave } from '@/persistence/autosave'
import { startSettingsSync } from '@/persistence/settingsSync'

export async function bootstrap(): Promise<void> {
  const settings = useSettingsStore.getState()
  try {
    const snapshot = await loadSettings()
    settings.hydrate(snapshot)
  } catch (error) {
    console.warn('[bootstrap] 读取设置失败，使用默认值', error)
    settings.hydrate(null)
  }

  startSettingsSync()

  let deck = null
  try {
    const current = useSettingsStore.getState()
    if (current.lastDeckId) deck = await loadDeck(current.lastDeckId)
    if (!deck) {
      const summaries = await listDeckSummaries()
      if (summaries.length > 0) deck = await loadDeck(summaries[0].id)
    }
  } catch (error) {
    console.warn('[bootstrap] 读取演示失败', error)
  }

  if (!deck) {
    try {
      deck = createSampleDeck(useSettingsStore.getState().lang)
    } catch (error) {
      console.error('[bootstrap] 示例演示生成失败', error)
      useUiStore.getState().setBootError(String(error))
      return
    }
  }

  useDeckStore.getState().setDeck(deck, { resetHistory: true })
  useUiStore.getState().setActiveSlide(deck.slides[0]?.id ?? null)
  useSettingsStore.getState().setLastDeckId(deck.id)

  try {
    await saveDeck(deck)
  } catch (error) {
    console.warn('[bootstrap] 首次保存失败', error)
  }

  startAutosave()
}
