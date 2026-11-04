/**
 * ai/mockCreator.ts —— 创造模式 `plugin` 任务的 Mock 文本（04 §6.5/§6.6，零随机、一次合法）。
 *
 * 纪律：
 * - 纯函数：输入图片段（`payload.intent`）→ 确定性 JSON 文本；同输入永远同字节；
 * - 产物必须**一次通过** `creator/proposal.ts` 的校验（Mock 不参与 repair）；
 * - 不 import `src/creator/**`（02 §1.2 单向依赖），所以这里是一份自包含的最小提案。
 */

export type MockCreatorIntent = 'theme' | 'widget' | 'command' | 'other'

const THEME_MANIFEST = {
  id: 'local.creator.template.skin',
  name: { zh: '品牌皮肤', en: 'Brand skin' },
  version: '0.1.0',
  apiVersion: '1.0',
  minAppVersion: '0.4.0',
  kind: 'declarative',
  author: { name: 'LUMEN Creator' },
  description: { zh: '按主色生成的一套主题令牌。', en: 'A theme token set generated from your accent color.' },
  license: 'CC-BY-4.0',
  capabilities: ['theme:contribute', 'i18n:contribute'],
  contributes: {
    themes: [
      {
        id: 'brand-skin',
        name: { zh: '品牌皮肤', en: 'Brand skin' },
        vibe: { zh: '克制、专业', en: 'Restrained and precise' },
        colors: {
          bg: '#0d0e12',
          fg: '#ebecf5',
          muted: '#8a8f9e',
          surface: '#191b22',
          line: '#2a2d38',
          accent: '#1f6feb',
          accent2: '#5a93f0',
        },
        typeScale: 1.02,
        radius: 8,
        elevation: 'raised',
      },
    ],
    i18n: [
      {
        zh: { 'skin.name': '品牌皮肤' },
        en: { 'skin.name': 'Brand skin' },
      },
    ],
  },
}

const WIDGET_MANIFEST = {
  id: 'local.creator.template.dock',
  name: { zh: '字数看板', en: 'Word count' },
  version: '0.1.0',
  apiVersion: '1.0',
  minAppVersion: '0.4.0',
  kind: 'code',
  entry: 'plugin.js',
  author: { name: 'LUMEN Creator' },
  description: { zh: '在底部 dock 显示每页字数与阅读时长。', en: 'Shows per-slide word count in the dock.' },
  license: 'CC-BY-4.0',
  capabilities: ['ui:slot', 'deck:read'],
  contributes: {
    slots: [
      {
        id: 'word-count',
        slot: 'workspace.dock',
        title: { zh: '字数看板', en: 'Word count' },
        kind: 'panel',
        order: 10,
      },
    ],
  },
}

const WIDGET_CODE = `// 字数看板：底部 dock 第一行显示当前页字数（Mock 产物）。
lumen.ui.setTitle('字数看板')
lumen.ui.css('.lw-box{display:flex;gap:14px;padding:10px 14px;font:12px/1.5 var(--ui-font)}.lw-box b{font-size:18px;color:var(--d-accent)}')
function draw(root, snapshot) {
  root.textContent = ''
  var index = 0
  for (var i = 0; i < snapshot.slides.length; i += 1) {
    if (snapshot.slides[i].id === snapshot.activeSlideId) index = i
  }
  var slide = snapshot.slides[index] || snapshot.slides[0]
  var box = lumen.ui.el('div', { class: 'lw-box', 'data-widget': 'word-count' })
  if (slide) {
    box.appendChild(lumen.ui.el('b', { text: String(slide.textChars) + ' 字' }))
    box.appendChild(lumen.ui.el('span', { text: '约 ' + String(slide.readingSeconds) + ' 秒' }))
  }
  root.appendChild(box)
}
lumen.ui.onRender(function (root, ctx) {
  var off = null
  function refresh() {
    lumen.deck.getSnapshot().then(function (snapshot) {
      if (!ctx.signal.aborted) draw(root, snapshot)
    })
  }
  refresh()
  off = lumen.deck.subscribe(function (change) {
    if (change.reason === 'deck' || change.reason === 'slide') refresh()
  })
  ctx.signal.addEventListener('abort', function () { if (off) off() })
})
`

