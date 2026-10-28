/**
 * forge/stage/Gate.tsx —— 过检门（02 §5.4、04 §5）。
 *
 * 「门」是全屏装置：两道 1px 竖线，间距 160px（translateX ±80），不属于任何一张幕。
 * 三档反馈：
 *   error  → 门转红 + 8 束金色短线（span，不用 canvas/SVG）+ 幕右上方形「!」+ 唯一「重试」；
 *   warn   → 幕右上 6px 四角星（不阻断、不弹 toast）；
 *   info   → 不上屏（`ForgeSlideState` 里根本没有 info 字段，这里也不建 DOM）。
 *
 * DOM 钩子：`[data-forge-issue][data-severity="error|warn"]`（02 §4.4）。
 */
import { useMemo } from 'react'
import { useT, type MessageKey } from '@/i18n'
import type { ForgeSlideState, SlideStatus } from '../types'
import type { GateProps } from '../ui'

const IN_FLIGHT: SlideStatus[] = ['drafting', 'art', 'typesetting', 'gating']

/** 04 §5.4：8 束；L1 减到 4 束、无渐变；L0 只有「!」角标。 */
const RAYS_L3 = 8
const RAYS_L1 = 4

interface Ray {
  i: number
  x: number
  y: number
  len: number
  angle: number
  opacity: number
}

/** 椭圆轨道：x = cosθ×470、y = sinθ×300，θ = 45°×i + 13.8°（错开四角）。 */
function raysOf(count: number): Ray[] {
  const list: Ray[] = []
  for (let i = 0; i < count; i += 1) {
    const angle = (Math.PI * 2 * i) / count + (13.8 * Math.PI) / 180
    list.push({
      i,
      x: Math.cos(angle) * 470,
      y: Math.sin(angle) * 300,
      len: 12 + (i % 3) * 6,
      angle: (angle * 180) / Math.PI + 90,
      opacity: 1 - (i % 3) * 0.16,
    })
  }
  return list
}

function entryWith(slides: ForgeSlideState[], pick: (slide: ForgeSlideState) => boolean): ForgeSlideState | undefined {
  return slides.find(pick)
}

