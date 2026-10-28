/**
 * autosave.ts —— 800ms 防抖自动保存 + 页面隐藏/关闭时 flush。
 * 只订阅 deck 的 revision，避免高频重渲染。
 */
import { useDeckStore } from '@/state/deckStore'
import { saveDeck } from './decks'

let installed = false

export function startAutosave(): () => void {
  if (installed) return () => undefined
  installed = true

  let timer: number | undefined
  let lastRevision = -1
  let pending = false

  const flush = () => {
    const state = useDeckStore.getState()
    if (!state.deck || !pending) return
    pending = false
    void saveDeck(state.deck)
  }

  const schedule = () => {
    pending = true
    window.clearTimeout(timer)
    timer = window.setTimeout(flush, 800)
  }

  const unsubscribe = useDeckStore.subscribe((state) => {
    if (!state.deck) return
    if (state.revision === lastRevision) return
    lastRevision = state.revision
    schedule()
  })

  const onHide = () => {
    if (document.visibilityState === 'hidden') flush()
  }
  const onUnload = () => flush()
  document.addEventListener('visibilitychange', onHide)
  window.addEventListener('beforeunload', onUnload)

  return () => {
    unsubscribe()
    document.removeEventListener('visibilitychange', onHide)
    window.removeEventListener('beforeunload', onUnload)
    window.clearTimeout(timer)
    flush()
    installed = false
  }
}
