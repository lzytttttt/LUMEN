/**
 * corpus.ts —— Mock 通道的语料库（离线首屏体验的一部分）。
 *
 * 设计：
 * - 先按关键词识别四种意图：产品发布 / 技术方案 / 课程讲解 / 项目复盘；
 * - 每种意图各有一套中文与英文语料，按 `length` + `durationMin` 取 6/9/12 幕；
 * - 文案遵守大纲契约：标题有观点、每幕 3–5 个信息单元、备注是讲者提示；
 * - 一切选择都由 `seedFrom(prompt)` 决定，同题同稿。
 */
import type { Outline, OutlineSlide, RecipeId, ThreePreset } from '@/schema/deck'
import { outlineSchema } from '@/schema/deck'
import { seedFrom, seededRandom } from '@/schema/ids'

export type MockIntent = 'launch' | 'plan' | 'course' | 'retro'
export type MockLength = 'short' | 'normal' | 'deep'

export interface MockOutlineInput {
  prompt: string
  lang: 'zh' | 'en'
  audience?: string
  length?: MockLength
  durationMin?: number
  includeSvg?: boolean
  include3d?: boolean
}

interface Seed {
  recipe: RecipeId
  headline: string
  lead?: string
  points?: string[]
  visual?: OutlineSlide['visual']
  notes?: string
  /** 1 = 必留，2 = 常规，3 = 深讲才留。 */
  weight: 1 | 2 | 3
}

interface PackCtx {
  topic: string
  audience: string
  includeSvg: boolean
  include3d: boolean
}

type Pack = (ctx: PackCtx) => Seed[]

/* ------------------------------- 意图与主题 ------------------------------- */

const INTENT_RULES: { intent: MockIntent; re: RegExp }[] = [
  { intent: 'launch', re: /发布|上线|新品|产品|宣发|launch|release|unveil|product\s*(launch|intro)|announce/i },
  { intent: 'retro', re: /复盘|回顾|总结|反思|事故|季度|retro|retrospective|postmortem|review|lessons?\s*learned/i },
  { intent: 'course', re: /课程|讲解|教学|培训|入门|上课|lesson|course|teach|tutorial|training|workshop|class/i },
  { intent: 'plan', re: /方案|架构|技术|规划|设计|提案|评审|plan|architecture|proposal|design|tech|roadmap/i },
]

export function detectIntent(prompt: string): MockIntent {
  for (const rule of INTENT_RULES) if (rule.re.test(prompt)) return rule.intent
  return 'plan'
}

