/**
 * scenarios.mjs —— LUMEN v0.3.0「LLM 实战模拟」的确定性内容生成器。
 *
 * 这个文件不联网、不依赖任何第三方包：它把 `src/ai/prompts.ts` 里四套 system prompt
 * 声明的输出契约，用「手写语料 + 结构化兜底」的方式一模一样地实现出来，供
 * `mock-llm-server.mjs` 在本地模拟一个 OpenAI 兼容端点。
 *
 * 契约对齐（逐条）：
 * - outline：title / subtitle / lang / slides[]；recipe 只取 12 种；首 cover、末 closing；
 *   全篇最多 1 个 svg 幕与 1 个 three 幕；data「标签=数值」、timeline「时间｜标题｜说明」、
 *   process「步骤｜时长｜说明」、compare「组名｜一句话」。
 * - slide：{ headline, lead, points, notes }；points 遵守该幕 recipe 的分隔符；
 *   非空 `brief` 会写进 points/notes（证明生成中纠偏通道真的生效）。
 * - svg：{ svg, viewBox: [0, 0, 820, 560], caption }；只使用 `src/render/svg/sanitize.ts`
 *   白名单内的标签，颜色只用主题令牌，无 <text> / style / 滤镜栈 / 外链。
 * - three：{ descriptor }，落在 `src/schema/deck.ts` 的 threeDescriptorSchema 内
 *   （objects ≤ 6、主对象 scale 1.0–2.0、辅助 0.2–0.6、|x| ≤ 3）。
 * - refine：{ headline, lead, points }；按指令关键词真实改变密度/结构/语言，保留核心信息。
 *
 * 纯函数：同样的 payload 永远得到同样的结果（哈希播种，不用 Math.random / Date）。
 */

/* ========================================================================== */
/*                                基础工具                                     */
/* ========================================================================== */

/** 12 个版式配方（与 src/schema/deck.ts 的 recipeIdSchema 完全一致）。 */
export const RECIPE_IDS = [
  'cover',
  'statement',
  'split',
  'grid3',
  'grid4',
  'timeline',
  'compare',
  'quote',
  'data',
  'process',
  'gallery',
  'closing',
]

const RECIPE_SET = new Set(RECIPE_IDS)

const THREE_PRESETS = new Set(['orbit', 'showcase', 'wave-field', 'particle-cloud', 'torus', 'stack', 'globe'])

