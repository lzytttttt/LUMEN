import { getTheme } from '@/themes'
import { useDeckStore } from '@/state/deckStore'

export function useTheme() {
  const themeId = useDeckStore((s) => s.deck?.themeId)
  return getTheme(themeId)
}
