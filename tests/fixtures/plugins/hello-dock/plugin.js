/* hello-dock —— 最小代码式插件：在 workspace.dock 里渲染一行看板（E-40-03 夹具）。 */
const lumen = window.lumen

if (lumen && lumen.ui) {
  const paint = function (root, ctx) {
    root.textContent = ''
    root.setAttribute('data-hello-dock', 'ready')
    root.setAttribute('data-plugin-lang', ctx.locale)
    const card = lumen.ui.el('div', { class: 'lumen-card' })
    const title = lumen.ui.el('strong', { text: ctx.locale === 'zh' ? '你好，看板' : 'Hello, dock' })
    const badge = lumen.ui.el('span', { class: 'lumen-badge', text: 'hello-dock 0.1.0' })
    card.appendChild(title)
    card.appendChild(badge)
    root.appendChild(card)
    lumen.log.info('hello-dock rendered', ctx.width + 'x' + ctx.height)
  }
  lumen.ui.onRender(paint)
}
