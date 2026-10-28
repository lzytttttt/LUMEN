/**
 * contract/replay.test.ts —— replay fixture 契约（`05` §13.2 + `07` L-02 / L-03 / L-04）。
 *
 * 四条硬断言（逐个 fixture 文件）：
 * ① `chunks.join('')` 过 SSE 解析出的 delta 拼接 **等于** `fixture.text`；
 * ② `fixture.text` 过对应 zod（outline / slide / svg / three）必须通过 —— 回放产物与真模型产物可校验等价；
 * ③ 用 `fixture.request` + `capturedFrom.model` 重算 `promptDigest` 与记录一致；
 * ④ 单文件 ≤ 120KB、`chunks.length === delays.length`、末帧含 `[DONE]`。
 *
 * 另加：索引文件与目录一致、单套总量 ≤ 120KB、`ReplayProvider` 严格命中的正反用例（L-04）。
 *
 * 注：`slideContentSchema`（compose.ts 私有）与 `svgPayloadSchema`（generate.ts 私有）在规格 §13.2 里
 * 要求各加一行 `export`，但那两个文件由 Lead 锁定；这里按同一形状本地声明，等 Lead 打开后再改成 import。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { outlineSchema, threeDescriptorSchema } from '@/schema/deck'
import { DEFAULT_LLM, useSettingsStore } from '@/state/settingsStore'
import { AiError, channelInfo, providerFor } from '@/ai/provider'
import { composeOutline } from '@/ai/compose'
import { requestDigestOf } from '@/ai/cache'
import { createSseParser } from '@/ai/sse'
import { ReplayProvider, deltaChunksOf, replaySets, type ReplayFixture } from '@/ai/replay'

const FIXTURE_DIR = join(process.cwd(), 'src/fixtures/ai')
const SET_DIR = join(FIXTURE_DIR, 'zh-normal')
const MAX_BYTES = 120 * 1024

/* ------------------------------ 与运行期同形的 zod ------------------------------ */

const slideContentSchema = z.object({
  headline: z.string().min(1).max(160),
  lead: z.string().max(240).optional(),
  points: z.array(z.string().max(200)).max(8).default([]),
  notes: z.string().max(800).optional(),
})

const svgPayloadSchema = z.object({
  svg: z.string().min(1),
  viewBox: z.array(z.number()).length(4).optional(),
  caption: z.string().max(200).optional(),
})

const threePayloadSchema = z.object({ descriptor: threeDescriptorSchema })

const SCHEMAS: Record<ReplayFixture['task'], z.ZodTypeAny> = {
  outline: outlineSchema,
  slide: slideContentSchema,
  svg: svgPayloadSchema,
  three: threePayloadSchema,
  refine: slideContentSchema,
}

/* --------------------------------- 读盘 --------------------------------- */

