/* bad/flood —— RPC 洪水：宿主令牌桶 120/s + 60s 内 3 次 → 挂起帧（S-40-11）。 */
const lumen = window.lumen

lumen.ui.onRender(function (root) {
  root.textContent = ''
  let sent = 0
  const pump = function () {
    for (let index = 0; index < 2000; index += 1) {
      sent += 1
      lumen.theme.get().catch(function () {
        return undefined
      })
    }
    lumen.log.warn('flood sent', sent)
    window.setTimeout(pump, 50)
  }
  pump()
})
