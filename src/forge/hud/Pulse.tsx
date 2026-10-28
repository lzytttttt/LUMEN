/**
 * forge/hud/Pulse.tsx —— 七阶段脉冲（04 §4）：一个标量 prog，七根柱子只是读数。
 *
 * 实现纪律（04 §4.3）：只有一条曲线。这里不写任何 setTimeout / rAF——
 * 柱高由 `--fill`（clamp(prog - i, 0, 1)）一次性算出，过渡交给 CSS 的同一条缓动；
 * 阶段词只在慢态出现（CSS 延迟 1200ms 淡入），同一时刻最多 1 个文字元素。
 */
import type { PulseProps } from '../ui'

const STAGES = ['think', 'plan', 'write', 'draw', 'set', 'check', 'seal'] as const

export function Pulse({ prog, stage, bad, tier, label }: PulseProps) {
  return (
    <div className="forge-pulse" data-forge-pulse data-bad={bad ? '1' : '0'} data-stage={stage} data-tier={tier} aria-hidden="true">
      <span className="forge-pulse__bars">
        {STAGES.map((name, index) => {
          const fill = Math.max(0, Math.min(1, prog - index))
          return (
            <span
              key={name}
              className={`forge-pulse__bar${fill >= 1 ? ' is-done' : fill > 0 ? ' is-on' : ''}${
                bad && name === 'check' ? ' is-bad' : ''
              }`}
              data-stage={name}
              style={{ ['--fill' as string]: fill }}
            />
          )
        })}
      </span>
      {label ? (
        <span key={label} className="forge-pulse__label">
          {label}
        </span>
      ) : null}
    </div>
  )
}
