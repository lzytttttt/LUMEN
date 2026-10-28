/**
 * library/index.ts —— 精选 SVG 插图库（12 件，令牌化，随主题换色）。
 *
 * 对外契约（panels 的插入菜单已在用，勿改）：
 *   `SvgLibraryItem` / `SVG_LIBRARY` / `svgLibraryItem(id)`
 */
import { LIBRARY_CATALOG } from './catalog'
import type { SvgCategory, SvgLibraryItem } from './types'

export type { SvgCategory, SvgLibraryItem } from './types'
export { SVG_CATEGORIES } from './types'

/** 12 件：geometric 4 / line 4 / iso 2 / chart 2。 */
export const SVG_LIBRARY: SvgLibraryItem[] = LIBRARY_CATALOG

export function svgLibraryItem(id: string): SvgLibraryItem | undefined {
  return SVG_LIBRARY.find((item) => item.id === id)
}

/** 按分类分组（库面板与插入菜单共用同一顺序）。 */
export function svgLibraryByCategory(category: SvgCategory): SvgLibraryItem[] {
  return SVG_LIBRARY.filter((item) => item.category === category)
}
