/**
 * art.ts —— 离线确定性 SVG / three.js 生成器。
 *
 * 职责：
 * - 给 MockProvider 提供"看起来像设计过"的矢量插图与 3D 场景描述符；
 * - 给真端点生成失败时提供兜底素材；
 * - 所有颜色只用主题令牌 `var(--d-*)`，保证 6 套主题下都成立；
 * - 同一段 prompt 永远得到同一份结果（seedFrom + mulberry32），首屏体验可复现。
 */
import type { ThreeDescriptor, ThreeObject, ThreePreset, ThreeShape } from '@/schema/deck'
import { seedFrom, seededRandom } from '@/schema/ids'

/* -------------------------------- 矢量插图 -------------------------------- */

export type ArtStyle = 'orbit' | 'grid' | 'wave' | 'stack' | 'arc'

export const ART_STYLES: ArtStyle[] = ['orbit', 'grid', 'wave', 'stack', 'arc']

export interface SvgArt {
  source: string
  viewBox: [number, number, number, number]
  style: ArtStyle
}

/** 画布固定 820×560（4:2.73），配方按比例放盒子。 */
const ART_W = 820
const ART_H = 560

function n(value: number): number {
  return Math.round(value * 10) / 10
}

function pick<T>(items: readonly T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length) % items.length]
}

/** 按 prompt 选风格：关键词优先，其余用种子决定。 */
export function pickArtStyle(prompt: string, forced?: string): ArtStyle {
  const forcedStyle = forced?.toLowerCase() as ArtStyle | undefined
  if (forcedStyle && ART_STYLES.includes(forcedStyle)) return forcedStyle
  const text = prompt.toLowerCase()
  if (/轨道|环|orbit|circle|轮|周期/.test(text)) return 'orbit'
  if (/网格|栅格|grid|矩阵|matrix|结构/.test(text)) return 'grid'
  if (/波|wave|流动|flow|曲线|curve/.test(text)) return 'wave'
  if (/叠|层|stack|堆|模块|block/.test(text)) return 'stack'
  if (/弧|arc|增长|growth|趋势/.test(text)) return 'arc'
  const rng = seededRandom(seedFrom(prompt))
  return pick(ART_STYLES, rng)
}

function defsBlock(seed: string): string {
  return `<defs>
    <linearGradient id="la-${seed}-a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--d-accent)" stop-opacity="0.18"/>
      <stop offset="1" stop-color="var(--d-accent2)" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="la-${seed}-b" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="var(--d-accent2)" stop-opacity="0.22"/>
      <stop offset="1" stop-color="var(--d-accent2)" stop-opacity="0"/>
    </radialGradient>
  </defs>`
}

