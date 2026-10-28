/**
 * SnapshotStage.tsx —— PNG 快照用的离屏舞台（1600×900，`mode='export'`）。
 *
 * 单独一个组件而不是内联在 `png.ts` 里，是因为 `src/export/png.ts` 必须保持 `.ts`
 * （panels 的 exporterBridge 用 `import.meta.glob('../../export/*.ts')` 探测内核，
 * 改成 .tsx 会让 PNG 按钮变成"内核未就绪"）。
 *
 * 内层 `<style>` 必须放在被克隆的子树里：`html-to-image` 只序列化目标节点，
 * 外部的样式不会跟着进 SVG foreignObject。
 */
import type { JSX } from 'react'
import { STAGE_H, STAGE_W, type Deck, type Slide } from '@/schema/deck'
import { SlideRenderer } from '@/render/SlideRenderer'

export interface SnapshotStageProps {
  deck: Deck
  slide: Slide
}

/**
 * 图片容器自带的 surface 底色会在快照里形成一块"板"（3D 抓帧是带透明通道的 PNG），
 * 与编辑器里透明 canvas 的观感不一致——快照内统一去掉。
 */
const SNAPSHOT_CSS = `
[data-lumen-snapshot-frame='1'] .lumen-image { background: transparent !important; }
[data-lumen-snapshot-frame='1'] .lumen-svg__badge { display: none !important; }
`

export function SnapshotStage({ deck, slide }: SnapshotStageProps): JSX.Element {
  return (
    <div style={{ width: STAGE_W, height: STAGE_H }} data-lumen-snapshot-frame="1">
      <style>{SNAPSHOT_CSS}</style>
      <SlideRenderer deck={deck} slide={slide} mode="export" active={false} />
    </div>
  )
}
