/**
 * creator-context.test.ts —— 上下文快照隐私默认值 / 预算裁剪 / ABI 摘录 / Mock 与 Replay（04 §6）。
 *
 * 覆盖 06 U-40-170…176（CR-40-15…21）。
 */
import { describe, expect, it } from 'vitest'
import { createSampleDeck } from '@/sample/sample-deck'
import { APP_VERSION } from '@/version'
import {
  composeCreatorContext,
  countCjk,
  CREATOR_CONTEXT_LIMITS,
  deckExcerptOf,
  estimateTokens,
  estimateTokensOf,
  fitTextToTokens,
  stableStringify,
  trimCreatorContext,
  type CreatorContextSnapshot,
} from '@/creator/context'
import { buildCreatorPrompt, CREATOR_PROMPT_BUDGET, detectCreatorIntent, fewShotsFor } from '@/creator/prompt'
import {
  ABI_CAPABILITY_IDS,
  ABI_DIGEST_FULL,
  ABI_NAMESPACES,
  ABI_PRIMITIVES,
  ABI_PROPOSAL_FIELDS,
  ABI_PROPOSAL_OPTIONAL_FIELDS,
  ABI_SLOT_IDS,
  abiDigestFor,
} from '@/creator/abi-digest'
import { mockCreatorProposal, mockCreatorText } from '@/ai/mockCreator'
import { validateCreatorProposal } from '@/creator/proposal'
import { requestDigestOf } from '@/ai/cache'
import { ReplayProvider } from '@/ai/replay'
import pluginOne from '@/fixtures/ai/creator-mock/plugin-1.json'
import pluginTwo from '@/fixtures/ai/creator-mock/plugin-2.json'

function contextOf(overrides: Partial<Parameters<typeof composeCreatorContext>[0]> = {}): CreatorContextSnapshot {
  return composeCreatorContext({
    appVersion: APP_VERSION,
    locale: 'zh',
    uiTheme: 'dark',
    deck: createSampleDeck('zh'),
    deckRevision: 7,
    layout: { railWidth: 216, panelWidth: 340, rightMode: 'inspector', leftTab: 'slides', inspectorTab: 'props' },
    enabledPlugins: [],
    readDeck: false,
    intent: 'auto',
    ...overrides,
  })
}

describe('上下文快照与隐私（CR-40-15/16）', () => {
  it('默认只发结构摘要：不含 deckExcerpt / 正文 / 备注', () => {
    const context = contextOf()
    expect(context.apiVersion).toBe('1.0')
    expect(context.appVersion).toBe(APP_VERSION)
    expect(context.deckSummary.slideCount).toBeGreaterThan(0)
    expect(context.deckSummary.blockCounts).toBeTypeOf('object')
    expect(context.deckExcerpt).toBeUndefined()
    const serialized = stableStringify(context)
    expect(serialized).not.toContain('"notes"')
    expect(serialized).not.toContain('"blocks"')
  })

  it('readDeck=true 才发摘录，且每幕 ≤200 字、≤20 幕', () => {
    const deck = createSampleDeck('zh')
    const excerpt = deckExcerptOf(deck)
    expect(excerpt.length).toBeGreaterThan(0)
    expect(excerpt.length).toBeLessThanOrEqual(CREATOR_CONTEXT_LIMITS.excerptSlides)
    for (const slide of excerpt) {
      expect(Array.from(slide.headline).length).toBeLessThanOrEqual(CREATOR_CONTEXT_LIMITS.excerptSlideChars)
      for (const point of slide.points) {
        expect(Array.from(point).length).toBeLessThanOrEqual(CREATOR_CONTEXT_LIMITS.excerptSlideChars)
      }
    }
    expect(contextOf({ readDeck: true }).deckExcerpt?.length).toBe(excerpt.length)
  })

  it('enabledPlugins 只含 id/name/version/kind，最多 8 条，不含插件数据', () => {
    const plugins = Array.from({ length: 12 }, (_, index) => ({
      id: `local.test.p${index}`,
      name: { zh: `插件${index}`, en: `Plugin ${index}` },
      version: '1.0.0',
      kind: 'declarative' as const,
    }))
    const context = contextOf({ enabledPlugins: plugins })
    expect(context.enabledPlugins).toHaveLength(CREATOR_CONTEXT_LIMITS.enabledPlugins)
    expect(Object.keys(context.enabledPlugins[0]).sort()).toEqual(['id', 'kind', 'name', 'version'])
  })

  it('稳定序列化：键序固定，同内容不同插入序字节一致', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    const context = contextOf()
    expect(stableStringify(context)).toBe(stableStringify(JSON.parse(JSON.stringify(context))))
    expect(stableStringify(context)).not.toMatch(/\d{13}/) // 无时间戳
  })
})

