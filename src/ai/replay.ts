/**
 * replay.ts —— `replay` 通道（`05` §12）：离线演示与 e2e 的**唯一真相**（D9）。
 *
 * 它把「网络」也变成确定性产物：产物、token 边界、帧节奏全部来自 fixture。
 * 与 `mock` 的分工：`mock` 断言管线正确性，`replay` 断言动效时序与「真模型产物」的等价性。
 *
 * 规则：
 * - 走真实管线（compose → complete），只是数据来自文件；不参与修复环、不写缓存、不重试、不出网；
 * - 严格模式（默认）：按 `promptDigest` 精确匹配，miss 抛 `AiError('notConfigured','replay:digest-miss')`，
 *   **不静默落 mock**（否则 e2e 假绿）；
 * - 宽松模式（`?strict=0`）：按 `task` + 出现顺序兜底，console 记一条 `replay:digest-miss` 警告；
 * - 流式节奏：按 `delays[i]` 逐帧 `onDelta`；`speed = 0` 同步一次灌完（e2e 断言布局用）。
 *
 * fixture 由 `src/fixtures/ai/<setId>/<task>-<n>.json` 提供（`import.meta.glob` 静态打包，零请求）。
 */
import {
  AiError,
  abortedError,
  resolveTask,
  type AiCapabilities,
  type AiFormat,
  type AiProvider,
  type AiTask,
  type AiUsage,
  type CompleteRequest,
  type CompleteResult,
} from './provider'
import { requestDigestOf } from './cache'
import { createSseParser } from './sse'

export type ReplayTask = AiTask

/** fixture 文件契约（§12.2）。 */
export interface ReplayFixture {
  kind: 'lumen.replay'
  version: 1
  /** `<lang>-<length>.<task>.<n>`，例：`zh-normal.slide.3`。 */
  fixtureId: string
  task: ReplayTask
  /** 录制时的请求级 digest（§7.3），严格匹配用。 */
  promptDigest: string
  request: { system: string; user: string; temperature?: number; format?: AiFormat }
  /** 原样 SSE 帧文本，含 `data: …\n\n`，末尾含 `data: [DONE]\n\n`。 */
  chunks: string[]
  /** 与 `chunks` 等长；首项是首字节延迟（ms）。 */
  delays: number[]
  /** 所有 delta 的 content 拼接，契约测试的比对基准。 */
  text: string
  usage?: AiUsage
  capturedAt: string
  capturedFrom: { baseURL: string; model: string; stream: boolean }
}

export interface ReplaySet {
  id: string
  fixtures: ReplayFixture[]
  byTask: Record<ReplayTask, ReplayFixture[]>
}

export const DEFAULT_REPLAY_SET = 'zh-normal'

const EMPTY_BY_TASK: Record<ReplayTask, ReplayFixture[]> = {
  outline: [],
  slide: [],
  svg: [],
  three: [],
  refine: [],
}

/** 静态打包全部 fixture（Vite/vitest 都会把 JSON 变成模块）。 */
const FIXTURE_MODULES = import.meta.glob<{ default: unknown }>('../fixtures/ai/*/*.json', { eager: true })

function isReplayFixture(value: unknown): value is ReplayFixture {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ReplayFixture>
  if (record.kind !== 'lumen.replay') return false
  if (typeof record.fixtureId !== 'string' || typeof record.promptDigest !== 'string') return false
  if (typeof record.text !== 'string') return false
  if (!record.request || typeof record.request.system !== 'string' || typeof record.request.user !== 'string') {
    return false
  }
  if (!Array.isArray(record.chunks) || !Array.isArray(record.delays)) return false
  if (record.chunks.length !== record.delays.length) return false
  const task = record.task
  return task === 'outline' || task === 'slide' || task === 'svg' || task === 'three' || task === 'refine'
}

let cache: Map<string, ReplaySet> | null = null

