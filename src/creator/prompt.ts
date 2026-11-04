/**
 * creator/prompt.ts —— 创造模式请求装配：few-shot（05 §3.10/§4.10/§5.10 压缩）+ ABI 注入 +
 * token 预算裁剪（04 §6.2/§6.3/§6.4）。
 *
 * 分层纪律（02 §1.2）：`src/ai/prompts.ts` 只提供 `CREATOR_SYSTEM` 基座与 `creatorRequest()`；
 * ABI 摘录 / few-shot / 预算都在 creator 域装配，ai 内核不 import creator。
 */
import { creatorRequest, type PromptPair } from '@/ai/prompts'
import type { CreatorTemplateId } from './state'
import { abiDigestFor, ABI_SURFACE_SUMMARY } from './abi-digest'
import {
  CREATOR_CONTEXT_LIMITS,
  estimateTokens,
  estimateTokensOf,
  fitTextToTokens,
  payloadOf,
  trimCreatorContext,
  stableStringify,
  type CreatorContextSnapshot,
} from './context'

/* ------------------------------ 意图识别（Mock 分派） ------------------------------ */

export type CreatorIntent = CreatorTemplateId | 'auto'

/** 一句话 → 意图（确定性关键词；不调模型）。 */
export function detectCreatorIntent(prompt: string): CreatorIntent {
  const text = prompt.toLowerCase()
  if (/(主题|皮肤|配色|主色|颜色|色板|theme|skin|palette|accent)/.test(text)) return 'theme'
  if (/(插槽|看板|面板|dock|widget|统计|字数|计时|overlay|悬浮)/.test(text)) return 'widget'
  if (/(命令|快捷键|键位|按键|command|shortcut|keymap|hotkey|专注|zen|focus)/.test(text)) return 'command'
  return 'auto'
}

/** 意图 → 协议意图（`other` 用于 Mock 兜底；04 §6.6）。 */
export function mockIntentOf(intent: CreatorIntent): CreatorTemplateId | 'other' {
  return intent === 'auto' ? 'other' : intent
}

/* ------------------------------ few-shot（≤450 token/条，最多 2 条） ------------------------------ */

export interface CreatorFewShot {
  intent: CreatorTemplateId
  /** 对应 05 的节号（引用，不整包注入）。 */
  source: string
  text: string
}

export const CREATOR_FEW_SHOTS: CreatorFewShot[] = [
  {
    intent: 'theme',
    source: '05 §3.10',
    text: `示例（主题皮肤，声明式）：
需求：「主色 #1F6FEB，圆角小一点」
manifest 摘要：{id:'local.creator.template.skin', kind:'declarative', capabilities:['theme:contribute','i18n:contribute'],
  contributes:{themes:[{id:'brand-skin',name:{zh:'品牌皮肤',en:'Brand skin'},colors:{bg:'#0d0e12',fg:'#ebecf5',muted:'#8a8f9e',surface:'#191b22',line:'#2a2d38',accent:'#1f6feb',accent2:'#5a93f0'},radius:4,typeScale:0.96}],
  i18n:[{zh:{'skin.name':'品牌皮肤'},en:{'skin.name':'Brand skin'}}]}}
要点：颜色只用 #rrggbb/rgb()/hsl()；不覆盖内置 6 套主题 id；不写 plugin.js。`,
  },
  {
    intent: 'widget',
    source: '05 §4.10',
    text: `示例（插槽小组件，code）：
需求：「底部 dock 显示每页字数」
manifest 摘要：{id:'local.creator.template.dock', kind:'code', entry:'plugin.js', capabilities:['ui:slot','deck:read'],
  contributes:{slots:[{id:'word-count',slot:'workspace.dock',title:{zh:'字数看板',en:'Word count'},kind:'panel'}]}}
关键代码（12 行）：
lumen.ui.setTitle('字数看板')
lumen.ui.onRender(function (root, ctx) {
  function draw(snapshot) {
    root.textContent = ''
    var box = lumen.ui.el('div', { class: 'lw-box' })
    box.appendChild(lumen.ui.el('b', { text: String(snapshot.slides.length) + ' 页' }))
    root.appendChild(box)
  }
  lumen.deck.getSnapshot().then(draw)
  var off = lumen.deck.subscribe(function () { lumen.deck.getSnapshot().then(draw) })
  ctx.signal.addEventListener('abort', function () { off() })
})
要点：单文件 ESM、只用 window.lumen；读 deck 要 deck:read，写 deck 需 deck:write（默认不申请）。`,
  },
  {
    intent: 'command',
    source: '05 §5.10',
    text: `示例（命令与键位，纯声明式）：
需求：「⌘⇧D 进入专注，收起右栏」
manifest 摘要：{id:'local.creator.template.keys', kind:'declarative', capabilities:['ui:command','ui:keymap','ui:layout'],
  contributes:{layoutPresets:[{id:'focus',name:{zh:'专注',en:'Focus'},apply:{hideInspector:true,railWidth:216}}],
  commands:[{id:'focus-mode',title:{zh:'进入专注',en:'Focus mode'},category:'plugin',action:{kind:'applyLayoutPreset',presetId:'focus'}}],
  keymap:[{combo:'mod+shift+d',commandId:'focus-mode'}]}}
要点：combo 必须含修饰键；命令 id 与键位引用一致；不写代码、不建帧；冲突交给用户确认。`,
  },
]

