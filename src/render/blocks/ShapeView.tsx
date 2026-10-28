/** blocks/ShapeView.tsx —— 形状块：矩形/椭圆/线/三角/分隔线。 */
import type { ShapeBlock } from '@/schema/deck'

export function ShapeView({ block }: { block: ShapeBlock }) {
  const fill = `var(--d-${block.fill})`
  const stroke = block.stroke ? `var(--d-${block.stroke})` : 'transparent'

  if (block.kind === 'ellipse') {
    return <div className="lumen-shape" style={{ background: fill, borderRadius: '50%' }} />
  }
  if (block.kind === 'line' || block.kind === 'rule') {
    return (
      <div
        className="lumen-shape"
        style={{
          background: fill,
          height: Math.max(1, block.strokeWidth || block.h),
          borderRadius: 99,
          opacity: block.opacity,
        }}
      />
    )
  }
  if (block.kind === 'triangle') {
    return (
      <svg className="lumen-shape__triangle" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="50,0 100,100 0,100" fill={fill} stroke={stroke} strokeWidth={block.strokeWidth} />
      </svg>
    )
  }
  return (
    <div
      className="lumen-shape"
      style={{
        background: fill,
        border: block.strokeWidth > 0 ? `${block.strokeWidth}px solid ${stroke}` : undefined,
        borderRadius: block.radius ?? 'var(--d-radius)',
      }}
    />
  )
}
