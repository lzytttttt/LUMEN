/** selectors.ts —— 从 store 派生常用数据（组件只用这些）。 */
import { useDeckStore } from './deckStore'
import { useUiStore } from './uiStore'
import { getTheme } from '@/themes'
import type { Deck, Slide, Theme } from '@/schema/deck'

export function useDeck(): Deck {
  return useDeckStore((s) => s.deck)
}

export function useSlides(): Slide[] {
  return useDeckStore((s) => s.deck.slides)
}

export function useActiveSlideId(): string | null {
  return useUiStore((s) => s.activeSlideId)
}

export function activeSlideIdOf(deck: Deck | undefined, requested: string | null): string | null {
  if (!deck || deck.slides.length === 0) return null
  if (requested && deck.slides.some((s) => s.id === requested)) return requested
  return deck.slides[0].id
}

export function useActiveSlide(): Slide | null {
  const deck = useDeck()
  const requested = useActiveSlideId()
  const id = activeSlideIdOf(deck, requested)
  if (!id) return null
  return deck.slides.find((s) => s.id === id) ?? null
}

export function useActiveSlideIndex(): number {
  const deck = useDeck()
  const requested = useActiveSlideId()
  const id = activeSlideIdOf(deck, requested)
  return id ? deck.slides.findIndex((s) => s.id === id) : 0
}

export function useDeckTheme(): Theme {
  const themeId = useDeckStore((s) => s.deck.themeId)
  return getTheme(themeId)
}

export function useThemeOverrides() {
  return useDeckStore((s) => s.deck.themeOverrides)
}

export function findSlide(deck: Deck, slideId?: string | null): Slide | undefined {
  if (!slideId) return deck.slides[0]
  return deck.slides.find((s) => s.id === slideId)
}

export function findBlock(slide: Slide | undefined, blockId: string) {
  return slide?.blocks.find((b) => b.id === blockId)
}