/** 按意图选 few-shot：最接近的 1 条，auto 时最多 2 条（04 §6.3）。 */
export function fewShotsFor(intent: CreatorIntent): CreatorFewShot[] {
  if (intent === 'auto') return CREATOR_FEW_SHOTS.slice(0, 2)
  const matched = CREATOR_FEW_SHOTS.find((shot) => shot.intent === intent)
  return matched ? [matched] : CREATOR_FEW_SHOTS.slice(0, 1)
}

/* ------------------------------ 装配 ------------------------------ */

export const CREATOR_PROMPT_BUDGET = {
  /** system 合计上限（04 §6.2）。 */
  systemTotal: 6500,
  /** 主体（角色/规则/面/契约/禁用）。 */
  roleRules: 2000,
  /** ABI 摘录上限。 */
  abi: 3000,
  /** few-shot 上限。 */
  fewShot: 1800,
  /** user 快照上限（显式 deck 摘录另算）。 */
  userSnapshot: CREATOR_CONTEXT_LIMITS.userSnapshot,
  deckExcerpt: CREATOR_CONTEXT_LIMITS.deckExcerpt,
  inputTotal: CREATOR_CONTEXT_LIMITS.inputTotal,
  inputTotalWithDeck: CREATOR_CONTEXT_LIMITS.inputTotalWithDeck,
} as const

export interface CreatorPromptInput {
  prompt: string
  context: CreatorContextSnapshot
  /** 显式打开「读演示正文」后才发摘录（默认读 context.deckExcerpt 是否存在）。 */
  readDeck?: boolean
  /** 沙箱错误回喂文本（04 §7.4；≤2000 字符，进 payload 的 feedback 字段）。 */
  feedback?: string
}

export interface CreatorPromptResult {
  system: string
  user: string
  intent: CreatorIntent
  mockIntent: CreatorTemplateId | 'other'
  tokens: { system: number; user: number; total: number; abi: number; fewShot: number }
  /** 被预算裁掉的段（诊断用）。 */
  trimmed: string[]
}

