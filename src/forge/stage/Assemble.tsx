/**
 * forge/stage/Assemble.tsx —— 生成 · 装台（02 §5.3、04 §2.4/§3.3）。
 *
 * 台面几何（04 §3.3 T2）：
 * - 中心幕 800×450：真实 `SlideRenderer`（1600×900 缩放 .5），块入场完全由真实
 *   `block.enter` / `enterDelayMs` 驱动——这里不生成假动画、不做二次插值；
 * - 左侧完成栈 160×90，最多 5 张（更早的收成「+N」纸角），越往下越暗；
 * - 右侧在铸幕是中心幕同尺寸的 30% 影子，用 `slides[].status` 的在飞数量表达管线并发 2；
 * - 落位只在 `slide:landed` 后发生（`active` 变化），所以"看到的"与成品同源（D2）。
 *
 * L3 的环境粒子交给 `fx/ambient.ts`（lazy import('three')），本文件不 import three。
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'
import { useT } from '@/i18n'
import { SlideRenderer } from '@/render/SlideRenderer'
import { isLanded } from '../state'
import { startAmbient } from '../fx/ambient'
import type { ForgeSlideState, SlideStatus } from '../types'
import type { AssembleProps } from '../ui'

/** 左侧完成栈同时最多 5 张（04 §3.3）；更早的折成「+N」。 */
const STACK_MAX = 5

/** 管线里有内容正在成形的状态（并发上限 2，`compose.ts` 的 runPool）。 */
const IN_FLIGHT: SlideStatus[] = ['drafting', 'art', 'typesetting', 'gating']

function byIndex(a: ForgeSlideState, b: ForgeSlideState): number {
  return a.index - b.index
}

/** 已落位（含带病落位）的幕。 */
function landedOf(slides: ForgeSlideState[]): ForgeSlideState[] {
  return slides.filter((slide) => isLanded(slide.status) && Boolean(slide.slide)).sort(byIndex)
}

