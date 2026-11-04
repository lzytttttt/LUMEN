/**
 * plugins.html 入口 —— 只挂载插件页，不加载编辑器 / 渲染器 / three。
 * 页面契约：05 §7（六段结构 + 固定钩子）、07 §1（发布物与「本版无插件市场」）。
 */
import { mountPluginsPage } from './mount'

const container = document.getElementById('plugins-root')
if (container) {
  void mountPluginsPage(container)
}
