/**
 * library/catalog.ts —— 12 件精选矢量插图的作者源码。
 *
 * 设计纪律（与《08-设计系统》一致）：
 * - 统一 800×600 画布，四周留白 ≥ 120，主体落在视觉中心；
 * - 描边只用细线（1–2.4），填色只做「面」的层次，绝不堆渐变与阴影；
 * - 每件最多一个强调色（--d-accent），其余走 line / muted / surface / fg；
 * - 全部令牌化（var(--d-*)），因此同一份源码在 6 套主题下都成立。
 *
 * 12 件 = geometric 4 + line 4 + iso 2 + chart 2。
 */
import type { SvgLibraryItem } from './types'

const arcStudy = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" fill="none">
  <circle cx="400" cy="300" r="210" stroke="var(--d-line)" stroke-width="1.4"/>
  <path d="M190 300a210 210 0 0 1 420 0" stroke="var(--d-accent)" stroke-width="2.4"/>
  <path d="M400 90v420" stroke="var(--d-line)" stroke-width="1.4" stroke-dasharray="3 9"/>
  <circle cx="400" cy="300" r="6" fill="var(--d-accent2)"/>
  <path d="M260 470h140" stroke="var(--d-muted)" stroke-width="2" stroke-linecap="round"/>
</svg>`

const orbitDots = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" fill="none">
  <ellipse cx="400" cy="300" rx="250" ry="96" stroke="var(--d-line)" stroke-width="1.4"/>
  <ellipse cx="400" cy="300" rx="150" ry="56" stroke="var(--d-line)" stroke-width="1.4"/>
  <circle cx="400" cy="300" r="34" fill="var(--d-accent)"/>
  <circle cx="650" cy="300" r="12" fill="var(--d-accent2)"/>
  <circle cx="250" cy="300" r="9" fill="var(--d-muted)"/>
</svg>`

const gridField = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" fill="none">
  <g stroke="var(--d-line)" stroke-width="1">
    <path d="M120 150H680M120 230H680M120 310H680M120 390H680M120 470H680"/>
    <path d="M140 120V490M220 120V490M300 120V490M380 120V490M460 120V490M540 120V490M620 120V490"/>
  </g>
  <path d="M140 490 620 120" stroke="var(--d-accent)" stroke-width="2.2"/>
  <circle cx="140" cy="490" r="5" fill="var(--d-accent)"/>
  <circle cx="620" cy="120" r="5" fill="var(--d-accent2)"/>
  <circle cx="380" cy="305" r="42" stroke="var(--d-muted)" stroke-width="1.2" stroke-dasharray="2 7"/>
</svg>`

const nestedSquares = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" fill="none">
  <rect x="190" y="90" width="420" height="420" stroke="var(--d-line)" stroke-width="1.2"/>
  <rect x="238" y="138" width="324" height="324" stroke="var(--d-line)" stroke-width="1.2" transform="rotate(8 400 300)"/>
  <rect x="290" y="190" width="220" height="220" stroke="var(--d-line)" stroke-width="1.2" transform="rotate(-12 400 300)"/>
  <rect x="348" y="248" width="104" height="104" stroke="var(--d-accent)" stroke-width="2" transform="rotate(20 400 300)"/>
  <path d="M120 300h160M520 300h160" stroke="var(--d-muted)" stroke-width="1.2" stroke-dasharray="2 8"/>
  <circle cx="400" cy="300" r="4" fill="var(--d-accent)"/>
</svg>`

const ruleStudies = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" fill="none">
  <path d="M150 148H650" stroke="var(--d-fg)" stroke-width="7"/>
  <path d="M150 196H452" stroke="var(--d-muted)" stroke-width="2"/>
  <path d="M150 250H650" stroke="var(--d-line)" stroke-width="1.2"/>
  <path d="M150 302H360" stroke="var(--d-accent)" stroke-width="2.4"/>
  <path d="M150 356H650" stroke="var(--d-line)" stroke-width="1.2"/>
  <path d="M150 404H540" stroke="var(--d-muted)" stroke-width="2"/>
  <path d="M150 456H650" stroke="var(--d-fg)" stroke-width="1.2" stroke-dasharray="18 10"/>
</svg>`

const contourLines = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" fill="none">
  <g stroke="var(--d-line)" stroke-width="1.2">
    <path d="M120 388C214 268 300 196 400 196s186 72 280 192"/>
    <path d="M120 424C214 304 300 232 400 232s186 72 280 192"/>
    <path d="M120 460C214 340 300 268 400 268s186 72 280 192"/>
  </g>
  <path d="M120 496C214 376 300 304 400 304s186 72 280 192" stroke="var(--d-accent)" stroke-width="2.2"/>
  <circle cx="400" cy="196" r="5" fill="var(--d-accent2)"/>
</svg>`

