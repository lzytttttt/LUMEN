/**
 * forge/hud/Pulse.tsx —— 七阶段脉冲（04 §4）：一个标量 prog，七根柱子只是读数。
 *
 * 实现纪律（04 §4.3）：只有一条曲线。这里不写任何 setTimeout / rAF——
 * 柱高由 `--fill`（clamp(prog - i, 0, 1)）一次性算出，过渡交给 CSS 的同一条缓动；
 * 阶段词只在慢态出现（CSS 延迟 1200ms 淡入），同一时刻最多 1 个文字元素。
 *
 * v0.2.5 FX-3（`plan/v0.2.5/02` §6.1）：柱阵之外再给一条环形进度——
 * 同一个 `prog`（0–7 连续量）换算成 SVG 的 `stroke-dashoffset`，props 契约一字未改
 * （仍是 `prog/stage/bad/tier/label`）。四档回落全在 CSS：
 *   L3/L2 → 环；L1 → 线性条；L0 / `?still=1` → 静态条（数值仍是真 `prog`，只是不过渡）。
 * `bad` 时环与线性条都转 `--ui-danger`（过检的红色缺口，04 §4.3）。
 */
import type { PulseProps } from '../ui'

const STAGES = ['think', 'plan', 'write', 'draw', 'set', 'check', 'seal'] as const

/** 环的半径（viewBox 24×24，圆心 12,12）；周长与 r 一起导出，单测不用重算。 */
export const PULSE_RING_R = 8
export const PULSE_RING_CIRC = 2 * Math.PI * PULSE_RING_R
/** `prog` 的上界（04 §4.3：0–7 的连续量，7 个阶段 + 收尾的那一格）。 */
export const PULSE_PROG_MAX = 7

/** `prog`(0–7) → 环的填充比例(0–1)；越界自动夹紧，NaN 视为 0。 */
export function pulseRingProgress(prog: number): number {
  const value = Number.isFinite(prog) ? prog : 0
  return Math.max(0, Math.min(1, value / PULSE_PROG_MAX))
}

/** 填充比例 → `stroke-dashoffset`：0 时整圈空（offset = 周长），1 时整圈满（offset = 0）。 */
export function pulseRingOffset(prog: number, circumference: number = PULSE_RING_CIRC): number {
  return Number((circumference * (1 - pulseRingProgress(prog))).toFixed(3))
}

export function Pulse({ prog, stage, bad, tier, label }: PulseProps) {
  const ringProgress = Number(pulseRingProgress(prog).toFixed(4))
  const ringOffset = pulseRingOffset(prog)

  return (
    <div
      className="forge-pulse"
      data-forge-pulse
      data-bad={bad ? '1' : '0'}
      data-stage={stage}
      data-tier={tier}
      data-forge-prog={Number.isFinite(prog) ? Number(prog.toFixed(3)) : 0}
      aria-hidden="true"
    >
      {/* FX-3 · L3/L2：环形进度。数值只来自 prog，不另起曲线。 */}
      <span className="forge-pulse__ring" data-forge-pulse-ring aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" focusable="false">
          <circle className="forge-pulse__ring-track" cx="12" cy="12" r={PULSE_RING_R} />
          <circle
            className="forge-pulse__ring-arc"
            cx="12"
            cy="12"
            r={PULSE_RING_R}
            strokeDasharray={Number(PULSE_RING_CIRC.toFixed(3))}
            strokeDashoffset={ringOffset}
          />
        </svg>
      </span>

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

      {/* FX-3 · L1/L0：线性条 / 静态条（同一个 prog，只换形态，不换数据源）。 */}
      <span className="forge-pulse__linear" data-forge-pulse-linear aria-hidden="true">
        <i style={{ ['--p' as string]: ringProgress }} />
      </span>

      {label ? (
        <span key={label} className="forge-pulse__label">
          {label}
        </span>
      ) : null}
    </div>
  )
}