function orbitArt(rng: () => number, seed: string): string {
  const cx = 410
  const cy = 280
  const rings = [250, 190, 130]
  const dots: string[] = []
  for (let i = 0; i < 5; i += 1) {
    const angle = rng() * Math.PI * 2
    const r = 130 + rng() * 140
    const radius = 5 + rng() * 8
    dots.push(
      `<circle cx="${n(cx + Math.cos(angle) * r)}" cy="${n(cy + Math.sin(angle) * r * 0.72)}" r="${n(radius)}" fill="var(--d-${i % 2 === 0 ? 'accent' : 'accent2'})" opacity="${n(0.55 + rng() * 0.35)}"/>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART_W} ${ART_H}" fill="none">
  ${defsBlock(seed)}
  <circle cx="${cx}" cy="${cy}" r="270" fill="url(#la-${seed}-b)"/>
  ${rings
    .map(
      (r, i) =>
        `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${n(r * 0.72)}" stroke="var(--d-${i === 1 ? 'accent' : 'line'})" stroke-width="${i === 1 ? 2 : 1.4}" opacity="${i === 1 ? 0.9 : 0.7}"${i === 2 ? ' stroke-dasharray="4 10"' : ''}/>`,
    )
    .join('\n  ')}
  <path d="M${cx - 250} ${cy}a250 180 0 0 1 500 0" stroke="var(--d-accent)" stroke-width="2.6"/>
  <circle cx="${cx}" cy="${cy}" r="44" fill="url(#la-${seed}-a)" stroke="var(--d-accent)" stroke-width="1.8"/>
  <circle cx="${cx}" cy="${cy}" r="12" fill="var(--d-accent)"/>
  ${dots.join('\n  ')}
  <path d="M${n(cx - 210)} ${cy + 210}h180" stroke="var(--d-muted)" stroke-width="2" stroke-linecap="round" opacity="0.8"/>
</svg>`
}

function gridArt(rng: () => number, seed: string): string {
  const cols = 7
  const rows = 5
  const cellW = 92
  const cellH = 82
  const originX = 130
  const originY = 90
  const highlight = Math.floor(rng() * cols)
  const cells: string[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = originX + col * cellW
      const y = originY + row * cellH
      const active = col === highlight && row <= 2
      const dot = rng() > 0.62
      cells.push(
        dot
          ? `<circle cx="${x + 24}" cy="${y + 24}" r="${n(4 + rng() * 6)}" fill="var(--d-${active ? 'accent' : row === 4 ? 'muted' : 'line'})" opacity="${n(active ? 0.95 : 0.75)}"/>`
          : `<rect x="${x}" y="${y}" width="48" height="48" rx="${n(2 + rng() * 8)}" stroke="var(--d-${active ? 'accent2' : 'line'})" stroke-width="1.4"${rng() > 0.7 ? ' stroke-dasharray="3 7"' : ''}/>`,
      )
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART_W} ${ART_H}" fill="none">
  ${defsBlock(seed)}
  <rect x="${originX - 18}" y="${originY - 18}" width="${cols * cellW + 12}" height="${rows * cellH + 12}" fill="url(#la-${seed}-a)" rx="10"/>
  ${cells.join('\n  ')}
  <path d="M${originX + highlight * cellW + 24} ${originY - 34}v${rows * cellH + 24}" stroke="var(--d-accent)" stroke-width="2" stroke-linecap="round"/>
  <path d="M${originX - 34} ${originY + 24}h${cols * cellW + 24}" stroke="var(--d-line)" stroke-width="1.6" stroke-dasharray="6 8"/>
</svg>`
}

