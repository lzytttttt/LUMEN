/**
 * sample-deck.ts —— 双语示例演示（9 幕，含 SVG 插图与 3D 场景）。
 * 同时充当：首次启动内容、Mock 生成器的骨架、e2e 与截图 harness 的固定夹具。
 */
import type { Block, Deck, Slide, TextBlock } from '@/schema/deck'
import { deckSchema } from '@/schema/deck'
import { makeShape, makeSlide, makeSvg, makeText, makeThree } from '@/schema/factory'
import { newId } from '@/schema/ids'

type Lang = 'zh' | 'en'

interface Copy {
  title: string
  slides: {
    name: string
    cover: { kicker: string; title: string; lead: string; foot: string }
    statement: { title: string; caption: string }
    split: { title: string; caption: string; bullets: string[]; foot: string; art: string }
    grid: { title: string; caption: string; foot: string; cards: { label: string; body: string }[] }
    timeline: {
      title: string
      caption: string
      nodes: { year: string; name: string; desc: string }[]
    }
    data: {
      title: string
      caption: string
      values: string[]
      categories: string[]
      conclusionTitle: string
      conclusion: string
      footnote: string
      foot: string
    }
    compare: { title: string; left: string; right: string; leftItems: string[]; rightItems: string[]; foot: string }
    quote: { title: string; attribution: string }
    closing: { title: string; lead: string; foot: string }
  }
  notes: string[]
}

