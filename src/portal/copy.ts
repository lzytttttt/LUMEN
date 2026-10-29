/**
 * src/portal/copy.ts —— 门户页的全部文案（中/英）。
 *
 * 语气：创作者与使用者平视聊天。不喊口号，直接聊做幻灯片时最真实的顾虑：
 * 排版耗时、上台出丑、会场电脑打不开、老电脑卡顿。
 * 这里刻意不放进 i18n 词典：门户是独立入口，文案随版式一起改。
 */
import type { Lang } from '@/i18n'
import { APP_VERSION } from '@/version'

export const PROJECT_URL = 'https://github.com/lzytttttt/LUMEN'
export const PROJECT_LABEL = 'github.com/lzytttttt/LUMEN'
export const CONTACT_EMAIL = 'lzytttttt@gmail.com'
export const GITHUB_URL = 'https://github.com/lzytttttt'
export const LICENSE_URL = 'https://github.com/lzytttttt/LUMEN/blob/main/LICENSE'

export interface PortalCopy {
  nav: {
    philosophy: string
    steps: string
    shots: string
    features: string
    about: string
    preferences: string
    replay: string
    enter: string
    enterHint: string
  }
  hero: {
    eyebrow: string
    titleA: string
    titleB: string
    subtitle: string
    lead: string
    cta: string
    ctaHint: string
    secondary: string
    note: string
    scroll: string
    stats: { value: string; label: string }[]
    cards: { label: string; src: string }[]
    window: { address: string; caption: string; tag: string }
  }
  philosophy: {
    kicker: string
    title: string
    lead: string
    items: { title: string; body: string }[]
  }
  steps: {
    kicker: string
    title: string
    lead: string
    items: { n: string; title: string; body: string }[]
  }
  shots: {
    kicker: string
    title: string
    lead: string
    hint: string
    tabs: { id: string; label: string; caption: string }[]
  }
  features: {
    kicker: string
    title: string
    lead: string
    items: { key: string; title: string; body: string; tag: string }[]
  }
  facts: { value: string; label: string }[]
  start: {
    kicker: string
    title: string
    lead: string
    preferences: { label: string; value: string }[]
    settingsCta: string
    finalTitle: string
    finalNote: string
    cta: string
    commandsLabel: string
    commands: { cmd: string; note: string }[]
  }
  about: {
    kicker: string
    title: string
    lead: string
    author: string
    role: string
    bio: string
    projectLabel: string
    project: string
    emailLabel: string
    email: string
    copy: string
    copied: string
    licenseLabel: string
    license: string
    licenseNote: string
    licenseLink: string
  }
  footer: { made: string; rights: string; top: string }
}