const signalSteps = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" fill="none">
  <path d="M130 470H690" stroke="var(--d-line)" stroke-width="1.2"/>
  <path d="M130 470V158" stroke="var(--d-line)" stroke-width="1.2"/>
  <path d="M130 158H670" stroke="var(--d-muted)" stroke-width="1.2" stroke-dasharray="3 9"/>
  <path d="M130 470H240V392H352V314H472V236H592V158H670" stroke="var(--d-accent)" stroke-width="2.4"/>
  <g fill="var(--d-fg)">
    <circle cx="240" cy="392" r="4"/>
    <circle cx="352" cy="314" r="4"/>
    <circle cx="472" cy="236" r="4"/>
    <circle cx="592" cy="158" r="4"/>
  </g>
</svg>`

const waveBars = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" fill="none">
  <path d="M120 300H680" stroke="var(--d-muted)" stroke-width="1.2" stroke-dasharray="2 10"/>
  <g stroke="var(--d-line)" stroke-width="4" stroke-linecap="round">
    <path d="M150 276V324"/>
    <path d="M184 262V338"/>
    <path d="M218 244V356"/>
    <path d="M252 222V378"/>
    <path d="M286 196V404"/>
    <path d="M320 168V432"/>
    <path d="M388 168V432"/>
    <path d="M422 196V404"/>
    <path d="M490 172V428"/>
    <path d="M524 204V396"/>
    <path d="M558 230V370"/>
    <path d="M592 252V348"/>
    <path d="M626 268V332"/>
    <path d="M660 278V322"/>
  </g>
  <g stroke="var(--d-accent)" stroke-width="4" stroke-linecap="round">
    <path d="M354 142V458"/>
    <path d="M456 142V458"/>
  </g>
</svg>`

const isoStack = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" fill="none">
  <path d="M400 372 560 442 400 512 240 442Z" fill="var(--d-surface)" stroke="var(--d-line)" stroke-width="1.2"/>
  <path d="M240 442v28l160 70v-28Z" fill="var(--d-surface)" stroke="var(--d-line)" stroke-width="1.2"/>
  <path d="M560 442v28l-160 70v-28Z" fill="var(--d-surface)" stroke="var(--d-line)" stroke-width="1.2"/>
  <path d="M400 258 520 318 400 378 280 318Z" fill="var(--d-accent)" stroke="var(--d-line)" stroke-width="1.2"/>
  <path d="M280 318v22l120 60v-22Z" fill="var(--d-accent)" stroke="var(--d-line)" stroke-width="1.2"/>
  <path d="M520 318v22l-120 60v-22Z" fill="var(--d-accent)" stroke="var(--d-line)" stroke-width="1.2"/>
  <path d="M400 176 452 202 400 228 348 202Z" fill="var(--d-surface)" stroke="var(--d-line)" stroke-width="1.2"/>
  <path d="M348 202v14l52 26v-14Z" fill="var(--d-surface)" stroke="var(--d-line)" stroke-width="1.2"/>
  <path d="M452 202v14l-52 26v-14Z" fill="var(--d-surface)" stroke="var(--d-line)" stroke-width="1.2"/>
  <path d="M150 566H650" stroke="var(--d-muted)" stroke-width="1.2" stroke-dasharray="2 9"/>
</svg>`

const isoRooms = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" fill="none">
  <g stroke="var(--d-line)" stroke-width="1.2">
    <path d="M400 148 600 248 400 348 200 248Z"/>
    <path d="M200 248v118l200 100 200-100V248"/>
    <path d="M400 348v118"/>
  </g>
  <path d="M400 148V348" stroke="var(--d-muted)" stroke-width="1.2" stroke-dasharray="3 9"/>
  <path d="M400 198 500 248 400 298 300 248Z" fill="var(--d-accent)"/>
  <path d="M200 366 400 466 600 366" stroke="var(--d-muted)" stroke-width="1.2"/>
</svg>`