export function Gate({ slides, active, tier, onRecast }: GateProps) {
  const t = useT()
  const activeEntry = active !== null ? slides[active] : undefined

  /** 有 error 的幕（先出现的那一幕；一次只显示一枚「!」与一个「重试」）。 */
  const errorEntry = useMemo(
    () =>
      entryWith(slides, (slide) => slide.errors.length > 0) ??
      // 带病落位（`stuck`）即使 errors 已被重铸清空，也继续保留「!」与「重试」入口。
      entryWith(slides, (slide) => slide.status === 'stuck'),
    [slides],
  )
  /** warn 优先落在当前舞台上的一幕，否则取第一个有 warn 的幕。 */
  const warnEntry = useMemo(() => {
    if (errorEntry && errorEntry.warns.length > 0) return errorEntry
    if (activeEntry && activeEntry.warns.length > 0) return activeEntry
    return entryWith(slides, (slide) => slide.warns.length > 0)
  }, [activeEntry, errorEntry, slides])

  const busy = useMemo(() => slides.some((slide) => IN_FLIGHT.includes(slide.status)), [slides])
  const bad = Boolean(errorEntry)
  /** 门在有幕落位后常驻（它是落位路径上的装置，不是弹层）。 */
  const open = active !== null
  const retryIndex = errorEntry?.index ?? null

  const rays = useMemo(() => {
    if (!bad || tier === 'L0') return []
    return raysOf(tier === 'L1' ? RAYS_L1 : RAYS_L3)
  }, [bad, tier])

  const lineStyle = (side: 'left' | 'right') => ({
    opacity: open ? (bad ? 1 : 0.5) : 0,
    background: bad ? 'var(--ui-danger)' : 'var(--ui-accent)',
    boxShadow: bad ? '0 0 20px color-mix(in srgb, var(--ui-danger) 55%, transparent)' : '0 0 16px rgba(200,161,90,.4)',
    transform: side === 'left' ? 'translateX(-80px)' : 'translateX(80px)',
  })

  return (
    <div
      className="forge-gate"
      data-forge-gate
      data-bad={bad ? '1' : '0'}
      data-severity-max={bad ? 'error' : warnEntry ? 'warn' : 'none'}
      data-open={open ? '1' : '0'}
      data-busy={busy ? '1' : '0'}
      data-tier={tier}
      style={{
        // 门是全屏装置（04 §5.2）：从顶栏下方贯穿到底部 Pulse，不属于任何一张幕。
        position: 'fixed',
        left: 0,
        right: 0,
        top: 56,
        bottom: 72,
        pointerEvents: 'none',
        zIndex: 3,
      }}
    >
      <span className="forge-gate__line forge-gate__line--left" data-gate-line="left" aria-hidden="true" style={lineStyle('left')} />
      <span
        className="forge-gate__line forge-gate__line--right"
        data-gate-line="right"
        aria-hidden="true"
        style={lineStyle('right')}
      />

      {/* error：幕右上方形「!」（方形不会被读成状态点，04 §5.3）。 */}
      {errorEntry ? (
        <span
          className="forge-gate__bang"
          data-forge-issue
          data-severity="error"
          data-issue-index={errorEntry.index}
          data-issue-codes={errorEntry.errors.join(' ')}
          title={errorEntry.errors.map((code) => t(`forge.gate.code.${code}` as MessageKey)).join(' · ')}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 'calc(50% + 372px)',
            top: 'calc(50% - 217px)',
            width: 12,
            height: 12,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 0,
            background: 'var(--ui-danger)',
            color: 'var(--ui-bg)',
            fontFamily: 'var(--ui-font-mono)',
            fontSize: 9,
            lineHeight: 1,
            fontWeight: 700,
          }}
        >
          !
        </span>
      ) : null}

      {/* warn：6px 四角星，不写任何字。 */}
      {warnEntry ? (
        <span
          className="forge-gate__star"
          data-forge-issue
          data-severity="warn"
          data-issue-index={warnEntry.index}
          data-issue-codes={warnEntry.warns.join(' ')}
          title={warnEntry.warns.map((code) => t(`forge.gate.code.${code}` as MessageKey)).join(' · ')}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 'calc(50% + 375px)',
            top: 'calc(50% - 216px)',
            width: 6,
            height: 6,
            background: 'var(--ui-warn, #e0a63a)',
            clipPath: 'polygon(50% 0, 60% 40%, 100% 50%, 60% 60%, 50% 100%, 40% 60%, 0 50%, 40% 40%)',
            opacity: 0.9,
          }}
        />
      ) : null}

      {/* error：8 束金色短线，元素底端锚在椭圆轨道点，沿法线朝外。 */}
      {rays.length > 0 ? (
        <div
          key={`rays-${errorEntry?.index ?? 'none'}`}
          className="forge-gate__burst"
          data-forge-burst={errorEntry?.index ?? undefined}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 0,
            height: 0,
            pointerEvents: 'none',
            zIndex: 4,
          }}
        >
          {rays.map((ray) => (
            <span
              key={ray.i}
              className="forge-gate__ray"
              data-spark-i={ray.i}
              style={{
                position: 'absolute',
                left: ray.x - 0.5,
                top: ray.y - ray.len,
                width: 1,
                height: ray.len,
                borderRadius: 1,
                transformOrigin: '50% 100%',
                transform: `rotate(${ray.angle.toFixed(2)}deg)`,
                background:
                  tier === 'L1'
                    ? 'var(--ui-accent)'
                    : 'linear-gradient(to top, rgba(200,161,90,.9), rgba(200,161,90,0))',
                opacity: ray.opacity,
                pointerEvents: 'none',
              }}
            />
          ))}
        </div>
      ) : null}

      {/* error 的交互只有一个按钮：幕下方「重试」（R 键由 ForgeApp 接）。 */}
      {retryIndex !== null ? (
        <button
          type="button"
          className="forge-gate__retry"
          data-act="recast"
          data-retry-index={retryIndex}
          onClick={() => onRecast(retryIndex)}
          style={{ pointerEvents: 'auto', top: 'calc(50% + 238px)', bottom: 'auto' }}
        >
          {t('forge.gate.recast')}
        </button>
      ) : null}

      {/* 读屏通道（视觉 1×1 隐藏）：error ≤1 次/秒，连续 error 只播第一条（04 §10.3）。 */}
      {errorEntry ? (
        <span className="forge__live" role="alert">
          {t('forge.live.error', { n: errorEntry.index + 1 })}
        </span>
      ) : null}
    </div>
  )
}