const zh: PortalCopy = {
  nav: {
    philosophy: '为什么做幕光',
    steps: '怎么用',
    shots: '实机画面',
    features: '还能做什么',
    about: '作者与许可',
    preferences: '偏好设置',
    replay: '离线演示',
    enter: '进入',
    enterHint: '按 Enter 直接开始',
  },
  hero: {
    eyebrow: `LUMEN 幕光 · v${APP_VERSION}`,
    titleA: '从一句话的想法，',
    titleB: '到稳稳当当地上台。',
    subtitle: 'LUMEN 幕光 —— 装在浏览器里的 AI 演示工作台。',
    lead: '顺着「输入、大纲、成稿、检查、播放」五步把架子搭好，也能随时退回画布亲手微调每一个细节。做完导出一个单文件 HTML，拷进 U 盘、双击就能播。',
    cta: '进入工作台',
    ctaHint: '按 Enter',
    secondary: '先看一遍离线回放',
    note: '不用注册登录 · 没有后台收集数据 · 断网也能用 · 稿子只存在你自己的浏览器里',
    scroll: '往下看',
    stats: [
      { value: '0', label: '后端' },
      { value: '0', label: '遥测' },
      { value: '1', label: '个 HTML 文件' },
    ],
    cards: [
      { label: '大纲', src: './portal/forge-deal.png' },
      { label: '装台', src: './portal/forge-cast.png' },
      { label: '开演', src: './portal/forge-premiere.png' },
    ],
    window: { address: 'lumen.local/forge', caption: '工作台实机', tag: '本地运行' },
  },
  philosophy: {
    kicker: '01 / 为什么做幕光',
    title: '好用的工具，首先得让人省心。',
    lead: '做幻灯片时最真实的几件烦心事，我们一件件处理。',
    items: [
      {
        title: 'AI 生成，不该像刷屏一样让人心慌',
        body: '文字噼里啪啦往外蹦，看的人往往比写的人还累。我们在生成过程里留了恰当的停顿节奏——出大纲、落页面、重排修正，每一步都按舒服的节拍走完。哪怕用的是极速接口或本地离线模式，它也会稳稳当当地把每一页摊开给你看。',
      },
      {
        title: '别把排版错误，留到演讲现场才发现',
        body: '投影仪上字太小、颜色看不清、文字撑出框外，这种尴尬谁都不想遇到。幕光给 AI 生成的稿子和你手改的页面配了同一把检查尺子：字号、对比度、溢出、3D 性能预算和单页阅读时长都会自动过检。有问题当场标出并试着重排，修妥当了再亮起播放键。',
      },
      {
        title: '不设账号，不传云端，带走的文件在哪都能开',
        body: '写东西是很私密的事。这里没有后端服务器，不埋点统计，连远程字体都不加载。所有数据和你填的接口密钥只留在本地浏览器里；导出的 HTML 把播放器和素材全打包在一块，换台没网的会议室电脑，双击照样流畅播放。',
      },
      {
        title: '不挑电脑配置，也照顾看屏幕的眼睛',
        body: '不是每个人手头都是顶配新电脑。工作台准备了 L0 到 L3 四档画面表现，老旧设备会自动退到轻量或静态档位保流畅；容易晕屏或喜欢清静的朋友，也可以一键开启「减少动效」，安安静静地把活干完。',
      },
    ],
  },
  steps: {
    kicker: '02 / 怎么用 · 造幕台',
    title: '五步走完，不用在七八个窗口之间来回切。',
    lead: '点一下顶栏的「✦ 生成」，或者长按左侧加号 400 毫秒就能呼出造幕台。中途想反悔随时按 Esc 退出，没做完的草稿绝不乱存，做完落进列表的也能一键撤销。',
    items: [
      {
        n: '1',
        title: '写句话（输入）',
        body: '说说你想讲什么，实在没头绪也可以点旁边的三张示例卡试试水。定好页数和时长再动手，不填内容时按钮不会误触抢跑。',
      },
      {
        n: '2',
        title: '理思路（大纲）',
        body: '先看 3 到 20 页的大纲卡合不合心意。一头一尾两幕帮你稳住全场，中间哪页不满意尽管换、尽管删，鼠标拽一拽就能调顺序。',
      },
      {
        n: '3',
        title: '出画面（生成）',
        body: '12 种版式搭配 6 套主题，一页接一页生成实稿。进度明明白白，中途不想等了随时取消，不会往你的片库里塞半成品。',
      },
      {
        n: '4',
        title: '挑毛病（检查）',
        body: '上台前的自动体检。遇到文字溢出或看不清的地方，系统会先自动重排一次；要是还不满意，按一下 R 键就能把这一页单独重做一遍。',
      },
      {
        n: '5',
        title: '直接讲（播放）',
        body: '检查通过就能全屏开讲，或者点「编辑」退回大画布，像改普通幻灯片一样挨个元素慢慢抠细节。',
      },
    ],
  },
  shots: {
    kicker: '03 / 实机画面',
    title: '不放概念渲染图，你看到的每一张都是真实界面。',
    lead: '点击下方标签，看看工作台在不同阶段的样子：',
    hint: '截图来自 doc/screenshots，和仓库里的版本一致。',
    tabs: [
      { id: 'forge', label: '造幕台', caption: '从写下想法到过检播放，五步流程全在同一张台面上流转，进度与卡点一目了然。' },
      { id: 'editor', label: '画布编辑器', caption: '1600×900 标准画布，支持多选框选、八向缩放、智能参考线吸附与 200 步历史撤销。' },
      { id: 'composer', label: '精确模式', caption: '结构与样式排得整整齐齐，适合习惯对着大纲改字、对版面规矩有要求的朋友。' },
      { id: 'studio', label: 'SVG 与 3D 工作室', caption: '内置安全净化的矢量画板与按需加载的 3D 场景，平时看缩略图不占显卡资源。' },
      { id: 'play', label: '全屏开演', caption: '配备五种转场与讲者视图，一边看备注、计时器和下一幕预告，一边从容控场。' },
    ],
  },
  features: {
    kicker: '04 / 还能做什么',
    title: 'AI 帮你搭好架子，剩下的自由度全在你手里。',
    lead: '不是把稿子锁在模板里，而是把能改的地方都留着。',
    items: [
      {
        key: 'elements',
        title: '六种元素随便搭',
        body: '文字、几何图形、图片、净化后的 SVG 矢量图、3D 空间模型，还有运行在独立安全沙箱里的 HTML，都能放心往同一页里放。',
        tag: '编辑',
      },
      {
        key: 'page',
        title: '哪页不顺改哪页',
        body: '不用整份推倒重来。单拎出一页，就能让 AI 帮你重写文案、精简字数、变成时间轴，或者单独补一张 SVG 图表和 3D 视角。',
        tag: '单页',
      },
      {
        key: 'model',
        title: '接你自己的模型，没网也能跑',
        body: '原生支持 DeepSeek、OpenAI、本地 Ollama 和自建网关，带流式输出与本地缓存。哪怕在飞机上或内网环境，也有两条离线通道让你随时演练。',
        tag: '通道',
      },
      {
        key: 'export',
        title: '多种格式兜底交付',
        body: '除了双击即播的独立 HTML，还能加个参数直接排版打印 PDF、导出 2 倍高清 PNG 图片，或者存成 .lumen.json 工程文件留着以后接着改。',
        tag: '导出',
      },
      {
        key: 'game',
        title: '不打扰人的小鼓励',
        body: '做稿子时会悄悄攒下连击、熟练度和小成就。纯本地计算，不联网、不弹窗催促、更不会拿来锁任何功能，只当是赶稿路上的小彩蛋。',
        tag: '游戏化',
      },
      {
        key: 'keyboard',
        title: '全键盘操作与双语切换',
        body: '顺手的快捷键让你不用频繁摸鼠标就能走完全程；中英文界面 1,088 处词条严格对应，点一下就能秒切。',
        tag: '键盘',
      },
    ],
  },
  facts: [
    { value: '362', label: '单元测试' },
    { value: '14', label: '端到端用例' },
    { value: '12', label: '版式配方' },
    { value: '0', label: '后端依赖' },
  ],
  start: {
    kicker: '05 / 进场准备',
    title: '进门之前，可以先按你的习惯调好设置。',
    lead: '在这里改好的选项会直接保存在本地（lumen.prefs），一进工作台就按你的习惯来。',
    preferences: [
      { label: '生成通道', value: '离线模式（默认免配置） / 离线回放 / 自定义接口（支持 DeepSeek、OpenAI、本地 Ollama 等）' },
      { label: '画面档位', value: '自动适配 / L3 全动效 / L2 2.5D 舞台 / L1 轻量流水线 / L0 纯静态' },
      { label: '声音与动效', value: '开启或关闭操作音效 · 开启「减少动效」让画面更安静' },
      { label: '界面语言', value: '简体中文 / English' },
    ],
    settingsCta: '打开偏好设置',
    finalTitle: '都调好了？那我们开始吧。',
    finalNote: '第一次进入时，右下角会有个三步小卡片带你认认路。不设全屏遮罩、不挡画布，熟悉了点「跳过」就行。',
    cta: '进入 LUMEN 工作台',
    commandsLabel: '本地运行',
    commands: [
      { cmd: 'pnpm install', note: '安装依赖' },
      { cmd: 'pnpm dev', note: 'http://127.0.0.1:5273' },
      { cmd: '?channel=replay', note: '断网回放一套 9 幕' },
    ],
  },
  about: {
    kicker: '06 / 作者与许可',
    title: '希望这个小工具，能帮你少熬一点排版的夜，在台上多几分笃定。',
    lead: '',
    author: '无极Ayaya',
    role: '设计 / 前端 / 文档',
    bio: '做浏览器里的工具。喜欢把复杂的东西压到一屏里，也喜欢让它们动起来。',
    projectLabel: '开源仓库',
    project: PROJECT_LABEL,
    emailLabel: '写信联系',
    email: CONTACT_EMAIL,
    copy: '复制',
    copied: '已复制',
    licenseLabel: '源码许可',
    license: 'Apache-2.0 + Commons Clause',
    licenseNote: '源码可自由自建、修改与分享，但不得转售本软件本身；示例文案、截图与品牌资产为非商业许可。转售或托管服务需商业授权。',
    licenseLink: '查看协议',
  },
  footer: {
    made: 'LUMEN 幕光 · 在浏览器里做演示',
    rights: '© 2026 无极Ayaya',
    top: '回到顶部',
  },
}

