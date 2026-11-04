/* hello-playoverlay —— 代码式插件：play.overlay 上的排练计时（V-40-13）。 */
const lumen = window.lumen

if (lumen && lumen.ui) {
  var startedAt = 0
  var ticker = null

  lumen.ui.onRender(function (root, ctx) {
    root.textContent = ''
    root.setAttribute('data-hello-playoverlay', 'ready')
    if (ticker) {
      clearInterval(ticker)
      ticker = null
    }
    if (!startedAt) startedAt = Date.now()
    const box = lumen.ui.el('div', { class: 'lumen-badge', 'aria-live': 'polite' })
    const paint = function () {
      const seconds = Math.floor((Date.now() - startedAt) / 1000)
      const minutes = Math.floor(seconds / 60)
      box.textContent = (ctx.locale === 'zh' ? '排练 ' : 'Rehearsal ') + minutes + ':' + String(seconds % 60).padStart(2, '0')
    }
    paint()
    ticker = setInterval(paint, 1000)
    root.appendChild(box)
  })

  lumen.events.on('play:stop', function () {
    if (ticker) {
      clearInterval(ticker)
      ticker = null
    }
  })
}