function fixtureFiles(): string[] {
  return readdirSync(SET_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

function readFixture(name: string): { fixture: ReplayFixture; bytes: number; raw: string } {
  const path = join(SET_DIR, name)
  const raw = readFileSync(path, 'utf8')
  return { fixture: JSON.parse(raw) as ReplayFixture, bytes: statSync(path).size, raw }
}

const FILES = fixtureFiles()

describe('replay fixture 契约', () => {
  it('至少覆盖 outline + 9 个 slide + 1 个 svg', () => {
    const tasks = FILES.map((name) => readFixture(name).fixture.task)
    expect(tasks.filter((task) => task === 'outline').length).toBeGreaterThanOrEqual(1)
    expect(tasks.filter((task) => task === 'slide').length).toBeGreaterThanOrEqual(9)
    expect(tasks.filter((task) => task === 'svg').length).toBeGreaterThanOrEqual(1)
  })

  it('① chunks 过 SSE 解析出的 delta 拼接 === fixture.text', () => {
    for (const name of FILES) {
      const { fixture } = readFixture(name)
      const parser = createSseParser()
      let joined = ''
      let sawDone = false
      for (const chunk of fixture.chunks) {
        for (const event of parser.push(chunk)) {
          if (event.data.trim() === '[DONE]') {
            sawDone = true
            continue
          }
          if (event.data.trim() === '') continue
          const parsed = JSON.parse(event.data) as {
            choices?: { delta?: { content?: unknown } }[]
          }
          const content = parsed.choices?.[0]?.delta?.content
          if (typeof content === 'string') joined += content
        }
      }
      expect(joined, name).toBe(fixture.text)
      expect(sawDone, `${name} 缺少 data: [DONE]`).toBe(true)
      expect(deltaChunksOf(fixture).flat().join(''), name).toBe(fixture.text)
    }
  })

  it('② fixture.text 过对应 zod', () => {
    for (const name of FILES) {
      const { fixture } = readFixture(name)
      const result = SCHEMAS[fixture.task].safeParse(JSON.parse(fixture.text))
      expect(result.success, `${name}: ${result.success ? '' : JSON.stringify(result.error?.issues)}`).toBe(true)
    }
  })

  it('③ 重算 promptDigest 与记录一致', () => {
    for (const name of FILES) {
      const { fixture } = readFixture(name)
      const digest = requestDigestOf({
        system: fixture.request.system,
        user: fixture.request.user,
        model: fixture.capturedFrom.model,
        format: fixture.request.format ?? 'auto',
        temperature: fixture.request.temperature,
        task: fixture.task,
      })
      expect(digest, name).toBe(fixture.promptDigest)
      expect(fixture.kind).toBe('lumen.replay')
      expect(fixture.version).toBe(1)
    }
  })

  it('④ 单文件 ≤ 120KB、帧数与 delays 等长、首项是首字节延迟', () => {
    for (const name of FILES) {
      const { fixture, bytes } = readFixture(name)
      expect(bytes, name).toBeLessThanOrEqual(MAX_BYTES)
      expect(fixture.chunks.length, name).toBe(fixture.delays.length)
      expect(fixture.delays[0], name).toBeGreaterThan(0)
      for (const delay of fixture.delays) {
        expect(Number.isFinite(delay), name).toBe(true)
        expect(delay, name).toBeGreaterThanOrEqual(0)
      }
      expect(fixture.chunks.at(-1), name).toContain('[DONE]')
    }
  })

  it('单套总量 ≤ 120KB（00 未决 4）', () => {
    const total = FILES.reduce((sum, name) => sum + statSync(join(SET_DIR, name)).size, 0)
    expect(total).toBeLessThanOrEqual(MAX_BYTES)
  })

  it('index.json 与目录内容一致', () => {
    const index = JSON.parse(readFileSync(join(FIXTURE_DIR, 'index.json'), 'utf8')) as Record<
      string,
      Record<string, string[]>
    >
    const set = index['zh-normal']
    expect(set).toBeTruthy()
    const listed = new Set(Object.values(set).flat())
    const actual = new Set(FILES.map((name) => readFixture(name).fixture.fixtureId))
    expect(listed).toEqual(actual)
  })

  it('fixture 里不出现密钥形态的字符串', () => {
    for (const name of FILES) {
      const { raw } = readFixture(name)
      expect(raw, name).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/)
      expect(raw, name).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/)
    }
  })
})

/* ---------------------------- L-04：严格模式不降级 ---------------------------- */

