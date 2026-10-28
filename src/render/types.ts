/** render/types.ts —— 渲染层共用类型（避免 SlideRenderer 与 blocks 之间循环引用）。 */
export type RenderMode = 'stage' | 'play' | 'thumb' | 'print' | 'export'