function clampChars(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/** 从一句话里提炼主题（去掉"给我讲讲/帮我做一份"这类壳）。 */
export function topicOf(prompt: string, lang: 'zh' | 'en'): string {
  let text = prompt.replace(/\s+/g, ' ').trim()
  if (text === '') return lang === 'zh' ? '这次分享' : 'This talk'
  if (lang === 'zh') {
    text = text
      .replace(/^(请|麻烦|帮我|帮忙|我想|我想要|我想做|我需要|需要|来|做|写|生成|准备|讲讲|聊一聊)\s*/u, '')
      .replace(/^(给|为|向|和|跟)[^，,。；;:：]{1,18}?(讲|说|分享|介绍|汇报|做|写)(一次|一场|一个|一份|一下)?[，,：:]?/u, '')
      .replace(/[。.!！?？]+$/u, '')
      .trim()
  } else {
    text = text
      .replace(/^(please\s+)?(help\s+me\s+)?(write|draft|make|prepare|create|give)\s+(a|an|the)?\s*/i, '')
      .replace(/^(talk|presentation|deck|slides?)\s+(about|on)\s+/i, '')
      .replace(/[.!?]+$/u, '')
      .trim()
  }
  const clause = text.split(/[，,。；;\n]/u)[0]?.trim() ?? ''
  const candidate = Array.from(clause).length >= 4 ? clause : text
  return clampChars(candidate, lang === 'zh' ? 22 : 48)
}

/* --------------------------------- 中文语料 --------------------------------- */

const zhLaunch: Pack = (ctx) => [
  {
    recipe: 'cover',
    headline: ctx.topic,
    lead: '一次发布，不是介绍功能，而是交付一个能被记住的瞬间。',
    visual: ctx.include3d ? { kind: 'three', preset: 'orbit' } : { kind: 'none' },
    notes: '开场先不念标题，直接给一句结论，留三秒让听众看画面。',
    weight: 1,
  },
  {
    recipe: 'statement',
    headline: '功能会被忘记，\n场景会被复述。',
    lead: '所以发布会只讲三件事：谁的问题、什么变化、下一步做什么。',
    notes: '这一页只留一句话，语速放慢，读完停两秒再翻。',
    weight: 1,
  },
  {
    recipe: 'split',
    headline: '先给画面，再给参数',
    lead: '把抽象的「能力」换成一个能看懂的场景。',
    points: [
      '**旧方式**：先讲架构，让听众自己拼出价值。',
      '**新方式**：先放结果，再解释它是怎么来的。',
      '**差别**：一个需要耐心，一个只要三秒。',
    ],
    visual: ctx.includeSvg
      ? { kind: 'svg', brief: '一条被拉长的胶片，末端变成一块亮起的屏幕' }
      : { kind: 'none' },
    notes: '手指着右边那张图讲：从旧载体到新载体，只差一次「跑起来」。',
    weight: ctx.includeSvg ? 1 : 3,
  },
  {
    recipe: 'grid3',
    headline: '发布会只需要三张牌',
    points: [
      '**问题**：谁在为什么付钱。',
      '**变化**：今天之后，哪里不一样。',
      '**证据**：一个能被复述的细节。',
    ],
    notes: '三张牌对应听众的三个疑问，一张牌讲 40 秒，不要展开技术细节。',
    weight: 1,
  },
  {
    recipe: 'timeline',
    headline: '从想法到上台，四个节点',
    points: [
      'T-8 周｜定叙事｜先定一句话，再定功能表',
      'T-6 周｜做样板｜把最关键的一幕做成能跑的原型',
      'T-2 周｜压时长｜砍掉三分之一的内容',
      'T-0｜上台｜只留一个动作给听众',
    ],
    notes: '讲到「压时长」停一下：砍掉的内容，才是发布会的品味。',
    weight: 2,
  },
  {
    recipe: 'data',
    headline: '记住率不靠信息量',
    lead: '同一份内容，换一种载体（示意数据）',
    points: ['纯文字=10%', '图文=35%', '动图=65%', '可交互=90%'],
    notes: '只讲结论，不要念数字；这页的任务是让听众自己得出「换载体」的结论。',
    weight: 2,
  },
  {
    recipe: 'compare',
    headline: '发布页 / 可运行的演示',
    points: [
      '幻灯片｜静态排版，改一页要重排',
      '幻灯片｜线性翻页，观众只能跟',
      '作品｜改一处，全篇更新',
      '作品｜可交互，观众自己看',
    ],
    notes: '让听众自己选：你更想交出去哪一种？',
    weight: 2,
  },
  {
    recipe: 'process',
    headline: '现场演示的四步节奏',
    points: [
      '开场｜30 秒｜先给结论',
      '问题｜90 秒｜用一个真实场景',
      '演示｜3 分钟｜只演一条主路径',
      '收尾｜30 秒｜给一个明确动作',
    ],
    notes: '演示环节只走一条主路径，其余功能留给 Q&A。',
    weight: 2,
  },
  {
    recipe: 'quote',
    headline: '把页面交出去，\n还是把体验交出去？',
    lead: 'LUMEN 设计原则 · P6 同一渲染器',
    notes: '情绪转折页，读完停两秒再翻。',
    weight: 3,
  },
  {
    recipe: 'grid4',
    headline: '听众离场时带走的四句话',
    points: ['这件事和我有关。', '它今天就能用。', '它比现在省一半力。', '我回去先做这一步。'],
    notes: '四句话是听众的转述版本，比任何 slogan 都重要。',
    weight: 3,
  },
  {
    recipe: 'gallery',
    headline: '三种画面，同一套叙事',
    points: ['开场：一个被拉长的瞬间', '中段：把结构摊开', '收尾：留一个动作'],
    notes: '画面只做记忆锚点，不承载信息量。',
    weight: 3,
  },
  {
    recipe: 'closing',
    headline: '下一步，只有一件事',
    lead: '把你最强的一幕，做成能跑的东西。',
    notes: '收尾给一个明确动作：现在就去试一次。',
    weight: 1,
  },
]

const zhPlan: Pack = (ctx) => [
  {
    recipe: 'cover',
    headline: ctx.topic,
    lead: '一份方案的说服力，不在篇幅，在可验证性。',
    visual: ctx.include3d ? { kind: 'three', preset: 'stack' } : { kind: 'none' },
    notes: '开场给结论：这份方案要验证的是哪一条假设。',
    weight: 1,
  },
  {
    recipe: 'statement',
    headline: '方案的价值不在完整，\n在能被验证。',
    lead: '先讲清楚约束与代价，再谈架构与排期。',
    notes: '先定评审标准，再讲内容，避免陷入细节争论。',
    weight: 1,
  },
  {
    recipe: 'split',
    headline: '先画约束，再画架构',
    lead: '约束决定形状，架构只是结果。',
    points: [
      '**边界**：必须做什么，明确不做什么。',
      '**代价**：每个选择要付什么。',
      '**验证**：怎么证明它成立。',
    ],
    visual: ctx.includeSvg
      ? { kind: 'svg', brief: '一张被切成三段的结构图，中间一段高亮' }
      : { kind: 'none' },
    notes: '重点讲「明确不做」，这是评审最容易被追问的地方。',
    weight: ctx.includeSvg ? 1 : 3,
  },
  {
    recipe: 'grid3',
    headline: '评审会上真正被问的三件事',
    points: [
      '**为什么现在做**：不做会怎样。',
      '**为什么这样做**：别的方案差在哪。',
      '**怎么知道成了**：指标与验证方式。',
    ],
    notes: '三件事按顺序讲，最后一件必须有数字。',
    weight: 1,
  },
  {
    recipe: 'process',
    headline: '落地路径：四个里程碑',
    points: [
      'M1｜打通主链路｜先让一条路径跑通',
      'M2｜补齐边界｜异常与回滚',
      'M3｜灰度验证｜真实流量下的小步试错',
      'M4｜全面切换｜旧路径下线',
    ],
    notes: '里程碑只讲交付物与验收条件，不讲人力。',
    weight: 2,
  },
  {
    recipe: 'timeline',
    headline: '三个月的取舍',
    points: [
      '第 1 月｜定型｜锁定接口与数据契约',
      '第 2 月｜实现｜主链路与监控',
      '第 3 月｜验证｜灰度与压测',
    ],
    notes: '讲清「第 1 月不定型会怎样」，比讲排期更有说服力。',
    weight: 2,
  },
  {
    recipe: 'data',
    headline: '成本结构：大头在维护',
    lead: '首版只占两成，其余都在长期维护（示意数据）',
    points: ['首版开发=20%', '联调与测试=25%', '长期维护=55%'],
    notes: '这页回答「为什么不能省掉抽象层」。',
    weight: 2,
  },
  {
    recipe: 'compare',
    headline: '现在的做法 / 方案里的做法',
    points: [
      '现在｜每次改动都要重排版',
      '现在｜问题只能靠人盯',
      '方案｜改一处，全篇更新',
      '方案｜问题在检查阶段暴露',
    ],
    notes: '左右对照讲，每边只讲两点，避免变成功能清单。',
    weight: 2,
  },
  {
    recipe: 'quote',
    headline: '复杂度不会消失，\n只会转移到别人看不见的地方。',
    lead: '设计取舍 · 约束优先',
    notes: '这一页是全场情绪最高点，读完停两秒。',
    weight: 3,
  },
  {
    recipe: 'grid4',
    headline: '四个风险与对策',
    points: [
      '**接口漂移**：先定契约再写实现。',
      '**性能回退**：把预算写进流水线。',
      '**迁移中断**：双写加灰度。',
      '**认知负担**：一个入口，一条主路径。',
    ],
    notes: '风险页不要只列风险，每条都要有对策。',
    weight: 3,
  },
  {
    recipe: 'gallery',
    headline: '三种形态，同一份结构',
    points: ['骨架：链路怎么走', '剖面：数据怎么流', '现场：用户看到什么'],
    notes: '三张图分别是架构图、时序图、界面图，讲的时候只指一处。',
    weight: 3,
  },
  {
    recipe: 'closing',
    headline: '下一步：先验证最贵的那条假设',
    lead: '把不确定的地方，做成一个一周能跑完的实验。',
    notes: '收尾落在动作上：谁、什么时候、交什么。',
    weight: 1,
  },
]

const zhCourse: Pack = (ctx) => [
  {
    recipe: 'cover',
    headline: ctx.topic,
    lead: '一节课只解决一个问题，其余都是练习。',
    visual: ctx.include3d ? { kind: 'three', preset: 'showcase' } : { kind: 'none' },
    notes: '开场先给结果：这节课结束时，你能做出什么。',
    weight: 1,
  },
  {
    recipe: 'statement',
    headline: '先建立直觉，\n再补细节。',
    lead: '直觉对了，细节才有地方挂。',
    notes: '不要一上来讲定义，先给一个能看懂的类比。',
    weight: 1,
  },
  {
    recipe: 'split',
    headline: '一张图讲清整条链路',
    lead: '先看全貌，再逐个部件拆。',
    points: [
      '**输入**：你手里有什么。',
      '**过程**：中间发生了什么。',
      '**输出**：怎么判断做对了。',
    ],
    visual: ctx.includeSvg
      ? { kind: 'svg', brief: '一条从左到右的链路，中间有三个节点' }
      : { kind: 'none' },
    notes: '这张图会在课里出现三次，每次多讲一层细节。',
    weight: ctx.includeSvg ? 1 : 3,
  },
  {
    recipe: 'grid3',
    headline: '这节课只解决三个问题',
    points: [
      '**是什么**：一句话定义。',
      '**为什么**：它解决了谁的痛。',
      '**怎么用**：一个最小可运行例子。',
    ],
    notes: '把三个问题写在白板上，讲完一个划掉一个。',
    weight: 1,
  },
  {
    recipe: 'process',
    headline: '四步练习法',
    points: [
      '看｜5 分钟｜先看一遍完整结果',
      '拆｜10 分钟｜把步骤拆成清单',
      '做｜20 分钟｜自己跑一遍',
      '讲｜5 分钟｜用自己的话复述',
    ],
    notes: '练习环节老师只答疑，不动手代做。',
    weight: 2,
  },
  {
    recipe: 'timeline',
    headline: '四周学习路径',
    points: [
      '第 1 周｜建立直觉｜先跑通，再理解',
      '第 2 周｜拆解原理｜每个部件单独练',
      '第 3 周｜组合应用｜做一个小项目',
      '第 4 周｜复盘输出｜写一篇讲解',
    ],
    notes: '每周只设一个可验收的产出。',
    weight: 2,
  },
  {
    recipe: 'data',
    headline: '记住的比例',
    lead: '不同学习方式的内容留存（示意数据）',
    points: ['听讲=5%', '阅读=10%', '练习=60%', '教别人=90%'],
    notes: '这页用来解释为什么课上有大量练习。',
    weight: 2,
  },
  {
    recipe: 'compare',
    headline: '看懂 / 做出来',
    points: [
      '看懂｜跟着走，不卡壳',
      '看懂｜换个场景就断',
      '做出来｜能自己拆步骤',
      '做出来｜能解释为什么',
    ],
    notes: '让学员举手：你现在停在哪一边？',
    weight: 2,
  },
  {
    recipe: 'quote',
    headline: '听懂不等于会做，\n会做不等于讲得清。',
    lead: '课堂原则 · 输出倒逼输入',
    notes: '这是本课的价值观，后面每次练习都回到这句话。',
    weight: 3,
  },
  {
    recipe: 'grid4',
    headline: '课后自测四问',
    points: ['我能一句话定义它吗？', '我能画出它的链路吗？', '我能举一个反例吗？', '我能教会别人吗？'],
    notes: '四问贴在课程群公告里，作为作业标准。',
    weight: 3,
  },
  {
    recipe: 'gallery',
    headline: '三种讲法，同一条链路',
    points: ['先看结果', '再拆步骤', '最后给反例'],
    notes: '三种讲法对应三种学习者：视觉型、步骤型、怀疑型。',
    weight: 3,
  },
  {
    recipe: 'closing',
    headline: '现在，动手做第一个最小例子',
    lead: '把「我知道了」换成「我做出来了」。',
    notes: '结束前留 5 分钟，让所有人跑通第一个例子。',
    weight: 1,
  },
]

const zhRetro: Pack = (ctx) => [
  {
    recipe: 'cover',
    headline: ctx.topic,
    lead: '复盘不是追责，是把经验变成资产。',
    visual: ctx.include3d ? { kind: 'three', preset: 'globe' } : { kind: 'none' },
    notes: '开场先定基调：只谈事实与判断，不谈人。',
    weight: 1,
  },
  {
    recipe: 'statement',
    headline: '复盘不是追责，\n是把经验变成资产。',
    lead: '只谈事实与判断，不谈人。',
    notes: '这句话要写在白板上，全程可见。',
    weight: 1,
  },
  {
    recipe: 'split',
    headline: '把时间线摊开，问题自己会浮出来',
    lead: '先对齐事实，再讨论判断。',
    points: [
      '**事实**：什么时候发生了什么。',
      '**判断**：当时我们以为是什么。',
      '**偏差**：实际发生了什么。',
    ],
    visual: ctx.includeSvg
      ? { kind: 'svg', brief: '一条时间线，三个节点上标着当时的判断' }
      : { kind: 'none' },
    notes: '先把事实写满，任何人不得在这一步评价。',
    weight: ctx.includeSvg ? 1 : 3,
  },
  {
    recipe: 'grid3',
    headline: '三个必须回答的问题',
    points: [
      '**哪里做对了**：要能被复制。',
      '**哪里做错了**：要能被识别。',
      '**下次怎么做**：要能被执行。',
    ],
    notes: '三个问题按顺序回答，不允许跳到最后一步。',
    weight: 1,
  },
  {
    recipe: 'timeline',
    headline: '关键节点与当时的判断',
    points: [
      '立项｜我们以为需求已经很清楚了',
      '第一次延期｜我们选择加人',
      '上线｜问题在真实流量下暴露',
      '一周后｜回滚并重写核心链路',
    ],
    notes: '每个节点只讲「当时怎么想」，不讲「后来才知道」。',
    weight: 2,
  },
  {
    recipe: 'data',
    headline: '时间都花在哪',
    lead: '项目时间分布（示意数据）',
    points: ['沟通对齐=40%', '返工重做=30%', '真正实现=30%'],
    notes: '这页是全场最容易被讨论的一页，留足时间。',
    weight: 2,
  },
  {
    recipe: 'compare',
    headline: '当时以为 / 实际发生',
    points: [
      '以为｜需求一次就能讲清',
      '以为｜加人能提速',
      '实际｜需求改了三轮',
      '实际｜加人先增加了沟通成本',
    ],
    notes: '左右对照读，读完问一句：下一次怎么提前发现？',
    weight: 2,
  },
  {
    recipe: 'process',
    headline: '把结论变成下一次的动作',
    points: [
      '写下来｜24 小时内｜一页纸结论',
      '定归属｜本周内｜谁负责哪一条',
      '进流程｜下个迭代｜写进检查清单',
      '再验证｜下个项目｜看指标有没有变',
    ],
    notes: '没有归属人的结论，等于没写。',
    weight: 2,
  },
  {
    recipe: 'quote',
    headline: '真正的成本，\n是同一个坑踩第二次。',
    lead: '复盘原则 · 经验要能被检索',
    notes: '情绪页，读完停两秒。',
    weight: 3,
  },
  {
    recipe: 'grid4',
    headline: '四条可复用的经验',
    points: ['先定验收，再定排期。', '不确定性先做实验。', '沟通成本随人数增长。', '每次延期都要改计划。'],
    notes: '四条经验要能直接贴进下个项目的启动文档。',
    weight: 3,
  },
  {
    recipe: 'gallery',
    headline: '三种证据，同一段经历',
    points: ['时间线', '数据', '当时的决策记录'],
    notes: '证据页不讲故事，只摆材料。',
    weight: 3,
  },
  {
    recipe: 'closing',
    headline: '把这一页，变成下个项目的检查清单',
    lead: '复盘的价值，在下一次被用上。',
    notes: '收尾确认：谁负责把清单放进模板。',
    weight: 1,
  },
]

/* --------------------------------- 英文语料 --------------------------------- */

const enLaunch: Pack = (ctx) => [
  {
    recipe: 'cover',
    headline: ctx.topic,
    lead: 'A launch is not a feature list. It is one moment people remember.',
    visual: ctx.include3d ? { kind: 'three', preset: 'orbit' } : { kind: 'none' },
    notes: 'Do not read the title. Land one sentence, then let the visual breathe.',
    weight: 1,
  },
  {
    recipe: 'statement',
    headline: 'Features are forgotten.\nScenes get retold.',
    lead: 'So a launch says three things: whose problem, what changes, what is next.',
    notes: 'One line only. Slow down, hold three seconds.',
    weight: 1,
  },
  {
    recipe: 'split',
    headline: 'Show the moment, then the spec',
    lead: 'Trade an abstract capability for a scene anyone can picture.',
    points: [
      '**Old way**: start with architecture, let the room assemble the value.',
      '**New way**: show the result, then explain how it got there.',
      '**The gap**: one needs patience, the other needs three seconds.',
    ],
    visual: ctx.includeSvg
      ? { kind: 'svg', brief: 'A film strip stretched until its last frame becomes a lit screen' }
      : { kind: 'none' },
    notes: 'Point at the artwork: the only difference is that one of them runs.',
    weight: ctx.includeSvg ? 1 : 3,
  },
  {
    recipe: 'grid3',
    headline: 'A launch needs three cards',
    points: [
      '**Problem**: who pays, and for what.',
      '**Change**: what is different after today.',
      '**Proof**: one detail people can repeat.',
    ],
    notes: 'One card answers one question. Forty seconds each, no architecture.',
    weight: 1,
  },
  {
    recipe: 'timeline',
    headline: 'Four checkpoints from idea to stage',
    points: [
      'T-8w｜Story｜One sentence before any feature list',
      'T-6w｜Prototype｜Make the key moment runnable',
      'T-2w｜Cut｜Remove a third of the content',
      'T-0｜Stage｜Leave the room one action',
    ],
    notes: 'Pause on "cut": what you remove is the taste of the launch.',
    weight: 2,
  },
  {
    recipe: 'data',
    headline: 'Recall is not about volume',
    lead: 'Same content, different medium (illustrative)',
    points: ['Text only=10%', 'Text + image=35%', 'Motion=65%', 'Interactive=90%'],
    notes: 'Never read the numbers. Let the shape make the argument.',
    weight: 2,
  },
  {
    recipe: 'compare',
    headline: 'A launch page / A running artifact',
    points: [
      'Slides｜Static layout, every edit a rebuild',
      'Slides｜Linear flipping, no exploration',
      'Artifact｜Edit once, update everywhere',
      'Artifact｜Interactive, the audience looks around',
    ],
    notes: 'Let the room choose which one they would rather hand over.',
    weight: 2,
  },
  {
    recipe: 'process',
    headline: 'Four beats for the live demo',
    points: [
      'Open｜30s｜Conclusion first',
      'Problem｜90s｜One real scene',
      'Demo｜3min｜One main path only',
      'Close｜30s｜One concrete action',
    ],
    notes: 'One path only. Everything else belongs to Q&A.',
    weight: 2,
  },
  {
    recipe: 'quote',
    headline: 'Hand over a page,\nor hand over an experience?',
    lead: 'LUMEN design principle · P6 One renderer',
    notes: 'The emotional turn. Read it, hold two beats, advance.',
    weight: 3,
  },
  {
    recipe: 'grid4',
    headline: 'Four sentences people leave with',
    points: ['This is about me.', 'I can use it today.', 'It saves me half the work.', 'I know my first step.'],
    notes: 'These are the sentences the audience will repeat.',
    weight: 3,
  },
  {
    recipe: 'gallery',
    headline: 'Three images, one story',
    points: ['Open: one stretched moment', 'Middle: the structure laid out', 'Close: one action left'],
    notes: 'Images are anchors, not information.',
    weight: 3,
  },
  {
    recipe: 'closing',
    headline: 'One next step, nothing else',
    lead: 'Make your strongest moment something that runs.',
    notes: 'Close with one concrete action: try it right now.',
    weight: 1,
  },
]

const enPlan: Pack = (ctx) => [
  {
    recipe: 'cover',
    headline: ctx.topic,
    lead: 'A proposal earns trust by being verifiable, not by being long.',
    visual: ctx.include3d ? { kind: 'three', preset: 'stack' } : { kind: 'none' },
    notes: 'Open with the hypothesis this proposal exists to test.',
    weight: 1,
  },
  {
    recipe: 'statement',
    headline: 'A plan is not valuable because\nit is complete — because it is testable.',
    lead: 'Constraints and costs first; architecture and schedule second.',
    notes: 'Set the review criteria before the content.',
    weight: 1,
  },
  {
    recipe: 'split',
    headline: 'Draw the constraints before the architecture',
    lead: 'Constraints decide the shape; architecture is the consequence.',
    points: [
      '**Boundary**: what we must do, and what we refuse to do.',
      '**Cost**: what each choice takes from us.',
      '**Proof**: how we will know it works.',
    ],
    visual: ctx.includeSvg
      ? { kind: 'svg', brief: 'A structure split into three bands, the middle one highlighted' }
      : { kind: 'none' },
    notes: 'Spend the most time on "refuse to do". That is where reviews push.',
    weight: ctx.includeSvg ? 1 : 3,
  },
  {
    recipe: 'grid3',
    headline: 'Three questions every review asks',
    points: [
      '**Why now**: what breaks if we wait.',
      '**Why this way**: where the alternatives fail.',
      '**How we know**: the metric and the test.',
    ],
    notes: 'Answer in order. The third one needs a number.',
    weight: 1,
  },
  {
    recipe: 'process',
    headline: 'Four milestones to production',
    points: [
      'M1｜Main path｜Make one route run end to end',
      'M2｜Edges｜Failures and rollback',
      'M3｜Canary｜Small bets on real traffic',
      'M4｜Cutover｜Retire the old path',
    ],
    notes: 'Milestones describe deliverables and acceptance, never headcount.',
    weight: 2,
  },
  {
    recipe: 'timeline',
    headline: 'Three months of tradeoffs',
    points: [
      'Month 1｜Freeze｜Lock interfaces and data contracts',
      'Month 2｜Build｜Main path and monitoring',
      'Month 3｜Prove｜Canary and load tests',
    ],
    notes: 'Explain what happens if month one does not freeze. That sells the plan.',
    weight: 2,
  },
  {
    recipe: 'data',
    headline: 'Most of the cost is maintenance',
    lead: 'The first version is a fifth of the bill (illustrative)',
    points: ['First build=20%', 'Integration & tests=25%', 'Maintenance=55%'],
    notes: 'This is the slide that justifies the abstraction layer.',
    weight: 2,
  },
  {
    recipe: 'compare',
    headline: 'Today / With this plan',
    points: [
      'Today｜Every edit means a rebuild',
      'Today｜Problems are caught by people',
      'Plan｜Edit once, update everywhere',
      'Plan｜Problems surface in checks',
    ],
    notes: 'Two points per side. Do not let this become a feature list.',
    weight: 2,
  },
  {
    recipe: 'quote',
    headline: 'Complexity does not disappear.\nIt moves where nobody looks.',
    lead: 'Design tradeoffs · constraints first',
    notes: 'The high point of the talk. Hold two beats.',
    weight: 3,
  },
  {
    recipe: 'grid4',
    headline: 'Four risks and their answers',
    points: [
      '**Interface drift**: contracts before code.',
      '**Perf regression**: budgets in the pipeline.',
      '**Broken migration**: dual write and canary.',
      '**Cognitive load**: one entry, one main path.',
    ],
    notes: 'Never list a risk without its answer.',
    weight: 3,
  },
  {
    recipe: 'gallery',
    headline: 'Three views of one structure',
    points: ['Skeleton: how it flows', 'Section: how data moves', 'Surface: what users see'],
    notes: 'Architecture, sequence, interface. Point at one thing per image.',
    weight: 3,
  },
  {
    recipe: 'closing',
    headline: 'Next: test the most expensive assumption',
    lead: 'Turn the uncertainty into a one-week experiment.',
    notes: 'End on who does what, by when.',
    weight: 1,
  },
]

const enCourse: Pack = (ctx) => [
  {
    recipe: 'cover',
    headline: ctx.topic,
    lead: 'One lesson solves one problem. Everything else is practice.',
    visual: ctx.include3d ? { kind: 'three', preset: 'showcase' } : { kind: 'none' },
    notes: 'Start with the outcome: what can they build by the end?',
    weight: 1,
  },
  {
    recipe: 'statement',
    headline: 'Build the intuition first.\nDetails have somewhere to hang.',
    lead: 'Once the intuition is right, details stick.',
    notes: 'Never open with a definition. Open with an analogy.',
    weight: 1,
  },
  {
    recipe: 'split',
    headline: 'One diagram for the whole pipeline',
    lead: 'See the shape first, then take it apart.',
    points: [
      '**Input**: what you already have.',
      '**Process**: what happens in between.',
      '**Output**: how you know it worked.',
    ],
    visual: ctx.includeSvg
      ? { kind: 'svg', brief: 'A left-to-right pipeline with three nodes in the middle' }
      : { kind: 'none' },
    notes: 'This diagram returns three times, each time with one more layer.',
    weight: ctx.includeSvg ? 1 : 3,
  },
  {
    recipe: 'grid3',
    headline: 'Three questions this lesson answers',
    points: [
      '**What**: one sentence of definition.',
      '**Why**: whose pain it removes.',
      '**How**: one minimal running example.',
    ],
    notes: 'Write the three questions on the board; cross one out as you go.',
    weight: 1,
  },
  {
    recipe: 'process',
    headline: 'A four-step practice loop',
    points: [
      'Watch｜5 min｜See the finished result',
      'Split｜10 min｜Turn it into a checklist',
      'Do｜20 min｜Run it yourself',
      'Teach｜5 min｜Explain it in your words',
    ],
    notes: 'During practice, answer questions — never take over the keyboard.',
    weight: 2,
  },
  {
    recipe: 'timeline',
    headline: 'A four-week path',
    points: [
      'Week 1｜Intuition｜Make it run, then understand',
      'Week 2｜Parts｜Practise each piece alone',
      'Week 3｜Compose｜Build one small project',
      'Week 4｜Teach｜Write an explanation',
    ],
    notes: 'One verifiable output per week, nothing more.',
    weight: 2,
  },
  {
    recipe: 'data',
    headline: 'What actually sticks',
    lead: 'Retention by learning mode (illustrative)',
    points: ['Lecture=5%', 'Reading=10%', 'Practice=60%', 'Teaching=90%'],
    notes: 'This explains why the lesson is mostly practice.',
    weight: 2,
  },
  {
    recipe: 'compare',
    headline: 'Understand / Produce',
    points: [
      'Understand｜You can follow along',
      'Understand｜A new case breaks it',
      'Produce｜You can split the steps',
      'Produce｜You can explain why',
    ],
    notes: 'Ask for a show of hands: which side are you on?',
    weight: 2,
  },
  {
    recipe: 'quote',
    headline: 'Following is not doing.\nDoing is not teaching.',
    lead: 'Class principle · output forces input',
    notes: 'Every practice returns to this sentence.',
    weight: 3,
  },
  {
    recipe: 'grid4',
    headline: 'Four self-checks after class',
    points: ['Can I define it in one line?', 'Can I draw the pipeline?', 'Can I give a counterexample?', 'Can I teach it?'],
    notes: 'These four questions are the homework rubric.',
    weight: 3,
  },
  {
    recipe: 'gallery',
    headline: 'Three ways to explain one pipeline',
    points: ['Start with the result', 'Then split the steps', 'End with a counterexample'],
    notes: 'Three learners: visual, sequential, sceptical.',
    weight: 3,
  },
  {
    recipe: 'closing',
    headline: 'Build your first minimal example now',
    lead: 'Trade "I get it" for "I built it".',
    notes: 'Leave five minutes so everyone finishes example one.',
    weight: 1,
  },
]

const enRetro: Pack = (ctx) => [
  {
    recipe: 'cover',
    headline: ctx.topic,
    lead: 'A retro is not a trial. It turns experience into an asset.',
    visual: ctx.include3d ? { kind: 'three', preset: 'globe' } : { kind: 'none' },
    notes: 'Set the tone: facts and decisions, never people.',
    weight: 1,
  },
  {
    recipe: 'statement',
    headline: 'A retro is not a trial.\nIt turns experience into an asset.',
    lead: 'Facts and decisions only. No names.',
    notes: 'Write this on the board and keep it visible.',
    weight: 1,
  },
  {
    recipe: 'split',
    headline: 'Lay out the timeline and the problems surface',
    lead: 'Align on facts before discussing judgement.',
    points: [
      '**Fact**: what happened, and when.',
      '**Belief**: what we thought it meant.',
      '**Gap**: what actually happened.',
    ],
    visual: ctx.includeSvg
      ? { kind: 'svg', brief: 'A timeline with three nodes, each labelled with the belief of that moment' }
      : { kind: 'none' },
    notes: 'Fill the facts first. Nobody evaluates during this step.',
    weight: ctx.includeSvg ? 1 : 3,
  },
  {
    recipe: 'grid3',
    headline: 'Three questions we must answer',
    points: [
      '**What worked**: make it repeatable.',
      '**What failed**: make it detectable.',
      '**What next**: make it executable.',
    ],
    notes: 'Answer in order. Skipping to the last one is how retros fail.',
    weight: 1,
  },
  {
    recipe: 'timeline',
    headline: 'Key moments and what we believed',
    points: [
      'Kickoff｜We thought the requirements were clear',
      'First slip｜We added people',
      'Launch｜Real traffic found the problem',
      'One week later｜Rolled back and rewrote the core',
    ],
    notes: 'Only the belief of that moment — not what we know now.',
    weight: 2,
  },
  {
    recipe: 'data',
    headline: 'Where the time went',
    lead: 'Time distribution across the project (illustrative)',
    points: ['Alignment=40%', 'Rework=30%', 'Actual build=30%'],
    notes: 'This page always starts the best discussion. Leave room.',
    weight: 2,
  },
  {
    recipe: 'compare',
    headline: 'What we believed / What happened',
    points: [
      'Believed｜Requirements land in one pass',
      'Believed｜More people means faster',
      'Happened｜Requirements changed three times',
      'Happened｜More people meant more talking',
    ],
    notes: 'Read both sides, then ask: how would we catch this earlier?',
    weight: 2,
  },
  {
    recipe: 'process',
    headline: 'Turn conclusions into next actions',
    points: [
      'Write｜24h｜One page of conclusions',
      'Assign｜This week｜One owner per item',
      'Embed｜Next sprint｜Add to the checklist',
      'Verify｜Next project｜Did the metric move?',
    ],
    notes: 'A conclusion without an owner was never written.',
    weight: 2,
  },
  {
    recipe: 'quote',
    headline: 'The real cost is\nfalling into the same hole twice.',
    lead: 'Retro principle · experience must be searchable',
    notes: 'The emotional page. Hold two beats.',
    weight: 3,
  },
  {
    recipe: 'grid4',
    headline: 'Four reusable lessons',
    points: [
      'Acceptance criteria before dates.',
      'Experiment before you commit.',
      'Communication cost grows with the team.',
      'Every slip changes the plan, not just the date.',
    ],
    notes: 'These four belong in the next kickoff document.',
    weight: 3,
  },
  {
    recipe: 'gallery',
    headline: 'Three kinds of evidence, one story',
    points: ['The timeline', 'The numbers', 'The decisions we wrote down'],
    notes: 'Evidence pages do not tell stories. They show material.',
    weight: 3,
  },
  {
    recipe: 'closing',
    headline: 'Turn this page into the next checklist',
    lead: 'A retro only counts when it is used next time.',
    notes: 'Close by naming who puts the checklist into the template.',
    weight: 1,
  },
]

const PACKS: Record<'zh' | 'en', Record<MockIntent, Pack>> = {
  zh: { launch: zhLaunch, plan: zhPlan, course: zhCourse, retro: zhRetro },
  en: { launch: enLaunch, plan: enPlan, course: enCourse, retro: enRetro },
}

/* --------------------------------- 幕数选择 --------------------------------- */

function targetCount(length: MockLength, durationMin?: number): number {
  const base = length === 'short' ? 6 : length === 'deep' ? 12 : 9
  if (!durationMin || !Number.isFinite(durationMin)) return base
  if (durationMin <= 5) return Math.max(5, base - 2)
  if (durationMin >= 20) return Math.min(14, base + 2)
  return base
}

/** 保首尾、按 weight 取中间幕，保证 SVG / 3D 幕在常规篇幅里一定出现。 */
function selectSeeds(seeds: Seed[], target: number): Seed[] {
  if (seeds.length <= target) return seeds
  const first = seeds[0]
  const last = seeds[seeds.length - 1]
  const middle = seeds.slice(1, -1)
  const budget = Math.max(1, target - 2)
  const chosen = new Set<Seed>()
  const byWeight = [...middle].sort((a, b) => a.weight - b.weight)
  for (const seed of byWeight) {
    if (chosen.size >= budget) break
    chosen.add(seed)
  }
  for (const seed of middle) {
    if (chosen.size >= budget) break
    chosen.add(seed)
  }
  const ordered = middle.filter((seed) => chosen.has(seed))
  return [first, ...ordered, last]
}

const DEFAULT_PRESETS: ThreePreset[] = ['orbit', 'showcase', 'wave-field', 'globe', 'stack', 'torus']

/** Mock 大纲：确定性、可直接编辑、已满足契约。 */
export function mockOutline(input: MockOutlineInput): Outline {
  const lang = input.lang
  const intent = detectIntent(input.prompt)
  const topic = topicOf(input.prompt, lang)
  const audience = input.audience?.trim() || (lang === 'zh' ? '在场的同事' : 'the room')
  const ctx: PackCtx = {
    topic,
    audience,
    includeSvg: input.includeSvg !== false,
    include3d: input.include3d !== false,
  }
  const seeds = selectSeeds(PACKS[lang][intent](ctx), targetCount(input.length ?? 'normal', input.durationMin))
  const rng = seededRandom(seedFrom(input.prompt))

  const slides: OutlineSlide[] = seeds.map((seed) => {
    const visual = seed.visual ?? { kind: 'none' as const }
    const withPreset =
      visual.kind === 'three' && !visual.preset
        ? { kind: 'three' as const, preset: DEFAULT_PRESETS[Math.floor(rng() * DEFAULT_PRESETS.length)] }
        : visual
    return {
      recipe: seed.recipe,
      headline: seed.headline,
      lead: seed.lead,
      points: seed.points ?? [],
      visual: withPreset,
      notes: seed.notes,
    }
  })

  const subtitle =
    lang === 'zh'
      ? `${intentLabel(intent, lang)} · ${slides.length} 幕 · ${audience}`
      : `${intentLabel(intent, lang)} · ${slides.length} slides · ${audience}`

  return outlineSchema.parse({ title: topic, subtitle, lang, slides })
}

export function intentLabel(intent: MockIntent, lang: 'zh' | 'en'): string {
  const zh: Record<MockIntent, string> = { launch: '产品发布', plan: '技术方案', course: '课程讲解', retro: '项目复盘' }
  const en: Record<MockIntent, string> = { launch: 'Product launch', plan: 'Technical plan', course: 'Lesson', retro: 'Retrospective' }
  return lang === 'zh' ? zh[intent] : en[intent]
}

/* ------------------------------ 逐幕内容展开 ------------------------------ */

export interface MockSlideInput {
  lang: 'zh' | 'en'
  deckTitle: string
  index: number
  total: number
  slide: {
    recipe: RecipeId
    headline: string
    lead?: string
    points?: string[]
    notes?: string
  }
}

const EXPAND_BANK: Record<'zh' | 'en', string[]> = {
  zh: [
    '把「{headline}」讲成一个具体场景。',
    '给出一个可验证的细节，而不是形容词。',
    '留一个明确的下一步。',
    '先说结论，再补一句为什么。',
  ],
  en: [
    'Turn "{headline}" into one concrete scene.',
    'Give a verifiable detail instead of an adjective.',
    'Leave one explicit next step.',
    'Conclusion first, then one reason why.',
  ],
}

const NOTE_BANK: Record<'zh' | 'en', string[]> = {
  zh: [
    '这一页只讲一件事：{headline}。先给结论，再举例，最后停两秒。',
    '不要念标题。用一个现场问题开场，让听众自己说出结论。',
    '这页的重点是右边的画面，讲的时候手指过去，只讲一处。',
    '如果时间紧，这页可以压到 30 秒，只保留第一句。',
  ],
  en: [
    'One point only: {headline}. Conclusion, example, then two beats of silence.',
    'Do not read the headline. Open with a question and let the room answer.',
    'The visual carries this page. Point at one thing only.',
    'If time is short, compress to 30 seconds and keep the first line.',
  ],
}

/** Mock 的"逐幕细化"：补齐 3–5 条要点、一句引导与讲者备注。 */
export function mockSlideContent(input: MockSlideInput): {
  headline: string
  lead?: string
  points: string[]
  notes: string
} {
  const lang = input.lang
  const rng = seededRandom(seedFrom(`${input.deckTitle}#${input.index}#${input.slide.headline}`))
  const points = [...(input.slide.points ?? [])]
  const bank = EXPAND_BANK[lang]
  let cursor = 0
  while (points.length < 3 && cursor < bank.length) {
    const candidate = bank[cursor].replace('{headline}', input.slide.headline.replace(/\n/g, ' '))
    if (!points.includes(candidate)) points.push(candidate)
    cursor += 1
  }
  const noteBank = NOTE_BANK[lang]
  const notes =
    input.slide.notes && input.slide.notes.trim() !== ''
      ? input.slide.notes
      : noteBank[Math.floor(rng() * noteBank.length)].replace('{headline}', input.slide.headline.replace(/\n/g, ' '))
  return {
    headline: input.slide.headline,
    lead: input.slide.lead,
    points: points.slice(0, 5),
    notes,
  }
}

/* -------------------------------- 简易翻译 -------------------------------- */

/** Mock 通道的翻译词表：够用即可，真端点走 LLM。 */
const ZH_EN: [string, string][] = [
  ['幻灯片', 'slides'],
  ['演示', 'deck'],
  ['作品', 'artifact'],
  ['观众', 'audience'],
  ['听众', 'audience'],
  ['结论', 'conclusion'],
  ['方案', 'plan'],
  ['结构', 'structure'],
  ['数据', 'data'],
  ['时间轴', 'timeline'],
  ['成本', 'cost'],
  ['风险', 'risk'],
  ['下一步', 'next step'],
  ['问题', 'problem'],
  ['因为', 'because'],
  ['所以', 'so'],
  ['然后', 'then'],
  ['我们', 'we'],
  ['一个', 'a'],
]

const EN_ZH: [string, string][] = [
  ['next step', '下一步'],
  ['conclusion', '结论'],
  ['timeline', '时间轴'],
  ['audience', '观众'],
  ['structure', '结构'],
  ['artifact', '作品'],
  ['problem', '问题'],
  ['slides', '幻灯片'],
  ['because', '因为'],
  ['before', '在……之前'],
  ['cost', '成本'],
  ['risk', '风险'],
  ['plan', '方案'],
  ['data', '数据'],
  ['deck', '演示'],
  ['then', '然后'],
  ['we', '我们'],
]

/** 简易词表翻译（Mock 用）：中文→英文 / 英文→中文，长词优先替换。 */
export function translateText(text: string, target: 'zh' | 'en'): string {
  const pairs = target === 'en' ? ZH_EN : EN_ZH
  let out = text
  for (const [from, to] of pairs) out = out.split(from).join(to)
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}