const artPageToScreen = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 680" fill="none">
  <defs>
    <linearGradient id="lumen-g1" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--d-accent)" stop-opacity="0.22"/>
      <stop offset="1" stop-color="var(--d-accent2)" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="60" y="150" width="230" height="330" rx="10" stroke="var(--d-line)" stroke-width="1.6"/>
  <path d="M96 210h158M96 250h118M96 290h140M96 330h96" stroke="var(--d-muted)" stroke-width="2" stroke-linecap="round" opacity="0.75"/>
  <circle cx="100" cy="420" r="10" stroke="var(--d-muted)" stroke-width="1.6"/>
  <circle cx="132" cy="420" r="10" stroke="var(--d-muted)" stroke-width="1.6"/>
  <path d="M310 315h86" stroke="var(--d-accent)" stroke-width="2"/>
  <path d="M388 306l14 9-14 9" stroke="var(--d-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="430" y="120" width="270" height="440" rx="22" stroke="var(--d-accent)" stroke-width="2" fill="url(#lumen-g1)"/>
  <rect x="470" y="176" width="190" height="12" rx="6" fill="var(--d-accent)"/>
  <rect x="470" y="210" width="132" height="8" rx="4" fill="var(--d-muted)" opacity="0.8"/>
  <circle cx="565" cy="360" r="64" stroke="var(--d-accent2)" stroke-width="2"/>
  <circle cx="565" cy="360" r="26" fill="var(--d-accent2)" opacity="0.18"/>
  <path d="M470 480h190" stroke="var(--d-line)" stroke-width="1.6"/>
  <path d="M470 508h120" stroke="var(--d-line)" stroke-width="1.6"/>
  <path d="M60 540h230" stroke="var(--d-line)" stroke-width="1.6" stroke-dasharray="4 8"/>
</svg>`

const artBars = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 820 470" fill="none">
  <g stroke="var(--d-line)" stroke-width="1" opacity="0.55">
    <path d="M40 320h740"/>
    <path d="M40 240h740"/>
    <path d="M40 160h740"/>
    <path d="M40 80h740"/>
  </g>
  <path d="M40 400h740" stroke="var(--d-line)" stroke-width="1.5"/>
  <path d="M40 400V70" stroke="var(--d-line)" stroke-width="1.5"/>
  <rect x="60" y="367" width="120" height="33" rx="4" fill="var(--d-muted)" opacity="0.55"/>
  <rect x="240" y="284" width="120" height="116" rx="4" fill="var(--d-accent2)" opacity="0.62"/>
  <rect x="420" y="185" width="120" height="215" rx="4" fill="var(--d-accent2)"/>
  <rect x="600" y="103" width="120" height="297" rx="4" fill="var(--d-accent)"/>
</svg>`

const copyZh: Copy = {
  title: '演示，该换一种载体了',
  slides: {
    name: '封面',
    cover: {
      kicker: 'LUMEN · 幕光 · AI 原生演示',
      title: '演示，\n该换一种载体了',
      lead: '从一份静态文件，到一件可运行的 HTML 作品。',
      foot: '1600 × 900 · 无插件 · 双击即播',
    },
    statement: {
      title: 'PPT 记录的是页面，\nHTML 交付的是体验。',
      caption: '演示不是文件的格式，而是体验的载体。',
    },
    split: {
      title: '三个断点',
      caption: '为什么旧格式卡住了',
      bullets: [
        '**静态**：改一页要重排版，改十页要重做。',
        '**线性**：观众只能跟着翻，不能自己看。',
        '**离线**：文件发出去就失联，数据回不来。',
      ],
      foot: 'HTML 把这三件事同时解开了。',
      art: artPageToScreen,
    },
    grid: {
      title: '一份作品，四种能力',
      caption: '生成、编辑、播放、导出一条链',
      foot: '所有能力都长在同一份 HTML 上。',
      cards: [
        { label: '生成', body: '一句话出大纲，逐幕成稿，版式由配方保证。' },
        { label: '编辑', body: '所见即所得，拖拽吸附，细到一行字。' },
        { label: '播放', body: '全屏、转场、讲者视图，键盘即控。' },
        { label: '导出', body: '独立 HTML 单文件，双击即可播放。' },
      ],
    },
    timeline: {
      title: '载体变迁',
      caption: '每一次载体变化，都重新定义了「演示」',
      nodes: [
        { year: '1987', name: 'PowerPoint 诞生', desc: '投影仪搬进了办公室' },
        { year: '2006', name: 'Web 演示', desc: '浏览器开始能放幻灯片' },
        { year: '2015', name: '前端动效', desc: '动效与交互成为常态' },
        { year: '2026', name: 'AI 原生', desc: '一句话生成一件作品' },
      ],
    },
    data: {
      title: '观众记得住什么',
      caption: '同一内容，不同媒介的记忆留存（示意数据）',
      values: ['10%', '35%', '65%', '90%'],
      categories: ['纯文字', '图文', '动图', '可交互'],
      conclusionTitle: '结论',
      conclusion: '能被记住的不是信息量，\n而是**可操作的体验**。',
      footnote: '示意数据：用于说明媒介差异，非严谨统计。',
      foot: '同一份内容，换一种载体，留存差 9 倍。',
    },
    compare: {
      title: '幻灯片 / 作品',
      left: '幻灯片',
      right: 'HTML 作品',
      leftItems: ['静态排版，改一页要重来', '线性翻页，观众只能跟', '文件即终点，数据回不来'],
      rightItems: ['结构化数据，改一处全篇更新', '可交互，观众能自己看', '可度量，能继续迭代'],
      foot: '同一份内容，两种交付方式。',
    },
    quote: {
      title: '把页面交出去，\n还是把体验交出去？',
      attribution: 'LUMEN 设计原则 · P6 同一渲染器',
    },
    closing: {
      title: '开始第一幕',
      lead: '按 ⌘K 输入你的主题，剩下的交给它。',
      foot: 'LUMEN · 幕光工作台 · 2026',
    },
  },
  notes: [
    '开场不要念标题，先问一句：你上一次打开一份 PPT 是什么时候？',
    '这一页只留一句话，语速放慢，留 3 秒空白。',
    '三个断点对应听众的真实痛点，逐个举例。',
    '四种能力对应产品形态，不需要展开技术细节。',
    '讲到 2026 停一下：载体变化的间隔在缩短。',
    '数据页只讲结论，不要念数字。',
    '对比页让听众自己选：你更想交出去哪一种？',
    '引用页承担情绪转折，读完停 2 秒再翻页。',
    '收尾：给出一个明确动作——现在按 ⌘K 试一次。',
  ],
}

const copyEn: Copy = {
  title: 'Decks deserve a new medium',
  slides: {
    name: 'Cover',
    cover: {
      kicker: 'LUMEN · AI-native decks',
      title: 'Decks deserve\na new medium.',
      lead: 'From a static file to a living HTML artifact.',
      foot: '1600 × 900 · No plugins · Double-click to present',
    },
    statement: {
      title: 'Slides record pages.\nHTML delivers experience.',
      caption: 'A deck is not a file format. It is a way of being experienced.',
    },
    split: {
      title: 'Three breakpoints',
      caption: 'Why the old format stalls',
      bullets: [
        '**Static**: one edit means re-layout, ten edits mean a rebuild.',
        '**Linear**: the audience can only follow, never explore.',
        '**Offline**: the file leaves and never reports back.',
      ],
      foot: 'HTML dissolves all three at once.',
      art: artPageToScreen,
    },
    grid: {
      title: 'One artifact, four capabilities',
      caption: 'Generate, edit, present, export — one chain',
      foot: 'Every capability lives on the same HTML document.',
      cards: [
        { label: 'Generate', body: 'A sentence becomes an outline; recipes keep the layout honest.' },
        { label: 'Edit', body: 'WYSIWYG, snapping, down to a single line of text.' },
        { label: 'Present', body: 'Fullscreen, transitions, presenter view, keyboard first.' },
        { label: 'Export', body: 'One self-contained HTML file. Double-click to play.' },
      ],
    },
    timeline: {
      title: 'The medium moved',
      caption: 'Every medium shift redefined what a presentation is',
      nodes: [
        { year: '1987', name: 'PowerPoint', desc: 'The projector moved into the office' },
        { year: '2006', name: 'Web decks', desc: 'Browsers learned to present' },
        { year: '2015', name: 'Motion', desc: 'Animation and interaction became normal' },
        { year: '2026', name: 'AI native', desc: 'One sentence builds the artifact' },
      ],
    },
    data: {
      title: 'What the audience remembers',
      caption: 'Same content, different media (illustrative)',
      values: ['10%', '35%', '65%', '90%'],
      categories: ['Text only', 'Text + image', 'Motion', 'Interactive'],
      conclusionTitle: 'The point',
      conclusion: 'What sticks is not the volume —\nit is the **manipulable experience**.',
      footnote: 'Illustrative figures, meant to show the gap, not a rigorous study.',
      foot: 'Same content, a different medium, nine times the recall.',
    },
    compare: {
      title: 'Slide / Artifact',
      left: 'A deck',
      right: 'An HTML artifact',
      leftItems: ['Static layout, every edit a rebuild', 'Linear flipping, no exploration', 'The file is the end state'],
      rightItems: ['Structured data, edit once update everywhere', 'Interactive — the audience can look around', 'Measurable, and keeps evolving'],
      foot: 'One story, two ways to hand it over.',
    },
    quote: {
      title: 'Hand over a page,\nor hand over an experience?',
      attribution: 'LUMEN design principle · P6 One renderer',
    },
    closing: {
      title: 'Start your first act',
      lead: 'Press ⌘K, type the topic, and let it draft.',
      foot: 'LUMEN · Workbench · 2026',
    },
  },
  notes: [
    'Do not read the title. Ask instead: when did you last open a PPT?',
    'One line only. Slow down, leave three seconds of silence.',
    'Each breakpoint maps to a real pain — give one example each.',
    'Four capabilities map to the product, no technical detail needed.',
    'Pause at 2026: the gaps between media shifts keep shrinking.',
    'Data slide: land the conclusion, never read the numbers.',
    'Let the room choose which one they would rather hand over.',
    'The quote is the emotional turn. Read it, hold two beats, then advance.',
    'Close with one concrete action: press ⌘K right now.',
  ],
}

const copyByLang: Record<Lang, Copy> = { zh: copyZh, en: copyEn }

function tidy(blocks: Block[]): Block[] {
  return blocks.map((block, index) => ({ ...block, z: index + 1 }))
}

function text(
  value: string,
  opts: {
    x: number
    y: number
    w: number
    h: number
    variant?: TextBlock['variant']
    color?: TextBlock['color']
    align?: 'left' | 'center' | 'right'
    weight?: number
  },
): Block {
  return makeText({
    text: value,
    x: opts.x,
    y: opts.y,
    w: opts.w,
    h: opts.h,
    variant: opts.variant ?? 'body',
    color: opts.color ?? 'fg',
    align: opts.align ?? 'left',
    weight: opts.weight,
    inline: true,
  })
}

export function createSampleDeck(lang: Lang = 'zh'): Deck {
  const copy = copyByLang[lang]
  const s = copy.slides

  const cover: Slide = makeSlide({
    name: s.name,
    transition: { kind: 'fade', ms: 520 },
    notes: copy.notes[0],
    blocks: tidy([
      text(s.cover.kicker, { x: 120, y: 176, w: 620, h: 30, variant: 'caption', color: 'accent' }),
      text(s.cover.title, { x: 120, y: 232, w: 780, h: 260, variant: 'display' }),
      makeShape({ kind: 'rule', x: 120, y: 528, w: 96, h: 2, fill: 'accent', strokeWidth: 2 }),
      text(s.cover.lead, { x: 120, y: 560, w: 660, h: 100, variant: 'lead', color: 'muted' }),
      text(s.cover.foot, { x: 120, y: 796, w: 620, h: 28, variant: 'caption', color: 'muted' }),
      makeThree({
        x: 900,
        y: 110,
        w: 580,
        h: 680,
        descriptor: {
          preset: 'orbit',
          palette: 'accent',
          light: 'studio',
          bg: 'transparent',
          camera: { distance: 7.4, elevation: 0.22, fov: 42 },
          motion: { kind: 'rotate', speed: 0.32 },
          grain: 0,
          orbitControls: false,
          objects: [
            { shape: 'torus', material: 'standard', tint: 'accent', scale: 1.45, pos: [0, 0, 0], rot: [0.42, 0.24, 0], metalness: 0.72, roughness: 0.24 },
            { shape: 'sphere', material: 'standard', tint: 'accent2', scale: 0.52, pos: [2.35, 0.72, 0.5], rot: [0, 0, 0], metalness: 0.15, roughness: 0.35 },
            { shape: 'octa', material: 'physical', tint: 'fg', scale: 0.38, pos: [-2.45, -0.68, 0.62], rot: [0.2, 0.6, 0] },
            { shape: 'icosa', material: 'wireframe', tint: 'muted', scale: 0.72, pos: [0.4, 1.9, -1.2], rot: [0.1, 0.3, 0.2] },
          ],
        },
      }),
    ]),
  })

  const statement: Slide = makeSlide({
    name: lang === 'zh' ? '主张' : 'Statement',
    transition: { kind: 'fade', ms: 460 },
    notes: copy.notes[1],
    blocks: tidy([
      text(s.statement.title, {
        x: 120,
        y: 268,
        w: 1360,
        h: 220,
        variant: 'h1',
        align: 'center',
      }),
      makeShape({ kind: 'rule', x: 760, y: 528, w: 80, h: 2, fill: 'accent', strokeWidth: 2 }),
      text(s.statement.caption, {
        x: 120,
        y: 560,
        w: 1360,
        h: 40,
        variant: 'lead',
        color: 'muted',
        align: 'center',
      }),
    ]),
  })

  const split: Slide = makeSlide({
    name: lang === 'zh' ? '断点' : 'Breakpoints',
    transition: { kind: 'push', ms: 420 },
    notes: copy.notes[2],
    blocks: tidy([
      text(s.split.title, { x: 120, y: 148, w: 520, h: 64, variant: 'h2' }),
      text(s.split.caption, { x: 120, y: 214, w: 520, h: 26, variant: 'caption', color: 'muted' }),
      text(s.split.bullets[0], { x: 120, y: 286, w: 520, h: 96, variant: 'body' }),
      text(s.split.bullets[1], { x: 120, y: 396, w: 520, h: 96, variant: 'body' }),
      text(s.split.bullets[2], { x: 120, y: 506, w: 520, h: 96, variant: 'body' }),
      makeShape({ kind: 'rule', x: 120, y: 640, w: 520, h: 1, fill: 'line', strokeWidth: 1 }),
      text(s.split.foot, { x: 120, y: 664, w: 520, h: 34, variant: 'body', color: 'accent' }),
      makeSvg({
        x: 720,
        y: 110,
        w: 760,
        h: 680,
        source: s.split.art,
        viewBox: [0, 0, 760, 680],
        animate: 'float',
      }),
    ]),
  })

  const cardX = [120, 460, 800, 1140]
  const gridBlocks: Block[] = [
    text(s.grid.title, { x: 120, y: 136, w: 900, h: 64, variant: 'h2' }),
    text(s.grid.caption, { x: 120, y: 202, w: 900, h: 26, variant: 'caption', color: 'muted' }),
  ]
  s.grid.cards.forEach((card, index) => {
    const x = cardX[index]
    gridBlocks.push(
      makeShape({
        kind: 'rect',
        x,
        y: 300,
        w: 310,
        h: 300,
        fill: 'surface',
        stroke: 'line',
        strokeWidth: 1,
        radius: 14,
      }),
      text(`0${index + 1}`, { x: x + 28, y: 328, w: 120, h: 26, variant: 'caption', color: 'accent' }),
      text(card.label, { x: x + 28, y: 372, w: 254, h: 56, variant: 'h2' }),
      text(card.body, { x: x + 28, y: 452, w: 254, h: 120, variant: 'body', color: 'muted' }),
    )
  })
  gridBlocks.push(text(s.grid.foot, { x: 120, y: 668, w: 900, h: 30, variant: 'caption', color: 'muted' }))
  const grid: Slide = makeSlide({
    name: lang === 'zh' ? '四种能力' : 'Capabilities',
    transition: { kind: 'wipe', ms: 420 },
    notes: copy.notes[3],
    blocks: tidy(gridBlocks),
  })

  const timelineBlocks: Block[] = [
    text(s.timeline.title, { x: 120, y: 136, w: 900, h: 64, variant: 'h2' }),
    text(s.timeline.caption, { x: 120, y: 202, w: 900, h: 26, variant: 'caption', color: 'muted' }),
    makeShape({ kind: 'line', x: 120, y: 462, w: 1360, h: 1, fill: 'line', strokeWidth: 1 }),
  ]
  const nodeX = [210, 570, 930, 1280]
  s.timeline.nodes.forEach((node, index) => {
    const cx = nodeX[index]
    timelineBlocks.push(
      makeShape({ kind: 'ellipse', x: cx - 9, y: 453, w: 18, h: 18, fill: 'accent' }),
      text(node.year, { x: cx - 80, y: 392, w: 160, h: 40, variant: 'h2', color: 'accent', align: 'center' }),
      text(node.name, { x: cx - 120, y: 498, w: 240, h: 30, variant: 'body', align: 'center', weight: 600 }),
      text(node.desc, { x: cx - 120, y: 534, w: 240, h: 56, variant: 'caption', color: 'muted', align: 'center' }),
    )
  })
  const timeline: Slide = makeSlide({
    name: lang === 'zh' ? '时间线' : 'Timeline',
    transition: { kind: 'push', ms: 420 },
    notes: copy.notes[4],
    blocks: tidy(timelineBlocks),
  })

  const barHeights = [33, 116, 215, 297]
  const dataBlocks: Block[] = [
    text(s.data.title, { x: 120, y: 136, w: 900, h: 64, variant: 'h2' }),
    text(s.data.caption, { x: 120, y: 202, w: 900, h: 26, variant: 'caption', color: 'muted' }),
    makeSvg({ x: 120, y: 260, w: 820, h: 470, source: artBars, viewBox: [0, 0, 820, 470] }),
  ]
  s.data.values.forEach((value, index) => {
    const x = 180 + index * 180
    dataBlocks.push(
      text(value, {
        x,
        y: 260 + (400 - barHeights[index]) - 46,
        w: 120,
        h: 42,
        variant: 'h2',
        align: 'center',
        color: index === 3 ? 'accent' : 'fg',
      }),
      text(s.data.categories[index], {
        x,
        y: 260 + 412,
        w: 120,
        h: 26,
        variant: 'caption',
        color: 'muted',
        align: 'center',
      }),
    )
  })
  dataBlocks.push(
    text(s.data.conclusionTitle, { x: 1000, y: 300, w: 480, h: 56, variant: 'h2', color: 'accent' }),
    text(s.data.conclusion, { x: 1000, y: 380, w: 480, h: 130, variant: 'lead' }),
    makeShape({ kind: 'rule', x: 1000, y: 548, w: 120, h: 1, fill: 'line', strokeWidth: 1 }),
    text(s.data.footnote, { x: 1000, y: 574, w: 480, h: 56, variant: 'caption', color: 'muted' }),
    text(s.data.foot, { x: 120, y: 772, w: 820, h: 30, variant: 'caption', color: 'muted' }),
  )
  const data: Slide = makeSlide({
    name: lang === 'zh' ? '数据' : 'Data',
    transition: { kind: 'fade', ms: 440 },
    notes: copy.notes[5],
    blocks: tidy(dataBlocks),
  })

  const compare: Slide = makeSlide({
    name: lang === 'zh' ? '对比' : 'Compare',
    transition: { kind: 'wipe', ms: 420 },
    notes: copy.notes[6],
    blocks: tidy([
      text(s.compare.title, { x: 120, y: 148, w: 900, h: 64, variant: 'h2' }),
      text(s.compare.left, { x: 120, y: 262, w: 600, h: 56, variant: 'h2', color: 'muted' }),
      text(s.compare.right, { x: 860, y: 262, w: 600, h: 56, variant: 'h2', color: 'accent' }),
      makeShape({ kind: 'line', x: 800, y: 250, w: 1, h: 360, fill: 'line', strokeWidth: 1 }),
      ...s.compare.leftItems.map((item, index) =>
        text(item, { x: 120, y: 360 + index * 84, w: 620, h: 60, variant: 'body', color: 'muted' }),
      ),
      ...s.compare.rightItems.map((item, index) =>
        text(item, { x: 860, y: 360 + index * 84, w: 600, h: 60, variant: 'body' }),
      ),
      text(s.compare.foot, { x: 120, y: 700, w: 900, h: 30, variant: 'caption', color: 'muted' }),
    ]),
  })

  const quote: Slide = makeSlide({
    name: lang === 'zh' ? '引用' : 'Quote',
    transition: { kind: 'fade', ms: 520 },
    notes: copy.notes[7],
    blocks: tidy([
      text(s.quote.title, { x: 120, y: 248, w: 1360, h: 300, variant: 'display', align: 'center' }),
      makeShape({ kind: 'rule', x: 760, y: 600, w: 80, h: 2, fill: 'accent', strokeWidth: 2 }),
      text(s.quote.attribution, {
        x: 120,
        y: 628,
        w: 1360,
        h: 30,
        variant: 'caption',
        color: 'muted',
        align: 'center',
      }),
    ]),
  })

  const closing: Slide = makeSlide({
    name: lang === 'zh' ? '收尾' : 'Closing',
    transition: { kind: 'fade', ms: 560 },
    notes: copy.notes[8],
    blocks: tidy([
      text(s.closing.title, { x: 120, y: 268, w: 780, h: 244, variant: 'display' }),
      text(s.closing.lead, { x: 120, y: 540, w: 700, h: 96, variant: 'lead', color: 'muted' }),
      text(s.closing.foot, { x: 120, y: 796, w: 620, h: 28, variant: 'caption', color: 'muted' }),
      makeThree({
        x: 920,
        y: 150,
        w: 560,
        h: 600,
        descriptor: {
          preset: 'particle-cloud',
          palette: 'mono',
          light: 'neon',
          bg: 'transparent',
          camera: { distance: 8.2, elevation: 0.18, fov: 46 },
          motion: { kind: 'float', speed: 0.28 },
          grain: 0.06,
          orbitControls: false,
          objects: [],
        },
      }),
    ]),
  })

  return deckSchema.parse({
    id: newId('deck'),
    title: copy.title,
    lang,
    themeId: 'noir',
    slides: [cover, statement, split, grid, timeline, data, compare, quote, closing],
    meta: { createdAt: Date.now(), updatedAt: Date.now(), origin: 'sample' },
  }) as Deck
}