/** 组装一次 plugin 任务的 prompt（system 含 ABI/few-shot；user 是稳定序列化 JSON）。 */
export function buildCreatorPrompt(input: CreatorPromptInput): CreatorPromptResult {
  const intent = detectCreatorIntent(input.prompt)
  const trimmed: string[] = []

  // 1) user 快照：默认 ≤600 token；deck 摘录单独 ≤2500。
  const snapshot: CreatorContextSnapshot = { ...input.context, intent }
  const withExcerpt = input.readDeck === true && snapshot.deckExcerpt !== undefined
  const contextForPayload: CreatorContextSnapshot = withExcerpt ? snapshot : { ...snapshot, deckExcerpt: undefined }
  const trimmedContext = trimCreatorContext(
    { ...contextForPayload, deckExcerpt: undefined },
    CREATOR_PROMPT_BUDGET.userSnapshot,
  )
  trimmed.push(...trimmedContext.trimmed)

  let deckExcerpt = withExcerpt ? (contextForPayload.deckExcerpt ?? []) : undefined
  if (deckExcerpt) {
    while (
      deckExcerpt.length > 0 &&
      estimateTokensOf({ deckExcerpt: deckExcerpt.map((slide) => ({ ...slide })) }) >
        CREATOR_PROMPT_BUDGET.deckExcerpt
    ) {
      deckExcerpt = deckExcerpt.slice(0, -1)
      if (!trimmed.includes('deckExcerpt')) trimmed.push('deckExcerpt')
    }
  }

  const payload = {
    intent: mockIntentOf(intent),
    prompt: input.prompt,
    ...(input.feedback ? { feedback: input.feedback.slice(0, 2000) } : {}),
    context: {
      ...payloadOf(trimmedContext.snapshot),
      ...(deckExcerpt && deckExcerpt.length > 0 ? { deckExcerpt } : {}),
    },
  }
  const user = stableStringify(payload)

  // 2) system：基座 + ABI + few-shot + 面摘要，按 04 §6.2 的裁剪顺序（few-shot → ABI → 面摘要）。
  const shots = fewShotsFor(intent)
  let shotText = formatFewShots(shots)
  let abiText = abiDigestFor(intent)
  let surfaceText = ABI_SURFACE_SUMMARY

  const composeSystem = (): string =>
    creatorRequest({
      user,
      extras: [abiText, shotText, surfaceText].filter((part) => part.trim() !== ''),
    }).system

  let system = composeSystem()

  // 2.1 先裁 few-shot：丢第 2 条 → 全丢。
  if (estimateTokens(system) > CREATOR_PROMPT_BUDGET.systemTotal && shots.length > 1) {
    shotText = formatFewShots(shots.slice(0, 1))
    system = composeSystem()
    trimmed.push('few-shot')
  }
  if (estimateTokens(system) > CREATOR_PROMPT_BUDGET.systemTotal && shotText !== '') {
    shotText = ''
    system = composeSystem()
    trimmed.push('few-shot')
  }
  // 2.2 再裁 ABI（只留目标面；auto 时缩成头部摘要）。
  if (estimateTokens(system) > CREATOR_PROMPT_BUDGET.systemTotal) {
    abiText = intent === 'auto' ? abiDigestFor('command') : abiDigestFor(intent)
    system = composeSystem()
    trimmed.push('abi')
  }
  // 2.3 最后裁面摘要。
  if (estimateTokens(system) > CREATOR_PROMPT_BUDGET.systemTotal) {
    surfaceText = ''
    system = composeSystem()
    trimmed.push('surface')
  }
  // 2.4 兜底：仍超上限就按 token 硬截（不允许把 20000 token 发给端点）。
  if (estimateTokens(system) > CREATOR_PROMPT_BUDGET.systemTotal) {
    system = fitTextToTokens(system, CREATOR_PROMPT_BUDGET.systemTotal)
    trimmed.push('hard-cut')
  }

  const inputTotal = estimateTokens(system) + estimateTokens(user)
  const limit = withExcerpt ? CREATOR_PROMPT_BUDGET.inputTotalWithDeck : CREATOR_PROMPT_BUDGET.inputTotal
  const finalUser = inputTotal > limit ? fitTextToTokens(user, Math.max(200, limit - estimateTokens(system))) : user

  return {
    system,
    user: finalUser,
    intent,
    mockIntent: mockIntentOf(intent),
    tokens: {
      system: estimateTokens(system),
      user: estimateTokens(finalUser),
      total: estimateTokens(system) + estimateTokens(finalUser),
      abi: estimateTokens(abiText),
      fewShot: estimateTokens(shotText),
    },
    trimmed: [...new Set(trimmed)],
  }
}

function formatFewShots(shots: CreatorFewShot[]): string {
  if (shots.length === 0) return ''
  return `样例（最多 ${shots.length} 条，只学结构，不要照抄内容）：\n${shots
    .map((shot) => `--- ${shot.source} ---\n${shot.text}`)
    .join('\n\n')}`
}

/** 消费方（store/UI）只需要 PromptPair 时用它。 */
export function creatorPromptPair(result: CreatorPromptResult): PromptPair {
  return { system: result.system, user: result.user }
}
