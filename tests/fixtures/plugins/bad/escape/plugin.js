/* bad/escape —— 尝试读父页 DOM：不透明源 iframe 下应抛 SecurityError 且宿主无泄漏（S-40-01）。 */
const lumen = window.lumen

lumen.ui.onRender(function (root) {
  root.textContent = ''
  try {
    const parentBody = window.parent.document.body
    lumen.log.error('escape-ok', parentBody ? 'leaked' : 'empty')
  } catch (error) {
    lumen.log.warn('escape-blocked', String(error && error.name))
  }
  try {
    const parentUrl = window.parent.location.href
    lumen.log.warn('url', String(parentUrl))
  } catch (error) {
    lumen.log.warn('url-blocked', String(error && error.name))
  }
})
