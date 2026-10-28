/**
 * forge/stage/Premiere.tsx —— 开演席（02 §5.5、04 §3.3 T3 / §8.1）。
 *
 * 最后一幕落位后，完成栈从 T2 台面归位成 T3：
 *   ≤9 幕  → T3-a 弧线（x = t×602，y = -46 + (1-cos(1.15t))×58，rotateY = -18°×t）；
 *   10–20 幕 → T3-b 5×4 网格（128×72，压平 rotateX(12°)，z 按 i%3 抖动 ±16）。
 * 内容一律 poster（`mode="thumb"`，不播块入场，04 §3.3 共同约束）。
 *
 * 这一屏只有三处文字：主按钮「播放」、残影「回编辑器」/「再来一套」。不写进度、不写数字。
 * 自动进开演由 ForgeApp 控制（04 §8.3），这里绝不 setTimeout 抢跳。
 */
import { useMemo } from 'react'
import { useT } from '@/i18n'
import { SlideRenderer } from '@/render/SlideRenderer'
import type { PremiereProps } from '../ui'

const ARC_CARD = { w: 160, h: 90 }
const GRID_CARD = { w: 128, h: 72 }

export function Premiere({ deck, slides, tier, accent, onPlay, onBack, onAgain }: PremiereProps) {
  const t = useT()
  const landed = useMemo(
    () => slides.filter((slide) => Boolean(slide.slide)).slice().sort((a, b) => a.index - b.index),
    [slides],
  )
  const count = landed.length
  const grid = count > 9
  const card = grid ? GRID_CARD : ARC_CARD
  const scale = card.w / 1600

  /** 有幕带病落位（error 兜底后仍失败）时把「播放」标成 aria-disabled，但保留入口避免整场被卡死（03 §8.8）。 */
  const blocked = slides.some((slide) => slide.status === 'stuck' && slide.errors.length > 0)
  const playable = count > 0

  return (
    <section
      className="forge-premiere"
      data-forge-screen="premiere"
      data-forge-tier-view={tier}
      data-forge-mode={grid ? 'grid' : 'arc'}
      data-forge-count={count}
      data-forge-blocked={blocked ? '1' : '0'}
      style={{ ['--forge-accent' as string]: accent, ['--forge-accent-2' as string]: 'var(--ui-accent-2)' }}
    >
      <div
        className={grid ? 'forge-premiere__grid' : 'forge-premiere__arc'}
        data-forge-premiere-track
        data-forge-premiere-layout={grid ? 't3-b' : 't3-a'}
        aria-hidden="true"
      >
        {landed.map((slide, index) => {
          const t01 = count <= 1 ? 0 : (index / (count - 1)) * 2 - 1
          const x = grid ? 0 : t01 * 602
          const y = grid ? 0 : -46 + (1 - Math.cos(t01 * 1.15)) * 58
          const z = grid ? ((index % 3) - 1) * 16 : -Math.abs(t01) * 70
          const rotateY = grid ? 0 : -18 * t01
          const brightness = grid ? 1 : 1 - 0.42 * Math.pow(Math.abs(t01), 1.2)
          const opacity = grid ? 1 : 0.62 + 0.38 * brightness
          const style = grid
            ? {
                transform: `translate3d(0px, 0px, ${z.toFixed(1)}px)`,
                opacity: 1,
              }
            : {
                position: 'absolute' as const,
                left: '50%',
                top: '50%',
                width: ARC_CARD.w,
                height: ARC_CARD.h,
                marginLeft: -ARC_CARD.w / 2,
                marginTop: -ARC_CARD.h / 2,
                transform: `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, ${z.toFixed(1)}px) rotateY(${rotateY.toFixed(
                  2,
                )}deg)`,
                filter: `brightness(${brightness.toFixed(3)})`,
                opacity: Number(opacity.toFixed(3)),
              }
          return (
            <div
              key={slide.index}
              className="forge-premiere__card"
              data-forge-premiere-card
              data-slide-index={slide.index}
              data-card-t={t01.toFixed(3)}
              style={style}
            >
              {deck ? (
                <SlideRenderer
                  deck={deck}
                  slide={slide.slide!}
                  mode="thumb"
                  active={false}
                  style={{
                    width: 1600,
                    height: 900,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                  }}
                />
              ) : null}
            </div>
          )
        })}
      </div>

      {/* 压角：只留中央约 40% 亮区（04 §3.3 T3-a）。 */}
      <div
        className="forge-premiere__veil"
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(36% 29% at 50% 45%, transparent 0, rgba(0, 0, 0, 0.42) 62%, rgba(0, 0, 0, 0.86) 100%)',
        }}
      />

      {/* 播放按钮：dock 里有一枚主按钮，Premiere 里这一枚是同 key 的第二处入口。 */}
      <button
        type="button"
        className="forge-premiere__play"
        data-act="premiere"
        aria-disabled={playable ? undefined : 'true'}
        disabled={!playable}
        onClick={onPlay}
      >
        {t('forge.premiere.start')}
      </button>

      <div className="forge-premiere__ghost">
        <button type="button" className="forge-ghost" data-act="close" onClick={onBack}>
          {t('forge.premiere.back')}
        </button>
        <button type="button" className="forge-ghost" data-act="again" onClick={onAgain}>
          {t('forge.premiere.again')}
        </button>
      </div>
    </section>
  )
}
