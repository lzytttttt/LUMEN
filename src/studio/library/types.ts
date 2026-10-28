/**
 * library/types.ts —— 精选库的数据契约。
 *
 * 归属：svg3d-studio。panels 的插入菜单（InsertMenu / insertActions）直接消费这些类型，
 * 所以字段名一旦确定就不要改：`{ id, name{zh,en}, category, viewBox, source }`。
 */

/** 四类选题：几何 / 线描 / 等距 / 图表。 */
export type SvgCategory = 'geometric' | 'line' | 'iso' | 'chart'

export interface SvgLibraryItem {
  id: string
  name: { zh: string; en: string }
  category: SvgCategory
  /** 与 source 里的 viewBox 必须一致（单测会校验）。 */
  viewBox: [number, number, number, number]
  /** 令牌化源码：描边/填色只用 var(--d-*)，保证任意主题下成立。 */
  source: string
}

/** 固定顺序：与检查器/库面板的分组顺序一致。 */
export const SVG_CATEGORIES: SvgCategory[] = ['geometric', 'line', 'iso', 'chart']
