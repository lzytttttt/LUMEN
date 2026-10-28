/**
 * render/three —— three.js 运行时公共出口。
 *
 * 渲染层只用这里的 API；导出层将来取帧也走 `captureThreeFrame`。
 */
export {
  MAX_LIVE_THREE_RUNTIMES,
  captureThreeFrame,
  createThreeRuntime,
  disposeAllThreeRuntimes,
  getLiveThreeRuntimeCount,
  isWebGLAvailable,
  loadThreeModule,
  resetWebGLSupportCache,
  suspendThreeRuntime,
  type ThreeFailureReason,
  type ThreeRuntime,
  type ThreeRuntimeOptions,
} from './runtime'

export {
  buildThreeScene,
  resolvePalette,
  safeColorValue,
  tintColor,
  type BuiltScene,
  type BuildSceneInput,
  type PaletteColors,
  type ThreeModule,
} from './sceneBuilder'

export {
  clearThreePosters,
  getThreePoster,
  setThreePoster,
  subscribeThreePosters,
} from './posterCache'
