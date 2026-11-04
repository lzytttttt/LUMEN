/**
 * creator/safeMode.ts —— 安全模式判定（04 §10 / 03 §5.3）。
 *
 * `?safe=1` / 启动按住 Shift / 设置项任一命中时，宿主把 `html[data-lumen-safe="1"]` 写上（02 §3.3）。
 * 创造模式自身是宿主内置功能，面板可打开、可生成提案、可导出；但**试跑与保留禁用**——
 * 草稿也是插件，安全模式不执行任何插件代码（E-SAFE-01）。
 */
export function isCreatorSafeMode(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.dataset.lumenSafe === '1'
}

/** 供 UI 在渲染时读取（安全模式在启动期就固定，不需要订阅）。 */
export function useCreatorSafeMode(): boolean {
  return isCreatorSafeMode()
}