/** 全部 fixture 集（按目录名分组）；内容非法或 `delays` 长度不符的条目直接跳过。 */
export function replaySets(): Map<string, ReplaySet> {
  if (cache) return cache
  const sets = new Map<string, ReplaySet>()
  for (const [path, module] of Object.entries(FIXTURE_MODULES)) {
    const raw = (module as { default?: unknown }).default ?? module
    if (!isReplayFixture(raw)) {
      if (import.meta.env?.DEV) console.warn(`[replay] 跳过非法 fixture：${path}`)
      continue
    }
    const segments = path.split('/')
    const setId = segments[segments.length - 2] ?? DEFAULT_REPLAY_SET
    let set = sets.get(setId)
    if (!set) {
      set = { id: setId, fixtures: [], byTask: { ...EMPTY_BY_TASK, outline: [], slide: [], svg: [], three: [], refine: [] } }
      sets.set(setId, set)
    }
    set.fixtures.push(raw)
    set.byTask[raw.task].push(raw)
  }
  cache = sets
  return sets
}

/** 测试用：清空加载缓存（改 fixture 后重读）。 */
export function resetReplayCache(): void {
  cache = null
}

export function hasReplaySet(setId: string = DEFAULT_REPLAY_SET): boolean {
  const set = replaySets().get(setId)
  return set !== undefined && set.fixtures.length > 0
}

/** `?replay=<set>` 选集（默认 `zh-normal`）。 */
export function replaySetFromLocation(search?: string): string {
  const query = search ?? (typeof location !== 'undefined' ? location.search : '')
  if (query === '') return DEFAULT_REPLAY_SET
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query)
  const setId = params.get('replay')
  return setId && setId.trim() !== '' ? setId.trim() : DEFAULT_REPLAY_SET
}

function searchParam(name: string): string | null {
  if (typeof location === 'undefined') return null
  const params = new URLSearchParams(location.search.startsWith('?') ? location.search.slice(1) : location.search)
  return params.get(name)
}

/**
 * 回放速度：`?speed=` > env > 测试环境 0 / 其它 1。
 * `0` = 同步一次灌完；`2` = 两倍速。
 */
export function replaySpeed(fromQuery?: string | null): number {
  const raw = fromQuery ?? searchParam('speed')
  if (raw !== null && raw.trim() !== '') {
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0) return value
  }
  const fromEnv = (import.meta as { env?: Record<string, unknown> }).env?.VITE_LUMEN_REPLAY_SPEED
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    const value = Number(fromEnv)
    if (Number.isFinite(value) && value >= 0) return value
  }
  return import.meta.env?.MODE === 'test' ? 0 : 1
}

/** 严格模式：`?strict=0` 关闭（演示用宽松兜底），缺省严格。 */
export function replayStrict(fromQuery?: string | null): boolean {
  const raw = fromQuery ?? searchParam('strict')
  if (raw === null) return true
  return !(raw === '0' || raw.toLowerCase() === 'false')
}

/**
 * 把 fixture 的原始帧文本解成「每帧的 delta」（与线上 SSE 解析器同一份代码）。
 * 返回数组与 `fixture.chunks` 等长：第 i 项是第 i 个 chunk 里完成的 delta（心跳帧为空数组），
 * 这样 `delays[i]` 与 delta 严格对齐。
 */
export function deltaChunksOf(fixture: ReplayFixture): string[][] {
  const parser = createSseParser()
  const out: string[][] = []
  for (const chunk of fixture.chunks) {
    const row: string[] = []
    for (const event of parser.push(chunk)) {
      const raw = event.data.trim()
      if (raw === '' || raw === '[DONE]') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new AiError('streamBroken', `replay 帧不是合法 JSON：${raw.slice(0, 80)}`)
      }
      const choice = (parsed as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]
      const content = choice?.delta?.content
      if (typeof content === 'string' && content !== '') row.push(content)
    }
    out.push(row)
  }
  return out
}

/** 摊平的 delta 序列（契约测试与快照用）。 */
export function deltasOfFixture(fixture: ReplayFixture): string[] {
  return deltaChunksOf(fixture).flat()
}

