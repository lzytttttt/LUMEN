/** vitest 全局环境补齐（jsdom 缺少的浏览器 API）。 */
import { vi } from 'vitest'

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}

if (typeof window !== 'undefined' && !window.URL.createObjectURL) {
  Object.defineProperty(window.URL, 'createObjectURL', { value: vi.fn(() => 'blob:mock') })
  Object.defineProperty(window.URL, 'revokeObjectURL', { value: vi.fn() })
}
