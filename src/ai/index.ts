/**
 * ai/index.ts —— AI 编排的公共 API（studio 与命令面板都依赖这一层）。
 *
 * 对外只暴露这些函数与类型；provider / prompts / recipes 是实现细节，
 * 但也一并导出，方便测试与后续扩展（例如工作室的单点生成）。
 */
export { generateSvgArt, generateThreeScene } from './generate'
export {
  composeOutline,
  buildDeckFromOutline,
  normalizeOutline,
  rebuildOutlineSlide,
  applySlideRebuild,
} from './compose'
export { refineSlide, applyRefinePlan, detectRefineIntent, contentFromSlide } from './refine'
export { installIntentListener, handleIntent, isIntentListenerInstalled } from './intent'
export { RECIPES, buildRecipe, fillContent, recipeSlots } from './recipes'
export type { Recipe } from './recipes'
export {
  AiError,
  MockProvider,
  OpenAICompatProvider,
  aiErrorMessage,
  channelInfo,
  currentProvider,
  isAborted,
  isAiError,
  mockText,
  providerFor,
} from './provider'
export type { AiErrorCode, AiProvider, CompleteRequest, CompleteResult } from './provider'
export { extractJson, parseWithRepair, repairPrompt } from './validate'
export { detectIntent, mockOutline, mockSlideContent, topicOf, translateText } from './corpus'
export type { MockIntent, MockLength, MockOutlineInput, MockSlideInput } from './corpus'
export { ART_STYLES, mockSvgArt, mockThreeScene, pickArtStyle } from './art'
export type { ArtStyle, SvgArt } from './art'
export { stampBlocks } from './provenance'
export type {
  AiLang,
  BuildDeckOptions,
  BuildDeckResult,
  ComposeInput,
  GenerateSvgResult,
  GenerateThreeResult,
  RecipeContent,
  RecipeSlotSpec,
  RecipeVisual,
  RefineIntent,
  SlidePatchPlan,
} from './types'