function matchesRequest(fixture: ReplayFixture, req: CompleteRequest, task: ReplayTask): boolean {
  if (fixture.task !== task) return false
  if (fixture.request.system !== req.system) return false
  if (fixture.request.user !== req.user) return false
  const digest = requestDigestOf({
    system: req.system,
    user: req.user,
    model: fixture.capturedFrom.model,
    format: fixture.request.format ?? 'auto',
    temperature: req.temperature ?? fixture.request.temperature,
    task,
  })
  return digest === fixture.promptDigest
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedError())
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface ReplayProviderOptions {
  setId?: string
  strict?: boolean
  speed?: number
}

export class ReplayProvider implements AiProvider {
  readonly id = 'replay' as const
  readonly label = 'Replay fixture'
  readonly capabilities: AiCapabilities = {
    stream: true,
    usageInStream: true,
    jsonObject: false,
    jsonSchema: false,
  }

  private readonly setId: string
  private readonly strict: boolean
  private readonly speed: number
  /** 宽松模式的按 task 轮转游标。 */
  private readonly cursor = new Map<ReplayTask, number>()
  private readonly warned = new Set<string>()

  constructor(opts: ReplayProviderOptions = {}) {
    this.setId = opts.setId ?? replaySetFromLocation()
    this.strict = opts.strict ?? replayStrict()
    this.speed = opts.speed ?? replaySpeed()
  }

  /** 本次回放实际使用的 fixture 集 id（UI 徽标用）。 */
  get set(): string {
    return this.setId
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    if (req.signal?.aborted) throw abortedError()

    const set = replaySets().get(this.setId)
    if (!set || set.fixtures.length === 0) {
      throw new AiError('notConfigured', 'replay:digest-miss')
    }
    const task = resolveTask(req)
    if (!task) throw new AiError('notConfigured', 'replay:digest-miss')
    const bucket = set.byTask[task]
    if (bucket.length === 0) throw new AiError('notConfigured', 'replay:digest-miss')

    const fixture = this.strict ? bucket.find((item) => matchesRequest(item, req, task)) : this.pickLoose(bucket, task)
    if (!fixture) throw new AiError('notConfigured', 'replay:digest-miss')

    const wantStream = req.stream !== false
    const perChunk = deltaChunksOf(fixture)

    if (!wantStream) {
      if (fixture.usage) req.onUsage?.(fixture.usage)
      return {
        text: fixture.text,
        usage: fixture.usage,
        streamed: false,
        finish: 'stop',
        model: fixture.capturedFrom.model,
        cached: false,
        effectiveFormat: fixture.request.format ?? 'auto',
      }
    }

    if (this.speed === 0) {
      // 同步一次灌完：保留 delta 边界，但不等待。
      for (const row of perChunk) {
        for (const delta of row) {
          if (req.signal?.aborted) throw abortedError()
          req.onDelta?.(delta)
        }
      }
    } else {
      for (let index = 0; index < fixture.delays.length; index += 1) {
        await sleep(fixture.delays[index] / this.speed, req.signal)
        for (const delta of perChunk[index] ?? []) req.onDelta?.(delta)
      }
    }

    if (fixture.usage) req.onUsage?.(fixture.usage)
    return {
      text: fixture.text,
      usage: fixture.usage,
      streamed: true,
      finish: 'stop',
      model: fixture.capturedFrom.model,
      cached: false,
      effectiveFormat: fixture.request.format ?? 'auto',
    }
  }

  private pickLoose(bucket: ReplayFixture[], task: ReplayTask): ReplayFixture {
    const index = this.cursor.get(task) ?? 0
    this.cursor.set(task, index + 1)
    const fixture = bucket[index % bucket.length]
    const key = `${this.setId}:${task}`
    if (!this.warned.has(key)) {
      this.warned.add(key)
      console.warn(`[replay] digest miss → 按 task 兜底（${key}）`)
    }
    return fixture
  }
}
