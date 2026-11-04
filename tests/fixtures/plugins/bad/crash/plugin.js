/* bad/crash —— 启动即抛错：宿主应记 E-RUN-02，连续 3 次后 quarantined（不白屏）。 */
window.lumen.ui.onRender(function () {
  throw new Error('intentional boot crash')
})
throw new Error('intentional crash')