export function Assemble(props: AssembleProps) {
  const t = useT()
  const { tier, slides, deck, active, done, stopped } = props
  const ambientRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  const landed = useMemo(() => landedOf(slides), [slides])
  const activeEntry = active !== null ? slides[active] : undefined
  const activeSlide = activeEntry?.slide
  const behind = useMemo(() => landed.filter((slide) => slide.index !== active), [landed, active])
  /** 栈顶是最近落位的一张（04 §3.3：「最上面一张最亮，往下渐暗」）。 */
  const stack = useMemo(() => behind.slice(-STACK_MAX).reverse(), [behind])
  const early = Math.max(0, behind.length - stack.length)

  const inFlight = useMemo(() => slides.filter((slide) => IN_FLIGHT.includes(slide.status)), [slides])
  const shadowEntry = inFlight.find((slide) => slide.slide) ?? inFlight[0]
  const shadowSlide = shadowEntry?.slide
  const shadowVisible = !stopped && inFlight.length > 0
  const typing = inFlight[0] ?? slides.find((slide) => slide.status === 'queued')
  /**
   * L2/L3 用真实 stage 渲染（3D 幕才建 WebGL）；L1/L0 用 thumb 渲染，
   * 保证 F-13「装台区 canvas 0」与 D-03「three 请求 0」成立（04 §10.1）。
   */
  const renderMode = tier === 'L3' || tier === 'L2' ? 'stage' : 'thumb'
  /* 只有"中心这一幕自己"有 error 时才停在门前；别人的 error 由 Gate 的「!」承担，不劫持当前幕。 */
  const holding = (activeEntry?.errors.length ?? 0) > 0 && !stopped

  /* 环境粒子：只在 L3 且用户没关时创建，卸载即 dispose（含 canvas 移除）。 */
  useEffect(() => {
    const handle = startAmbient({ tier, host: ambientRef.current })
    return () => handle.dispose()
  }, [tier])

  /**
   * `forge.css` 用 `animation` 简写（含 `animation-delay: 0s`）覆盖 `slide.css` 的 520/560ms 入场，
   * 简写里的 `!important` 会压掉 `BlockFrame` 写在行内的 `animationDelay`。
   * 真实错峰（`enterDelayMs` 0–3000ms）是 D2 的硬字段，这里在绘制前把它补回 `!important`。
   */
  useLayoutEffect(() => {
    const root = stageRef.current
    if (!root) return
    const l1 = tier === 'L1'
    const blocks = root.querySelectorAll<HTMLElement>('.lumen-block[data-enter]')
    blocks.forEach((block) => {
      // L1：rise / scale 一律降为 fade 520ms（04 §10.2「降的是运动幅度，不降'发生了什么'」）。
      // thumb 渲染会 `animation: none !important`，所以 L1 必须把 fade 也补回。
      if (l1) {
        block.style.setProperty('animation-name', 'lumen-enter-fade', 'important')
        block.style.setProperty('animation-duration', '520ms', 'important')
        block.style.setProperty('animation-timing-function', 'var(--d-ease, ease)', 'important')
        block.style.setProperty('animation-fill-mode', 'both', 'important')
      }
      const delay = block.style.animationDelay
      if (delay === '') return
      block.style.setProperty('animation-delay', delay, 'important')
    })
  })

  const stackStyle: CSSProperties | undefined = stopped
    ? { transform: 'translateY(calc(-50% + 40px)) rotateY(14deg)', opacity: 0.55 }
    : undefined

  /* 过检 error：幕停在门中间（translateZ(200) scale(.96)），门与幕的读法才成立（04 §5.2）。 */
  const stageStyle: CSSProperties = { zIndex: 1 }
  if (holding) {
    // 位移只在有 3D 透视的档位做；L1/L0 只保留亮度/饱和度的静态降级（04 §10.1）。
    if (tier === 'L2' || tier === 'L3') {
      stageStyle.transform = 'rotateX(0deg) rotateY(0deg) translateZ(200px) scale(0.96)'
    }
    stageStyle.filter = 'brightness(0.88) saturate(0.72)'
  }

  return (
    <section
      className="forge-assemble"
      data-forge-screen="assemble"
      data-forge-tier-view={tier}
      data-stopped={stopped ? '1' : '0'}
      data-forge-hold={holding ? '1' : '0'}
      data-forge-inflight={inFlight.length}
      data-forge-landed={landed.length}
    >
      {/* L3 环境粒子宿主：由 fx/ambient 恰好放 1 个 canvas，其余档位为空。 */}
      <div
        ref={ambientRef}
        className="forge-ambient"
        data-forge-ambient-host
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}
      />

      <div className="forge-assemble__stack" style={stackStyle} aria-hidden="true">
        {early > 0 ? (
          <span className="forge-assemble__more" data-forge-text>
            +{early}
          </span>
        ) : null}
        {stack.map((slide, depth) => (
          <div
            key={slide.index}
            className="forge-assemble__thumb"
            data-forge-slot
            data-slot-filled={slide.slide ? 'true' : 'false'}
            data-slide-index={slide.index}
            data-stack-depth={depth}
            style={{
              opacity: Math.max(0.3, Number((1 - depth * 0.13).toFixed(2))),
              filter: `brightness(${Number((1 - depth * 0.12).toFixed(2))})`,
            }}
          >
            {deck && slide.slide ? (
              <SlideRenderer
                deck={deck}
                slide={slide.slide}
                mode="thumb"
                active={false}
                className="forge-assemble__thumb-slide"
              />
            ) : null}
          </div>
        ))}
      </div>

      <div
        ref={stageRef}
        className="forge-stage"
        data-forge-hold={holding ? '1' : '0'}
        style={stageStyle}
      >
        <div className="forge-stage__floor" aria-hidden="true" />
        {/* 落位扫光：每次 done 自增重播 1 次（520ms），样式归 Lane B。 */}
        <div className="forge-stage__beam" key={`beam-${done}`} data-forge-beam={done} aria-hidden="true" />

        {activeSlide && deck ? (
          <div
            className="forge-stage__center"
            key={activeSlide.id}
            data-forge-slot
            data-slot-filled="true"
            data-slide-index={active ?? undefined}
          >
            <SlideRenderer
              deck={deck}
              slide={activeSlide}
              mode={renderMode}
              active={renderMode === 'stage'}
              className="forge-stage__slide"
            />
          </div>
        ) : (
          <div className="forge-stage__ghost" data-forge-slot data-slot-filled="false" aria-hidden="true">
            <div className="forge-stage__ghost-line" />
            {typing ? (
              <span className="forge-stage__ghost-title" data-forge-text>
                {typing.headline}
              </span>
            ) : null}
          </div>
        )}

        {/* 落位闷响环：以幕心为心的 1px 椭圆，每次落位重播（04 §2.4）。 */}
        <span className="forge-stage__ping" key={`ping-${done}`} data-forge-ping={done} aria-hidden="true" />

        {/* 右侧在铸幕：同尺寸、30% 不透明，表达"两幕并行落下"（04 §3.3）。 */}
        <div
          className="forge-stage__echo"
          data-forge-slot
          data-slot-filled={shadowSlide ? 'true' : 'false'}
          data-slide-index={shadowEntry?.index ?? undefined}
          data-forge-inflight={inFlight.length}
          aria-hidden="true"
          style={{ opacity: shadowVisible ? 0.3 : 0 }}
        >
          {shadowSlide && deck ? (
            <SlideRenderer
              deck={deck}
              slide={shadowSlide}
              mode="thumb"
              active={false}
              className="forge-stage__echo-slide"
              style={{ width: 1600, height: 900, transform: 'scale(0.5)', transformOrigin: 'top left' }}
            />
          ) : (
            <div className="forge-stage__echo-line" />
          )}
        </div>
      </div>

      <footer className="forge-assemble__foot">
        {stopped ? (
          <button type="button" className="forge-ghost" data-act="resume" onClick={props.onResume}>
            {t('forge.seed.resume')}
          </button>
        ) : null}
      </footer>
    </section>
  )
}
