/**
 * forge/hud/FxToast.tsx —— 瞬时反馈（连击 / +XP / 成就 / 升级），不占布局、不打断输入。
 *
 * 文案 ≤4 字，4s 自退（03 §8-5；退场由 ForgeApp 的 4000ms 定时器执行，这里只做 3.7s 的视觉淡出）。
 * 整层 `pointer-events: none`，读屏走 `aria-live="off"`（数值不播报，04 §10.3）。
 */
import type { FxToastProps } from '../ui'

export function FxToast({ items }: FxToastProps) {
  if (items.length === 0) return null
  return (
    <div className="forge-fx" aria-live="off">
      {items.map((item) => (
        <span
          key={item.id}
          className={`forge-fx__item forge-fx__item--${item.kind}`}
          data-forge-fx={item.kind}
          data-tone={item.tone ?? (item.kind === 'error' ? 'danger' : 'accent')}
        >
          {item.text}
        </span>
      ))}
    </div>
  )
}