describe('token 预算（CR-40-17 / 04 §6.4）', () => {
  it('公式 ceil(cjk*0.75 + latin/4)', () => {
    expect(countCjk('中文abc')).toBe(2)
    expect(estimateTokens('中文')).toBe(2) // ceil(2*0.75)=2
    expect(estimateTokens('abcd')).toBe(1) // ceil(4/4)
    expect(estimateTokens('中文abcd')).toBe(3) // ceil(1.5+1)=3
    expect(estimateTokens('')).toBe(0)
  })

  it('按 token 预算截断文本，且不超预算', () => {
    const text = '这是一段很长的中文文本，'.repeat(50)
    const cut = fitTextToTokens(text, 20)
    expect(estimateTokens(cut)).toBeLessThanOrEqual(20)
    expect(cut.length).toBeLessThan(text.length)
    expect(fitTextToTokens('短句', 100)).toBe('短句')
  })

  it('超限先裁 enabledPlugins 到 4 条，再按幕截 deck 摘录', () => {
    const plugins = Array.from({ length: 8 }, (_, index) => ({
      id: `local.test.p${index}`,
      name: { zh: '插件'.repeat(12), en: 'Plugin '.repeat(12) },
      version: '1.0.0',
      kind: 'declarative' as const,
    }))
    const context = contextOf({ enabledPlugins: plugins, readDeck: true })
    const trimmed = trimCreatorContext(context, CREATOR_CONTEXT_LIMITS.userSnapshot)
    expect(trimmed.tokens).toBeLessThanOrEqual(CREATOR_CONTEXT_LIMITS.userSnapshot)
    expect(trimmed.trimmed.length).toBeGreaterThan(0)
    expect(trimmed.snapshot.enabledPlugins.length).toBeLessThanOrEqual(4)
  })
})

describe('ABI 摘录与 02 冻结表一致（CR-40-18）', () => {
  it('17 命名空间 / 9 插槽 / 15 能力 / 16 基元 / 提案 7+1 字段', () => {
    expect(ABI_NAMESPACES).toHaveLength(17)
    expect(ABI_SLOT_IDS).toHaveLength(9)
    expect(ABI_CAPABILITY_IDS).toHaveLength(15)
    expect(ABI_PRIMITIVES).toHaveLength(16)
    expect(ABI_PROPOSAL_FIELDS).toHaveLength(7)
    expect(ABI_PROPOSAL_OPTIONAL_FIELDS).toHaveLength(1)
    expect(new Set(ABI_NAMESPACES).size).toBe(17)
    for (const slot of ABI_SLOT_IDS) expect(ABI_DIGEST_FULL).toContain(slot)
    for (const capability of ABI_CAPABILITY_IDS) expect(ABI_DIGEST_FULL).toContain(capability)
    expect(estimateTokens(ABI_DIGEST_FULL)).toBeLessThanOrEqual(CREATOR_PROMPT_BUDGET.abi)
  })

  it('按意图裁剪：theme / widget / command 各自 ≤3000 token 且含关键命名空间', () => {
    expect(abiDigestFor('theme')).toContain('theme:contribute')
    expect(abiDigestFor('widget')).toContain('lumen.ui')
    expect(abiDigestFor('command')).toContain('keymap')
    for (const intent of ['theme', 'widget', 'command', 'auto'] as const) {
      expect(estimateTokens(abiDigestFor(intent))).toBeLessThanOrEqual(CREATOR_PROMPT_BUDGET.abi)
    }
  })
})