const COMMAND_MANIFEST = {
  id: 'local.creator.template.keys',
  name: { zh: '专注快捷键', en: 'Focus shortcut' },
  version: '0.1.0',
  apiVersion: '1.0',
  minAppVersion: '0.4.0',
  kind: 'declarative',
  author: { name: 'LUMEN Creator' },
  description: { zh: '一个专注布局预设、一个命令与一个组合键。', en: 'A focus preset, a command, and a key combo.' },
  license: 'CC-BY-4.0',
  capabilities: ['ui:command', 'ui:keymap', 'ui:layout'],
  contributes: {
    layoutPresets: [
      {
        id: 'focus',
        name: { zh: '专注', en: 'Focus' },
        apply: { hideInspector: true, railWidth: 216 },
      },
    ],
    commands: [
      {
        id: 'focus-mode',
        title: { zh: '进入专注', en: 'Focus mode' },
        category: 'plugin',
        action: { kind: 'applyLayoutPreset', presetId: 'focus' },
      },
    ],
    keymap: [{ combo: 'mod+shift+d', commandId: 'focus-mode' }],
  },
}

interface ProposalLike {
  title: string
  summary: string
  kind: 'declarative' | 'code'
  risk: 'low' | 'medium' | 'high'
  capabilities: string[]
  files: { path: string; content: string }[]
  changes: { surface: string; detail: string }[]
  trialNote?: string
}

function themeProposal(): ProposalLike {
  return {
    title: '品牌主题皮肤',
    summary: '按主色 #1F6FEB 生成主题令牌与双语语言包',
    kind: 'declarative',
    risk: 'low',
    capabilities: ['theme:contribute', 'i18n:contribute'],
    files: [
      { path: '.lumen-plugin.json', content: JSON.stringify(THEME_MANIFEST, null, 2) },
      { path: 'locales/zh.json', content: JSON.stringify({ 'skin.name': '品牌皮肤' }, null, 2) },
      { path: 'locales/en.json', content: JSON.stringify({ 'skin.name': 'Brand skin' }, null, 2) },
    ],
    changes: [
      { surface: 'theme', detail: '新增主题「品牌皮肤」（主色 #1F6FEB）' },
      { surface: 'i18n', detail: '附 zh/en 双语语言包' },
    ],
    trialNote: '主题在 6 套预设之外，可随时切回',
  }
}

function widgetProposal(): ProposalLike {
  return {
    title: '底部字数看板',
    summary: '在底部 dock 显示当前页字数与预计阅读秒数',
    kind: 'code',
    risk: 'low',
    capabilities: ['ui:slot', 'deck:read'],
    files: [
      { path: '.lumen-plugin.json', content: JSON.stringify(WIDGET_MANIFEST, null, 2) },
      { path: 'plugin.js', content: WIDGET_CODE },
    ],
    changes: [
      { surface: 'workspace.dock', detail: '底部 dock 新增字数看板' },
      { surface: 'command.palette', detail: '不改命令；看板随切幕实时更新' },
    ],
    trialNote: '看底部 dock 第一行',
  }
}

function commandProposal(): ProposalLike {
  return {
    title: '专注命令与键位',
    summary: '新增命令「进入专注」、组合键 mod+shift+d 与专注布局预设',
    kind: 'declarative',
    risk: 'low',
    capabilities: ['ui:command', 'ui:keymap', 'ui:layout'],
    files: [{ path: '.lumen-plugin.json', content: JSON.stringify(COMMAND_MANIFEST, null, 2) }],
    changes: [
      { surface: 'command', detail: '命令面板新增「进入专注」' },
      { surface: 'keymap', detail: '绑定 mod+shift+d（冲突需你确认）' },
      { surface: 'layout', detail: '应用「专注」预设：收起右栏' },
    ],
    trialNote: '按一下你刚设的键',
  }
}

/** intent → 确定性提案对象（Mock 与 fixture 作者共用同一份形状）。 */
export function mockCreatorProposal(intent: MockCreatorIntent): ProposalLike {
  switch (intent) {
    case 'theme':
      return themeProposal()
    case 'widget':
      return widgetProposal()
    case 'command':
      return commandProposal()
    case 'other':
    default:
      return themeProposal()
  }
}

/** `mockText` 的 plugin 分支：返回一次合法的 CreatorProposal JSON 文本。 */
export function mockCreatorText(payload: Record<string, unknown>): string {
  const intent = payload.intent
  const normalized: MockCreatorIntent =
    intent === 'theme' || intent === 'widget' || intent === 'command' || intent === 'other' ? intent : 'other'
  return JSON.stringify(mockCreatorProposal(normalized))
}