describe('replay 通道（L-04）', () => {
  it('严格命中：outline fixture 可回放且文本一致', async () => {
    const { fixture } = readFixture('outline-1.json')
    const provider = new ReplayProvider({ setId: 'zh-normal', strict: true, speed: 0 })
    const deltas: string[] = []
    const result = await provider.complete({
      system: fixture.request.system,
      user: fixture.request.user,
      temperature: fixture.request.temperature,
      stream: true,
      onDelta: (text) => deltas.push(text),
    })
    expect(result.text).toBe(fixture.text)
    expect(deltas.join('')).toBe(fixture.text)
    expect(deltas.length).toBeGreaterThan(1)
    expect(result.streamed).toBe(true)
    expect(result.model).toBe(fixture.capturedFrom.model)
  })

  it('严格模式 prompt 改一个字 → notConfigured replay:digest-miss，不静默落 mock', async () => {
    const { fixture } = readFixture('outline-1.json')
    const provider = new ReplayProvider({ setId: 'zh-normal', strict: true, speed: 0 })
    const failure = await provider
      .complete({ system: fixture.request.system, user: `${fixture.request.user} `, stream: false })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AiError)
    expect((failure as AiError).code).toBe('notConfigured')
    expect((failure as AiError).detail).toBe('replay:digest-miss')
  })

  it('宽松模式按 task 兜底，仍返回可校验产物', async () => {
    const provider = new ReplayProvider({ setId: 'zh-normal', strict: false, speed: 0 })
    const result = await provider.complete({ system: '[TASK:slide] whatever', user: '{}', stream: false })
    expect(slideContentSchema.safeParse(JSON.parse(result.text)).success).toBe(true)
  })

  it('fixture 集存在且能按 task 分组', () => {
    const set = replaySets().get('zh-normal')
    expect(set).toBeTruthy()
    expect(set?.byTask.outline.length).toBeGreaterThanOrEqual(1)
    expect(set?.byTask.slide.length).toBeGreaterThanOrEqual(9)
    expect(set?.byTask.svg.length).toBeGreaterThanOrEqual(1)
  })
})

/* ---------------------------- 通道路由（05 §2） ---------------------------- */

describe('providerFor 路由', () => {
  const base = { ...DEFAULT_LLM }

  afterEach(() => {
    window.history.replaceState({}, '', '/')
  })

  it('llm.provider === "replay" → ReplayProvider（不看 baseURL/model）', () => {
    const provider = providerFor({ ...base, provider: 'replay', baseURL: '', model: '' })
    expect(provider.id).toBe('replay')
  })

  it('?channel=replay 优先于 provider/mock', () => {
    window.history.replaceState({}, '', '/?channel=replay&replay=zh-normal')
    expect(providerFor({ ...base, provider: 'mock' }).id).toBe('replay')
    expect(providerFor({ ...base, provider: 'openai', baseURL: 'https://x/v1', model: 'm' }).id).toBe('replay')
  })

  it('openai 就绪仍走 isLlmReady；未就绪落 mock', () => {
    const ready = providerFor({ ...base, provider: 'openai', baseURL: 'https://api.test/v1', model: 'm' })
    expect(ready.id).toBe('openai')
    const notReady = providerFor({ ...base, provider: 'openai', baseURL: '', model: '' })
    expect(notReady.id).toBe('mock')
  })

  it('channelInfo 对 replay 不落「离线示例模式」', () => {
    const info = channelInfo({ ...base, provider: 'replay' })
    expect(info.channel).toBe('replay')
    expect(info.ready).toBe(true)
    expect(info.id).toBe('replay')
    const mockInfo = channelInfo({ ...base, provider: 'mock' })
    expect(mockInfo.channel).toBe('mock')
    expect(mockInfo.ready).toBe(false)
  })
})

/* ---------------------- 管线集成：compose → replay ---------------------- */

describe('replay 走完真实管线（composeOutline）', () => {
  it('用 trace 的原始输入复现大纲，产物过 outlineSchema', async () => {
    useSettingsStore.getState().hydrate({ llm: { ...DEFAULT_LLM, provider: 'replay', cache: false } })
    const outline = await composeOutline({
      prompt: '给管理层讲：AI 写作助手试点三个月的结论，要不要继续投',
      lang: 'zh',
      length: 'normal',
      durationMin: 10,
      includeSvg: true,
      include3d: true,
    })
    expect(outline.provider).toBe('replay')
    expect(outline.outline.slides).toHaveLength(9)
    expect(outlineSchema.safeParse(outline.outline).success).toBe(true)
  })
})