const barSeries = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" fill="none">
  <g stroke="var(--d-line)" stroke-width="1" stroke-dasharray="2 8">
    <path d="M150 180H700"/>
    <path d="M150 280H700"/>
    <path d="M150 380H700"/>
  </g>
  <path d="M150 140V480" stroke="var(--d-muted)" stroke-width="1.4"/>
  <path d="M150 480H700" stroke="var(--d-muted)" stroke-width="1.4"/>
  <g fill="var(--d-surface)">
    <rect x="180" y="330" width="52" height="150"/>
    <rect x="272" y="270" width="52" height="210"/>
    <rect x="364" y="360" width="52" height="120"/>
    <rect x="456" y="220" width="52" height="260"/>
    <rect x="548" y="300" width="52" height="180"/>
  </g>
  <rect x="640" y="150" width="52" height="330" fill="var(--d-accent)"/>
  <g stroke="var(--d-muted)" stroke-width="1.4">
    <path d="M142 180h8"/>
    <path d="M142 280h8"/>
    <path d="M142 380h8"/>
    <path d="M180 480v8"/>
    <path d="M640 480v8"/>
  </g>
</svg>`

const donutSplit = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" fill="none">
  <circle cx="400" cy="300" r="150" fill="none" stroke="var(--d-muted)" stroke-width="32" stroke-dasharray="254.5 942.5" stroke-dashoffset="-688" transform="rotate(-90 400 300)"/>
  <circle cx="400" cy="300" r="150" fill="none" stroke="var(--d-accent2)" stroke-width="32" stroke-dasharray="254.5 942.5" stroke-dashoffset="-433.5" transform="rotate(-90 400 300)"/>
  <circle cx="400" cy="300" r="150" fill="none" stroke="var(--d-accent)" stroke-width="32" stroke-dasharray="433.5 942.5" transform="rotate(-90 400 300)"/>
  <circle cx="400" cy="300" r="112" fill="none" stroke="var(--d-line)" stroke-width="1.2" stroke-dasharray="2 8"/>
  <path d="M400 120v-14" stroke="var(--d-muted)" stroke-width="1.2"/>
  <path d="M400 480v14" stroke="var(--d-muted)" stroke-width="1.2"/>
  <path d="M220 300h-14" stroke="var(--d-muted)" stroke-width="1.2"/>
  <circle cx="400" cy="300" r="5" fill="var(--d-accent)"/>
</svg>`

/** 12 件，顺序即库面板顺序（grouped by category 由 UI 负责）。 */
export const LIBRARY_CATALOG: SvgLibraryItem[] = [
  {
    id: 'arc-study',
    name: { zh: '弧线研究', en: 'Arc study' },
    category: 'geometric',
    viewBox: [0, 0, 800, 600],
    source: arcStudy,
  },
  {
    id: 'orbit-dots',
    name: { zh: '轨道点阵', en: 'Orbit dots' },
    category: 'geometric',
    viewBox: [0, 0, 800, 600],
    source: orbitDots,
  },
  {
    id: 'grid-field',
    name: { zh: '栅格场', en: 'Grid field' },
    category: 'geometric',
    viewBox: [0, 0, 800, 600],
    source: gridField,
  },
  {
    id: 'nested-squares',
    name: { zh: '同心方阵', en: 'Nested squares' },
    category: 'geometric',
    viewBox: [0, 0, 800, 600],
    source: nestedSquares,
  },
  {
    id: 'rule-studies',
    name: { zh: '分割线研究', en: 'Rule studies' },
    category: 'line',
    viewBox: [0, 0, 800, 600],
    source: ruleStudies,
  },
  {
    id: 'contour-lines',
    name: { zh: '等高线', en: 'Contour lines' },
    category: 'line',
    viewBox: [0, 0, 800, 600],
    source: contourLines,
  },
  {
    id: 'signal-steps',
    name: { zh: '阶梯信号', en: 'Signal steps' },
    category: 'line',
    viewBox: [0, 0, 800, 600],
    source: signalSteps,
  },
  {
    id: 'wave-bars',
    name: { zh: '波形柱', en: 'Wave bars' },
    category: 'line',
    viewBox: [0, 0, 800, 600],
    source: waveBars,
  },
  {
    id: 'iso-stack',
    name: { zh: '等距堆叠', en: 'Isometric stack' },
    category: 'iso',
    viewBox: [0, 0, 800, 600],
    source: isoStack,
  },
  {
    id: 'iso-rooms',
    name: { zh: '等距空间', en: 'Isometric room' },
    category: 'iso',
    viewBox: [0, 0, 800, 600],
    source: isoRooms,
  },
  {
    id: 'bar-series',
    name: { zh: '柱状系列', en: 'Bar series' },
    category: 'chart',
    viewBox: [0, 0, 800, 600],
    source: barSeries,
  },
  {
    id: 'donut-split',
    name: { zh: '环形占比', en: 'Donut split' },
    category: 'chart',
    viewBox: [0, 0, 800, 600],
    source: donutSplit,
  },
]