/** FNV-1a 32 位哈希：给同一段 prompt 一个稳定的种子。 */
export function hash32(text) {
  const source = String(text ?? '')
  let hash = 2166136261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** mulberry32：确定性的伪随机数发生器（不碰 Math.random）。 */
function seededRandom(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function pick(rng, items) {
  return items[Math.floor(rng() * items.length) % items.length]
}

function asText(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/**
 * 受众代码 → 展示标签（造幕台设置里传的是 exec / team / client / class 这类代码，
 * 不能直接拼进 subtitle，否则会写出「给exec」这种话）。
 * 未知值原样返回，由调用方决定各自的兜底。
 */
const AUDIENCE_LABELS = {
  exec: { zh: '高管', en: 'execs' },
  team: { zh: '团队', en: 'team' },
  client: { zh: '客户', en: 'client' },
  class: { zh: '课堂', en: 'class' },
}

function audienceLabel(value, lang = 'zh') {
  const raw = asText(value, '').trim()
  if (raw === '') return ''
  const mapped = AUDIENCE_LABELS[raw.toLowerCase()]
  if (mapped) return lang === 'en' ? mapped.en : mapped.zh
  // 英文产出里不能混进中文受众描述：未知中文值交回调用方走自己的兜底。
  if (lang === 'en' && /[\u4e00-\u9fff]/.test(raw)) return ''
  return raw
}

/** 按 code point 截断（不会把 emoji / 生僻字切成两半）。 */
function clip(value, max) {
  const chars = Array.from(String(value ?? ''))
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

function lengthOf(value) {
  return Array.from(String(value ?? '')).length
}

function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactPoints(points) {
  if (!Array.isArray(points)) return []
  return points.map((point) => oneLine(point)).filter((point) => point !== '')
}

function stripBold(value) {
  return String(value ?? '').replace(/\*\*([^*]+)\*\*/g, '$1').trim()
}

/** 「A｜B｜C」→ 数组（全角 / 半角竖线都认）。 */
function splitPipe(value) {
  return stripBold(value)
    .split(/[｜|]/u)
    .map((part) => part.trim())
}

/** 从一句话里提炼主题：去掉「帮我 / 做一份 / 讲一讲」这类壳，并处理「把 X 讲给 Y」句式。 */
const PROMPT_SHELL_RE = /^(请|麻烦|帮我|帮忙|我想做|我想要|我想|我需要|需要|给我|来|做|写|生成|准备|讲讲|聊一聊)/u
const QUOTE_TRIM_RE = /^[「『"'“‘《]+|[」』"'”’》]+$/gu

function topicOf(prompt, max = 18) {
  const raw = oneLine(prompt)
  if (raw === '') return '这次分享'
  let text = raw

  // 「把 X 讲给 Y」/「给 Y 讲讲 X」：优先取真正被讲的那个 X。
  const tellAbout = /把\s*[「『"'“‘《]?([^」』"'”’》]{3,40}?)[」』"'”’》]?\s*(?:讲|说|分享|汇报|介绍|呈现)给/u.exec(raw)
  if (tellAbout) {
    text = tellAbout[1]
  } else {
    const about = /(?:关于|围绕|讲讲|讲一讲|聊一聊|介绍(?:一下)?)\s*[「『"'“‘《]?([^」』"'”’》]{3,40})/u.exec(raw)
    if (about) text = about[1]
  }

  for (let round = 0; round < 3; round += 1) {
    const next = text
      .replace(PROMPT_SHELL_RE, '')
      .replace(/^(一份|一个|一场|一次|一套|个)\s*/u, '')
      .replace(/[，,]\s*\d+\s*(?:分钟|分|min(?:ute)?s?).*$/iu, '')
      .trim()
    if (next === text || next === '') break
    text = next
  }
  text = text
    .replace(QUOTE_TRIM_RE, '')
    .replace(/\d+\s*(?:分钟|分|min(?:ute)?s?)\s*$/iu, '')
    .replace(/[。.!！?？]+$/u, '')
    .trim()
  const clause = text.split(/[，,。；;\n]/u)[0]?.trim() ?? ''
  return clip(Array.from(clause).length >= 4 ? clause : text, max)
}

/** 强主题信号：只认「一望即知」的词，避免「非技术」这类子串把题材带偏。 */
const STRONG_THEME_RE = {
  retro: /复盘|回顾|总结|反思|retro|retrospective/i,
  launch: /发布|上线|新品|首发|宣发|launch|release|unveil/i,
  course: /课程|讲解|教学|培训|上课|lesson|course|tutorial|workshop|class/i,
  tech: /方案评审|评审|架构|技术方案|系统设计|技术选型|重构|微服务|architecture|roadmap|proposal/i,
}

function hasStrongTheme(prompt, theme) {
  const pattern = STRONG_THEME_RE[theme]
  return Boolean(pattern && pattern.test(String(prompt ?? '')))
}

/** 英文 prompt 里抽一段可用作标题的拉丁文短语；没有就返回空串。 */
function latinTopicOf(prompt) {
  const match = /[A-Za-z][A-Za-z0-9 ,'’\-]{3,48}/.exec(oneLine(prompt))
  if (!match) return ''
  return oneLine(match[0].replace(/[,，。.;；:：]+$/u, ''))
}

/** 主题粗分类：只用于挑语料 / 3D 预设，不改变输出契约。 */
function detectTheme(prompt) {
  const text = String(prompt ?? '')
  if (/复盘|回顾|总结|反思|季度|retro|retrospective|review|postmortem/i.test(text)) return 'retro'
  if (/发布|上线|新品|宣发|首发|launch|release|unveil/i.test(text)) return 'launch'
  if (/课程|讲解|教学|培训|入门|上课|lesson|course|tutorial|workshop|class/i.test(text)) return 'course'
  if (/方案|架构|技术|设计|评审|规划|提案|plan|architecture|proposal|design|tech|roadmap/i.test(text)) return 'tech'
  return 'generic'
}

/** 幕数：payload.slideCount 优先，其次 length（short 6 / normal 9 / deep 12）。 */
function resolveSlideCount(payload) {
  const raw = Number(payload?.slideCount)
  if (Number.isFinite(raw) && raw > 0) return Math.max(3, Math.min(20, Math.round(raw)))
  const length = payload?.length
  if (length === 'short') return 6
  if (length === 'deep') return 12
  return 9
}

function resolveDuration(payload, fallback = 12) {
  const raw = Number(payload?.durationMin)
  if (Number.isFinite(raw) && raw > 0) return Math.max(3, Math.min(90, Math.round(raw)))
  return fallback
}

function cloneSeed(seed) {
  const visual = seed && seed.visual && typeof seed.visual === 'object' ? { ...seed.visual } : { kind: 'none' }
  return {
    recipe: seed?.recipe,
    headline: seed?.headline ?? '',
    lead: seed?.lead,
    points: Array.isArray(seed?.points) ? [...seed.points] : [],
    visual,
    notes: seed?.notes,
  }
}

/**
 * 从 12 幕母版里挑出恰好 count 幕：
 * 保留首幕（cover）与末幕（closing），中间按等距采样，保证叙事弧不被截断。
 */
function arrangeSeeds(master, count, extras = []) {
  const seeds = (Array.isArray(master) ? master : []).filter((seed) => RECIPE_SET.has(seed?.recipe))
  if (seeds.length === 0) return []
  const target = Math.max(3, Math.min(20, Math.round(count)))
  if (target === seeds.length) return seeds.map(cloneSeed)

  if (target < seeds.length) {
    const pool = seeds.slice(1, -1)
    const middleCount = target - 2
    const picked = []
    for (let index = 0; index < middleCount; index += 1) {
      const position = Math.round(((index + 1) * pool.length) / (middleCount + 1)) - 1
      picked.push(pool[Math.max(0, Math.min(pool.length - 1, position))])
    }
    return [seeds[0], ...picked, seeds[seeds.length - 1]].map(cloneSeed)
  }

  // 超过母版长度（极端输入）：补通用幕，再以 closing 收尾。
  const expanded = seeds.slice(0, -1)
  let cursor = 0
  while (expanded.length < target - 1) {
    const extra = extras[cursor % Math.max(extras.length, 1)] ?? seeds[(cursor % Math.max(seeds.length - 2, 1)) + 1]
    expanded.push(extra ?? seeds[seeds.length - 1])
    cursor += 1
  }
  expanded.push(seeds[seeds.length - 1])
  return expanded.map(cloneSeed)
}

/** 视觉预算：全篇最多 1 个 svg + 1 个 three；开关关掉时一律降为 none。 */
function enforceVisualBudget(seeds, includeSvg, include3d) {
  let svgCount = 0
  let threeCount = 0
  return (Array.isArray(seeds) ? seeds : []).map((seed) => {
    const visual = seed?.visual && typeof seed.visual === 'object' ? { ...seed.visual } : { kind: 'none' }
    if (visual.kind === 'svg') {
      if (!includeSvg || svgCount >= 1) return { ...seed, visual: { kind: 'none' } }
      svgCount += 1
    } else if (visual.kind === 'three') {
      if (!include3d || threeCount >= 1) return { ...seed, visual: { kind: 'none' } }
      threeCount += 1
    } else {
      return { ...seed, visual: { kind: 'none' } }
    }
    return { ...seed, visual }
  })
}

function zhSubtitle(audience, scene, minutes) {
  return `给${audience} · ${scene} · ${minutes} 分钟`
}

/* ========================================================================== */
/*                        中文手写语料（3 套母版）                              */
/* ========================================================================== */

/** 母版 1：为什么下一季度的复盘，要从 PPT 换成 HTML 演示。 */
const ZH_RETRO_HTML = {
  id: 'retro-html',
  audience: '产品与工程团队',
  scene: 'Q3 季度复盘',
  title: '复盘不该是一份文档，而是一个现场',
  slides: [
    {
      recipe: 'cover',
      headline: '复盘要能点开，不只是翻页',
      lead: '同样的内容，换一个载体，结论才留得下来。',
      points: [],
      visual: { kind: 'three', preset: 'orbit' },
      notes: '开场别念标题，先问：上次复盘的结论，现在还存在吗？',
    },
    {
      recipe: 'statement',
      headline: '复盘会结束的那一刻，文档就开始过期。',
      lead: '结论留在第 14 页，下一次决策没人会翻回去。',
      points: [],
      visual: { kind: 'none' },
      notes: '读完停两秒再翻页，让这句话先落地。',
    },
    {
      recipe: 'data',
      headline: '同一份复盘，三种归宿',
      lead: '示意数据：用于说明载体差异，非严谨统计。',
      points: ['仍被引用=8%', '偶尔打开=23%', '再没打开=69%'],
      visual: { kind: 'none' },
      notes: '指着最长的那条说：这不是内容问题，是载体问题。',
    },
    {
      recipe: 'grid3',
      headline: '复盘被浪费的三个地方',
      points: [
        '**找结论**：翻到第 14 页才看到建议。',
        '**对不上**：同一指标出现两个版本。',
        '**传不动**：转发一次，上下文丢一半。',
      ],
      visual: { kind: 'none' },
      notes: '三张卡片对应三个提问者：老板、数据同学、下一位负责人。',
    },
    {
      recipe: 'split',
      headline: '把结论放回它发生的地方',
      lead: '每一句判断下面，都挂着能点开的证据。',
      points: ['**现场**：点开当天的数据快照。', '**证据**：一段录音的时间戳。', '**下一步**：右边写好负责人和日期。'],
      visual: { kind: 'svg', brief: '一条时间线从文档流向外链页面，节点逐一点亮' },
      notes: '从左边讲到右边，最后停在「下一步」那条。',
    },
    {
      recipe: 'compare',
      headline: 'PPT 与 HTML，不是替代关系',
      lead: '一个负责被讲述，一个负责被使用。',
      points: ['PPT｜交付一次性的讲述', 'PPT｜版式固定，改一处要重发', 'HTML｜交付可检索的现场', 'HTML｜改一处，链接不变也更新'],
      visual: { kind: 'none' },
      notes: '先讲左边不丢人，再讲右边为什么值得多花两天。',
    },
    {
      recipe: 'quote',
      headline: '如果结论要三个人转述才能听懂，它就不是结论。',
      lead: 'Q3 复盘现场 · 产品负责人',
      points: [],
      visual: { kind: 'none' },
      notes: '引用这一句时放慢语速，别解释，让现场安静一下。',
    },
    {
      recipe: 'timeline',
      headline: '一次复盘，四个可交付节点',
      points: [
        'T-5 天｜对齐口径｜指标定义先统一，再开会',
        'T-2 天｜写结论｜每条结论配一个反例',
        'T-0｜现场演示｜边讲边点开证据',
        'T+3 天｜发链接｜只发一个能点开的页面',
      ],
      visual: { kind: 'none' },
      notes: '四个节点各停 20 秒，重点落在最后一个。',
    },
    {
      recipe: 'process',
      headline: '从文档到页面，只要四步',
      points: [
        '01｜半天｜先写 5 条能被反驳的判断',
        '02｜1 天｜每幕只留一个证据入口',
        '03｜1 天｜图表从同一份指标源生成',
        '04｜2 小时｜旧链接重定向到新页面',
      ],
      visual: { kind: 'none' },
      notes: '强调第三步：数据同一份源，才不会对不上。',
    },
    {
      recipe: 'grid4',
      headline: '换载体之后多出的四件事',
      points: [
        '**可检索**：结论能被下次会议直接引用。',
        '**可更新**：季度内持续修订，不重发。',
        '**可交互**：让听众自己点到证据。',
        '**可复用**：模板沉淀成团队资产。',
      ],
      visual: { kind: 'none' },
      notes: '这页快速过，每张卡片一句话，不展开。',
    },
    {
      recipe: 'statement',
      headline: '先让人看见，再让人相信',
      lead: '画面不是装饰，它把结论推到眼前。',
      points: [],
      visual: { kind: 'none' },
      notes: '用这一页收束证据，只讲一句就翻。',
    },
    {
      recipe: 'closing',
      headline: '下一次复盘，从一个链接开始',
      lead: 'Q4 的第一次复盘，直接用页面交付。',
      points: [],
      visual: { kind: 'none' },
      notes: '收尾给一个具体日期，把行动钉在日历上。',
    },
  ],
}

/** 母版 2：把一次季度复盘，讲成下一季度的行动。 */
const ZH_RETRO_ACTION = {
  id: 'retro-action',
  audience: '管理团队',
  scene: 'Q3 → Q4 行动对齐',
  title: '复盘结束时，只该留下一张行动表',
  slides: [
    {
      recipe: 'cover',
      headline: '复盘结束时，只该留下一张行动表',
      lead: '总结不是终点；下一次做对，才是。',
      points: [],
      visual: { kind: 'none' },
      notes: '开场先亮出行动表的空白模板，再往回讲。',
    },
    {
      recipe: 'statement',
      headline: '没人执行的复盘，只是把错误又抄了一遍。',
      lead: '行动不是附录，它就是复盘的正文。',
      points: [],
      visual: { kind: 'none' },
      notes: '这一页只讲一句，停两秒再往下。',
    },
    {
      recipe: 'grid3',
      headline: '复盘为什么总停在总结',
      points: [
        '**写给自己**：结论停在个人笔记里。',
        '**没有主人**：任务没有名字，也没有日期。',
        '**没有代价**：不做，也不会影响下一步。',
      ],
      visual: { kind: 'none' },
      notes: '三张卡片依次问：写给谁、谁负责、不做会怎样。',
    },
    {
      recipe: 'data',
      headline: '一张行动表要回答的三个数',
      lead: '示意数据：来自三次内部复盘的对照样本。',
      points: ['有负责人=100%', '有截止日期=82%', '两周内启动=47%'],
      visual: { kind: 'none' },
      notes: '最后一行数字才是重点：写在纸上不等于开始。',
    },
    {
      recipe: 'timeline',
      headline: '从复盘到落地，要过四关',
      points: [
        'T+0｜当场认领｜写下负责人和日期',
        'T+1 天｜拆小｜切到一周内能验证的动作',
        'T+7 天｜检查｜用同一指标回看一次',
        'T+30 天｜归档｜写进下一季度的默认流程',
      ],
      visual: { kind: 'none' },
      notes: '第四关最重要：没写进流程，下季度还会重犯。',
    },
    {
      recipe: 'compare',
      headline: '总结式复盘 vs 行动式复盘',
      lead: '差别不在会议时长，而在产出物。',
      points: ['总结式｜讨论发生了什么', '总结式｜结论留给主持人', '行动式｜讨论下次怎么改', '行动式｜每条结论都有主人'],
      visual: { kind: 'none' },
      notes: '左右各讲两条，最后落在右边的「主人」。',
    },
    {
      recipe: 'grid4',
      headline: '把结论翻译成动作',
      points: [
        '**结论**：延迟主要来自评审排队。',
        '**动作**：把评审拆成两个 30 分钟窗口。',
        '**验证**：下周看平均等待时长。',
        '**代价**：两位评审人各多一小时。',
      ],
      visual: { kind: 'none' },
      notes: '重点讲「代价」那张：不愿付代价的行动是许愿。',
    },
    {
      recipe: 'process',
      headline: '复盘后 30 天的四步',
      points: [
        '01｜30 分钟｜只留三条行动，宁少勿多',
        '02｜10 分钟｜负责人当场确认并写下日期',
        '03｜每周 5 分钟｜只看有没有变好',
        '04｜季度末｜把未完成项带进下一轮',
      ],
      visual: { kind: 'none' },
      notes: '强调第一步：三条都收不下，说明还没想清楚。',
    },
    {
      recipe: 'split',
      headline: '让行动表被所有人看见',
      lead: '贴出来，比记在共享文档里有效。',
      points: ['**谁**：每条行动只有一个负责人。', '**何时**：日期精确到周，不写「尽快」。', '**怎么算完成**：一句能被验证的话。'],
      visual: { kind: 'svg', brief: '一张三列的行动表在灯下逐列点亮，最后一行被圈出' },
      notes: '指着最后一行说：这条下周我会亲自检查。',
    },
    {
      recipe: 'quote',
      headline: '复盘的终点不是共识，是明天有人开始做不同的事。',
      lead: 'Q3 复盘 · 收尾',
      points: [],
      visual: { kind: 'none' },
      notes: '读完这句就结束这一页，不要补解释。',
    },
    {
      recipe: 'split',
      headline: '下一季度，只追三条线',
      lead: '其余的写进后台，不占下一次会议时间。',
      points: ['**增长**：新客首周留存。', '**效率**：评审平均等待时长。', '**质量**：线上事故恢复时间。'],
      visual: { kind: 'three', preset: 'stack' },
      notes: '三条线各配一个指标，别加第四条。',
    },
    {
      recipe: 'closing',
      headline: '明天上午 10 点，认领第一条',
      lead: '复盘之后真正的动作，发生在会议室之外。',
      points: [],
      visual: { kind: 'none' },
      notes: '把日期和地点说清楚，现场确认认领人。',
    },
  ],
}

/** 母版 3：产品发布。 */
const ZH_LAUNCH = {
  id: 'launch',
  audience: '产品与市场团队',
  scene: '新品发布',
  title: '发布会不介绍功能，只交付一个瞬间',
  slides: [
    {
      recipe: 'cover',
      headline: '功能会被忘记，场景会被复述',
      lead: '发布会的任务只有一个：让人记住一个瞬间。',
      points: [],
      visual: { kind: 'three', preset: 'showcase' },
      notes: '开场别念参数，先放那个最想被记住的画面。',
    },
    {
      recipe: 'statement',
      headline: '听众不关心你做了什么，只关心他哪里不一样了。',
      lead: '把「我们升级了」翻译成「你少做了哪一步」。',
      points: [],
      visual: { kind: 'none' },
      notes: '这一页说完停两秒，让对比停在听众脑子里。',
    },
    {
      recipe: 'split',
      headline: '先给画面，再给参数',
      lead: '把抽象的「能力」换成一个能看懂的场景。',
      points: ['**旧方式**：先讲架构，让听众自己拼价值。', '**新方式**：先放结果，再解释它怎么来的。', '**差别**：一个要耐心，一个只要三秒。'],
      visual: { kind: 'svg', brief: '一块屏幕从暗到亮，边缘伸出一条时间线' },
      notes: '指着右边那张图：从旧载体到新载体，只差一次「跑起来」。',
    },
    {
      recipe: 'grid3',
      headline: '发布会只需要三张牌',
      points: ['**问题**：谁在为什么付钱。', '**变化**：今天之后哪里不一样。', '**证据**：一个能被复述的细节。'],
      visual: { kind: 'none' },
      notes: '三张牌对应听众的三个疑问，每张讲 40 秒。',
    },
    {
      recipe: 'data',
      headline: '用一个数字说清价值',
      lead: '示意数据：用于说明量级，非严谨统计。',
      points: ['核心操作=3', '上手分钟=8', '可省步骤=5'],
      visual: { kind: 'none' },
      notes: '只强调「3」：核心操作只有三步，别念其他数字。',
    },
    {
      recipe: 'compare',
      headline: '旧流程 vs 新流程',
      lead: '不是快一点，是少三个人配合。',
      points: ['旧流程｜装软件、讲配置、等开会', '旧流程｜一次演示要三个人配合', '新流程｜双击打开，三分钟讲完', '新流程｜改一处，全篇同步'],
      visual: { kind: 'none' },
      notes: '讲左边时别贬低对手，只讲成本；右边落到「一个人也能做完」。',
    },
    {
      recipe: 'timeline',
      headline: '从定稿到上台，四个节点',
      points: [
        'T-8 周｜定叙事｜先定一句话，再定功能表',
        'T-6 周｜做样板｜把最关键的一幕做成能跑的原型',
        'T-2 周｜压时长｜砍掉三分之一的内容',
        'T-0｜上台｜只留一个动作给听众',
      ],
      visual: { kind: 'none' },
      notes: '重点讲 T-2 周：减法比加法难，也更重要。',
    },
    {
      recipe: 'process',
      headline: '四步做出可演示的样板',
      points: ['01｜2 天｜只跑通一条主路径', '02｜1 天｜把最亮的瞬间做成动画', '03｜半天｜准备三个会被追问的问题', '04｜1 小时｜彩排一次，掐表'],
      visual: { kind: 'none' },
      notes: '第三步最容易被跳过：先把会被问的问题写下来。',
    },
    {
      recipe: 'quote',
      headline: '最好的发布，是让听众回家后还能复述一句话。',
      lead: 'LUMEN 发布现场 · 主讲人',
      points: [],
      visual: { kind: 'none' },
      notes: '这一句就是全场的目标，说完停一秒。',
    },
    {
      recipe: 'grid4',
      headline: '台上只讲四件事',
      points: [
        '**谁的问题**：一句话说清对象。',
        '**什么变化**：今天之后哪里不同。',
        '**凭什么信**：一个可核对的细节。',
        '**下一步**：清楚到可以立刻动作。',
      ],
      visual: { kind: 'none' },
      notes: '四件事讲完就下台，不要临时加第五件。',
    },
    {
      recipe: 'statement',
      headline: '真正的发布，从用户第一次打开开始',
      lead: '台上讲完不算结束，链接发出去才算。',
      points: [],
      visual: { kind: 'none' },
      notes: '把「打开」这个动作说具体：点哪里、看到什么。',
    },
    {
      recipe: 'closing',
      headline: '今天散会后，只做一件事：打开它',
      lead: '把链接发进群里，让第一个人真的用起来。',
      points: [],
      visual: { kind: 'none' },
      notes: '现场发链接，等第一个人打开再下台。',
    },
  ],
}

/** 幕数超过 12 时用于补位的通用幕（仍然遵守分隔符与长度预算）。 */
const ZH_EXTRA = [
  {
    recipe: 'statement',
    headline: '把结论说在前面，细节留给提问',
    lead: '演示不是文档，它只负责让人做出一个决定。',
    points: [],
    visual: { kind: 'none' },
    notes: '补位页：视现场节奏决定是否展开。',
  },
  {
    recipe: 'grid3',
    headline: '三个随时会被问到的问题',
    points: ['**为什么现在**：拖延的成本比试错更高。', '**为什么是我们**：这件事只有我们非做不可。', '**怎么算赢**：一个月后能看到哪个数。'],
    visual: { kind: 'none' },
    notes: '补位页：把最尖锐的三个问题先自己回答一遍。',
  },
]

/* ========================================================================== */
/*                       中文结构化兜底语料（按题材换皮）                       */
/* ========================================================================== */

const GENERIC_FLAVOR_ZH = {
  retro: {
    title: '复盘要留下能被执行的结论',
    coverHeadline: '复盘要留下能被执行的结论',
    coverLead: '先讲清楚改什么，再讲发生了什么。',
    statement: '没有人执行的复盘，只是把错误又抄了一遍。',
    statementLead: '行动不是附录，它是复盘的正文。',
    quote: '复盘的终点不是共识，是明天有人开始做不同的事。',
    quoteLead: '季度复盘 · 收尾',
    closing: '下一步，只做一件明天能开始的事',
    closingLead: '把第一个动作钉进日历。',
    scene: '季度复盘',
  },
  launch: {
    title: '发布会只交付一个瞬间',
    coverHeadline: '功能会被忘记，场景会被复述',
    coverLead: '发布会的任务只有一个：让人记住一个瞬间。',
    statement: '听众不关心你做了什么，只关心他哪里不一样了。',
    statementLead: '把「我们升级了」翻译成「你少做了哪一步」。',
    quote: '最好的发布，是让听众回家后还能复述一句话。',
    quoteLead: '发布现场 · 主讲人',
    closing: '散会后只做一件事：让第一个人用起来',
    closingLead: '把链接发出去，等一个真实的打开。',
    scene: '新品发布',
  },
  tech: {
    title: '方案评审只回答三个问题',
    coverHeadline: '方案评审只回答三个问题',
    coverLead: '边界、代价、验证；其余都是实现细节。',
    statement: '架构不是一张图，是一组被写下来的取舍。',
    statementLead: '没有代价的方案，通常也还没有想清楚。',
    quote: '如果取舍没有被命名，它就不是一个决定。',
    quoteLead: '方案评审 · 架构组',
    closing: '评审之后，先把取舍写进文档',
    closingLead: '代码之前，先写清楚放弃了什么。',
    scene: '方案评审',
  },
  course: {
    title: '先给结果，再讲原理',
    coverHeadline: '先给结果，再讲原理',
    coverLead: '学员先看到能做什么，才愿意听为什么。',
    statement: '一堂课真正结束，是学员能自己做一遍。',
    statementLead: '听懂不是目标，做出来才是。',
    quote: '理解，是你合上笔记还能重新搭出来的东西。',
    quoteLead: '课程现场 · 讲师',
    closing: '今晚留一道 20 分钟能做完的练习',
    closingLead: '让学习发生在课堂之外。',
    scene: '课程讲解',
  },
  generic: {
    title: '把这件事讲成一个结论',
    coverHeadline: '把这件事讲成一个结论',
    coverLead: '少讲背景，多给判断；听众只带走一句就够。',
    statement: '演示不是把信息搬上台，而是把结论交出去。',
    statementLead: '信息量不等于说服力。',
    quote: '能被复述的，才是被听懂的。',
    quoteLead: '演示现场 · 主讲人',
    closing: '下一步，只做一件明天就能开始的事',
    closingLead: '把第一个动作写下来，并给它一个日期。',
    scene: '主题分享',
  },
}

function genericZhSeeds(prompt, count) {
  const detected = detectTheme(prompt)
  const strong = hasStrongTheme(prompt, detected)
  const theme = strong ? detected : 'generic'
  const flavor = GENERIC_FLAVOR_ZH[theme] ?? GENERIC_FLAVOR_ZH.generic
  const topic = topicOf(prompt, 14)
  const topicLength = Array.from(topic).length
  const topicTitle =
    topicLength >= 5 && topicLength <= 12 ? `「${topic}」值得一个明确的结论` : '把这件事讲成一个结论'
  const title = strong ? flavor.title : topicTitle
  const scene = strong ? flavor.scene : '主题分享'
  const coverHeadline = strong ? flavor.coverHeadline : title
  const master = [
    {
      recipe: 'cover',
      headline: clip(coverHeadline, 24),
      lead: clip(theme === 'generic' ? `围绕「${topic}」，只讲一个结论。` : flavor.coverLead, 40),
      points: [],
      visual: { kind: 'three', preset: theme === 'tech' ? 'torus' : theme === 'launch' ? 'showcase' : 'orbit' },
      notes: '开场别念标题，先抛一个反问，再让画面自己说话。',
    },
    {
      recipe: 'statement',
      headline: clip(flavor.statement, 24),
      lead: clip(flavor.statementLead, 40),
      points: [],
      visual: { kind: 'none' },
      notes: '读完停两秒再翻页，让这句话先落地。',
    },
    {
      recipe: 'grid3',
      headline: '先把三个问题说清楚',
      points: ['**问题**：谁在为哪件事付出成本。', '**变化**：今天之后，哪里变得不一样。', '**证据**：一个能被复述的细节。'],
      visual: { kind: 'none' },
      notes: '三张卡片对应听众的三个疑问，每张讲 30 秒。',
    },
    {
      recipe: 'data',
      headline: '用三个数字交代现状',
      lead: '示意数据：用于说明量级差异，非严谨统计。',
      points: ['投入=100%', '产出=38%', '返工=22%'],
      visual: { kind: 'none' },
      notes: '先指最大的数，再解释它意味着什么。',
    },
    {
      recipe: 'timeline',
      headline: '这件事的四个节点',
      points: [
        'T-2 周｜对齐目标｜先统一一句话结论',
        'T-0｜做出样板｜只跑通最短的一条路径',
        'T+3 天｜收反馈｜只问三个具体问题',
        'T+2 周｜定下一步｜写进默认流程',
      ],
      visual: { kind: 'none' },
      notes: '沿时间线从左到右，每个节点停 20 秒。',
    },
    {
      recipe: 'compare',
      headline: '两种做法，只能选一个',
      lead: '把选择说清楚，比把选项列全更重要。',
      points: ['现在｜靠人盯，靠记性', '现在｜问题到复盘时才暴露', '之后｜靠结构，靠默认流程', '之后｜问题在生成时就暴露'],
      visual: { kind: 'none' },
      notes: '先讲左边不丢人，再讲右边为什么值得换。',
    },
    {
      recipe: 'grid4',
      headline: '四个必须对齐的判断',
      points: [
        '**用户**：谁真的会因此改变动作。',
        '**价值**：省下的是时间还是返工。',
        '**代价**：愿意为此放弃什么。',
        '**验证**：一周内能看哪个数。',
      ],
      visual: { kind: 'none' },
      notes: '这页快速过，每张卡片一句话，不展开。',
    },
    {
      recipe: 'split',
      headline: '把主线画出来',
      lead: '一张图说清从哪里来、到哪里去。',
      points: ['**起点**：今天真实存在的瓶颈。', '**转折**：哪一个决定改变了走向。', '**终点**：听众散会后要做的动作。'],
      visual: { kind: 'svg', brief: '一条主线从左到右穿过三个节点，末端亮起' },
      notes: '左边讲判断，右边点一下图里最亮的位置。',
    },
    {
      recipe: 'process',
      headline: '四步推进，每一步可验收',
      points: ['01｜1 天｜先写一句能被反驳的结论', '02｜2 天｜把最强的一幕做成样板', '03｜半天｜找三个人来挑毛病', '04｜1 小时｜定下第一个动作和日期'],
      visual: { kind: 'none' },
      notes: '强调第一步：结论立不住，后面都是白工。',
    },
    {
      recipe: 'gallery',
      headline: '三种画面，讲同一件事',
      points: ['开场：一个具体的人和一个具体的问题', '中段：把结构摊开，指出关键的一层', '收尾：一个能立刻做的动作'],
      visual: { kind: 'none' },
      notes: '三张图快速过，别逐张解释细节。',
    },
    {
      recipe: 'split',
      headline: '让关键的一点立起来',
      lead: '画面只服务一个判断，不抢结论。',
      points: ['**焦点**：只留一个视觉中心。', '**层次**：辅助元素退到第二层。', '**留白**：让眼睛有地方休息。'],
      visual: { kind: 'none' },
      notes: '这一页用来收束证据，只讲一句就翻。',
    },
    {
      recipe: 'closing',
      headline: clip(flavor.closing, 24),
      lead: clip(flavor.closingLead, 40),
      points: [],
      visual: { kind: 'none' },
      notes: '收尾给一个具体日期，把行动钉在日历上。',
    },
  ]
  return {
    title: clip(title, 24),
    subtitle: zhSubtitle('与会同事', scene, 12),
    scene,
    slides: arrangeSeeds(master, count, ZH_EXTRA),
  }
}

/* ========================================================================== */
/*                          英文语料（结构化兜底）                             */
/* ========================================================================== */

const GENERIC_FLAVOR_EN = {
  retro: {
    title: 'A retro should end with actions, not a document',
    coverHeadline: 'A retro should end with actions, not a document',
    coverLead: 'Same content, different carrier: only one survives the meeting.',
    statement: 'The moment the retro ends, the document starts to expire.',
    statementLead: 'The conclusion sits on page 14; nobody opens it again.',
    quote: 'A retro is not a meeting. It is a change of behaviour.',
    quoteLead: 'Q3 retro · closing slide',
    closing: 'Tomorrow at 10: claim the first action',
    closingLead: 'The real work happens outside the meeting room.',
    scene: 'Q3 retro',
  },
  launch: {
    title: 'A launch is one moment, not a feature list',
    coverHeadline: 'A launch is one moment, not a feature list',
    coverLead: 'Deliver something the audience can repeat tomorrow.',
    statement: 'People do not remember what you built. They remember what changed.',
    statementLead: 'Translate “we upgraded it” into “you do one step less”.',
    quote: 'The best demo is the one the audience can repeat.',
    quoteLead: 'Launch day · product lead',
    closing: 'Send the link and let one person use it today',
    closingLead: 'The launch ends when the first user opens it.',
    scene: 'product launch',
  },
  tech: {
    title: 'A design review answers three questions, not thirty',
    coverHeadline: 'A design review answers three questions, not thirty',
    coverLead: 'Boundary, cost, proof. Everything else is implementation.',
    statement: 'Architecture is a set of trade-offs, not a diagram.',
    statementLead: 'A plan without a cost has not been thought through.',
    quote: 'If the trade-off is not named, it is not a decision.',
    quoteLead: 'Design review · architecture group',
    closing: 'Write the trade-off down before you write the code',
    closingLead: 'Name what you gave up, in one sentence.',
    scene: 'design review',
  },
  course: {
    title: 'Teach the result first, the mechanism second',
    coverHeadline: 'Teach the result first, the mechanism second',
    coverLead: 'Learners need to see what they can do before they care why.',
    statement: 'A lesson ends when the learner can do it alone.',
    statementLead: 'Understanding is not the goal. Repetition is not either. Doing is.',
    quote: 'Understanding is what you can rebuild with the notes closed.',
    quoteLead: 'Workshop · instructor',
    closing: 'Leave one exercise they can finish tonight',
    closingLead: 'Let the learning happen outside the room.',
    scene: 'workshop',
  },
  generic: {
    title: 'Turn this topic into one conclusion',
    coverHeadline: 'Turn this topic into one conclusion',
    coverLead: 'Less background, more judgement. One sentence is enough.',
    statement: 'A deck is not a document. It is a conclusion delivered.',
    statementLead: 'Volume is not persuasion.',
    quote: 'If it can be repeated, it was understood.',
    quoteLead: 'Presentation · speaker',
    closing: 'Next step: one thing you can start tomorrow',
    closingLead: 'Write it down and put a date on it.',
    scene: 'team talk',
  },
}

const GENERIC_BODY_EN = [
  {
    recipe: 'grid3',
    headline: 'Start with the three questions',
    points: ['**Problem**: who pays, and for what.', '**Change**: what is different after today.', '**Proof**: one detail people can repeat.'],
    visual: { kind: 'none' },
    notes: 'One card per question, 30 seconds each.',
  },
  {
    recipe: 'data',
    headline: 'Three numbers that frame the problem',
    lead: 'Illustrative figures, not a rigorous study.',
    points: ['Input=100%', 'Output=38%', 'Rework=22%'],
    visual: { kind: 'none' },
    notes: 'Point at the largest number, then say what it means.',
  },
  {
    recipe: 'timeline',
    headline: 'Four moments that matter',
    points: [
      'T-2 weeks｜Align｜Agree on one sentence first',
      'T-0｜Prototype｜Run the shortest path end to end',
      'T+3 days｜Feedback｜Ask only three concrete questions',
      'T+2 weeks｜Decide｜Write it into the default process',
    ],
    visual: { kind: 'none' },
    notes: 'Move left to right, 20 seconds per node.',
  },
  {
    recipe: 'compare',
    headline: 'Two ways forward. Pick one.',
    lead: 'Make the trade-off explicit, not the option list long.',
    points: ['Today｜Depends on people and memory', 'Today｜Problems surface in the retro', 'After｜Depends on structure and defaults', 'After｜Problems surface while building'],
    visual: { kind: 'none' },
    notes: 'Do not dismiss the left side; explain what it costs.',
  },
  {
    recipe: 'grid4',
    headline: 'Four judgements to align on',
    points: [
      '**User**: who actually changes behaviour.',
      '**Value**: time saved or rework avoided.',
      '**Cost**: what we are willing to give up.',
      '**Proof**: the number we check in a week.',
    ],
    visual: { kind: 'none' },
    notes: 'Fast page: one line per card, no deep dive.',
  },
  {
    recipe: 'split',
    headline: 'Draw the main line',
    lead: 'One diagram: where we come from, where we go.',
    points: ['**Start**: the bottleneck that is real today.', '**Turn**: the decision that changes direction.', '**End**: the action the audience takes next.'],
    visual: { kind: 'svg', brief: 'A single main line crossing three nodes, the last one lit' },
    notes: 'Talk to the left, point at the brightest node on the right.',
  },
  {
    recipe: 'process',
    headline: 'Four steps, each with a deliverable',
    points: ['01｜1 day｜Write one conclusion that can be disproved', '02｜2 days｜Make the strongest moment run', '03｜Half day｜Ask three people to attack it', '04｜1 hour｜Fix the first action and its date'],
    visual: { kind: 'none' },
    notes: 'Stress step one: a weak conclusion wastes the rest.',
  },
  {
    recipe: 'gallery',
    headline: 'Three images, one story',
    points: ['Open: one person, one concrete problem', 'Middle: the structure, one layer at a time', 'Close: an action that starts tomorrow'],
    visual: { kind: 'none' },
    notes: 'Move fast; do not explain every detail.',
  },
  {
    recipe: 'quote',
    headline: 'Clarity is a decision, not a formatting choice.',
    lead: 'Team talk · closing',
    points: [],
    visual: { kind: 'none' },
    notes: 'Slow down, read it once, then pause.',
  },
  {
    recipe: 'split',
    headline: 'Make the key point stand up',
    lead: 'The visual serves one judgement, not the deck.',
    points: ['**Focus**: keep one visual centre.', '**Depth**: push helpers to layer two.', '**Air**: leave the eye somewhere to rest.'],
    visual: { kind: 'none' },
    notes: 'Use this page to close the evidence and move on.',
  },
]

function genericEnSeeds(prompt, count, audienceRaw = '', minutes = 12) {
  const detected = detectTheme(prompt)
  const strong = hasStrongTheme(prompt, detected)
  const theme = strong ? detected : 'generic'
  const flavor = GENERIC_FLAVOR_EN[theme] ?? GENERIC_FLAVOR_EN.generic
  const latinTopic = strong ? '' : latinTopicOf(prompt)
  const topicTitle = latinTopic !== '' ? `Turn “${latinTopic}” into one conclusion` : ''
  const title = strong ? flavor.title : topicTitle || flavor.title
  const scene = strong ? flavor.scene : 'team talk'
  const coverHeadline = strong ? flavor.coverHeadline : title
  const master = [
    {
      recipe: 'cover',
      headline: clip(coverHeadline, 72),
      lead: clip(flavor.coverLead, 90),
      points: [],
      visual: { kind: 'three', preset: theme === 'tech' ? 'torus' : theme === 'launch' ? 'showcase' : 'orbit' },
      notes: 'Do not read the title. Ask a question, then let the visual breathe.',
    },
    {
      recipe: 'statement',
      headline: clip(flavor.statement, 72),
      lead: clip(flavor.statementLead, 90),
      points: [],
      visual: { kind: 'none' },
      notes: 'Read it once, then pause for two seconds.',
    },
    ...GENERIC_BODY_EN,
    {
      recipe: 'closing',
      headline: clip(flavor.closing, 72),
      lead: clip(flavor.closingLead, 90),
      points: [],
      visual: { kind: 'none' },
      notes: 'End with a date and an owner, not a thank-you slide.',
    },
  ]
  const audience = audienceLabel(audienceRaw, 'en') || argumentsAudience(prompt) || 'the team'
  return {
    title: clip(title, 72),
    subtitle: `For ${audience} · ${scene} · ${minutes} min`,
    scene,
    slides: arrangeSeeds(master, count, []),
  }
}

/** 英文 prompt 里尽量抽一个可用的听众词；没有就用 the team。 */
function argumentsAudience(prompt) {
  const match = /(?:for|to)\s+([a-z][a-z\s]{2,30})$/i.exec(oneLine(prompt))
  return match ? match[1].trim() : ''
}

/* ========================================================================== */
/*                                  大纲                                       */
/* ========================================================================== */

function pickZhPack(prompt) {
  const text = String(prompt ?? '')
  if (/复盘|回顾|总结|反思|季度|retro|retrospective|review/i.test(text)) {
    if (/ppt|html|页面|网页|载体|文档|链接|deck\s*换/i.test(text)) return ZH_RETRO_HTML
    if (/行动|计划|下一步|落地|执行|action|plan|next\s*step/i.test(text)) return ZH_RETRO_ACTION
    return ZH_RETRO_ACTION
  }
  if (/发布|上线|新品|首发|宣发|launch|release|unveil/i.test(text)) return ZH_LAUNCH
  return null
}

function normalizeOutlineSlides(seeds) {
  return (Array.isArray(seeds) ? seeds : []).map((seed) => {
    const recipe = RECIPE_SET.has(seed.recipe) ? seed.recipe : 'statement'
    const slide = {
      recipe,
      headline: clip(oneLine(seed.headline) || '未命名一幕', 24),
      points: compactPoints(seed.points).map((point) => clip(point, 40)).slice(0, 6),
      visual: seed.visual && typeof seed.visual === 'object' ? seed.visual : { kind: 'none' },
      notes: clip(oneLine(seed.notes) || '停顿一下，再翻页。', 60),
    }
    const lead = oneLine(seed.lead)
    if (lead !== '') slide.lead = clip(lead, 40)
    return slide
  })
}

/**
 * 一句话需求 → 可编辑大纲（与 OUTLINE_SYSTEM 的输出契约逐字段一致）。
 */
export function outline(payload = {}) {
  const lang = payload?.lang === 'en' ? 'en' : 'zh'
  const prompt = asText(payload?.prompt, '')
  const count = resolveSlideCount(payload)
  const includeSvg = payload?.includeSvg !== false
  const include3d = payload?.include3d !== false

  if (lang === 'en') {
    const built = genericEnSeeds(prompt, count, asText(payload?.audience, ''), resolveDuration(payload, 12))
    const slides = enforceVisualBudget(normalizeOutlineSlides(built.slides), includeSvg, include3d)
    return { title: built.title, subtitle: built.subtitle, lang, slides }
  }

  const minutes = resolveDuration(payload, 12)
  const pack = pickZhPack(prompt)
  let title
  let subtitle
  let seeds
  if (pack) {
    title = pack.title
    subtitle = zhSubtitle(audienceLabel(payload?.audience, 'zh') || pack.audience, pack.scene, minutes)
    seeds = arrangeSeeds(pack.slides, count, ZH_EXTRA)
  } else {
    const built = genericZhSeeds(prompt, count)
    const audience = audienceLabel(payload?.audience, 'zh') || '与会同事'
    title = built.title
    subtitle = zhSubtitle(audience, built.scene || '主题分享', minutes)
    seeds = built.slides
  }

  const slides = enforceVisualBudget(normalizeOutlineSlides(seeds), includeSvg, include3d)
  return { title: clip(title, 24), subtitle: clip(subtitle, 60), lang, slides }
}

/* ========================================================================== */
/*                                 单幕细化                                    */
/* ========================================================================== */

/** 各 recipe 的兜底要点（seed 没有可用 points 时用来补齐，避免占位符）。 */
const FALLBACK_POINTS_ZH = {
  cover: ['**场合**：主题分享现场', '**听众**：与会同事', '**目标**：散会后能复述一句结论'],
  statement: ['**依据**：来自本轮的三个具体事实', '**边界**：这一页只证明一件事', '**落点**：把判断交给下一幕'],
  split: ['**现状**：结论散落在三份文档里。', '**变化**：把它收进一个页面。', '**下一步**：给每条结论一个负责人。'],
  grid3: ['**问题**：谁在为哪件事付出成本。', '**变化**：今天之后，哪里不一样。', '**证据**：一个能被复述的细节。'],
  grid4: ['**用户**：谁真的会因此改变动作。', '**价值**：省下的是时间还是返工。', '**代价**：愿意为此放弃什么。', '**验证**：一周内能看哪个数。'],
  timeline: ['T-2 周｜对齐目标｜先统一一句话结论', 'T-0｜做出样板｜跑通最短的一条路径', 'T+3 天｜收反馈｜只问三个具体问题', 'T+2 周｜定下一步｜写进默认流程'],
  compare: ['现在｜靠人盯，靠记性', '现在｜问题到复盘时才暴露', '之后｜靠结构，靠默认流程', '之后｜问题在生成时就暴露'],
  quote: ['**场景**：主题分享现场', '**用法**：读完停两秒', '**别加话**：让这句话自己站住'],
  data: ['投入=100%', '产出=38%', '返工=22%'],
  process: ['01｜1 天｜先写一句能被反驳的结论', '02｜2 天｜把最强的一幕做成样板', '03｜半天｜找三个人来挑毛病', '04｜1 小时｜定下第一个动作和日期'],
  gallery: ['开场：一个具体的人和一个具体的问题', '中段：把结构摊开，指出关键的一层', '收尾：一个能立刻做的动作'],
  closing: ['**下一步**：把第一个动作写进日历', '**负责人**：现场认领，不指派', '**检查点**：一周后再看一次'],
}

const FALLBACK_POINTS_EN = {
  cover: ['**Occasion**: team session', '**Audience**: the people in the room', '**Goal**: one sentence they can repeat'],
  statement: ['**Basis**: three concrete facts from this round', '**Boundary**: this page proves one thing', '**Hand-off**: let the next slide carry it'],
  split: ['**Today**: conclusions live in three documents.', '**Change**: pull them into one page.', '**Next**: give every conclusion an owner.'],
  grid3: ['**Problem**: who pays, and for what.', '**Change**: what is different after today.', '**Proof**: one detail people can repeat.'],
  grid4: ['**User**: who actually changes behaviour.', '**Value**: time saved or rework avoided.', '**Cost**: what we are willing to give up.', '**Proof**: the number we check in a week.'],
  timeline: ['T-2 weeks｜Align｜Agree on one sentence first', 'T-0｜Prototype｜Run the shortest path end to end', 'T+3 days｜Feedback｜Ask only three questions', 'T+2 weeks｜Decide｜Write it into the default process'],
  compare: ['Today｜Depends on people and memory', 'Today｜Problems surface in the retro', 'After｜Depends on structure and defaults', 'After｜Problems surface while building'],
  quote: ['**Scene**: the team session', '**Delivery**: read it, then pause', '**Rule**: do not explain it away'],
  data: ['Input=100%', 'Output=38%', 'Rework=22%'],
  process: ['01｜1 day｜Write one conclusion that can be disproved', '02｜2 days｜Make the strongest moment run', '03｜Half day｜Ask three people to attack it', '04｜1 hour｜Fix the first action and its date'],
  gallery: ['Open: one person, one concrete problem', 'Middle: the structure, one layer at a time', 'Close: an action that starts tomorrow'],
  closing: ['**Next**: put the first action on a calendar', '**Owner**: claimed in the room, not assigned', '**Check**: one week later, look again'],
}

const DEFAULT_LEAD_ZH = {
  cover: '一场演示只带走一句话，这句话最好由你替听众说完。',
  statement: '把结论放在最前面，剩下的都是证据。',
  split: '左边讲判断，右边给证据。',
  grid3: '三条判断，每一条都能在下周被验证。',
  grid4: '四条判断，缺一条都别急着往下走。',
  timeline: '按时间走一遍，让每个节点都有名字。',
  compare: '把选择摆在桌面上，比列全选项更重要。',
  quote: '这一页只留一句话，让现场安静下来。',
  data: '先看数，再解释数。',
  process: '每一步都要有可验收的产出。',
  gallery: '三张画面，讲同一件事。',
  closing: '收尾只留一个动作。',
}

const DEFAULT_LEAD_EN = {
  cover: 'One sentence should leave the room with the audience.',
  statement: 'Put the conclusion first; everything else is evidence.',
  split: 'Judgement on the left, proof on the right.',
  grid3: 'Three questions, one conclusion.',
  grid4: 'Four judgements; skip one and the rest collapses.',
  timeline: 'Walk the timeline; name every node.',
  compare: 'Put the choice on the table, not the whole option list.',
  quote: 'One sentence only. Let the room go quiet.',
  data: 'Look at the number, then explain it.',
  process: 'Every step needs a deliverable you can check.',
  gallery: 'Three images, one story.',
  closing: 'One action, nothing else.',
}

const NOTES_ZH = {
  cover: ['开场别念标题，先抛一个反问，再看画面。', '先停三秒，等听众看完画面再开口。'],
  statement: ['这一页只讲一句，读完停两秒再翻页。', '放慢语速，让这句话先落地。'],
  split: ['左边讲判断，右边点一下最亮的位置。', '先讲三条里最扎心的那条。'],
  grid3: ['三张卡片各讲 30 秒，最后一句落到结论上。', '每张卡片只讲一个动作，不展开。'],
  grid4: ['这页快速过，每张卡片一句话。', '四条按顺序讲，最后一条留足时间。'],
  timeline: ['沿时间线从左到右，每个节点停 20 秒。', '重点讲最后一个节点。'],
  compare: ['先讲左边不丢人，再讲右边为什么更好。', '左右各讲两条，最后落在「之后」。'],
  quote: ['引用时放慢语速，不要补解释。', '读完这一句就翻页，让安静留久一点。'],
  data: ['先指最大的数，再解释它意味着什么。', '只讲一个数，其余留给提问。'],
  process: ['强调第一步，后面的步骤才立得住。', '每一步都问一句：产出是什么。'],
  gallery: ['三张图快速过，别逐张解释细节。', '让画面自己讲，你只报幕。'],
  closing: ['收尾给一个具体日期，把行动钉在日历上。', '让负责人当场点头，再下台。'],
}

const NOTES_EN = {
  cover: ['Do not read the title. Ask a question, then look at the visual.', 'Pause three seconds before you speak.'],
  statement: ['Read it once, then pause for two seconds.', 'Slow down and let the sentence land.'],
  split: ['Talk to the left, point at the brightest node on the right.', 'Lead with the point that stings most.'],
  grid3: ['One card per question, 30 seconds each.', 'One action per card; do not expand.'],
  grid4: ['Fast page: one line per card.', 'Give the last judgement extra time.'],
  timeline: ['Move left to right, 20 seconds per node.', 'Spend most of the time on the last node.'],
  compare: ['Do not dismiss the left side; explain what it costs.', 'Two per side, then land on “after”.'],
  quote: ['Slow down; do not explain it away.', 'Read it once, then turn the page.'],
  data: ['Point at the largest number, then say what it means.', 'Explain one number; leave the rest for questions.'],
  process: ['Stress step one; the rest depends on it.', 'Ask “what is the deliverable?” at every step.'],
  gallery: ['Move fast; do not explain every detail.', 'Let the images talk; you introduce them.'],
  closing: ['End with a date and an owner.', 'Get a nod in the room before you leave.'],
}

function slideLimits(lang) {
  return lang === 'en'
    ? { headline: 72, lead: 90, point: 90, notes: 120 }
    : { headline: 24, lead: 40, point: 40, notes: 60 }
}

function ensureSentence(point, lang) {
  const text = oneLine(point)
  if (text === '') return text
  if (/[。．.!！?？…"”』】）]$/u.test(text)) return text
  if (/[｜|]/u.test(text)) return text
  return lang === 'en' ? `${text}.` : `${text}。`
}

function cardPoints(seedPoints, count, lang) {
  const fallback = (lang === 'en' ? FALLBACK_POINTS_EN : FALLBACK_POINTS_ZH)[count === 4 ? 'grid4' : 'grid3']
  const parsed = []
  for (const raw of [...seedPoints, ...fallback]) {
    if (parsed.length >= count) break
    const bold = /^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/u.exec(oneLine(raw))
    let label = bold ? oneLine(bold[1]) : ''
    let body = bold ? oneLine(bold[2]) : ''
    if (!label) {
      const plain = /^([^：:]{1,12})\s*[：:]\s*(.+)$/u.exec(stripBold(raw))
      if (plain) {
        label = plain[1].trim()
        body = plain[2].trim()
      } else {
        body = stripBold(raw)
      }
    }
    if (body === '') continue
    if (label === '') {
      label = (lang === 'en' ? ['Context', 'Change', 'Proof', 'Cost'] : ['背景', '变化', '证据', '代价'])[parsed.length % 4]
    }
    parsed.push(`**${label}**${lang === 'en' ? ': ' : '：'}${ensureSentence(body, lang)}`)
  }
  return parsed.slice(0, count)
}

function dataPoints(seedPoints, lang) {
  const parsed = []
  for (const raw of [...seedPoints, ...FALLBACK_POINTS_DATA(lang)]) {
    const text = stripBold(raw)
    const match = /^(.+?)\s*[=＝]\s*([\d.]+)\s*(%?)$/u.exec(text)
    if (!match) continue
    const value = Number.parseFloat(match[2])
    if (!Number.isFinite(value)) continue
    const label = oneLine(match[1]).replace(/\s+/g, '')
    if (label === '') continue
    const point = `${label}=${match[2]}${match[3] || ''}`
    if (parsed.includes(point)) continue
    parsed.push(point)
    if (parsed.length >= 5) break
  }
  return parsed.length >= 2 ? parsed : FALLBACK_POINTS_DATA(lang)
}

function FALLBACK_POINTS_DATA(lang) {
  return lang === 'en' ? ['Input=100%', 'Output=38%', 'Rework=22%'] : ['投入=100%', '产出=38%', '返工=22%']
}

function timelinePoints(seedPoints, lang) {
  const fallback = (lang === 'en' ? FALLBACK_POINTS_EN : FALLBACK_POINTS_ZH).timeline
  const source = [...seedPoints, ...fallback]
  const times = lang === 'en'
    ? ['T-2 weeks', 'T-0', 'T+3 days', 'T+2 weeks', 'T+1 month']
    : ['T-2 周', 'T-0', 'T+3 天', 'T+2 周', 'T+1 个月']
  const out = []
  for (const raw of source) {
    if (out.length >= 5) break
    const parts = splitPipe(raw)
    let time
    let title
    let desc
    if (parts.length >= 3) {
      time = parts[0]
      title = parts[1]
      desc = parts.slice(2).join('｜')
    } else if (parts.length === 2) {
      time = times[out.length % times.length]
      title = parts[0]
      desc = parts[1]
    } else {
      time = times[out.length % times.length]
      title = clip(parts[0] ?? '', lang === 'en' ? 20 : 10)
      desc = lang === 'en' ? 'Keep it concrete and checkable.' : '先对齐口径，再往下推。'
    }
    const node = `${clip(time, 12)}｜${clip(title, lang === 'en' ? 22 : 12)}｜${clip(desc, lang === 'en' ? 40 : 22)}`
    if (!out.includes(node)) out.push(node)
  }
  return out.length >= 3 ? out : fallback
}

function processPoints(seedPoints, lang) {
  const fallback = (lang === 'en' ? FALLBACK_POINTS_EN : FALLBACK_POINTS_ZH).process
  const source = [...seedPoints, ...fallback]
  const durationsZh = ['30 分钟', '1 小时', '半天', '一天', '两天']
  const durationsEn = ['30 min', '1 hour', 'half a day', 'one day', 'two days']
  const out = []
  for (const raw of source) {
    if (out.length >= 5) break
    const parts = splitPipe(raw)
    let step
    let duration
    let desc
    if (parts.length >= 3) {
      step = parts[0]
      duration = parts[1]
      desc = parts.slice(2).join('｜')
    } else if (parts.length === 2) {
      step = parts[0]
      duration = (lang === 'en' ? durationsEn : durationsZh)[out.length % 5]
      desc = parts[1]
    } else {
      step = `0${out.length + 1}`
      duration = (lang === 'en' ? durationsEn : durationsZh)[out.length % 5]
      desc = parts[0] ?? ''
    }
    const point = `${clip(step, 8)}｜${clip(duration, lang === 'en' ? 14 : 8)}｜${clip(desc, lang === 'en' ? 42 : 22)}`
    if (!out.includes(point)) out.push(point)
  }
  return out.length >= 3 ? out : fallback
}

function comparePoints(seedPoints, lang) {
  const fallback = (lang === 'en' ? FALLBACK_POINTS_EN : FALLBACK_POINTS_ZH).compare
  const groups = new Map()
  const groupsOf = (raw) => {
    const parts = splitPipe(raw)
    if (parts.length >= 2) return { group: parts[0], body: parts.slice(1).join('｜') }
    return { group: '', body: stripBold(raw) }
  }
  for (const raw of seedPoints) {
    const { group, body } = groupsOf(raw)
    if (body === '') continue
    const key = group || (lang === 'en' ? 'Today' : '现在')
    const list = groups.get(key) ?? []
    if (list.length < 3) list.push(body)
    groups.set(key, list)
  }
  if (groups.size < 2) {
    const positives = (seedPoints.length > 0 ? seedPoints : fallback).map((raw) => stripBold(raw)).filter(Boolean)
    groups.clear()
    const left = lang === 'en' ? 'Today' : '现在'
    const right = lang === 'en' ? 'After' : '之后'
    const half = Math.max(1, Math.ceil(positives.length / 2))
    groups.set(left, positives.slice(0, half))
    groups.set(right, positives.slice(half).length > 0 ? positives.slice(half) : positives.slice(0, half))
  }
  const keys = Array.from(groups.keys()).slice(0, 2)
  const out = []
  for (const key of keys) {
    for (const body of groups.get(key) ?? []) {
      out.push(`${clip(key, lang === 'en' ? 18 : 8)}｜${clip(body, lang === 'en' ? 60 : 30)}`)
      if (out.length >= 6) break
    }
    if (out.length >= 6) break
  }
  while (out.length < 4) {
    const raw = fallback[out.length % fallback.length]
    if (!out.includes(raw)) out.push(raw)
    else break
  }
  return out
}

function splitPoints(seedPoints, lang) {
  const fallback = (lang === 'en' ? FALLBACK_POINTS_EN : FALLBACK_POINTS_ZH).split
  const source = [...seedPoints, ...fallback]
  const out = []
  for (const raw of source) {
    if (out.length >= 3) break
    const text = oneLine(raw)
    if (text === '') continue
    const point = ensureSentence(text, lang)
    if (!out.includes(point)) out.push(point)
  }
  return out.length >= 3 ? out : fallback
}

function galleryPoints(seedPoints, lang) {
  const fallback = (lang === 'en' ? FALLBACK_POINTS_EN : FALLBACK_POINTS_ZH).gallery
  const source = [...seedPoints, ...fallback]
  const out = []
  for (const raw of source) {
    if (out.length >= 3) break
    const text = oneLine(raw)
    if (text === '') continue
    if (!out.includes(text)) out.push(text)
  }
  return out.length >= 3 ? out : fallback
}

function metaPoints(recipe, ctx, lang) {
  const zh = lang !== 'en'
  const audienceText = audienceLabel(ctx.audience, zh ? 'zh' : 'en')
  const scene = clip(ctx.deckTitle || audienceText || (zh ? '主题分享' : 'the session'), zh ? 16 : 40)
  const audience = clip(audienceText || (zh ? '与会同事' : 'the team'), zh ? 12 : 32)
  if (recipe === 'cover') {
    return zh
      ? [`**主题**：${scene}`, `**听众**：${audience}`, '**目标**：散会后能复述一句结论']
      : [`**Topic**: ${scene}`, `**Audience**: ${audience}`, '**Goal**: one sentence they can repeat']
  }
  if (recipe === 'closing') {
    return zh
      ? ['**下一步**：把第一个动作写进日历', '**负责人**：现场认领，不指派', '**检查点**：一周后再看一次']
      : ['**Next**: put the first action on a calendar', '**Owner**: claimed in the room', '**Check**: look again one week later']
  }
  if (recipe === 'quote') {
    return zh
      ? [`**主题**：${scene}`, '**用法**：读完停两秒', '**别加话**：让这句话自己站住']
      : [`**Topic**: ${scene}`, '**Delivery**: read it, then pause', '**Rule**: do not explain it away']
  }
  return zh
    ? ['**依据**：来自本轮的三个具体事实', '**边界**：这一页只证明一件事', '**落点**：把判断交给下一幕']
    : ['**Basis**: three concrete facts from this round', '**Boundary**: this page proves one thing', '**Hand-off**: let the next slide carry it']
}

function buildSlidePoints(recipe, seedPoints, ctx, lang) {
  switch (recipe) {
    case 'grid3':
      return cardPoints(seedPoints, 3, lang)
    case 'grid4':
      return cardPoints(seedPoints, 4, lang)
    case 'data':
      return dataPoints(seedPoints, lang)
    case 'timeline':
      return timelinePoints(seedPoints, lang)
    case 'process':
      return processPoints(seedPoints, lang)
    case 'compare':
      return comparePoints(seedPoints, lang)
    case 'gallery':
      return galleryPoints(seedPoints, lang)
    case 'split':
      return splitPoints(seedPoints, lang)
    default:
      return metaPoints(recipe, ctx, lang)
  }
}

/** 把 brief（用户在生成中补的意图）真正写进产出，证明纠偏通道有效。 */
function applyBrief(content, brief, recipe, lang) {
  const text = oneLine(brief)
  if (text === '') return content
  const limit = slideLimits(lang)
  const briefText = clip(text, lang === 'en' ? 52 : 26)
  let { headline, lead, points, notes } = content

  if (recipe === 'data') {
    lead = clip(lang === 'en' ? `Re-cut around “${briefText}”. Illustrative only.` : `按「${briefText}」重新取数（示意）。`, limit.lead)
  } else if (recipe === 'compare') {
    const firstGroup = splitPipe(points[0] ?? '')[0] || (lang === 'en' ? 'Today' : '现在')
    const next = [...points]
    next.splice(Math.min(1, next.length), 0, clip(`${clip(firstGroup, 8)}｜${briefText}`, limit.point))
    points = next.slice(0, 6)
  } else if (recipe === 'timeline') {
    const next = [...points]
    next.splice(Math.min(1, next.length), 0, clip(`${lang === 'en' ? 'T+0' : 'T+0'}｜${lang === 'en' ? 'Brief' : '补充意图'}｜${briefText}`, limit.point))
    points = next.slice(0, 5)
  } else if (recipe === 'process') {
    const next = [...points]
    next.splice(Math.min(1, next.length), 0, clip(`${lang === 'en' ? 'Add' : '补充'}｜${lang === 'en' ? 'this page' : '本页'}｜${briefText}`, limit.point))
    points = next.slice(0, 5)
  } else {
    const next = [...points]
    next.splice(Math.min(1, next.length), 0, clip(`${lang === 'en' ? '**Brief**' : '**补充**'}：${briefText}`, limit.point))
    points = next.slice(0, 5)
  }

  notes = clip(`${notes}${lang === 'en' ? ' Note: ' : '｜补充：'}${briefText}`, limit.notes)
  return { headline, lead, points, notes }
}

/**
 * 把大纲里的一幕展开成可直接排版的文案（与 SLIDE_SYSTEM 的输出契约一致）。
 */
export function slide(payload = {}) {
  const lang = payload?.lang === 'en' ? 'en' : 'zh'
  const seed = payload?.slide && typeof payload.slide === 'object' ? payload.slide : {}
  const recipe = RECIPE_SET.has(seed.recipe) ? seed.recipe : 'statement'
  const limits = slideLimits(lang)
  const index = Number.isFinite(Number(payload?.index)) ? Math.max(0, Math.round(Number(payload.index))) : 0
  const total = Number.isFinite(Number(payload?.total)) ? Math.max(1, Math.round(Number(payload.total))) : 0
  const brief = oneLine(asText(payload?.brief, '') || asText(seed?.brief, ''))
  const ctx = {
    deckTitle: oneLine(asText(payload?.deckTitle, '')),
    audience: oneLine(asText(payload?.audience, '')),
    index,
    total,
    prompt: oneLine(asText(payload?.prompt, '')),
  }

  const seedHeadline = oneLine(asText(seed.headline, ''))
  const headline = clip(seedHeadline !== '' ? seedHeadline : ctx.deckTitle || (lang === 'en' ? 'This slide' : '这一幕'), limits.headline)

  const leadSource = oneLine(asText(seed.lead, ''))
  let lead = clip(leadSource !== '' ? leadSource : (lang === 'en' ? DEFAULT_LEAD_EN : DEFAULT_LEAD_ZH)[recipe] || '', limits.lead)

  const seedPoints = compactPoints(seed.points)
  let points = buildSlidePoints(recipe, seedPoints, ctx, lang).slice(0, 5)
  if (recipe === 'compare' && points.length < 4) points = comparePoints(seedPoints, lang)
  if (points.length === 0) points = (lang === 'en' ? FALLBACK_POINTS_EN : FALLBACK_POINTS_ZH)[recipe] ?? []

  const notesPool = (lang === 'en' ? NOTES_EN : NOTES_ZH)[recipe] ?? (lang === 'en' ? NOTES_EN.statement : NOTES_ZH.statement)
  let notes = clip(notesPool[(index + hash32(headline)) % notesPool.length], limits.notes)

  let content = { headline, lead, points, notes }
  content = applyBrief(content, brief, recipe, lang)

  return {
    headline: clip(content.headline, limits.headline),
    lead: clip(content.lead, limits.lead),
    points: content.points.map((point) => clip(point, limits.point)).slice(0, 8),
    notes: clip(content.notes, limits.notes),
  }
}

/* ========================================================================== */
/*                                SVG 插图                                     */
/* ========================================================================== */

const SVG_W = 820
const SVG_H = 560

function num(value) {
  return Math.round(value * 10) / 10
}

function svgDefs(seedKey) {
  const glow = `sim-glow-${seedKey}`
  const stroke = `sim-stroke-${seedKey}`
  const wash = `sim-wash-${seedKey}`
  return {
    ids: { glow, stroke, wash },
    markup: `<defs>
    <radialGradient id="${glow}" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="var(--d-accent)" stop-opacity="0.26"/>
      <stop offset="1" stop-color="var(--d-accent)" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${stroke}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--d-accent)" stop-opacity="0.9"/>
      <stop offset="1" stop-color="var(--d-accent2)" stop-opacity="0.25"/>
    </linearGradient>
    <linearGradient id="${wash}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--d-surface)" stop-opacity="0.9"/>
      <stop offset="1" stop-color="var(--d-accent2)" stop-opacity="0.06"/>
    </linearGradient>
  </defs>`,
  }
}

/** 构图 A：轨道（视觉中心 + 三圈轨道 + 卫星点 + 刻度）。 */
function svgOrbitArt(seedKey, rng) {
  const { ids, markup } = svgDefs(seedKey)
  const cx = 410
  const cy = 276
  const rings = [
    { rx: 252, ry: 176, token: 'line', width: 1.4, dash: '', opacity: 0.75 },
    { rx: 198, ry: 139, token: 'accent', width: 1.8, dash: ' stroke-dasharray="3 9"', opacity: 0.85 },
    { rx: 142, ry: 99, token: 'line', width: 1.4, dash: '', opacity: 0.9 },
  ]
  const ringPaths = rings
    .map(
      (ring) =>
        `<ellipse cx="${cx}" cy="${cy}" rx="${ring.rx}" ry="${ring.ry}" stroke="var(--d-${ring.token})" stroke-width="${ring.width}" opacity="${ring.opacity}"${ring.dash}/>`,
    )
    .join('\n  ')

  const ticks = []
  for (let index = 0; index < 24; index += 1) {
    const angle = (index / 24) * Math.PI * 2
    const inner = 262
    const outer = inner + (index % 6 === 0 ? 15 : 8)
    ticks.push(
      `<line x1="${num(cx + Math.cos(angle) * inner)}" y1="${num(cy + Math.sin(angle) * inner * 0.7)}" x2="${num(cx + Math.cos(angle) * outer)}" y2="${num(cy + Math.sin(angle) * outer * 0.7)}" stroke="var(--d-${index % 6 === 0 ? 'muted' : 'line'})" stroke-width="1.4" opacity="${index % 6 === 0 ? 0.85 : 0.5}"/>`,
    )
  }

  const satellites = []
  for (let index = 0; index < 6; index += 1) {
    const angle = (index / 6) * Math.PI * 2 + rng() * 0.6
    const radius = 152 + rng() * 90
    satellites.push(
      `<circle cx="${num(cx + Math.cos(angle) * radius)}" cy="${num(cy + Math.sin(angle) * radius * 0.7)}" r="${num(4 + rng() * 4)}" fill="var(--d-${index % 3 === 0 ? 'accent2' : 'accent'})" opacity="${num(0.45 + rng() * 0.4)}"/>`,
    )
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${SVG_H}" fill="none">
  ${markup}
  <circle cx="${cx}" cy="${cy}" r="246" fill="url(#${ids.glow})"/>
  ${ringPaths}
  <path d="M${cx - 252} ${cy}a252 176 0 0 1 504 0" stroke="url(#${ids.stroke})" stroke-width="2.6" stroke-linecap="round"/>
  <path d="M${cx - 142} ${cy - 6}a142 99 0 0 1 284 0" stroke="var(--d-accent2)" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>
  ${ticks.join('\n  ')}
  <circle cx="${cx}" cy="${cy}" r="46" fill="var(--d-surface)" stroke="var(--d-accent)" stroke-width="2" opacity="0.95"/>
  <circle cx="${cx}" cy="${cy}" r="13" fill="var(--d-accent)"/>
  <line x1="${cx - 46}" y1="${cy + 46}" x2="${cx + 46}" y2="${cy + 46}" stroke="var(--d-line)" stroke-width="1.4" opacity="0.7"/>
  ${satellites.join('\n  ')}
  <line x1="168" y1="472" x2="424" y2="472" stroke="var(--d-muted)" stroke-width="1.6" stroke-linecap="round" opacity="0.8"/>
  <line x1="168" y1="464" x2="168" y2="480" stroke="var(--d-muted)" stroke-width="1.4" opacity="0.7"/>
  <line x1="424" y1="464" x2="424" y2="480" stroke="var(--d-muted)" stroke-width="1.4" opacity="0.7"/>
</svg>`
}

/** 构图 B：层叠（视觉中心在顶层亮面 + 透视基座 + 上升轴线）。 */
function svgStrataArt(seedKey, rng) {
  const { ids, markup } = svgDefs(seedKey)
  const plates = []
  const plateCount = 4
  for (let index = 0; index < plateCount; index += 1) {
    const x = 214 + index * 36
    const y = 402 - index * 74
    const w = 336 - index * 16
    const top = index === plateCount - 1
    plates.push(
      `<rect x="${x}" y="${y}" width="${w}" height="52" rx="10" stroke="var(--d-${top ? 'accent' : index === 0 ? 'muted' : 'line'})" stroke-width="${top ? 2.2 : 1.5}" fill="${top ? `url(#${ids.wash})` : 'none'}" opacity="${num(0.72 + index * 0.07)}"/>`,
    )
  }
  // 左侧是一条虚线轴，每层板用一条水平引导线接上去（比散落的刻度更有秩序）。
  const guides = []
  for (let index = 0; index < plateCount; index += 1) {
    const y = 402 - index * 74 + 26
    const x = 214 + index * 36
    guides.push(
      `<line x1="176" y1="${y}" x2="${x - 10}" y2="${y}" stroke="var(--d-${index === plateCount - 1 ? 'accent2' : 'line'})" stroke-width="1.4" opacity="${index === plateCount - 1 ? 0.8 : 0.5}"/>`,
    )
  }
  const topX = 214 + (plateCount - 1) * 36
  const topY = 402 - (plateCount - 1) * 74
  const topW = 336 - (plateCount - 1) * 16
  const arrowX = 626
  const arrowTop = 168
  const ticks = []
  for (let index = 0; index < 4; index += 1) {
    const y = 300 + index * 46
    ticks.push(
      `<line x1="${arrowX - 18}" y1="${y}" x2="${arrowX - (index % 2 === 0 ? 34 : 26)}" y2="${y}" stroke="var(--d-${index === 1 ? 'accent2' : 'muted'})" stroke-width="1.4" opacity="${index === 1 ? 0.9 : 0.5}"/>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${SVG_H}" fill="none">
  ${markup}
  <circle cx="${num(topX + topW * 0.62)}" cy="${num(topY - 34)}" r="132" fill="url(#${ids.glow})"/>
  <ellipse cx="410" cy="466" rx="246" ry="40" stroke="var(--d-line)" stroke-width="1.4" opacity="0.65"/>
  ${plates.join('\n  ')}
  ${guides.join('\n  ')}
  <line x1="${topX}" y1="${topY}" x2="${topX + topW}" y2="${topY}" stroke="var(--d-accent)" stroke-width="2.6" stroke-linecap="round"/>
  <line x1="${topX + topW - 30}" y1="${topY}" x2="${topX + topW - 30}" y2="${topY - 30}" stroke="var(--d-accent2)" stroke-width="1.6" opacity="0.8"/>
  <circle cx="${num(topX + topW * 0.62)}" cy="${num(topY - 34)}" r="26" stroke="var(--d-accent2)" stroke-width="1.8" opacity="0.9"/>
  <circle cx="${num(topX + topW * 0.62)}" cy="${num(topY - 34)}" r="9" fill="var(--d-accent)"/>
  <path d="M${arrowX} 430C${arrowX + 46} 360 ${arrowX + 40} 246 ${arrowX - 4} ${arrowTop}" stroke="url(#${ids.stroke})" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M${arrowX - 16} ${arrowTop + 18}l12-20 14 18" stroke="var(--d-accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  ${ticks.join('\n  ')}
  <line x1="170" y1="158" x2="170" y2="452" stroke="var(--d-line)" stroke-width="1.4" stroke-dasharray="6 8" opacity="0.7"/>
</svg>`
}

/** 构图 C：流动（视觉中心在双波交汇处 + 渐变底 + 基线刻度）。 */
function svgFlowArt(seedKey, rng) {
  const { ids, markup } = svgDefs(seedKey)
  const phase = num(rng() * 24)
  const waves = [
    `<path d="M112 214C${num(220 + phase)} ${num(150 - phase)} ${num(320)} 300 428 268S${num(620)} 196 ${num(708)} 236" stroke="var(--d-line)" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>`,
    `<path d="M112 292C${num(236 - phase)} 348 ${num(344)} 214 452 264S${num(636)} 336 ${num(708)} 300" stroke="url(#${ids.stroke})" stroke-width="2.8" stroke-linecap="round"/>`,
    `<path d="M112 368C${num(226)} 314 ${num(330 + phase)} 404 438 372S${num(620)} 322 ${num(708)} 356" stroke="var(--d-accent2)" stroke-width="1.8" stroke-linecap="round" opacity="0.65" stroke-dasharray="4 10"/>`,
  ]
  const ticks = []
  for (let index = 0; index < 5; index += 1) {
    ticks.push(
      `<line x1="${num(112 + index * 149)}" y1="466" x2="${num(112 + index * 149)}" y2="${num(index % 2 === 0 ? 484 : 476)}" stroke="var(--d-${index === 2 ? 'accent' : 'line'})" stroke-width="1.4" opacity="${index === 2 ? 0.9 : 0.55}"/>`,
    )
  }
  const satellites = []
  for (let index = 0; index < 4; index += 1) {
    const x = 190 + index * 148 + rng() * 18
    const y = 226 + rng() * 128
    satellites.push(
      `<circle cx="${num(x)}" cy="${num(y)}" r="${num(3.4 + rng() * 3)}" fill="var(--d-${index % 2 === 0 ? 'accent2' : 'accent'})" opacity="${num(0.4 + rng() * 0.45)}"/>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${SVG_H}" fill="none">
  ${markup}
  <rect x="108" y="86" width="604" height="386" rx="18" fill="url(#${ids.wash})" opacity="0.9"/>
  ${waves.join('\n  ')}
  <line x1="108" y1="466" x2="712" y2="466" stroke="var(--d-line)" stroke-width="1.6" opacity="0.8"/>
  ${ticks.join('\n  ')}
  <line x1="470" y1="272" x2="470" y2="466" stroke="var(--d-muted)" stroke-width="1.4" stroke-dasharray="4 9" opacity="0.6"/>
  <circle cx="470" cy="272" r="58" stroke="var(--d-accent2)" stroke-width="1.4" opacity="0.55"/>
  <circle cx="470" cy="272" r="36" stroke="var(--d-accent)" stroke-width="1.8" opacity="0.9"/>
  <circle cx="470" cy="272" r="10" fill="var(--d-accent)"/>
  ${satellites.join('\n  ')}
  <line x1="108" y1="112" x2="208" y2="112" stroke="var(--d-accent2)" stroke-width="1.6" stroke-linecap="round" opacity="0.8"/>
  <line x1="108" y1="126" x2="170" y2="126" stroke="var(--d-muted)" stroke-width="1.4" stroke-linecap="round" opacity="0.6"/>
</svg>`
}

/**
 * 一句话画面描述 → 一张可直接嵌入的矢量插图（严格落在 sanitize 白名单内）。
 */
export function svg(payload = {}) {
  const prompt = oneLine(asText(payload?.prompt, ''))
  const style = oneLine(asText(payload?.style, '')).toLowerCase()
  const seedNum = hash32(`${prompt}::${style}`)
  const seedKey = seedNum.toString(36).slice(0, 6)
  const rng = seededRandom(seedNum)

  const signal = `${style} ${prompt}`
  let kind
  if (/orbit|轨道|环|轮|周期|循环/.test(signal)) kind = 0
  else if (/grid|网格|结构|层|叠|stack|台阶|增长|上升/.test(signal)) kind = 1
  else if (/wave|波|流|趋势|曲线|脉络|时间/.test(signal)) kind = 2
  else kind = seedNum % 3

  const source = kind === 1 ? svgStrataArt(seedKey, rng) : kind === 2 ? svgFlowArt(seedKey, rng) : svgOrbitArt(seedKey, rng)
  const caption = clip(prompt !== '' ? prompt : '这张图只说明一件事：结构与取舍。', 30)
  return { svg: source, viewBox: [0, 0, SVG_W, SVG_H], caption }
}

/* ========================================================================== */
/*                              3D 场景                                       */
/* ========================================================================== */

const THREE_SHAPES = ['box', 'sphere', 'torus', 'torusKnot', 'cone', 'cylinder', 'octa', 'plane', 'icosa']

function presetFor(theme, seed) {
  const pool =
    theme === 'tech'
      ? ['orbit', 'globe', 'torus', 'wave-field']
      : theme === 'launch'
        ? ['showcase', 'orbit', 'torus']
        : theme === 'retro'
          ? ['stack', 'orbit', 'wave-field']
          : theme === 'course'
            ? ['showcase', 'globe', 'stack']
            : ['orbit', 'showcase', 'torus', 'globe', 'wave-field']
  return pool[seed % pool.length]
}

/**
 * 一句话描述 → 受限的 three.js 场景描述符（通过 threeDescriptorSchema）。
 */
export function three(payload = {}) {
  const prompt = oneLine(asText(payload?.prompt, ''))
  const seedNum = hash32(`${prompt}::3d`)
  const rng = seededRandom(seedNum)
  const theme = detectTheme(prompt)
  const preset = presetFor(theme, seedNum)

  const mainShape =
    preset === 'globe'
      ? 'sphere'
      : preset === 'torus'
        ? 'torusKnot'
        : preset === 'stack'
          ? 'box'
          : preset === 'wave-field'
            ? 'box'
            : preset === 'showcase'
              ? pick(rng, ['icosa', 'octa', 'torus'])
              : 'torus'
  const mainScale = num(1.24 + rng() * 0.5)
  const metal = num(0.4 + rng() * 0.4)
  const rough = num(0.12 + rng() * 0.3)

  const objects = [
    {
      shape: mainShape,
      material: preset === 'showcase' ? 'physical' : 'standard',
      tint: 'accent',
      scale: mainScale,
      pos: [0, 0, 0],
      rot: [num(0.28 + rng() * 0.2), num(0.36 + rng() * 0.24), 0],
      metalness: num(0.5 + rng() * 0.3),
      roughness: rough,
    },
  ]

  const auxCount = 2 + Math.floor(rng() * 3)
  const tints = ['accent2', 'muted', 'accent2', 'fg']
  for (let index = 0; index < auxCount; index += 1) {
    const angle = (index / Math.max(auxCount, 1)) * Math.PI * 2 + rng() * 0.5
    const radius = num(1.5 + rng() * 0.9)
    objects.push({
      shape: pick(rng, ['box', 'sphere', 'octa', 'cone', 'cylinder']),
      material: index === 0 ? 'physical' : 'standard',
      tint: tints[index % tints.length],
      scale: num(0.22 + rng() * 0.32),
      pos: [num(Math.cos(angle) * radius), num((rng() - 0.5) * 1.1), num(Math.sin(angle) * radius)],
      rot: [num(rng() * 0.6), num(rng() * 0.6), 0],
      metalness: metal,
      roughness: num(0.2 + rng() * 0.4),
    })
  }

  const motionKind = preset === 'wave-field' ? 'float' : preset === 'particle-cloud' ? 'pulse' : 'rotate'
  const light = theme === 'launch' ? 'studio' : theme === 'tech' ? 'neon' : theme === 'retro' ? 'soft' : 'studio'
  const palette = theme === 'tech' ? 'mono' : theme === 'retro' ? 'duotone' : 'accent'

  return {
    descriptor: {
      preset,
      palette,
      light,
      bg: 'transparent',
      camera: {
        distance: num(6.2 + rng() * 1.8),
        elevation: num(0.16 + rng() * 0.24),
        fov: Math.round(38 + rng() * 10),
      },
      motion: { kind: motionKind, speed: num(0.24 + rng() * 0.32) },
      objects: objects.slice(0, 6),
      grain: num(0.02 + rng() * 0.05),
      orbitControls: false,
    },
  }
}

/* ========================================================================== */
/*                                 微调                                       */
/* ========================================================================== */

const REFINE_HEADLINE_EN = {
  cover: ['One conclusion, delivered', 'A single idea worth the room'],
  statement: ['One sentence, one decision', 'Say less. Land more.'],
  split: ['Judgement on the left, proof on the right', 'Two columns, one argument'],
  grid3: ['Three judgements that need a decision', 'Three cards, one conclusion'],
  grid4: ['Four points, no filler', 'Four judgements, one decision'],
  timeline: ['How the work lands, step by step', 'The timeline, without the noise'],
  compare: ['Two ways forward. Pick one.', 'The trade-off, made explicit'],
  quote: ['One sentence to remember', 'A line the room can repeat'],
  data: ['The numbers behind the change', 'Three figures that frame it'],
  process: ['Four steps, four deliverables', 'The process, made checkable'],
  gallery: ['Three images, one story', 'One story, three frames'],
  closing: ['One action. One date.', 'The next step, made concrete'],
}

const REFINE_LEAD_EN = {
  cover: 'Same content, sharper delivery.',
  statement: 'Keep the judgement; drop the decoration.',
  split: 'The argument stays; the wording gets tighter.',
  grid3: 'Three points, each with one verifiable detail.',
  grid4: 'Four judgements; nothing decorative.',
  timeline: 'Each node has a time, a name and a proof.',
  compare: 'Both sides stay; the choice becomes obvious.',
  quote: 'Same line, fewer words around it.',
  data: 'Same figures, clearer emphasis.',
  process: 'Every step ends with something you can check.',
  gallery: 'Same scenes, quieter captions.',
  closing: 'One action, one owner, one date.',
}

const REFINE_POINTS_EN = {
  cover: ['**Occasion**: the team session', '**Audience**: the people in the room', '**Goal**: one sentence they can repeat'],
  statement: ['**Basis**: three facts from this round', '**Boundary**: one claim only', '**Hand-off**: the next slide carries it'],
  split: ['**Today**: conclusions live in three files', '**Change**: one page, one link', '**Next**: an owner for every conclusion'],
  grid3: ['**Problem**: who pays, and for what', '**Change**: what differs after today', '**Proof**: one repeatable detail'],
  grid4: ['**User**: who changes behaviour', '**Value**: time saved or rework avoided', '**Cost**: what we give up', '**Proof**: the number we check'],
  timeline: ['T-2 weeks｜Align｜One sentence first', 'T-0｜Build｜Shortest path end to end', 'T+3 days｜Check｜Only three questions', 'T+2 weeks｜Decide｜Write it into the process'],
  compare: ['Today｜Depends on people and memory', 'Today｜Problems surface late', 'After｜Depends on structure and defaults', 'After｜Problems surface early'],
  quote: ['**Scene**: the retro room', '**Delivery**: read, then pause', '**Rule**: do not explain it'],
  data: ['Input=100%', 'Output=38%', 'Rework=22%'],
  process: ['01｜30 min｜Write one disprovable conclusion', '02｜1 day｜Make the strongest moment run', '03｜Half day｜Ask three people to attack it', '04｜1 hour｜Fix the action and the date'],
  gallery: ['Open: one person, one problem', 'Middle: the structure, one layer', 'Close: an action for tomorrow'],
  closing: ['**Next**: put the action on a calendar', '**Owner**: claimed in the room', '**Check**: one week later'],
}

/** 数字是核心信息：翻译时原样保留下来。 */
function extractNumbers(text) {
  const matches = String(text ?? '').match(/\d+(?:\.\d+)?%?/g) ?? []
  return Array.from(new Set(matches)).slice(0, 3)
}

function englishRewrite(payload) {
  const recipe = RECIPE_SET.has(payload?.recipe) ? payload.recipe : 'statement'
  const baseHeadline = oneLine(asText(payload?.headline, ''))
  const basePoints = compactPoints(payload?.points)
  const numbers = extractNumbers(`${baseHeadline} ${basePoints.join(' ')}`)
  const headlines = REFINE_HEADLINE_EN[recipe] ?? REFINE_HEADLINE_EN.statement
  const points = (REFINE_POINTS_EN[recipe] ?? REFINE_POINTS_EN.statement).slice(0, 4)
  let lead = REFINE_LEAD_EN[recipe] ?? REFINE_LEAD_EN.statement
  if (numbers.length > 0) lead = clip(`${lead} Key figures: ${numbers.join(', ')}.`, 90)
  return {
    headline: clip(headlines[hash32(baseHeadline) % headlines.length], 60),
    lead,
    points,
  }
}

function chineseRewrite(payload) {
  const recipe = RECIPE_SET.has(payload?.recipe) ? payload.recipe : 'statement'
  const fallback = (FALLBACK_POINTS_ZH[recipe] ?? FALLBACK_POINTS_ZH.statement).slice(0, 3)
  const baseHeadline = oneLine(asText(payload?.headline, ''))
  const numbers = extractNumbers(`${baseHeadline} ${compactPoints(payload?.points).join(' ')}`)
  const headline = clip(baseHeadline !== '' ? `${clip(baseHeadline, 16)}` : '这一页只讲一件事', 24)
  const lead = clip(numbers.length > 0 ? `核心数字：${numbers.join('、')}。` : '保留原意，只换说法。', 40)
  return { headline, lead, points: fallback }
}

function toShorter(points, lang) {
  const limit = lang === 'en' ? 56 : 20
  return points.slice(0, 5).map((point) => clip(stripBold(point), limit))
}

function toTimeline(points, lang, headline) {
  const timesZh = ['T-2 周', 'T+0', 'T+3 天', 'T+2 周', 'T+1 个月']
  const timesEn = ['T-2 weeks', 'T+0', 'T+3 days', 'T+2 weeks', 'T+1 month']
  const times = lang === 'en' ? timesEn : timesZh
  const nodes = []
  points.slice(0, 5).forEach((point, index) => {
    const parts = splitPipe(point)
    let title
    let desc
    if (parts.length >= 3) {
      title = parts[1]
      desc = parts.slice(2).join('｜')
    } else if (parts.length === 2) {
      title = parts[0]
      desc = parts[1]
    } else {
      const colon = stripBold(point).split(/[：:]/)
      title = colon.length > 1 ? colon[0] : clip(stripBold(point), lang === 'en' ? 24 : 12)
      desc = colon.length > 1 ? colon.slice(1).join('：') : lang === 'en' ? 'Make it checkable.' : '写成可验收的动作。'
    }
    nodes.push(
      `${times[index % times.length]}｜${clip(title, lang === 'en' ? 26 : 12)}｜${clip(desc, lang === 'en' ? 48 : 24)}`,
    )
  })
  const headlineOut = clip(headline || (lang === 'en' ? 'How it lands, step by step' : '一路怎么走，四个节点'), lang === 'en' ? 60 : 24)
  return { headline: headlineOut, lead: lang === 'en' ? 'Each node: a time, a name, a proof.' : '每个节点都有时间、名字和证据。', points: nodes }
}

function toProcess(points, lang, headline) {
  const durationsZh = ['30 分钟', '1 小时', '半天', '一天', '两天']
  const durationsEn = ['30 min', '1 hour', 'half a day', 'one day', 'two days']
  const durations = lang === 'en' ? durationsEn : durationsZh
  const steps = []
  points.slice(0, 5).forEach((point, index) => {
    const parts = splitPipe(point)
    let title
    let desc
    if (parts.length >= 3) {
      title = parts[1]
      desc = parts.slice(2).join('｜')
    } else if (parts.length === 2) {
      title = parts[0]
      desc = parts[1]
    } else {
      const colon = stripBold(point).split(/[：:]/)
      title = colon.length > 1 ? colon[0] : clip(stripBold(point), lang === 'en' ? 24 : 12)
      desc = colon.length > 1 ? colon.slice(1).join('：') : lang === 'en' ? 'One checkable output.' : '一个可验收的产出。'
    }
    steps.push(`0${index + 1}｜${durations[index % durations.length]}｜${clip(`${title}：${desc}`, lang === 'en' ? 56 : 26)}`)
  })
  const headlineOut = clip(headline || (lang === 'en' ? 'Four steps, four deliverables' : '四步推进，每步可验收'), lang === 'en' ? 60 : 24)
  return { headline: headlineOut, lead: lang === 'en' ? 'Every step has a check.' : '每一步都要有可验收的产出。', points: steps }
}

function toCompare(points, lang, headline) {
  const existing = comparePoints(points, lang)
  const paired = existing.some((point) => splitPipe(point).length >= 2)
  const out = paired
    ? existing
    : [...existing.map((point) => `${lang === 'en' ? 'Today' : '现在'}｜${stripBold(point)}`), ...existing.map((point) => `${lang === 'en' ? 'After' : '之后'}｜${stripBold(point)}`)].slice(0, 6)
  return {
    headline: clip(headline || (lang === 'en' ? 'Two ways forward. Pick one.' : '两种做法，只能选一个'), lang === 'en' ? 60 : 24),
    lead: lang === 'en' ? 'The trade-off, made explicit.' : '把取舍摆到桌面上。',
    points: out,
  }
}

function toQuieter(points, lang, headline, lead) {
  const calm = points.slice(0, 2).map((point) => stripBold(point).replace(/[！!]/g, '。'))
  const calmPoints = calm.length >= 2 ? calm : [lang === 'en' ? 'One point, said once.' : '一个判断，说一次。']
  const headlineOut = clip(String(headline ?? '').replace(/[！!]/g, ''), lang === 'en' ? 60 : 24)
  const leadOut = clip(oneLine(lead) || calmPoints[0], lang === 'en' ? 70 : 30)
  return { headline: headlineOut || (lang === 'en' ? 'Quieter, not emptier' : '少一点，但不空'), lead: leadOut, points: calmPoints }
}

function toUnknown(points, lang, headline, lead) {
  const stripped = points.map((point) => stripBold(point)).filter(Boolean)
  const headlineOut = clip(headline || (lang === 'en' ? 'One page, one argument' : '这一页只讲一个判断'), lang === 'en' ? 60 : 24)
  const leadOut = clip(
    stripped.length > 0
      ? `${lang === 'en' ? 'The core is: ' : '核心是：'}${clip(stripped[0], lang === 'en' ? 56 : 30)}`
      : oneLine(lead) || (lang === 'en' ? 'Same facts, tighter framing.' : '事实不变，换一种讲法。'),
    lang === 'en' ? 80 : 38,
  )
  const polished = stripped.slice(0, 4).map((point) => clip(point, lang === 'en' ? 70 : 32))
  const padded =
    polished.length >= 3
      ? polished
      : [...polished, ...(lang === 'en' ? REFINE_POINTS_EN.statement : FALLBACK_POINTS_ZH.statement)].slice(0, 3)
  return { headline: headlineOut, lead: leadOut, points: padded }
}

/**
 * 一条自然语言指令 → 重写后的当前幕文案（与 REFINE_SYSTEM 输出契约一致）。
 */
export function refine(payload = {}) {
  const instruction = oneLine(asText(payload?.instruction, ''))
  const headline = oneLine(asText(payload?.headline, ''))
  const lead = oneLine(asText(payload?.lead, ''))
  const points = compactPoints(payload?.points)
  const sourceLang = payload?.lang === 'en' ? 'en' : 'zh'
  const askEnglish = /英文|英语|english|translate\s+to\s+en/i.test(instruction)
  const askChinese = !askEnglish && /中文|汉语|chinese/i.test(instruction)
  const targetLang = askEnglish ? 'en' : askChinese ? 'zh' : sourceLang

  const shorter = /短|精简|压缩|太长|收紧|压缩|short|shorter|tight|trim/i.test(instruction)
  const timeline = /时间轴|时间线|timeline/i.test(instruction)
  const process = !timeline && /流程|步骤|process|steps?\b/i.test(instruction)
  const compare = /对比|比较|compare|versus|\bvs\b/i.test(instruction)
  const quieter = /安静|克制|简洁|清爽|少一点|calm|quiet|minimal|cleaner|less\s+busy/i.test(instruction)

  if (targetLang !== sourceLang) {
    if (targetLang === 'en') return englishRewrite({ recipe: payload?.recipe, headline, lead, points })
    return chineseRewrite({ recipe: payload?.recipe, headline, points })
  }

  if (timeline) return toTimeline(points.length > 0 ? points : [headline], targetLang, headline)
  if (process) return toProcess(points.length > 0 ? points : [headline], targetLang, headline)
  if (compare) return toCompare(points.length > 0 ? points : [headline], targetLang, headline)
  if (shorter) {
    const result = {
      headline: clip(headline, targetLang === 'en' ? 48 : 24),
      lead: clip(lead, targetLang === 'en' ? 60 : 28),
      points: toShorter(points, targetLang),
    }
    if (result.points.length < 3) result.points = [...result.points, ...(targetLang === 'en' ? REFINE_POINTS_EN.statement : FALLBACK_POINTS_ZH.statement).slice(0, 3 - result.points.length)].slice(0, 3)
    return result
  }
  if (quieter) return toQuieter(points, targetLang, headline, lead)
  return toUnknown(points, targetLang, headline, lead)
}

export default { outline, slide, svg, three, refine }