const en: PortalCopy = {
  nav: {
    philosophy: 'Why Lumen',
    steps: 'How it works',
    shots: 'Screens',
    features: 'More',
    about: 'Author & license',
    preferences: 'Preferences',
    replay: 'Offline demo',
    enter: 'Enter',
    enterHint: 'Press Enter to start',
  },
  hero: {
    eyebrow: `LUMEN · v${APP_VERSION}`,
    titleA: 'From a single line,',
    titleB: 'to walking on stage calm.',
    subtitle: 'LUMEN — an AI deck workbench that lives in the browser.',
    lead: 'Build the frame in five steps — input, outline, draft, check, play — then drop back onto the canvas and adjust every detail by hand. Ship one HTML file; copy it to a USB stick and it plays on double-click.',
    cta: 'Open workbench',
    ctaHint: 'Press Enter',
    secondary: 'Watch the offline replay',
    note: 'No sign-up · no analytics · works offline · your deck stays in this browser',
    scroll: 'Scroll',
    stats: [
      { value: '0', label: 'backend' },
      { value: '0', label: 'telemetry' },
      { value: '1', label: 'HTML file' },
    ],
    cards: [
      { label: 'Outline', src: './portal/forge-deal.png' },
      { label: 'Stage', src: './portal/forge-cast.png' },
      { label: 'Play', src: './portal/forge-premiere.png' },
    ],
    window: { address: 'lumen.local/forge', caption: 'Workbench', tag: 'local' },
  },
  philosophy: {
    kicker: '01 / Why Lumen',
    title: 'A good tool should first put your mind at ease.',
    lead: 'The four things people actually worry about when making slides. We handle them one by one.',
    items: [
      {
        title: 'AI output should not feel like a slot machine',
        body: 'Text spitting out at full speed is more tiring to watch than to write. We keep a calm rhythm in generation — outline, page, re-layout — each step at a pace you can follow. Fast APIs and local offline mode both deal the pages out steadily.',
      },
      {
        title: 'Do not discover a layout bug at the venue',
        body: 'Tiny type on a projector, low contrast, text pushed out of the box. Lumen runs the same checks on AI drafts and hand-edited pages: type size, contrast, overflow, 3D budget and reading time. Problems are marked on the spot and re-laid-out; play unlocks after they are fixed.',
      },
      {
        title: 'No account, no cloud, a file that opens anywhere',
        body: 'Writing is private. There is no backend, no tracking, not even remote fonts. Your deck and API key stay in this browser. The exported HTML packs the player and assets together; open it on an offline meeting-room PC and it still plays.',
      },
      {
        title: 'Runs on modest hardware, and looks after your eyes',
        body: 'Not everyone has a new top-spec laptop. Lumen ships four render tiers, L0–L3; older machines fall back to a lighter or static stage. If motion makes you dizzy, turn on Reduce motion and work in quiet.',
      },
    ],
  },
  steps: {
    kicker: '02 / How it works · The Forge',
    title: 'Five steps, without jumping between seven windows.',
    lead: 'Click “✦ Generate” in the top bar, or press and hold the + in the left rail for 400 ms. Press Esc to leave; unfinished drafts are not saved, and completed slides can be undone in one step.',
    items: [
      {
        n: '1',
        title: 'Say it (input)',
        body: 'Type what you want to talk about, or tap one of the three examples. Set slide count and length first; the button will not fire on an empty line.',
      },
      {
        n: '2',
        title: 'Shape it (outline)',
        body: 'Check the 3–20 outline cards. Cover and closing hold the ends; swap, delete or drag the middle slides until the order feels right.',
      },
      {
        n: '3',
        title: 'Build it (generate)',
        body: '12 layouts × 6 themes, one real slide after another. Progress is honest, cancel anytime, and half-built slides never enter your deck.',
      },
      {
        n: '4',
        title: 'Check it (gate)',
        body: 'A pre-flight check. Overflow or low contrast triggers one automatic re-layout; press R to rebuild that single slide if it still bothers you.',
      },
      {
        n: '5',
        title: 'Play it (play)',
        body: 'Pass the check and go full screen — or hit Edit to return to the canvas and adjust every element like a normal slide.',
      },
    ],
  },
  shots: {
    kicker: '03 / Screens',
    title: 'No concept renders. Every frame here is the real interface.',
    lead: 'Click a tab to see the workbench at each stage.',
    hint: 'Screenshots come from doc/screenshots — the same files as the repository.',
    tabs: [
      { id: 'forge', label: 'Forge', caption: 'From a line to gate pass and playback, all five stages run on one stage; progress and blockers stay visible.' },
      { id: 'editor', label: 'Canvas editor', caption: 'A 1600×900 canvas with multi-select, marquee, 8-way resize, smart guides and 200-step undo.' },
      { id: 'composer', label: 'Precision mode', caption: 'Structure and styles laid out in order, for people who prefer editing copy against a clean outline.' },
      { id: 'studio', label: 'SVG & 3D studio', caption: 'A sanitized vector board and on-demand 3D scenes; thumbnails do not touch the GPU.' },
      { id: 'play', label: 'Playback', caption: 'Five transitions and a presenter view with notes, timer and next-slide preview.' },
    ],
  },
  features: {
    kicker: '04 / More',
    title: 'AI builds the frame; the freedom to change it stays with you.',
    lead: 'Nothing is locked inside a template.',
    items: [
      {
        key: 'elements',
        title: 'Six element types',
        body: 'Text, shapes, images, sanitized SVG, 3D scenes and sandboxed HTML can share one slide.',
        tag: 'Edit',
      },
      {
        key: 'page',
        title: 'Fix one page, not the deck',
        body: 'Ask AI to rewrite, shorten, turn into a timeline, or add a single SVG chart or 3D view — for that page only.',
        tag: 'Single page',
      },
      {
        key: 'model',
        title: 'Bring your own model, work offline',
        body: 'DeepSeek, OpenAI, local Ollama and self-hosted gateways, with streaming and local cache. Two offline paths keep you rehearsing on a plane or intranet.',
        tag: 'Channel',
      },
      {
        key: 'export',
        title: 'Deliver in several formats',
        body: 'A self-contained HTML for double-click playback, print-ready PDF, 2× PNG, or a .lumen.json project file to keep editing.',
        tag: 'Export',
      },
      {
        key: 'game',
        title: 'Small rewards that stay out of the way',
        body: 'Combo, mastery and achievements accumulate quietly. All local, no network, no pop-ups, no feature locks — just small Easter eggs on the way.',
        tag: 'Game',
      },
      {
        key: 'keyboard',
        title: 'Keyboard-first, bilingual',
        body: 'Shortcuts cover the whole flow; 1,088 UI strings map one-to-one between Chinese and English, one click to switch.',
        tag: 'Keyboard',
      },
    ],
  },
  facts: [
    { value: '362', label: 'unit tests' },
    { value: '14', label: 'e2e cases' },
    { value: '12', label: 'recipes' },
    { value: '0', label: 'backend' },
  ],
  start: {
    kicker: '05 / Before you enter',
    title: 'Set it up the way you like before walking in.',
    lead: 'Changes here are saved locally (lumen.prefs) and applied the moment you enter the workbench.',
    preferences: [
      { label: 'Channel', value: 'Offline mode (default, no setup) / offline replay / custom endpoint (DeepSeek, OpenAI, local Ollama…)' },
      { label: 'Render tier', value: 'Auto / L3 full motion / L2 2.5D stage / L1 light pipeline / L0 static' },
      { label: 'Sound & motion', value: 'Toggle operation sounds · turn on Reduce motion for a quieter screen' },
      { label: 'Language', value: '简体中文 / English' },
    ],
    settingsCta: 'Open preferences',
    finalTitle: 'All set? Let’s start.',
    finalNote: 'On first entry, a three-step card appears in the bottom-right. No full-screen overlay, no blocked canvas; press Skip when you know the way.',
    cta: 'Enter LUMEN workbench',
    commandsLabel: 'Local run',
    commands: [
      { cmd: 'pnpm install', note: 'install' },
      { cmd: 'pnpm dev', note: 'http://127.0.0.1:5273' },
      { cmd: '?channel=replay', note: 'replay nine slides offline' },
    ],
  },
  about: {
    kicker: '06 / Author & license',
    title: 'Hope this little tool saves you a few late nights of typesetting, and adds some calm on stage.',
    lead: '',
    author: '无极Ayaya',
    role: 'Design / front-end / docs',
    bio: 'Builds tools in the browser. Likes compressing complicated things into one screen, and making them move.',
    projectLabel: 'Repository',
    project: PROJECT_LABEL,
    emailLabel: 'Email',
    email: CONTACT_EMAIL,
    copy: 'Copy',
    copied: 'Copied',
    licenseLabel: 'License',
    license: 'Apache-2.0 + Commons Clause',
    licenseNote: 'Self-host, modify and share freely, but do not resell the software itself; sample copy, screenshots and brand assets are non-commercial. Resale or hosted service needs a commercial license.',
    licenseLink: 'Read the license',
  },
  footer: {
    made: 'LUMEN · decks made in the browser',
    rights: '© 2026 无极Ayaya',
    top: 'Back to top',
  },
}

export function portalCopy(lang: Lang): PortalCopy {
  return lang === 'en' ? en : zh
}