describe('请求装配（CR-40-17 / §6.2）', () => {
  it('system ≤6500 token；user 快照 ≤600；意图识别正确', () => {
    const prompts: [string, string][] = [
      ['主色 #1F6FEB 的主题皮肤', 'theme'],
      ['底部加一条字数看板', 'widget'],
      ['⌘⇧D 进入专注', 'command'],
      ['把整个工作台变成我的样子', 'auto'],
    ]
    for (const [prompt, intent] of prompts) {
      expect(detectCreatorIntent(prompt)).toBe(intent)
    }
    const result = buildCreatorPrompt({ prompt: '主色 #1F6FEB 的主题皮肤', context: contextOf() })
    expect(result.system).toContain('[TASK:plugin]')
    expect(result.system).toContain('theme:contribute')
    expect(result.tokens.system).toBeLessThanOrEqual(CREATOR_PROMPT_BUDGET.systemTotal)
    expect(result.tokens.total).toBeLessThanOrEqual(CREATOR_PROMPT_BUDGET.inputTotal)
    expect(result.mockIntent).toBe('theme')
    const user = JSON.parse(result.user) as { intent: string; context: Record<string, unknown> }
    expect(user.intent).toBe('theme')
    expect(user.context.deckExcerpt).toBeUndefined()
  })

  it('readDeck=true 才把 deckExcerpt 放进 user', () => {
    const off = buildCreatorPrompt({ prompt: '给这套演示加目录', context: contextOf(), readDeck: false })
    const on = buildCreatorPrompt({ prompt: '给这套演示加目录', context: contextOf({ readDeck: true }), readDeck: true })
    expect(JSON.parse(off.user).context.deckExcerpt).toBeUndefined()
    expect(JSON.parse(on.user).context.deckExcerpt.length).toBeGreaterThan(0)
    expect(on.tokens.total).toBeLessThanOrEqual(CREATOR_PROMPT_BUDGET.inputTotalWithDeck)
  })

  it('few-shot：目标意图 1 条、auto 最多 2 条', () => {
    expect(fewShotsFor('widget')).toHaveLength(1)
    expect(fewShotsFor('auto').length).toBeLessThanOrEqual(2)
  })

  it('回喂文本进 user.feedback（≤2000）', () => {
    const result = buildCreatorPrompt({
      prompt: '加一个看板',
      context: contextOf(),
      feedback: '[PLUGIN_ERROR] E-RUN-01 / boom',
    })
    expect(JSON.parse(result.user).feedback).toContain('[PLUGIN_ERROR]')
  })
})

describe('Mock / Replay（CR-40-19/20/21）', () => {
  it('Mock 三意图确定性且一次合法', () => {
    for (const intent of ['theme', 'widget', 'command', 'other'] as const) {
      const text = mockCreatorText({ intent })
      expect(text).toBe(mockCreatorText({ intent }))
      expect(validateCreatorProposal(JSON.parse(text)).ok).toBe(true)
      expect(mockCreatorProposal(intent).title.length).toBeGreaterThan(0)
    }
    expect(mockCreatorText({})).toBe(mockCreatorText({ intent: 'other' }))
  })

  it('Replay fixture digest 可重算，且 plugin 任务能被严格匹配', async () => {
    for (const fixture of [pluginOne, pluginTwo]) {
      expect(fixture.task).toBe('plugin')
      const digest = requestDigestOf({
        system: fixture.request.system,
        user: fixture.request.user,
        model: fixture.capturedFrom.model,
        format: fixture.request.format,
        temperature: fixture.request.temperature,
        task: 'plugin',
      })
      expect(digest).toBe(fixture.promptDigest)

      const provider = new ReplayProvider({ setId: 'creator-mock', strict: true, speed: 0 })
      const deltas: string[] = []
      const result = await provider.complete({
        system: fixture.request.system,
        user: fixture.request.user,
        json: true,
        temperature: fixture.request.temperature,
        task: 'plugin',
        stream: true,
        onDelta: (delta) => deltas.push(delta),
      })
      expect(result.text).toBe(fixture.text)
      expect(deltas.join('')).toBe(fixture.text)
      expect(validateCreatorProposal(JSON.parse(result.text)).ok).toBe(true)
    }
  })

  it('fixture 体积 ≤24KB（04 §6.6）', () => {
    for (const fixture of [pluginOne, pluginTwo]) {
      expect(Buffer.byteLength(JSON.stringify(fixture), 'utf8')).toBeLessThanOrEqual(24 * 1024)
    }
  })
})