function waveArt(rng: () => number, seed: string): string {
  const waves: string[] = []
  const amp = 40 + rng() * 50
  for (let i = 0; i < 3; i += 1) {
    const y = 190 + i * 84
    const a = amp * (1 - i * 0.22)
    const phase = rng() * 40
    const token = i === 0 ? 'accent' : i === 1 ? 'accent2' : 'line'
    waves.push(
      `<path d="M70 ${n(y)}C${n(190)} ${n(y - a)} ${n(300 + phase)} ${n(y + a)} ${n(430)} ${n(y)}S${n(680)} ${n(y - a)} 760 ${n(y + 10)}" stroke="var(--d-${token})" stroke-width="${i === 0 ? 2.8 : 1.6}" stroke-linecap="round" opacity="${n(1 - i * 0.22)}"/>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART_W} ${ART_H}" fill="none">
  ${defsBlock(seed)}
  <rect x="60" y="70" width="700" height="420" fill="url(#la-${seed}-a)" rx="12"/>
  ${waves.join('\n  ')}
  <path d="M70 470h680" stroke="var(--d-line)" stroke-width="1.4"/>
  ${[0, 1, 2, 3, 4]
    .map((i) => `<path d="M${70 + i * 170} 470v12" stroke="var(--d-muted)" stroke-width="1.4"/>`)
    .join('\n  ')}
  <circle cx="${n(430 + rng() * 40)}" cy="190" r="9" fill="var(--d-accent)"/>
  <circle cx="${n(600 + rng() * 40)}" cy="358" r="6" fill="var(--d-accent2)"/>
</svg>`
}

function stackArt(rng: () => number, seed: string): string {
  const plates: string[] = []
  const count = 4
  for (let i = 0; i < count; i += 1) {
    const y = 400 - i * 76
    const x = 220 + i * 22
    const w = 380 - i * 26
    const token = i === count - 1 ? 'accent' : i === 0 ? 'muted' : 'line'
    plates.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${n(44 + rng() * 10)}" rx="10" stroke="var(--d-${token})" stroke-width="${i === count - 1 ? 2.2 : 1.5}" fill="${i === count - 1 ? `url(#la-${seed}-a)` : 'none'}" opacity="${n(0.7 + i * 0.08)}"/>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART_W} ${ART_H}" fill="none">
  ${defsBlock(seed)}
  ${plates.join('\n  ')}
  <path d="M200 470h420" stroke="var(--d-line)" stroke-width="1.6" stroke-dasharray="5 9"/>
  <path d="M610 300v130" stroke="var(--d-accent2)" stroke-width="2" stroke-linecap="round"/>
  <path d="M602 310l8-12 8 12" stroke="var(--d-accent2)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="640" cy="180" r="${n(26 + rng() * 18)}" stroke="var(--d-accent)" stroke-width="2"/>
</svg>`
}

function arcArt(rng: () => number, seed: string): string {
  const cx = 410
  const cy = 330
  const ticks: string[] = []
  for (let i = 0; i <= 12; i += 1) {
    const angle = Math.PI + (i / 12) * Math.PI
    const inner = 214
    const outer = 214 + (i % 3 === 0 ? 22 : 11)
    ticks.push(
      `<path d="M${n(cx + Math.cos(angle) * inner)} ${n(cy + Math.sin(angle) * inner)}L${n(cx + Math.cos(angle) * outer)} ${n(cy + Math.sin(angle) * outer)}" stroke="var(--d-${i % 3 === 0 ? 'accent' : 'line'})" stroke-width="1.6"/>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART_W} ${ART_H}" fill="none">
  ${defsBlock(seed)}
  <circle cx="${cx}" cy="${cy}" r="250" stroke="var(--d-line)" stroke-width="1.2" opacity="0.7"/>
  <path d="M${cx - 214} ${cy}a214 214 0 0 1 428 0" stroke="var(--d-accent)" stroke-width="3"/>
  <path d="M${cx - 156} ${cy}a156 156 0 0 1 312 0" stroke="var(--d-accent2)" stroke-width="2" stroke-dasharray="6 10"/>
  ${ticks.join('\n  ')}
  <path d="M${cx} ${cy}v-214" stroke="var(--d-muted)" stroke-width="1.4" stroke-dasharray="4 8"/>
  <circle cx="${cx}" cy="${cy}" r="${n(10 + rng() * 8)}" fill="var(--d-accent)"/>
  <rect x="${n(300 + rng() * 60)}" y="${cy + 24}" width="${n(120 + rng() * 80)}" height="10" rx="5" fill="var(--d-accent2)" opacity="0.5"/>
</svg>`
}

/** 确定性矢量插图：同 prompt → 同结果。 */
export function mockSvgArt(prompt: string, opts?: { style?: string }): SvgArt {
  const seedNum = seedFrom(prompt)
  const seed = seedNum.toString(36).slice(0, 6)
  const rng = seededRandom(seedNum)
  const style = pickArtStyle(prompt, opts?.style)
  const body =
    style === 'grid'
      ? gridArt(rng, seed)
      : style === 'wave'
        ? waveArt(rng, seed)
        : style === 'stack'
          ? stackArt(rng, seed)
          : style === 'arc'
            ? arcArt(rng, seed)
            : orbitArt(rng, seed)
  return { source: body, viewBox: [0, 0, ART_W, ART_H], style }
}

/* -------------------------------- 3D 场景 -------------------------------- */

const PRESETS: ThreePreset[] = ['orbit', 'showcase', 'wave-field', 'particle-cloud', 'torus', 'stack', 'globe']
const SHAPES: ThreeShape[] = ['box', 'sphere', 'torus', 'torusKnot', 'cone', 'cylinder', 'octa', 'plane', 'icosa']

function ringObjects(rng: () => number, count: number): ThreeObject[] {
  const objects: ThreeObject[] = []
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2 + rng() * 0.4
    const radius = 1.55 + rng() * 0.6
    objects.push({
      shape: pick(SHAPES, rng),
      material: pick(['standard', 'standard', 'physical', 'physical'] as const, rng),
      tint: pick(['accent2', 'accent2', 'muted', 'muted'] as const, rng),
      scale: n(0.3 + rng() * 0.32),
      pos: [n(Math.cos(angle) * radius), n((rng() - 0.5) * 1.3), n(Math.sin(angle) * radius)],
      rot: [n(rng() * Math.PI), n(rng() * Math.PI), 0],
      metalness: n(0.2 + rng() * 0.6),
      roughness: n(0.15 + rng() * 0.55),
    })
  }
  return objects
}

/** 确定性 3D 描述符：只使用受限枚举，保证渲染与导出都稳定。 */
export function mockThreeScene(prompt: string): ThreeDescriptor {
  const seedNum = seedFrom(prompt)
  const rng = seededRandom(seedNum)
  const preset = pick(PRESETS, rng)
  const palette = pick(['accent', 'accent', 'mono', 'duotone'] as const, rng)
  const light = pick(['studio', 'studio', 'sunset', 'neon', 'soft'] as const, rng)
  const motionKind = pick(['rotate', 'rotate', 'float', 'pulse'] as const, rng)
  const distance = preset === 'wave-field' ? n(9 + rng() * 2) : preset === 'particle-cloud' ? n(8 + rng() * 2) : n(6.2 + rng() * 1.6)
  const mainScale = n(1.5 + rng() * 0.4)
  const metal = n(0.35 + rng() * 0.5)
  const rough = n(0.12 + rng() * 0.35)

  let objects: ThreeObject[] = []
  switch (preset) {
    case 'wave-field': {
      objects = []
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 3; col += 1) {
          objects.push({
            shape: 'box',
            material: 'standard',
            tint: row === 1 && col === 1 ? 'accent' : 'accent2',
            scale: n(0.32 + (row === 1 && col === 1 ? 0.34 : 0)),
            pos: [n((col - 1) * 1.5), n(Math.sin(row + col) * 0.42), n((row - 1) * 1.5)],
            rot: [0, n((row + col) * 0.2), 0],
            metalness: metal,
            roughness: rough,
          })
        }
      }
      break
    }
    case 'stack': {
      objects = [0, 1, 2, 3].map((i) => ({
        shape: 'box',
        material: i === 3 ? 'physical' : 'standard',
        tint: i === 3 ? 'accent' : i === 0 ? 'muted' : 'accent2',
        scale: n(1.35 - i * 0.12),
        pos: [0, n(-1.1 + i * 0.62), 0],
        rot: [0, n(0.28 + i * 0.06), 0],
        metalness: metal,
        roughness: rough,
      }))
      break
    }
    case 'globe': {
      objects = [
        {
          shape: 'sphere',
          material: 'physical',
          tint: 'accent',
          scale: mainScale,
          pos: [0, 0, 0],
          rot: [0, 0, 0],
          metalness: n(0.55 + rng() * 0.3),
          roughness: n(0.1 + rng() * 0.2),
        },
        ...ringObjects(rng, 5).map((object, index): ThreeObject => ({
          ...object,
          shape: index % 2 === 0 ? 'octa' : 'sphere',
          scale: n(0.14 + rng() * 0.16),
          pos: [object.pos[0], object.pos[1] * 0.7, object.pos[2]],
        })),
      ]
      break
    }
    case 'torus': {
      objects = [
        {
          shape: 'torusKnot',
          material: 'standard',
          tint: 'accent',
          scale: mainScale,
          pos: [0, 0, 0],
          rot: [0.42, 0.24, 0],
          metalness: n(0.6 + rng() * 0.25),
          roughness: n(0.12 + rng() * 0.18),
        },
        ...ringObjects(rng, 2).map((object) => ({ ...object, scale: n(0.3 + rng() * 0.2) })),
      ]
      break
    }
    case 'particle-cloud': {
      objects = []
      break
    }
    case 'showcase': {
      objects = [
        {
          shape: pick(['torus', 'icosa', 'octa'] as const, rng),
          material: 'physical',
          tint: 'accent',
          scale: mainScale,
          pos: [0, 0, 0],
          rot: [0.2, 0.5, 0],
          metalness: metal,
          roughness: rough,
        },
        ...ringObjects(rng, 3),
      ]
      break
    }
    default: {
      objects = [
        {
          shape: 'torus',
          material: 'standard',
          tint: 'accent',
          scale: mainScale,
          pos: [0, 0, 0],
          rot: [0.42, 0.24, 0],
          metalness: n(0.65 + rng() * 0.2),
          roughness: n(0.16 + rng() * 0.18),
        },
        ...ringObjects(rng, 3),
      ]
      break
    }
  }

  return {
    preset,
    palette,
    light,
    bg: 'transparent',
    camera: { distance, elevation: n(0.16 + rng() * 0.2), fov: Math.round(38 + rng() * 10) },
    motion: { kind: motionKind, speed: n(0.24 + rng() * 0.3) },
    objects: objects.slice(0, 24),
    grain: preset === 'particle-cloud' ? 0.06 : n(rng() * 0.04),
    orbitControls: false,
  }
}
