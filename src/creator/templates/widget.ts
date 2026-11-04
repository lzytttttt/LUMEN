/**
 * creator/templates/widget.ts —— 插槽小组件模板（04 §6.6 / CR-40-187）。
 *
 * 无模型起点：同步生成 `.lumen-plugin.json` + `plugin.js`（单文件 ESM、只用 `window.lumen`）。
 * manifest id 固定 `local.creator.template.dock`；代码只申请 `ui:slot` + `deck:read`（最小权限）。
 */
import type { CreatorProposal } from '@/plugins/types'

export type WidgetSlotChoice = 'workspace.dock' | 'workspace.inspector.tab'

export interface WidgetTemplateOptions {
  /** 插槽（默认底部 dock；04 §4.1 的 panel 形态，静态 inline 槽不在模板内）。 */
  slot?: WidgetSlotChoice
  /** 显示每页字数（默认 true）。 */
  showWords?: boolean
  /** 显示预计阅读秒数（默认 true）。 */
  showReadingTime?: boolean
}

export const WIDGET_TEMPLATE_ID = 'local.creator.template.dock'

const SLOT_TITLE: Record<WidgetSlotChoice, { zh: string; en: string }> = {
  'workspace.dock': { zh: '字数看板', en: 'Word count' },
  'workspace.inspector.tab': { zh: '字数页签', en: 'Word count tab' },
}

function progressJs(options: Required<Pick<WidgetTemplateOptions, 'showWords' | 'showReadingTime'>>): string {
  return `${options.showWords ? '    box.appendChild(lumen.ui.el(\'b\', { text: String(slide.textChars) + \' 字\' }))\n' : ''}${
    options.showReadingTime
      ? '    box.appendChild(lumen.ui.el(\'span\', { text: \'约 \' + String(slide.readingSeconds) + \' 秒\' }))\n'
      : ''
  }`
}

/** 插件入口源码（单文件 ESM，零网络、零存储、零外链）。 */
export function widgetPluginSource(options: WidgetTemplateOptions = {}): string {
  const showWords = options.showWords !== false
  const showReadingTime = options.showReadingTime !== false
  return `// 字数看板：把每页字数与阅读时长放到插槽里，实时跟随 deck 变化。
// 只用 window.lumen；不联网、不写宿主存储、不碰其他插件数据。
lumen.ui.setTitle('字数看板')
lumen.ui.css(
  '.lw-box{display:flex;align-items:baseline;gap:14px;padding:10px 14px;font:12px/1.5 var(--ui-font)}' +
    '.lw-box b{font-size:18px;font-variant-numeric:tabular-nums;color:var(--d-accent)}' +
    '.lw-page{color:var(--ui-fg-mute)}.lw-time{color:var(--ui-fg-dim)}',
)

function draw(root, snapshot) {
  root.textContent = ''
  var active = null
  var index = 0
  for (var i = 0; i < snapshot.slides.length; i += 1) {
    if (snapshot.slides[i].id === snapshot.activeSlideId) {
      active = snapshot.slides[i]
      index = i
    }
  }
  var slide = active || snapshot.slides[0]
  var box = lumen.ui.el('div', { class: 'lw-box', 'data-widget': 'word-count' })
  box.appendChild(lumen.ui.el('span', { class: 'lw-page', text: '第 ' + String(index + 1) + ' / ' + String(snapshot.slides.length) + ' 页' }))
${progressJs({ showWords, showReadingTime })}  root.appendChild(box)
}

lumen.ui.onRender(function (root, ctx) {
  var off = null
  function refresh() {
    lumen.deck.getSnapshot().then(function (snapshot) {
      if (ctx.signal.aborted) return
      draw(root, snapshot)
    })
  }
  refresh()
  off = lumen.deck.subscribe(function (change) {
    if (change.reason === 'deck' || change.reason === 'slide') refresh()
  })
  ctx.signal.addEventListener('abort', function () {
    if (off) off()
  })
})
`
}

function manifestOf(options: WidgetTemplateOptions): Record<string, unknown> {
  const slot = options.slot ?? 'workspace.dock'
  return {
    id: WIDGET_TEMPLATE_ID,
    name: { zh: '字数看板', en: 'Word count' },
    version: '0.1.0',
    apiVersion: '1.0',
    minAppVersion: '0.4.0',
    kind: 'code',
    entry: 'plugin.js',
    author: { name: 'LUMEN Creator' },
    description: {
      zh: '在插槽里显示当前页字数与预计阅读时长，每页实时更新。',
      en: 'Shows the current slide word count and reading time, updated live.',
    },
    license: 'CC-BY-4.0',
    capabilities: ['ui:slot', 'deck:read'],
    contributes: {
      slots: [
        {
          id: 'word-count',
          slot,
          title: SLOT_TITLE[slot],
          kind: 'panel',
          order: 10,
        },
      ],
    },
  }
}

/** 插槽小组件模板 → 提案（未走校验；入口在 `templates/index.ts`）。 */
export function buildWidgetTemplate(options: WidgetTemplateOptions = {}): CreatorProposal {
  const slot = options.slot ?? 'workspace.dock'
  const slotName = SLOT_TITLE[slot]
  const flags: string[] = []
  if (options.showWords !== false) flags.push('每页字数')
  if (options.showReadingTime !== false) flags.push('预计阅读秒数')
  return {
    title: slot === 'workspace.dock' ? '底部字数看板' : '右栏字数页签',
    summary: `在 ${slot} 插槽显示当前页${flags.join('与')}，随切换幕实时更新`,
    kind: 'code',
    risk: 'low',
    capabilities: ['ui:slot', 'deck:read'],
    files: [
      { path: '.lumen-plugin.json', content: JSON.stringify(manifestOf(options), null, 2) },
      { path: 'plugin.js', content: widgetPluginSource(options) },
    ],
    changes: [
      { surface: slot, detail: `新增插槽贡献「${slotName.zh}」` },
      { surface: 'command.palette', detail: '插槽只在试跑/启用后出现，不新增命令' },
    ],
    trialNote: slot === 'workspace.dock' ? '看底部 dock 第一行' : '看右栏新增的页签',
  }
}
