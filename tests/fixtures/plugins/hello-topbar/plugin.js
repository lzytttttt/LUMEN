/* hello-topbar —— 代码式插件：顶栏 inline 入口 → 打开 dialog 帧（E-40-14 / 插槽单测夹具）。 */
const lumen = window.lumen

if (lumen && lumen.ui) {
  lumen.ui.onRender(function (root, ctx) {
    root.textContent = ''
    root.setAttribute('data-hello-topbar', 'ready')
    const card = lumen.ui.el('div', { class: 'lumen-card' })
    const title = lumen.ui.el('strong', { text: ctx.locale === 'zh' ? '顶栏你好' : 'Hello from the topbar' })
    const close = lumen.ui.el('button', { class: 'lumen-button', type: 'button', text: ctx.locale === 'zh' ? '关闭' : 'Close' })
    close.addEventListener('click', function () {
      lumen.ui.closePanel({ slot: 'dialog' })
    })
    card.appendChild(title)
    card.appendChild(close)
    root.appendChild(card)
  })
}
